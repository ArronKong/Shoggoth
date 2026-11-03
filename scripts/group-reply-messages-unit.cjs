"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupActivityProjection, validGroupActivity } = require("../app/agent-service/group-activity");
const { GroupNativeExecutor } = require("../app/agent-service/group-native-executor");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { groupReplyMessages } = require("../app/group-reply-messages");
const { ChatUiTextProjection } = require("../app/agent-service/chat-ui-text-projection");
const binding = { groupId: "g", discussionId: "d", memberId: "m", opportunityId: "o", runId: "r", executionGeneration: "f:r" };
const event = (seq, type, payload) => ({ seq, type, payload });

test("source message boundaries survive text deltas, tools and terminal completion", () => {
  const activity = new GroupActivityProjection(binding);
  activity.observeEvents([event(1, "text", { itemId: "one", text: "先核对配置。" }),
    event(2, "tool.start", { toolCallId: "tool", tool: { name: "read_file" } })], "stream");
  assert.deepEqual(activity.replyMessages().map(({ id, text, pending }) => ({ id, text, pending })),
    [{ id: "one", text: "先核对配置。", pending: false }]);
  activity.observeEvents([event(3, "text.delta", { itemId: "two", delta: "配置" }),
    event(4, "text.delta", { itemId: "two", delta: "已核对。" })], "stream");
  assert.deepEqual(activity.replyMessages().map(({ id, text, pending }) => ({ id, text, pending })),
    [{ id: "one", text: "先核对配置。", pending: false }, { id: "two", text: "配置已核对。", pending: true }]);
  activity.observeStatus("completed");
  assert.equal(activity.replyMessages()[0].final, false);
  assert.equal(activity.replyMessages()[1].final, true);
  assert.ok(validGroupActivity(activity.snapshot()));
  activity.observeEvents([event(5, "text", { itemId: "three", text: "late" })], "stream");
  assert.equal(activity.replyMessages().length, 2, "late text cannot revive a completed execution");
});

test("equal text remains two messages; private events and retired streams cannot supply bubbles", () => {
  const activity = new GroupActivityProjection(binding);
  activity.observeEvents([event(1, "text", { itemId: "one", text: "收到" }), event(2, "text", { itemId: "two", text: "收到" }),
    event(3, "text", { itemId: "analysis", text: "private", phase: "analysis" }),
    event(4, "text", { itemId: "async", text: "private", delivery: "async" })], "one");
  assert.deepEqual(activity.replyMessages().map(item => item.text), ["收到", "收到"]);
  activity.observeEvents([event(1, "text", { itemId: "new", text: "新运行" })], "two");
  activity.observeEvents([event(5, "text", { itemId: "old", text: "old" })], "one");
  assert.deepEqual(activity.replyMessages().map(item => item.text), ["新运行"]);
});

test("message frames remain bounded and strict, with the original 64 KiB tool budget", () => {
  const activity = new GroupActivityProjection(binding);
  for (let index = 0; index < 32; index++) activity.observeEvents([event(index + 1, "text", { itemId: "text:" + index, text: "正文".repeat(6000) })], "stream");
  const value = activity.snapshot();
  assert.ok(validGroupActivity(value));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 256 * 1024);
  assert.equal(value.textMessages.length, 32);
  assert.equal(validGroupActivity({ ...value, textMessages: [{ id: "one", text: "a", rawReasoning: "private" }] }), false);
  assert.equal(validGroupActivity({ ...value, tool: { id: "t", name: "read", title: "read", status: "running", startedAt: null,
    updatedAt: null, finishedAt: null, durationMs: null, output: "x".repeat(70 * 1024) } }), false);
  assert.equal(groupReplyMessages([{ id: "x", text: "first" }, { id: "x", text: "updated" }]).length, 1);
});

test("native transcript selection keeps commentary and the authoritative final as distinct messages", () => {
  const events = [
    { id: "one", runId: "r", kind: "assistant", content: { text: "先核对配置。", phase: "commentary" } },
    { id: "private", runId: "r", kind: "assistant", content: { text: "private", phase: "analysis" } },
    { id: "foreign", runId: "other", kind: "assistant", content: { text: "foreign" } },
    { id: "two", runId: "r", kind: "assistant", content: { text: "已完成。", phase: "final_answer" } },
  ];
  const executor = new GroupNativeExecutor({ chatSessionStore: { getSession: () => ({ profileId: "p", id: "s" }) },
    transcriptStore: { listEvents: () => events } });
  const messages = executor.replyMessages({ id: "r", sourceId: "s", profileId: "p" });
  assert.deepEqual(messages, [{ id: "one", text: "先核对配置。", final: false }, { id: "two", text: "已完成。", final: true }]);
  assert.deepEqual(executor.replyMessages({ id: "r", sourceId: "s", profileId: "other" }), []);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-message-boundaries-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let clock = Date.parse("2026-11-01T02:00:00Z");
  let store = new GroupChatStore({ paths, now: () => clock }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { groupId } = store.createGroup({ operationId: "create", name: "Message boundaries", purpose: "",
    members: ["a", "b"].map(id => ({ backendId: "shoggoth", agentId: id, profileId: id, displayName: id })) });
  store.appendUserMessage({ groupId, clientMessageId: "user", body: "核对配置", mentionMemberIds: [] });
  const fence = store.advanceDriverFence(), claimed = store.claimNext(groupId, fence), opportunityId = claimed.opportunity.id;
  store.bindSession({ groupId, memberId: claimed.member.id, sessionKey: "session", fence });
  store.recordRun({ opportunityId, runId: "run", sessionKey: "session", fence });
  return { get store() { return store; }, groupId, fence, opportunityId, advance(ms = 60000) { clock += ms; },
    sync(messages) { return store.syncTurnMessages({ opportunityId, fence, runId: "run", messages }); },
    reopen() { store.close(); store = new GroupChatStore({ paths, now: () => clock }).open(); } };
}

test("native live text, tool-boundary receipts and transcript settlement publish each segment once", t => {
  const f = fixture(t), buffer = new ChatUiTextProjection(), activity = new GroupActivityProjection({ ...binding, runId: "run" });
  const transcript = [];
  let seq = 0;
  const observe = (type, payload) => {
    activity.observeEvents([event(++seq, type, payload)], "stream");
    f.sync(activity.replyMessages());
  };
  const text = (type, payload) => {
    const projected = buffer.observe("run", type, payload);
    if (type === "text") transcript.push({ id: `receipt:${seq}`, runId: "run", kind: "assistant", content: projected });
    observe(type, projected);
  };
  const flush = id => buffer.flush("run", id, part => {
    const content = { ...part, phase: "commentary" };
    transcript.push({ id: `boundary:${id}`, runId: "run", kind: "assistant", content });
    observe("text", content);
    return content;
  });
  const first = "我来负责把稿子和 HTML 交付，先让各位领取板块。我先核对最近两天 AI 领域的事件。";
  const second = "材料已够用：我先把可交付的 HTML 做出来。\n";
  text("text.delta", { itemId: "part:one", delta: first });
  const original = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0];
  flush("search");
  text("text.delta", { itemId: "part:two", delta: second });
  flush("write");
  // OpenCode ends by replaying all its original text parts. The projection has
  // already sealed the first two, so their canonical text is empty here.
  text("text", { itemId: "part:one", text: first, phase: "final_answer" });
  text("text", { itemId: "part:two", text: second, phase: "final_answer" });
  text("text", { itemId: "part:final", text: "已完成。", phase: "final_answer" });
  const executor = new GroupNativeExecutor({ chatSessionStore: { getSession: () => ({ profileId: "p", id: "s" }) },
    transcriptStore: { listEvents: () => transcript } });
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: "已完成。",
    replyMessages: executor.replyMessages({ id: "run", sourceId: "s", profileId: "p" }) });
  f.reopen();
  const rows = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(rows.map(item => item.body), [first, second, "已完成。"]);
  assert.deepEqual([rows[0].id, rows[0].seq, rows[0].createdAt], [original.id, original.seq, original.createdAt]);
});

test("one native runtime item can contain several visible segments around tool boundaries", () => {
  const buffer = new ChatUiTextProjection(), activity = new GroupActivityProjection(binding);
  let seq = 0;
  const project = (type, payload) => activity.observeEvents([event(++seq, type, buffer.observe("r", type, payload))], "stream");
  const flush = id => buffer.flush("r", id, payload => {
    activity.observeEvents([event(++seq, "text", { ...payload, phase: "commentary" })], "stream");
    return payload;
  });
  project("text.delta", { itemId: "one-item", delta: "收到。" }); flush("first-tool");
  project("text.delta", { itemId: "one-item", delta: "收到。" }); flush("second-tool");
  project("text", { itemId: "one-item", text: "收到。收到。已完成。", phase: "final_answer" });
  assert.deepEqual(activity.replyMessages().map(item => item.text), ["收到。", "收到。", "已完成。"]);
  assert.equal(new Set(activity.replyMessages().map(item => item.id)).size, 3, "identical wording in distinct segments remains intentional");
});

test("each settled message has its own sequence and survives SQLite reopen and pagination", t => {
  const f = fixture(t), replyMessages = [{ id: "one", text: "先核对配置。", final: false }, { id: "two", text: "已完成。", final: true }];
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: "已完成。", replyMessages });
  const before = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(before.map(item => item.body), ["先核对配置。", "已完成。"]);
  assert.notEqual(before[0].id, before[1].id); assert.ok(before[0].seq < before[1].seq);
  f.reopen();
  const after = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(after, before);
  assert.equal(f.store.listMessages({ groupId: f.groupId, beforeSeq: before[1].seq, limit: 1 }).messages[0].id, before[0].id);
});

test("releasing the speaking slot preserves earlier bubbles without repeating them at final settlement", t => {
  const f = fixture(t), first = { id: "one", text: "先核对配置。", final: false };
  f.store.releaseTurn({ opportunityId: f.opportunityId, fence: f.fence, reason: "working", text: first.text, replyMessages: [first] });
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: "已完成。",
    replyMessages: [first, { id: "two", text: "已完成。", final: true }] });
  const rows = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(rows.map(item => item.body), ["先核对配置。", "已完成。"]);
});

test("a failed run retains already visible messages once, followed by its failure notice", t => {
  const f = fixture(t), replyMessages = [{ id: "one", text: "已经核对第一项，第二项暂时不可用。", pending: false, final: false }];
  const input = { opportunityId: f.opportunityId, fence: f.fence, status: "failed", errorCode: "FIXTURE_FAILURE", replyMessages };
  f.store.completeTurn(input);
  f.store.completeTurn(input);
  const rows = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages;
  assert.equal(rows.filter(item => item.author.kind === "member").length, 1);
  assert.equal(rows.find(item => item.author.kind === "member").body, replyMessages[0].text);
  assert.equal(rows.at(-1).system.eventType, "turn_failed");
});

test("A1, B1, A2 retain separate times and authoritative order while A keeps working", t => {
  const f = fixture(t), first = { id: "a-one", text: "A1：我先检查配置，@b 请检查权限。", pending: false };
  f.advance(); f.sync([{ ...first, text: "A1：我先检查配置。", pending: true }]); f.sync([first]);
  const a1 = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0];
  f.store.releaseTurn({ opportunityId: f.opportunityId, fence: f.fence, reason: "working", text: first.text, replyMessages: [first] });
  const b = f.store.claimNext(f.groupId, f.fence);
  assert.ok(b); assert.notEqual(b.opportunity.memberId, a1.author.memberId);
  f.store.bindSession({ groupId: f.groupId, memberId: b.member.id, sessionKey: "session-b", fence: f.fence });
  f.store.recordRun({ opportunityId: b.opportunity.id, runId: "run-b", sessionKey: "session-b", fence: f.fence });
  f.advance();
  f.store.completeTurn({ opportunityId: b.opportunity.id, fence: f.fence, status: "completed", text: "B1：权限已核对。",
    replyMessages: [{ id: "b-one", text: "B1：权限已核对。", final: true }] });
  f.advance(); const second = { id: "a-two", text: "A2：配置检查", pending: true };
  f.sync([first, second]);
  const before = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(before.map(item => item.body.slice(0, 2)), ["A1", "B1", "A2"]);
  assert.ok(before[0].createdAt < before[1].createdAt && before[1].createdAt < before[2].createdAt);
  f.advance(); f.sync([first, { ...second, text: "A2：配置检查完成。" }]);
  const updated = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0];
  assert.equal(updated.id, before[2].id); assert.equal(updated.seq, before[2].seq); assert.equal(updated.createdAt, before[2].createdAt);
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: updated.body,
    replyMessages: [first, { id: "a-two", text: updated.body, final: true }] });
  f.reopen();
  const saved = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.deepEqual(saved.map(item => [item.id, item.seq, item.createdAt]), before.map(item => [item.id, item.seq, item.createdAt]));
  assert.equal(saved[0].body, a1.body); assert.equal(saved[2].body, "A2：配置检查完成。");
  assert.equal(saved[2].origin.streaming, false); assert.equal(saved[2].origin.partial, false);
});

test("revision pagination refreshes an earlier streaming message without moving or replacing it", t => {
  const f = fixture(t);
  f.sync([{ id: "one", text: "正在检查", pending: true }]);
  const initial = f.store.listMessages({ groupId: f.groupId, limit: 20 });
  const first = initial.messages.at(-1);
  f.advance();
  const later = f.store.appendUserMessage({ groupId: f.groupId, clientMessageId: "later", body: "补充要求", mentionMemberIds: [] }).message;
  f.advance(); f.sync([{ id: "one", text: "正在检查配置", pending: true }]);
  const page = f.store.listMessages({ groupId: f.groupId, afterSeq: later.seq, afterRevision: initial.revision, limit: 1 });
  assert.equal(page.messages.length, 0); assert.equal(page.hasMoreUpdates, true);
  const next = f.store.listMessages({ groupId: f.groupId, afterSeq: later.seq, afterRevision: page.revision, limit: 1 });
  const update = next.updates[0];
  assert.equal(update.id, first.id); assert.equal(update.seq, first.seq); assert.equal(update.createdAt, first.createdAt);
  assert.equal(update.body, "正在检查配置"); assert.ok(next.revision > page.revision);
  f.sync([{ id: "one", text: update.body, pending: false }]);
  const revision = f.store.getGroup(f.groupId).group.messageRevision;
  f.sync([{ id: "one", text: "迟到的另一条内容", pending: true }]);
  assert.equal(f.store.getGroup(f.groupId).group.messageRevision, revision, "a completed bubble cannot revive or be overwritten");
  const wrong = f.store.syncTurnMessages({ opportunityId: f.opportunityId, fence: f.fence + 1, runId: "run", messages: [{ id: "x", text: "wrong" }] });
  assert.equal(wrong.changed, false);
});

test("authoritative completion restores a long earlier message from its bounded streaming preview", t => {
  const f = fixture(t), text = "配置检查详情。".repeat(1800);
  f.sync([{ id: "long-one", text: text.slice(0, 500) + "…", pending: false }]);
  const first = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0];
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: "已完成。",
    replyMessages: [{ id: "long-one", text, final: false }, { id: "final", text: "已完成。", final: true }] });
  const message = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.find(item => item.id === first.id);
  assert.equal(message.body, text); assert.equal(message.seq, first.seq); assert.equal(message.createdAt, first.createdAt);
});

test("verified attachment and quote cleanup finishes the same message without changing its time", t => {
  const f = fixture(t), raw = "回复 #1\n检查完成。\n\n附件：/private/tmp/report.pdf";
  f.sync([{ id: "answer", text: raw, pending: false }]);
  const before = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0]; f.advance();
  f.store.completeTurn({ opportunityId: f.opportunityId, fence: f.fence, status: "completed", text: "检查完成。", replyToSeq: 1,
    attachments: [{ id: "11111111-1111-4111-8111-111111111111", name: "report.pdf", mimeType: "application/pdf", size: 32 }],
    replyMessages: [{ id: "answer", text: raw, final: true }] });
  const rows = f.store.listMessages({ groupId: f.groupId, limit: 20 }).messages.filter(item => item.author.kind === "member");
  assert.equal(rows.length, 1); assert.equal(rows[0].id, before.id); assert.equal(rows[0].createdAt, before.createdAt);
  assert.equal(rows[0].body, "检查完成。"); assert.equal(rows[0].attachments[0].name, "report.pdf");
  assert.equal(rows[0].replyTo.seq, 1);
});
