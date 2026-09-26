"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NativeRuntimeConfig, defaultNativeRuntimeConfig } = require("../app/agent-service/native-runtime-config");
const { RuntimeStartupGate } = require("../app/agent-service/runtime-startup-gate");
const { RuntimeAccountAdmission } = require("../app/agent-service/runtime-account-admission");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");

test("Service persists only a validated, monotonic projection and rejects same-revision conflicts", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-config-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  const store = new NativeRuntimeConfig({ paths, onApplied() { throw new Error("observer"); } });
  store.open();
  const config = defaultNativeRuntimeConfig();
  assert.deepEqual(store.read(), config);
  config.revision = 1;
  config.flags = { ...config.flags, runtimeAdmissionV1: true };
  store.apply(config);
  assert.deepEqual(store.apply(config), config);
  assert.throws(() => store.apply({ ...config, revision: 0 }), { code: "NATIVE_RUNTIME_CONFIG_STALE" });
  assert.throws(() => store.apply({ ...config, maxActive: 1 }), { code: "NATIVE_RUNTIME_CONFIG_CONFLICT" });
  assert.throws(() => store.apply({ ...config, revision: 2, maxActive: 101 }), { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  const reopened = new NativeRuntimeConfig({ paths });
  reopened.open();
  assert.deepEqual(reopened.read(), config);
  const read = reopened.read(); read.flags.runtimeAdmissionV1 = false;
  assert.equal(reopened.read().flags.runtimeAdmissionV1, true);
});

test("startup gate handles lowering, cancellation, recovery waiters and rollback without over-admission", async () => {
  const config = defaultNativeRuntimeConfig();
  config.flags = { ...config.flags, runtimeAdmissionV1: true };
  config.startupConcurrency = 2;
  const gate = new RuntimeStartupGate({ getConfig: () => config });
  assert.equal(gate.acquire("one"), true);
  assert.equal(gate.acquire("two"), true);
  assert.equal(gate.acquire("three"), false);
  config.startupConcurrency = 1;
  const controller = new AbortController();
  const waiting = gate.wait("canceled", controller.signal);
  controller.abort();
  await assert.rejects(waiting, { code: "RUNTIME_STARTUP_CANCELED" });
  let acquired = false;
  const recovered = gate.wait("recover").then(() => { acquired = true; });
  gate.release("one");
  await Promise.resolve(); assert.equal(acquired, false);
  gate.release("two");
  await recovered; assert.equal(gate.read().active, 1);
  config.flags = { ...config.flags, runtimeAdmissionV1: false };
  assert.equal(gate.acquire("legacy"), true);
  assert.equal(gate.read().active, 1);
  gate.release("recover");
  assert.equal(gate.waiters.size, 0);
  assert.equal(gate.read().active, 0);
});

test("account gate supports 100 and recovers durable active reservations after a lower limit", () => {
  const account = DEFAULT_RUNTIME_ACCOUNTS[0];
  let limit = 100;
  const admission = new RuntimeAccountAdmission({ runtimeAccountLookup: () => account, resolveMaxActive: () => limit });
  for (let i = 0; i < 100; i++) {
    assert.equal(admission.admit({ runtimeAccountId: account.id, runId: `run-${i}` }).disposition, "started");
  }
  assert.equal(admission.admit({ runtimeAccountId: account.id, runId: "overflow" }).disposition, "queued");
  limit = 1;
  admission.release({ runtimeAccountId: account.id, runId: "run-0" });
  assert.equal(admission.admit({ runtimeAccountId: account.id, runId: "run-0", recovering: true }).disposition, "started");
  assert.equal(admission.read(account.id).active, 100);
  assert.equal(admission.admit({ runtimeAccountId: account.id, runId: "overflow" }).disposition, "queued");
});


test("authenticated Service socket applies configuration and headless restart preserves its projection", async t => {
  const { randomUUID } = require("node:crypto");
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
  const { requestService, readClientToken } = require("../app/agent-service/client");
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "sg-capacity-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profiles") });
  const service = createAgentService({ paths, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
  }, runtimeManager: { acquire() { throw new Error("This test must not start a Runtime"); }, stop() {}, stopAll() {} } });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const ipc = (method, params) => requestService(paths, {
    id: randomUUID(), version: PROTOCOL_VERSION, token: readClientToken(paths), method, params,
  });
  await service.start();
  assert.deepEqual(await ipc("runtime.capacity.read", {}), { revision: 0, maxActive: 100,
    startupConcurrency: 8, enabled: false, active: 0, queued: 0, byReason: [] });
  const next = defaultNativeRuntimeConfig(); next.revision = 1; next.maxActive = 75;
  next.flags = { ...next.flags, runtimeAdmissionV1: true };
  assert.deepEqual(await ipc("runtime.config.apply", next), next);
  assert.equal((await ipc("runtime.capacity.read", {})).enabled, true);
  await assert.rejects(ipc("runtime.config.apply", { ...next, revision: 0 }), { code: "NATIVE_RUNTIME_CONFIG_STALE" });
  await assert.rejects(ipc("runtime.capacity.read", { unexpected: true }), { code: "NATIVE_RUNTIME_CONFIG_INVALID" });
  await service.stop(); await service.start();
  const restored = await ipc("runtime.capacity.read", {});
  assert.equal(restored.maxActive, 75); assert.equal(restored.enabled, true); assert.equal(restored.revision, 1);
});
