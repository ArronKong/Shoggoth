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

  const send = async (prompt, target = session) => {
    const result = await f.ipc("chat.send", { operationId: id(), sessionKey: target.sessionKey,
      prompt, createdAt: Date.now() });
    return activeRun(f, result.run.id);
  };
  const abort = async (run, target = session) => {
    try {
      return await f.ipc("chat.abort", { operationId: id(), sessionKey: target.sessionKey,
        runId: run.id, createdAt: Date.now() });
    } catch (error) {
      if (error.code !== "RUN_REQUEST_STATE_CONFLICT") throw error;
      // The fake Runtime can finish after the tool assertion but before the
      // cleanup abort. Accept only an observed terminal Run, never an active
      // Run whose control request genuinely failed.
      const latest = service.workRunCoordinator.getRun(run.id);
      if (["completed", "canceled", "interrupted"].includes(latest?.status)) return { run: latest };
      throw error;
    }
  };
  // The production Service constructs the tool controller and both conversation services.
  const call = (run, name, args) => service.mcpProductToolController.handle(name,
    { source: run.source, sourceId: run.sourceId, ...args }, { profileId: profile.id, callId: id() });
  const run = await send("以后叫我 Arron");
  await assert.rejects(() => call(run, "memory_search", {
    query: "用户偏好的称呼 Arron", includeCandidates: true,
  }), (error) => error.code === "MCP_TOOL_INVALID_ARGUMENTS");
  const empty = await call(run, "memory_search", { query: "用户偏好的称呼 Arron" });
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.items, []);
  const saved = await call(run, "memory_save", { expectedRevision: empty.revision,
    content: "用户希望被称呼为 Arron", scope: "user", classification: "explicit", sourceQuote: "以后叫我 Arron" });
  assert.equal(saved.saved, true);
  const sourceEvent = service.transcriptStore.listEvents(profile.id, session.id)
    .find((event) => event.runId === run.id && event.kind === "user");
  assert.deepEqual(saved.item.sourceRefs, [sourceEvent.id, run.id]);
  assert.equal((await call(run, "memory_get", { id: saved.item.id })).item.content,
    "用户希望被称呼为 Arron");
  const explanation = await call(run, "memory_explain", { id: saved.item.id });
  assert.equal(explanation.evidence.status, "verified_quote");
  assert.equal(explanation.evidence.quote, "以后叫我 Arron");
  assert.equal(explanation.evidence.sessionId, session.id);
  assert.equal(explanation.evidence.eventId, sourceEvent.id);
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
  await assert.rejects(() => call(inspirationRun, "memory_search", { query: "Arron" }),
    (error) => error.code === "MCP_TOOL_FORBIDDEN", "idea-card execution is not a direct user chat");
  await abort(inspirationRun, { sessionKey: boundKey });
  const continued = await f.ipc("chat.send", { operationId: id(), sessionKey: boundKey,
    prompt: "以后回答简洁一些", createdAt: Date.now() });
  const directRun = await activeRun(f, continued.run.id);
  assert.equal(service.inspirationStore.executionForRun(directRun.id).inputSource, "chat");
  const found = await call(directRun, "memory_search", { query: "Arron" });
  assert.ok(found.items.some((item) => item.id === saved.item.id));
  const preference = await call(directRun, "memory_save", { expectedRevision: found.revision,
    content: "用户偏好简洁回答", scope: "user", classification: "explicit", sourceQuote: "以后回答简洁一些" });
  assert.equal(preference.saved, true);
  console.log("PASS Inspiration card denied; direct chat-origin continuation may read and save memory");
  await abort(directRun, { sessionKey: boundKey });

  const createChat = () => service.chatSessionStore.createSession({ profileId: profile.id,
    workspace: session.workspace, operationId: id(), createdAt: Date.now() });
  const lookupSession = createChat();
  assert.notEqual(lookupSession.id, session.id);
  const lookupRun = await send("请检索上一段对话中的称呼原话。", lookupSession);
  const searchArgs = { query: "以后叫我 Arron", sessionId: session.id, limit: 10 };
  const searchWhenReady = async (run) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      let result;
      try { result = await call(run, "conversation_search", searchArgs); }
      catch (error) {
        // Real inference yields to transcript writes. A rejected stale read
        // must be retried with the current source revision, never reused.
        if (error.code !== "MCP_TOOL_STATE_CONFLICT" || Date.now() >= deadline) throw error;
        continue;
      }
      if (result.status !== "rebuilding") return result;
      if (Date.now() >= deadline) throw new Error("conversation index did not become ready");
      // A completed build may have been invalidated by the concurrent Run
      // append; the next search starts its replacement build.
      await service.conversationRecallService.whenIndexReady(profile.id);
    }
  };
  const original = await searchWhenReady(lookupRun);
  assert.equal(original.status, "ready");
  assert.ok(original.results.some((item) => item.sessionId === session.id
    && item.eventId === sourceEvent.id && item.kind === "user"
    && item.snippet.includes("以后叫我 Arron")),
  "cross-session search must find the verified original user event");
  const originalGet = await call(lookupRun, "conversation_get", {
    sessionId: session.id, eventId: sourceEvent.id, window: 0 });
  assert.deepEqual(originalGet.events.map((item) => item.text), ["以后叫我 Arron"]);
  await abort(lookupRun, lookupSession);

  const forgetQuote = "请忘记 Arron 这个称呼偏好";
  const forgetRun = await send(`${forgetQuote}。`, lookupSession);
  const forgotten = await call(forgetRun, "memory_forget", { id: saved.item.id,
    expectedRevision: service.memoryStore.getRevision(profile.id), sourceQuote: forgetQuote });
  assert.equal(forgotten.item.status, "deleted");
  assert.equal(forgotten.saved, false);
  assert.equal((await f.ipc("harness.memory.explain", { profileId: profile.id,
    id: saved.item.id })).withdrawalReason, "forgotten");
  await abort(forgetRun, lookupSession);

  const afterSession = createChat();
  const afterRun = await send("请复查已撤回称呼的旧原话是否仍可见。", afterSession);
  const after = await searchWhenReady(afterRun);
  assert.equal(after.status, "ready");
  assert.ok(!after.results.some(row => row.eventId === sourceEvent.id
    || row.snippet.includes("以后叫我 Arron")), "forgotten original must not be returned across sessions");
  await assert.rejects(() => call(afterRun, "conversation_get", {
    sessionId: session.id, eventId: sourceEvent.id, window: 0 }),
  (error) => error.code === "MCP_TOOL_NOT_FOUND");
  assert.equal((await call(afterRun, "memory_search", { query: "Arron" })).items
    .some((item) => item.id === saved.item.id), false);
  await abort(afterRun, afterSession);
  console.log("PASS verified cross-session conversation search/get, then memory_forget revokes old source");
}

module.exports = { verifyConversationService };
if (require.main === module) {
  (async () => {
    const f = await startInspirationFixture();
    try { await verifyConversationService(f); }
    finally { await f.close(); }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
