"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupMemberDirectory, exportRoleDocuments } = require("../app/agent-service/group-member-directory");
const { createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");
const { sha256 } = require("../app/group-result-content");

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-role-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  let clock = 1000;
  const now = () => clock;
  const store = new GroupChatStore({ paths, now }).open();
  const definitions = new Map([ ["pa", { manifest: { revision: 1 }, documents: {
    IDENTITY: "# IDENTITY.md\n\n- 角色：公开角色甲", SOUL: "公开协作方式。", USER: "私人偏好", AGENTS: "内部规则" } }],
  ["pb", { manifest: { revision: 1 }, documents: createDefaultDocuments("b") }] ]);
  const oldDefinitions = new Map();
  const directory = new GroupMemberDirectory({ store, now, isRuntimeAvailable: () => true,
    productStore: { getAgentProfile: id => ({ id, name: id, runtime: "codex", enabled: true, defaultModel: "m" }) },
    definitionStore: { get: id => definitions.get(id), readRevision: (id, revision) => oldDefinitions.get(`${id}:${revision}`) },
    ...options });
  const makeGroup = (operationId, external = false) => {
    const { groupId } = store.createGroup({ operationId, name: operationId, purpose: "", members: [
      external ? { backendId: "hermes", agentId: "agent-a", displayName: "甲" }
        : { backendId: "shoggoth", agentId: "a", profileId: "pa", displayName: "甲" },
      { backendId: "shoggoth", agentId: "b", profileId: "pb", displayName: "乙" }] });
    return { groupId, memberId: store.getGroup(groupId).members[0].id };
  };
  t.after(() => { directory.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { paths, store, directory, definitions, oldDefinitions, makeGroup, now, advance: ms => { clock += ms; } };
}

test("public role pages retain their exact UTF-8 snapshot through edits, restart, policy changes and revocation", async t => {
  const f = fixture(t);
  const a = f.makeGroup("a"), b = f.makeGroup("b");
  const doc = f.definitions.get("pa");
  doc.documents.SOUL = "# SOUL.md\n\n" + "公开🙂协作与核验。\n".repeat(6000) + "末尾版本甲\n<!-- 私人注释 -->\napi_key = sk-live-abcdefghijklmnopqrstuvwx1234567890"; // gitleaks:allow -- Synthetic test-only marker
  const exported = exportRoleDocuments({ identity: doc.documents.IDENTITY, soul: doc.documents.SOUL });
  await f.directory.refresh(a.groupId);
  const seenSnapshotId = f.store.getMemberCards(a.groupId).get(a.memberId).roleSnapshotId;
  const first = await f.directory.readRole(a.groupId, a.memberId, { revision: "seen", seenSnapshotId });
  assert.equal(first.ok, true); assert.equal(first.disclosure, "redacted");
  assert.ok(first.nextCursor); assert.ok(Buffer.byteLength(first.text) <= 16 * 1024);
  f.oldDefinitions.set("pa:1", structuredClone(doc));
  doc.manifest.revision = 2; doc.documents.SOUL = "公开新版，末尾版本乙。";
  await f.directory.refresh(a.groupId);
  const latest = await f.directory.readRole(a.groupId, a.memberId, { revision: "latest", seenSnapshotId });
  assert.equal(latest.changedSinceSeen, true); assert.match(latest.text, /版本乙/u);
  assert.deepEqual(await f.directory.readRole(b.groupId, b.memberId, { cursor: first.nextCursor }), { ok: false, code: "invalid_cursor" });
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { cursor: first.nextCursor + "x" }), { ok: false, code: "invalid_cursor" });
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { revision: "seen", cursor: first.nextCursor }),
    { ok: false, code: "invalid_cursor" }, "seen cannot fall back to an arbitrary cursor if no execution snapshot exists");
  const malformed = f.store.roleCursor({ groupId: a.groupId, memberId: a.memberId, id: first.revisionId,
    digest: first.exportDigest, policy: 1, offset: 999999999 });
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { cursor: malformed }), { ok: false, code: "invalid_cursor" });
  f.store.close(); f.store.open();
  let full = first.text, page = first;
  while (page.nextCursor) {
    page = await f.directory.readRole(a.groupId, a.memberId, { revision: "seen", seenSnapshotId, cursor: page.nextCursor });
    assert.equal(page.ok, true); assert.equal(page.offset, Buffer.byteLength(full));
    assert.equal(page.revisionId, first.revisionId); full += page.text;
  }
  assert.equal(full, exported.text); assert.equal(sha256(full), first.exportDigest);
  assert.doesNotMatch(full, /私人|sk-live|内部规则/u); assert.match(full, /末尾版本甲/u);
  const history = await f.directory.history(a.groupId, a.memberId, {});
  assert.deepEqual(history.snapshots.map(item => item.sourceRevision), [2, 1]);
  const c = f.makeGroup("c");
  const old = await f.directory.readRole(c.groupId, c.memberId, { revision: "1" });
  assert.equal(old.ok, true); assert.equal(old.sourceRevision, 1);
  f.directory.disclosurePolicyRevision = 2;
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { cursor: first.nextCursor }), { ok: false, code: "invalid_cursor" });
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { revision: first.revisionId }), { ok: false, code: "revision_unavailable" });
  const policyPage = await f.directory.readRole(a.groupId, a.memberId);
  assert.equal(policyPage.disclosurePolicyRevision, 2);
  f.store.removeMember({ ...a, expectedRosterRevision: f.store.getGroup(a.groupId).group.rosterRevision });
  assert.deepEqual(await f.directory.readRole(a.groupId, a.memberId, { cursor: first.nextCursor }), { ok: false, code: "access_revoked" });
});

test("history pages and external observed versions remain available without inventing unread versions", async t => {
  let source = "外部公开旧版。", connected = true, fileAvailable = true, fileReads = 0;
  const client = { request: async (method, input) => {
    if (!connected) throw new Error("disconnected");
    if (method === "agent.get") return { agent: { name: "外部", model: "m" } };
    if (method === "group.external.capabilities") return { groupTools: true };
    fileReads++; if (!fileAvailable) throw new Error("file temporarily unavailable");
    return { file: { missing: input.file === "IDENTITY.md", content: input.file === "SOUL.md" ? source : "" } };
  } };
  const f = fixture(t, { getFederationClient: () => client });
  const a = f.makeGroup("external", true);
  await f.directory.refresh(a.groupId);
  const old = await f.directory.readRole(a.groupId, a.memberId);
  source = "外部公開新版。";
  const cachedReads = fileReads; await f.directory.refresh(a.groupId);
  assert.equal(fileReads, cachedReads, "normal turn refresh reuses the short external cache");
  f.advance(61_000); await f.directory.refresh(a.groupId);
  const latest = await f.directory.readRole(a.groupId, a.memberId);
  assert.notEqual(latest.revisionId, old.revisionId);
  fileAvailable = false; f.advance(61_000); await f.directory.refresh(a.groupId);
  assert.equal(f.store.getMemberCards(a.groupId).get(a.memberId).freshness, "stale");
  assert.equal(f.store.getMemberCards(a.groupId).get(a.memberId).missing, false, "an unreadable file is not an empty role");
  f.directory.disclosurePolicyRevision = 2;
  await f.directory.refresh(a.groupId);
  assert.equal(f.store.getMemberCards(a.groupId).get(a.memberId).role, null, "a stricter policy cannot retain the old summary during an outage");
  f.directory.disclosurePolicyRevision = 1;
  connected = false;
  assert.equal((await f.directory.readRole(a.groupId, a.memberId)).code, "source_unavailable");
  assert.equal((await f.directory.readRole(a.groupId, a.memberId, { revision: old.revisionId })).text, old.text);
  assert.equal((await f.directory.readRole(a.groupId, a.memberId, { revision: "7" })).code, "revision_unavailable");
  const native = f.makeGroup("history");
  for (let n = 1; n <= 26; n++) {
    f.definitions.get("pa").manifest.revision = n;
    f.definitions.get("pa").documents.SOUL = `公开版本 ${n}。`;
    await f.directory.refresh(native.groupId);
  }
  const first = await f.directory.history(native.groupId, native.memberId, { limit: 10 });
  const second = await f.directory.history(native.groupId, native.memberId, { limit: 10, before: first.nextCursor });
  const third = await f.directory.history(native.groupId, native.memberId, { limit: 10, before: second.nextCursor });
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, true); assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.snapshots, ...second.snapshots, ...third.snapshots].map(item => item.id)).size, 26);
});
