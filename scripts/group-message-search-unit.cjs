"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createFixture: makeFixture } = require("./fixtures/group-store-fixture.cjs");
const createFixture = t => makeFixture(t);
const { searchGroupMessages } = require("../app/agent-service/group-message-search");
const { validateParams, validateResult } = require("../app/agent-service/group-chat-protocol");
const { sha256 } = require("../app/group-result-content");
const query = (f, extra = {}) => ({ groupId: f.groupId, query: "needle", authorKind: null, memberId: null, discussionId: null, cursor: null, limit: 20, ...extra });
function insert(f, seq, body, { full = true, groupId = f.groupId, author = { kind: "member", memberId: f.roster[0].id }, origin } = {}) {
  const message = { id: `search-${groupId}-${seq}`, groupId, seq, threadId: "main", author, body: full ? body.slice(0, 100) : body,
    createdAt: 1000 + seq, mentions: { memberIds: [], broadcast: false, unresolved: [] }, ...(origin ? { origin } : {}),
    ...(full ? { fullResult: { digest: sha256(body), bytes: Buffer.byteLength(body) } } : {}) };
  f.store.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(message.id, groupId, seq, message.id, JSON.stringify(message));
  if (full) f.store.db.prepare("INSERT INTO message_results VALUES(?,?,?,?)").run(message.id, body, sha256(body), Buffer.byteLength(body));
  return message;
}
const search = (f, extra) => validateResult("group.search", searchGroupMessages(f.store, validateParams("group.search", query(f, extra))), query(f, extra));

test("saved long text tail, Unicode snippets, literal wildcard, public-only results and fixed digest reads", t => {
  const f = createFixture(t), body = "开头😀".repeat(10000) + " NEEDLE 后文 100%_ ";
  const message = insert(f, 1, body); insert(f, 2, "needle secret", { author: { kind: "system" } });
  const result = search(f); assert.equal(result.hits.length, 1); const hit = result.hits[0];
  assert.match(hit.snippet, /NEEDLE/); assert.ok([...hit.snippet].length <= 320); assert.ok(hit.snippetOffset > 1000);
  assert.equal(hit.message.fullResult.digest, sha256(body)); assert.equal(hit.partial, false);
  assert.equal(f.store.readMessage({ groupId: f.groupId, seq: message.seq, digest: hit.message.fullResult.digest }).page.digest, sha256(body));
  assert.equal(search(f, { query: "%_" }).hits.length, 1); assert.equal(search(f, { query: "never%" }).hits.length, 0);
});
test("cursor pins upper seq across new messages; no duplicates or omissions; query/filter/group tampering fails", t => {
  const f = createFixture(t); for (let seq = 1; seq <= 6; seq++) insert(f, seq, `needle ${seq}`);
  const first = search(f, { limit: 2 }); assert.deepEqual(first.hits.map(h => h.message.seq), [6, 5]);
  insert(f, 7, "needle newer"); const second = search(f, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.upperSeq, 6); assert.deepEqual(second.hits.map(h => h.message.seq), [4, 3]);
  const third = search(f, { limit: 2, cursor: second.nextCursor }); assert.deepEqual(third.hits.map(h => h.message.seq), [2, 1]); assert.equal(third.nextCursor, null);
  assert.equal(search(f).upperSeq, 7);
  for (const extra of [{ query: "other" }, { authorKind: "user" }, { limit: 3 }, { cursor: first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith('a') ? 'b' : 'a') }]) {
    assert.throws(() => search(f, { limit: 2, cursor: first.nextCursor, ...extra }), { code: "GROUP_CHAT_RESPONSE_EXPIRED" });
  }
  const other = f.store.createGroup({ operationId: "other", name: "other", purpose: "", members: f.roster.map(m => ({ backendId: m.backendId, agentId: m.agentId, profileId: m.profileId, displayName: m.displayName })) }).groupId;
  insert(f, 1, "needle other group", { groupId: other });
  assert.throws(() => search(f, { groupId: other, limit: 2, cursor: first.nextCursor }), { code: "GROUP_CHAT_RESPONSE_EXPIRED" });
  assert.equal(search(f, { groupId: other }).hits[0].snippet, "needle other group");
});
test("exact discussion ownership, root input and author filters; foreign members/requests rejected", t => {
  const f = createFixture(t); const sent = f.send("needle root"); const own = sent.discussionId;
  insert(f, 2, "needle reply", { origin: { discussionId: own } });
  insert(f, 3, "needle another discussion", { origin: { discussionId: "different" } });
  assert.deepEqual(search(f, { discussionId: own }).hits.map(h => h.message.seq), [2, 1]);
  assert.deepEqual(search(f, { authorKind: "user" }).hits.map(h => h.message.seq), [1]);
  assert.equal(search(f, { authorKind: "member", memberId: f.roster[1].id }).hits.length, 0);
  assert.throws(() => search(f, { discussionId: "foreign-request" }), { code: "GROUP_CHAT_REQUEST_NOT_FOUND" });
  assert.throws(() => search(f, { authorKind: "member", memberId: "foreign-member" }), { code: "GROUP_CHAT_MEMBER_NOT_FOUND" });
});
test("missing old full text is partial even when only a saved excerpt can match", t => {
  const f = createFixture(t); insert(f, 1, "needle saved old excerpt", { full: false }); insert(f, 2, "user exact", { full: false, author: { kind: "user" } });
  const result = search(f); assert.equal(result.partial, true); assert.equal(result.hits[0].partial, true);
  assert.equal(result.hits[0].message.fullResult.digest, sha256("needle saved old excerpt"));
  assert.equal(search(f, { query: "missing tail" }).partial, true);
  assert.equal(search(f, { query: "user", authorKind: "user" }).partial, false);
});
test("bounded legacy scans can continue through empty pages to older matches", t => {
  const f = createFixture(t); insert(f, 1, "needle oldest");
  f.store.db.exec("BEGIN"); for (let seq = 2; seq <= 502; seq++) insert(f, seq, "unrelated legacy", { full: false }); f.store.db.exec("COMMIT");
  const first = search(f); assert.equal(first.hits.length, 0); assert.equal(first.hasMore, true);
  const second = search(f, { cursor: first.nextCursor }); assert.equal(second.hits.length, 1); assert.equal(second.hits[0].message.seq, 1); assert.equal(second.hasMore, false);
});
test("cursor expires and cannot survive a new Store authority; archived reads remain available", t => {
  const f = createFixture(t); insert(f, 1, "needle"); insert(f, 2, "needle"); const first = search(f, { limit: 1 });
  f.advance(30 * 60 * 1000 + 1); assert.throws(() => search(f, { limit: 1, cursor: first.nextCursor }), { code: "GROUP_CHAT_RESPONSE_EXPIRED" });
  const next = search(f, { limit: 1 }); f.reopen(); assert.throws(() => search(f, { limit: 1, cursor: next.nextCursor }), { code: "GROUP_CHAT_RESPONSE_EXPIRED" });
  const group = f.view().group; f.store.updateGroup({ groupId: f.groupId, expectedMetadataRevision: group.metadataRevision, patch: { status: "archived" } });
  assert.equal(search(f).hits.length, 2);
});
test("strict input/result boundary rejects scope injection, oversized pages and private authors", t => {
  const f = createFixture(t);
  for (const extra of [{ query: " " }, { query: "x".repeat(201) }, { query: "\0" }, { limit: 21 }, { limit: 0 }, { authorKind: "system" }, { authorKind: "user", memberId: "m" }, { cursor: "malformed" }, { privateSession: "s" }]) {
    assert.throws(() => validateParams("group.search", query(f, extra)), { code: "GROUP_CHAT_INVALID" });
  }
  insert(f, 1, "needle"); const result = search(f);
  assert.throws(() => validateResult("group.search", { ...result, groupId: "other" }, query(f)), { code: "GROUP_CHAT_UNAVAILABLE" });
  assert.throws(() => validateResult("group.search", { ...result, hits: [{ ...result.hits[0], message: { ...result.hits[0].message, author: { kind: "system" } } }] }, query(f)), { code: "GROUP_CHAT_UNAVAILABLE" });
});
test("Backend contract, owner Registry, RPC service and read-only configuration boundary", async t => {
  const f = createFixture(t); insert(f, 1, "needle");
  const { AgentBackend } = require("../app/core/agent-backend");
  const { ShoggothBackend } = require("../app/core/shoggoth-backend");
  const { BackendRegistry } = require("../app/core/backend-registry");
  await assert.rejects(() => AgentBackend.prototype.searchGroupChatMessages.call({ id: "external" }, f.groupId, {}), { code: "GROUP_CHAT_UNAVAILABLE" });
  const backend = Object.create(ShoggothBackend.prototype); let calls = 0;
  backend._call = (method, input) => { assert.equal(method, "group.search"); calls++; return f.service.handle(method, input); };
  const registry = Object.create(BackendRegistry.prototype); registry._requireGroupChatOwner = () => backend;
  const result = await registry.searchGroupChatMessages(f.groupId, { query: "needle" });
  assert.equal(result.hits.length, 1); assert.equal(calls, 1);
});

test("search carries the authoritative quote into saved-body reads without changing raw text or digest", t => {
  const f = createFixture(t);
  const quoted = insert(f, 1, "用户的问题", { author: { kind: "user" } });
  const body = "回复 #1\nneedle 具体建议，正文中保留 #11。";
  const answer = insert(f, 2, body);
  const replyTo = { seq: quoted.seq, messageId: quoted.id, author: quoted.author, excerpt: quoted.body };
  f.store.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify({ ...answer, replyTo }), answer.id);
  const before = f.store.db.prepare("SELECT body,digest,bytes FROM message_results WHERE message_id=?").get(answer.id);
  const hit = search(f).hits[0];
  assert.deepEqual(hit.message.replyTo, replyTo);
  assert.equal(hit.snippetOffset, 0); assert.equal(hit.snippet, body);
  assert.equal(hit.message.fullResult.digest, sha256(body));
  assert.equal(f.store.readMessage({ groupId: f.groupId, seq: answer.seq, digest: hit.message.fullResult.digest }).page.text, body);
  assert.deepEqual(f.store.db.prepare("SELECT body,digest,bytes FROM message_results WHERE message_id=?").get(answer.id), before);
});
