"use strict";
// Real SQLite; no driver, Provider or user data. Quotes carry only media metadata.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");

const image = { id: "11111111-1111-4111-8111-111111111111", name: "坡道.png", mimeType: "image/png", size: 128 };
const file = { id: "22222222-2222-4222-8222-222222222222", name: "说明.pdf", mimeType: "application/pdf", size: 256 };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-quotes-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let store, count = 0;
  t.after(() => { store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store = new GroupChatStore({ paths }).open();
  const create = operationId => store.createGroup({ operationId, name: "引用图片", purpose: "",
    members: ["a", "b"].map(id => ({ backendId: "shoggoth", agentId: id, profileId: id, displayName: id })) }).groupId;
  const groupId = create("create");
  return { get store() { return store; }, groupId, create,
    send(body, extra = {}) { return store.appendUserMessage({ groupId, clientMessageId: `c${++count}`, body, mentionMemberIds: [], ...extra }).message; },
    reopen() { store.close(); store = new GroupChatStore({ paths }).open(); } };
}

test("user and member quotes snapshot attachment metadata and retain it after restart/pagination", t => {
  const f = fixture(t), original = f.send("", { attachments: [{ ...image, localPath: "/private/input.png" }, file] });
  const reply = f.send("描述这张图", { replyToSeq: original.seq });
  assert.deepEqual(reply.replyTo, { seq: original.seq, messageId: original.id, author: original.author, excerpt: "", attachments: [image, file] });
  const fence = f.store.advanceDriverFence(), turn = f.store.claimNext(f.groupId, fence);
  f.store.bindSession({ groupId: f.groupId, memberId: turn.member.id, sessionKey: "quote-session", fence });
  f.store.recordRun({ opportunityId: turn.opportunity.id, runId: "quote-run", sessionKey: "quote-session", fence });
  f.store.completeTurn({ opportunityId: turn.opportunity.id, fence, status: "completed", text: "一座坡道", replyToSeq: original.seq });
  const memberReply = f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0];
  assert.equal(memberReply.author.kind, "member");
  assert.deepEqual(memberReply.replyTo.attachments, [image, file]);
  f.reopen();
  const page = f.store.listMessages({ groupId: f.groupId, limit: 1 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages[0].replyTo.attachments, [image, file], "source need not be in the page");
  assert.equal(page.messages[0].attachments, undefined, "quoted media is separate from newly sent attachments");
});

test("existing text-only quote snapshots acquire source metadata on read without rewriting history", t => {
  const f = fixture(t), original = f.send("", { attachments: [image] });
  const reply = f.send("描述这张图", { replyToSeq: original.seq });
  const saved = JSON.parse(f.store.db.prepare("SELECT data FROM messages WHERE id=?").get(reply.id).data);
  delete saved.replyTo.attachments;
  const legacy = JSON.stringify(saved);
  f.store.db.prepare("UPDATE messages SET data=? WHERE id=?").run(legacy, reply.id);
  const page = f.store.listMessages({ groupId: f.groupId, afterSeq: original.seq, limit: 1 });
  assert.deepEqual(page.messages[0].replyTo.attachments, [image]);
  assert.equal(f.store.db.prepare("SELECT data FROM messages WHERE id=?").get(reply.id).data, legacy);
  f.reopen();
  assert.deepEqual(f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0].replyTo.attachments, [image]);
});

test("quote hydration requires the same group, source ID and sequence; plain text stays unchanged", t => {
  const f = fixture(t), text = f.send("普通文字"), reply = f.send("继续", { replyToSeq: text.seq });
  assert.deepEqual(reply.replyTo, { seq: text.seq, messageId: text.id, author: text.author, excerpt: "普通文字" });
  const otherId = f.create("other"), foreign = f.store.appendUserMessage({ groupId: otherId, clientMessageId: "foreign", body: "", mentionMemberIds: [], attachments: [image] }).message;
  const saved = JSON.parse(f.store.db.prepare("SELECT data FROM messages WHERE id=?").get(reply.id).data);
  saved.replyTo.messageId = foreign.id;
  f.store.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(saved), reply.id);
  assert.equal(f.store.listMessages({ groupId: f.groupId, limit: 1 }).messages[0].replyTo.attachments, undefined);
  assert.throws(() => f.send("跨群", { replyToSeq: 999 }), { code: "GROUP_CHAT_REPLY_NOT_FOUND" });
});

test("the desktop journal retains a quoted image across close/reopen without adding it to the send payload", async t => {
  const { DesktopGroupSendJournalStore } = require("../app/desktop-group-send-journal-store");
  const f = fixture(t), original = f.send("", { attachments: [image, file] });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-quote-journal-")));
  fs.chmodSync(root, 0o700);
  let journal;
  t.after(async () => { await journal?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  journal = new DesktopGroupSendJournalStore({ userDataRoot: root }); await journal.open();
  const scope = { ownerScope: f.store.getOwnerScope(), groupId: f.groupId };
  const composer = { text: "描述这张图", mentionIds: [], replyTo: {
    id: original.id, groupId: original.groupId, seq: original.seq, threadId: original.threadId, author: original.author,
    body: original.body, mentions: original.mentions, createdAt: original.createdAt, attachments: original.attachments,
  }, replyTask: null, requestRef: null, newRequest: false, summaryMemberId: "", files: [] };
  const draft = await journal.saveComposer({ ...scope, draftId: "quote", revision: 1, composer, expectedStorageRevision: 0 });
  const inputSnapshot = { clientMessageId: "quote-send", ownerScope: scope.ownerScope, body: composer.text, mentions: [], replyTo: original.seq, attachments: [] };
  const record = await journal.prepare({ ...scope, inputSnapshot, draft });
  assert.deepEqual(record.composerSnapshot.replyTo.attachments, [image, file]);
  assert.deepEqual(record.attachmentRefs, []);
  await journal.close(); journal = new DesktopGroupSendJournalStore({ userDataRoot: root }); await journal.open();
  const restored = await journal.read(scope);
  assert.deepEqual(restored.draft.composer.replyTo.attachments, [image, file]);
  assert.deepEqual(restored.sends[0].inputSnapshot, inputSnapshot);
});
