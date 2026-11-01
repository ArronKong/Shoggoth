"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { fixture: serviceFixture } = require("./native-chat-ui-service-unit.cjs");
const { openFixture, sendAndDrain, directRuntimeManager, FakeHost, PROFILE_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { contextToolContent } = require("../app/agent-service/context-tool-content");
const { consumeChatTextFragment } = require("../app/agent-service/chat-text-fragments");
const { conversationContextBudget } = require("../app/agent-service/conversation-context-budget");

// All values are synthetic. Conversation fidelity and memory admission are
// separate policies, even when the user discusses a configured credential.
const credential = "fixture-conversation-private-value";
const reply = `今天共有 23 封邮件，其中 15 封未读、8 封已读。\n邮件主题：验证码 123456\ntoken=${credential}`;
const assertMetadataSafe = value => !JSON.stringify(value).includes(credential);

test("user and assistant bodies survive private transcript persistence and context replay; memory still rejects them", () => {
  const f = contextFixture({ runtime: "pi" });
  try {
    f.transcripts.assertSecretSafe = assertMetadataSafe;
    for (const [index, kind] of ["user", "assistant"].entries()) {
      f.append({ id: `private-${kind}`, kind, content: { text: reply },
        contextContent: { text: reply, contextComplete: true }, occurredAt: 100 + index });
    }
    const legacy = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      contextLifecycleV1: false, currentPrompt: "继续", freshSession: true });
    assert.ok(legacy.dynamicContext.includes(reply));
    const large = `${reply}\n${"用户自己的邮件内容\n".repeat(6000)}`;
    f.append({ id: "private-long", kind: "assistant", content: { text: large } });
    f.transcripts.close(); f.transcripts.open();
    for (const kind of ["user", "assistant"]) {
      const event = f.transcripts.getEvent(f.profile.id, f.transcriptSessionId, `private-${kind}`);
      assert.equal(f.transcripts.displayEvent(f.profile.id, f.transcriptSessionId, event).content.text, reply);
      assert.equal(f.transcripts.contextEvent(f.profile.id, f.transcriptSessionId, event).content.text, reply);
    }
    const event = f.transcripts.getEvent(f.profile.id, f.transcriptSessionId, "private-long");
    assert.equal(f.transcripts.displayEvent(f.profile.id, f.transcriptSessionId, event).content.text, large);
    const contentPath = path.join(f.paths.agentsDir, f.profile.id, "transcripts", f.transcriptSessionId,
      "context-content", `${event.content.displayRef.hash}.json`);
    assert.equal(fs.statSync(contentPath).mode & 0o777, 0o600);

    f.append({ id: "current", kind: "user", content: { text: "继续", operationId: "current" } });
    const budget = conversationContextBudget(1_000_000);
    const snapshot = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      contextLifecycleV1: true, transcriptTokenBudget: budget.triggerTokens, requestBudget: budget,
      currentOperationId: "current", currentPrompt: "继续", freshSession: true });
    assert.ok(snapshot.dynamicContext.includes(reply));
    assert.ok(snapshot.dynamicContext.includes("用户自己的邮件内容"));
    assert.throws(() => f.memoryEngine.propose({ profileId: f.profile.id, scope: "user", type: "semantic",
      content: reply, sourceRefs: ["private-assistant"], classification: "explicit" }), { code: "MEMORY_SECRET_REJECTED" });
    assert.throws(() => f.append({ id: credential, kind: "assistant", content: { text: "body" } }),
      { code: "TRANSCRIPT_SECRET_REJECTED" }, "control identifiers still use the credential guard");
    assert.throws(() => f.transcripts.saveContextContent(f.profile.id, f.transcriptSessionId,
      { text: "x".repeat(8 * 1024 * 1024) }), { code: "TRANSCRIPT_EVENT_TOO_LARGE" });
  } finally { f.cleanup(); }
});

test("native conversation text keeps user information while diagnostic metadata remains redacted", () => {
  const ids = { threadId: "thread-1", turnId: "turn-1" };
  const options = { registeredSecrets: [credential] };
  const delta = normalizeCodexEvent({ method: "item/agentMessage/delta", params: { ...ids, delta: reply } }, options);
  assert.equal(delta.delta, reply);
  const message = normalizeCodexEvent({ method: "item/completed", params: { ...ids,
    item: { id: `message-${credential}`, type: "agentMessage", phase: "final_answer", text: reply } } }, options);
  assert.equal(message.text, reply);
  assert.equal(message.contextText, reply);
  assert.equal(message.contextIncomplete, undefined);
  assert.ok(!message.itemId.includes(credential));
  assert.deepEqual(contextToolContent({ output: reply }, [credential]), { contextTool: { output: reply } });
  const diagnostic = normalizeCodexEvent({ method: `future/${credential}`, params: ids }, options);
  assert.ok(!JSON.stringify(diagnostic).includes(credential));
});

for (const [runtime, long] of [["antigravity", false], ["codex", false], ["antigravity", true]]) {
  test(`${runtime} ${long ? "fragmented" : "short"} replies are streamed and saved without content replacement`, async () => {
    const f = contextFixture();
    f.transcripts.assertSecretSafe = assertMetadataSafe;
    const host = new FakeHost([], { threads: [{ id: "thread-private", threadSource: null, turns: [] }] });
    const value = await openFixture({ runtime, host, runtimeManager: directRuntimeManager(host, runtime),
      sessionStatus: "ready", threadId: "thread-private", transcriptStore: f.transcripts,
      assertSecretSafe: assertMetadataSafe, sanitizeSummary: text => text.includes(credential) ? null : text });
    let subscription;
    try {
      const { ack } = await sendAndDrain(value, { operationId: `private-${runtime}-${long}` });
      const run = value.coordinator.getRun(ack.run.id), received = [];
      subscription = value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => received.push(event));
      const text = long ? `${reply}\n${"原始完整邮件内容\n".repeat(8000)}` : reply;
      const common = { known: true, method: "session/update", sessionId: run.runtimeSessionRef.sessionId,
        threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId, itemId: "private-reply" };
      const preamble = runtime === "antigravity" && !long ? "正在读取今日邮件。\n" : "";
      if (preamble) {
        // ACP seals public progress at a tool boundary, then returns one full
        // final item. This is the original incident's context-content path.
        host.emit({ ...common, type: "text_delta", delta: preamble });
        host.emit({ ...common, type: "tool_start", itemId: "mail-tool", toolCallId: "mail-tool",
          tool: { kind: "read", name: "read_file", status: "in_progress" } });
      }
      host.emit({ ...common, type: "text_delta", delta: reply });
      host.emit({ ...common, type: "text", text: preamble + text,
        ...(preamble ? {} : { contextText: text }), phase: "final_answer" });
      const assembled = [], state = {};
      for (const event of received) {
        const full = consumeChatTextFragment(state, event);
        if (full?.type === "text") assembled.push(full.payload.text);
      }
      assert.deepEqual(assembled, preamble ? [preamble, text] : [text]);
      assert.ok(received.some(event => event.type === "text.delta" && event.payload.delta === reply));
      assert.equal(received.some(event => event.payload.redacted === true), false);
      const events = f.transcripts.listEvents(PROFILE_ID, value.sessions.session.id);
      const saved = events.filter(event => event.kind === "assistant" && event.content.transcriptType === "text").at(-1);
      assert.ok(saved);
      assert.equal(f.transcripts.displayEvent(PROFILE_ID, value.sessions.session.id, saved).content.text, text);
      assert.equal(f.transcripts.contextEvent(PROFILE_ID, value.sessions.session.id, saved).content.text, preamble + text);
      const turn = host.threads[0].turns.find(item => item.id === run.runtimeTurnRef.turnId);
      turn.status = "completed"; turn.itemsView = "full";
      turn.items.push({ id: "private-reply", type: "agentMessage", text, phase: "final_answer" });
      host.emit({ ...common, type: "complete", status: "completed" });
      await value.coordinator.waitForIdle(run.id);
      assert.equal(value.coordinator.getRun(run.id).status, "completed");
    } finally {
      subscription?.unsubscribe(); await value.coordinator.close(); f.cleanup();
    }
  });
}

test("actual Service chat history returns private user and assistant text after restart", async () => {
  const f = await serviceFixture();
  try {
    await f.service.secretStore.put("chat-policy-fixture", credential, { kind: "custom-responses" });
    const store = f.service.transcriptStore, session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    for (const kind of ["user", "assistant"]) store.appendEvent({ profileId: f.owner.profileId,
      sessionId: session.id, id: `private-service-${kind}`, runId: f.runId, kind,
      content: { text: reply }, contextContent: { text: reply, contextComplete: true },
      runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
    await assert.rejects(f.service.memoryEngine.propose({ profileId: f.owner.profileId, scope: "user",
      type: "semantic", content: reply, sourceRefs: ["private-service-user"], classification: "explicit" }),
    { code: "MEMORY_SECRET_REJECTED" });
    const texts = async () => (await f.ipc("chat.history", { sessionKey: f.owner.sessionKey, cursor: null, limit: 50 })).messages
      .map(item => item.payload.message).filter(message => message.content.some(part => part.text === reply));
    assert.deepEqual((await texts()).map(message => message.role), ["user", "assistant"]);
    await f.close(); await f.open();
    assert.deepEqual((await texts()).map(message => message.role), ["user", "assistant"]);
  } finally { await f.remove(); }
});
