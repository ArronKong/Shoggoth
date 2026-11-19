"use strict";

// Native background tasks on a real Service: real Product/Chat/Transcript/
// File stores, Coordinator, chat controller and product tool controller. Only
// the native Runtime transport is a fixture (FakeHost), so each turn stays open
// until the test completes it, which gives the acceptance order a wait point.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { isBackgroundTaskReportEvent, isBackgroundTaskOperation } = require("../app/agent-service/background-task-protocol");

const TIMEOUT = 8_000;

async function open(t, options = {}) {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: false, ...options.serviceOptions },
    root: options.root, transport: options.transport });
  if (!options.keep) t.after(() => f.close());
  const config = f.service.nativeRuntimeConfig.read();
  f.service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, maxActive: 16,
    // The App enables context lifecycle by default (config-store); published
    // reports reach a continuing native thread through that path.
    flags: { ...config.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
  return f;
}

function callTool(f, run, name, args) {
  const current = f.service.workRunCoordinator.getRun(run.id);
  const { runtimeProfileId, runtimeAccountId } = current.runtimeSessionRef;
  return f.service.workRunCoordinator.invokeRuntimeCapability({ runId: run.id, runtimeProfileId, runtimeAccountId, kind: "mcp" },
    scope => f.service.mcpProductToolController.handle(name, args, { profileId: run.profileId, callId: crypto.randomUUID() }, scope));
}

function rpc(f, method, params) {
  return requestService(f.paths, { token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params },
    { timeoutMs: TIMEOUT });
}

async function running(f, runId) {
  await waitUntil(() => f.service.workRunCoordinator.getRun(runId)?.status === "running", `Run ${runId} running`, TIMEOUT);
  return f.service.workRunCoordinator.getRun(runId);
}

function task(f, taskId) { return f.service.backgroundTaskStore.get(taskId); }

// An explicit project directory isolates unrelated fixture conversations.
function ownSession(f, profileId = f.profile.id) {
  const workspace = fs.mkdtempSync(path.join(f.root, "chat-"));
  return f.service.chatSessionStore.createSession({ operationId: `create-${crypto.randomUUID()}`, profileId,
    workspace, createdAt: Date.now() });
}

async function childRun(f, taskId) {
  await waitUntil(() => task(f, taskId)?.generations.at(-1).runId, "child run accepted", TIMEOUT);
  return running(f, task(f, taskId).generations.at(-1).runId);
}

function reports(f, session) {
  return f.service.transcriptStore.listEvents(session.profileId, session.id).filter(isBackgroundTaskReportEvent);
}

async function delivered(f, session, count = 1) {
  await waitUntil(() => reports(f, session).length >= count, `${count} report(s) delivered`, TIMEOUT);
  return reports(f, session);
}

test("dispatch → independent second answer → one report with the file → follow-up sees it", { timeout: 60_000 }, async t => {
  const f = await open(t);
  const { service } = f;
  // The default GUI chat writes at the Agent root. A custom project folder
  // would miss contention between that root and a nested task writer.
  const { ensureAgentWorkspace, isAgentHomeWorkspace } = require("../app/agent-service/chat-workspace");
  const source = service.chatSessionStore.createSession({ profileId: f.profile.id,
    operationId: "default-workspace-chat", workspace: ensureAgentWorkspace(f.paths, f.profile.id), createdAt: Date.now() });
  const parent = await f.send(source.sessionKey, "user-op-1", "Research the three pricing pages in the background.");
  assert.equal(parent.status, "running");

  const receipt = await callTool(f, parent, "background_task_start", {
    brief: "Compare pricing of products A, B and C\nBuild a table and report the cheapest plan.",
  });
  assert.match(receipt.task.taskId, /^bgt-[a-f0-9]{48}$/u);
  assert.equal(receipt.task.title, "Compare pricing of products A, B and C");
  assert.match(receipt.note, /Do not poll/u);
  const record = task(f, receipt.task.taskId);
  const child = service.chatSessionStore.getSession(record.childSessionKey);
  assert.ok(child, "the child session exists");
  assert.notEqual(child.sessionKey, source.sessionKey);
  assert.equal(child.profileId, source.profileId);
  assert.equal(child.runtimeBindingId, service.chatSessionStore.getSession(source.sessionKey).runtimeBindingId);
  assert.notEqual(child.workspace, source.workspace, "the child writes in its own task directory");
  assert.equal(isAgentHomeWorkspace(f.paths, source.profileId, child.workspace), true);
  assert.equal(isAgentHomeWorkspace(f.paths, "other-profile", child.workspace), false);
  assert.equal(child.workspace.startsWith(source.workspace + path.sep), false);
  const listed = await rpc(f, "chat.session.list", { profileId: source.profileId, cursor: null, limit: 100, includeArchived: true });
  assert.equal(listed.sessions.some(item => item.sessionKey === child.sessionKey), false, "the child stays out of the session list");
  assert.equal(listed.sessions.some(item => item.sessionKey === source.sessionKey), true);

  // The clone has started before the source conversation moves on.
  const bg = await childRun(f, receipt.task.taskId);
  assert.notEqual(bg.id, parent.id);
  assert.equal(bg.sourceId, child.sessionKey);
  assert.equal(isBackgroundTaskOperation(bg.idempotencyKey.replace("shoggoth:chat-send:", "")), true);
  assert.equal(bg.runtimeSessionRef.runtimeProfileId, parent.runtimeSessionRef.runtimeProfileId, "same runtime binding");
  assert.notEqual(bg.runtimeSessionRef.sessionId, parent.runtimeSessionRef.sessionId, "a separate runtime session");
  const brief = service.transcriptStore.listEvents(child.profileId, child.id).find(event => event.kind === "user");
  assert.match(brief.content.text, /^\[Shoggoth background task\]/u);
  assert.match(brief.content.text, /Task brief:\nCompare pricing/u);

  await f.complete(parent, "I handed this to the background; ask me anything meanwhile.");
  const second = await f.send(source.sessionKey, "user-op-2", "What does the renewal clause mean?");
  assert.equal(second.status, "running", "the source conversation admits its next turn while the clone runs");
  await f.complete(second, "It renews yearly unless cancelled 30 days ahead.");
  assert.equal(service.workRunCoordinator.getRun(bg.id).status, "running", "the clone is still working");
  assert.equal(reports(f, source).length, 0);

  // The clone publishes a deliverable, then finishes.
  const csv = "product,price\nA,10\nB,8\nC,12\n".padEnd(4095, "A") + "青竹,12\n";
  fs.writeFileSync(path.join(child.workspace, "pricing.csv"), csv);
  const published = await callTool(f, bg, "artifact_publish", { runId: bg.id, name: "pricing.csv", kind: "report",
    mimeType: "text/csv", relativePath: "pricing.csv" });
  assert.match(published.file.url, /pricing\.csv|files/u);
  const binary = Buffer.from([0, 255, 36, 17]);
  fs.writeFileSync(path.join(child.workspace, "sample.bin"), binary);
  await callTool(f, bg, "artifact_publish", { runId: bg.id, name: "sample.bin", kind: "report",
    mimeType: "application/octet-stream", relativePath: "sample.bin" });
  await f.complete(bg, "B is the cheapest at 8. The full comparison is attached.");

  const [report] = await delivered(f, source);
  assert.equal(report.content.backgroundTaskReport.taskId, receipt.task.taskId);
  assert.equal(report.content.backgroundTaskReport.status, "completed");
  assert.match(report.content.text, /B is the cheapest at 8/u);
  assert.equal(report.content.backgroundTaskReport.files.length, 2);
  assert.match(report.content.text, new RegExp(published.file.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const secondAnswer = service.transcriptStore.listEvents(source.profileId, source.id)
    .filter(event => event.runId === second.id && event.kind === "assistant").at(-1);
  assert.ok(report.seq > secondAnswer.seq, "the report arrives after the independent second answer");
  await waitUntil(() => task(f, receipt.task.taskId).generations[0].report.state === "delivered", "delivery receipt", TIMEOUT);

  // A duplicate terminal notification delivers nothing more.
  await service.backgroundTaskService.deliver(receipt.task.taskId);
  await service.backgroundTaskService.recover();
  assert.equal(reports(f, source).length, 1);
  assert.equal(reports(f, child).length, 0, "nothing is posted into the clone's own session");

  const history = await rpc(f, "chat.history", { sessionKey: source.sessionKey, cursor: null, limit: 50 });
  const projected = history.messages.map(item => item.payload?.message ?? item).find(message => message?.shoggoth?.backgroundTaskReport);
  assert.equal(projected?.shoggoth.backgroundTaskReport.taskId, receipt.task.taskId);

  // The next source turn carries the report and its readable file path.
  const host = f.transport.hosts.get("codex");
  const followUp = await f.send(source.sessionKey, "user-op-3", "Add the enterprise plan of B to the table.");
  // Codex receives conversation data as injected items before turn/start.
  assert.equal(host.lastTurnStartParams.clientUserMessageId, "user-op-3");
  const sent = JSON.stringify(host.lastInjectedItems);
  assert.match(sent, /Background task report/u);
  assert.match(sent, /B is the cheapest at 8/u);
  assert.match(sent, /pricing\.csv: \//u, "the model can locate the file locally");
  const taskId = receipt.task.taskId;
  const { files } = await callTool(f, followUp, "background_task_get", { taskId });
  const { fileId } = files.find(file => file.name === "pricing.csv");
  const binaryId = files.find(file => file.name === "sample.bin").fileId;
  const binaryPage = await callTool(f, followUp, "background_task_get", { taskId, fileId: binaryId });
  assert.equal(binaryPage.encoding, "base64");
  assert.deepEqual(Buffer.from(binaryPage.data, "base64"), binary);
  const page = await callTool(f, followUp, "background_task_get", { taskId, fileId });
  assert.equal(page.encoding, "utf8");
  assert.equal(page.nextOffset, 4095);
  const last = await callTool(f, followUp, "background_task_get", { taskId, fileId, offset: page.nextOffset });
  assert.equal(last.nextOffset, null);
  assert.equal(last.encoding, "utf8");
  assert.equal(page.data + last.data, csv);
  await expectCode(callTool(f, followUp, "background_task_get", { taskId, fileId: "0".repeat(64) }), "MCP_TOOL_NOT_FOUND");
  await f.complete(followUp, "Added.");
  const outsider = await f.send(ownSession(f).sessionKey, "outsider-read", "Read a different chat's file.");
  await expectCode(callTool(f, outsider, "background_task_get", { taskId, fileId }), "BACKGROUND_TASK_NOT_FOUND");
  await f.complete(outsider, "Unavailable.");
});

function hostFor(f, run) {
  const ref = f.service.workRunCoordinator.getRun(run.id).runtimeSessionRef;
  return [...f.transport.handles.values()].find(handle => handle.runtime === ref.runtime
    && handle.runtimeProfileId === ref.runtimeProfileId && handle.runtimeAccountId === ref.runtimeAccountId).host;
}

async function interrupt(f, run) {
  const current = f.service.workRunCoordinator.getRun(run.id);
  const raw = hostFor(f, run);
  const thread = raw.threads.find(item => item.id === current.runtimeSessionRef.sessionId);
  const turn = thread.turns.find(item => item.id === current.runtimeTurnRef.turnId);
  turn.status = "interrupted";
  raw.emit({ known: true, type: "complete", method: "turn/completed", threadId: thread.id, turnId: turn.id, status: "interrupted" });
  await f.service.workRunCoordinator.waitForIdle(run.id).catch(() => {});
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code || (assert.equal(error?.code, code), false));
}

test("controls act only on the chosen task: steer, continue after finishing, stop without a report", { timeout: 60_000 }, async t => {
  const f = await open(t);
  const { service } = f;
  const source = f.createSession();
  const parent = await f.send(source.sessionKey, "op-control", "Two background jobs please.");
  const first = (await callTool(f, parent, "background_task_start", { brief: "Job one: summarize the notes" })).task;
  const second = (await callTool(f, parent, "background_task_start", { brief: "Job two: draft the email" })).task;
  assert.notEqual(first.taskId, second.taskId);
  const listed = await callTool(f, parent, "background_task_get", {});
  assert.deepEqual(listed.tasks.map(item => item.taskId), [first.taskId, second.taskId]);
  assert.equal(listed.bindings.some(binding => binding.current && binding.runtime === "codex"), true);
  const oneRun = await childRun(f, first.taskId);
  const twoRun = await childRun(f, second.taskId);

  // An extra instruction reaches the running turn of the chosen task only.
  const steered = await callTool(f, parent, "background_task_send", { taskId: first.taskId, message: "Also count the action items." });
  assert.equal(steered.delivered, "steered");
  const oneHost = hostFor(f, oneRun);
  assert.equal(oneHost.lastTurnSteerParams.threadId, service.workRunCoordinator.getRun(oneRun.id).runtimeSessionRef.sessionId);
  assert.match(JSON.stringify(oneHost.lastTurnSteerParams.input), /Also count the action items/u);

  // Stopping the second task stops only that run; a requested stop posts no report.
  const stopping = await callTool(f, parent, "background_task_cancel", { taskId: second.taskId });
  assert.equal(["stopping", "canceled"].includes(stopping.task.status), true);
  await interrupt(f, twoRun);
  await waitUntil(() => task(f, second.taskId).generations[0].terminal, "second task terminal", TIMEOUT);
  assert.equal(task(f, second.taskId).generations[0].report.state, "withheld");
  assert.equal(service.workRunCoordinator.getRun(oneRun.id).status, "running", "the other task keeps running");
  await f.complete(parent, "Both are running.");

  await f.complete(oneRun, "Summary done: 3 action items.");
  await delivered(f, source, 1);
  // A finished task continues with a new run in the same child session.
  const followUp = await f.send(source.sessionKey, "op-continue", "Ask job one to add owners.");
  const continued = await callTool(f, followUp, "background_task_send", { taskId: first.taskId, message: "Add an owner to each item." });
  assert.equal(continued.delivered, "new_run");
  assert.equal(continued.task.generation, 2);
  const oneRun2 = await childRun(f, first.taskId);
  assert.notEqual(oneRun2.id, oneRun.id);
  assert.equal(oneRun2.sourceId, task(f, first.taskId).childSessionKey);
  await f.complete(followUp, "Sent.");
  await f.complete(oneRun2, "Owners added.");
  const all = await delivered(f, source, 2);
  assert.deepEqual(all.map(event => [event.content.backgroundTaskReport.taskId, event.content.backgroundTaskReport.generation]),
    [[first.taskId, 1], [first.taskId, 2]]);
  assert.equal(all.some(event => event.content.backgroundTaskReport.taskId === second.taskId), false);
});

test("ownership: other conversations, other Agents and background sessions cannot reach a task", { timeout: 60_000 }, async t => {
  const f = await open(t);
  const { service } = f;
  const a = ownSession(f);
  const b = ownSession(f);
  const runA = await f.send(a.sessionKey, "op-a", "Background job in A.");
  const started = (await callTool(f, runA, "background_task_start", { brief: "Job A" })).task;
  await f.complete(runA, "Dispatched.");
  const runB = await f.send(b.sessionKey, "op-b", "Look at A's job.");
  await expectCode(callTool(f, runB, "background_task_get", { taskId: started.taskId }), "BACKGROUND_TASK_NOT_FOUND");
  await expectCode(callTool(f, runB, "background_task_cancel", { taskId: started.taskId }), "BACKGROUND_TASK_NOT_FOUND");
  assert.deepEqual((await callTool(f, runB, "background_task_get", {})).tasks, []);

  // A background session cannot dispatch further work (depth one).
  const child = await childRun(f, started.taskId);
  await expectCode(callTool(f, child, "background_task_start", { brief: "nested" }), "BACKGROUND_TASK_SOURCE_REQUIRED");
  // Its memory writes stay closed: its input is a brief, not the user's words.
  const memory = service.mcpProductToolController.conversationMemoryService;
  assert.throws(() => memory.bind("memory_save", { scope: "user" }, service.workRunCoordinator.getRun(child.id)),
    error => error.code === "MCP_TOOL_FORBIDDEN");
  // Only bindings that passed background verification can be chosen.
  await expectCode(callTool(f, runB, "background_task_start", { brief: "unsupported", bindingRef: f.binding("deepseek-harness").id }),
    "BACKGROUND_TASK_BINDING_UNAVAILABLE");
  await expectCode(callTool(f, runB, "background_task_start", { brief: "unknown", bindingRef: "no-such-binding" }), "BACKGROUND_TASK_BINDING_UNAVAILABLE");

  // A second Agent with the same name receives only its own report.
  const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId",
    "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
  const base = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  const twin = service.productStore.putAgentProfile({ ...base, id: "twin-agent", agentId: "twin-agent", runtimeProfileId: "twin-agent",
    isDefault: false });
  service.agentDefinitionStore.ensureProfile({ profileId: twin.id });
  const twinSession = ownSession(f, twin.id);
  const twinRun = await f.send(twinSession.sessionKey, "op-twin", "Twin background job.");
  const twinTask = (await callTool(f, twinRun, "background_task_start", { brief: "Twin job" })).task;
  const twinChild = await childRun(f, twinTask.taskId);
  assert.equal(twinChild.profileId, twin.id);
  await f.complete(child, "A is done.");
  await f.complete(twinChild, "Twin is done.");
  const [reportA] = await delivered(f, a);
  const [reportTwin] = await delivered(f, twinSession);
  assert.match(reportA.content.text, /A is done/u);
  assert.match(reportTwin.content.text, /Twin is done/u);
  assert.equal(reports(f, b).length, 0);
  for (const run of [runA, runB, twinRun]) await f.complete(run, "ok");
});

test("restart and duplicates: every stage resumes with the same operation and one report", { timeout: 90_000 }, async t => {
  let f = await open(t, { keep: true });
  t.after(() => f.close());
  const source = f.createSession();
  const parent = await f.send(source.sessionKey, "op-restart", "Background job across a restart.");
  const started = (await callTool(f, parent, "background_task_start", { brief: "Survive a restart" })).task;
  const before = await childRun(f, started.taskId);
  await f.complete(parent, "Started.");

  // Stage 1: the Service stops while the child is running.
  await f.close({ remove: false });
  f = await open(t, { root: f.root, transport: f.transport, keep: true });
  await waitUntil(() => {
    const run = f.service.workRunCoordinator.getRun(before.id);
    return run && run.status !== "starting";
  }, "child recovered", TIMEOUT);
  const recovered = f.service.workRunCoordinator.getRun(before.id);
  if (recovered.status === "running") await f.complete(recovered, "Finished after restart.");
  const [report] = await delivered(f, source);
  assert.equal(report.content.backgroundTaskReport.taskId, started.taskId);

  // Stage 2: the report was appended but its receipt was lost.
  f.service.backgroundTaskStore.update(started.taskId, record => {
    record.generations[0].report = { state: "pending", eventId: null, updatedAt: Date.now() };
  });
  await f.service.backgroundTaskService.recover();
  assert.equal(reports(f, source).length, 1);
  assert.equal(task(f, started.taskId).generations[0].report.state, "delivered");

  // Stage 3: the intent was saved, then the Service stopped before any child existed.
  const second = ownSession(f);
  const parent2 = await f.send(second.sessionKey, "op-intent", "Another job.");
  const service = f.service.backgroundTaskService;
  const original = service.start.bind(service);
  let interrupted = false;
  // Persist the intent through the real start path, but fail the first send.
  const getChat = service.getChat;
  service.getChat = () => ({ handle: async (method, params, ...rest) => {
    if (method === "chat.send" && params.operationId.startsWith("bg-send-") && !interrupted) {
      interrupted = true;
      throw Object.assign(new Error("lost"), { code: "SERVICE_UNAVAILABLE", receiptUncertain: true });
    }
    return getChat().handle(method, params, ...rest);
  } });
  const pending = (await original(f.service.workRunCoordinator.getRun(parent2.id), { operationId: "fixture-intent", brief: "Intent only" })).task;
  assert.equal(pending.status, "starting");
  assert.equal(task(f, pending.taskId).generations[0].runId, null);
  service.getChat = getChat;
  await f.service.backgroundTaskService.recover();
  await f.service.backgroundTaskService.recover();
  const resumed = await childRun(f, pending.taskId);
  const sends = f.service.workRunCoordinator.listRuns({}).filter(run => run.sourceId === task(f, pending.taskId).childSessionKey);
  assert.equal(sends.length, 1, "the resumed send used the same operation once");
  await f.complete(resumed, "Intent finished.");
  await f.complete(parent2, "ok");
  assert.equal((await delivered(f, second)).length, 1);
});

test("an archived source holds the report; a deleted source stops the child and posts nothing", { timeout: 60_000 }, async t => {
  const f = await open(t);
  const { service } = f;
  const source = ownSession(f);
  const parent = await f.send(source.sessionKey, "op-archive", "Job before archiving.");
  const kept = (await callTool(f, parent, "background_task_start", { brief: "Keep me" })).task;
  const keptRun = await childRun(f, kept.taskId);
  await f.complete(parent, "ok");
  service.chatSessionStore.requestArchive(source.sessionKey, "archive-source", Date.now());
  service.chatSessionStore.completeRemoteOperation("archive-source");
  assert.equal(service.chatSessionStore.getSession(source.sessionKey).status, "archived");
  await f.complete(keptRun, "Result while archived.");
  // Native chats have no restore yet; the report stays held for its original destination.
  await waitUntil(() => task(f, kept.taskId).generations[0].report.state === "held", "report held", TIMEOUT);
  assert.equal(reports(f, source).length, 0);
  assert.equal(task(f, kept.taskId).closedReason, null);

  const doomed = ownSession(f);
  const parent2 = await f.send(doomed.sessionKey, "op-delete", "Job before deleting.");
  const gone = (await callTool(f, parent2, "background_task_start", { brief: "Stop when my chat is deleted" })).task;
  const goneRun = await childRun(f, gone.taskId);
  await f.complete(parent2, "ok");
  service.chatSessionStore.requestDelete(doomed.sessionKey, "delete-source", Date.now());
  service.chatSessionStore.completeRemoteOperation("delete-source");
  await waitUntil(() => hostFor(f, goneRun).turnInterruptCalls > 0 || task(f, gone.taskId).closedReason,
    "child stop requested", TIMEOUT);
  await interrupt(f, goneRun).catch(() => {});
  await waitUntil(() => task(f, gone.taskId).closedReason === "source_deleted", "task closed", TIMEOUT);
  assert.equal(task(f, gone.taskId).generations[0].report.state, "withheld");
});

test("cross runtime: a Codex chat hands work to the same Agent's Pi binding; others are refused", { timeout: 60_000 }, async t => {
  const f = await open(t);
  const { service } = f;
  const source = ownSession(f);
  const parent = await f.send(source.sessionKey, "op-cross", "Use Pi for the research.");
  const pi = f.binding("pi");
  const listed = await callTool(f, parent, "background_task_get", {});
  assert.deepEqual(listed.bindings.map(binding => binding.runtime).sort(), ["codex", "pi"]);
  const started = (await callTool(f, parent, "background_task_start", { brief: "Research on Pi", bindingRef: "pi" })).task;
  assert.equal(started.runtime, "pi");
  const record = task(f, started.taskId);
  const child = service.chatSessionStore.getSession(record.childSessionKey);
  assert.equal(child.runtimeBindingId, pi.id, "the child uses the chosen binding of the same Profile");
  assert.equal(child.profileId, source.profileId);
  assert.equal(service.chatSessionStore.getSession(source.sessionKey).runtimeBindingId, f.binding("codex").id,
    "the source keeps its own runtime");
  const piRun = await childRun(f, started.taskId);
  assert.equal(piRun.runtimeSessionRef.runtime, "pi");
  assert.equal(parent.runtimeSessionRef.runtime, "codex");
  await f.complete(piRun, "Pi research finished.");
  const [report] = await delivered(f, source);
  assert.match(report.content.text, /Pi research finished/u);
  // The source conversation continues on Codex and sees the report.
  await f.complete(parent, "ok");
  const next = await f.send(source.sessionKey, "op-cross-next", "Summarize the Pi result.");
  assert.equal(next.runtimeSessionRef.runtime, "codex");
  assert.match(JSON.stringify(f.transport.hosts.get("codex").lastInjectedItems), /Pi research finished/u);
  await f.complete(next, "done");

  // Another Profile's binding and a disabled binding are refused before acceptance.
  const PROFILE_FIELDS = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId",
    "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
  const base = Object.fromEntries(PROFILE_FIELDS.map(key => [key, f.profile[key]]));
  const other = service.productStore.putAgentProfile({ ...base, id: "other-agent", agentId: "other-agent", runtimeProfileId: "other-agent",
    name: "Other", isDefault: false });
  const otherBinding = service.productStore.getAgentRuntimeBindings(other.id).bindings[0];
  const before = service.backgroundTaskStore.list({}).length;
  const asker = await f.send(source.sessionKey, "op-cross-refuse", "Try other runtimes.");
  await expectCode(callTool(f, asker, "background_task_start", { brief: "foreign", bindingRef: otherBinding.id }),
    "BACKGROUND_TASK_BINDING_UNAVAILABLE");
  const { revision } = service.productStore.getAgentRuntimeBindings(f.profile.id);
  service.productStore.updateAgentRuntimeBinding(f.profile.id, pi.id, { enabled: false }, { revision });
  await expectCode(callTool(f, asker, "background_task_start", { brief: "disabled pi", bindingRef: "pi" }),
    "BACKGROUND_TASK_BINDING_UNAVAILABLE");
  assert.equal(service.backgroundTaskStore.list({}).length, before, "nothing is accepted");
  await f.complete(asker, "ok");
});
