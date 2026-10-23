"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MemoryStore, validateMemoryItem } = require("../memory-store");
const { MemoryEngine, memoryTrust, contentHash } = require("../memory-engine");
const { RecallPolicyStore } = require("../recall-policy-store");
const { readPrivateFile, validatePrivateStat } = require("../private-file");
const { serviceError } = require("../security");
const { openLegacyAuthorizationResources, captureLegacyAuthorizationSnapshot, verifyLegacyAuthorizationSnapshot, assertLegacyAuthorizationPlanBinding }
  = require("./legacy-authorization-verifier.cjs");

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 100_000;
const LEGACY_NAMES = ["events.jsonl", "snapshot.json", "recall-policy.jsonl", "recall-policy.seal.json", "provenance.jsonl", "candidate-review.json"];
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code, message) => { throw serviceError(code, message); };
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function statOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, nlink: stat.nlink,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

// Do not open SQLite or run any owner's startup. Capture complete bytes of the
// fixed memory authority, including absent SQLite sidecars and generated views.
function authorityCapture(paths, profileId, plan, auxiliary = false, ownedSnapshotArtifactsNames = []) {
  const root = paths?.trustedRoot;
  if (typeof root !== "string" || root !== path.resolve(root) || fs.realpathSync.native(root) !== root) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆验收根目录不规范");
  const profile = path.join(paths.agentsDir, profileId), memory = path.join(profile, "memory");
  const migration = path.join(profile, "memory-migration-shoggoth-v1"), workspace = path.join(profile, "memory-workspace");
  const directories = new Map(), files = new Map();
  if (!Array.isArray(ownedSnapshotArtifactsNames) || ownedSnapshotArtifactsNames.length > 16
    || new Set(ownedSnapshotArtifactsNames).size !== ownedSnapshotArtifactsNames.length
    || ownedSnapshotArtifactsNames.some(name => typeof name !== "string" || !/^(?:snapshot\.json\.tmp|snapshot\.json\.backup-[1-9][0-9]*-[a-f0-9]{16})$/u.test(name))) {
    fail("MEMORY_ROLLBACK_PATH_UNSAFE", "辅助验收只允许已证明归属的固定 snapshot 残留名");
  }
  const skipped = new Set(auxiliary ? ["events.jsonl", "snapshot.json", ...ownedSnapshotArtifactsNames].map(name => path.join(memory, name)) : []);
  const owned = (target, directory = false) => {
    if (target !== path.resolve(target) || !(target.startsWith(root + path.sep) || directory && target === root)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆验收路径超出私有根目录");
    for (let parent = directory ? target : path.dirname(target); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || fs.realpathSync.native(parent) !== parent) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆验收目录不安全");
      // Directory mtimes naturally change when sibling apply receipts publish.
      // Pin identity and inventory of the authority trees themselves instead.
      directories.set(parent, { ...directories.get(parent), path: parent, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
      if (parent === root) break;
      if (!parent.startsWith(root + path.sep)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆验收目录越界");
    }
  };
  const capture = (target, required = false) => {
    if (skipped.has(target)) return;
    owned(target);
    const before = statOrNull(target);
    if (!before) {
      if (required) fail("MEMORY_ROLLBACK_SOURCE_MISSING", "记忆验收权威文件缺失");
      files.set(target, { path: target, present: false }); return;
    }
    validatePrivateStat(before, target);
    const bytes = readPrivateFile(target, { maxBytes: MAX_BYTES }), after = validatePrivateStat(fs.lstatSync(target), target);
    if (stable(identity(before)) !== stable(identity(after)) || bytes.length !== after.size) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "权威文件在验收读取时改变");
    files.set(target, { path: target, present: true, bytes: bytes.length, sha256: hash(bytes), identity: identity(after) });
    if (files.size > MAX_FILES) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "记忆验收文件数量超限");
  };
  const walk = (target, depth = 0) => {
    if (depth > 64) fail("MEMORY_ROLLBACK_SNAPSHOT_TOO_LARGE", "记忆验收目录层级超限");
    owned(path.dirname(target), true);
    const stat = statOrNull(target);
    if (!stat) { files.set(target, { path: target, present: false, directory: true }); return; }
    owned(target, true);
    const names = fs.readdirSync(target).filter(name => !skipped.has(path.join(target, name))).sort();
    directories.set(target, { ...directories.get(target), entries: names });
    for (const name of names) {
      const next = path.join(target, name), entry = fs.lstatSync(next);
      if (entry.isSymbolicLink()) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "记忆验收目录含符号链接");
      if (entry.isDirectory()) walk(next, depth + 1);
      else {
        if (/\.tmp$|\.backup-/u.test(name)) fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "记忆权威文件有未闭合写入事务");
        capture(next, true);
      }
    }
  };
  walk(memory); walk(path.join(profile, "generated")); walk(workspace); walk(path.join(migration, "backup"));
  for (const name of ["USER.md", "MEMORY.md", ".shoggoth-memory-migration.json"]) capture(path.join(workspace, name));
  for (const name of LEGACY_NAMES) capture(path.join(memory, name), ["recall-policy.jsonl", "recall-policy.seal.json"].includes(name));
  capture(path.join(profile, "recall-policy-installed.json"), true);
  capture(path.join(paths.agentsDir, ".recall-policy-installations", `${profileId}.json`), true);
  capture(path.join(migration, "manifest.json"), true); capture(path.join(migration, "legacy-snapshot.json"), true);
  for (const database of [path.join(paths.stateDir, "shoggoth-memory.sqlite"), path.join(profile, "memory-core.sqlite")]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) capture(database + suffix);
  }
  // A supplied plan may only identify its fixed, hashed publication directory.
  if (plan.planPath !== undefined || plan.ownershipPath !== undefined) {
    if (!HASH.test(plan.planHash || "") || !HASH.test(plan.ownershipHash || "")) fail("MEMORY_ROLLBACK_PLAN_INVALID", "验收计划发布证明无效");
    const directory = path.join(migration, "rollback-plans", plan.planHash);
    if (plan.planPath !== path.join(directory, "plan.json") || plan.ownershipPath !== path.join(directory, "ownership.json")) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "验收计划不是固定发布路径");
    capture(plan.planPath, true); capture(plan.ownershipPath, true);
    if (files.get(plan.planPath).sha256 !== plan.planHash || files.get(plan.ownershipPath).sha256 !== plan.ownershipHash) fail("MEMORY_ROLLBACK_PLAN_INVALID", "验收计划发布字节不匹配");
  }
  // Reject a manifest trying to nominate credentials or unrelated authorities.
  const allowed = new Set([...files.keys(), ...skipped]);
  const snapshot = plan.snapshot;
  for (const entry of [snapshot.manifest, snapshot.legacySnapshot, ...(snapshot.backupFiles || []), ...(snapshot.legacyFiles || []),
    ...(snapshot.files || []), ...(snapshot.product?.files || []), ...(snapshot.core?.files || [])].filter(Boolean)) {
    if (typeof entry.path !== "string" || !allowed.has(entry.path)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "验收计划含非记忆权威路径");
  }
  const result = { ...(auxiliary ? { primaryExcluded: true } : {}), directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path)),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  return { ...result, sha256: hash(stable(result)) };
}

// Retain the real assertReady identity checks, but never allow its fallback to
// initialize or reconcile authority. _read is the original seal/anchor parser.
class ReadOnlyRecallPolicy extends RecallPolicyStore {
  _load() { fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "验收期间撤回账本身份改变，禁止写入式恢复"); }
}
function openReadOnlyMemory(paths, profileId, now, store = null, authorization = null) {
  store ||= new MemoryStore({ paths, readOnly: true });
  // MemoryStore.open() always mkdir/chmods. Authority was already validated;
  // only set its in-memory lifecycle flag, then use the original _load parser.
  store.opened = true;
  const policy = new ReadOnlyRecallPolicy({ paths, memoryStore: store, now: () => now, strictSourceResolution: true,
    transcriptStore: authorization?.transcripts, chatSessionStore: authorization?.sessions });
  const state = policy._read(profileId, policy._paths(profileId));
  policy.states.set(profileId, state); policy.opened = true;
  const engine = new MemoryEngine({ store, recallPolicy: policy, now: () => now });
  // Engine.open() would quarantine and write views. search() needs no startup
  // side effect: its original lexical view is built only in memory.
  engine.opened = true;
  if (authorization) authorization.attach(engine);
  return { store, policy, state, engine, authorization, close: () => { engine.close(); store.close(); } };
}
function targetRecords(profileId, plan, expectedRecords) {
  if (typeof profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(profileId)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "旧引擎验收 Profile 无效");
  if (!plan || plan.format !== "shoggoth-stopped-memory-rollback-plan" || plan.schemaVersion !== 1 || plan.profileId !== profileId
    || plan.mappingReady !== true || !Array.isArray(plan.blockers) || plan.blockers.length
    || !Array.isArray(plan.snapshot?.legacyRecords) || !Array.isArray(plan.snapshot?.recallRecords)
    || !Array.isArray(plan.journalBatches) || !Number.isSafeInteger(plan.snapshot?.revisions?.legacy)
    || plan.snapshot.revisions.legacy < 0 || !Number.isSafeInteger(plan.snapshot?.revisions?.recall)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "旧引擎验收需要已验证的完整回退计划");
  const target = new Map();
  for (const raw of plan.snapshot.legacyRecords) {
    const item = validateMemoryItem(raw, profileId);
    if (target.has(item.id)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退前像记忆 ID 重复");
    target.set(item.id, item);
  }
  let revision = plan.snapshot.revisions.legacy;
  for (const batch of plan.journalBatches) {
    if (batch.expectedRevision !== revision || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > 128
      || new Set(batch.items.map(item => item?.id)).size !== batch.items.length) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退批次修订无效");
    for (const raw of batch.items) { const item = validateMemoryItem(raw, profileId); target.set(item.id, item); }
    revision += 1;
  }
  if (target.size > MAX_FILES) fail("MEMORY_ROLLBACK_PLAN_INVALID", "回退目标数量超限");
  const records = [...target.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (expectedRecords !== undefined) {
    if (!Array.isArray(expectedRecords)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "旧引擎验收目标无效");
    const expected = expectedRecords.map(item => validateMemoryItem(item, profileId)).sort((a, b) => a.id.localeCompare(b.id));
    if (stable(expected) !== stable(records)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "验收目标与回退批次不一致");
  }
  return { records, revision };
}
// These are the exact conditions under which the original _reconcile would
// need a durable repair. Reject that intent rather than invoking the writer.
function assertSettled(reader, profileId, records) {
  const suppresses = record => ["forgotten", "user_deleted", "legacy_unknown"].includes(record.reason);
  for (const item of records) {
    const reasons = reader.state.byMemory.get(item.id) || [];
    const covers = record => record.memoryId === item.id && record.contentHash === contentHash(item.content)
      || record.related.some(related => related.memoryId === item.id && related.contentHash === contentHash(item.content));
    const matching = reasons.filter(covers).at(-1), suppression = reasons.some(record => covers(record) && suppresses(record));
    const expiry = matching?.reason === "expired" && reader.state.expiryCommits.get(matching.operationId);
    const proof = expiry && reader.store.getItemWriteProof(profileId, item.id);
    const verifiedExpiry = expiry && proof && expiry.primarySeq === proof.seq && expiry.primaryChecksum === proof.checksum;
    if (item.status === "deleted" && !suppression && !verifiedExpiry
      || item.status !== "deleted" && suppression
      || item.status !== "deleted" && reasons.some(suppresses) && !matching) {
      fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "旧记忆仍需要写入式撤回整理，禁止验收");
    }
  }
}
function projectedSearch(reader, paths, profileId, item, now) {
  // The record, content revision and write proof come from the actual replay.
  // A one-record projection bypasses only top-100 competition; neither stored
  // content nor the original visibility/search algorithm is replaced.
  const store = new MemoryStore({ paths, readOnly: true }), state = store._empty(profileId);
  state.revision = reader.store.getRevision(profileId);
  state.items.set(item.id, structuredClone(item));
  state.contentRevisions.set(item.id, reader.store.getContentRevision(profileId, item.id));
  state.itemWriteProofs.set(item.id, reader.store.getItemWriteProof(profileId, item.id));
  store.profiles.set(profileId, state);
  const projected = openReadOnlyMemory(paths, profileId, now, store, reader.authorization);
  try { return searchIds(projected.engine, profileId, item, now); }
  finally { projected.close(); }
}
function searchIds(engine, profileId, item, now) {
  return engine.search({ profileId, query: item.content, scopes: [item.scope], maxSensitivity: "private", now,
    limit: 100, maxBytes: 128 * 1024 }).items.map(result => result.id);
}

// Future writes are not executed. Project each lawful MemoryItem and its
// content sequence into a fresh real readOnly MemoryStore's in-memory cache;
// exercise the unmodified policy and Engine.search against that projection.
function futureAuthorization(paths, profileId, plan, targetRevision, state, now, check) {
  const evidence = [];
  for (const [content, cutoff] of state.contentCutoffs) {
    check();
    if (cutoff.memoryRevision > targetRevision) fail("MEMORY_ROLLBACK_FUTURE_REVISION_FENCE", "后继旧引擎写入不能跨越保留的内容撤回修订");
    const createdAt = Math.max(now, cutoff.createdAt + 1), revision = targetRevision + 1;
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(revision)) fail("MEMORY_ROLLBACK_FUTURE_REVISION_FENCE", "后继旧引擎授权时间或修订不可表示");
    const id = `rollback-probe-${contentHash(content).slice(0, 32)}`;
    const base = { id, profileId, scope: "agent", type: "semantic", content, sourceRefs: [`user-edit:${id}`], confidence: 1,
      sensitivity: "normal", status: "active", validFrom: 0, validUntil: null, supersedes: null, createdAt, updatedAt: createdAt };
    const probes = [
      { name: "fresh-user-edit", item: base, revision, visible: true },
      { name: "old-content-sequence", item: base, revision: cutoff.memoryRevision, visible: false },
      { name: "old-creation-time", item: { ...base, createdAt: cutoff.createdAt }, revision, visible: false },
      { name: "imported-content", item: { ...base, sourceRefs: [`codex-memory:${id}`] }, revision, visible: false },
      { name: "unverified-event", item: { ...base, sourceRefs: [`event-${id}`, `run-${id}`] }, revision, visible: false },
      { name: "future-start", item: { ...base, validFrom: createdAt + 1 }, revision, visible: false },
      { name: "restricted-content", item: { ...base, sensitivity: "restricted" }, revision, visible: false },
    ];
    const revokedRef = [...state.suppressedRefs][0];
    if (revokedRef) probes.push({ name: "mixed-revoked-source", item: { ...base, sourceRefs: [...base.sourceRefs, revokedRef] }, revision, visible: false });
    for (const probe of probes) {
      check();
      const projected = new MemoryStore({ paths, readOnly: true }), projection = projected._empty(profileId);
      const item = validateMemoryItem(probe.item, profileId);
      projection.revision = revision; projection.items.set(id, item); projection.contentRevisions.set(id, probe.revision);
      projected.profiles.set(profileId, projection);
      const fixture = openReadOnlyMemory(paths, profileId, createdAt, projected);
      try {
        const visible = searchIds(fixture.engine, profileId, item, createdAt).includes(id);
        if (visible !== probe.visible) fail("MEMORY_ROLLBACK_FUTURE_AUTHORIZATION_FAILED", "旧引擎未来授权守门验收失败");
      } finally { fixture.close(); }
    }
    evidence.push({ contentHash: contentHash(content), cutoffRevision: cutoff.memoryRevision, nextRevision: revision,
      checks: probes.map(probe => probe.name) });
  }
  return evidence;
}

function verifyLegacyRollback({ paths, profileId, plan, expectedRecords, now = Date.now(), assertCurrent, authorizationSnapshot } = {}) {
  if (typeof profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(profileId)
    || !Number.isSafeInteger(now) || now < 0) fail("MEMORY_ROLLBACK_PLAN_INVALID", "旧引擎验收 Profile 或时间无效");
  if (typeof assertCurrent !== "function") fail("MEMORY_ROLLBACK_STOP_PROOF_REQUIRED", "旧引擎验收需要同步停服及来源证明");
  const check = () => { const result = assertCurrent(); if (result !== undefined && result !== true) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "旧引擎验收来源证明必须同步成立"); };
  const target = targetRecords(profileId, plan, expectedRecords);
  if (plan.authorizationSnapshot) {
    assertLegacyAuthorizationPlanBinding(plan);
    if (authorizationSnapshot !== undefined && stable(authorizationSnapshot) !== stable(plan.authorizationSnapshot)) fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "调用方不能替换不可变计划的授权前像");
    authorizationSnapshot = plan.authorizationSnapshot;
    if (now !== authorizationSnapshot.now) fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "回退授权验收时间与不可变计划不同");
  }
  const before = authorityCapture(paths, profileId, plan);
  const needsAuthorization = target.records.some(item => /^reviewed-mc-[a-f0-9]{64}$/u.test(item.id)
    || ["user", "project", "workspace"].includes(item.scope));
  if (needsAuthorization && !authorizationSnapshot) fail("MEMORY_ROLLBACK_AUTHORIZATION_SNAPSHOT_REQUIRED", "保留 review/shared 项需要真实只读授权资源与前像矩阵");
  let reader, authorization, authorizationEvidence, result;
  try {
    check();
    const journalPath = path.join(paths.agentsDir, profileId, "memory", "events.jsonl");
    if (!statOrNull(journalPath) && target.revision > 0) fail("MEMORY_ROLLBACK_SOURCE_MISSING", "非空回退目标的旧记忆主日志缺失");
    const journal = statOrNull(journalPath) ? readPrivateFile(journalPath, { maxBytes: MAX_BYTES }) : Buffer.alloc(0);
    if (journal.length && journal.at(-1) !== 0x0a) fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "旧记忆主日志有未闭合尾部，禁止只读截断验收");
    if (authorizationSnapshot) {
      if (!HASH.test(plan.authorizationSnapshotHash || "") || plan.authorizationSnapshotHash !== authorizationSnapshot.sha256) {
        fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "授权前像 digest 必须绑定已固定的回退计划");
      }
      authorization = openLegacyAuthorizationResources({ paths, profileId, now, assertCurrent });
      authorizationEvidence = verifyLegacyAuthorizationSnapshot(authorization, authorizationSnapshot, plan.authorizationSnapshot ? plan : null);
    }
    reader = openReadOnlyMemory(paths, profileId, now, null, authorization);
    const actual = reader.store.list(profileId).sort((a, b) => a.id.localeCompare(b.id));
    if (reader.store.getRevision(profileId) !== target.revision || stable(actual) !== stable(target.records)) fail("MEMORY_ROLLBACK_LEGACY_TARGET_MISMATCH", "旧记忆日志尚未达到完整回退目标");
    if (reader.state.revision !== plan.snapshot.revisions.recall || stable(reader.state.records) !== stable(plan.snapshot.recallRecords)) fail("MEMORY_ROLLBACK_RECALL_MISMATCH", "撤回账本与回退保留目标不一致");
    assertSettled(reader, profileId, actual);
    const visibleIds = [], excluded = [], fullSearchReturned = new Set();
    for (const item of actual) {
      check();
      const policyVisible = reader.policy.snapshot(profileId).isMemoryVisible(item);
      const reasons = [];
      if (item.status !== "active") reasons.push(item.status);
      if (item.validFrom > now) reasons.push("future");
      if (item.validUntil !== null && item.validUntil <= now) reasons.push("expired");
      if (item.sensitivity === "restricted") reasons.push("restricted");
      if (!policyVisible) reasons.push("withdrawn");
      if (memoryTrust(item) === "untrusted") reasons.push("untrusted");
      if (!reader.engine.isReviewCommitted(profileId, item)) reasons.push("review-source-denied");
      const ids = searchIds(reader.engine, profileId, item, now), expectedVisible = reasons.length === 0;
      if (projectedSearch(reader, paths, profileId, item, now).includes(item.id) !== expectedVisible) fail("MEMORY_ROLLBACK_LEGACY_SEARCH_FAILED", "旧引擎真实记录的个体检索与记忆可见性不一致");
      for (const id of ids) fullSearchReturned.add(id);
      // Search all returned records too: result truncation must never hide a
      // visibility leak of a sibling claim carrying a revoked source.
      for (const id of ids) {
        const found = reader.store.get(profileId, id);
        if (!found || found.status !== "active" || found.sensitivity === "restricted"
          || found.validFrom > now || found.validUntil !== null && found.validUntil <= now
          || !reader.policy.isMemoryVisible(profileId, found)) fail("MEMORY_ROLLBACK_LEGACY_SEARCH_FAILED", "旧引擎检索泄露不可见记忆");
      }
      if (expectedVisible) visibleIds.push(item.id); else excluded.push({ id: item.id, reasons });
    }
    const future = futureAuthorization(paths, profileId, plan, target.revision, reader.state, now, check);
    check();
    result = { valid: true, legacySearchVerified: true, withdrawalVerified: true, futureAuthorizationVerified: true,
      legacyRevision: target.revision, recallRevision: reader.state.revision, visibleIds, excluded, future,
      individualSearchProjectionVerified: true, fullSearchReturnedIds: [...fullSearchReturned].sort(),
      authorityHash: before.sha256, authorityFileCount: before.files.length, ...(authorizationEvidence || {}) };
  } finally {
    reader?.close();
    authorization?.close();
    const after = authorityCapture(paths, profileId, plan);
    if (stable(after) !== stable(before)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "旧引擎验收前后权威文件字节或身份改变");
  }
  return freeze({ ...result, authorityPreserved: true });
}

function validateCaptureInput(profileId, plan) {
  if (typeof profileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(profileId)
    || !plan || typeof plan !== "object" || Array.isArray(plan) || !plan.snapshot
    || typeof plan.snapshot !== "object" || Array.isArray(plan.snapshot)
    || plan.profileId !== undefined && plan.profileId !== profileId) fail("MEMORY_ROLLBACK_PLAN_INVALID", "只读来源捕获输入无效");
  for (const key of ["backupFiles", "legacyFiles", "files"]) {
    if (plan.snapshot[key] !== undefined && !Array.isArray(plan.snapshot[key])) fail("MEMORY_ROLLBACK_PLAN_INVALID", "只读来源文件列表无效");
  }
  for (const key of ["product", "core"]) {
    if (plan.snapshot[key]?.files !== undefined && !Array.isArray(plan.snapshot[key].files)) fail("MEMORY_ROLLBACK_PLAN_INVALID", "只读数据库来源列表无效");
  }
}
function captureLegacyRollbackAuthority({ paths, profileId, plan } = {}) {
  validateCaptureInput(profileId, plan);
  return freeze(authorityCapture(paths, profileId, plan));
}
function captureLegacyRollbackAuxiliaryAuthority({ paths, profileId, plan, ownedSnapshotArtifactsNames = [] } = {}) {
  validateCaptureInput(profileId, plan);
  // The apply protocol must first verify the exact path/inode/content of each
  // allowed artifact. This narrower capture cannot authorize or clean it.
  return freeze(authorityCapture(paths, profileId, plan, true, ownedSnapshotArtifactsNames));
}
module.exports = { verifyLegacyRollback, captureLegacyRollbackAuthority, captureLegacyRollbackAuxiliaryAuthority, captureLegacyAuthorizationSnapshot };
