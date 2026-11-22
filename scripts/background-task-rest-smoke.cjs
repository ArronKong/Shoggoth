#!/usr/bin/env node
"use strict";

// /__api/background-tasks through the real chain: static server → Registry →
// ShoggothBackend → Service. The preview fixture has one finished task with a
// delivered report and one running task in the same source chat.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { startPreview } = require("./shoggoth-background-task-preview.cjs");
const { waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");

async function json(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { status: response.status, body: value };
}

async function verifyTaskChat(preview) {
  const { base, sessionKey, tasks, fixture } = preview;
  const socket = new WebSocket(`${base.replace(/^http/u, "ws")}/__chatws`, { origin: base });
  const frames = [];
  socket.on("message", data => { frames.push(JSON.parse(data.toString())); });
  try {
    await once(socket, "open");
    let sequence = 0;
    async function history(key, backgroundTaskId) {
      const id = `task-history-${++sequence}`;
      socket.send(JSON.stringify({ type: "req", id, method: "chat.history", params: {
        sessionKey: key, page: true, limit: 50, cursor: null,
        ...(backgroundTaskId ? { backgroundTaskId } : {}),
      } }));
      const response = () => frames.find(frame => frame.type === "res" && frame.id === id);
      await waitUntil(response, "background chat page", 8_000);
      return response();
    }
    const page = await history(sessionKey, tasks.pricing);
    assert.equal(page.ok, true, JSON.stringify(page.error));
    assert.match(page.payload.brief.text, /^比较产品 A、B、C 的定价/u);
    assert.match(page.payload.messages[0].content[0].text, /^比较产品 A、B、C 的定价/u);
    assert(!JSON.stringify(page.payload).includes("[Shoggoth background task]"));
    const child = fixture.service.backgroundTaskStore.get(tasks.pricing).childSessionKey;
    const childKey = sessionKey.replace(/:[0-9a-f-]{36}$/u, `:${child}`);
    assert.equal((await history(childKey)).ok, false, "child stays off the ordinary session route");
    assert.equal((await history(sessionKey, { toString: null })).error.code, "INVALID_PARAMS");
    assert.equal((await history(sessionKey, `bgt-${"0".repeat(48)}`)).error.code, "BACKGROUND_TASK_NOT_FOUND");

    const result = await history(sessionKey, tasks.research);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const viewKey = `background-task:${sessionKey}:${tasks.research}`;
    const record = fixture.service.backgroundTaskStore.get(tasks.research);
    const run = fixture.service.workRunCoordinator.getRun(record.generations[0].runId);
    await waitUntil(() => frames.some(frame => frame.event === "chat" && frame.payload?.sessionKey === viewKey
      && frame.payload?.nativeRunId === run.id), "scoped live observer attached", 8_000);
    const host = fixture.transport.hosts.get("codex");
    const tool = { kind: "commandExecution", input: "printf preview", status: "inProgress" };
    const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      toolCallId: "background-trajectory", itemId: "background-trajectory" };
    host.emit({ ...common, type: "tool_start", method: "item/started", tool });
    await waitUntil(() => frames.some(frame => frame.event === "session.tool" && frame.payload?.sessionKey === viewKey
      && frame.payload.data?.toolCallId === common.toolCallId && frame.payload.data?.phase === "start"), "live child tool", 8_000);
    host.emit({ ...common, type: "tool_result", method: "item/completed", tool: {
      ...tool, status: "completed", result: "fixture stdout",
    } });
    await waitUntil(() => frames.some(frame => frame.event === "session.tool" && frame.payload?.sessionKey === viewKey
      && frame.payload.data?.toolCallId === common.toolCallId && frame.payload.data?.phase === "result"), "live child tool result", 8_000);
    const refreshed = await history(sessionKey, tasks.research);
    assert.equal(refreshed.ok, true);
    assert(refreshed.payload.messages.some(message => message.content.some(part =>
      part.type === "toolResult" && part.toolCallId === common.toolCallId)), "completed tool is in normal chat history");
    assert(!frames.some(frame => frame.event === "session.tool" && frame.payload.sessionKey === sessionKey
      && frame.payload.data?.toolCallId === common.toolCallId));
    console.log("PASS background chat reuses scoped history and live tool events without entering the foreground");
  } finally {
    socket.terminate();
  }
}

async function verifySidebarApprovals({ base, sessionKey, tasks, fixture }) {
  const socket = new WebSocket(`${base.replace(/^http/u, "ws")}/__chatws`, { origin: base });
  const frames = [];
  socket.on("message", data => { frames.push(JSON.parse(data.toString())); });
  const list = async () => {
    const result = await json(base, "GET", "/__api/background-tasks/approvals");
    assert.equal(result.status, 200);
    return result.body;
  };
  const listChange = since => waitUntil(() => frames.slice(since).some(frame => frame.event === "background.tasks.approvals.changed"),
    "sidebar approvals invalidated", 8_000);
  try {
    await waitUntil(() => frames.some(frame => frame.event === "gateway.ready"), "sidebar socket ready", 8_000);
    assert.deepEqual(await list(), { approvals: [] });

    const record = fixture.service.backgroundTaskStore.get(tasks.research);
    const runId = record.generations[0].runId;
    const run = fixture.service.workRunCoordinator.getRun(runId);
    const host = fixture.transport.hosts.get("codex");
    const sinceRequest = frames.length;
    const response = host.request("item/commandExecution/requestApproval", {
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, itemId: "background-sidebar-approval",
      command: "printf test", cwd: record.childWorkspace, reason: "Fixture approval",
    }, 503);
    response.catch(() => {});
    await listChange(sinceRequest);
    assert.deepEqual(await list(), { approvals: [{ sessionKey, taskId: tasks.research }] });
    assert(!frames.some(frame => frame.event === "chat" && frame.payload?.sessionKey === sessionKey
      && frame.payload?.state === "prompt"), "a child approval never becomes a foreground prompt");

    const requestId = fixture.service.workRunCoordinator.getRun(runId).waitingRequestId;
    const sinceResponse = frames.length;
    const denied = await json(base, "POST", "/__api/background-tasks/control", {
      sessionKey, taskId: tasks.research, operationId: "sidebar-deny-approval", requestId, action: "approval", choice: "deny",
    });
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal((await response).decision, "decline");
    await listChange(sinceResponse);
    assert.deepEqual(await list(), { approvals: [] });
    console.log("PASS sidebar approvals use the source session and invalidate on request and response without a child observer");
  } finally {
    socket.terminate();
  }
}

async function run() {
  const preview = await startPreview(0);
  const { base, sessionKey, tasks, researchTitle, fixture } = preview;
  const q = (params) => new URLSearchParams(params).toString();
  try {
    const list = await json(base, "GET", `/__api/background-tasks?${q({ sessionKey })}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.supported, true);
    const byId = new Map(list.body.tasks.map(task => [task.taskId, task]));
    assert.equal(byId.get(tasks.pricing).status, "completed");
    assert.equal(byId.get(tasks.pricing).report, "delivered");
    assert.equal(byId.get(tasks.research).status, "running");
    const storedTitle = fixture.service.backgroundTaskStore.get(tasks.research).title;
    assert(storedTitle.endsWith("…"), "the persisted short title still has its original limit");
    assert.equal(byId.get(tasks.research).title, researchTitle, "the App card wraps the original first line");
    console.log("PASS background-tasks list shows the finished and the running task");

    const detail = await json(base, "GET", `/__api/background-tasks/detail?${q({ sessionKey, taskId: tasks.pricing })}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.messages[0].role, "user");
    assert.match(detail.body.messages[0].text, /^比较产品 A、B、C 的定价/u, "the brief without the Service wrapper");
    assert.equal(detail.body.files.length, 1);
    assert.equal(detail.body.files[0].name, "pricing.csv");
    assert.equal(Object.hasOwn(detail.body.files[0], "path"), false, "local paths stay out of the UI");
    console.log("PASS background-tasks detail returns brief, reply and file links");

    await verifySidebarApprovals(preview);
    await verifyTaskChat(preview);

    const steered = await json(base, "POST", "/__api/background-tasks/control",
      { sessionKey, taskId: tasks.research, operationId: "smoke-send-1", action: "send", message: "每家附上来源。" });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    assert.equal(steered.body.delivered, "steered");
    const replay = await json(base, "POST", "/__api/background-tasks/control",
      { sessionKey, taskId: tasks.research, operationId: "smoke-send-1", action: "send", message: "每家附上来源。" });
    assert.equal(replay.status, 200, "a repeated click is the same operation");
    console.log("PASS background-tasks control steers the running task");

    const { runId } = fixture.service.backgroundTaskStore.get(tasks.research).generations.at(-1);
    const run = fixture.service.workRunCoordinator.getRun(runId);
    const host = fixture.transport.hosts.get("codex");
    const ask = async (message, properties, requestNumber) => {
      const result = host.request("mcpServer/elicitation/request", { serverName: "shoggoth", mode: "form",
        threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, message,
        requestedSchema: { type: "object", properties, required: Object.keys(properties) } }, requestNumber);
      result.catch(() => {});
      await waitUntil(() => fixture.service.workRunCoordinator.getRun(runId).waitingRequestId, "child request", 8000);
      const detail = await json(base, "GET", `/__api/background-tasks/detail?${q({ sessionKey, taskId: tasks.research })}`);
      assert.equal(detail.status, 200);
      return { request: detail.body.interaction.payload, result };
    };
    const respond = (request, control) => json(base, "POST", "/__api/background-tasks/control", {
      sessionKey, taskId: tasks.research, operationId: `respond-${request.requestId}`, requestId: request.requestId, ...control,
    });
    const form = await ask("Choose a color", { color: { type: "string", enum: ["green", "blue"] } }, 501);
    assert.equal(form.request.version, 1);
    assert.equal(form.request.fields[0].id, "color");
    assert.deepEqual(form.request.fields[0].options.map(option => option.value), ["green", "blue"]);
    const invalid = await respond(form.request, { action: "input", inputAction: "submit", answers: { color: "red" } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "INTERACTION_RESPONSE_INVALID");
    assert.deepEqual((await json(base, "GET", "/__api/background-tasks/approvals")).body, { approvals: [] });
    assert.equal((await respond(form.request, { action: "input", inputAction: "submit", answers: { color: "green" } })).status, 200);
    assert.equal((await form.result).content.color, "green");
    const permission = await ask("Allow this fixture action?", {}, 502);
    assert.equal(permission.request.kind, "mcp_permission");
    assert.equal((await respond(permission.request, { action: "approval", choice: "deny" })).status, 200);
    assert.equal((await permission.result).action, "cancel");
    console.log("PASS background-tasks projects input choices and forwards denied MCP consent");

    await preview.completeResearch();
    await waitUntil(async () => (await json(base, "GET", `/__api/background-tasks?${q({ sessionKey })}`)).body.tasks
      .find(task => task.taskId === tasks.research)?.report === "delivered", "second report delivered", 8000);
    console.log("PASS background-tasks list follows the second report");

    const otherKey = sessionKey.replace(/:[0-9a-f-]{36}$/u, ":00000000-0000-4000-8000-000000000000");
    const cases = [
      [await json(base, "GET", `/__api/background-tasks`), 400, "missing session"],
      [await json(base, "GET", `/__api/background-tasks?${q({ sessionKey, extra: "1" })}`), 400, "extra query"],
      [await json(base, "GET", `/__api/background-tasks/approvals?${q({ sessionKey })}`), 400, "approval query"],
      [await json(base, "GET", `/__api/background-tasks/detail?${q({ sessionKey, taskId: "bgt-nope" })}`), 400, "bad task id"],
      [await json(base, "GET", `/__api/background-tasks/detail?${q({ sessionKey, taskId: `bgt-${"0".repeat(48)}` })}`), 404, "unknown task"],
      [await json(base, "GET", `/__api/background-tasks?${q({ sessionKey: otherKey })}`), 400, "unknown session"],
      [await json(base, "POST", "/__api/background-tasks", {}), 405, "list method"],
      [await json(base, "GET", "/__api/background-tasks/control"), 405, "control method"],
      [await json(base, "POST", "/__api/background-tasks/control", { sessionKey, taskId: tasks.research, action: "send", message: "x" }),
        400, "missing operation"],
      [await json(base, "POST", "/__api/background-tasks/control",
        { sessionKey, taskId: tasks.research, operationId: "smoke-bad", action: "launch" }), 400, "unknown action"],
    ];
    for (const [result, status, label] of cases) assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
    console.log("PASS background-tasks rejects invalid requests");
  } finally {
    await preview.close();
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
