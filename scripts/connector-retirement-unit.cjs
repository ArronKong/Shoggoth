"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { openDatabase } = require("../app/agent-service/inspiration-database");
const { readLegacyPluginCalls } = require("../app/agent-service/legacy-plugin-history");
const { createAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { markLegacyPluginPlatformRetired, CONNECTOR_UPGRADE_SNAPSHOT_GENERATION } = require("../app/agent-service/connector-platform-retirement");
const { verifyUpgradeSnapshot } = require("../app/agent-service/upgrade-snapshot");
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-connector-retirement-")));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fingerprints(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")]));
}
function auditFixture(root, version) {
  const pluginsDir = path.join(root, "plugins"); fs.mkdirSync(pluginsDir, { mode: 0o700 });
  const db = openDatabase(path.join(pluginsDir, "external-provenance.sqlite"));
  const columns = ["call_id", "backend_id", "instance_id", "agent_id", "session_id", "run_id", "task_id", "turn_id",
    "tool_call_id", "binding_id", "installation_id", "component_id", "connection_id", "tool_identity", "tool_name", "status",
    "cancel_requested", "result_digest", "result_bytes", "error_code", "created_at", "updated_at"];
  if (version === 4) columns.push("approval_request_id", "approval_outcome", "approval_updated_at");
  db.exec(`PRAGMA user_version=${version}; CREATE TABLE external_plugin_calls (${columns.map(key => `${key} ${/^(?:created_at|updated_at|cancel_requested|result_bytes|approval_updated_at)$/u.test(key) ? "INTEGER" : "TEXT"}`).join(",")});`);
  const hash = "a".repeat(64), toolIdentity = `plugin:fixture:${hash}:old-tool:${hash}`;
  for (const [id, status, cancel, created] of [["old-confirmed", "confirmed", 0, 10], ["old-pending", "pending", 0, 20], ["old-canceled", "pending", 1, 30]]) {
    const values = [id, "openclaw", "old-instance", "agent-one", "session-one", "old-run", null, null, "tool-one", "binding-one",
      "installed-one", hash, "connection-one", toolIdentity, "old_action", status, cancel, status === "confirmed" ? hash : null,
      status === "confirmed" ? 10 : null, null, created, created];
    if (version === 4) values.push(null, null, null);
    db.prepare(`INSERT INTO external_plugin_calls VALUES (${columns.map(() => "?").join(",")})`).run(...values);
  }
  return { db, pluginsDir };
}
function cutoverFixture(t) {
  const root = scratch(t), paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state") });
  const data = { "plugins/catalog.sqlite": "opaque old catalog", "plugins/catalog.sqlite-wal": "opaque old WAL",
    "plugins/packages/old-package/manifest.json": "opaque package", "plugins/active-memory/transcripts/kept.jsonl": "independent memory",
    "encrypted-secrets.json": "opaque encrypted secret container" };
  for (const [relative, text] of Object.entries(data)) {
    const target = path.join(paths.stateDir, relative); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, text, { mode: 0o600 });
  }
  const unchanged = () => { for (const [relative, text] of Object.entries(data)) assert.equal(fs.readFileSync(path.join(paths.stateDir, relative), "utf8"), text); };
  return { root, paths, data, unchanged };
}
test("first legacy cutover seals a usable full authority snapshot before its retirement receipt", t => {
  const { paths, data, unchanged } = cutoverFixture(t);
  const phases = [], receipt = markLegacyPluginPlatformRetired(paths, { checkpoint: phase => phases.push(phase) });
  assert.equal(receipt.version, 2); assert.equal(receipt.legacyExecution, false);
  assert.deepEqual(phases, ["authority-committed", "before-generation-commit", "generation-committed", "before-retirement-commit"]);
  const snapshot = verifyUpgradeSnapshot({ paths, generationId: CONNECTOR_UPGRADE_SNAPSHOT_GENERATION });
  assert.equal(snapshot.manifest.authorityRootDigest, receipt.upgradeSnapshot.rootDigest);
  for (const [relative, text] of Object.entries(data)) assert.equal(fs.readFileSync(path.join(snapshot.backupPath, "payload", relative), "utf8"), text);
  assert.equal(fs.statSync(snapshot.backupPath).mode & 0o077, 0);
  assert.deepEqual(markLegacyPluginPlatformRetired(paths), receipt); assert.equal(fs.readdirSync(paths.backupsDir).length, 1); unchanged();
});
for (const interruptedAt of ["authority-committed", "generation-committed", "before-retirement-commit"]) {
  test(`cutover interrupted at ${interruptedAt} resumes the same snapshot and preserves legacy bytes`, t => {
    const { paths, unchanged } = cutoverFixture(t);
    assert.throws(() => markLegacyPluginPlatformRetired(paths, { checkpoint: phase => {
      if (phase === interruptedAt) throw Object.assign(Error("fixture interrupted"), { code: "EIO" });
    } }));
    assert.equal(fs.existsSync(path.join(paths.connectorsDir, "legacy-platform-retired-v1.json")), false); unchanged();
    const prior = JSON.parse(fs.readFileSync(path.join(paths.backupsDir, "upgrade-" + CONNECTOR_UPGRADE_SNAPSHOT_GENERATION, "manifest.json"), "utf8"));
    const receipt = markLegacyPluginPlatformRetired(paths);
    assert.equal(receipt.upgradeSnapshot.rootDigest, prior.rootDigest); assert.equal(fs.readdirSync(paths.backupsDir).length, 1); unchanged();
  });
}
test("a corrupt unfinished upgrade snapshot or unverified old preview receipt cannot complete cutover", t => {
  const { paths, unchanged } = cutoverFixture(t);
  assert.throws(() => markLegacyPluginPlatformRetired(paths, { checkpoint: phase => {
    if (phase === "before-retirement-commit") throw Error("fixture interruption");
  } }), { code: "CONNECTOR_UPGRADE_SNAPSHOT_FAILED" });
  const target = path.join(paths.connectorsDir, "legacy-platform-retired-v1.json");
  const snapshot = path.join(paths.backupsDir, "upgrade-" + CONNECTOR_UPGRADE_SNAPSHOT_GENERATION);
  fs.writeFileSync(path.join(snapshot, "payload/plugins/catalog.sqlite"), "tampered backup", { mode: 0o600 });
  assert.throws(() => markLegacyPluginPlatformRetired(paths), { code: "CONNECTOR_UPGRADE_SNAPSHOT_FAILED" });
  assert.equal(fs.existsSync(target), false); unchanged();
  fs.writeFileSync(target, JSON.stringify({ version: 1, platform: "open-connector", legacyExecution: false,
    legacyDataPreserved: true, recordedAt: 1, files: [] }), { mode: 0o600 });
  assert.throws(() => markLegacyPluginPlatformRetired(paths), { code: "CONNECTOR_UPGRADE_SNAPSHOT_FAILED" }); unchanged();
});
test("restoring a completed cutover keeps its historical snapshot reference without depending on nested backups", t => {
  const { root, paths, unchanged } = cutoverFixture(t), receipt = markLegacyPluginPlatformRetired(paths);
  createAuthorityBackup({ paths, backupId: "after-cutover" });
  const destination = path.join(root, "restored");
  restoreAuthorityBackup({ paths, backupId: "after-cutover", destinationStateDir: destination });
  const restored = resolveServicePaths({ trustedRoot: root, stateRoot: destination });
  assert.equal(fs.existsSync(restored.backupsDir), false);
  assert.deepEqual(markLegacyPluginPlatformRetired(restored), receipt); unchanged();
  assert.equal(fs.readFileSync(path.join(destination, "plugins/catalog.sqlite"), "utf8"), "opaque old catalog");
});
test("independent active-memory alone does not trigger a retired-platform snapshot", t => {
  const root = scratch(t), paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state") });
  const target = path.join(paths.pluginsDir, "active-memory/transcripts/retained.jsonl");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, "protected memory", { mode: 0o600 });
  assert.equal(markLegacyPluginPlatformRetired(paths).upgradeSnapshot, null);
  assert.equal(fs.existsSync(paths.backupsDir), false); assert.equal(fs.readFileSync(target, "utf8"), "protected memory");
});
test("built-in Skills retain standalone authoring without the retired package workflow", () => {
  const root = path.join(__dirname, "../resources/shoggoth-skills");
  assert.equal(fs.existsSync(path.join(root, "shoggoth-plugin-authoring")), false);
  const skill = JSON.parse(fs.readFileSync(path.join(root, "shoggoth-skill-authoring/skill.json"), "utf8"));
  assert.equal(skill.id, "shoggoth-skill-authoring");
  assert.ok(skill.requiredTools.every(name => !name.startsWith("plugin_")));
  assert.ok(fs.statSync(path.join(root, "shoggoth-skill-authoring/SKILL.md")).isFile());
});
test("retired package Hook snapshots remain durable and cannot load package code or enter a new Run", t => {
  const { HookStore } = require("../app/agent-service/hook-store");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-connector-hook-retirement-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state") });
  const store = new HookStore({ paths }).open();
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let packageLoads = 0;
  store.pluginHooks = { entriesForRun() { packageLoads++; throw Error("retired registry reached"); },
    hydrate() { packageLoads++; throw Error("retired package reached"); } };
  const owner = { profileId: "profile-one", workspace: paths.defaultWorkspaceDir, source: "chat" };
  const fresh = store.freeze({ ...owner, id: "new-standalone-run" }, {}, () => {});
  assert.deepEqual(fresh.entries, []);
  const snapshot = { ...owner, id: "legacy-package-snapshot", runId: "old-package-run", createdAt: 1,
    incarnation: store.incarnation, capabilities: {}, entries: [{ owner: "plugin", hookId: "plugin-hook-old", version: 1,
      contentDigest: "a".repeat(64), sourceFile: "/never-load-old-package.js" }] };
  store.write(() => store.putSnapshot(snapshot));
  const saved = () => store.db.prepare("SELECT data FROM snapshots WHERE id=?").get(snapshot.id).data;
  const before = saved();
  assert.throws(() => store.snapshotForRun(snapshot.runId), { code: "HOOK_PLUGIN_UNAVAILABLE" });
  const skipped = [];
  assert.deepEqual(store.hydrate(JSON.parse(before), { skipUnavailablePlugins: true, onSkipped: (entry, error) => skipped.push([entry.hookId, error.code]) }).entries, []);
  assert.deepEqual(skipped, [["plugin-hook-old", "HOOK_PLUGIN_UNAVAILABLE"]]);
  assert.throws(() => store.assertCurrent(snapshot, snapshot.entries[0]), { code: "HOOK_REVOKED" });
  assert.equal(saved(), before); assert.equal(packageLoads, 0);
});
for (const version of [1, 4]) test(`legacy v${version} history is paged from a private SQLite/WAL copy without changing its source`, t => {
  const { db, pluginsDir } = auditFixture(scratch(t), version); t.after(() => db.close());
  // Leave the writer open so the tested history genuinely resides in WAL.
  const before = fingerprints(pluginsDir);
  assert.ok(before["external-provenance.sqlite-wal"]);
  const page = readLegacyPluginCalls({ pluginsDir }, { backendId: "openclaw", agentId: "agent-one", sessionId: "session-one", toolCallId: "tool-one", limit: 2 });
  assert.deepEqual(page.items.map(row => [row.callId, row.status]), [["old-canceled", "canceled_outcome_unknown"], ["old-pending", "outcome_unknown"]]);
  const next = readLegacyPluginCalls({ pluginsDir }, { backendId: "openclaw", cursor: page.nextCursor, limit: 2 });
  assert.equal(next.items[0].callId, "old-confirmed"); assert.equal(next.items[0].status, "confirmed"); assert.equal(next.nextCursor, null);
  assert.deepEqual(readLegacyPluginCalls({ pluginsDir }, { backendId: "hermes" }), { items: [], nextCursor: null });
  assert.deepEqual(fingerprints(pluginsDir), before);
});
test("legacy approval facts are merged without reviving pending calls and conflicting facts fail closed", t => {
  const { db, pluginsDir } = auditFixture(scratch(t), 4); t.after(() => db.close());
  const journal = openDatabase(path.join(pluginsDir, "external-approval-journal.sqlite")); t.after(() => journal.close());
  journal.exec("PRAGMA user_version=1; CREATE TABLE approval_events (call_id TEXT, request_id TEXT, outcome TEXT, updated_at INTEGER)");
  journal.prepare("INSERT INTO approval_events VALUES (?,?,?,?)").run("old-pending", "old-approval", "approved", 22);
  const before = fingerprints(pluginsDir), pending = readLegacyPluginCalls({ pluginsDir }, {}).items.find(row => row.callId === "old-pending");
  assert.equal(pending.status, "outcome_unknown"); assert.equal(pending.approvalOutcome, "approved"); assert.equal(pending.updatedAt, 22);
  assert.deepEqual(fingerprints(pluginsDir), before);
  db.exec("UPDATE external_plugin_calls SET approval_request_id='other-approval', approval_outcome='denied', approval_updated_at=20 WHERE call_id='old-pending'");
  assert.throws(() => readLegacyPluginCalls({ pluginsDir }, {}), { code: "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE" });
});
test("authority restore preserves an opaque retired catalog and never opens or restores its grants", t => {
  const root = scratch(t), paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  fs.mkdirSync(path.join(paths.stateDir, "plugins"), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from("retired-format-catalog\0opaque\n"), catalog = path.join(paths.stateDir, "plugins/catalog.sqlite");
  fs.writeFileSync(catalog, bytes, { mode: 0o600 });
  createAuthorityBackup({ paths, backupId: "retired-platform" });
  const destination = path.join(root, "restored");
  const result = restoreAuthorityBackup({ paths, backupId: "retired-platform", destinationStateDir: destination });
  assert.equal(result.pluginRestore.platformRetired, true); assert.equal(result.pluginRestore.effectiveGrantsRestored, false);
  assert.deepEqual(fs.readFileSync(path.join(destination, "plugins/catalog.sqlite")), bytes);
  assert.deepEqual(fs.readFileSync(catalog), bytes);
  assert.equal(Object.keys(require.cache).some(file => /\/(?:plugin-store|plugin-database|plugin-catalog-restorer)\.js$/u.test(file)), false);
});
test("an old frozen chat UI operation survives Service restart as unknown and creates no Inbox or Run", async () => {
  const { actionFixture } = require("./native-chat-ui-action-unit.cjs"), c = require("../app/agent-service/chat-ui-contract");
  const f = await actionFixture();
  try {
    f.service.workRunCoordinator.send = async () => { throw Object.assign(Error("cut before send"), { code: "EIO" }); };
    const params = f.spec(), result = await f.send(params); assert.equal(result.status, "unknown");
    const owner = { ...f.owner, transcriptSessionId: f.service.chatSessionStore.getSession(f.owner.sessionKey).id };
    const stored = f.service.chatUiStore.getOperation(owner, { actionRequestId: params.actionRequestId });
    const files = f.service.chatUiStore._paths(owner.profileId, owner.transcriptSessionId);
    await f.close();
    const records = fs.readFileSync(files.log, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    let previous = c.hash("shoggoth-chat-ui-journal-v1");
    for (const record of records) {
      if (record.type === "operation.prepare") {
        delete record.payload.sendEnvelope.connectorSelection;
        record.payload.sendEnvelope.pluginSelection = [{ installationId: "retired-installation", revision: 1 }];
        record.payload.sendFingerprint = c.hash(record.payload.sendEnvelope);
      }
      record.previous = previous; delete record.checksum; record.checksum = c.hash(record); previous = record.checksum;
    }
    fs.writeFileSync(files.log, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8")); manifest.checksum = previous;
    fs.writeFileSync(files.manifest, JSON.stringify(manifest) + "\n");
    await f.open();
    const receipt = await f.ipc("chat.ui.operation.get", { ...f.owner, actionRequestId: params.actionRequestId });
    assert.equal(receipt.status, "unknown"); assert.equal(receipt.errorCode, "UI_PLUGIN_PLATFORM_RETIRED"); assert.equal(receipt.runId, null);
    assert.equal(f.service.workRunCoordinator.inbox.get(stored.operationId), null);
    assert.equal(f.service.productStore.listWorkRuns().some(run => run.idempotencyKey === `shoggoth:chat-send:${stored.operationId}`), false);
  } finally { await f.remove(); }
});
