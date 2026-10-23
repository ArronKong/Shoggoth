"use strict";

// Original-plan §358: an explicit stopped-writer backup step, not a startup hook.
// All authority is synthetic and confined to a freshly owned private temp root.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
// 0.8.215 的源码（群库 v9，单一机制改动之前的最后一版）。
const BASELINE = "c2169df4343736c02edb7e3cd096b67d9a144ed6";
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAuthorityBackup, verifyAuthorityBackup } = require("../app/agent-service/authority-backup");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--report", "use --report NEW_JSON_PATH");
const reportPath = args[1] ? path.resolve(args[1]) : null;
if (reportPath) assert.ok(!fs.existsSync(reportPath), "never overwrite an earlier proof");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "group-schema-backup-")));
fs.chmodSync(root, 0o700);
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "authority"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const frozenRoot = path.join(root, "baseline-source"); fs.mkdirSync(frozenRoot, { mode: 0o700 });
let old = null, current = null;
try {
  const topSources = execFileSync("git", ["ls-tree", BASELINE, "app/"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").map(line => line.split("\t")[1]).filter(name => /^app\/[^/]+\.(?:js|json)$/u.test(name));
  const archive = execFileSync("git", ["archive", "--format=tar", BASELINE, "app/agent-service", "app/core", ...topSources], { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", frozenRoot], { input: archive });
  // Only dependency resolution is shared. Every baseline application module is
  // read from the exact archive; no ConfigStore, Service, Runtime or Provider runs.
  fs.symlinkSync(path.join(ROOT, "app", "node_modules"), path.join(frozenRoot, "app", "node_modules"), "dir");
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(frozenRoot, "node_modules"), "dir");
  const oldStorePath = path.join(frozenRoot, "app", "agent-service", "group-chat-store.js");
  const { GroupChatStore: V9Store } = require(oldStorePath);
  old = new V9Store({ paths }).open();
  assert.equal(old.diagnostics().schemaVersion, 9);
  const { groupId } = old.createGroup({ operationId: "owned-create", name: "synthetic upgrade", purpose: "preserve accepted work",
    members: [0, 1].map(index => ({ backendId: "shoggoth", agentId: `synthetic-agent-${index}`,
      profileId: `synthetic-profile-${index}`, displayName: `Synthetic ${index}` })) });
  const roster = old.getGroup(groupId).members;
  const input = { groupId, clientMessageId: "original-v9-operation", body: "synthetic accepted v9 input",
    mentionMemberIds: [roster[0].id] };
  const accepted = old.appendUserMessage(input), fence = old.advanceDriverFence();
  const claim = old.claimNext(groupId, fence); assert.ok(claim); assert.equal(claim.member.id, roster[0].id);
  const runId = "synthetic-original-run", sessionKey = "synthetic-original-session";
  old.bindSession({ groupId, memberId: roster[0].id, sessionKey, fence });
  old.recordRun({ opportunityId: claim.opportunity.id, runId, sessionKey, fence });
  old.markReconciliation({ kind: "turn", id: claim.opportunity.id, fence, reason: "SYNTHETIC_CONNECTION_LOST" });
  const handoff = old.claimNext(groupId, fence);
  if (handoff) { assert.notEqual(handoff.member.id, roster[0].id); old.completeTurn({ opportunityId: handoff.opportunity.id, fence, status: "completed", text: "(pass)" }); }
  assert.equal(old.claimNext(groupId, fence), null);
  const priorOpportunityCount = old.db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE discussion_id=?").get(accepted.discussionId).n;
  const oldMessages = old.listMessages({ groupId, limit: 200 }).messages;
  const originalExecution = old.getOpportunity(claim.opportunity.id);
  assert.equal(originalExecution.recovery.reason, "SYNTHETIC_CONNECTION_LOST");
  assert.throws(() => createAuthorityBackup({ paths, backupId: "pre-group-v10" }), { code: "BACKUP_SERVICE_ACTIVE" });
  old.close(); old = null;
  const database = path.join(paths.stateDir, "group-chats.sqlite"), v9Digest = fileHash(database);
  const backup = createAuthorityBackup({ paths, backupId: "pre-group-v10" });
  const verified = verifyAuthorityBackup({ paths, backupId: "pre-group-v10" });
  assert.equal(verified.manifest.rootDigest, backup.manifest.rootDigest);
  const groupEntry = verified.manifest.entries.find(entry => entry.path === "group-chats.sqlite");
  assert.ok(groupEntry); assert.equal(groupEntry.sha256, v9Digest);
  assert.ok(!verified.manifest.entries.some(entry => entry.path.endsWith("writer.lock")));
  const backupDatabase = path.join(verified.backupPath, "payload", "group-chats.sqlite");
  assert.equal(fileHash(backupDatabase), v9Digest);
  // This is a legal old schema produced by the old binary, not a v10 database
  // with only PRAGMA user_version changed or selected new tables dropped.
  current = new GroupChatStore({ paths }).open();
  assert.equal(current.diagnostics().schemaVersion, 10);
  assert.deepEqual(current.listMessages({ groupId, limit: 200 }).messages, oldMessages, "history is kept as it was");
  assert.equal(current.getGroup(groupId).group.ownerMemberId, roster[0].id, "the first member owns a group without Shoggoth, even after a coordinator succession");
  // 升级到单一机制：没结束的旧工作一律取消，原运行身份保留，交给驱动中止一次。
  const migrated = current.getOpportunity(claim.opportunity.id);
  for (const key of ["id", "memberId", "discussionId", "operationId", "runId", "sessionKey"]) {
    assert.deepEqual(migrated[key], originalExecution[key], `preserve ${key}`);
  }
  assert.equal(migrated.state, "cancelled"); assert.equal(migrated.errorCode, "GROUP_UPGRADE_RETIRED");
  assert.deepEqual(current.takeLegacyRuns().map(run => run.runId), [runId], "the unknown old run is handed to the driver to stop");
  assert.equal(current.getDiscussionBinding(groupId, roster[0].id).sessionKey, sessionKey, "the member keeps its group session");
  assert.equal(current.claimNext(groupId, current.getDriverFence()), null, "retired work is never replayed");
  const replay = current.appendUserMessage(input);
  assert.equal(replay.duplicate, true); assert.equal(replay.message.id, accepted.message.id);
  assert.equal(replay.discussionId, accepted.discussionId);
  assert.equal(current.db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE discussion_id=?").get(accepted.discussionId).n, priorOpportunityCount);
  const freshInput = { groupId, clientMessageId: "new-v10-operation", body: "synthetic accepted after upgrade",
    mentionMemberIds: [roster[1].id] };
  const fresh = current.appendUserMessage(freshInput);
  assert.notEqual(fresh.message.id, accepted.message.id); assert.ok(fresh.message.seq > accepted.message.seq);
  const freshClaim = current.claimNext(groupId, current.getDriverFence());
  assert.ok(freshClaim); assert.equal(freshClaim.opportunity.discussionId, fresh.discussionId);
  assert.equal(freshClaim.member.id, roster[1].id, "the mentioned member answers after the upgrade");
  current.close(); current = null;
  const beforeOldRead = fileHash(database);
  const refusingOld = new V9Store({ paths });
  assert.throws(() => refusingOld.open(), { code: "GROUP_CHAT_STORE_CORRUPT" });
  refusingOld.close();
  const afterOldRead = fileHash(database);
  assert.equal(afterOldRead, beforeOldRead, "old binary refusal must leave v10 and new accepted input intact");
  assert.equal(fileHash(backupDatabase), v9Digest, "old backup remains immutable; never restore it over current work");
  current = new GroupChatStore({ paths }).open();
  assert.equal(current.getOpportunity(claim.opportunity.id).runId, runId);
  assert.equal(current.getOpportunity(claim.opportunity.id).state, "cancelled");
  assert.deepEqual(current.takeLegacyRuns(), [], "the retired run is stopped once, not again on reopen");
  assert.equal(current.appendUserMessage(input).message.id, accepted.message.id);
  assert.equal(current.appendUserMessage(freshInput).message.id, fresh.message.id);
  assert.equal(current.getOpportunity(freshClaim.opportunity.id).state, "running");
  assert.equal(current.claimNext(groupId, current.getDriverFence()), null, "reopen cannot replay either accepted operation");
  const report = { version: 1, passed: true, baselineCommit: BASELINE,
    baselineStoreSha256: fileHash(oldStorePath), baselineArchiveSha256: hash(archive),
    currentStoreSha256: fileHash(path.join(ROOT, "app/agent-service/group-chat-store.js")),
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    backupRootDigest: verified.manifest.rootDigest, backupDatabaseSha256: v9Digest,
    currentDatabaseSha256BeforeOldRead: beforeOldRead, currentDatabaseSha256AfterOldRead: afterOldRead,
    checks: { actualV9Schema: true, liveWriterBackupRejected: true, stoppedWriterBackupVerified: true,
      originalIdentityRetained: true, unfinishedWorkRetiredOnce: true, oldIdReplayIsDuplicate: true,
      v10NewWorkRetainedAfterOldBinaryRefusal: true, oldBinaryRefusalDidNotChangeDatabase: true,
      reopenDidNotReplay: true, noBackupRestoredOverCurrentWork: true },
    scope: "explicit offline authority backup and same-authority group v9-to-v10 migration; no startup hook",
    realProviderStarts: 0, realServiceStarts: 0, personalConfigOrAuthReads: 0,
    boundary: "Synthetic isolated SQLite only; no installed App, production authority upgrade or rollback restoration performed." };
  if (reportPath) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  old?.close(); current?.close(); fs.rmSync(root, { recursive: true, force: true });
}
