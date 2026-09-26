#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { createChatServiceController } = require("../app/agent-service/chat-service-controller");
const { fixture, until } = require("./fixtures/inspiration-coordinator-fixture.cjs");

async function history(f, sessionKey, limit = 100) {
  const controller = createChatServiceController({
    paths: f.paths, productStore: f.productStore, chatSessionStore: f.sessions,
    transcriptStore: f.transcript, coordinator: f.coordinator,
    cursorSecret: Buffer.alloc(32, 1),
  });
  await controller.open();
  try {
    const messages = [];
    let cursor = null;
    do {
      const page = await controller.handle("chat.history", { sessionKey, cursor, limit });
      messages.unshift(...page.messages.map(item => item.payload.message));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return messages;
  } finally { await controller.close(); }
}

test("restarting while awaiting approval keeps the interruption notice without approval history", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approval = f.host.approve(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
  const before = await history(f, idea.latestExecution.sessionKey);
  assert.equal(before.some(message => message.shoggoth?.interruptedApproval), false);
  assert.equal(before.some(message => message.content[0].text.includes("需要授权")), false);

  await f.restart();
  await approval;
  await until(() => f.dispatcher.getRun(run.id).status === "interrupted");
  const messages = await history(f, idea.latestExecution.sessionKey);
  const cards = messages.filter(message => message.shoggoth?.interruptedApproval);
  assert.equal(cards.length, 0);
  assert.equal(messages.some(message => message.content[0].text.includes("需要授权")), false);
  assert.equal(messages.at(-1).notice, "runInterrupted");
  assert.equal(f.host.turnStarts, 1, "reading recovery history must never restart the model");
  await assert.rejects(f.coordinator.respondApproval({
    operationId: crypto.randomUUID(), runId: run.id, requestId, choice: "once",
  }));
});

test("an answered approval and its decision stay hidden after a restart and across history pages", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approval = f.host.approve(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  await f.coordinator.respondApproval({ operationId: crypto.randomUUID(), runId: run.id,
    requestId: f.dispatcher.getRun(run.id).waitingRequestId, choice: "once" });
  await approval;
  await f.restart();
  await until(() => f.dispatcher.getRun(run.id).status === "interrupted");
  const messages = await history(f, idea.latestExecution.sessionKey, 1);
  assert.equal(messages.some(message => message.shoggoth?.interruptedApproval), false);
  assert.equal(messages.some(message => /需要授权|授权：/.test(message.content[0].text)), false);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const events = f.transcript.listEvents(run.profileId, session.id);
  assert.ok(events.some(event => event.kind === "approval"), "原始授权请求仍然保留");
  assert.ok(events.some(event => event.content?.transcriptType === "interaction.response"), "原始授权决定仍然保留");
});

test("an unexpected runtime crash remains an error instead of being described as a Service restart", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  f.dispatcher.transition(run.id, "interrupted", { errorCode: "CODEX_HOST_TERMINATED" });
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  f.transcript.appendEvent({ profileId: run.profileId, sessionId: session.id,
    id: crypto.randomUUID(), runId: run.id, kind: "error",
    content: { transcriptType: "terminal", status: "interrupted", errorCode: "CODEX_HOST_TERMINATED" },
    runtimeRef: run.runtimeTurnRef, contextExcluded: false, occurredAt: Date.now() });
  const messages = await history(f, session.sessionKey);
  assert.equal(messages.at(-1).notice, undefined);
  assert.equal(messages.at(-1).content[0].text, "CODEX_HOST_TERMINATED");
});

test("large approval details stay in the transcript without entering chat history", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const command = "x".repeat(15_500);
  f.transcript.appendEvent({ profileId: run.profileId, sessionId: session.id,
    id: crypto.randomUUID(), runId: run.id, kind: "approval",
    content: { transcriptType: "approval", requestId: crypto.randomUUID(), kind: "command",
      command, cwd: `/${"w".repeat(3_000)}`, reason: "r".repeat(3_500),
      toolInput: { description: "d".repeat(8_000) } },
    runtimeRef: run.runtimeTurnRef, contextExcluded: false, occurredAt: Date.now() });
  f.dispatcher.transition(run.id, "interrupted", { errorCode: "SERVICE_RESTARTED" });
  const messages = await history(f, session.sessionKey);
  assert.equal(JSON.stringify(messages).includes(command), false);
  assert.equal(messages.some(message => message.shoggoth?.interruptedApproval), false);
  assert.ok(f.transcript.listEvents(run.profileId, session.id)
    .some(event => event.content?.command === command));
});

test("hiding approval history preserves the live request and the normal response path", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approval = f.host.approve(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
  const subscription = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, () => {});
  assert.ok(subscription.events.some(event => event.type === "approval" && event.payload.requestId === requestId));
  subscription.unsubscribe();
  const before = await history(f, idea.latestExecution.sessionKey);
  const response = await f.coordinator.respondApproval({ operationId: crypto.randomUUID(), runId: run.id,
    requestId, choice: "once" });
  assert.equal(response.run.status, "running");
  assert.equal((await approval).decision, "accept");
  assert.deepEqual(await history(f, idea.latestExecution.sessionKey, 1), before);
  f.host.complete(run, "授权之后的正常回答");
  await until(() => f.dispatcher.getRun(run.id).status === "completed");
  const after = await history(f, idea.latestExecution.sessionKey, 1);
  assert.equal(after.at(-1).content[0].text, "授权之后的正常回答");
});

test("MCP tool approvals are hidden while clarification questions and answers stay visible", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const before = await history(f, idea.latestExecution.sessionKey);
  const permission = f.host.request("mcpServer/elicitation/request", {
    threadId: run.codexThreadId, turnId: run.codexTurnId, serverName: "fixture", mode: "form",
    message: 'Allow the fixture MCP server to run tool "read_news"?',
    requestedSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_input");
  assert.deepEqual(await history(f, idea.latestExecution.sessionKey), before);
  await f.coordinator.respondInput({ operationId: crypto.randomUUID(), runId: run.id,
    requestId: f.dispatcher.getRun(run.id).waitingRequestId, action: "submit", answers: {} });
  assert.equal((await permission).action, "accept");
  assert.deepEqual(await history(f, idea.latestExecution.sessionKey, 1), before);

  const question = f.host.ask(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_input");
  await f.coordinator.respondInput({ operationId: crypto.randomUUID(), runId: run.id,
    requestId: f.dispatcher.getRun(run.id).waitingRequestId, action: "submit", answers: { audience: "family" } });
  await question;
  const messages = await history(f, idea.latestExecution.sessionKey, 1);
  assert.ok(messages.some(message => message.content[0].text.includes("主要给谁使用？")));
  assert.equal(messages.at(-1).content[0].text, "补充：audience: family");
});

test("approval visibility uses request and run identity instead of matching conversation text", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const append = (kind, content, runId = run.id) => f.transcript.appendEvent({
    profileId: run.profileId, sessionId: session.id, id: crypto.randomUUID(), runId, kind,
    content, runtimeRef: run.runtimeTurnRef, contextExcluded: false, occurredAt: Date.now(),
  });
  const requestId = crypto.randomUUID();
  const request = append("approval", { transcriptType: "approval", requestId,
    kind: "command", command: "read-news", reason: "Fetch: https://www.npr.org/sections/news/" });
  const user = append("user", { text: "授权：Yes, allow once" });
  const assistant = append("assistant", { text: "需要授权\n\n这是正常对话中的说明。" });
  const unrelatedResponse = append("user", { transcriptType: "interaction.response", requestId,
    text: "补充：保留另一个 run 的回答" }, `other-${run.id}`);
  const decision = append("user", { transcriptType: "interaction.response", requestId,
    text: "授权：Yes, always allow en.wikipedia.org for this project" });
  const messages = await history(f, session.sessionKey, 1);
  const ids = new Set(messages.map(message => message.id));
  assert.ok(ids.has(user.id) && ids.has(assistant.id) && ids.has(unrelatedResponse.id));
  assert.ok(!ids.has(request.id) && !ids.has(decision.id));
});

test("product confirmations keep one live card without a duplicate history bubble", async t => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const before = await history(f, session.sessionKey);
  const confirmation = f.host.request("mcpServer/elicitation/request", {
    threadId: run.codexThreadId, turnId: run.codexTurnId, serverName: "shoggoth", mode: "form",
    message: "Shoggoth 将操作 Computer Use 会话。是否继续？",
    requestedSchema: { type: "object", required: ["confirm_product_action"], properties: {
      confirm_product_action: { type: "string", title: "确认修改", enum: ["确认执行", "取消"] },
    } },
  });
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_input");
  const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
  const subscription = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, () => {});
  assert.ok(subscription.events.some(event => event.type === "prompt" && event.payload.requestId === requestId),
    "the confirmation must still reach the live interactive card");
  subscription.unsubscribe();
  assert.deepEqual(await history(f, session.sessionKey, 1), before,
    "a pending product confirmation must not also render as an assistant message");
  await f.coordinator.respondInput({ operationId: crypto.randomUUID(), runId: run.id,
    requestId, action: "submit", answers: { confirm_product_action: "取消" } });
  assert.deepEqual(await confirmation, { action: "accept", content: { confirm_product_action: "取消" } },
    "Cancel must reach the product helper as the original selected answer");
  assert.deepEqual(await history(f, session.sessionKey, 1), before,
    "confirmation responses must not reappear as ordinary chat messages");
  const events = f.transcript.listEvents(run.profileId, session.id);
  assert.ok(events.some(event => event.kind === "input" && event.content.requestId === requestId));
  assert.ok(events.some(event => event.content.transcriptType === "interaction.response" && event.content.requestId === requestId),
    "raw confirmation requests and responses must remain in the transcript");
});
