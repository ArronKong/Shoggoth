"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { AcpJsonlClient } = require("../app/agent-service/acp-jsonl-client");
const { StdioMcpClient } = require("../app/agent-service/native-mcp-client-manager");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { HostCapabilityIssuer } = require("../app/agent-service/host-capability-issuer");
const { McpExternalApprovalBroker } = require("../app/agent-service/mcp-external-approval-broker");
const { AppleDeviceApprovalBroker } = require("../app/agent-service/apple-device-approval-broker");
const { createFederatedAgentTaskRunner } = require("../app/federated-agent-runner");
const DAY = 24 * 60 * 60_000;
const flush = () => new Promise(resolve => setImmediate(resolve));
function childFixture() {
  const frames = [], child = new EventEmitter();
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line));
    done();
  } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = 0;
  return { child, frames };
}

test("unbounded ACP waits survive a month, finite controls expire, and EOF rejects without replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { child, frames } = childFixture(), rpc = new AcpJsonlClient(child);
  try {
    const pending = rpc.request("session/prompt", { sessionId: "long-session" }, { timeoutMs: null });
    await flush();
    let settled = false; pending.finally(() => { settled = true; }).catch(() => {});
    t.mock.timers.tick(30 * DAY); await flush();
    assert.equal(settled, false);
    rpc.pauseRequestTimeout("session/prompt")();
    t.mock.timers.tick(30 * DAY); await flush(); assert.equal(settled, false);
    const prompt = frames.find(frame => frame.method === "session/prompt");
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }) + "\n");
    assert.deepEqual(await pending, { stopReason: "end_turn" });
    const finite = rpc.request("control", {}, { timeoutMs: 100 });
    const failed = assert.rejects(finite, error => /REQUEST_TIMEOUT$/.test(error.code));
    await flush(); t.mock.timers.tick(100); await failed;
    const disconnected = rpc.request("session/prompt", { sessionId: "long-session" }, { timeoutMs: null });
    const lost = assert.rejects(disconnected, error => /STDOUT|PROCESS|TERMINATED/.test(error.code));
    await flush(); child.stdout.end(); await lost;
    assert.equal(rpc.pending.size, 0);
    assert.equal(frames.filter(frame => frame.method === "session/prompt").length, 2);
  } finally { rpc.terminate(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
});

test("Pi without a total deadline stays alive across managed waits and retains explicit finite enforcement", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let failed = 0, killed = 0;
  const active = { promptTimer: null, settled: false };
  const host = { now: Date.now, _killActiveProcess() { killed++; }, _failActive() { failed++; },
    _armPromptTimeout: PiRuntimeHost.prototype._armPromptTimeout };
  host._armPromptTimeout(active, null);
  PiRuntimeHost.prototype._pausePromptTimeout.call(host, active);
  PiRuntimeHost.prototype._resumePromptTimeout.call(host, active);
  t.mock.timers.tick(30 * DAY); assert.equal(failed, 0); assert.equal(killed, 0);
  host._armPromptTimeout(active, 100); t.mock.timers.tick(100);
  assert.equal(failed, 1); assert.equal(killed, 1);
});

test("lifecycle-bound authority stays valid while waiting and is revoked by the owning signal or policy", () => {
  let now = 1000, current = true;
  const issuer = new HostCapabilityIssuer({ now: () => now });
  const identity = { runId: "run", profileId: "profile", bindingId: "binding", runtime: "pi", runtimeAccountId: "account", attemptId: "attempt" };
  const controller = new AbortController();
  const lease = issuer.issue({ identity, expiresAt: null, validate: () => current, signal: controller.signal });
  issuer.bind(lease, { sessionId: "session", turnId: "turn" });
  now += 30 * DAY;
  const scope = { kind: "input", sessionId: "session", turnId: "turn" };
  assert.deepEqual(issuer.inspectReply(lease, "request", scope), { active: true, expiresAt: null });
  issuer.consumeReply(lease, "request", scope);
  assert.throws(() => issuer.consumeReply(lease, "request", scope), { code: "HOST_CAPABILITY_REVOKED" });
  controller.abort(); assert.throws(() => issuer.assert(lease), { code: "HOST_CAPABILITY_REVOKED" });
  const next = issuer.issue({ identity, expiresAt: null, validate: () => current });
  current = false; assert.throws(() => issuer.assert(next), { code: "HOST_CAPABILITY_REVOKED" });
  assert.equal(issuer.activeCount, 0); issuer.close();
});

for (const apple of [false, true]) test(`${apple ? "Apple" : "MCP"} approvals survive a month and cannot be approved after cancellation`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const broker = apple ? new AppleDeviceApprovalBroker() : new McpExternalApprovalBroker();
  const identity = apple ? { backendId: "hermes", agentId: "agent", profileId: "profile", sessionId: "session", callId: "call" }
    : { backendId: "hermes", agentId: "agent", instanceId: "instance", sessionId: "session", taskId: "task", turnId: "turn", toolCallId: "call" };
  const start = controller => broker.request({ identity, name: apple ? "apple_calendar_create" : "mcp_server_call",
    arguments: { serverId: "fixture", value: "original" }, reason: "Review this action", assertCurrent() {}, signal: controller.signal });
  try {
    const controller = new AbortController(), pending = start(controller);
    pending.catch(() => {});
    t.mock.timers.tick(30 * DAY);
    const card = broker.list().items[0]; assert(card); assert.equal(card.expiresAt, null);
    broker.resolve({ requestId: card.requestId, argumentDigest: card.argumentDigest, approved: true });
    assert.deepEqual(await pending, { approved: true });
    const next = new AbortController(), canceled = start(next);
    const failed = assert.rejects(canceled, error => /CANCELLED/.test(error.code));
    const stale = broker.list().items[0]; next.abort(); await failed;
    assert.throws(() => broker.resolve({ requestId: stale.requestId, argumentDigest: stale.argumentDigest, approved: true }));
    assert.deepEqual(broker.list().items, []);
  } finally { broker.close(); }
});

test("stdio MCP long calls complete or cancel by exact request without replay or losing their connection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { child, frames } = childFixture(), client = new StdioMcpClient({ command: "fixture", args: [] });
  client.child = child; client.ready = Promise.resolve();
  try {
    const pending = client.callTool("long", {}); await flush();
    t.mock.timers.tick(30 * DAY); assert.equal(client.pending.size, 1);
    const first = frames.find(frame => frame.method === "tools/call");
    client._consume(JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { content: [{ type: "text", text: "done" }] } }) + "\n");
    assert.equal((await pending).content[0].text, "done");
    const controller = new AbortController(), canceled = client.callTool("write", {}, { signal: controller.signal });
    const failed = assert.rejects(canceled, { code: "MCP_SERVER_RESULT_UNKNOWN" });
    await flush(); controller.abort(); await failed;
    const calls = frames.filter(frame => frame.method === "tools/call");
    assert.equal(calls.length, 2); assert.equal(client.closed, false); assert.equal(client.pending.size, 0);
    assert.equal(frames.at(-1).method, "notifications/cancelled"); assert.equal(frames.at(-1).params.requestId, calls[1].id);
  } finally { await client.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
});

test("async federation keeps an unlimited task observable past a month, then settles or cancels exactly once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const sockets = [], sent = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; sockets.push(this); setImmediate(() => { this.readyState = 1; this.emit("open"); }); }
    send(raw) {
      const frame = JSON.parse(raw); sent.push(frame);
      const payload = frame.method === "sessions.create" ? { key: `session-${sockets.indexOf(this)}` } : {};
      setImmediate(() => this.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: true, payload })));
    }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const runner = createFederatedAgentTaskRunner({ origin: "http://127.0.0.1:1", WebSocket: Socket });
  const input = { backendId: "hermes", agentId: "agent", prompt: "long task" };
  try {
    const task = await runner.run(input);
    t.mock.timers.tick(30 * DAY); await flush();
    const query = { backendId: input.backendId, agentId: input.agentId, taskId: task.taskId };
    assert.equal(runner.get(query).status, "running");
    sockets[0].emit("message", JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: task.sessionKey, state: "final", message: { content: "done" } } }));
    assert.equal(runner.get(query).result, "done");
    const next = await runner.run({ ...input, timeoutMs: 0 });
    t.mock.timers.tick(30 * DAY);
    const canceled = await runner.cancel({ ...query, taskId: next.taskId }); assert.equal(canceled.status, "canceled");
    sockets[1].emit("message", JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: next.sessionKey, state: "final", message: { content: "late" } } }));
    assert.equal(runner.get({ ...query, taskId: next.taskId }).status, "canceled");
    assert.equal(sent.filter(frame => frame.method === "chat.send").length, 2);
    assert.equal(sent.filter(frame => frame.method === "chat.abort").length, 1);
  } finally { runner.close(); }
});
