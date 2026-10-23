#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");
const { getOpenClawChatOperation } = require("../app/core/openclaw-chat-operation");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { BackendRegistry } = require("../app/core/backend-registry");
const { AgentBackend } = require("../app/core/agent-backend");
const key = "agent:main:main", run = "original-operation";
const user = { role: "user", idempotencyKey: `${run}:user` };
const final = { role: "assistant", stopReason: "stop", __openclaw: { runId: run } };
const history = (messages = [user, final], extra = {}) => ({ sessionKey: key, sessionId: "original-session",
  messages, hasMore: false, sessionInfo: { hasActiveRun: false, activeRunIds: [] }, ...extra });
async function observe(pages, wait = { runId: run, status: "timeout" }) {
  const calls = [];
  const result = await getOpenClawChatOperation(key, run, { requestHost: async (method, params) => {
    calls.push({ method, params });
    assert.ok(["chat.history", "agent.wait"].includes(method), "ordinary recovery must never require plugin receipts or send");
    return method === "chat.history" ? pages.shift() : wait;
  } });
  return { result, calls };
}

test("expired wait cache recovers exact completed ordinary message without plugin RPCs", async () => {
  const { result, calls } = await observe([history()]);
  assert.equal(result.status, "found"); assert.equal(result.run.status, "completed");
  assert.equal(result.run.id, run); assert.equal(result.run.sessionKey, key);
  assert.equal(calls[1].params.timeoutMs, 0);
});
for (const [name, page, wait] of [
  ["neighboring run", history([user, { ...final, __openclaw: { runId: "neighbor" } }])],
  ["same run in another session", history([user, final], { sessionKey: "agent:main:other" })],
  ["tool intermediate", history([user, { ...final, stopReason: "toolUse" }])],
  ["untagged assistant", history([user, { role: "assistant", stopReason: "stop" }])],
  ["no idle evidence", history([user, final], { sessionInfo: {} })],
  ["another active run", history([user, final], { sessionInfo: { hasActiveRun: true, activeRunIds: ["neighbor"] } })],
  ["mismatched wait identity", history(), { runId: "neighbor", status: "ok", endedAt: 42 }],
  ["missing original despite terminal cache", history([]), { runId: run, status: "ok", endedAt: 42 }],
  ["inconsistent active and terminal cache", history([user, final], {
    sessionInfo: { hasActiveRun: true, activeRunIds: [run] },
  }), { runId: run, status: "ok", endedAt: 42 }],
]) test(`${name} remains unresolved and never authorizes replay`, async () => {
  const { result } = await observe([page], wait);
  assert.deepEqual(result, { status: "unresolved", run: null, canReconcile: false });
});
test("exact active run and queue are observable before transcript catches up", async () => {
  for (const status of ["timeout", "pending"]) {
    const { result } = await observe([history([], { sessionInfo: { hasActiveRun: true, activeRunIds: [run] } })], { runId: run, status });
    assert.equal(result.run.status, status === "pending" ? "queued" : "running");
  }
});
test("terminal wait status is session-correlated and timeout without endedAt is never failure", async () => {
  for (const [status, expected] of [["ok", "completed"], ["error", "failed"], ["timeout", "failed"]]) {
    const { result } = await observe([history([user])], { runId: run, status, endedAt: 42 });
    assert.equal(result.run.status, expected);
  }
  assert.equal((await observe([history([user])])).result.status, "unresolved");
});
test("bounded history paging preserves session identity and refuses an older final after newer activity", async () => {
  const first = history([{ role: "user", idempotencyKey: "neighbor:user" }], { hasMore: true, nextOffset: 100 });
  const { result, calls } = await observe([first, history()]);
  assert.equal(result.run.status, "completed"); assert.equal(calls[1].params.offset, 100);
  assert.equal((await observe([first, history([user, final], { sessionId: "replaced-session" })])).result.status, "unresolved");
  const newer = history([{ ...final, stopReason: "toolUse" }], { hasMore: true, nextOffset: 100 });
  assert.equal((await observe([newer, history()])).result.status, "unresolved");
  const pages = Array.from({ length: 7 }, (_, i) => history([], { hasMore: true, nextOffset: (i + 1) * 100 }));
  const exhausted = await observe(pages);
  assert.equal(exhausted.result.status, "unresolved"); assert.equal(exhausted.calls.length, 6);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { const value = predicate(); if (value) return value; await delay(5); }
  throw Error("fixture observation timed out");
}
async function fixture(t, onRequest, registry) {
  const server = http.createServer(), wss = new WebSocketServer({ server }), requests = [];
  wss.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }));
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString()); requests.push(frame);
      if (frame.method === "connect") socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
        payload: { type: "hello-ok", protocol: 4, features: { methods: [], events: [] } } }));
      else onRequest(frame, socket);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxyGateway({ port: 0, upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    getUpstreamUrl: () => `ws://127.0.0.1:${server.address().port}`, upstreamRetryMs: 5000, registry });
  const socket = new WebSocket(proxy.url), frames = [];
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame);
    if (frame.event === "connect.challenge") socket.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
  });
  t.after(async () => {
    socket.terminate(); await proxy.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  });
  await until(() => frames.find(frame => frame.id === "connect" && frame.ok));
  return { requests, frames, proxy, socket, send(id, method, params) {
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  }, response(id) { return until(() => frames.find(frame => frame.type === "res" && frame.id === id)); } };
}
test("real Proxy resolves ordinary recovery on a Host with no chat.selection.get", async t => {
  class OpenClawFixture extends AgentBackend {
    get id() { return "openclaw"; }
    async getExternalChatSelectionOperation(sessionKey, operationId, { requestHost }) {
      return requestHost("chat.selection.get", { sessionKey, operationId });
    }
  }
  const registry = new BackendRegistry(); registry.register(new OpenClawFixture()); await registry.start("openclaw");
  const f = await fixture(t, (frame, socket) => {
    const payload = frame.method === "chat.history" ? history() : { runId: run, status: "timeout" };
    socket.send(JSON.stringify(frame.method.startsWith("chat.selection")
      ? { type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST", message: "unknown method" } }
      : { type: "res", id: frame.id, ok: true, payload }));
  }, registry);
  f.send("lookup", "chat.operation.get", { sessionKey: key, idempotencyKey: run, operationKind: "chat" });
  const response = await f.response("lookup");
  assert.equal(response.ok, true); assert.equal(response.payload.run.status, "completed");
  assert.deepEqual(f.requests.filter(frame => frame.method !== "connect").map(frame => frame.method), ["chat.history", "agent.wait"]);
  // Explicit selections (and old clients omitting operationKind) retain their
  // strict receipt path. Missing plugin support must not downgrade the request.
  for (const operationKind of ["plugin-selection", undefined]) {
    const id = `selected-${operationKind}`;
    f.send(id, "chat.operation.get", { sessionKey: key, idempotencyKey: run, operationKind });
    const selected = await f.response(id);
    assert.equal(selected.ok, false); assert.equal(selected.error.code, "PLUGIN_SELECTION_NEEDS_VERIFICATION");
  }
  assert.equal(f.requests.filter(frame => frame.method === "chat.selection.get").length, 2);
  assert.equal(f.requests.filter(frame => frame.method === "chat.send").length, 0);
});
test("late ordinary ACK produces an exact accepted event, with no send replay", async t => {
  let acknowledge;
  class SteeringHost extends AgentBackend {
    get id() { return "openclaw"; }
    getChatCapabilities() { return { steer: true }; }
  }
  const registry = new BackendRegistry(); registry.register(new SteeringHost()); await registry.start("openclaw");
  const f = await fixture(t, (frame, socket) => {
    acknowledge = () => socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
      payload: { status: "started", runId: frame.params.idempotencyKey } }));
  }, registry);
  f.send("original", "chat.send", { sessionKey: key, idempotencyKey: run, message: "fixture" });
  await until(() => acknowledge); await delay(30); acknowledge();
  assert.equal((await f.response("original")).ok, true);
  const accepted = await until(() => f.frames.find(frame => frame.event === "chat.operation.accepted"));
  assert.equal(accepted.payload.runId, run); assert.equal(accepted.payload.sessionKey, key);
  assert.equal(f.frames.some(frame => frame.event === "chat" && frame.payload?.state === "accepted"), false,
    "ordinary queued receipts must not replace the current live run");
  assert.equal(f.requests.filter(frame => frame.method === "chat.send").length, 1);
  acknowledge = null;
  f.send("guidance", "chat.steer", { sessionKey: key, message: "focus the current reply" });
  await until(() => acknowledge); acknowledge(); await f.response("guidance"); await delay(20);
  assert.equal(f.frames.filter(frame => frame.event === "chat.operation.accepted").length, 1,
    "steering admission must not replace the observed run with a synthetic accepted run");
});
test("retired connection cannot supply a successful recovery result", async t => {
  let respond;
  const f = await fixture(t, (frame, socket) => {
    respond = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: history() })); };
  });
  f.send("lookup", "chat.operation.get", { sessionKey: key, idempotencyKey: run, operationKind: "chat" });
  await until(() => respond); f.proxy.invalidateOpenClawUpstream(); respond();
  const response = await f.response("lookup");
  assert.equal(response.ok, false); assert.equal(response.error.code, "UPSTREAM_NEEDS_VERIFICATION");
  assert.equal(f.requests.filter(frame => frame.method === "chat.send").length, 0);
});
