#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const {
  brokerUrl,
  createFederatedAgentTaskRunner,
  runFederatedAgentViaBroker,
} = require("../app/federated-agent-runner");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function withBroker(onRequest, action) {
  const server = http.createServer();
  const websocket = new WebSocketServer({ server, path: "/__chatws" });
  websocket.on("connection", (socket, request) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString("utf8"));
      onRequest(socket, frame, request);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await action(origin);
  } finally {
    for (const client of websocket.clients) client.terminate();
    await new Promise((resolve) => websocket.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}

test("broker URL 固定为当前 App 的私有聊天入口", () => {
  assert.equal(brokerUrl("http://127.0.0.1:18799/anything?secret=no"),
    "ws://127.0.0.1:18799/__chatws");
  assert.equal(brokerUrl("https://app.example.test"), "wss://app.example.test/__chatws");
});

test("创建目标 Agent session、发送一次 prompt 并只接受同 session 终态", async () => {
  const seen = [];
  const result = await withBroker((socket, frame, request) => {
    seen.push({ frame, origin: request.headers.origin });
    if (frame.method === "sessions.create") {
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
        payload: { key: "session-target" } }));
      return;
    }
    if (frame.method === "chat.send") {
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
      socket.send(JSON.stringify({ type: "event", event: "chat", payload: {
        sessionKey: "session-other", state: "final", message: { content: "wrong" },
      } }));
      setImmediate(() => socket.send(JSON.stringify({ type: "event", event: "chat", payload: {
        sessionKey: "session-target", state: "final",
        message: { content: [{ type: "output_text", text: "delegated " },
          { type: "output_text", text: "answer" }] },
      } })));
    }
  }, (origin) => runFederatedAgentViaBroker({
    origin, agentId: "agent-1", prompt: "do work", timeoutMs: 5_000,
  }));
  assert.deepEqual(result, { sessionKey: "session-target", text: "delegated answer" });
  assert.deepEqual(seen.map(({ frame }) => frame.method), ["sessions.create", "chat.send"]);
  assert.deepEqual(seen[0].frame.params, { agentId: "agent-1" });
  assert.equal(seen[1].frame.params.sessionKey, "session-target");
  assert.equal(seen[1].frame.params.message, "do work");
  assert.match(seen[1].frame.params.idempotencyKey, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(seen[1].frame.params.systemInputProvenance, {
    kind: "inter_session",
    sourceTool: "federation_agent_run",
  });
  assert.equal(seen.every(({ origin }) => origin === seen[0].origin), true);
});

test("目标 Agent 需要嵌套确认时 fail closed，不替用户作答", async () => {
  await assert.rejects(withBroker((socket, frame) => {
    if (frame.method === "sessions.create") {
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
        payload: { key: "session-prompt" } }));
      return;
    }
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    setImmediate(() => socket.send(JSON.stringify({ type: "event", event: "chat", payload: {
      sessionKey: "session-prompt", state: "prompt", request: { question: "confirm?" },
    } })));
  }, (origin) => runFederatedAgentViaBroker({
    origin, agentId: "agent-1", prompt: "dangerous work", timeoutMs: 5_000,
  })), (error) => error?.code === "AGENT_OPERATION_FAILED");
});

test("异步联邦任务可查询、续聊和取消，并拒绝旧 turn", async () => {
  let sequence = 0;
  const sockets = new Map();
  const sends = [];
  await withBroker((socket, frame) => {
    if (frame.method === "sessions.create") {
      const sessionKey = `session-${++sequence}`;
      sockets.set(sessionKey, socket);
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
        payload: { key: sessionKey } }));
      return;
    }
    if (frame.method === "chat.send") sends.push(frame.params);
    socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
  }, async (origin) => {
    const runner = createFederatedAgentTaskRunner({ origin });
    try {
      const first = await runner.run({
        backendId: "openclaw", agentId: "agent-1", prompt: "first", timeoutMs: 5_000,
      });
      assert.equal(first.status, "running");
      assert.deepEqual(sends[0].systemInputProvenance, {
        kind: "inter_session",
        sourceTool: "federation_agent_run",
      });
      sockets.get(first.sessionKey).send(JSON.stringify({ type: "event", event: "chat", payload: {
        sessionKey: first.sessionKey, state: "final", message: { content: "done one" },
      } }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const completed = runner.get({
        backendId: "openclaw", agentId: "agent-1", taskId: first.taskId,
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.result, "done one");

      const continued = await runner.message({
        backendId: "openclaw", agentId: "agent-1", taskId: first.taskId,
        expectedTurn: 1, prompt: "second", timeoutMs: 5_000,
      });
      assert.equal(continued.turn, 2);
      assert.equal(continued.status, "running");
      assert.deepEqual(sends[1].systemInputProvenance, {
        kind: "inter_session",
        sourceTool: "federation_agent_message",
      });
      await assert.rejects(() => runner.message({
        backendId: "openclaw", agentId: "agent-1", taskId: first.taskId,
        expectedTurn: 1, prompt: "stale", timeoutMs: 5_000,
      }), (error) => error?.code === "FEDERATION_TASK_STATE_CONFLICT");

      const second = await runner.run({
        backendId: "hermes", agentId: "agent-2", prompt: "cancel me", timeoutMs: 5_000,
      });
      assert.deepEqual(sends[2].systemInputProvenance, {
        kind: "inter_session",
        sourceTool: "federation_agent_run",
      });
      const canceled = await runner.cancel({
        backendId: "hermes", agentId: "agent-2", taskId: second.taskId,
      });
      assert.equal(canceled.status, "canceled");
    } finally {
      runner.close();
    }
  });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
})();
