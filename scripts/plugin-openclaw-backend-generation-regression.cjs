#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { WebSocketServer } = require("ws");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { generateIdentity } = require("../app/core/device-auth");
const { createManagedOpenClawEndpointGeneration } = require("../app/managed-openclaw-endpoint-generation");
const identity = generateIdentity();
const auth = { ...identity, token: "isolated-local-fixture-token", scopes: ["operator.read", "operator.write"] };
const hello = { type: "hello-ok", protocol: 4, server: { version: "2026.9.1" }, features: { methods: [], events: [], capabilities: [] },
  auth: { role: "operator", scopes: ["operator.read", "operator.write"], deviceToken: "isolated-issued-token", issuedAtMs: 1 },
  policy: { maxPayload: 100000, maxBufferedBytes: 200000 } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { const deadline = Date.now() + 4000; while (!condition()) { if (Date.now() > deadline) throw new Error("local fixture timed out"); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function fixture(t, options = {}) {
  const server = http.createServer(), wss = new WebSocketServer({ server }), frames = [], sockets = [], stored = [], waits = [];
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}`; let generation = 0, authReads = 0;
  const config = { gatewayUrl: url, token: "original-fixture-token" };
  const credentials = createManagedOpenClawEndpointGeneration({ getConfig: () => config, isManaged: () => false, getOwnerGeneration: () => generation });
  wss.on("connection", socket => {
    sockets.push(socket); socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "local-nonce" } }));
    socket.on("message", raw => { const frame = JSON.parse(raw.toString()); frames.push({ socket, frame });
      if (frame.method === "connect" && !options.holdHello) socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: hello }));
    });
  });
  const backend = new OpenClawBackend({ getUpstreamUrl: () => url, authResolver: {
    getGatewayGeneration: () => credentials.current(),
    resolveConnectAuthAsync: async () => { authReads++; if (options.holdAuth || (options.holdWidgetAuth && authReads > 1)) { const wait = deferred(); waits.push(wait); return wait.promise; } return auth; },
    storeDeviceToken: (...args) => stored.push(args), clearDeviceToken() {},
  } });
  t.after(async () => { await backend.stop(); for (const socket of sockets) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  return { backend, frames, sockets, stored, waits, rotate: () => { generation++; }, rotateToken: () => { config.token = "replacement-fixture-token"; },
    business: () => frames.filter(({ frame }) => frame.method !== "connect"),
    reply: (item, payload) => item.socket.send(JSON.stringify({ type: "res", id: item.frame.id, ok: true, payload })),
  };
}
test("same-URL credential generation rotation during auth opens zero stale sockets", async t => {
  const f = await fixture(t, { holdAuth: true }), old = f.backend._connect(), rejected = assert.rejects(old, /superseded/u);
  f.rotate(); f.waits[0].resolve(auth); await rejected; await tick();
  assert.equal(f.sockets.length, 0); assert.equal(f.stored.length, 0); assert.equal(f.backend._ready, false);
});
test("late real hello after same-URL rotation stores no retired token", async t => {
  const f = await fixture(t, { holdHello: true }), old = f.backend._connect(), rejected = assert.rejects(old, /superseded/u);
  await until(() => f.frames.length === 1); f.rotate(); f.reply(f.frames[0], hello); await rejected;
  assert.equal(f.stored.length, 0); assert.equal(f.backend._gatewayHello, null); assert.equal(f.backend._ready, false);
});
test("ordinary request on retired ready socket stops before physical send", async t => {
  const f = await fixture(t); await f.backend._connect(); f.rotate();
  await assert.rejects(f.backend.request("chat.send", { sessionKey: "isolated", idempotencyKey: "before-dispatch", message: "local" }),
    { code: "UPSTREAM_ENDPOINT_RETIRED", receiptUncertain: false });
  await tick(); assert.equal(f.business().length, 0); assert.equal(f.backend._pending.size, 0); assert.equal(f.sockets.length, 1);
});
test("serialization-time endpoint rotation is rechecked at the final physical send boundary", async t => {
  const f = await fixture(t); await f.backend._connect();
  await assert.rejects(f.backend.request("chat.send", { toJSON() { f.rotate(); return { sessionKey: "isolated", message: "local" }; } }),
    { code: "UPSTREAM_ENDPOINT_RETIRED", receiptUncertain: false });
  await tick(); assert.equal(f.business().length, 0); assert.equal(f.sockets.length, 1);
});
test("dispatched request retains original operation as uncertain; late receipt triggers no retry", async t => {
  const f = await fixture(t); await f.backend._connect();
  const request = f.backend.request("chat.send", { sessionKey: "isolated", idempotencyKey: "original-operation", message: "local" });
  const rejected = assert.rejects(request, { code: "UPSTREAM_NEEDS_VERIFICATION", receiptUncertain: true, operationId: "original-operation" });
  await until(() => f.business().length === 1); f.rotate(); f.reply(f.business()[0], { status: "started", runId: "original-operation" }); await rejected;
  assert.equal(f.business().length, 1); assert.equal(f.sockets.length, 1); assert.equal(f.backend._pending.size, 0);
});
test("new connect cancels stale auth and old completion cannot clear the new generation", async t => {
  const f = await fixture(t, { holdAuth: true }); const old = f.backend._connect(), rejected = assert.rejects(old, /stopped/u);
  f.rotate(); const current = f.backend._connect(); await rejected; f.waits[0].resolve(auth); await tick();
  assert.equal(f.sockets.length, 0); assert.equal(f.backend._connecting, current);
  f.waits[1].resolve(auth); await current; assert.equal(f.sockets.length, 1); assert.equal(f.stored.length, 1);
});
test("Canvas credential rotation during async resolution sends no old bearer", async t => {
  const f = await fixture(t, { holdWidgetAuth: true }); await f.backend._connect();
  const oldFetch = global.fetch; let externalFetches = 0; global.fetch = async () => { externalFetches++; throw new Error("unexpected fetch"); };
  t.after(() => { global.fetch = oldFetch; });
  const resource = f.backend.fetchWidgetResource("/__openclaw__/canvas/documents/cv_test/index.html");
  await until(() => f.waits.length === 1); f.rotate(); f.waits[0].resolve(auth);
  assert.equal((await resource).reason, "upstream-error"); assert.equal(externalFetches, 0);
});
test("managed config-only, batch, recovery and unleased activation reject with zero writes", async t => {
  const backend = new OpenClawBackend({ getManagedExecution: () => null, authResolver: {} }); t.after(() => backend.stop());
  let rpc = 0; backend.request = async () => { rpc++; throw new Error("must not call"); }; backend._configSnapshot = async () => { rpc++; throw new Error("must not read"); };
  const caps = await backend.getModelConfigWriteCapabilities(); assert.equal(caps.supported, false); assert.equal(caps.batch, false); assert.equal(caps.activation, null);
  for (const task of [backend.applyModelChangeConfigOnly({ kind: "create" }, {}, {}), backend.applyModelChangeConfigOnlyBatch([{ kind: "delete-model" }]),
    backend.recoverModelChangeConfigOnly({ kind: "create" }), backend.activateModelConfig()]) {
    await assert.rejects(task, { code: "managed_model_transaction_required" });
  }
  assert.equal(rpc, 0);
});

test("saved token immediately retires old namespace while config lifecycle callback is still queued", async t => {
  const f = await fixture(t); await f.backend._connect();
  const callback = deferred(); let applied = false;
  const queued = callback.promise.then(() => { applied = true; f.rotate(); });
  f.rotateToken(); assert.equal(applied, false);
  await assert.rejects(f.backend.request("chat.send", { sessionKey: "isolated", idempotencyKey: "queued-config", message: "local" }),
    { code: "UPSTREAM_ENDPOINT_RETIRED", receiptUncertain: false });
  assert.equal(f.business().length, 0); assert.equal(applied, false); callback.resolve(); await queued;
});
test("legacy credential edits do not retire an active managed namespace", () => {
  let managed = false, owner = 0; const config = { gatewayUrl: "ws://127.0.0.1:1", token: "fixture-token" };
  const credentials = createManagedOpenClawEndpointGeneration({ getConfig: () => config, isManaged: () => managed, getOwnerGeneration: () => owner });
  assert.equal(credentials.current(), "0:0"); managed = true; owner++;
  assert.equal(credentials.current(), "1:0"); config.token = "other-fixture-token";
  assert.equal(credentials.current(), "1:0"); managed = false;
  assert.equal(credentials.current(), "1:1");
});
