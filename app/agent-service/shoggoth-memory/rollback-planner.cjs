"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, validatePrivateStat, fsyncPrivateParent } = require("../private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("../security");
const { openDatabase } = require("../inspiration-database");
const { MemoryStore, validateMemoryItem } = require("../memory-store");
const { RecallPolicyStore } = require("../recall-policy-store");
const { contentHash, hasSecret } = require("../memory-engine");
const { splitEntries } = require("./file-store.cjs");
const { renderMemoryEntry, sha256 } = require("./migration.cjs");
const { captureLegacyAuthorizationSnapshot, captureLegacyAuthorizationAuxiliaryAuthority, needsLegacyAuthorization,
  retainedAuthorizationRecords, authorizationPlanBinding, openLegacyAuthorizationResources, verifyLegacyAuthorizationSnapshot } = require("./legacy-authorization-verifier.cjs");

const { captureLegacyAcceptedReviewProof, acceptedReviewPlanBinding, reuseLegacyAcceptedReviewProof } = require("./legacy-accepted-review-verifier.cjs");
const originalAuthorizationPlanBinding = authorizationPlanBinding;
const planBinding = plan => ({ ...originalAuthorizationPlanBinding(plan), ...acceptedReviewPlanBinding(plan) });

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_PLAN_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const FIELDS = ["id", "profileId", "scope", "type", "content", "sourceRefs", "confidence", "sensitivity", "status", "validFrom", "validUntil", "supersedes", "createdAt", "updatedAt"];
const META_FIELDS = new Set([...FIELDS, "memoryPath", "contentHash", "contentRevision", "migrated"]);
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw serviceError(code, message); };
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const canonical = (item, profileId) => validateMemoryItem(Object.fromEntries(FIELDS.map(key => [key, item[key]])), profileId);
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

// This is an offline preflight, not a writer, archive-based rollback or owner
// switch. Every proposed operation still needs a future apply/recovery protocol.
class StoppedMemoryRollbackPlanner {
  constructor({ migration, paths, fault = () => {} }) { this.migration = migration; this.paths = paths; this.fault = fault; }

  proof(options) {
    if (typeof options?.assertServiceStopped !== "function") fail("MEMORY_ROLLBACK_STOP_PROOF_REQUIRED", "回退计划需要停服证明");
    // An assertion must throw when false. An explicit false result cannot be
    // mistaken for a successful assertion either.
    const check = () => {
      const result = options.assertServiceStopped();
      if (result !== undefined && result !== true) fail("MEMORY_ROLLBACK_SERVICE_RUNNING", "Service 停止证明必须同步成立");
    };
    check(); return check;
  }

  owned(target, directory = false) {
    const root = path.resolve(this.paths.trustedRoot), resolved = path.resolve(target);
    if (resolved !== target || !(resolved.startsWith(root + path.sep) || directory && resolved === root) || fs.realpathSync.native(root) !== root) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "回退来源路径不规范");
    for (let parent = directory ? resolved : path.dirname(resolved); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || parent !== root && (stat.mode & 0o777) !== 0o700
        || fs.realpathSync.native(parent) !== parent) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "回退来源目录不安全");
      const identity = { path: parent, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
      const previous = this.directoryPins?.get(parent);
      if (previous && stableJson(previous) !== stableJson(identity)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退来源父目录身份发生变化");
      this.directoryPins?.set(parent, identity);
      if (parent === root) break;
      if (!parent.startsWith(root + path.sep)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "回退来源超出私有根目录");
    }
    return resolved;
  }

  read(target, maxBytes = MAX_FILE_BYTES, optional = false) {
    this.owned(target);
    if (!exists(target)) {
      if (optional) return { path: target, present: false };
      fail("MEMORY_ROLLBACK_SOURCE_MISSING", "回退来源缺失");
    }
    const before = validatePrivateStat(fs.lstatSync(target), target);
    const data = readPrivateFile(target, { maxBytes });
    const after = validatePrivateStat(fs.lstatSync(target), target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退来源在读取时变化");
    this.owned(target);
    return { path: target, present: true, bytes: data.length, sha256: sha256(data),
      identity: { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs }, data };
  }

  workspaceFiles(locations) {
    this.owned(locations.workspace, true);
    const names = ["USER.md", "MEMORY.md", ".shoggoth-memory-migration.json"];
    const walk = (relative, depth = 0) => {
      if (depth > 64 || names.length > MAX_ROWS) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "记忆目录超过快照限制");
      const directory = path.join(locations.workspace, relative);
      if (!exists(directory)) return;
      this.owned(directory, true);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name), target = path.join(locations.workspace, name);
        if (entry.isSymbolicLink()) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆目录含符号链接");
        if (entry.isDirectory() && !entry.name.startsWith(".")) walk(name, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".md")) names.push(name);
      }
    };
    walk("memory");
    return names.sort().map(name => {
      const captured = this.read(path.join(locations.workspace, name), MAX_FILE_BYTES, name !== ".shoggoth-memory-migration.json");
      if (captured.present && !Buffer.from(captured.data.toString("utf8"), "utf8").equals(captured.data)) fail("MEMORY_ROLLBACK_TEXT_INVALID", "权威记忆文件不是有效 UTF-8");
      return { name, ...captured, text: captured.present ? captured.data.toString("utf8") : "" };
    });
  }

  database(target, tables, check, scratchParent, optional = false) {
    const files = ["", "-wal", "-shm", "-journal"].map(suffix => this.read(target + suffix, MAX_DATABASE_BYTES, suffix !== "" || optional));
    if (!files[0].present) return { files, tables: {}, present: false };
    // SQLite may create WAL/SHM files even for a readOnly connection. Read
    // logical rows from an exact owned copy; the retained source is untouched.
    this.owned(scratchParent, true);
    const scratch = fs.mkdtempSync(path.join(scratchParent, ".rollback-db-read-")); fs.chmodSync(scratch, 0o700);
    const copied = path.join(scratch, "source.sqlite"), result = {};
    let db;
    try {
      for (const file of files.filter(file => file.present && !file.path.endsWith("-shm"))) {
        atomicWritePrivateFile(copied + file.path.slice(target.length), file.data, { trustedRoot: this.paths.trustedRoot });
      }
      check(); db = openDatabase(copied, { readOnly: true });
      db.exec("BEGIN");
      for (const [table, profileId] of tables) {
        const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!present) continue;
        // Table names come only from the fixed calls below, never a manifest.
        const rows = db.prepare(`SELECT * FROM ${table}${profileId ? " WHERE profile_id=?" : ""} LIMIT ${MAX_ROWS + 1}`).all(...(profileId ? [profileId] : []));
        if (rows.length > MAX_ROWS) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "回退元数据超过行数限制");
        result[table] = rows.map(row => ({ ...row })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
      }
      db.exec("ROLLBACK");
    } finally {
      try { db?.close(); }
      finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    }
    check();
    for (const file of files) {
      const current = this.read(file.path, MAX_DATABASE_BYTES, true);
      if (stableJson(this.stamp(current)) !== stableJson(this.stamp(file))) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "SQLite 在回退快照期间变化");
    }
    return { files, tables: result, present: true };
  }

  stamp(file) { const { data, text, ...stamp } = file; return stamp; }

  sameStamp(current, captured) {
    return stableJson(this.stamp({ ...current, ...(captured.name === undefined ? {} : { name: captured.name }) })) === stableJson(this.stamp(captured));
  }

  assertDirectories(pins) {
    const previous = this.directoryPins;
    this.directoryPins = new Map(pins.map(identity => [identity.path, identity]));
    try { for (const identity of pins) this.owned(identity.path, true); }
    finally { this.directoryPins = previous; }
  }

  capture(profileId, check, { acceptedReviewProof = null } = {}) {
    const previousProof = this.acceptedReviewProof; this.acceptedReviewProof = acceptedReviewProof;
    const previous = this.directoryPins;
    this.directoryPins = new Map();
    try { return this.captureSources(profileId, check); }
    finally { this.directoryPins = previous; this.acceptedReviewProof = previousProof; }
  }

  captureSources(profileId, check) {
    check(); const locations = this.migration.locations(profileId);
    this.owned(locations.directory, true);
    const manifestFile = this.read(locations.manifest, MAX_PLAN_BYTES), manifest = JSON.parse(manifestFile.data.toString("utf8"));
    if (manifest.profileId !== profileId || manifest.phase !== "active") fail("MEMORY_ROLLBACK_MIGRATION_INVALID", "不是当前 Profile 的已完成迁移");
    // A manifest cannot nominate arbitrary readable files as old authority.
    const known = new Map([...["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json", "provenance.jsonl", "candidate-review.json"]
      .map(name => [name, path.join(locations.profileDir, "memory", name)]),
    ["recall-policy-installed.json", path.join(locations.profileDir, "recall-policy-installed.json")],
    ["recall-policy-installation.json", path.join(this.paths.agentsDir, ".recall-policy-installations", `${profileId}.json`)]]);
    if (!Array.isArray(manifest.backupFiles) || new Set(manifest.backupFiles.map(file => file.name)).size !== manifest.backupFiles.length
      || manifest.backupFiles.some(file => known.get(file.name) !== file.source)) fail("MEMORY_ROLLBACK_MIGRATION_INVALID", "迁移来源不是固定的旧记忆路径");
    for (const file of manifest.backupFiles) this.owned(path.join(locations.directory, "backup", file.name));
    const backupFiles = manifest.backupFiles.map(file => this.read(path.join(locations.directory, "backup", file.name), MAX_DATABASE_BYTES));
    const snapshotFile = this.read(locations.snapshot, MAX_PLAN_BYTES);
    const legacySnapshot = this.migration.verifyBackups(locations, manifest);
    if (legacySnapshot.profileId !== profileId || legacySnapshot.revision !== manifest.legacyRevision) fail("MEMORY_ROLLBACK_MIGRATION_INVALID", "迁移前像不属于当前修订");
    const legacyFiles = [...known].map(([name, target]) => ({ name, ...this.read(target, MAX_DATABASE_BYTES, true) }));
    const old = new MemoryStore({ paths: this.paths, readOnly: true }); old.open();
    let legacyRecords, legacyRevision, contentRevisions, writeProofs;
    try {
      legacyRecords = old.list(profileId); legacyRevision = old.getRevision(profileId);
      contentRevisions = Object.fromEntries(legacyRecords.map(item => [item.id, old.getContentRevision(profileId, item.id)]));
      writeProofs = Object.fromEntries(legacyRecords.map(item => [item.id, old.getItemWriteProof(profileId, item.id)]));
    } finally { old.close(); }
    const policy = new RecallPolicyStore({ paths: this.paths, memoryStore: {} });
    // _read is the existing read-only checksum/seal/anchor verifier. Calling
    // assertReady here would reconcile/write the policy, which is forbidden.
    const policyState = policy._read(profileId, policy._paths(profileId));
    const files = this.workspaceFiles(locations);
    const marker = JSON.parse(files.find(file => file.name === ".shoggoth-memory-migration.json").text);
    if (marker.profileId !== profileId || marker.snapshotHash !== manifest.snapshotHash || marker.upstreamRevision !== manifest.upstreamRevision) fail("MEMORY_ROLLBACK_MIGRATION_INVALID", "新工作区迁移标记已改变");
    const product = this.database(path.join(this.paths.stateDir, "shoggoth-memory.sqlite"),
      ["memory_file_profiles", "memory_file_records", "memory_file_pending", "memory_file_history", "memory_flush_runs", "memory_flush_cycles"].map(table => [table, profileId]), check, locations.directory);
    const core = this.database(path.join(locations.profileDir, "memory-core.sqlite"),
      ["memory_state", "memory_clock", "memory_entry_origins", "memory_session_tombstones", "memory_host_events", "memory_promotion_sources"].map(table => [table, null]), check, locations.directory, true);
    if ([...(core.tables.memory_entry_origins || []), ...(core.tables.memory_session_tombstones || [])].some(row => row.agent_id !== profileId)) fail("MEMORY_ROLLBACK_METADATA_INVALID", "当前记忆库含其他 Profile 的来源归属");
    const profiles = product.tables.memory_file_profiles || [];
    if (profiles.length !== 1 || !Number.isSafeInteger(profiles[0].revision) || profiles[0].revision < 0) fail("MEMORY_ROLLBACK_METADATA_INVALID", "文件记忆修订缺失或无效");
    const metadata = (product.tables.memory_file_records || []).map(row => {
      const item = JSON.parse(row.data);
      if (item.profileId !== profileId || row.id !== item.id) fail("MEMORY_ROLLBACK_METADATA_INVALID", "兼容元数据归属无效");
      return item;
    });
    const fingerprintFiles = files.filter(file => file.name !== ".shoggoth-memory-migration.json").map(file => ({ path: file.name, content: file.text }));
    const fileRevision = profiles[0].revision + Number(profiles[0].fingerprint !== sha256(JSON.stringify(fingerprintFiles)));
    const capture = { manifest: this.stamp(manifestFile), legacySnapshot: this.stamp(snapshotFile), backupFiles: backupFiles.map(file => this.stamp(file)), legacySnapshotHash: manifest.snapshotHash,
      legacyFiles: legacyFiles.map(file => this.stamp(file)), files: files.map(file => ({ ...this.stamp(file), text: file.text })),
      product: { files: product.files.map(file => this.stamp(file)), tables: product.tables },
      core: { files: core.files.map(file => this.stamp(file)), tables: core.tables },
      legacyRecords, legacyContentRevisions: contentRevisions, legacyWriteProofs: writeProofs, metadata,
      revisions: { legacy: legacyRevision, file: fileRevision, recall: policyState.revision },
      recallRecords: policyState.records };
    // Bind all retained memory trees at plan time. A later prepare must not
    // adopt a newly appeared generated file or a different authority directory.
    // The plan publication itself is intentionally excluded to avoid a hash
    // referring to its own bytes; verify() proves that publication separately.
    const { captureLegacyRollbackAuxiliaryAuthority } = require("./legacy-rollback-verifier.cjs");
    capture.auxiliaryAuthority = captureLegacyRollbackAuxiliaryAuthority({ paths: this.paths, profileId, plan: { snapshot: capture } });
    for (const directory of capture.auxiliaryAuthority.directories) this.owned(directory.path, true);
    if (needsLegacyAuthorization(legacyRecords)) {
      capture.authorizationAuxiliaryAuthority = captureLegacyAuthorizationAuxiliaryAuthority({ paths: this.paths, profileId, assertCurrent: check });
      for (const directory of capture.authorizationAuxiliaryAuthority.directories) this.owned(directory.path, true);
    }
    const reviewedTargets = metadata.filter(item => /^reviewed-mc-[a-f0-9]{64}$/u.test(item.id)
      && (item.status !== "candidate" || !legacyRecords.some(old => old.id === item.id && stableJson(canonical(item, profileId)) === stableJson(old))));
    if (reviewedTargets.length) {
      const receiptBackup = manifest.backupFiles.find(file => file.name === "candidate-review.json");
      capture.acceptedReviewProof = this.acceptedReviewProof ? reuseLegacyAcceptedReviewProof({ paths: this.paths, profileId, records: reviewedTargets,
        auxiliaryAuthority: capture.authorizationAuxiliaryAuthority, proof: this.acceptedReviewProof }) : captureLegacyAcceptedReviewProof({ paths: this.paths, profileId, records: reviewedTargets,
        baselineReceiptPath: receiptBackup ? path.join(locations.directory, "backup", receiptBackup.name) : null, now: this.migration.now(), assertCurrent: check,
        sessionTombstones: core.tables.memory_session_tombstones || [] });
    }
    check();
    // Detect races between the first old-store replay and later SQLite reads.
    for (const file of [manifestFile, snapshotFile, ...backupFiles, ...legacyFiles, ...files, ...product.files, ...core.files]) {
      const current = this.read(file.path, file.path.endsWith(".json") ? MAX_PLAN_BYTES : MAX_DATABASE_BYTES, true);
      if (!this.sameStamp(current, file)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "停服快照的来源发生变化");
    }
    if (stableJson(captureLegacyRollbackAuxiliaryAuthority({ paths: this.paths, profileId, plan: { snapshot: capture } }))
      !== stableJson(capture.auxiliaryAuthority)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "停服快照的辅助记忆来源发生变化");
    if (capture.authorizationAuxiliaryAuthority && stableJson(captureLegacyAuthorizationAuxiliaryAuthority({ paths: this.paths, profileId, assertCurrent: check })) !== stableJson(capture.authorizationAuxiliaryAuthority)) {
      fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "停服快照的共享或审核授权来源发生变化");
    }
    capture.directoryIdentities = [...this.directoryPins.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.assertDirectories(capture.directoryIdentities);
    return { locations, manifest, legacySnapshot, policyState, capture };
  }

  initialIds(manifest, snapshot) {
    for (const now of new Set([manifest.createdAt, manifest.activatedAt])) {
      const visible = new Set(snapshot.visibleIds), active = snapshot.records.filter(item => visible.has(item.id)
        && item.status === "active" && item.validFrom <= now && (item.validUntil === null || item.validUntil > now));
      const generated = {
        "USER.md": "# User\n\n" + active.filter(item => item.scope === "user").map(renderMemoryEntry).join("\n"),
        "MEMORY.md": "# Memory\n\n" + active.filter(item => item.scope !== "user").map(renderMemoryEntry).join("\n"),
      };
      if (Object.entries(generated).every(([name, text]) => manifest.initialFiles?.[name] === sha256(text))) return new Set(active.map(item => item.id));
    }
    return null;
  }

  build(profileId, state) {
    const { capture, manifest, legacySnapshot, policyState } = state, blockers = [], operations = [];
    const block = (code, fields = {}) => blockers.push({ code, ...fields });
    const originals = new Map(legacySnapshot.records.map(item => [item.id, canonical(item, profileId)]));
    const retained = new Map(capture.legacyRecords.map(item => [item.id, item]));
    if (capture.revisions.legacy !== manifest.legacyRevision || stableJson([...retained].sort()) !== stableJson([...originals].sort())) block("LEGACY_AUTHORITY_CHANGED");
    for (const file of manifest.backupFiles.filter(file => ["events.jsonl", "snapshot.json", "provenance.jsonl", "candidate-review.json"].includes(file.name))) {
      const current = capture.legacyFiles.find(source => source.name === file.name);
      if (!current?.present || current.sha256 !== file.sha256) {
        if (file.name !== "candidate-review.json" || !capture.acceptedReviewProof) block("LEGACY_AUTHORITY_CHANGED", { file: file.name });
      }
    }
    if ((capture.product.tables.memory_file_pending || []).length) block("FILE_TRANSACTION_UNSETTLED");
    if ((capture.product.tables.memory_flush_runs || []).some(row => ["running", "interrupted"].includes(row.state))) block("INCOMPLETE_BACKGROUND_WRITE");
    const initialIds = this.initialIds(manifest, legacySnapshot);
    if (!initialIds) block("INITIAL_PUBLICATION_UNPROVEN");
    const entries = new Map();
    for (const file of capture.files.filter(file => file.name.endsWith(".md"))) {
      const identified = splitEntries(file.text);
      for (const entry of identified) {
        if (entries.has(entry.id)) block("DUPLICATE_FILE_ID", { id: entry.id });
        else entries.set(entry.id, { ...entry, path: file.name });
      }
      let unbound = file.text;
      for (const entry of identified.toReversed()) unbound = unbound.slice(0, entry.start) + unbound.slice(entry.end);
      if (unbound.split("\n").some(line => line.trim() && !/^\s*(?:#|<!--)/u.test(line))) block("UNIDENTIFIED_FILE_FACT", { path: file.name });
      if (/<!--\s*openclaw-memory-promotion:/iu.test(file.text)) block("PROMOTION_SOURCE_SEMANTICS", { path: file.name });
    }
    const metadataIds = new Set();
    for (const data of capture.metadata) {
      metadataIds.add(data.id);
      let item;
      try { item = canonical(data, profileId); } catch (error) { block("LEGACY_RECORD_UNREPRESENTABLE", { id: data.id, reason: error.code || "invalid-record" }); continue; }
      if (typeof data.memoryPath !== "string" || !/^(?:USER\.md|MEMORY\.md|memory\/[^\\\0]+\.md)$/u.test(data.memoryPath)
        || path.posix.normalize(data.memoryPath) !== data.memoryPath) { block("RECORD_SOURCE_PATH_UNPROVEN", { id: item.id }); continue; }
      if (Object.keys(data).some(key => !META_FIELDS.has(key))) block("ADDITIONAL_RECORD_SEMANTICS", { id: item.id,
        fields: Object.keys(data).filter(key => !META_FIELDS.has(key)).sort() });
      const source = entries.get(item.id), original = originals.get(item.id);
      const initial = original && { ...original, status: initialIds?.has(item.id) ? "active" : original.status === "active" ? "deleted" : original.status };
      // Hidden migration records were never a user deletion. Preserve their
      // exact old authority and original content revision when untouched.
      const unchangedInitial = data.migrated === true && original && stableJson(item) === stableJson(initial)
        && data.contentHash === sha256(original.content);
      if (unchangedInitial && !initialIds?.has(item.id) && !source) continue;
      if (source) {
        if (source.content !== item.content || data.contentHash !== sha256(source.content)) { block("FILE_EDIT_WITHOUT_COMPATIBLE_PROVENANCE", { id: item.id, path: source.path }); continue; }
        if (item.status !== "active") { block("FILE_METADATA_STATUS_CONFLICT", { id: item.id }); continue; }
      } else if (item.status === "active") item = { ...item, status: "deleted" };
      if (stableJson(item) === stableJson(retained.get(item.id))) continue;
      const reviewedProof = capture.acceptedReviewProof?.proofs.find(proof => proof.id === item.id && proof.targetHash === sha256(stableJson(item)));
      if (item.scope !== "agent" && !(reviewedProof && item.status !== "active")) { block("LEGACY_SHARED_SCOPE_SEMANTICS", { id: item.id, scope: item.scope }); continue; }
      if (item.status === "active" && (hasSecret(item.content) || item.sensitivity === "restricted")) { block("LEGACY_VISIBILITY_SEMANTICS", { id: item.id }); continue; }
      if (/^reviewed-mc-[a-f0-9]{64}$/u.test(item.id) && !reviewedProof) { block("LEGACY_REVIEW_PROOF_REQUIRED", { id: item.id }); continue; }
      if (/<!--\s*(?:openclaw-memory-promotion|project):|\[[^\]\s]+\/sessions\/|\bmemory\/[^\n`<>]*?\.(?:txt|md)(?::\d+-\d+|#L\d+-L\d+)/iu.test(item.content)) {
        block("CONTENT_SOURCE_SEMANTICS", { id: item.id }); continue;
      }
      const additional = Object.keys(data).filter(key => !META_FIELDS.has(key));
      if (additional.length) continue;
      operations.push({ id: item.id, before: retained.get(item.id) || null, after: item,
        sourcePath: source?.path || data.memoryPath, sourceContentHash: data.contentHash,
        missingFileRequiresDeleteReceipt: !source && data.status === "active" });
    }
    for (const [id, entry] of entries) if (!metadataIds.has(id)) block("FILE_ID_WITHOUT_METADATA", { id, path: entry.path });
    for (const [id] of originals) if (!metadataIds.has(id)) block("MIGRATED_METADATA_MISSING", { id });
    operations.sort((a, b) => a.id.localeCompare(b.id));
    const target = new Map([...retained, ...operations.map(operation => [operation.id, operation.after])]);
    const currentMetadata = new Map(capture.metadata.map(item => [item.id, item]));
    const cutoffs = new Map([...policyState.contentCutoffs].map(([text, cutoff]) => [sha256(text), cutoff]));
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index], item = operation.after;
      operation.proposedBatch = Math.floor(index / 128);
      operation.proposedSequence = capture.revisions.legacy + operation.proposedBatch + 1;
      if (item.supersedes && (!target.has(item.supersedes) || target.get(item.supersedes).scope !== item.scope)) block("LINEAGE_UNREPRESENTABLE", { id: item.id });
      const cutoff = cutoffs.get(contentHash(item.content));
      const oldRevision = operation.before?.content === item.content ? capture.legacyContentRevisions[item.id] : operation.proposedSequence;
      const currentRevision = currentMetadata.get(item.id)?.contentRevision;
      if (cutoff && item.createdAt > cutoff.createdAt && (!Number.isSafeInteger(currentRevision)
        || (currentRevision > cutoff.memoryRevision) !== (oldRevision > cutoff.memoryRevision))) {
        block("CONTENT_REVISION_FENCE_REQUIRED", { id: item.id, currentContentRevision: currentRevision ?? null,
          proposedContentRevision: oldRevision ?? null, cutoff: cutoff.memoryRevision });
      }
      if (operation.missingFileRequiresDeleteReceipt) block("MISSING_DELETE_POLICY_RECEIPT", { id: item.id });
    }
    const journalBatches = [];
    for (let index = 0; index < operations.length; index += 128) journalBatches.push({ expectedRevision: capture.revisions.legacy + index / 128,
      items: operations.slice(index, index + 128).map(operation => operation.after) });
    const targetRevision = capture.revisions.legacy + journalBatches.length;
    const legacyCompatibility = this.legacyCompatibility(capture, policyState, target, operations);
    // File revisions and journal sequences are independent domains. Checking
    // only today's mapped records can still prevent tomorrow's first explicit
    // authorization from crossing an inherited file-owner cutoff.
    for (const [text, cutoff] of policyState.contentCutoffs) {
      if (cutoff.memoryRevision > targetRevision) legacyCompatibility.blockers.push({ code: "FUTURE_AUTHORIZATION_REVISION_FENCE_REQUIRED",
        contentHash: contentHash(text), cutoff: cutoff.memoryRevision, targetRevision });
    }
    legacyCompatibility.preservesWriterSemantics = legacyCompatibility.blockers.length === 0;
    return { format: "shoggoth-stopped-memory-rollback-plan", schemaVersion: 1, profileId,
      upstreamRevision: manifest.upstreamRevision, migrationSnapshotHash: manifest.snapshotHash,
      sourceFingerprint: sha256(stableJson(capture)), snapshot: capture, operations, journalBatches,
      blockers, legacyCompatibility, mappingReady: blockers.length === 0, canApply: false, canSelectLegacyWriter: false,
      remaining: ["apply-and-crash-recovery", "legacy-search-and-revocation-acceptance", "explicit-owner-selection"] };
  }

  legacyCompatibility(capture, policyState, target, operations) {
    const blockers = [], changes = new Map(operations.map(operation => [operation.id, operation]));
    const suppresses = record => ["forgotten", "user_deleted", "legacy_unknown"].includes(record.reason);
    const covers = (record, item) => record.memoryId === item.id && record.contentHash === contentHash(item.content)
      || record.related?.some(related => related.memoryId === item.id && related.contentHash === contentHash(item.content));
    // A read-only mapping can preserve an unfinished legacy deletion. A writer
    // must not use writable replay/owner startup to finish that other intent.
    for (const item of capture.legacyRecords) {
      const records = policyState.byMemory.get(item.id) || [];
      if (item.status !== "deleted" && records.some(record => suppresses(record) && covers(record, item))
        && changes.get(item.id)?.after.status !== "deleted") {
        blockers.push({ code: "LEGACY_WITHDRAWAL_TRANSACTION_UNSETTLED", id: item.id });
      }
      // An expiry reason does not itself commit the primary deletion. The
      // file-owner's visibility filter cannot close that older transaction.
      if (item.status !== "deleted" && records.some(record => record.reason === "expired" && covers(record, item))) {
        blockers.push({ code: "LEGACY_EXPIRY_TRANSACTION_UNSETTLED", id: item.id });
      }
    }
    for (const item of target.values()) {
      const records = policyState.byMemory.get(item.id) || [];
      const matching = records.filter(record => covers(record, item)).at(-1);
      const suppression = records.some(record => suppresses(record) && covers(record, item));
      if (item.status !== "deleted" && records.some(suppresses) && !matching) {
        blockers.push({ code: "LEGACY_WITHDRAWAL_CONTENT_CONFLICT", id: item.id });
      }
      if (item.status !== "deleted" || suppression) continue;
      const expiry = matching?.reason === "expired" && policyState.expiryCommits.get(matching.operationId);
      const proof = capture.legacyWriteProofs[item.id];
      if (!expiry || !proof || changes.has(item.id) || expiry.primarySeq !== proof.seq
        || expiry.primaryChecksum !== proof.checksum) {
        blockers.push({ code: expiry || matching?.reason === "expired"
          ? "LEGACY_EXPIRY_PRIMARY_PROOF_UNPROVEN" : "LEGACY_DELETE_POLICY_RECEIPT_REQUIRED", id: item.id });
      }
    }
    return { blockers, preservesWriterSemantics: blockers.length === 0 };
  }

  cas(revisions, options) {
    const expected = options?.expectedRevisions;
    if (!expected || Object.keys(expected).sort().join(",") !== "file,legacy,recall" || !Object.values(expected).every(value => Number.isSafeInteger(value) && value >= 0)) fail("MEMORY_ROLLBACK_CAS_REQUIRED", "回退计划需要三种明确修订");
    if (stableJson(expected) !== stableJson(revisions)) fail("MEMORY_ROLLBACK_REVISION_CONFLICT", "回退计划的来源修订已改变");
  }

  recoverPublication(target, prepared, text) {
    this.owned(target); this.owned(prepared);
    const current = fs.lstatSync(target);
    if (current.nlink === 1) return this.read(target, MAX_PLAN_BYTES).data.toString("utf8");
    // A crash between exclusive publication and unlink leaves exactly this
    // owned pair. Arbitrary linked sources and unrelated plans stay forbidden.
    const pending = exists(prepared) && fs.lstatSync(prepared);
    const safe = stat => stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2
      && (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
    if (!safe(current) || !safe(pending) || current.dev !== pending.dev || current.ino !== pending.ino
      || current.size > MAX_PLAN_BYTES) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "计划发布的链接前像不唯一");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!safe(opened) || opened.dev !== current.dev || opened.ino !== current.ino) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "计划发布的 inode 已改变");
      bytes = fs.readFileSync(fd).toString("utf8");
    } finally { fs.closeSync(fd); }
    if (bytes !== text) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "计划发布内容与不可变计划不符");
    this.owned(target); this.owned(prepared);
    fs.unlinkSync(prepared); fsyncPrivateParent(path.dirname(target));
    this.owned(target);
    return bytes;
  }

  assertAuthorizationAuxiliary(plan, check, ownedSnapshotArtifactsNames = []) {
    const binding = authorizationPlanBinding(plan);
    if (!binding.authorizationSnapshotHash) return;
    const current = captureLegacyAuthorizationAuxiliaryAuthority({ paths: this.paths, profileId: plan.profileId, assertCurrent: check, ownedSnapshotArtifactsNames });
    if (stableJson(current) !== stableJson(plan.snapshot.authorizationAuxiliaryAuthority)) fail("MEMORY_ROLLBACK_AUTHORIZATION_SOURCE_CHANGED", "完整共享或审核辅助授权来源与不可变计划不同");
    check();
  }
  assertAuthorizationMatrix(plan, check) {
    this.assertAuthorizationAuxiliary(plan, check);
    if (!plan.authorizationSnapshot) return;
    const context = openLegacyAuthorizationResources({ paths: this.paths, profileId: plan.profileId, now: plan.authorizationSnapshot.now, assertCurrent: check });
    try { verifyLegacyAuthorizationSnapshot(context, plan.authorizationSnapshot, plan); } finally { context.close(); }
  }

  plan(profileId, options) {
    const check = this.proof(options), state = this.capture(profileId, check);
    this.cas(state.capture.revisions, options);
    if (options.expectedSourceFingerprint !== undefined && options.expectedSourceFingerprint !== sha256(stableJson(state.capture))) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退来源与预检不一致");
    const plan = this.build(profileId, state);
    if (state.capture.authorizationAuxiliaryAuthority) {
      const now = options.now ?? this.migration.now();
      if (!Number.isSafeInteger(now) || now < 0) fail("MEMORY_ROLLBACK_AUTHORIZATION_INPUT_INVALID", "授权计划验收时间无效");
      const retained = new Set(retainedAuthorizationRecords(plan).map(item => item.id));
      plan.authorizationSnapshot = captureLegacyAuthorizationSnapshot({ paths: this.paths, profileId, now, assertCurrent: check,
        excludeSelectedIds: state.capture.legacyRecords.filter(item => !retained.has(item.id)).map(item => item.id) });
      plan.authorizationSnapshotHash = plan.authorizationSnapshot.sha256;
      this.assertAuthorizationMatrix(plan, check);
    }
    const text = stableJson(plan) + "\n";
    if (Buffer.byteLength(text) > MAX_PLAN_BYTES) fail("MEMORY_ROLLBACK_PLAN_TOO_LARGE", "回退计划超过容量限制");
    const planHash = sha256(text), directory = path.join(state.locations.directory, "rollback-plans", planHash);
    const previous = this.directoryPins;
    this.directoryPins = new Map(state.capture.directoryIdentities.map(identity => [identity.path, identity]));
    try {
      this.assertDirectories([...this.directoryPins.values()]);
      ensurePrivateDirectoryTree(directory, this.paths.trustedRoot); this.owned(directory, true);
      const target = path.join(directory, "plan.json"), prepared = path.join(directory, "prepared.json"), ownershipPath = path.join(directory, "ownership.json");
      const ownership = { schemaVersion: 1, planHash, sourceFingerprint: plan.sourceFingerprint, ...planBinding(plan),
        directories: [...this.directoryPins.values()].sort((a, b) => a.path.localeCompare(b.path)) };
      const ownershipText = stableJson(ownership) + "\n", ownershipHash = sha256(ownershipText);
      if (options.expectedOwnershipHash !== undefined && options.expectedOwnershipHash !== ownershipHash) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "计划目录证明已经变化");
      if (exists(ownershipPath)) {
        if (this.read(ownershipPath, MAX_PLAN_BYTES).data.toString("utf8") !== ownershipText) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "计划父目录已被替换");
      } else {
        if (exists(target) || exists(prepared)) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "已有计划缺少目录归属证明");
        atomicWritePrivateFile(ownershipPath, ownershipText, { trustedRoot: this.paths.trustedRoot });
      }
      this.assertDirectories(ownership.directories);
      if (exists(target)) {
        if (this.recoverPublication(target, prepared, text) !== text) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "不可变计划发生冲突");
      } else {
        if (exists(prepared)) {
          if (this.read(prepared, MAX_PLAN_BYTES).data.toString("utf8") !== text) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "回退准备文件发生冲突");
        } else atomicWritePrivateFile(prepared, text, { trustedRoot: this.paths.trustedRoot });
        this.fault("rollback-plan-prepared", profileId);
        check();
        this.assertDirectories(ownership.directories);
        if (sha256(stableJson(this.capture(profileId, check).capture)) !== plan.sourceFingerprint) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "发布前回退来源发生变化");
        this.assertAuthorizationMatrix(plan, check);
        if (exists(target)) fail("MEMORY_ROLLBACK_PLAN_CONFLICT", "计划发布目标已出现");
        this.assertDirectories(ownership.directories);
        // link is an exclusive publish: it cannot replace an immutable target
        // that appeared after the preceding check.
        fs.linkSync(prepared, target); fsyncPrivateParent(directory);
        this.fault("rollback-plan-linked", profileId);
        this.assertDirectories(ownership.directories);
        this.recoverPublication(target, prepared, text);
        this.fault("rollback-plan-published", profileId);
      }
      check();
      this.assertDirectories(ownership.directories);
      return freeze({ ...plan, planHash, planPath: target, ownershipHash, ownershipPath });
    } finally { this.directoryPins = previous; }
  }

  verify(profileId, options) {
    const check = this.proof(options);
    if (!HASH.test(options.planHash || "") || !HASH.test(options.ownershipHash || "")) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退计划及目录证明哈希无效");
    const target = path.join(this.migration.locations(profileId).directory, "rollback-plans", options.planHash, "plan.json");
    const bytes = this.read(target, MAX_PLAN_BYTES).data;
    if (sha256(bytes) !== options.planHash) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退计划哈希不匹配");
    const plan = JSON.parse(bytes.toString("utf8"));
    if (plan.format !== "shoggoth-stopped-memory-rollback-plan" || plan.schemaVersion !== 1 || plan.profileId !== profileId
      || plan.canApply !== false || plan.canSelectLegacyWriter !== false) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退计划归属或用途无效");
    const ownershipPath = path.join(path.dirname(target), "ownership.json"), ownershipBytes = this.read(ownershipPath, MAX_PLAN_BYTES).data;
    if (sha256(ownershipBytes) !== options.ownershipHash) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退计划目录证明哈希不符");
    const ownership = JSON.parse(ownershipBytes.toString("utf8"));
    if (ownership.schemaVersion !== 1 || ownership.planHash !== options.planHash || ownership.sourceFingerprint !== plan.sourceFingerprint
      || !Array.isArray(ownership.directories)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退计划目录证明用途无效");
    const binding = authorizationPlanBinding(plan);
    if (Object.entries(binding).some(([key,value])=>ownership[key] !== value) || !plan.authorizationSnapshot && (ownership.authorizationSnapshotHash !== undefined || ownership.authorizationAuthorityHash !== undefined)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "计划目录归属缺少原授权前像绑定");
    this.assertDirectories(ownership.directories);
    const state = this.capture(profileId, check);
    if (sha256(stableJson(state.capture)) !== plan.sourceFingerprint) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退计划的来源已经变化");
    this.assertAuthorizationMatrix(plan, check);
    this.assertDirectories(ownership.directories);
    check(); return freeze({ valid: true, mappingReady: plan.mappingReady, canApply: false, canSelectLegacyWriter: false,
      planHash: options.planHash, planPath: target, ownershipHash: options.ownershipHash, ownershipPath, blockers: plan.blockers });
  }
}

module.exports = { StoppedMemoryRollbackPlanner, MAX_FILE_BYTES, MAX_PLAN_BYTES };
