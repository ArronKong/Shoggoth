#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ChatUiStore } = require("../app/agent-service/chat-ui-store");
const c = require("../app/agent-service/chat-ui-contract");
const owner = { profileId: "profile", transcriptSessionId: "transcript", sessionKey: "session" };
const declaration = () => ({ sourceFile: "ui.html", title: "方案选择", summary: "选择方案后继续分析", stateSchemaVersion: 1,
  stateSchema: { type: "object", properties: { selected: { type: "string", enum: ["A", "B", "C"] } }, required: ["selected"], additionalProperties: false },
  initialState: { selected: "A" }, actions: [{ actionId: "continue", kind: "continue_agent", label: "继续分析", instruction: "分析当前方案", stateFields: ["selected"] }] });
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-store-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile"), trustedRoot: root });
  let store;
  const open = extra => { store = new ChatUiStore({ paths, ...options, ...extra }); store.open(); return store; };
  const close = () => { store?.close(); };
  const remove = () => { close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, paths, open, close, remove };
}
const publication = (store, callId = "publish", extra = {}) => store.preparePublication({ owner, callId, fingerprint: c.hash(callId), tool: "render_ui",
  declaration: declaration(), html: "<!doctype html><h1>原始页面</h1>", creatorRunId: "run", creatorAttemptId: "attempt", provenance: {}, ...extra });
function ready(store, callId = "publish", extra = {}) { const pub = publication(store, callId, extra); return store.markPublicationReady(owner, pub.publicationId, 1); }
test("immutable publication, exact replay and independent revision state survive restart", () => {
  const f = fixture(); try {
    let store = f.open(), rev = ready(store); const original = store.part(rev);
    store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" });
    const p2 = publication(store, "update", { tool: "update_ui", declaration: { ...declaration(), artifactId: rev.artifactId, expectedRevision: 1, updateNote: "增加选项" }, html: "<h1>第二版</h1>" });
    const v2 = store.markPublicationReady(owner, p2.publicationId, 2);
    assert.notEqual(v2.sourceEventId, rev.sourceEventId); assert.equal(v2.state.selected, "A");
    f.close(); store = f.open(); rev = store.revision(owner, rev.artifactId, 1, original.sourceEventId);
    assert.equal(rev.state.selected, "B"); assert.equal(rev.headRevision, 2);
    const replay = publication(store, "publish", { html: "<h1>源文件已被改写</h1>" });
    assert.equal(replay.artifactId, rev.artifactId); assert.equal(replay.htmlHash, rev.htmlHash);
    assert.equal(Buffer.from(store.readObject(owner, rev).data, "base64").toString(), "<!doctype html><h1>原始页面</h1>");
    assert.throws(()=>publication(store, "publish", { fingerprint: c.hash("changed") }), { code: "UI_OPERATION_CONFLICT" });
    assert.equal(Buffer.byteLength(JSON.stringify(original)) < c.LIMITS.reference, true);
  } finally { f.remove(); }
});
test("CAS rejects a second window without replacing confirmed state", () => {
  const f = fixture(); try { const store = f.open(), rev = ready(store);
    store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" });
    assert.throws(()=>store.saveState(owner, rev.artifactId, 1, 0, { selected: "C" }), error => error.code === "UI_STATE_CONFLICT" && error.state.state.selected === "B");
    assert.equal(store.revision(owner, rev.artifactId, 1).stateRevision, 1);
    assert.throws(()=>store.saveState(owner, rev.artifactId, 1, 1, { selected: "unknown" }), { code: "UI_STATE_INVALID" });
    assert.equal(store.revision(owner, rev.artifactId, 1).state.selected, "B");
  } finally { f.remove(); }
});
test("frozen operation snapshot, same-ID conflict and receipts survive a crash", () => {
  const f = fixture(); try { let store = f.open(), rev = ready(store);
    const op = { actionRequestId: "request", operationId: "operation", artifactId: rev.artifactId, revision: 1, sourceEventId: rev.sourceEventId,
      actionId: "continue", action: declaration().actions[0], baseStateRevision: 0, snapshot: { selected: "A" }, fingerprint: c.hash("action"), createdAt: Date.now(),
      sendEnvelope: { operationId: "operation", sessionKey: owner.sessionKey, prompt: "分析当前方案：A" } };
    op.sendFingerprint = c.hash(op.sendEnvelope);
    store.prepareOperation(owner, op); store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" });
    assert.deepEqual(store.prepareOperation(owner, op).snapshot, { selected: "A" });
    assert.throws(()=>store.prepareOperation(owner, { ...op, fingerprint: c.hash("changed") }), { code: "UI_OPERATION_CONFLICT" });
    f.close(); store = f.open(); assert.equal(store.getOperation(owner, { actionRequestId: "request" }).snapshot.selected, "A");
    store.receipt(owner, "request", "accepted", { runId: "same-run", status: "queued", disposition: "queued", reason: "CHAT_SESSION_BUSY" });
    f.close(); store = f.open(); assert.equal(store.getOperation(owner, { operationId: "operation" }).receipt.runId, "same-run");
    assert.throws(()=>store.getOperation({ ...owner, sessionKey: "other" }, { actionRequestId: "request" }), { code: "UI_SCOPE_MISMATCH" });
  } finally { f.remove(); }
});
test("durable journal with a missing checkpoint recovers the exact ready publication", () => {
  let crash = false;
  const f = fixture({ fault: (at, detail) => { if (crash && at === "afterJournal" && detail.type === "publication.ready") throw Error("simulated manifest crash"); } });
  try { let store = f.open(); const pub = publication(store); crash = true;
    assert.throws(()=>store.markPublicationReady(owner, pub.publicationId, 9), { code: "UI_COMMIT_UNCERTAIN" });
    assert.throws(()=>store.revision(owner, pub.artifactId, 1), { code: "UI_COMMIT_UNCERTAIN" });
    f.close(); crash = false; store = f.open(); const rev = store.revision(owner, pub.artifactId, 1);
    assert.equal(rev.status, "ready"); assert.equal(rev.transcriptSeq, 9); assert.equal(rev.sourceEventId, pub.sourceEventId);
    assert.equal(publication(store).publicationId, pub.publicationId);
  } finally { f.remove(); }
});
test("short write cannot acknowledge state; restart repairs only the incomplete tail", () => {
  const fdPaths = new Map(); let broken = false, wrote = false;
  const injected = Object.create(fs);
  injected.openSync = (...args) => { const fd = fs.openSync(...args); fdPaths.set(fd, args[0]); return fd; };
  injected.closeSync = fd => { fdPaths.delete(fd); return fs.closeSync(fd); };
  injected.writeSync = (fd, bytes, offset, length, position) => {
    if (broken && String(fdPaths.get(fd)).endsWith("journal.jsonl")) { if (wrote) return 0; wrote = true; return fs.writeSync(fd, bytes, offset, Math.min(20, length), position); }
    return fs.writeSync(fd, bytes, offset, length, position);
  };
  const f = fixture({ fs: injected }); try { let store = f.open(), rev = ready(store); broken = true;
    assert.throws(()=>store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" }), { code: "UI_COMMIT_UNCERTAIN" });
    f.close(); broken = false; store = f.open(); const restored = store.revision(owner, rev.artifactId, 1);
    assert.equal(restored.stateRevision, 0); assert.equal(restored.state.selected, "A");
  } finally { f.remove(); }
});
test("ENOSPC and hard capacity preserve already referenced objects and values", () => {
  let diskFull = false;
  const f = fixture({ fault: at => { if (diskFull && at === "beforeJournal") throw Object.assign(Error("full"), { code: "ENOSPC" }); } });
  try { const store = f.open(), rev = ready(store); diskFull = true;
    assert.throws(()=>store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" }), { code: "UI_STORAGE_FAILED" });
    assert.equal(store.revision(owner, rev.artifactId, 1).state.selected, "A"); diskFull = false;
    store.limits.profileHard = store.usage(owner.profileId);
    assert.throws(()=>publication(store, "too-much", { html: "<h1>large new content</h1>" }), { code: "UI_STORAGE_CAPACITY" });
    assert.equal(store.readObject(owner, rev).done, true);
  } finally { f.remove(); }
});
test("writer exclusion, symlinks, object corruption and replaced journal fail closed", () => {
  const f = fixture(); try { let store = f.open(), rev = ready(store);
    const competitor = new ChatUiStore({ paths: f.paths }); assert.throws(()=>competitor.open(), { code: "WRITER_LEASE_HELD" });
    const obj = path.join(f.paths.agentsDir, owner.profileId, "chat-ui", "objects", rev.htmlHash + ".html");
    fs.writeFileSync(obj, "corrupt"); assert.throws(()=>store.readObject(owner, rev), { code: "UI_STORAGE_CORRUPT" });
    const journal = path.join(f.paths.agentsDir, owner.profileId, "chat-ui", owner.transcriptSessionId, "journal.jsonl");
    fs.appendFileSync(journal, "{}"); assert.throws(()=>store.revision(owner, rev.artifactId, 1), { code: "UI_STORAGE_CORRUPT" });
    f.close(); fs.unlinkSync(obj); fs.symlinkSync(path.join(f.root, "escape"), obj); store = f.open();
    assert.throws(()=>store.readObject(owner, store.revision(owner, rev.artifactId, 1)), { code: "UNSAFE_SYMLINK" });
  } finally { f.remove(); }
});
test("epoch invalidation and revocation wipe execution payloads but retain identity", () => {
  const f = fixture(); try { const store = f.open(), rev = ready(store);
    store.invalidate(owner, "reset"); assert.throws(()=>store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" }), { code: "UI_SOURCE_EXPIRED" });
    assert.equal(store.revision(owner, rev.artifactId, 1).sourceEventId, rev.sourceEventId);
    store.revokeRevision(owner, rev.artifactId, 1); const revoked = store.revision(owner, rev.artifactId, 1);
    assert.equal(revoked.status, "revoked"); assert.deepEqual(revoked.state, {}); assert.deepEqual(revoked.declaration.actions, []);
    store.limits.profileSoft = 0; store.collectUnreferenced(owner.profileId);
    assert.equal(fs.existsSync(path.join(f.paths.agentsDir, owner.profileId, "chat-ui", "objects", rev.htmlHash + ".html")), false);
  } finally { f.remove(); }
});

test("checkpoint compaction bounds state history without changing sources, confirmed values or operation receipts", () => {
  const f = fixture(); try { let store = f.open();
    const decl = declaration(); decl.stateSchema.properties.note = { type: "string", maxLength: 24000 }; decl.initialState.note = "";
    for (const key of ["stableOne", "stableTwo"]) { decl.stateSchema.properties[key] = { type: "string", maxLength: 8000 }; decl.initialState[key] = "x".repeat(7000); }
    const rev = ready(store, "large", { declaration: decl });
    for (let index = 0; index < 210; index++) store.saveState(owner, rev.artifactId, 1, index, { note: String(index).padEnd(7000, "z") });
    const before = store.revision(owner, rev.artifactId, 1), compacted = store.compact(owner);
    assert.ok(compacted.afterBytes < 70000, JSON.stringify(compacted));
    const journal = path.join(f.paths.agentsDir, owner.profileId, "chat-ui", owner.transcriptSessionId, "journal.jsonl");
    assert.equal(JSON.parse(fs.readFileSync(journal, "utf8").split("\n")[0]).type, "checkpoint.begin");
    const op = { actionRequestId: "checkpoint-request", operationId: "checkpoint-operation", artifactId: rev.artifactId, revision: 1,
      sourceEventId: rev.sourceEventId, actionId: "continue", action: decl.actions[0], baseStateRevision: 210, snapshot: before.state,
      fingerprint: c.hash("snapshot"), createdAt: Date.now(), sendEnvelope: { operationId: "checkpoint-operation", sessionKey: owner.sessionKey, prompt: "点击已确认" } };
    op.sendFingerprint = c.hash(op.sendEnvelope); store.prepareOperation(owner, op);
    store.receipt(owner, op.actionRequestId, "accepted", { runId: "checkpoint-run", status: "queued", disposition: "queued", reason: "CHAT_SESSION_BUSY" });
    const receipt = store.getOperation(owner, { actionRequestId: op.actionRequestId }); store.compact(owner);
    f.close(); store = f.open(); assert.deepEqual(store.revision(owner, rev.artifactId, 1), before);
    assert.deepEqual(store.getOperation(owner, { operationId: op.operationId }), receipt);
    assert.equal(publication(store, "large", { declaration: decl }).sourceEventId, rev.sourceEventId);
  } finally { f.remove(); }
});
test("compaction crash before or after its manifest preserves the same durable card and state", () => {
  for (const cut of ["beforeCompactJournal", "afterCompactJournal", "afterCompactCommit"]) {
    let armed = false;
    const f = fixture({ fault: at => { if (armed && at === cut) throw Object.assign(Error("cut"), { code: "EIO" }); } });
    try { let store = f.open(); const rev = ready(store); store.saveState(owner, rev.artifactId, 1, 0, { selected: "B" });
      const before = store.revision(owner, rev.artifactId, 1); armed = true;
      assert.throws(()=>store.compact(owner), { code: cut === "beforeCompactJournal" ? "UI_STORAGE_FAILED" : "UI_COMMIT_UNCERTAIN" });
      f.close(); armed = false; store = f.open(); assert.deepEqual(store.revision(owner, rev.artifactId, 1), before);
      store.saveState(owner, rev.artifactId, 1, 1, { selected: "C" }); assert.equal(store.revision(owner, rev.artifactId, 1).stateRevision, 2);
    } finally { f.remove(); }
  }
});
test("revocation removes derived payloads from the compacted journal and only unreferenced HTML objects", () => {
  const f = fixture(); try { let store = f.open();
    const rev = ready(store, "sensitive", { html: "<html>derived-sensitive-marker</html>" });
    const second = ready(store, "same-html-other-source", { html: "<html>derived-sensitive-marker</html>" });
    const update = publication(store, "v2", { tool: "update_ui", declaration: { ...declaration(), artifactId: rev.artifactId,
      expectedRevision: 1, updateNote: "derived-sensitive-marker" }, html: "<html>v2-derived-marker</html>" });
    store.markPublicationReady(owner, update.publicationId, 2); store.revokeRevision(owner, rev.artifactId, 2);
    store.revokeRevision(owner, rev.artifactId, 1);
    const journal = path.join(f.paths.agentsDir, owner.profileId, "chat-ui", owner.transcriptSessionId, "journal.jsonl");
    assert.equal(fs.readFileSync(journal, "utf8").includes("v2-derived-marker"), false);
    assert.equal(store.readObject(owner, second).done, true);
    store.revokeRevision(owner, second.artifactId, 1);
    assert.equal(fs.existsSync(path.join(f.paths.agentsDir, owner.profileId, "chat-ui", "objects", rev.htmlHash + ".html")), false);
    f.close(); store = f.open(); assert.equal(store.revision(owner, rev.artifactId, 2).status, "revoked");
    assert.equal(publication(store, "v2", { tool: "update_ui" }).sourceEventId, update.sourceEventId);
  } finally { f.remove(); }
});
test("a revoked reserved revision is never reused and incomplete compacted facts fail closed", () => {
  const f = fixture(); try { let store = f.open(); const rev = ready(store);
    const args = { ...declaration(), artifactId: rev.artifactId, expectedRevision: 1, updateNote: "new" };
    const pending = publication(store, "pending-v2", { tool: "update_ui", declaration: args }); store.revokeRevision(owner, rev.artifactId, 2);
    const next = publication(store, "next-v3", { tool: "update_ui", declaration: args }); assert.equal(next.revision, 3);
    store.markPublicationReady(owner, next.publicationId, 3); store.compact(owner);
    f.close(); store = f.open(); assert.equal(store.revision(owner, rev.artifactId, 2).sourceEventId, pending.sourceEventId);
    assert.equal(store.revision(owner, rev.artifactId, 3).headRevision, 3); f.close();
    const journal = path.join(f.paths.agentsDir, owner.profileId, "chat-ui", owner.transcriptSessionId, "journal.jsonl");
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n"); fs.writeFileSync(journal, lines.slice(0, -1).join("\n") + "\n");
    assert.throws(()=>f.open(), { code: "UI_STORAGE_CORRUPT" });
  } finally { f.remove(); }
});
