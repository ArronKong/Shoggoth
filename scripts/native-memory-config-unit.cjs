"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConfigStore, normalizeConfig, projectNativeMemoryConfig } = require("../app/core/config-store");
const { createNativeMemoryConfigController } = require("../app/core/native-memory-config-controller");
const { validateNativeMemoryConfigProjection: validate, validateNativeMemoryConfigResult } = require("../app/agent-service/native-memory-config-protocol");
const { NativeMemoryConfig } = require("../app/agent-service/native-memory-config");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION, createAgentService } = require("../app/agent-service/server");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { core } = require("../app/agent-service/shoggoth-memory/host.cjs");
const { defaultNativeMemoryProjection } = require("../app/agent-service/active-memory-defaults");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(25);
  }
  assert.fail(message);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sg-mcfg-"));
  fs.chmodSync(root, 0o700);
  const store = createConfigStore(path.join(root, "config.json"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const value = { root, store, paths, close: async () => {} };
  t.after(async () => { await value.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return value;
}
const disabled = { memory: { search: { enabled: false } } };

test("settings context accepts only the actual owner and minimal unique Agent identities", () => {
  const context = { owner: "shoggoth-memory-core", agents: [{ profileId: "profile-a", agentId: "agent-a", name: "A" }] };
  assert.deepEqual(validateNativeMemoryConfigResult("memory.config.context", context), context);
  for (const value of [{ ...context, owner: "requested" }, { ...context, agents: [...context.agents, ...context.agents] },
    { ...context, agents: [{ ...context.agents[0], credentials: "private" }] },
    { ...context, agents: [{ ...context.agents[0], profileId: "__proto__" }] }]) {
    assert.throws(() => validateNativeMemoryConfigResult("memory.config.context", value), { code: "NATIVE_MEMORY_CONFIG_UNAVAILABLE" });
  }
});

test("Core persists revisioned policy, preserves other settings and never persists owner selection", t => {
  const { store } = fixture(t);
  store.write({ token: "unrelated-test-token", locale: "en" });
  assert.deepEqual(projectNativeMemoryConfig(store.read()), defaultNativeMemoryProjection());
  const config = { ...disabled, agents: { entries: { profile_2: { memory: { search: {
    sources: ["sessions"], query: { maxResults: 2, minScore: 0.1 } } } } }, defaults: {
    userTimezone: "Asia/Shanghai", models: { "zeta/model": { alias: "remember" }, "alpha/model": { alias: "remember" } },
    compaction: { memoryFlush: { forceFlushTranscriptBytes: "2mb" } } } },
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false, frequency: "0 3 * * *" } } },
      "active-memory": { enabled: false, config: { modelFallback: "fixture/model", thinking: "adaptive", fastMode: "auto",
        toolsAllow: ["memory_get"], timeoutMs: 30_000, persistTranscripts: true, transcriptDir: "recall/diagnostics" } } } } };
  const saved = store.writeNativeMemoryConfig({ expectedRevision: 0, config });
  assert.equal(saved.nativeMemory.revision, 1);
  const reopened = createConfigStore(store.path);
  assert.deepEqual(reopened.read().nativeMemory, saved.nativeMemory);
  assert.deepEqual(Object.keys(reopened.read().nativeMemory.config.agents.defaults.models), ["zeta/model", "alpha/model"]);
  reopened.write({ theme: "dark" });
  assert.equal(reopened.read().token, "unrelated-test-token");
  assert.equal(reopened.read().nativeMemory.revision, 1);
  assert.throws(() => store.writeNativeMemoryConfig({ expectedRevision: 0, config: {} }), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  assert.ok(Object.isFrozen(projectNativeMemoryConfig(saved).config.agents.entries));
  assert.equal(Object.hasOwn(saved, "memoryCore"), false);
});

test("policy boundary rejects credentials, arbitrary paths, unknown knobs and executable getters", () => {
  let read = false;
  const getter = {}; Object.defineProperty(getter, "memory", { enumerable: true, get() { read = true; return {}; } });
  const sparse = new Array(1);
  for (const config of [getter, { memoryCore: true }, { memory: { search: { provider: "invalid/provider" } } },
    { memory: { search: { remote: { apiKey: "credential-must-not-enter" } } } },
    { memory: { search: { extraPaths: [{ path: "/Users/foreign", recursive: true }] } } },
    { agents: { entries: { alpha: { workspace: "/Users/foreign" } } } },
    { agents: { entries: JSON.parse('{"__proto__":{}}') } },
    { memory: { search: { sources: sparse } } },
    { plugins: { entries: { "active-memory": { config: { toolsAllow: ["exec"] } } } } },
    { plugins: { entries: { "active-memory": { config: { modelFallback: { model: "fixture" } } } } } },
    { plugins: { entries: { "active-memory": { config: { modelFallbackPolicy: "default-remote" } } } } },
    { plugins: { entries: { "active-memory": { config: { thinking: "ultra" } } } } },
    { plugins: { entries: { "active-memory": { config: { fastMode: "true" } } } } },
    { plugins: { entries: { "active-memory": { config: { persistTranscripts: "true" } } } } },
    { plugins: { entries: { "active-memory": { config: { transcriptDir: "x".repeat(1025) } } } } },
    { plugins: { entries: { "active-memory": { config: { transcriptDir: "invalid\u0000directory" } } } } },
    { agents: { defaults: { userTimezone: "Not/AZone" } } },
    { plugins: { entries: { "memory-core": { config: { dreaming: { frequency: "invalid" } } } } } },
    { plugins: { entries: { "memory-core": { config: { dreaming: { execution: { defaults: { speed: "fast" } } } } } } } },
    { plugins: { entries: { "memory-core": { config: { dreaming: { phases: { light: { cron: "0 3 * * *" } } } } } } } },
  ]) assert.throws(() => validate({ revision: 0, config }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  assert.equal(read, false);
  const left = validate({ config: { memory: { search: { enabled: true, sources: ["memory"] } } }, revision: 4 });
  const right = validate({ revision: 4, config: { memory: { search: { sources: ["memory"], enabled: true } } } });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  const indexSettings = validate({ revision: 5, config: { memory: { search: { provider: "none", cache: { enabled: false }, extraPaths: ["notes.md", { path: "reference", pattern: "**/*.md" }],
    store: { fts: { tokenizer: "trigram" } } } }, agents: { entries: { alpha: { memory: { search: { provider: "shoggoth-e5" } } } } } } });
  assert.equal(indexSettings.config.memory.search.store.fts.tokenizer, "trigram");
  const remoteSettings = { provider: "openai", model: "text-embedding-3-small", fallback: "none",
    providerRefs: { openai: "fixture:owner" }, remote: { headers: { "X-Project": "public-fixture" }, batch: { enabled: false } } };
  assert.deepEqual(validate({ revision: 5, config: { memory: { search: remoteSettings } } }).config.memory.search, remoteSettings);
  for (const search of [{ provider: "unsupported/local" }, { cache: { maxEntries: 1 } }, { store: { fts: { tokenizer: "invalid" } } },
    { store: { vector: { extensionPath: "/tmp/arbitrary-library" } } }]) {
    assert.throws(() => validate({ revision: 0, config: { memory: { search } } }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  }
});

test("corrupt Core policy is preserved and cannot silently become enabled defaults", t => {
  const { store } = fixture(t);
  fs.writeFileSync(store.path, JSON.stringify({ nativeMemory: { revision: 7, config: { memoryCore: true } }, locale: "en" }));
  const bytes = fs.readFileSync(store.path);
  assert.equal(store.read().nativeMemory, null);
  assert.throws(() => store.writeNativeMemoryConfig({ expectedRevision: 7, config: {} }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  assert.deepEqual(fs.readFileSync(store.path), bytes);
  store.write({ theme: "dark" });
  assert.equal(store.read().nativeMemory, null);
  assert.equal(normalizeConfig({}).nativeMemory.revision, 0);
  fs.writeFileSync(store.path, "{corrupt");
  assert.equal(store.read().nativeMemory, null);
  assert.throws(() => store.writeNativeMemoryConfig({ expectedRevision: 0, config: {} }), { code: "NATIVE_MEMORY_CONFIG_INVALID" });
  assert.equal(fs.readFileSync(store.path, "utf8"), "{corrupt");
});

test("Service projection survives restart, rejects stale/conflicting revisions and fails closed on uncertain writes", t => {
  const { paths } = fixture(t), service = new NativeMemoryConfig({ paths }); service.open();
  service.apply({ revision: 2, config: disabled });
  const reopened = new NativeMemoryConfig({ paths }); reopened.open();
  assert.deepEqual(reopened.read(), service.read());
  assert.deepEqual(reopened.apply({ config: disabled, revision: 2 }), service.read());
  assert.throws(() => reopened.apply({ revision: 1, config: {} }), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  assert.throws(() => reopened.apply({ revision: 2, config: {} }), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" });
  // A directory occupying the exact projection file prevents any valid commit.
  fs.unlinkSync(reopened.file); fs.mkdirSync(reopened.file);
  assert.throws(() => reopened.apply({ revision: 3, config: {} }), { code: "NATIVE_MEMORY_CONFIG_UNCERTAIN" });
  assert.throws(() => reopened.read(), { code: "NATIVE_MEMORY_CONFIG_UNCERTAIN" });
});

test("lost IPC reply is compensated with a newer revision and concurrent Core edits are preserved", async t => {
  const { store } = fixture(t); let applied, fail = true;
  const registry = { async applyNativeMemoryConfig(value) { applied = value;
    if (fail) { fail = false; throw Error("private transport error"); } return value; } };
  const controller = createNativeMemoryConfigController({ configStore: store, registry });
  await assert.rejects(controller.update({ expectedRevision: 0, config: disabled }), { code: "NATIVE_MEMORY_CONFIG_APPLY_FAILED" });
  assert.deepEqual(applied, { ...defaultNativeMemoryProjection(), revision: 2 });
  assert.deepEqual(store.read().nativeMemory, applied);
  registry.applyNativeMemoryConfig = async value => {
    store.writeNativeMemoryConfig({ expectedRevision: value.revision, config: disabled });
    throw Error("response lost while another writer committed");
  };
  await assert.rejects(controller.update({ expectedRevision: 2, config: {} }), { code: "NATIVE_MEMORY_CONFIG_ROLLBACK_PENDING" });
  assert.deepEqual(store.read().nativeMemory, { revision: 4, config: disabled });
});

test("real REST and authenticated IPC apply policy, reject bypasses and preserve the explicit owner gate", async t => {
  const { store } = fixture(t);
  const f = await startInspirationFixture({ agentCount: 1, configStore: store,
    serviceOptions: { memoryCore: true, prewarmMcpAuth: false } });
  t.after(() => f.close());
  const request = async (route, body, origin = f.url) => {
    const response = await fetch(`${f.url}/__api/${route}`, body === undefined ? {} : { method: "PUT",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    const raw = await response.text(); return { status: response.status, data: raw.startsWith("{") ? JSON.parse(raw) : raw };
  };
  assert.equal((await request("native-memory-config")).status, 200);
  const context = await request("native-memory-config/context");
  assert.equal(context.status, 200);
  assert.equal(context.data.owner, "shoggoth-memory-core");
  assert.deepEqual(context.data.agents, f.service.productStore.listAgentProfiles()
    .filter(profile => profile.enabled && profile.backendId === "shoggoth")
    .map(profile => ({ profileId: profile.id, agentId: profile.agentId, name: profile.name })));
  assert.equal((await request("native-memory-config/context", { owner: "legacy" })).status, 405);
  assert.equal(store.read().nativeMemory.revision, 0, "reading context cannot change configuration");
  await f.service.memoryEngine.propose({ profileId: DEFAULT_AGENT_PROFILE_ID, classification: "explicit",
    scope: "agent", sourceRefs: ["user:memory-editor"], content: "Amber telescope calibration is required." });
  let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const index = f.service.memoryEngine.host(DEFAULT_AGENT_PROFILE_ID).searchIndex;
  index.model = "config-race-fixture";
  index.embedding = { encode: async () => { entered(); await wait; return [1, 0]; } };
  const searching = f.service.memoryEngine.searchMemory({ profileId: DEFAULT_AGENT_PROFILE_ID, workspace: null, query: "calibration" });
  const rejected = assert.rejects(searching, { code: "MEMORY_CONFIG_CHANGED" });
  await arrived;
  const input = { expectedRevision: 0, config: disabled };
  assert.equal((await request("native-memory-config", input, null)).status, 403);
  assert.equal((await request("native-memory-config", input, "https://foreign.example")).status, 403);
  // The apply reply now joins the actual old owner. Release our provider gate
  // after the durable policy changed, before awaiting that physical retirement.
  const updating = request("native-memory-config", input); updating.catch(() => {});
  try {
    await until(() => f.service.nativeMemoryConfig.read().revision === 1,
      "the authenticated apply must commit before the old owner retires");
  } finally { release(); }
  const updated = await updating;
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.equal(updated.data.revision, 1);
  await rejected;
  assert.equal(f.service.memoryEngine.config(DEFAULT_AGENT_PROFILE_ID).memory.search.enabled, false);
  const result = await f.service.memoryEngine.searchMemory({ profileId: DEFAULT_AGENT_PROFILE_ID, workspace: null, query: "calibration" });
  assert.deepEqual(result.results, []);
  assert.equal((await request("native-memory-config", input)).data.code, "NATIVE_MEMORY_CONFIG_STALE");
  assert.equal((await request("native-memory-config", { expectedRevision: 1, config: { memoryCore: true } })).status, 400);
  await request("config", { locale: "en", nativeMemory: { revision: 900, config: {} } });
  assert.equal(store.read().nativeMemory.revision, 1);
  await assert.rejects(requestService(f.paths, { version: PROTOCOL_VERSION, token: "wrong-service-token",
    method: "memory.config.apply", params: { revision: 2, config: {} } }));
  assert.equal(f.service.nativeMemoryConfig.read().revision, 1);
  await f.service.stop({ notify: false }); await f.service.start();
  assert.equal(f.service.memoryEngine.config(DEFAULT_AGENT_PROFILE_ID).memory.search.enabled, false);
  assert.equal(f.service.nativeMemoryConfig.read().revision, 1);
  const reference = path.join(f.root, "library.md"), text = "Violet nebula appendix selected in Core settings.";
  fs.writeFileSync(reference, text, { mode: 0o600 });
  const extraPaths = { memory: { search: { provider: "none", extraPaths: [reference] } } };
  assert.equal((await request("native-memory-config", { expectedRevision: 1, config: extraPaths })).status, 200);
  const readLibrary = () => {
    const owner = f.service.memoryEngine, index = owner.host(DEFAULT_AGENT_PROFILE_ID).searchIndex;
    return owner.getFile({ profileId: DEFAULT_AGENT_PROFILE_ID, path: index.sourceFiles.relative(reference), workspace: null });
  };
  assert.equal(readLibrary().text, text);
  await f.service.stop({ notify: false }); await f.service.start();
  assert.equal(readLibrary().text, text);
  assert.equal((await request("native-memory-config", { expectedRevision: 2, config: { memory: { search: { provider: "none" } } } })).status, 200);
  assert.throws(readLibrary, { code: "MEMORY_PATH_NOT_ALLOWED" });
  assert.equal(fs.readFileSync(reference, "utf8"), text);
});

test("applying saved policy to an explicit legacy fixture does not migrate files or start a new owner", async t => {
  const local = fixture(t), { paths } = local;
  const service = createAgentService({ paths, memoryCore: false, version: "memory-config-old-owner", prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  local.close = () => service.stop({ notify: false }); await service.start();
  const projection = { revision: 1, config: { plugins: { entries: { "active-memory": { enabled: true } } } } };
  const response = await requestService(paths, { version: PROTOCOL_VERSION, token: readClientToken(paths), method: "memory.config.apply", params: projection });
  assert.deepEqual(response, projection);
  const context = await requestService(paths, { version: PROTOCOL_VERSION, token: readClientToken(paths), method: "memory.config.context", params: {} });
  assert.equal(context.owner, "legacy", "saved policy is not evidence that its engine is active");
  assert.notEqual(service.memoryEngine.owner, "shoggoth-memory-core");
  assert.equal(fs.existsSync(path.join(paths.agentsDir, DEFAULT_AGENT_PROFILE_ID, "memory-workspace")), false);
});

function configBarrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function configApplyFixture(t) {
  const local = fixture(t);
  const paths = resolveServicePaths({ homeDir: local.root, trustedRoot: local.root,
    stateRoot: path.join(local.root, "state"), cacheRoot: path.join(local.root, "cache"),
    profileRoot: path.join(local.root, "profile") });
  const service = createAgentService({ paths, memoryCore: true, memoryCoreConfig: disabled,
    version: "memory-config-singleflight-fixture", prewarmMcpAuth: false,
    parentEnv: { HOME: local.root, PATH: process.env.PATH, TMPDIR: local.root },
    runtimeStorageHomedir: local.root,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => Buffer.from(value).toString("utf8") } });
  const barriers = [];
  local.close = async () => {
    for (const barrier of barriers) barrier.release();
    await service.stop({ notify: false });
  };
  await service.start();
  const engine = service.memoryEngine, scans = [], storeApplies = [];
  const nativeApply = service.nativeMemoryConfig.apply;
  t.mock.method(service.nativeMemoryConfig, "apply", function (params) {
    storeApplies.push(params); return nativeApply.call(this, params);
  });
  assert.equal(engine.owner, "shoggoth-memory-core");
  engine.embedding = null;
  let modelCalls = 0;
  engine.complete = async () => { modelCalls++; assert.fail("config apply must not request a model"); };
  const f = { service, engine, scans, storeApplies, onSync: async () => {},
    barrier() { const barrier = configBarrier(); barriers.push(barrier); return barrier; },
    addOwnedHosts() {
      // Controlled already-owned indexes exercise the real Service reconcile
      // path without opening a memory database, source body, watcher or model.
      for (let n = 0; n < 3; n++) {
        const profileId = `config-singleflight-owned-${n}`;
        engine.hosts.set(profileId, { searchIndex: {
          async sync(params) {
            const revision = service.nativeMemoryConfig.read().revision;
            scans.push({ profileId, revision, params });
            await f.onSync({ profileId, revision });
          }, async close() {},
        }, database: { close() {} } });
      }
    },
    apply(revision, config = disabled, timeoutMs = 5_000) {
      return requestService(paths, { version: PROTOCOL_VERSION, token: readClientToken(paths),
        method: "memory.config.apply", params: { revision, config } }, { timeoutMs });
    },
    assertNoModels() { assert.equal(modelCalls, 0); },
  };
  f.addOwnedHosts();
  return f;
}

// Use the actual authenticated IPC route, exported NativeMemoryConfig and
// ShoggothMemoryService. Only the owned index work is a controllable fixture.
test("config apply joins identical in-flight requests after client timeout and caches only their successful ACK", async t => {
  const f = await configApplyFixture(t), gate = f.barrier();
  f.onSync = () => gate.promise;
  const timedOut = f.apply(1, disabled, 100);
  const timeoutCheck = assert.rejects(timedOut, { code: "REQUEST_TIMEOUT" });
  await until(() => f.scans.length === 3, "the first admitted projection must reach all owned indexes");
  await timeoutCheck;
  const second = f.apply(1), third = f.apply(1);
  await delay(50); // Keep the physical work owned while both IPC retries arrive.
  gate.release();
  assert.deepEqual(await second, validate({ revision: 1, config: disabled }));
  assert.deepEqual(await third, validate({ revision: 1, config: disabled }));
  assert.equal(f.scans.length, 3, "timed-out client retries must join one physical reconciliation");
  assert.equal(f.storeApplies.length, 1, "in-flight retries must share the admitted projection operation");
  assert.deepEqual(await f.apply(1), validate({ revision: 1, config: disabled }));
  assert.equal(f.storeApplies.length, 2, "successful ACK reuse must still validate the durable current revision");
  assert.equal(f.scans.length, 3, "an acknowledged equal projection must not scan owned indexes again");
  for (const scan of f.scans) assert.deepEqual(scan.params, { nativeParams: { reason: "config" } });
  f.assertNoModels();
});

test("config apply does not cache a persisted projection whose reconciliation failed", async t => {
  const f = await configApplyFixture(t);
  f.onSync = async () => { throw new Error("synthetic owned-index failure"); };
  await assert.rejects(f.apply(1), { code: "NATIVE_MEMORY_CONFIG_UNAVAILABLE" });
  assert.equal(f.service.nativeMemoryConfig.read().revision, 1, "persistence alone cannot prove successful reconciliation");
  assert.equal(f.scans.length, 3);
  f.onSync = async () => {};
  assert.deepEqual(await f.apply(1), validate({ revision: 1, config: disabled }));
  assert.equal(f.scans.length, 6, "the first failed apply must remain retryable");
  await f.apply(1);
  assert.equal(f.scans.length, 6, "only the successful retry may be cached");
  f.assertNoModels();
});

test("config apply serializes changed policy, retains stale/conflict validation and reconciles again after Service restart", async t => {
  const f = await configApplyFixture(t), oldGate = f.barrier(), newGate = f.barrier();
  const replacement = { memory: { search: { enabled: false, sources: ["sessions"] } } };
  f.onSync = ({ revision }) => revision === 1 ? oldGate.promise : newGate.promise;
  const first = f.apply(1);
  await until(() => f.scans.length === 3, "old policy must reach physical owned-index work");
  let secondSettled = false;
  const second = f.apply(2, replacement).then(value => { secondSettled = true; return value; });
  await delay(50);
  assert.equal(f.service.nativeMemoryConfig.read().revision, 1, "new policy cannot overtake physical old-policy reconciliation");
  assert.equal(f.scans.length, 3);
  oldGate.release();
  await first;
  await until(() => f.scans.length === 6, "the new revision must reconcile every already-owned index");
  assert.equal(secondSettled, false, "new revision cannot ACK before its own physical reconciliation");
  const joinedSecond = f.apply(2, replacement);
  newGate.release();
  assert.deepEqual(await second, validate({ revision: 2, config: replacement }));
  assert.deepEqual(await joinedSecond, validate({ revision: 2, config: replacement }));
  assert.equal(f.scans.length, 6);
  await assert.rejects(f.apply(1), { code: "NATIVE_MEMORY_CONFIG_STALE" });
  await assert.rejects(f.apply(2), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" });
  assert.equal(f.scans.length, 6, "rejected cached/stale revisions cannot invoke owned-index work");
  await f.service.stop({ notify: false });
  await f.service.start();
  f.addOwnedHosts();
  f.onSync = async () => {};
  assert.deepEqual(await f.apply(2, replacement), validate({ revision: 2, config: replacement }));
  assert.equal(f.scans.length, 9, "a new Service generation must reconcile its first equal durable projection");
  f.assertNoModels();
});

function backgroundConfig(sources, provider = "none") {
  // The pinned policy indexes sessions by default for cross-conversation
  // remembering. Select explicit source admission for this switching fixture.
  return { memory: { search: { provider, sources, rememberAcrossConversations: false,
    experimental: { sessionMemory: sources.includes("sessions") }, query: { minScore: 0 } } },
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } },
      "active-memory": { enabled: false } } } };
}

async function backgroundFixture(t, config) {
  const local = fixture(t), observers = [], searches = [];
  const nativeStart = core.MemoryFileWatcher.prototype.start;
  t.mock.method(core.MemoryFileWatcher.prototype, "start", function (...args) {
    observers.push(this); return nativeStart.apply(this, args);
  });
  const service = createAgentService({ paths: local.paths, memoryCore: true,
    memoryCoreConfig: config, version: "memory-config-background-fixture", prewarmMcpAuth: false,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => Buffer.from(value).toString("utf8") } });
  const sourceStores = [];
  local.close = async () => {
    await service.stop({ notify: false });
    for (const { name, store } of sourceStores) assert.equal(store.changeSubscriptions.size, 0,
      `${name}: the complete Service must retire every component's subscription`);
  };
  await service.start();
  const engine = service.memoryEngine;
  for (const [name, store] of [["TranscriptStore", service.transcriptStore],
    ["ChatSessionStore", service.chatSessionStore], ["RecallPolicy", engine.recallPolicy]]) {
    sourceStores.push({ name, store, serviceSubscriptions: new Set(store.changeSubscriptions) });
  }
  // No E5 worker, model download or remote model is admitted in this fixture.
  // The provider-change case below deliberately exercises pure FTS fallback.
  engine.embedding = null;
  let modelCalls = 0;
  engine.complete = async () => { modelCalls++; assert.fail("configuration reconciliation must not invoke a model"); };
  const { MemorySearchIndex } = require("../app/agent-service/shoggoth-memory/search-index.cjs");
  const nativeSearch = MemorySearchIndex.prototype.search;
  t.mock.method(MemorySearchIndex.prototype, "search", function (...args) {
    searches.push(args); return nativeSearch.apply(this, args);
  });
  const token = readClientToken(local.paths), profileId = DEFAULT_AGENT_PROFILE_ID;
  const apply = (revision, policy) => requestService(local.paths, { version: PROTOCOL_VERSION, token,
    method: "memory.config.apply", params: { revision, config: policy } }, { timeoutMs: 30_000 });
  // Product metadata alone supplies a second unopened Profile. No lifecycle
  // initializer, Runtime, workspace or memory host is started for it.
  const peer = { ...service.productStore.getAgentProfile(profileId), id: "config-unopened-profile",
    agentId: "config-unopened-agent", name: "Unopened memory config fixture", isDefault: false,
    runtimeProfileId: "config-unopened-runtime" };
  for (const field of ["bindings", "bindingOperations", "bindingsRevision", "defaultBindingId"]) delete peer[field];
  service.productStore.putAgentProfile(peer);
  const unopened = service.productStore.listAgentProfiles().filter(profile => profile.id !== profileId)
    .map(profile => ({ id: profile.id, database: path.join(local.paths.agentsDir, profile.id, "memory-core.sqlite") }));
  assert.ok(unopened.some(profile => profile.id === peer.id), "the unopened Profile check must have a real Product identity");
  assert.equal(engine.hosts.has(peer.id), false);
  assert.equal(fs.existsSync(path.join(local.paths.agentsDir, peer.id, "memory-core.sqlite")), false);
  const unopenedFiles = new Map(unopened.map(profile => [profile.id, fs.existsSync(profile.database)]));
  const currentIndex = () => {
    const host = engine.hosts.get(profileId);
    assert.ok(host, "configuration apply must retain the already-open Product host");
    return host.searchIndex;
  };
  const assertUnopened = () => {
    for (const profile of unopened) {
      assert.equal(engine.hosts.has(profile.id), false, "apply cannot acquire an unopened Profile owner");
      assert.equal(fs.existsSync(profile.database), unopenedFiles.get(profile.id), "apply cannot create an unopened Profile database");
    }
  };
  const assertListeners = count => {
    // Closing one native index must preserve other Service components' source
    // observers. Exact counts and identities still detect an index leak.
    for (const { name, store, serviceSubscriptions } of sourceStores) {
      assert.equal(store.changeSubscriptions.size, serviceSubscriptions.size + count,
        `${name}: exactly ${count} native-index subscriptions`);
      for (const subscription of serviceSubscriptions) assert.ok(store.changeSubscriptions.has(subscription),
        `${name}: configuration replacement must preserve other Service observers`);
    }
  };
  const append = (session, tag, text) => {
    const run = service.workDispatcher.enqueue({ id: `${tag}-run`, profileId, source: "chat",
      sourceId: session.sessionKey, idempotencyKey: `${tag}:direct`, workspace: session.workspace });
    service.workDispatcher.admit(run.id); service.workDispatcher.transition(run.id, "running");
    const event = service.transcriptStore.appendEvent({ profileId, sessionId: session.id,
      id: `${tag}-event`, runId: run.id, kind: "user", content: { text } });
    service.workDispatcher.transition(run.id, "completed");
    return event;
  };
  const session = (tag, text) => {
    const workspace = path.join(local.root, "chat-workspace"); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const created = service.chatSessionStore.createSession({ profileId, workspace,
      operationId: `${tag}-session`, createdAt: Date.now() });
    service.chatSessionStore.requestBinding(created.sessionKey, `${tag}-binding`, Date.now());
    service.chatSessionStore.completeBinding(created.sessionKey, `${tag}-binding`, `${tag}-runtime-session`);
    const ready = service.chatSessionStore.getSession(created.sessionKey); append(ready, tag, text); return ready;
  };
  const write = (relative, content) => {
    const target = path.join(engine.store.workspace(profileId), relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });
  };
  const source = (index, relative, kind) => index.db.prepare("SELECT hash FROM memory_index_sources WHERE path=? AND source=?").get(relative, kind);
  const text = (index, relative, kind) => index.db.prepare("SELECT text FROM memory_index_chunks WHERE path=? AND source=? ORDER BY start_line")
    .all(relative, kind).map(row => row.text).join("\n");
  const openIndex = async () => {
    const index = engine.host(profileId).searchIndex;
    await index.sync();
    await until(() => index.searchOwner.backgroundStarted && !index.searchOwner.syncing && !index.searchOwner.activeManagerOperations,
      "the initial native background owner must finish startup catchup");
    return index;
  };
  const readyWatcher = async index => {
    assert.ok(index.searchOwner.memoryWatchSubscription, "the new owner must install a native memory watcher");
    await until(() => observers.some(observer => !observer.closed && observer.observations.size > 0
      && [...observer.observations.values()].every(entry => entry.subscription.health().state === "ready")),
    "the new actual native observer must become ready");
  };
  const assertRetired = (index, owner) => {
    assert.equal(owner.closed, true, "apply cannot return before the old native owner retires");
    assert.equal(owner.sessionUnsubscribe, null, "old Product transcript subscription retired");
    assert.equal(owner.memoryWatchSubscription, undefined, "old filesystem subscription retired");
    assert.equal(owner.sessionWatchTimer, null);
    assert.notEqual(index.searchOwner, owner);
    assert.equal(index.searchOwner.stamp, index.configStamp(), "the replacement owner must use the durable current config");
    assert.notEqual(index.searchOwner.stamp, owner.stamp);
  };
  return { ...local, service, engine, profileId, apply, observers, currentIndex, assertUnopened, assertListeners,
    append, session, write, source, text, openIndex, readyWatcher, assertRetired,
    assertNoSearchOrModels() { assert.equal(searches.length, 0); assert.equal(modelCalls, 0); } };
}

test("authenticated config apply retires the old source owner and admits new file/transcript events without search", { timeout: 60_000 }, async t => {
  const memory = backgroundConfig(["memory"]), sessions = backgroundConfig(["sessions"]);
  const f = await backgroundFixture(t, memory);
  const chat = f.session("source-config", "Synthetic violet lighthouse history precedes the source change.");
  f.write("memory/config-baseline.md", "Synthetic amber lighthouse file precedes configuration.");
  let index = await f.openIndex(); await f.readyWatcher(index);
  assert.ok(f.source(index, "memory/config-baseline.md", "memory"));
  assert.equal(f.source(index, index.sessionPath(chat.id), "sessions"), undefined);
  f.assertListeners(0);
  const previous = index.searchOwner, oldObservers = f.observers.slice();
  assert.deepEqual(await f.apply(1, sessions), validate({ revision: 1, config: sessions }));
  index = f.currentIndex(); f.assertRetired(index, previous); f.assertListeners(1); f.assertUnopened();
  assert.equal(f.source(index, "memory/config-baseline.md", "memory"), undefined);
  assert.match(f.text(index, index.sessionPath(chat.id), "sessions"), /violet lighthouse/u);
  for (const observer of oldObservers) { assert.equal(observer.closed, true); assert.equal(observer.observations.size, 0); }
  f.append(chat, "source-config-late", "Synthetic silver lighthouse arrived after authenticated source apply.");
  await until(() => f.text(index, index.sessionPath(chat.id), "sessions").includes("silver lighthouse"),
    "the new transcript listener must index after apply without any search");
  f.write("memory/excluded-after-config.md", "Synthetic excluded copper file.");
  await delay(100);
  assert.equal(f.source(index, "memory/excluded-after-config.md", "memory"), undefined);
  const previousSessions = index.searchOwner;
  assert.deepEqual(await f.apply(2, memory), validate({ revision: 2, config: memory }));
  index = f.currentIndex(); f.assertRetired(index, previousSessions); f.assertListeners(0); f.assertUnopened();
  assert.equal(f.source(index, index.sessionPath(chat.id), "sessions"), undefined);
  await f.readyWatcher(index);
  f.write("memory/new-after-config.md", "Synthetic golden lighthouse arrived after native watcher replacement.");
  await until(() => f.text(index, "memory/new-after-config.md", "memory").includes("golden lighthouse"),
    "the replacement filesystem observer must index a new file without search");
  f.assertNoSearchOrModels();
});

test("authenticated provider/revision changes replace native ownership while rejected policies preserve it", { timeout: 60_000 }, async t => {
  const none = backgroundConfig(["sessions"]), unavailableE5 = backgroundConfig(["sessions"], "shoggoth-e5");
  const f = await backgroundFixture(t, none);
  const chat = f.session("provider-config", "Synthetic indigo lighthouse remains in the keyword generation.");
  let index = await f.openIndex(), previous = index.searchOwner;
  f.assertListeners(1);
  assert.deepEqual(await f.apply(1, none), validate({ revision: 1, config: none }));
  index = f.currentIndex(); f.assertRetired(index, previous); f.assertListeners(1); f.assertUnopened();
  assert.equal(f.engine.config(f.profileId)._shoggothConfigRevision, 1);
  previous = index.searchOwner;
  assert.deepEqual(await f.apply(2, unavailableE5), validate({ revision: 2, config: unavailableE5 }));
  index = f.currentIndex(); f.assertRetired(index, previous); f.assertListeners(1); f.assertUnopened();
  assert.equal(index.settings.provider, "shoggoth-e5"); assert.equal(index.activeEmbedding, null);
  assert.equal(index.embeddingExecutor.provider, null, "an unavailable local provider cannot start a worker in this fixture");
  assert.equal(index.db.prepare("SELECT count(*) AS n FROM memory_index_chunks WHERE model<>'fts-only'").get().n, 0);
  assert.match(f.text(index, index.sessionPath(chat.id), "sessions"), /indigo lighthouse/u);
  previous = index.searchOwner;
  assert.deepEqual(await f.apply(3, none), validate({ revision: 3, config: none }));
  index = f.currentIndex(); f.assertRetired(index, previous); f.assertListeners(1); f.assertUnopened();
  const active = index.searchOwner, activeStamp = active.stamp;
  for (const [revision, policy, code] of [
    [4, { memory: { search: { provider: "unsupported/local" } } }, "NATIVE_MEMORY_CONFIG_INVALID"],
    [3, unavailableE5, "NATIVE_MEMORY_CONFIG_CONFLICT"],
    [2, none, "NATIVE_MEMORY_CONFIG_STALE"],
  ]) {
    await assert.rejects(f.apply(revision, policy), { code });
    assert.equal(f.currentIndex().searchOwner, active, "a rejected policy must not retire the admitted owner");
    assert.equal(active.closed, false); assert.equal(active.stamp, activeStamp);
    assert.equal(f.service.nativeMemoryConfig.read().revision, 3); f.assertListeners(1);
  }
  f.append(chat, "provider-config-late", "Synthetic cyan lighthouse proves the current listener still receives durable events.");
  await until(() => f.text(index, index.sessionPath(chat.id), "sessions").includes("cyan lighthouse"),
    "the replacement owner must still index after revision/provider changes and rejected applies");
  f.assertNoSearchOrModels();
});

test("authenticated config apply never reopens stopped or unopened Profile indexes", { timeout: 30_000 }, async t => {
  const f = await backgroundFixture(t, backgroundConfig(["sessions"]));
  f.session("stopped-config", "Synthetic stopped lighthouse remains durable without a live observer.");
  const index = await f.openIndex(), previous = index.searchOwner;
  await f.engine.stopProfile(f.profileId);
  assert.equal(index.db, null); assert.equal(previous.closed, true); f.assertListeners(0);
  assert.equal(f.engine.hosts.size, 0);
  const database = path.join(f.paths.agentsDir, f.profileId, "memory-core.sqlite"), bytes = fs.readFileSync(database);
  const policy = backgroundConfig(["memory", "sessions"]);
  assert.deepEqual(await f.apply(1, policy), validate({ revision: 1, config: policy }));
  assert.equal(f.engine.hosts.size, 0); f.assertListeners(0); f.assertUnopened();
  assert.deepEqual(fs.readFileSync(database), bytes, "applying config cannot write a stopped Profile database");
  assert.throws(() => f.engine.host(f.profileId), { code: "MEMORY_SCOPE_REVOKED" });
  f.assertNoSearchOrModels();
});
