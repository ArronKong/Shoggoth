#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), { test } = require("node:test");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
const { ChatUiTextProjection } = require("../app/agent-service/chat-ui-text-projection");
const { fragmentHistoryItem, reassembleHistoryItems } = require("../app/agent-service/chat-history-adapter");
const { appendChatText, consumeChatTextFragment } = require("../app/agent-service/chat-text-fragments");
const { openFixture, sendAndDrain, SESSION_KEY } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

async function history(f, limit = 3) {
  let cursor = null; const messages = [], sizes = [];
  do {
    const page = await f.ipc("chat.history", { sessionKey: f.owner.sessionKey, cursor, limit });
    sizes.push(Buffer.byteLength(JSON.stringify(page)));
    for (const item of page.messages) assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 48 * 1024);
    messages.unshift(...page.messages); cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor);
  assert.ok(sizes.every(bytes => bytes < 64 * 1024));
  return { items: messages, messages: reassembleHistoryItems(messages).map(item => item.payload.message), pages: sizes.length };
}
test("actual Service preserves long sealed prefixes, cards and full model context across fragment pages and restart", async () => {
  const f = await fixture(); try {
    const text = '中文😀\\\"\n'.repeat(28000), middle = "卡片之间".repeat(15000);
    const store = f.service.transcriptStore, session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    const projection = new ChatUiTextProjection(); f.service.workRunCoordinator.nativeUiTextProjection = projection;
    projection.observe(f.runId, "text.delta", { itemId: "long", delta: text });
    const first = (await f.call("render_ui", declaration())).part;
    projection.observe(f.runId, "text.delta", { itemId: "long", delta: middle });
    const second = (await f.call("render_ui", declaration())).part;
    const suffix = projection.observe(f.runId, "text", { itemId: "long", text: text + middle + "结束" });
    store.appendEvent({ profileId: f.owner.profileId, sessionId: session.id, id: "long-final-source", runId: f.runId,
      kind: "assistant", content: { transcriptType: "text", ...suffix },
      contextContent: { transcriptType: "text", ...suffix, text: text + middle + "结束", contextComplete: true },
      runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
    const before = await history(f);
    assert.ok(before.pages > 5);
    const parts = before.messages.filter(message => message.role === "assistant").flatMap(message => message.content);
    assert.deepEqual(parts.map(part => part.text || part.artifactId), [text, first.artifactId, middle, second.artifactId, "结束"]);
    const final = store.getEvent(f.owner.profileId, session.id, "long-final-source");
    assert.equal(store.contextEvent(f.owner.profileId, session.id, final).content.text, text + middle + "结束");
    const prefix = store.listEvents(f.owner.profileId, session.id).find(event => event.content?.transcriptType === "ui.text.boundary");
    assert.equal(prefix.contextExcluded, true); assert.ok(prefix.content.displayRef); assert.ok(prefix.content.segmentId);
    await f.close(); await f.open(); assert.deepEqual((await history(f)).messages, before.messages);
  } finally { await f.remove(); }
});
test("imported long Codex fragments become one verified canonical source, with original message identity", async () => {
  const f = await fixture(); try {
    const session = f.service.chatSessionStore.getSession(f.owner.sessionKey), store = f.service.transcriptStore;
    const text = "原始长正文".repeat(20000) + "\n```html\n<!doctype html><p>完整旧页</p>\n```";
    const item = { id: "old-message", runId: null, role: "assistant", type: "text", payload: { message: {
      id: "old-message", role: "assistant", timestamp: 1700000000000, content: [{ type: "text", text }], codex: { itemType: "agentMessage" },
    } }, createdAt: 1700000000000, fragment: null };
    const fragments = fragmentHistoryItem(item); assert.ok(fragments.length > 4);
    assert.throws(() => reassembleHistoryItems(fragments.slice(1)));
    const corrupt = structuredClone(fragments); corrupt[1].payload.data += "x";
    assert.throws(() => reassembleHistoryItems(corrupt));
    const events = store.importHistoryItems({ profileId: f.owner.profileId, sessionId: session.id, items: fragments, runtimeRef: null });
    assert.equal(events.length, 1); assert.ok(events[0].content.displayRef); assert.equal(events[0].content.importedFrom, "codex");
    assert.equal(store.displayEvent(f.owner.profileId, session.id, events[0]).content.historyItem.payload.message.content[0].text, text);
    assert.equal(store.importHistoryItems({ profileId: f.owner.profileId, sessionId: session.id, items: fragments, runtimeRef: null })[0].id, events[0].id);
    const restored = (await history(f, 1)).messages.find(message => message.id === "old-message");
    assert.equal(restored.content[0].text, text); assert.equal(restored.shoggoth.sourceEventId, events[0].id);
  } finally { await f.remove(); }
});
test("actual Coordinator Runtime long event reaches Backend once and stays within the unchanged event bound", async () => {
  const f = await openFixture(); try {
    await sendAndDrain(f, { operationId: "long-runtime-op", sessionKey: SESSION_KEY, prompt: "long" });
    const run = f.dispatcher.listRuns()[0], events = [];
    const unsubscribe = f.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const text = "中文😀".repeat(50000);
    f.host.emit(require("../app/agent-service/codex-event-normalizer").normalizeCodexEvent({ method: "item/completed", params: {
      threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      item: { type: "agentMessage", id: "long-runtime-item", text, phase: "final_answer" },
    } }));
    const fragments = events.filter(event => event.type === "text.fragment"); assert.ok(fragments.length > 4);
    fragments.forEach(event => assert.ok(Buffer.byteLength(JSON.stringify(event)) < 48 * 1024));
    const backend = new ShoggothBackend({}), received = [], state = { text: "", reasoning: "", settled: false };
    const context = { run, hooks: { delta: value => received.push(value) } };
    for (const event of fragments) await backend._consumeEvent(context, state, event);
    assert.deepEqual(received, [text]); assert.equal(state.nativeContent.parts[0].text, text);
    const wrong = structuredClone(fragments); wrong[1].payload.sha256 = "f".repeat(64);
    const partial = {}; consumeChatTextFragment(partial, wrong[0]); assert.throws(() => consumeChatTextFragment(partial, wrong[1]));
    const sent = []; assert.throws(() => appendChatText({ append: (...args) => sent.push(args) }, "text", { text }, () => false, run.id), { code: "RUN_EVENT_SECRET_REJECTED" });
    assert.equal(sent.length, 0); unsubscribe.unsubscribe();
  } finally { await f.coordinator.close(); }
});
