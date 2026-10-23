"use strict";
// Pure projection boundaries. Native file/IPC and rendered Viewer are tested separately.
const test = require("node:test"), assert = require("node:assert/strict");
const { projectJournalRecovery: project } = require("../app/group-journal-recovery");
const scope = { ownerScope: "owned-authority", groupId: "group-A", snapshotDigest: "a".repeat(64) };
const send = (id, text, extra = {}) => ({ ownerScope: scope.ownerScope, groupId: scope.groupId, clientMessageId: id,
  key: JSON.stringify([scope.ownerScope, scope.groupId, id]), inputSnapshot: { body: text }, ...extra });
const draft = (id, text, extra = {}) => ({ ownerScope: scope.ownerScope, groupId: scope.groupId, draftId: id,
  key: JSON.stringify([scope.ownerScope, scope.groupId, id]), composer: { text }, ...extra });
const state = (sends = [], drafts = []) => ({ version: 1, sends, drafts });
const call = (value, extra = {}) => project(value, { ...scope, ...extra });
const immutable = (value, seen = new Set()) => {
  if (value && typeof value === "object" && !seen.has(value)) { seen.add(value); Object.values(value).forEach(item => immutable(item, seen)); Object.freeze(value); }
  return value;
};

test("recovery never exports another owner or group, including a forged composite key", () => {
  const foreignOwner = send("foreign-owner", "PRIVATE-OWNER", { ownerScope: "different-authority" });
  const foreignGroup = send("foreign-group", "PRIVATE-GROUP", { groupId: "group-B" });
  const rows = state([foreignOwner, foreignGroup, send("visible", "owned text")],
    [draft("foreign-draft", "PRIVATE-DRAFT", { ownerScope: "different-authority" }), draft("owned-draft", "owned draft")]);
  const result = call(rows); assert.deepEqual(result.items.map(item => item.text), ["owned text", "owned draft"]);
  assert(!JSON.stringify(result).includes("PRIVATE"));
});

test("damaged keys and missing bodies are skipped without blocking the next readable input", () => {
  const rows = state([send("wrong-key", "bad", { key: "not-the-same-identity" }), send("missing", "bad", { inputSnapshot: {} }), null,
    send("valid", "recoverable")]);
  const result = call(rows); assert.equal(result.skipped, 3); assert.deepEqual(result.items.map(item => item.text), ["recoverable"]);
});

test("recovered text grants no payload, operation identity or attachment capability", () => {
  const row = send("old-client-id", "manual review text", {
    payloadDigest: "b".repeat(64), acceptedMessageId: "old-message", discussionId: "other-request", phase: "submitting",
    attachmentRefs: ["capability-token"], inputSnapshot: { body: "manual review text", requestMode: "replace", discussionId: "old-request",
      clientMessageId: "another-id", attachments: [{ id: "secret-attachment-id", path: "/private/owned-file", name: "review.txt", token: "capability-token" }] }
  });
  const result = call(state([row]));
  assert.equal(result.readOnly, true); assert.equal(result.items[0].unverified, true);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ["attachmentNames", "id", "kind", "text", "truncated", "unverified"]);
  assert.deepEqual(result.items[0].attachmentNames, ["review.txt"]);
  for (const forbidden of ["secret-attachment-id", "capability-token", "/private/owned-file", "payloadDigest", "acceptedMessageId", "inputSnapshot", "requestMode"])
    assert(!JSON.stringify(result).includes(forbidden), forbidden);
});

test("draft recovery also exposes only text and human-readable file names", () => {
  const result = call(state([], [draft("draft-A", "draft text", { composer: { text: "draft text", newRequest: false,
    requestRef: { id: "old-request", mode: "replace" }, files: [{ id: "attachment-cap", name: "draft.csv", attachment: { id: "media-cap" } }] } })]));
  assert.deepEqual(result.items[0], { kind: "draft", id: "draft-A", text: "draft text", attachmentNames: ["draft.csv"], truncated: false, unverified: true });
});

test("a page scans at most256 records and a foreign prefix cannot hide a readable later page", () => {
  const prefix = Array.from({ length: 256 }, (_, i) => send("foreign-"+i, "outside", { ownerScope: "foreign" }));
  const source = state([...prefix, send("after-prefix", "owned later input")]);
  const first = call(source); assert.deepEqual(first.items, []); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 256);
  const second = call(source, { offset: first.nextOffset }); assert.deepEqual(second.items.map(row => row.text), ["owned later input"]);
  assert.equal(second.hasMore, false); assert.equal(second.nextOffset, null); assert.equal(first.snapshotDigest, second.snapshotDigest);
});

test("twenty-item pages progress deterministically from sends into drafts", () => {
  const source = state(Array.from({ length: 25 }, (_, i) => send("send-"+i, "send "+i)), [draft("draft-1", "draft one")]);
  const first = call(source); assert.equal(first.items.length, 20); assert.equal(first.nextOffset, 20);
  const second = call(source, { offset: first.nextOffset }); assert.equal(second.items.length, 6); assert.equal(second.items.at(-1).kind, "draft");
  assert.equal(second.nextOffset, null); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 26);
});

test("bounded collections explicitly report truncation instead of claiming complete recovery", () => {
  const result = call(state(Array.from({ length: 1001 }, (_, i) => send("send-"+i, "text")),
    Array.from({ length: 257 }, (_, i) => draft("draft-"+i, "text"))));
  assert.equal(result.collectionTruncated, true); assert.equal(result.items.length, 20); assert.equal(result.hasMore, true);
});

test("UTF8 text truncation preserves complete codepoints and the following row", () => {
  const text = "a".repeat(32767) + "😀" + "tail";
  const result = call(state([send("large", text), send("next", "next readable text")]));
  assert.equal(result.items[0].truncated, true); assert.equal(Buffer.byteLength(result.items[0].text), 32767);
  assert(!result.items[0].text.includes("�")); assert.equal(result.items[1].text, "next readable text");
  assert.equal(text.endsWith("tail"), true, "the original input is not modified");
});

test("NUL and lone surrogate text are omitted while legitimate emoji remains readable", () => {
  const result = call(state([send("nul", "bad\0text"), send("surrogate", "\ud800"), send("emoji", "合法😀") ]));
  assert.equal(result.skipped, 2); assert.deepEqual(result.items.map(item => item.text), ["合法😀"]);
});

test("accessor fields are never executed and do not block a later data row", () => {
  let accessed = 0; const bad = send("getter", "unused");
  Object.defineProperty(bad.inputSnapshot, "body", { enumerable: true, get() { accessed++; throw Error("must not execute"); } });
  const badFile = {}; Object.defineProperty(badFile, "name", { enumerable: true, get() { accessed++; throw Error("must not execute"); } });
  const result = call(state([bad, send("ok", "still readable", { inputSnapshot: { body: "still readable", attachments: [badFile] } })]));
  assert.equal(accessed, 0); assert.equal(result.skipped, 1); assert.equal(result.items[0].text, "still readable");
  assert.deepEqual(result.items[0].attachmentNames, []);
});

test("cyclic unrelated damaged fields do not obstruct projection or mutate the source", () => {
  const row = send("cycle", "readable despite unrelated damaged field"); row.self = row; row.inputSnapshot.replyTo = row;
  const source = immutable(state([row, send("second", "second text")]));
  const result = call(source); assert.equal(result.items.length, 2); assert.equal(source.sends[0].self, source.sends[0]);
  assert.equal(result.items[0].text, "readable despite unrelated damaged field");
});

test("attachment names remain bounded and invalid names cannot smuggle extra capabilities", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ name: i === 1 ? "bad\0name" : i === 2 ? "x".repeat(513) : "file-"+i, id: "cap-"+i }));
  const result = call(state([send("files", "text", { inputSnapshot: { body: "text", attachments: files } })]));
  assert.deepEqual(result.items[0].attachmentNames, ["file-0", "file-3", "file-4", "file-5", "file-6", "file-7"]);
});

test("unsupported or unreadable envelopes fail without claiming generic JSON repair", () => {
  for (const source of [null, {}, { version: 2, sends: [], drafts: [] }, { version: 1, sends: [], drafts: null }])
    assert.throws(() => call(source), { code: "GROUP_JOURNAL_RECOVERY_UNAVAILABLE" });
});

test("invalid scope or cursor inputs fail with a static recovery diagnostic", () => {
  for (const input of [{ ownerScope: "" }, { groupId: "bad\0id" }, { offset: -1 }, { offset: 1257 }, { offset: 0.5 }, { snapshotDigest: "not-a-digest" }])
    assert.throws(() => call(state(), input), { code: "GROUP_JOURNAL_RECOVERY_UNAVAILABLE" });
});
