"use strict";

// Real Backend + loopback gateway. No model, user state, or runtime process.
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
const { HermesBackend } = require("../app/core/hermes-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await pause();
  }
}
function collector() {
  const events = [];
  const hooks = Object.fromEntries(["status", "delta", "interim", "thinking", "tool", "plan", "final", "error", "prompt", "promptExpire"]
    .map(name => [name, (...args) => events.push({ name, args })]));
  return { events, hooks };
}

async function main() {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "fixture-model", provider: "fixture" }));
  });
  const wss = new WebSocketServer({ server, path: "/api/ws" });
  const requests = [];
  let peer;
  wss.on("connection", ws => {
    peer = ws;
    ws.on("message", bytes => {
      const frame = JSON.parse(bytes);
      requests.push(frame);
      if (!frame.method) return;
      const result = frame.method === "client.capabilities" ? { server_requests: true }
        : frame.method === "session.create" ? { session_id: "runtime", stored_session_id: "stored" }
        : frame.method === "prompt.submit" ? { status: "streaming" } : {};
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local" }) });
  backend.profileById.set("hermes-test", "fixture");
  backend.dashboards.set("fixture", { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture-token" });
  const emit = (type, payload = {}, session_id = "runtime") => peer.send(JSON.stringify({
    jsonrpc: "2.0", method: "event", params: { type, session_id, payload },
  }));
  const controllers = [];
  const watchers = [];
  let proxy, browser;
  const watch = (key, hooks) => {
    const controller = new AbortController(); controllers.push(controller);
    const task = backend.watchSession(key, hooks, { signal: controller.signal }); watchers.push(task);
    return { controller, task };
  };
  try {
    const key = await backend.createSession("hermes-test");
    const original = collector();
    const sending = backend.sendMessage(key, "fixture question", "original-operation", original.hooks);
    void sending.catch(() => {}); // stop() also settles the send after an assertion failure.
    await until(() => requests.some(frame => frame.method === "prompt.submit"), "original submit");
    emit("message.start");
    emit("tool.start", { tool_id: "first-tool", name: "terminal", args: { command: "fixture-only" } });
    await until(() => original.events.some(event => event.name === "tool"), "original tool");

    const reloaded = collector();
    const firstWatch = watch(key, reloaded.hooks);
    assert.ok(reloaded.events.some(event => event.name === "status" && event.args[0].kind === "running"),
      "a reload during a quiet tool restores running immediately");
    assert.ok(reloaded.events.some(event => event.name === "tool" && event.args[0].toolCallId === "first-tool"),
      "a reload restores the tool that started before it subscribed");

    emit("message.complete", { status: "error", error: "fixture persistence failed" });
    await sending;
    assert.equal(original.events.filter(event => event.name === "error").length, 1);
    assert.equal(backend.gwTurns.size, 0);
    const originalCount = original.events.length;
    // Hermes starts a process_complete notification turn after the original
    // prompt has already failed. There is no second Shoggoth chat.send.
    emit("message.start");
    emit("message.delta", { text: "Background command finished; checking its result." });
    emit("message.interim", { text: "Background command finished; checking its result." });
    emit("tool.start", { tool_id: "followup-tool", name: "terminal", args: { command: "fixture-followup" } });
    await until(() => reloaded.events.some(event => event.name === "tool" && event.args[0].toolCallId === "followup-tool"),
      "background continuation stays observable after the first terminal");
    assert.equal(original.events.length, originalCount, "a continuation never reopens the settled send receipt");
    assert.equal(requests.filter(frame => frame.method === "prompt.submit").length, 1, "observation never resends");
    peer.send(JSON.stringify({ jsonrpc: "2.0", id: "srq-000000000001", method: "approval", params: {
      session_id: "runtime", command: "fixture follow-up approval", choices: ["once", "deny"],
    } }));
    await until(() => reloaded.events.some(event => event.name === "prompt"), "continuation approval");
    await backend.respondChatPrompt(key, { kind: "approval", requestId: "srq-000000000001", choice: "deny" });
    await until(() => requests.some(frame => frame.id === "srq-000000000001" && frame.result?.choice === "deny"), "continuation approval response");

    firstWatch.controller.abort(); await firstWatch.task;
    const afterReload = collector();
    const secondWatch = watch(key, afterReload.hooks);
    assert.ok(afterReload.events.some(event => event.name === "status" && event.args[0].kind === "running"));
    assert.ok(afterReload.events.some(event => event.name === "tool" && event.args[0].toolCallId === "followup-tool"));
    assert.ok(!afterReload.events.some(event => event.name === "interim"), "sealed history is not replayed as a new bubble");
    emit("tool.complete", { tool_id: "followup-tool", result_text: "fixture result", duration_s: 2 });
    emit("message.delta", { text: "Follow-up complete." });
    emit("message.complete", { status: "complete", text: "Follow-up complete." });
    await until(() => afterReload.events.some(event => event.name === "final"), "continuation finishes normally");
    assert.equal(backend.gwTurns.size, 0);
    assert.equal(afterReload.events.filter(event => event.name === "final").length, 1);

    // Activity from another runtime or profile cannot borrow this observation.
    emit("message.start", {}, "foreign-runtime");
    backend._onGwEvent("foreign-profile", { type: "message.start", session_id: "runtime", payload: {} });
    await pause(); assert.equal(backend.gwTurns.size, 0);
    const observerCount = afterReload.events.length;
    secondWatch.controller.abort(); await secondWatch.task;
    emit("message.start");
    emit("tool.start", { tool_id: "third-tool", name: "terminal" });
    await until(() => backend.gwTurns.size === 1, "unobserved continuation is retained for reopening");
    assert.equal(afterReload.events.length, observerCount, "detached browser receives no more events");
    const late = collector(); watch(key, late.hooks);
    assert.ok(late.events.some(event => event.name === "tool" && event.args[0].toolCallId === "third-tool"));
    assert.equal(requests.filter(frame => ["prompt.submit", "session.resume", "session.interrupt"].includes(frame.method)).length, 1,
      "history/reload/subscription neither executes nor takes over the runtime");

    emit("message.complete", { status: "complete", text: "Third turn complete." });
    await until(() => backend.gwTurns.size === 0, "third turn complete");
    const registry = new BackendRegistry();
    registry.setChatSecretOwner({ async chatSecretRequest(_action, input) { return { text: input.text, references: [], version: 1 }; } });
    registry.register(backend);
    proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry });
    const frames = [];
    browser = new WebSocket(proxy.url);
    browser.on("message", bytes => frames.push(JSON.parse(bytes)));
    await new Promise(resolve => browser.on("open", resolve));
    browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
    await until(() => frames.some(frame => frame.id === "connect" && frame.ok), "proxy handshake");
    browser.send(JSON.stringify({ type: "req", id: "send", method: "chat.send", params: {
      sessionKey: key, message: "second explicit fixture question", idempotencyKey: "proxy-original",
    } }));
    await until(() => requests.filter(frame => frame.method === "prompt.submit").length === 2, "proxy original submit");
    emit("message.start");
    emit("message.complete", { status: "error", error: "fixture persistence failed again" });
    await until(() => frames.some(frame => frame.event === "chat" && frame.payload?.state === "error"), "proxy original error");
    // No history read follows this error. The capability must start passive
    // observation without waiting for a page switch or another user message.
    emit("message.start");
    emit("tool.start", { tool_id: "proxy-followup", name: "terminal" });
    await until(() => frames.some(frame => frame.event === "session.tool" && frame.payload?.data?.toolCallId === "proxy-followup"),
      "proxy observes autonomous turn after error without a history request");
    assert.ok(frames.some(frame => frame.event === "chat" && frame.payload?.state === "status"
      && frame.payload.statusKind === "running" && frame.payload.runId === undefined), "continuation has no original operation identity");
    emit("message.complete", { status: "complete", text: "Proxy follow-up complete." });
    await until(() => frames.some(frame => frame.event === "chat" && frame.payload?.state === "final"), "proxy continuation final");
    assert.equal(requests.filter(frame => frame.method === "prompt.submit").length, 2);
    browser.close(); await proxy.close(); proxy = null;
    emit("message.start");
    await until(() => backend.gwTurns.size === 1, "continuation before disconnect");
    const requestCount = requests.length;
    backend._onGwReconnect("fixture");
    assert.equal(backend.gwTurns.size, 0);
    assert.ok(late.events.some(event => event.name === "status" && event.args[0].kind === "needs_verification"));
    assert.equal(requests.length, requestCount, "a passive observer cannot resume a disconnected runtime");
    await backend.stop();
    await Promise.all(watchers);
    console.log("PASS Hermes quiet-tool reload, failed-turn continuation, repeated reopen, terminal cleanup, isolation, and no resubmit");
  } finally {
    browser?.terminate();
    if (proxy) await proxy.close();
    for (const controller of controllers) controller.abort();
    await backend.stop();
    await Promise.allSettled(watchers);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
