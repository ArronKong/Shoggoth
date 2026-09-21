#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { bindConversationSource } = require("../app/agent-service/conversation-source");
const id = () => crypto.randomUUID();

async function activeRun(f, runId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = f.service.workRunCoordinator.getRun(runId);
    if (["running", "waiting_input", "waiting_approval"].includes(run.status)) return run;
    if (["failed", "interrupted", "canceled"].includes(run.status)) assert.fail(JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not start: ${runId}`);
}

async function verifyConversationService(f) {
  const { service } = f;
  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const session = service.chatSessionStore.listSessions().find((item) => item.profileId === profile.id);
  assert.notEqual(session.id, session.sessionKey, "Use the real, distinct product and transcript IDs");
  const readFile = (kind) => f.ipc("harness.definition.read", { profileId: profile.id, kind, revision: null });
  assert.equal((await readFile("MEMORY")).revision, 0);
  const fileUrl = new URL(`/__api/agents/${encodeURIComponent(profile.agentId)}/file`, f.url);
  for (const [key, value] of Object.entries({ backend: "shoggoth", file: "MEMORY.md" })) {
    fileUrl.searchParams.set(key, value);
  }
  const emptyResponse = await fetch(fileUrl);
  assert.equal(emptyResponse.status, 200, await emptyResponse.clone().text());
  assert.equal((await emptyResponse.json()).file.revision, 0);
  console.log("PASS empty MEMORY.md through Service IPC and the UI REST endpoint");

  const send = async (prompt) => {
    const result = await f.ipc("chat.send", { operationId: id(), sessionKey: session.sessionKey,
      prompt, createdAt: Date.now() });
    return activeRun(f, result.run.id);
  };
  const abort = (run) => f.ipc("chat.abort", { operationId: id(), sessionKey: session.sessionKey,
    runId: run.id, createdAt: Date.now() });
  // The production Service constructs the tool controller and both conversation services.
  const call = (run, name, args) => service.mcpProductToolController.handle(name,
    { source: run.source, sourceId: run.sourceId, ...args }, { profileId: profile.id, callId: id() });
  const run = await send("以后叫我 Arron");
  const empty = await call(run, "memory_search", { query: "用户偏好的称呼 Arron", includeCandidates: true });
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.items, []);
  const saved = await call(run, "memory_save", { expectedRevision: empty.revision,
    content: "用户希望被称呼为 Arron", scope: "user", classification: "explicit", sourceQuote: "以后叫我 Arron" });
  assert.equal(saved.saved, true);
  const sourceEvent = service.transcriptStore.listEvents(profile.id, session.id)
    .find((event) => event.runId === run.id && event.kind === "user");
  assert.deepEqual(saved.item.sourceRefs, [sourceEvent.id, run.id]);
  for (const kind of ["MEMORY", "USER"]) assert.match((await readFile(kind)).content, /Arron/u);
  assert.match((await (await fetch(fileUrl)).json()).file.content, /Arron/u);
  await assert.rejects(() => call(run, "memory_search", { query: "", sourceId: session.id }),
    (error) => error.code === "MCP_TOOL_NOT_FOUND");
  await assert.rejects(() => call(run, "memory_save", { expectedRevision: saved.revision,
    content: "用户希望被称呼为别人", scope: "user", classification: "explicit", sourceQuote: "叫我别人" }),
  (error) => error.code === "MCP_TOOL_INVALID_ARGUMENTS");
  for (const wrongSession of [null, { ...session, profileId: "another-profile" },
    { ...session, workspace: "/unrelated-workspace" }]) {
    assert.throws(() => bindConversationSource({ args: {}, run, transcriptStore: service.transcriptStore,
      chatSessionStore: { getSession: () => wrongSession }, getRunSessionKey: () => session.sessionKey }),
    (error) => error.code === "CONVERSATION_SOURCE_INVALID");
  }
  await abort(run);
  console.log("PASS real chat memory search/save, provenance and ownership boundaries");

  const next = await send("把你的身份补充为研究助理，语气温和，工作规则加上先查证再回答。");
  const snapshot = service.contextSnapshotStore.get(profile.id, next.contextSnapshotId);
  assert.match(snapshot.dynamicContext, /用户希望被称呼为 Arron/u);
  for (const [kind, addition, sourceQuote] of [
    ["IDENTITY", "研究助理", "身份补充为研究助理"],
    ["SOUL", "语气温和", "语气温和"],
    ["AGENTS", "先查证再回答", "工作规则加上先查证再回答"],
  ]) {
    const before = await call(next, "agent_definition_read", { kind });
    const updated = await call(next, "agent_definition_update", { kind, expectedRevision: before.revision,
      oldText: before.content, newText: `${before.content}\n${addition}\n`, sourceQuote });
    assert.equal(updated.saved, true);
    assert.match((await readFile(kind)).content, new RegExp(addition, "u"));
  }
  await abort(next);
  console.log("PASS next-turn memory recall and conversational IDENTITY/SOUL/AGENTS edits");

  const { idea } = await f.ipc("inspiration.create", { operationId: id(), body: "记住我偏好简洁回答" });
  const started = await f.ipc("inspiration.start", { id: idea.id, operationId: id(), expectedRevision: idea.revision,
    agentId: profile.agentId, backendId: profile.backendId, workspace: null, instruction: "" });
  const inspirationRun = await activeRun(f, started.idea.latestExecution.runId);
  const boundKey = service.workRunCoordinator.getRunSessionKey(inspirationRun);
  assert.notEqual(boundKey, inspirationRun.sourceId);
  assert.notEqual(service.chatSessionStore.getSession(boundKey).id, boundKey);
  const found = await call(inspirationRun, "memory_search", { query: "Arron" });
  assert.ok(found.items.some((item) => item.id === saved.item.id));
  const preference = await call(inspirationRun, "memory_save", { expectedRevision: found.revision,
    content: "用户偏好简洁回答", scope: "user", classification: "explicit", sourceQuote: "记住我偏好简洁回答" });
  assert.equal(preference.saved, true);
  console.log("PASS Inspiration resolves its own bound chat session before recording memory");
}

module.exports = { verifyConversationService };
if (require.main === module) {
  (async () => {
    const f = await startInspirationFixture();
    try { await verifyConversationService(f); }
    finally { await f.close(); }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
