#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
class Socket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; Socket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", code, reason); }
  terminate() { this.close(); }
  receive(frame) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
}
class Server extends EventEmitter {
  handleUpgrade(_req, socket, _head, callback) { callback(socket.client); }
}
const originalLoad = Module._load;
let OpenClawBackend, attachChatBroker;
try {
  Module._load = function(name, ...args) { return name === "ws" ? { WebSocket: Socket, WebSocketServer: Server } : originalLoad.call(this, name, ...args); };
  ({ OpenClawBackend } = require("../app/core/openclaw-backend"));
  ({ attachChatBroker } = require("../app/core/chat-broker"));
} finally { Module._load = originalLoad; }
const { generateIdentity } = require("../app/core/device-auth");
const identity = generateIdentity();
const auth = { ...identity, token: "isolated-fixture-token", scopes: ["operator.read"] };
const hello = { type: "hello-ok", protocol: 4, server: { version: "2026.9.1" },
  features: { methods: [], events: [], capabilities: [] }, auth: { role: "operator", scopes: ["operator.read"], deviceToken: "issued-fixture-token", issuedAtMs: 1 },
  policy: { maxPayload: 100000, maxBufferedBytes: 200000 } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function resolverFixture() {
  const pending = [], urls = [], stored = [];
  return { pending, urls, stored, resolver: {
    resolveConnectAuth() { throw new Error("synchronous resolver must not run"); },
    resolveConnectAuthAsync(url) { urls.push(url); const wait = deferred(); pending.push(wait); return wait.promise; },
    storeDeviceToken(...args) { stored.push(args); }, clearDeviceToken() {},
  } };
}
async function authenticate(socket) {
  socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } });
  await tick();
  const request = socket.sent.find(frame => frame.method === "connect");
  assert.ok(request);
  socket.receive({ type: "res", id: request.id, ok: true, payload: hello });
  await tick();
}
test("management awaits async auth once, remains responsive, and stores tokens for the frozen URL", async t => {
  Socket.instances.length = 0; const f = resolverFixture();
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://gateway-a.invalid", authResolver: f.resolver });
  t.after(() => backend.stop());
  const one = backend._connect(), two = backend._connect();
  assert.equal(one, two); assert.equal(f.pending.length, 1);
  await tick(); assert.equal(Socket.instances.length, 0);
  f.pending[0].resolve(auth); await tick();
  const socket = Socket.instances[0]; assert.equal(socket.url, "ws://gateway-a.invalid");
  await authenticate(socket); await one;
  assert.equal(backend._ready, true);
  assert.deepEqual(f.stored, [["issued-fixture-token", 1, "ws://gateway-a.invalid"]]);
});
test("stop promptly cancels auth, and a late old resolver cannot clear the next connection", async t => {
  Socket.instances.length = 0; const f = resolverFixture();
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://gateway-a.invalid", authResolver: f.resolver });
  t.after(() => backend.stop());
  const old = backend._connect(); const rejected = assert.rejects(old, /backend stopped/u);
  await backend.stop(); await rejected;
  const current = backend._connect(); f.pending[0].resolve(auth); await tick();
  assert.equal(Socket.instances.length, 0); assert.equal(backend._connecting, current);
  f.pending[1].resolve(auth); await tick(); await authenticate(Socket.instances[0]); await current;
});
test("endpoint changes during auth reject the old attempt without opening either socket", async t => {
  Socket.instances.length = 0; const f = resolverFixture(); let url = "ws://gateway-a.invalid";
  const backend = new OpenClawBackend({ getUpstreamUrl: () => url, authResolver: f.resolver }); t.after(() => backend.stop());
  const connection = backend._connect(), rejected = assert.rejects(connection, /superseded/u);
  url = "ws://gateway-b.invalid"; f.pending[0].resolve(auth); await rejected;
  assert.deepEqual(f.urls, ["ws://gateway-a.invalid"]); assert.equal(Socket.instances.length, 0);
  assert.equal(backend._connecting, null);
});
test("late hello cannot persist its token or mutate readiness after endpoint changes", async t => {
  Socket.instances.length = 0; const f = resolverFixture(); let url = "ws://gateway-a.invalid";
  const backend = new OpenClawBackend({ getUpstreamUrl: () => url, authResolver: f.resolver }); t.after(() => backend.stop());
  const connection = backend._connect(), rejected = assert.rejects(connection, /superseded/u);
  f.pending[0].resolve(auth); await tick(); const socket = Socket.instances[0];
  socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } }); await tick();
  url = "ws://gateway-b.invalid";
  socket.receive({ type: "res", id: socket.sent[0].id, ok: true, payload: hello }); await rejected;
  assert.equal(backend._ready, false); assert.equal(backend._gatewayHello, null); assert.deepEqual(f.stored, []);
});
test("an asynchronous auth failure releases single flight without unhandled work", async t => {
  const f = resolverFixture(), backend = new OpenClawBackend({ authResolver: f.resolver }); t.after(() => backend.stop());
  const connection = backend._connect(), rejected = assert.rejects(connection, /fixture failed/u);
  f.pending[0].reject(new Error("fixture failed")); await rejected;
  assert.equal(backend._connecting, null); assert.equal(backend._cancelConnecting, null);
});
test("widget auth cannot send a bearer after stop or endpoint change", async t => {
  const originalFetch = global.fetch; let fetches = 0; global.fetch = async () => { fetches++; throw new Error("unexpected fetch"); };
  t.after(() => { global.fetch = originalFetch; });
  for (const action of ["stop", "endpoint"]) {
    const f = resolverFixture(); let url = "ws://gateway-a.invalid";
    const backend = new OpenClawBackend({ getUpstreamUrl: () => url, authResolver: f.resolver }); t.after(() => backend.stop());
    backend._connect = async () => {};
    const resource = backend.fetchWidgetResource("/__openclaw__/canvas/documents/cv_test/index.html"); await tick();
    if (action === "stop") await backend.stop(); else url = "ws://gateway-b.invalid";
    f.pending[0].resolve(auth); assert.equal((await resource).reason, "upstream-error");
    assert.deepEqual(f.urls, ["ws://gateway-a.invalid"]);
  }
  assert.equal(fetches, 0);
});
test("status awaits identity and does not reconnect after stop during auth", async t => {
  Socket.instances.length = 0; const f = resolverFixture();
  const backend = new OpenClawBackend({ authResolver: f.resolver }); t.after(() => backend.stop());
  const status = backend.getStatus(); await backend.stop(); f.pending[0].resolve(null);
  const result = await status; assert.equal(result.connected, false); assert.equal(result.info.hasIdentity, false);
  assert.equal(Socket.instances.length, 0);
});
function brokerFixture(t) {
  Socket.instances.length = 0; const f = resolverFixture(), server = new EventEmitter(); server.address = () => ({ port: 12345 });
  let gatewayUrl = "ws://gateway-a.invalid"; f.resolver.getGatewayUrl = () => gatewayUrl;
  attachChatBroker(server, { getUpstreamUrl: () => "ws://proxy.invalid", authResolver: f.resolver });
  const client = new EventEmitter(); Object.assign(client, { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closeReason = reason; this.emit("close", code, reason); } });
  t.after(() => client.close());
  server.emit("upgrade", { url: "/__chatws", headers: { host: "127.0.0.1:12345", origin: "http://127.0.0.1:12345" } }, { client }, Buffer.alloc(0));
  return { ...f, client, changeEndpoint() { gatewayUrl = "ws://gateway-b.invalid"; } };
}
test("broker queues browser frames during auth and freezes the real gateway token namespace", async t => {
  const f = brokerFixture(t);
  f.client.emit("message", Buffer.from(JSON.stringify({ type: "req", id: "early", method: "sessions.list", params: {} })));
  f.pending[0].resolve(auth); await tick(); const socket = Socket.instances[0];
  assert.equal(socket.url, "ws://proxy.invalid"); assert.deepEqual(f.urls, ["ws://gateway-a.invalid"]);
  await authenticate(socket);
  assert.equal(socket.sent.at(-1).id, "early");
  assert.deepEqual(f.stored, [["issued-fixture-token", 1, "ws://gateway-a.invalid"]]);
});
test("broker creates no upstream after browser closes or gateway changes during auth", async t => {
  for (const action of ["close", "endpoint"]) {
    const f = brokerFixture(t); if (action === "close") f.client.close(); else f.changeEndpoint();
    f.pending[0].resolve(auth); await tick(); assert.equal(Socket.instances.length, 0);
    if (action === "endpoint") assert.equal(f.client.closeReason, "gateway configuration changed");
  }
});
test("broker refuses an old auth challenge after the real endpoint changes behind a fixed proxy", async t => {
  const f = brokerFixture(t); f.pending[0].resolve(auth); await tick(); const socket = Socket.instances[0];
  f.changeEndpoint(); socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } });
  assert.equal(socket.sent.length, 0); assert.equal(socket.readyState, 3); assert.deepEqual(f.stored, []);
});
