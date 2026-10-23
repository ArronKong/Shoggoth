#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { CHANNELS, registerDesktopModelOperationRecoveryIpc } = require("../app/desktop-model-operation-recovery-ipc");
const tests = [], test = (name, run) => tests.push({ name, run });
const operation = { version: 1, backendId: "openclaw", providerKey: "fixture-provider", operationId: "original-operation", status: "unconfirmed" };
const identity = { version: 1, backendId: operation.backendId, providerKey: operation.providerKey, operationId: operation.operationId };
function fixture(storeOverride, loader) {
  const handlers = new Map(), calls = [];
  const frame = { url: "http://127.0.0.1:19000/#/models" };
  const wc = { mainFrame: frame, isDestroyed: () => false }, window = { webContents: wc, isDestroyed: () => false };
  const state = { window, origin: "http://127.0.0.1:19000" };
  const store = storeOverride || {
    async read() { calls.push("read"); return { version: 1, revision: 0, operations: [operation] }; },
    async retain(row) { calls.push({ retain: row }); return { version: 1, revision: 1, operation: row }; },
    async ack(row) { calls.push({ ack: row }); return { ...row, revision: 2, status: "acknowledged", outcome: "applied" }; },
  };
  const owner = registerDesktopModelOperationRecoveryIpc({
    ipcMain: { handle(key, handler) { handlers.set(key, handler); }, removeHandler(key) { handlers.delete(key); } },
    getMainWindow: () => state.window, getUiOrigin: () => state.origin,
    async getStore() { calls.push("getStore"); return loader ? loader(store) : store; },
  });
  const event = { sender: wc, senderFrame: frame };
  return { handlers, calls, state, frame, wc, event, owner,
    invoke(method, ...args) { return handlers.get(CHANNELS[method])(event, ...args); } };
}
test("only the current main window/main frame at the configured management origin can read safe identities", async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: f.frame }, { sender: f.wc, senderFrame: { url: f.frame.url } }, {}])
    assert.equal((await f.handlers.get(CHANNELS.read)(event)).error.code, "MODEL_RECOVERY_CALLER_REQUIRED");
  for (const url of ["https://example.invalid/", "http://127.0.0.1:19001/", "http://127.0.0.1:19000/__plugin/app", "http://127.0.0.1:19000/?extra=1", "file:///private/tmp/fixture.html"]) {
    f.frame.url = url; assert.equal((await f.invoke("read")).ok, false);
  }
  assert.deepEqual(f.calls, []); f.owner.dispose();
});
test("closed input rejects getters, symbols, request bodies and additional arguments before obtaining the store", async () => {
  const f = fixture(); let getters = 0; const accessor = { ...operation };
  Object.defineProperty(accessor, "operationId", { enumerable: true, get() { getters++; return operation.operationId; } });
  for (const bad of [null, [], { ...operation, spec: {} }, { ...operation, apiKey: "test-canary" }, { ...operation, [Symbol("extra")]: true },
    accessor, { ...operation, operationId: "x".repeat(129) }, { ...operation, status: "applied" }, { ...operation, code: "arbitrary-code" }])
    assert.equal((await f.invoke("retain", bad)).error.code, "MODEL_RECOVERY_INVALID_REQUEST");
  assert.equal((await f.invoke("read", {})).error.code, "MODEL_RECOVERY_INVALID_REQUEST");
  assert.equal((await f.invoke("ack", { ...identity, outcome: "applied" })).error.code, "MODEL_RECOVERY_INVALID_REQUEST");
  assert.equal((await f.invoke("ack", identity, {})).error.code, "MODEL_RECOVERY_INVALID_REQUEST");
  assert.equal(getters, 0); assert.deepEqual(f.calls, []); f.owner.dispose();
});
test("read, retain and acknowledged outcome are exact projected receipts, not permissions or credentials", async () => {
  const f = fixture();
  const read = await f.invoke("read"); assert.equal(read.ok, true); assert.deepEqual(read.value, { version: 1, revision: 0, operations: [operation] });
  const requested = { ...operation, code: "model_recovery_requested" };
  assert.deepEqual((await f.invoke("retain", requested)).value, { version: 1, revision: 1, operation: requested });
  assert.deepEqual((await f.invoke("ack", identity)).value, { ...identity, revision: 2, status: "acknowledged", outcome: "applied" });
  assert(Object.isFrozen(f.calls.find(value => value?.retain)?.retain)); f.owner.dispose();
});
test("identity scalars are captured before opening the store; caller mutation cannot change later retained data", async () => {
  let release; const held = new Promise(resolve => { release = resolve; }); const f = fixture(null, async store => { await held; return store; });
  const input = { ...operation }, response = f.invoke("retain", input); input.operationId = "replacement-operation"; input.providerKey = "replacement-provider";
  release(); assert.equal((await response).value.operation.operationId, operation.operationId);
  assert.equal(f.calls.find(value => value?.retain).retain.providerKey, operation.providerKey); f.owner.dispose();
});
test("a window retired while the store opens cannot retain or acknowledge an operation", async () => {
  let release; const held = new Promise(resolve => { release = resolve; }); const f = fixture(null, async store => { await held; return store; });
  const response = f.invoke("retain", operation); f.state.window = null; release();
  assert.equal((await response).error.code, "MODEL_RECOVERY_CALLER_RETIRED"); assert.deepEqual(f.calls, ["getStore"]); f.owner.dispose();
});
test("a completed store action whose renderer navigated away publishes no stale successful receipt", async () => {
  let release; const held = new Promise(resolve => { release = resolve; }), calls = [];
  const f = fixture({ async retain(row) { calls.push(row); await held; return { version: 1, revision: 1, operation: row }; } });
  const response = f.invoke("retain", operation); await Promise.resolve(); await Promise.resolve();
  f.frame.url = "https://example.invalid/"; release(); assert.equal((await response).error.code, "MODEL_RECOVERY_CALLER_RETIRED");
  assert.equal(calls.length, 1); f.owner.dispose();
});
test("a missing or failed store is unavailable rather than an empty verified list; private errors are not returned", async () => {
  for (const loader of [async () => null, async () => { throw Error("private path /secret/key must not escape"); }]) {
    const f = fixture(null, loader), response = await f.invoke("read");
    assert.equal(response.error.code, "MODEL_RECOVERY_STORE_UNAVAILABLE"); assert.equal(JSON.stringify(response).includes("/secret/key"), false); f.owner.dispose();
  }
});
test("invalid, secret-bearing, duplicate, sparse or getter-based store snapshots never cross IPC", async () => {
  let getters = 0; const sparse = new Array(1), accessor = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { getters++; return operation; } });
  for (const bad of [{ version: 1, revision: 0, operations: [operation], secret: "not-for-renderer" },
    { version: 1, revision: 0, operations: [{ ...operation, permit: {} }] }, { version: 1, revision: -1, operations: [] },
    { version: 1, revision: 0, operations: [operation, { ...operation, backendId: "hermes" }] },
    { version: 1, revision: 0, operations: sparse }, { version: 1, revision: 0, operations: accessor }]) {
    const f = fixture({ async read() { return bad; } }); assert.equal((await f.invoke("read")).error.code, "MODEL_RECOVERY_RESPONSE_UNVERIFIED"); f.owner.dispose();
  }
  assert.equal(getters, 0);
});
test("foreign retain/ack IDs or missing recovery marker cannot release the original operation", async () => {
  for (const changed of [{ ...operation, operationId: "foreign-operation" }, { ...operation, providerKey: "other-provider" }, { ...operation, backendId: "hermes" }, operation]) {
    const f = fixture({ async retain() { return { version: 1, revision: 1, operation: changed }; } });
    assert.equal((await f.invoke("retain", { ...operation, code: "model_recovery_requested" })).error.code, "MODEL_RECOVERY_RESPONSE_UNVERIFIED"); f.owner.dispose();
  }
  for (const patch of [{ operationId: "foreign-operation" }, { outcome: "partial" }, { status: "applied" }, { secret: "not-for-renderer" }]) {
    const f = fixture({ async ack() { return { ...identity, revision: 2, status: "acknowledged", outcome: "applied", ...patch }; } });
    assert.equal((await f.invoke("ack", identity)).error.code, "MODEL_RECOVERY_RESPONSE_UNVERIFIED"); f.owner.dispose();
  }
});
test("disposal removes all channels and retires already waiting callbacks", async () => {
  let release; const held = new Promise(resolve => { release = resolve; }); const f = fixture(null, async store => { await held; return store; });
  const response = f.invoke("read"); f.owner.dispose(); f.owner.dispose(); assert.equal(f.handlers.size, 0); release();
  assert.equal((await response).error.code, "MODEL_RECOVERY_CALLER_RETIRED"); assert.deepEqual(f.calls, ["getStore"]);
});
(async () => { const names = []; for (const { name, run } of tests) { await run(); names.push(name); }
  console.log(JSON.stringify({ verified: true, groups: names.length, tests: names,
    boundary: "production recovery IPC adapter with controlled Electron sender/store; no actual BrowserWindow, persistence, Host/model/account or App restart claim" }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
