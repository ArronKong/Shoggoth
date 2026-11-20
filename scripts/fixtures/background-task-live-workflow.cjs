"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { ensureAgentWorkspace } = require("../../app/agent-service/chat-workspace");
const { readBoundedFile } = require("../../app/agent-service/agent-file-store");
const { isBackgroundTaskReportEvent, TERMINAL_RUN_STATUSES } = require("../../app/agent-service/background-task-protocol");

// The default answer is an exact fixture handshake. An operator may additionally
// authorize publication of the verified disposable result.txt on its own card.
module.exports = async function check({ service, backend, paths, source, runtime, signal, model, textOnly = false, confirmResultFile = false }) {
  const { workRunCoordinator: coordinator, transcriptStore, chatSessionStore, backgroundTaskService: tasks } = service;
  const gatewaySessionKey = await backend.createSession(source.agentId);
  const session = chatSessionStore.getSession(gatewaySessionKey.split(":").at(-1));
  assert.equal(session.workspace, ensureAgentWorkspace(paths, source.id));
  const mode = session.permissionMode;
  if (model) chatSessionStore.setModelOverride(session.sessionKey, model);
  const target = service.productStore.getAgentRuntimeBindings(source.id).bindings.find(b => b.runtime === runtime && b.enabled);
  assert.ok(target, "Target belongs to the same Agent and is enabled");
  const events = () => transcriptStore.listEvents(source.id, session.id);
  const reports = () => events().filter(isBackgroundTaskReportEvent);
  const final = run => {
    const event = events().filter(e => e.runId === run.id && e.kind === "assistant" && e.content?.phase !== "commentary").at(-1);
    return event && transcriptStore.displayEvent(source.id, session.id, event).content.text;
  };
  const send = async prompt => (await coordinator.send({ sessionKey: session.sessionKey, operationId: crypto.randomUUID(), prompt })).run;
  const log = (stage, data = {}) => console.log(JSON.stringify({ source: source.runtime, target: runtime, stage, ...data }));
  async function until(stage, get, describe) {
    log(stage);
    const deadline = Date.now() + 180_000;
    do {
      signal.throwIfAborted();
      const result = get();
      if (result) return result;
      await delay(300, null, { signal });
    } while (Date.now() < deadline);
    throw new Error(`Timed out during ${stage}${describe ? ". " + describe() : ""}`);
  }
  function checkedRun(run) {
    const current = coordinator.getRun(run.id);
    if (current?.status === "waiting_approval") throw new Error("Run requires interactive permission approval");
    if (TERMINAL_RUN_STATUSES.has(current?.status) && current.status !== "completed") {
      throw new Error(current.errorCode || current.status);
    }
    return current;
  }
  const completed = (stage, run) => until(stage, () => {
    const current = checkedRun(run);
    return current.status === "completed" && current;
  });
  const challenge = `Fixture handshake ${crypto.randomBytes(5).toString("hex")}`;
  const secret = `receipt-${crypto.randomBytes(6).toString("hex")}`;
  const publishQuestion = `May I publish only result.txt to this temporary Agent's private file library and attach it to the original acceptance chat (${challenge})?`;
  const expectedQuestion = confirmResultFile ? publishQuestion : challenge;
  const ask = question => `Use the Shoggoth request_user_input tool with ${JSON.stringify({ questions: [{ id: "answer", header: "Acceptance", question }] })} and wait for the task-card answer.`;
  const deliverFile = "Use runtime_context_get with source chat and the sourceId in your current Run context. With its runId, call artifact_publish using relativePath result.txt, name result.txt, kind report and mimeType text/plain. After a successful receipt, reply FILE_READY with its file link. If publication fails, report the actual error. Keep the file contents out of the conversation.";
  const brief = confirmResultFile ? [
    "Copy seed.txt from your current task workspace into result.txt.",
    `Before publishing, ask the user for confirmation. ${ask(publishQuestion)}`,
    `Continue only if the user approves. ${deliverFile}`,
  ].join(" ") : [
    `First perform this scripted test handshake. ${ask(challenge)} The test driver supplies READY.`,
    textOnly ? "Then give the product of 13 and 7 in a plain-text report. This task has no file deliverable."
      : `Then copy seed.txt from your current task workspace into result.txt. ${deliverFile}`,
  ].join(" ");
  const selection = source.runtime === runtime ? "Use the current binding; omit bindingRef." : `Use bindingRef "${runtime}".`;
  const publicationRequest = confirmResultFile
    ? "I want this background task started. I authorize the worker to publish the test file result.txt to this temporary Agent's private file library and attach it in this chat. I will confirm that scope on the task card. " : "";
  const parent = await send(`${publicationRequest}Start one separate Shoggoth background task now using background_task_start. ${selection} Pass this brief verbatim to the worker, then end your own turn on the receipt. Brief: ${brief}`);
  const record = await until("dispatch", () => {
    const owned = service.backgroundTaskStore.list({ profileId: source.id, sourceSessionKey: session.sessionKey });
    assert.ok(owned.length <= 1, "Only one task accepted");
    if (owned[0]?.childSessionKey) return owned[0];
    if (checkedRun(parent).status === "completed" && !owned.length) {
      throw new Error(`Foreground ended without a background task receipt. Public reply: ${(final(parent) || "(empty)").slice(0, 400)}`);
    }
  });
  const child = chatSessionStore.getSession(record.childSessionKey);
  assert.equal(record.sourceRunId, parent.id);
  assert.equal(child.profileId, source.id);
  assert.equal(child.runtimeBindingId, target.id);
  assert.equal(child.permissionMode, mode);
  assert.notEqual(child.sessionKey, session.sessionKey);
  assert.ok(!child.workspace.startsWith(session.workspace + path.sep) && child.workspace !== session.workspace);
  if (!textOnly) fs.writeFileSync(path.join(child.workspace, "seed.txt"), secret + "\n", { flag: "wx", mode: 0o600 });
  const detail = () => tasks.detail(session.sessionKey, record.id);
  const describeWorker = () => {
    const { task, queueReason, interaction, messages } = detail();
    const reply = messages.filter(message => message.role === "assistant").at(-1)?.text || "";
    return JSON.stringify({ status: task.status, queueReason, interaction: interaction?.type, error: task.errorCode,
      publicReply: reply.replaceAll(secret, "[fixture value]").slice(0, 700) });
  };
  const checkpoint = stage => until(stage, () => {
    const { task, interaction } = detail();
    if (TERMINAL_RUN_STATUSES.has(task.status)) throw new Error(`Worker ended before the handshake. ${describeWorker()}`);
    if (task.status === "waiting_approval") throw new Error("Worker requires interactive permission approval");
    if (task.status === "waiting_input" && interaction) return interaction;
  }, describeWorker);
  const sourceRun = await completed("foreground-receipt", parent);
  const interaction = await checkpoint("worker-input");
  const workerRun = coordinator.getRun(interaction.runId);
  assert.equal(sourceRun.runtimeSessionRef.runtime, source.runtime);
  assert.equal(workerRun.runtimeSessionRef.runtime, runtime);
  assert.equal(workerRun.runtimeSessionRef.runtimeAccountId, target.runtimeAccountId);
  assert.notEqual(sourceRun.runtimeSessionRef.sessionId, workerRun.runtimeSessionRef.sessionId);
  const second = await send("What is 11 plus 12? Answer with the number only.");
  await completed("independent-answer", second);
  assert.match(final(second) || "", /\b23\b/u);
  assert.equal(detail().task.status, "waiting_input");
  assert.equal(reports().length, 0);
  const { interaction: card } = await backend.getBackgroundTask(gatewaySessionKey, record.id);
  const { fields, requestId } = card.payload;
  assert.equal(card.runId, workerRun.id);
  assert.equal(requestId, interaction.payload.requestId);
  assert.equal(card.payload.kind, "user_input");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, "text");
  assert.equal(fields[0].secret, false);
  assert.ok([fields[0].label, fields[0].description, card.payload.message].includes(expectedQuestion), "Unexpected fixture question");
  const control = input => backend.controlBackgroundTask(gatewaySessionKey, record.id, { operationId: crypto.randomUUID(), ...input });
  let answer = "READY";
  if (confirmResultFile) {
    assert.equal(card.payload.message, publishQuestion);
    assert.equal(fields[0].description, publishQuestion);
    assert.deepEqual(fields[0].options, []);
    const expected = Buffer.from(secret + "\n");
    const bytes = await readBoundedFile(path.join(child.workspace, "result.txt"), { limit: expected.length + 1 });
    assert.ok(bytes.equals(expected), "Only the exact random test file is authorized");
    answer = "YES. Publish this result.txt to this temporary Agent's private file library and attach it to the original acceptance chat.";
  }
  await control({ action: "input", inputAction: "submit", requestId, answers: { [fields[0].id]: answer } });
  if (confirmResultFile) log("result-file-confirmed", { file: "result.txt", bytesVerified: true });
  const stopTest = { action: "send",
    message: `This is the stop test. ${ask(challenge)}` };
  const queueDuringRun = ["grok-build", "opencode", "antigravity"].includes(runtime);
  if (queueDuringRun) {
    const receipt = await control(stopTest);
    assert.equal(receipt.delivered, "queued");
    assert.equal((await backend.getBackgroundTask(gatewaySessionKey, record.id)).queuedFollowUps, 1);
    log("supplement-queued");
  } else {
    const receipt = await control({ action: "send", message: "Keep the final report concise." });
    assert.equal(receipt.delivered, "steered");
    log("supplement-steered");
  }
  const report = await until(textOnly ? "text-report" : "file-report", () => {
    const current = checkedRun(workerRun);
    if (current.status === "waiting_input" && current.waitingRequestId !== requestId) {
      const request = detail().interaction?.payload;
      const question = String(request?.questions?.[0]?.question || request?.message || "Open the task card");
      throw new Error(`Worker is waiting for a separate user decision. ${question.slice(0, 400)}`);
    }
    return reports()[0];
  });
  const data = report.content.backgroundTaskReport;
  assert.equal(data.status, "completed");
  assert.equal(data.taskId, record.id);
  if (textOnly) {
    assert.match(report.content.text, /\b91\b/u);
    assert.equal(data.files.length, 0);
  } else {
    assert.equal(data.files.length, 1, `Expected one published file. Worker report: ${report.content.text.replaceAll(secret, "[fixture value]").slice(0, 900)}`);
    assert.match(report.content.text, /FILE_READY/u);
    assert.ok(!report.content.text.includes(secret), "The next turn must learn the value from the file");
    assert.equal(data.files[0].name, "result.txt");
  }
  await tasks.deliver(record.id);
  assert.equal(reports().length, 1);
  if (!textOnly) {
    const follow = await send("Read the delivered result.txt using background_task_get with the taskId and fileId from the report. Reply with the exact contents.");
    await completed("file-follow-up", follow);
    assert.ok(final(follow)?.includes(secret), "The original chat read the actual attachment bytes");
  }

  if (!queueDuringRun) await control(stopTest);
  await checkpoint("second-generation-input");
  await control({ action: "cancel" });
  await until("stop", () => detail().task.status === "canceled");
  await tasks.deliver(record.id);
  assert.equal(reports().length, 1, "Stopping the second generation produced no report");
  log("passed", { distinctSessions: true, permissionMode: mode, artifactRead: !textOnly, reportCount: 1, stopped: true });
};
