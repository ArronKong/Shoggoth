#!/usr/bin/env node
"use strict";

// /__api/background-tasks through the real chain: static server → Registry →
// ShoggothBackend → Service. The preview fixture has one finished task with a
// delivered report and one running task in the same source chat.
const assert = require("node:assert/strict");
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

async function run() {
  const preview = await startPreview(0);
  const { base, sessionKey, tasks } = preview;
  const q = (params) => new URLSearchParams(params).toString();
  try {
    const list = await json(base, "GET", `/__api/background-tasks?${q({ sessionKey })}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.supported, true);
    const byId = new Map(list.body.tasks.map(task => [task.taskId, task]));
    assert.equal(byId.get(tasks.pricing).status, "completed");
    assert.equal(byId.get(tasks.pricing).report, "delivered");
    assert.equal(byId.get(tasks.research).status, "running");
    console.log("PASS background-tasks list shows the finished and the running task");

    const detail = await json(base, "GET", `/__api/background-tasks/detail?${q({ sessionKey, taskId: tasks.pricing })}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.messages[0].role, "user");
    assert.match(detail.body.messages[0].text, /^比较产品 A、B、C 的定价/u, "the brief without the Service wrapper");
    assert.equal(detail.body.files.length, 1);
    assert.equal(detail.body.files[0].name, "pricing.csv");
    assert.equal(Object.hasOwn(detail.body.files[0], "path"), false, "local paths stay out of the UI");
    console.log("PASS background-tasks detail returns brief, reply and file links");

    const steered = await json(base, "POST", "/__api/background-tasks/control",
      { sessionKey, taskId: tasks.research, operationId: "smoke-send-1", action: "send", message: "每家附上来源。" });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    assert.equal(steered.body.delivered, "steered");
    const replay = await json(base, "POST", "/__api/background-tasks/control",
      { sessionKey, taskId: tasks.research, operationId: "smoke-send-1", action: "send", message: "每家附上来源。" });
    assert.equal(replay.status, 200, "a repeated click is the same operation");
    console.log("PASS background-tasks control steers the running task");

    const fixture = preview.fixture;
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
