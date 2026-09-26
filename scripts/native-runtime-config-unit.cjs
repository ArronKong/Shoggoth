#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConfigStore, normalizeConfig, projectNativeRuntimeConfig } = require("../app/core/config-store");
const { createNativeRuntimeConfigController } = require("../app/core/native-runtime-config-controller");
const { validateNativeRuntimeConfigProjection, validateNativeCapacitySnapshot } = require("../app/agent-service/native-runtime-config-protocol");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-config-"));
let serial = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function fixture() {
  const store = createConfigStore(path.join(temp, `config-${++serial}.json`));
  store.write({ token: "unrelated-fixture-token", locale: "en" });
  const calls = [];
  let applied = projectNativeRuntimeConfig(store.read());
  let failCount = 0;
  const registry = {
    async applyNativeRuntimeConfig(input) {
      calls.push(input);
      applied = validateNativeRuntimeConfigProjection(input);
      if (failCount-- > 0) throw new Error("response lost after application");
      return applied;
    },
    async getNativeCapacity() {
      return { revision: applied.revision, maxActive: applied.maxActive,
        startupConcurrency: applied.startupConcurrency, enabled: applied.flags.runtimeAdmissionV1,
        active: 12, queued: 1, byReason: [{ reason: "GLOBAL_CAPACITY", count: 1 }] };
    },
  };
  return { store, calls, registry, controller: createNativeRuntimeConfigController({ configStore: store, registry }),
    fail(count) { failCount = count; }, applied: () => applied };
}
const change = (expectedRevision = 0, maxActive = 50) => ({ expectedRevision, maxActive, startupConcurrency: 8, enabled: true });

test("fresh App persistence is 100/8 with all shipped Runtime features enabled", () => {
  const { store } = fixture();
  assert.deepEqual(store.read().nativeConcurrency, { maxActive: 100, startupConcurrency: 8, revision: 0 });
  const current = projectNativeRuntimeConfig(store.read());
  assert.equal(Object.keys(current.flags).length, 4);
  assert.ok(Object.values(current.flags).every((value) => value === true));
  const saved = store.writeNativeRuntimeConfig({ expectedRevision: 0, maxActive: 40, startupConcurrency: 3,
    flags: { ...current.flags, runtimeAdmissionV1: true } });
  assert.deepEqual(saved.nativeConcurrency, { maxActive: 40, startupConcurrency: 3, revision: 1 });
  assert.equal(saved.token, "unrelated-fixture-token");
  assert.equal(saved.locale, "en");
  assert.ok(Object.isFrozen(projectNativeRuntimeConfig(saved).flags));
});

test("first-run ensure persists enabled features while explicit disabled choices survive restart", () => {
  const store = createConfigStore(path.join(temp, `config-${++serial}.json`));
  store.ensure();
  assert.ok(Object.values(JSON.parse(fs.readFileSync(store.path)).runtimeFrameworkFlags).every(Boolean));
  const disabled = Object.fromEntries(Object.keys(store.read().runtimeFrameworkFlags).map(key => [key, false]));
  store.writeNativeRuntimeConfig({ expectedRevision: 0, maxActive: 100, startupConcurrency: 8, flags: disabled });
  const reopened = createConfigStore(store.path);
  reopened.ensure();
  assert.deepEqual(projectNativeRuntimeConfig(reopened.read()).flags, disabled);
});

test("invalid persisted capacity fails closed and keeps its recoverable revision", () => {
  const normal = normalizeConfig({ nativeConcurrency: { maxActive: 0, startupConcurrency: 8, revision: 10 },
    runtimeFrameworkFlags: { runtimeAdmissionV1: true } });
  assert.equal(normal.nativeConcurrency.maxActive, 100);
  assert.equal(normal.nativeConcurrency.revision, 10);
  assert.equal(normal.runtimeFrameworkFlags.runtimeAdmissionV1, false);
});

test("unreadable or malformed existing config never enables the fresh-install defaults", () => {
  const store = createConfigStore(path.join(temp, `config-${++serial}.json`));
  for (const raw of ["{broken", "null", "[]", "42", JSON.stringify({ runtimeFrameworkFlags: { runtimeMultiBinding: "true" } })]) {
    fs.writeFileSync(store.path, raw);
    assert.ok(Object.values(store.read().runtimeFrameworkFlags).every(flag => flag === false));
  }
  fs.unlinkSync(store.path);
  fs.mkdirSync(store.path);
  assert.ok(Object.values(store.read().runtimeFrameworkFlags).every(flag => flag === false));
  fs.rmdirSync(store.path);
  assert.ok(Object.values(store.read().runtimeFrameworkFlags).every(Boolean), "only missing config receives product defaults");
});

test("CAS rejects stale and invalid writes without changing disk", () => {
  const { store } = fixture();
  const before = fs.readFileSync(store.path, "utf8");
  const flags = projectNativeRuntimeConfig(store.read()).flags;
  for (const maxActive of [0, 101, 2.5, "100"]) {
    assert.throws(() => store.writeNativeRuntimeConfig({ expectedRevision: 0, maxActive, startupConcurrency: 8, flags }),
      { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  }
  assert.throws(() => store.writeNativeRuntimeConfig({ expectedRevision: 2, maxActive: 50, startupConcurrency: 8, flags }),
    { code: "NATIVE_RUNTIME_CONFIG_STALE" });
  assert.equal(fs.readFileSync(store.path, "utf8"), before);
  fs.writeFileSync(store.path, "{broken");
  assert.throws(() => store.writeNativeRuntimeConfig({ expectedRevision: 0, maxActive: 50, startupConcurrency: 8, flags }),
    { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  assert.equal(fs.readFileSync(store.path, "utf8"), "{broken");
});

test("wire projections reject accessors, extra fields and secrets without invoking getters", () => {
  const projection = projectNativeRuntimeConfig(normalizeConfig({}));
  let getters = 0;
  const accessor = { ...projection };
  Object.defineProperty(accessor, "maxActive", { enumerable: true, get() { getters++; return 50; } });
  for (const candidate of [accessor, { ...projection, prompt: "private" },
    { ...projection, flags: { ...projection.flags, runtimeFrameworkV2: true } },
    { ...projection, startupConcurrency: 17 }, { ...projection, revision: -1 }]) {
    assert.throws(() => validateNativeRuntimeConfigProjection(candidate), { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  }
  assert.equal(getters, 0);
});

test("lower limits preserve existing active work; queue metadata is bounded", () => {
  const value = { revision: 1, maxActive: 5, startupConcurrency: 1, enabled: true,
    active: 100, queued: 1, byReason: [{ reason: "GLOBAL_CAPACITY", count: 1 }] };
  assert.equal(validateNativeCapacitySnapshot(value).active, 100);
  for (const byReason of [[{ reason: "private user prompt", count: 1 }],
    [{ reason: "GLOBAL_CAPACITY", count: 2 }], [{ reason: "GLOBAL_CAPACITY", count: 0 }]]) {
    assert.throws(() => validateNativeCapacitySnapshot({ ...value, byReason }), { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  }
});

test("successful settings writes wait for application and return effective counters", async () => {
  const f = fixture();
  const result = await f.controller.update(change());
  assert.equal(result.revision, 1);
  assert.equal(result.maxActive, 50);
  assert.equal(result.active, 12);
  assert.equal(result.enabled, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied().flags.runtimeAdmissionV1, true);
});

test("lost apply response compensates both core and Service with a newer revision", async () => {
  const f = fixture();
  f.fail(1);
  await assert.rejects(() => f.controller.update(change()), { code: "NATIVE_RUNTIME_CONFIG_APPLY_FAILED" });
  assert.deepEqual(f.calls.map((entry) => entry.revision), [1, 2]);
  assert.equal(f.store.read().nativeConcurrency.maxActive, 100);
  assert.equal(f.applied().maxActive, 100);
  assert.equal(f.applied().flags.runtimeAdmissionV1, true);
  assert.equal(f.store.read().token, "unrelated-fixture-token");
});

test("a stale capacity response cannot claim a configuration was applied", async () => {
  const f = fixture();
  const readCapacity = f.registry.getNativeCapacity;
  f.registry.getNativeCapacity = async () => ({ ...await readCapacity(), revision: 0 });
  await assert.rejects(() => f.controller.update(change()), { code: "NATIVE_RUNTIME_CONFIG_APPLY_FAILED" });
  assert.deepEqual(f.calls.map((entry) => entry.revision), [1, 2]);
  assert.equal(f.store.read().nativeConcurrency.maxActive, 100);
});

test("unconfirmed compensation stays explicit and reconnect applies the core authority", async () => {
  const f = fixture();
  f.fail(2);
  await assert.rejects(() => f.controller.update(change()), { code: "NATIVE_RUNTIME_CONFIG_ROLLBACK_PENDING" });
  const refreshed = await f.controller.read();
  assert.equal(refreshed.maxActive, 100);
  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.enabled, true);
});

test("concurrent stale edits cannot overwrite the first accepted configuration", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.controller.update(change(0, 35)), f.controller.update(change(0, 60))]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.code, "NATIVE_RUNTIME_CONFIG_STALE");
  assert.equal(f.store.read().nativeConcurrency.maxActive, 35);
  assert.equal(f.calls.length, 1);
});

test("shared native facades route one capacity call by capability, without multiplying totals", async () => {
  const registry = new BackendRegistry();
  let calls = 0;
  for (const id of ["fixture-native-a", "fixture-native-b"]) registry.register({
    id, name: id,
    getBackendDescriptor() { return { id, name: id, disconnectable: true, surfaces: { nativeCapacity: true } }; },
    getNativeCapacity() { calls++; return { active: 9 }; },
  });
  assert.equal((await registry.getNativeCapacity()).active, 9);
  assert.equal(calls, 1);
  registry.setDisabledBackendsProvider(() => ["fixture-native-a"]);
  assert.equal((await registry.getNativeCapacity()).active, 9);
  assert.equal(calls, 2);
});

test("native facade uses authenticated IPC and validates both new result contracts", async () => {
  const calls = [];
  let applied = projectNativeRuntimeConfig(normalizeConfig({}));
  const backend = new ShoggothBackend({
    paths: {}, readToken: () => "isolated-test-token", requestService: async (_paths, request) => {
      calls.push(request);
      if (request.method === "runtime.config.apply") return applied = request.params;
      return { revision: applied.revision, maxActive: applied.maxActive, startupConcurrency: applied.startupConcurrency,
        enabled: false, active: 2, queued: 0, byReason: [] };
    },
  });
  await backend.applyNativeRuntimeConfig(applied);
  assert.equal((await backend.getNativeCapacity()).active, 2);
  assert.deepEqual(calls.map((entry) => entry.method), ["runtime.config.apply", "runtime.capacity.read"]);
  assert.ok(calls.every((entry) => entry.token === "isolated-test-token"));
  assert.equal(backend.getBackendDescriptor().surfaces.nativeCapacity, true);
});

(async () => {
  try {
    for (const { name, fn } of tests) { await fn(); console.log(`PASS ${name}`); }
    console.log(`Native runtime config: ${tests.length}/${tests.length} passed (isolated config and IPC fixtures).`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
