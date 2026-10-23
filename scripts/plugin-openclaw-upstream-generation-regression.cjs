#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { attachChatBroker } = require("../app/core/chat-broker");
const { createEndpointGenerationGuard, endpointDigest } = require("../app/core/upstream-endpoint-generation");
const { BackendRegistry } = require("../app/core/backend-registry");
const { AgentBackend } = require("../app/core/agent-backend");
const { generateIdentity, DEFAULT_OPERATOR_SCOPES } = require("../app/core/device-auth");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error(`Timed out: ${label}`);
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}
async function stopServer(server, wss) {
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
function hello(name) {
  return { type: "hello-ok", protocol: 4, server: { version: "2026.9.5", buildId: name },
    features: { methods: [], events: [], capabilities: [] },
    auth: { role: "operator", scopes: ["operator.read"], deviceToken: `issued-${name}`, issuedAtMs: 1 },
    policy: { maxPayload: 100000, maxBufferedBytes: 200000 } };
}
async function gateway(t, name, options = {}) {
  const server = http.createServer(), wss = new WebSocketServer({ server });
  const received = [], sockets = [];
  wss.on("connection", socket => {
    sockets.push(socket);
    if (options.challenge !== false) socket.send(JSON.stringify({ type: "event", event: "connect.challenge",
      payload: options.plainChallenge ? { nonce: `nonce-${name}` } : { nonce: `nonce-${name}`, gatewayBinding: "forged-by-host", degraded: true } }));
    socket.on("message", data => {
      const frame = JSON.parse(data.toString()); received.push(frame);
      if (frame.type !== "req" || options.hold?.(frame)) return;
      const payload = frame.method === "connect" ? hello(name)
        : frame.method === "chat.selection.get" ? null : { name, status: "started", runId: frame.params?.idempotencyKey };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await listen(server); t.after(() => stopServer(server, wss));
  return { url: `ws://127.0.0.1:${server.address().port}`, received, sockets, server, wss };
}
async function client(t, url, autoAuth = true) {
  const socket = new WebSocket(url), frames = [];
  let handshake = 0;
  socket.on("message", data => {
    const frame = JSON.parse(data.toString()); frames.push(frame);
    if (autoAuth && frame.type === "event" && frame.event === "connect.challenge") {
      socket.send(JSON.stringify({ type: "req", id: `test-connect-${++handshake}`, method: "connect", params: {} }));
    }
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  t.after(() => socket.terminate());
  return { socket, frames, send(id, method, params = {}) { socket.send(JSON.stringify({ type: "req", id, method, params })); },
    response(id) { return until(() => frames.find(frame => frame.type === "res" && frame.id === id), id); } };
}
class NativeFixture extends AgentBackend {
  constructor() { super(); this.watches = []; this.sends = []; }
  get id() { return "shoggoth"; }
  claimsAgentId(id) { return id === "shoggoth-fixture"; }
  ownsAgentId(id) { return this.claimsAgentId(id); }
  getAgents() { return [{ id: "shoggoth-fixture", name: "Fixture native" }]; }
  async getHistory() { return { messages: [] }; }
  async watchSession(sessionKey, hooks, { signal }) {
    const record = { sessionKey, hooks, aborted: false }; this.watches.push(record);
    await new Promise(resolve => { signal.addEventListener("abort", () => { record.aborted = true; resolve(); }, { once: true }); });
  }
  async sendMessage(sessionKey, message, operationId, hooks) {
    this.sends.push({ sessionKey, message, operationId }); hooks.final?.("native completed", false);
  }
}
async function registryFixture() {
  const registry = new BackendRegistry(), native = new NativeFixture();
  registry.register(native); await registry.start(native.id);
  return { registry, native };
}
async function proxyFixture(t, initialUrl, options = {}) {
  let url = initialUrl, generation = 1;
  const proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => url,
    getUpstreamGeneration: () => generation, upstreamRetryMs: options.retryMs || 5000,
    upstreamHandshakeTimeoutMs: 500, registry: options.registry });
  t.after(() => proxy.close());
  return { proxy, getUrl: () => url, getGeneration: () => generation,
    set(nextUrl, nextGeneration = generation + 1, invalidate = false) {
      url = nextUrl; generation = nextGeneration; if (invalidate) proxy.invalidateOpenClawUpstream();
    } };
}
async function readyDirect(c) {
  await until(() => c.frames.find(frame => frame.type === "res" && String(frame.id).startsWith("test-connect-") && frame.ok), "direct authentication");
}
const nativeKey = "agent:shoggoth-fixture:main", hostKey = "agent:main:main";
async function attachWatcher(c, native) {
  c.send("native-history", "chat.history", { sessionKey: nativeKey });
  assert.equal((await c.response("native-history")).ok, true);
  return until(() => native.watches[0], "native watcher attached");
}

test("endpoint guard requires a captured binding, rejects disabled or changed generation, and never accepts caller proofs", () => {
  let url = "ws://127.0.0.1:1234", generation = 1;
  const guard = createEndpointGenerationGuard({ getUrl: () => url, getGeneration: () => generation });
  const captured = guard.capture(); assert.equal(guard.isCurrent(captured), true);
  assert.equal(guard.isCurrent({ ...captured }), false);
  generation++; assert.equal(guard.isCurrent(captured), false);
  const next = guard.capture(); guard.invalidate(); assert.equal(guard.isCurrent(next), false);
  url = ""; assert.equal(guard.capture(), null);
  url = "ws://127.0.0.1:1234"; generation = {}; assert.equal(guard.capture(), null);
  assert.equal(endpointDigest(url, { ready: true }), null);
  assert.equal(createEndpointGenerationGuard({ getUrl() { throw new Error("unavailable"); } }).capture(), null);
});

test("same URL generation change rejects old model/message/config before send while retaining native watcher", async t => {
  const host = await gateway(t, "old"); const { registry, native } = await registryFixture();
  const f = await proxyFixture(t, host.url, { registry }); const c = await client(t, f.proxy.url); await readyDirect(c);
  const watcher = await attachWatcher(c, native);
  c.send("baseline", "models.list"); assert.equal((await c.response("baseline")).ok, true);
  const count = host.received.length; f.set(host.url);
  for (const [index, method] of ["models.list", "chat.send", "config.patch"].entries()) {
    c.send(`stale-${index}`, method, { sessionKey: hostKey, message: "must not model", idempotencyKey: "stale-op" });
    assert.equal((await c.response(`stale-${index}`)).ok, false);
  }
  await delay(35); assert.equal(host.received.length, count);
  assert.equal(watcher.aborted, false); assert.equal(c.socket.readyState, WebSocket.OPEN);
  watcher.hooks.delta?.("still observed");
  await until(() => c.frames.find(frame => frame.event === "chat" && frame.payload?.message?.content?.[0]?.text === "still observed"), "retained native delta");
  c.send("native-send", "chat.send", { sessionKey: nativeKey, message: "native", idempotencyKey: "native-op" });
  assert.equal((await c.response("native-send")).ok, true); assert.equal(native.sends.length, 1);
});

test("explicit same-owner retirement marks actual unresolved sends uncertain and never replays to a new gateway", async t => {
  const a = await gateway(t, "a", { hold: frame => frame.method === "chat.send" && frame.params.message === "lost ACK" });
  const b = await gateway(t, "b"); const f = await proxyFixture(t, a.url, { retryMs: 20 });
  const c = await client(t, f.proxy.url); await readyDirect(c);
  c.send("accepted", "chat.send", { sessionKey: hostKey, message: "acknowledged", idempotencyKey: "accepted-op" });
  assert.equal((await c.response("accepted")).ok, true);
  c.send("unknown", "chat.send", { sessionKey: hostKey, message: "lost ACK", idempotencyKey: "original-op" });
  await until(() => a.received.find(frame => frame.id === "unknown"), "old Host received original send");
  f.proxy.invalidateOpenClawUpstream();
  const unknown = await c.response("unknown"); assert.equal(unknown.error.code, "UPSTREAM_NEEDS_VERIFICATION");
  assert.equal(unknown.error.receiptUncertain, true);
  f.set(b.url, 2, true);
  await until(() => b.received.some(frame => frame.method === "connect"), "new Host authenticated");
  c.send("fresh", "config.patch", { config: "private fixture" }); assert.equal((await c.response("fresh")).ok, true);
  c.send("observe", "chat.operation.get", { sessionKey: hostKey, idempotencyKey: "original-op" });
  assert.equal((await c.response("observe")).ok, true);
  assert.equal(b.received.filter(frame => frame.method === "chat.send").length, 0);
  assert.equal(a.received.filter(frame => frame.id === "accepted").length, 1);
  assert.equal(c.frames.filter(frame => frame.id === "unknown").length, 1);
});

test("connecting backlog is known unsent and cannot cross endpoint ownership", async t => {
  const gate = http.createServer(), pendingUpgrades = [];
  gate.on("upgrade", (_req, socket) => pendingUpgrades.push(socket)); await listen(gate);
  t.after(async () => { for (const socket of pendingUpgrades) socket.destroy(); await new Promise(resolve => gate.close(resolve)); });
  const next = await gateway(t, "new"); const f = await proxyFixture(t, `ws://127.0.0.1:${gate.address().port}`, { retryMs: 20 });
  const c = await client(t, f.proxy.url, false);
  await until(() => pendingUpgrades.length, "held TCP upgrade");
  c.send("queued-message", "chat.send", { sessionKey: hostKey, message: "queued", idempotencyKey: "queued-op" });
  c.send("queued-config", "config.patch", { config: "queued" }); await delay(20);
  f.set(next.url, 2, true);
  for (const id of ["queued-message", "queued-config"]) {
    const response = await c.response(id); assert.equal(response.error.code, "UPSTREAM_CHANGED");
    assert.equal(response.error.admissionAccepted, false);
  }
  await until(() => next.sockets.length, "new socket opens"); await delay(35);
  assert.equal(next.received.some(frame => ["queued-message", "queued-config"].includes(frame.id)), false);
});

test("disabled endpoint blocks the first model and explicit invalidation retains active native observations", async t => {
  const host = await gateway(t, "disabled"); const { registry, native } = await registryFixture();
  const f = await proxyFixture(t, host.url, { registry }); const c = await client(t, f.proxy.url); await readyDirect(c);
  const watcher = await attachWatcher(c, native); const before = host.received.length;
  f.set("", 2, true);
  c.send("disabled-model", "chat.send", { sessionKey: hostKey, message: "never run", idempotencyKey: "disabled-op" });
  assert.equal((await c.response("disabled-model")).error.code, "BACKEND_NOT_READY");
  assert.equal(host.received.length, before); assert.equal(watcher.aborted, false); assert.equal(c.socket.readyState, WebSocket.OPEN);
  c.send("disabled-native", "chat.send", { sessionKey: nativeKey, message: "still works", idempotencyKey: "disabled-native-op" });
  assert.equal((await c.response("disabled-native")).ok, true);
});

test("real Broker refreshes private namespace, retains the UI socket, rejects forged Host binding and stores exact issued-token owner", async t => {
  const a = await gateway(t, "global-fixture"), b = await gateway(t, "private-fixture");
  const { registry, native } = await registryFixture(); const f = await proxyFixture(t, a.url, { registry, retryMs: 20 });
  const authCalls = [], stored = []; const identity = generateIdentity();
  const authResolver = { getGatewayUrl: f.getUrl, getGatewayGeneration: f.getGeneration,
    async resolveConnectAuthAsync(url) {
      authCalls.push(url); return { ...identity, token: url === a.url ? "fixture-global-token" : "fixture-private-token", scopes: DEFAULT_OPERATOR_SCOPES };
    }, storeDeviceToken(...args) { stored.push(args); } };
  const server = http.createServer(), wss = attachChatBroker(server, { getUpstreamUrl: () => f.proxy.url, authResolver });
  await listen(server); t.after(() => stopServer(server, wss));
  const c = await client(t, `ws://127.0.0.1:${server.address().port}/__chatws`, false);
  await until(() => c.frames.find(frame => frame.event === "gateway.ready" && frame.payload.server?.buildId === "global-fixture"), "global hello");
  const watcher = await attachWatcher(c, native);
  f.set(b.url, 2, true);
  await until(() => c.frames.find(frame => frame.event === "gateway.ready" && frame.payload.server?.buildId === "private-fixture"), "private hello");
  assert.equal(c.socket.readyState, WebSocket.OPEN); assert.equal(watcher.aborted, false);
  assert.deepEqual(authCalls, [a.url, b.url]);
  assert.deepEqual(stored, [["issued-global-fixture", 1, a.url], ["issued-private-fixture", 1, b.url]]);
  assert.equal(a.received.filter(frame => frame.method === "connect").length, 1);
  const privateConnect = b.received.find(frame => frame.method === "connect");
  assert.equal(privateConnect.params.auth.token, "fixture-private-token");
  assert.equal(JSON.stringify(c.frames).includes("fixture-private-token"), false);
  c.send("broker-private", "chat.send", { sessionKey: hostKey, message: "private only", idempotencyKey: "broker-private-op" });
  assert.equal((await c.response("broker-private")).ok, true);
  f.set("", 3, true); await until(() => c.frames.filter(frame => frame.event === "gateway.ready" && frame.payload.degraded).length >= 2, "disabled local hello");
  c.send("broker-native", "chat.send", { sessionKey: nativeKey, message: "no global identity fallback", idempotencyKey: "broker-native-op" });
  assert.equal((await c.response("broker-native")).ok, true); assert.deepEqual(authCalls, [a.url, b.url]);
});

class SelectionFixture extends AgentBackend {
  constructor() { super(); this.pending = null; this.canceled = []; this.observed = []; }
  get id() { return "openclaw"; }
  ownsAgentId() { return false; }
  async prepareExternalChatSelection(params, { requestHost }) {
    await requestHost("chat.selection.capabilities", { sessionKey: params.sessionKey });
    if (this.pending) await this.pending;
    return { params: { ...params, pluginSelection: undefined, capabilitySelection: {} },
      selection: { sessionKey: params.sessionKey, operationId: params.idempotencyKey } };
  }
  async getExternalChatSelectionOperation(sessionKey, operationId, { requestHost }) {
    this.observed.push({ sessionKey, operationId }); await requestHost("chat.selection.get", { operationId });
    return { status: "not_found", operationId, sessionKey, backendId: "openclaw" };
  }
  async cancelExternalChatSelections(params) { this.canceled.push(params); }
}
test("retirement during selected prepare sends no model or late second response, while actual selected lost ACK remains uncertain", async t => {
  const host = await gateway(t, "selection", { hold: frame => frame.method === "chat.send" });
  const registry = new BackendRegistry(), backend = new SelectionFixture(); registry.register(backend); await registry.start(backend.id);
  const f = await proxyFixture(t, host.url, { registry, retryMs: 20 }); const c = await client(t, f.proxy.url); await readyDirect(c);
  let release; backend.pending = new Promise(resolve => { release = resolve; });
  c.send("selected-before", "chat.send", { sessionKey: hostKey, message: "before", idempotencyKey: "selected-before-op", pluginSelection: ["fixture"] });
  await until(() => host.received.some(frame => frame.method === "chat.selection.capabilities"), "selection negotiation");
  f.proxy.invalidateOpenClawUpstream();
  assert.equal((await c.response("selected-before")).error.code, "PLUGIN_SELECTION_NEEDS_VERIFICATION");
  release(); backend.pending = null; await delay(60);
  assert.equal(host.received.some(frame => frame.method === "chat.send"), false);
  assert.equal(c.frames.filter(frame => frame.id === "selected-before").length, 1);
  c.send("selected-sent", "chat.send", { sessionKey: hostKey, message: "after", idempotencyKey: "selected-sent-op", pluginSelection: ["fixture"] });
  await until(() => host.received.find(frame => frame.id === "selected-sent"), "selected message sent");
  f.proxy.invalidateOpenClawUpstream();
  assert.equal((await c.response("selected-sent")).error.code, "PLUGIN_SELECTION_NEEDS_VERIFICATION");
  await delay(60); assert.equal(host.received.filter(frame => frame.id === "selected-sent").length, 1);
  assert.equal(c.frames.filter(frame => frame.id === "selected-sent").length, 1);
  c.send("selected-observe", "chat.operation.get", { sessionKey: hostKey, idempotencyKey: "selected-sent-op" });
  assert.equal((await c.response("selected-observe")).payload.status, "not_found");
  assert.equal(backend.observed.at(-1).operationId, "selected-sent-op");
  c.send("selected-stop", "chat.abort", { sessionKey: hostKey }); await c.response("selected-stop");
  assert.equal(backend.canceled.length, 1);
});


test("Broker rechecks its transport before every outgoing model/message/config frame and does not replay across Proxy URLs", async t => {
  const a = await gateway(t, "broker-old", { plainChallenge: true }), b = await gateway(t, "broker-new", { plainChallenge: true });
  let relayUrl = a.url; const identity = generateIdentity();
  const resolver = { resolveConnectAuth: () => ({ ...identity, token: "local-fixture-only", scopes: DEFAULT_OPERATOR_SCOPES }) };
  const server = http.createServer(), wss = attachChatBroker(server, { getUpstreamUrl: () => relayUrl, authResolver: resolver });
  await listen(server); t.after(() => stopServer(server, wss));
  for (const [index, method] of ["models.list", "chat.send", "config.patch"].entries()) {
    relayUrl = a.url;
    const c = await client(t, `ws://127.0.0.1:${server.address().port}/__chatws`, false);
    await until(() => c.frames.some(frame => frame.event === "gateway.ready" && !frame.payload.degraded), "broker authenticated");
    const count = a.received.length; relayUrl = b.url;
    c.send(`broker-stale-${index}`, method, { sessionKey: hostKey, message: "blocked", idempotencyKey: `broker-stale-op-${index}` });
    await until(() => c.socket.readyState === WebSocket.CLOSED, "old Proxy transport retired");
    assert.equal(a.received.length, count); assert.equal(b.received.length, 0);
  }
});

test("coalesced old Host events cannot arrive after generation change without an explicit invalidate", async t => {
  const host = await gateway(t, "coalesced"), f = await proxyFixture(t, host.url);
  const c = await client(t, f.proxy.url); await readyDirect(c);
  const event = value => ({ type: "event", event: "session.message", payload: { sessionKey: hostKey, fixtureValue: value } });
  host.sockets[0].send(JSON.stringify(event("leading"))); await until(() => c.frames.some(frame => frame.payload?.fixtureValue === "leading"), "leading event");
  host.sockets[0].send(JSON.stringify(event("must-not-cross"))); await delay(20); f.set(host.url);
  await delay(850); assert.equal(c.frames.some(frame => frame.payload?.fixtureValue === "must-not-cross"), false);
  assert.equal(c.socket.readyState, WebSocket.OPEN);
});


test("legacy Broker without a namespace resolver completes genuine Proxy binding and refreshes only its own fallback identity", async t => {
  const Module = require("node:module"), brokerFile = require.resolve("../app/core/chat-broker");
  const previous = require.cache[brokerFile], originalLoad = Module._load, identity = generateIdentity();
  let token = "legacy-isolated-initial", calls = 0, legacyAttach;
  try {
    delete require.cache[brokerFile];
    Module._load = function(name, parent, ...rest) {
      const result = originalLoad.call(this, name, parent, ...rest);
      if (name === "./device-auth" && parent?.filename === brokerFile) return { ...result,
        loadOperatorAuth() { calls++; return { ...identity, token, scopes: DEFAULT_OPERATOR_SCOPES }; } };
      return result;
    };
    legacyAttach = require(brokerFile).attachChatBroker;
  } finally { Module._load = originalLoad; require.cache[brokerFile] = previous; }
  const host = await gateway(t, "legacy-proxy"), f = await proxyFixture(t, host.url, { retryMs: 20 });
  const server = http.createServer(), wss = legacyAttach(server, { getUpstreamUrl: () => f.proxy.url });
  await listen(server); t.after(() => stopServer(server, wss));
  const c = await client(t, `ws://127.0.0.1:${server.address().port}/__chatws`, false);
  await until(() => c.frames.some(frame => frame.event === "gateway.ready" && !frame.payload.degraded), "legacy initial genuine Proxy hello");
  assert.equal(calls, 1); assert.equal(host.received.find(frame => frame.method === "connect").params.auth.token, "legacy-isolated-initial");
  token = "legacy-isolated-current"; f.set(host.url, 2, true);
  await until(() => host.received.filter(frame => frame.method === "connect").length === 2, "legacy fresh genuine Proxy hello");
  assert.equal(calls, 2); assert.equal(c.socket.readyState, WebSocket.OPEN);
  assert.equal(host.received.filter(frame => frame.method === "connect")[1].params.auth.token, "legacy-isolated-current");
  assert.equal(JSON.stringify(c.frames).includes("legacy-isolated-current"), false);
});
