"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createConfigStore, normalizeConfig, projectNativeMemorySharingConfig: project,
  validateNativeMemorySharingProjection: validate } = require("../app/core/config-store");
const { createNativeMemorySharingConfigController } = require("../app/core/native-memory-sharing-config-controller");
const { NativeMemorySharingConfig } = require("../app/agent-service/native-memory-sharing-config");
const { validateNativeMemorySharingParams: params, validateNativeMemorySharingResult: result } = require("../app/agent-service/native-memory-sharing-protocol");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { BackendRegistry } = require("../app/core/backend-registry");
const config = (enabled = true, excludedProfiles = []) => ({ enabled, excludedProfiles });
const profile = (id, other = {}) => ({ id, backendId: "shoggoth", enabled: true, agentId: `agent-${id}`, name: `Agent ${id}`, ...other });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-sharecfg-")); fs.chmodSync(root, 0o700);
  const store = createConfigStore(path.join(root, "config.json"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, store, paths };
}
test("Core defaults include future enabled native Profiles without an allowlist and revisions are independent", t => {
  const { store } = fixture(t); store.write({ locale: "en", token: "fixture-unrelated" });
  assert.deepEqual(project(store.read()), { revision: 0, config: config() });
  store.writeNativeMemoryConfig({ expectedRevision: 0, config: {} });
  const saved = store.writeNativeMemorySharingConfig({ expectedRevision: 0, config: config(true, ["b", "a"]) });
  assert.deepEqual(saved.nativeMemorySharing, { revision: 1, config: config(true, ["a", "b"]) });
  assert.equal(saved.nativeMemory.revision, 1); assert.equal(saved.locale, "en"); assert.equal(saved.token, "fixture-unrelated");
  const reopened = createConfigStore(store.path); assert.deepEqual(reopened.read().nativeMemorySharing, saved.nativeMemorySharing);
  assert.throws(() => reopened.writeNativeMemorySharingConfig({ expectedRevision: 0, config: config(false) }), { code: "NATIVE_MEMORY_SHARING_STALE" });
});
test("closed Core schema rejects credentials, owner selectors, feature gates, sparse arrays and accessors", () => {
  let accessed = false;
  const getter = {}; Object.defineProperty(getter, "enabled", { enumerable: true, get() { accessed = true; return true; } });
  getter.excludedProfiles = [];
  const accessorArray = []; Object.defineProperty(accessorArray, "0", { enumerable: true, get() { accessed = true; return "a"; } });
  for (const value of [null, { revision: 0, config: {} }, { revision: -1, config: config() },
    { revision: 0, config: config(), owner: "shoggoth-memory-core" }, { revision: 0, config: { ...config(), featureReady: true } },
    { revision: 0, config: { ...config(), credential: "private" } }, { revision: 0, config: getter },
    { revision: 0, config: config(true, new Array(1)) }, { revision: 0, config: config(true, accessorArray) },
    { revision: 0, config: config(true, ["a", "a"]) }, { revision: 0, config: config(true, ["__proto__"]) },
    { revision: 0, config: config(true, ["../other"]) }, { revision: 0, config: config("true") }]) {
    assert.throws(() => validate(value), { code: "NATIVE_MEMORY_SHARING_INVALID" });
  }
  assert.equal(accessed, false);
  assert.deepEqual(params("memory.sharing.config.read", {}), {});
  assert.throws(() => params("memory.sharing.config.read", { profileId: "pretend" }), { code: "NATIVE_MEMORY_SHARING_INVALID" });
});
test("damaged persisted policy fails closed and unrelated writes do not replace it with fresh enabled defaults", t => {
  const { store } = fixture(t); fs.writeFileSync(store.path, JSON.stringify({ nativeMemorySharing: { revision: 5, config: { enabled: true } } }));
  assert.equal(store.read().nativeMemorySharing, null);
  assert.throws(() => store.writeNativeMemorySharingConfig({ expectedRevision: 5, config: config() }), { code: "NATIVE_MEMORY_SHARING_INVALID" });
  store.write({ theme: "dark" }); assert.equal(store.read().nativeMemorySharing, null);
  fs.writeFileSync(store.path, "{corrupt"); assert.equal(store.read().nativeMemorySharing, null);
  assert.throws(() => store.writeNativeMemorySharingConfig({ expectedRevision: 0, config: config() }), { code: "NATIVE_MEMORY_SHARING_INVALID" });
  assert.equal(fs.readFileSync(store.path, "utf8"), "{corrupt"); assert.equal(normalizeConfig({}).nativeMemorySharing.config.enabled, true);
});
test("Service trusted feature gate stays closed despite authenticated enabled config and restart", t => {
  const { paths } = fixture(t); const gated = new NativeMemorySharingConfig({ paths }); gated.open();
  const profiles = [profile("a"), profile("b")];
  assert.equal(gated.resolve("a", profiles).enabled, false);
  gated.apply({ revision: 0, config: config() }); assert.equal(gated.resolve("a", profiles).enabled, false);
  const reopened = new NativeMemorySharingConfig({ paths }); reopened.open(); assert.equal(reopened.resolve("a", profiles).enabled, false);
  assert.equal(reopened.context(profiles).featureReady, false); assert.equal(reopened.context(profiles).effectiveEnabled, false);
});
test("both directions exclude a Profile; dynamic enabled native inventory never admits external or disabled profiles", t => {
  const { paths } = fixture(t); const store = new NativeMemorySharingConfig({ paths, featureReady: true }); store.open();
  store.apply({ revision: 2, config: config(true, ["b"]) });
  let profiles = [profile("a"), profile("b"), profile("external", { backendId: "openclaw" }), profile("disabled", { enabled: false })];
  assert.deepEqual(store.resolve("a", profiles), { revision: 2, enabled: true, participatingProfileIds: ["a"] });
  assert.deepEqual(store.resolve("b", profiles).participatingProfileIds, []);
  assert.equal(store.resolve("external", profiles).enabled, false); assert.equal(store.resolve("disabled", profiles).enabled, false);
  profiles.push(profile("new")); assert.deepEqual(store.resolve("a", profiles).participatingProfileIds, ["a", "new"]);
  assert.deepEqual(store.context(profiles).agents.map(value => [value.profileId, value.participating]), [["a", true], ["b", false], ["new", true]]);
  store.apply({ revision: 3, config: config(false) }); assert.equal(store.resolve("a", profiles).enabled, false);
});
test("Service restart, stale revision, conflicting replay and unsafe write remain fenced", t => {
  const { paths } = fixture(t); const store = new NativeMemorySharingConfig({ paths, featureReady: true }); store.open();
  store.apply({ revision: 5, config: config(true, ["b"]) });
  const reopened = new NativeMemorySharingConfig({ paths, featureReady: true }); reopened.open();
  assert.deepEqual(reopened.projection(), store.projection());
  assert.deepEqual(reopened.apply({ config: config(true, ["b"]), revision: 5 }), store.read());
  assert.throws(() => reopened.apply({ revision: 4, config: config() }), { code: "NATIVE_MEMORY_SHARING_STALE" });
  assert.throws(() => reopened.apply({ revision: 5, config: config() }), { code: "NATIVE_MEMORY_SHARING_CONFLICT" });
  fs.unlinkSync(reopened.file); fs.mkdirSync(reopened.file);
  assert.throws(() => reopened.apply({ revision: 6, config: config() }), { code: "NATIVE_MEMORY_SHARING_UNCERTAIN" });
  assert.throws(() => reopened.resolve("a", [profile("a")]), { code: "NATIVE_MEMORY_SHARING_UNCERTAIN" });
});
test("projection response cannot claim effective enabled while gated or leak secrets", () => {
  const value = { owner: "shoggoth-memory-core", revision: 1, featureReady: false, effectiveEnabled: false,
    agents: [{ profileId: "a", agentId: "agent-a", name: "A", participating: true }] };
  assert.deepEqual(result("memory.sharing.config.context", value), value);
  for (const invalid of [{ ...value, effectiveEnabled: true }, { ...value, owner: "unknown" }, { ...value, privateKey: "secret" },
    { ...value, agents: [...value.agents, ...value.agents] }, { ...value, agents: [{ ...value.agents[0], path: "/private" }] }]) {
    assert.throws(() => result("memory.sharing.config.context", invalid), { code: "NATIVE_MEMORY_SHARING_UNAVAILABLE" });
  }
});
test("lost apply reply is compensated with newer revision; concurrent Core edit is never overwritten", async t => {
  const { store } = fixture(t); let applied, failure = true;
  const registry = { async applyNativeMemorySharingConfig(value) { applied = value; if (failure) { failure = false; throw Error("private IPC"); } return value; } };
  const controller = createNativeMemorySharingConfigController({ configStore: store, registry });
  await assert.rejects(controller.update({ expectedRevision: 0, config: config(false) }), { code: "NATIVE_MEMORY_SHARING_APPLY_FAILED" });
  assert.deepEqual(applied, { revision: 2, config: config() }); assert.deepEqual(project(store.read()), applied);
  registry.applyNativeMemorySharingConfig = async value => { store.writeNativeMemorySharingConfig({ expectedRevision: value.revision, config: config(false, ["b"]) }); throw Error("reply lost"); };
  await assert.rejects(controller.update({ expectedRevision: 2, config: config(false) }), { code: "NATIVE_MEMORY_SHARING_ROLLBACK_PENDING" });
  assert.deepEqual(project(store.read()), { revision: 4, config: config(false, ["b"]) });
});
test("registry routes only declared sharing surface and unsupported external backends remain isolated", async () => {
  const registry = new BackendRegistry();
  const external = { id: "external", getBackendDescriptor: () => ({ surfaces: { nativeMemoryConfig: true } }), applyNativeMemorySharingConfig: () => assert.fail("external backend used") };
  registry.register(external);
  assert.throws(() => registry.applyNativeMemorySharingConfig({ revision: 0, config: config() }), { code: "NATIVE_MEMORY_SHARING_UNAVAILABLE" });
  const projection = { revision: 0, config: config() };
  registry.register({ id: "native", getBackendDescriptor: () => ({ surfaces: { nativeMemorySharingConfig: true } }), applyNativeMemorySharingConfig: async value => value });
  assert.deepEqual(await registry.applyNativeMemorySharingConfig(projection), projection);
});

test("real Service opens the implementation gate by default but needs authenticated Core policy; explicit false stays closed", { timeout: 30000 }, async () => {
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
  for (const gate of [undefined, false, true]) {
    const f = await openHandoffFixture({ serviceOptions: { memoryCore: true,
      ...(gate === undefined ? {} : { memorySharingFeatureReady: gate }),
      memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
        plugins: { entries: { "active-memory": { config: { enabled: false } } } } } } });
    try {
      const store = f.service.nativeMemorySharingConfig, profiles = f.service.productStore.listAgentProfiles();
      assert.equal(store.context(profiles).featureReady, gate !== false);
      assert.equal(store.resolve(f.profile.id, profiles).enabled, false, "startup cannot invent a Core policy");
      store.apply({ revision: 0, config: config() });
      assert.equal(store.resolve(f.profile.id, profiles).enabled, gate !== false);
      store.apply({ revision: 1, config: config(false) });
      assert.equal(store.resolve(f.profile.id, profiles).enabled, false, "user global close always takes effect");
    } finally { await f.close(); }
  }
});
