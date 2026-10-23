"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MemoryStore } = require("../memory-store");
const { atomicWritePrivateFile, validatePrivateStat, fsyncPrivateParent } = require("../private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("../security");
const { StoppedMemoryRollbackPlanner, MAX_PLAN_BYTES } = require("./rollback-planner.cjs");
const { sha256 } = require("./migration.cjs");
const { authorizationPlanBinding: originalAuthorizationPlanBinding } = require("./legacy-authorization-verifier.cjs");

const { acceptedReviewPlanBinding } = require("./legacy-accepted-review-verifier.cjs");
const authorizationPlanBinding = plan => ({ ...originalAuthorizationPlanBinding(plan), ...acceptedReviewPlanBinding(plan) });

const MAX_JOURNAL = 256 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw serviceError(code, message); };
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const frozen = value => { if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

// This offline transaction writes only proven v1 MemoryItems. It does not
// select an owner, rewrite policy receipts, or repair any other transaction.
class StoppedMemoryRollbackApply {
  constructor({ migration, paths, fault = () => {} }) {
    this.migration = migration; this.paths = paths; this.fault = fault;
    this.planner = new StoppedMemoryRollbackPlanner({ migration, paths });
  }
  locations(profileId, operationId) {
    if (!ID.test(operationId || "")) fail("MEMORY_ROLLBACK_OPERATION_INVALID", "回退事务标识无效");
    const source = this.migration.locations(profileId);
    const directory = path.join(source.directory, "rollback-applies", operationId);
    return { ...source, operationDirectory: directory, intentPath: path.join(directory, "intent.json"),
      receiptPath: path.join(directory, "receipt.json"), artifactsPath: path.join(directory, "artifacts.json"),
      journalOwnershipPath: path.join(directory, "journal-ownership.json"),
      preparationPath: path.join(directory, "preparation.json"),
      activePath: path.join(source.directory, "rollback-apply-active.json"),
      journalPath: path.join(source.profileDir, "memory", "events.jsonl"),
      snapshotPath: path.join(source.profileDir, "memory", "snapshot.json") };
  }
  readJson(target) { return JSON.parse(this.planner.read(target, MAX_PLAN_BYTES).data.toString("utf8")); }
  publicationBytes(target) {
    this.planner.owned(target);
    const stat = fs.lstatSync(target);
    if (stat.nlink === 1) return this.planner.read(target, MAX_PLAN_BYTES).data;
    const prepared = target + ".prepared", pending = exists(prepared) && fs.lstatSync(prepared);
    const safe = value => value && value.isFile() && !value.isSymbolicLink() && value.nlink === 2
      && value.size <= MAX_PLAN_BYTES && (value.mode & 0o077) === 0
      && (typeof process.getuid !== "function" || value.uid === process.getuid());
    if (!safe(stat) || !safe(pending) || stat.dev !== pending.dev || stat.ino !== pending.ino) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "不可变事务发布的链接前像不唯一");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!safe(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "不可变事务发布 inode 变化");
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(target);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || named.dev !== stat.dev || named.ino !== stat.ino
        || bytes.length !== stat.size) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "不可变事务发布内容在读取时变化");
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  publish(target, value, pins, check = () => {}) {
    check();
    const text = stable(value) + "\n";
    if (Buffer.byteLength(text) > MAX_PLAN_BYTES) fail("MEMORY_ROLLBACK_PLAN_TOO_LARGE", "回退事务超过容量限制");
    if (pins) this.planner.assertDirectories(pins);
    this.planner.owned(path.dirname(target), true);
    if (exists(target)) {
      if (!this.publicationBytes(target).equals(Buffer.from(text))) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "不可变回退事务发生冲突");
      this.planner.recoverPublication(target, target + ".prepared", text);
      check();
      if (pins) this.planner.assertDirectories(pins);
      return sha256(text);
    }
    const prepared = target + ".prepared";
    if (exists(prepared)) {
      if (!this.planner.read(prepared, MAX_PLAN_BYTES).data.equals(Buffer.from(text))) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "回退准备文件发生冲突");
    } else atomicWritePrivateFile(prepared, text, { trustedRoot: this.paths.trustedRoot });
    const publicationFault = stage => {
      if (value.format === "shoggoth-stopped-memory-rollback-apply") this.fault(stage, value.profileId,
        { operationId: value.operationId, intentPath: target, target, applyIntentHash: sha256(text) });
    };
    publicationFault("rollback-apply-intent-prepared");
    check();
    if (pins) this.planner.assertDirectories(pins);
    fs.linkSync(prepared, target); fsyncPrivateParent(path.dirname(target));
    publicationFault("rollback-apply-intent-linked");
    check();
    // Only this exact exclusive publication pair may temporarily have two links.
    const a = fs.lstatSync(prepared), b = fs.lstatSync(target);
    if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 2 || b.nlink !== 2) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "回退事务发布身份无效");
    if (pins) this.planner.assertDirectories(pins);
    fs.unlinkSync(prepared); fsyncPrivateParent(path.dirname(target));
    check();
    if (pins) this.planner.assertDirectories(pins);
    return sha256(text);
  }
  state(store, profileId) {
    const records = store.list(profileId).sort((a, b) => a.id.localeCompare(b.id));
    return { records, contentRevisions: Object.fromEntries(records.map(item => [item.id, store.getContentRevision(profileId, item.id)])),
      writeProofs: Object.fromEntries(records.map(item => [item.id, store.getItemWriteProof(profileId, item.id)])) };
  }
  sourceArtifacts(locations) {
    this.planner.owned(path.dirname(locations.journalPath), true);
    return fs.readdirSync(path.dirname(locations.journalPath)).filter(name => name === "snapshot.json.tmp" || name.startsWith("snapshot.json.backup-"));
  }
  activeValue(profileId, options) { return { schemaVersion: 1, profileId, operationId: options.operationId, planHash: options.planHash, ownershipHash: options.ownershipHash }; }
  validateActive(active, profileId, options) {
    const expected = this.activeValue(profileId, options);
    if (Object.entries(expected).some(([key, value]) => active[key] !== value) || !Array.isArray(active.directoryIdentities)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "已有其他回退事务或不明确的目录归属");
    this.planner.assertDirectories(active.directoryIdentities);
  }
  evidencePlan(plan, locations, hashes) { return { ...plan, planHash: hashes.planHash, ownershipHash: hashes.ownershipHash,
    planPath: path.join(locations.directory, "rollback-plans", hashes.planHash, "plan.json"),
    ownershipPath: path.join(locations.directory, "rollback-plans", hashes.planHash, "ownership.json") }; }
  assertAuxiliary(operation, ownedSnapshotArtifactsNames = []) {
    const { captureLegacyRollbackAuxiliaryAuthority } = require("./legacy-rollback-verifier.cjs");
    const current = captureLegacyRollbackAuxiliaryAuthority({ paths: this.paths, profileId: operation.intent.profileId,
      plan: operation.plan, ownedSnapshotArtifactsNames });
    if (stable(current) !== stable(operation.intent.auxiliaryAuthority)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "额外记忆权威文件或目录在回退期间变化");
    this.planner.assertAuthorizationAuxiliary(operation.plan, operation.check, ownedSnapshotArtifactsNames);
    operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
  }
  prepare(profileId, options) {
    const check = this.planner.proof(options), locations = this.locations(profileId, options.operationId);
    if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now < 0)) fail("MEMORY_ROLLBACK_APPLY_INVALID", "回退验收时间无效");
    if (exists(locations.intentPath)) {
      const operation = this.load(profileId, { ...options, applyIntentHash: sha256(this.publicationBytes(locations.intentPath)) });
      const observed = this.inspect(operation);
      if (observed.count) fail("MEMORY_ROLLBACK_RECOVERY_REQUIRED", "已经开始的事务需要 apply/recover 复核");
      return this.result(operation, "prepared");
    }
    this.planner.verify(profileId, options);
    const planPath = path.join(locations.directory, "rollback-plans", options.planHash, "plan.json");
    const plan = this.readJson(planPath);
    this.planner.cas(plan.snapshot.revisions, options);
    if (!plan.mappingReady || plan.blockers.length || plan.legacyCompatibility?.blockers?.length) {
      const error = serviceError("MEMORY_ROLLBACK_MAPPING_BLOCKED", "回退存在未映射语义或旧引擎兼容阻碍");
      error.blockers = [...plan.blockers, ...(plan.legacyCompatibility?.blockers || [])]; throw error;
    }
    const { captureLegacyRollbackAuthority, captureLegacyRollbackAuxiliaryAuthority } = require("./legacy-rollback-verifier.cjs");
    const proofPlan = this.evidencePlan(plan, locations, options);
    const authorizationBinding = authorizationPlanBinding(plan);
    if (plan.authorizationSnapshot && options.now !== undefined && options.now !== plan.authorizationSnapshot.now) fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "验收时间与已发布授权前像不同");
    // Inspect all fixed authority trees before the first transaction metadata
    // publication, so a foreign temp is never discovered only after appending.
    captureLegacyRollbackAuthority({ paths: this.paths, profileId, plan: proofPlan });
    const auxiliaryAuthority = captureLegacyRollbackAuxiliaryAuthority({ paths: this.paths, profileId, plan });
    if (!plan.snapshot.auxiliaryAuthority || stable(auxiliaryAuthority) !== stable(plan.snapshot.auxiliaryAuthority)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "额外权威来源与计划生成时的前像不一致");
    check();
    if (exists(locations.intentPath + ".prepared")) {
      const intentBytes = this.planner.read(locations.intentPath + ".prepared", MAX_PLAN_BYTES).data, intent = JSON.parse(intentBytes.toString("utf8"));
      if (intent.profileId !== profileId || intent.operationId !== options.operationId || intent.planHash !== options.planHash
        || intent.ownershipHash !== options.ownershipHash || intent.sourceFingerprint !== plan.sourceFingerprint
        || stable(intent.authorizationSnapshot) !== stable(plan.authorizationSnapshot)
        || Object.entries(authorizationBinding).some(([key,value])=>intent[key] !== value)) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "intent 发布前像不属于本操作计划");
      this.planner.assertDirectories(intent.directoryIdentities);
      const active = JSON.parse(this.publicationBytes(locations.activePath).toString("utf8")); this.validateActive(active, profileId, options);
      if (stable(this.readJson(locations.preparationPath)) !== stable({ ...this.activeValue(profileId,options), sourceFingerprint: plan.sourceFingerprint,
        ...authorizationBinding, auxiliaryFingerprint: auxiliaryAuthority.sha256, directoryIdentities: active.directoryIdentities })) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "准备发布不属于已固定的 active owner");
      this.planner.assertAuthorizationAuxiliary(plan, check);
      const applyIntentHash = this.publish(locations.intentPath, intent, intent.directoryIdentities, check);
      const operation = this.load(profileId, { ...options, applyIntentHash }); this.inspect(operation);
      return this.result(operation, "prepared");
    }
    if (this.sourceArtifacts(locations).length) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "旧 snapshot 存在其他未闭合事务");
    const baselineJournal = this.planner.read(locations.journalPath, MAX_JOURNAL, true);
    if (baselineJournal.present && baselineJournal.data.length && baselineJournal.data.at(-1) !== 10) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "旧 journal 有不属于本次回退的未提交尾部");
    const ownership = this.readJson(path.join(path.dirname(planPath), "ownership.json"));
    let active;
    if (exists(locations.activePath) || exists(locations.activePath + ".prepared")) {
      active = JSON.parse((exists(locations.activePath) ? this.publicationBytes(locations.activePath)
        : this.planner.read(locations.activePath + ".prepared", MAX_PLAN_BYTES).data).toString("utf8")); this.validateActive(active, profileId, options);
    } else {
      if (exists(locations.operationDirectory)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "已有回退目录缺少事前归属证明，保留现场");
      this.planner.assertDirectories(ownership.directories);
      ensurePrivateDirectoryTree(locations.operationDirectory, this.paths.trustedRoot);
      const pins = new Map(ownership.directories.map(item => [item.path, item])), previous = this.planner.directoryPins;
      this.planner.directoryPins = pins;
      try { this.planner.owned(locations.operationDirectory, true); } finally { this.planner.directoryPins = previous; }
      active = { ...this.activeValue(profileId, options), directoryIdentities: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)) };
    }
    this.planner.assertAuthorizationAuxiliary(plan, check);
    this.publish(locations.activePath, active, active.directoryIdentities, check);
    this.fault("rollback-apply-active", profileId, { operationId: options.operationId }); check();
    const preparation = { ...this.activeValue(profileId, options), sourceFingerprint: plan.sourceFingerprint, ...authorizationBinding,
      auxiliaryFingerprint: auxiliaryAuthority.sha256, directoryIdentities: active.directoryIdentities };
    this.publish(locations.preparationPath, preparation, active.directoryIdentities, check);
    this.fault("rollback-apply-preparation", profileId, { operationId: options.operationId }); check();
    let attempt = 0;
    while (exists(path.join(locations.operationDirectory, `staging-${attempt}`))) {
      if (++attempt >= 1024) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "回退准备次数超过限制，保留现场");
    }
    const staging = path.join(locations.operationDirectory, `staging-${attempt}`), agentsDir = path.join(staging, "agents");
    ensurePrivateDirectoryTree(path.join(agentsDir, profileId, "memory"), this.paths.trustedRoot);
    this.fault("rollback-apply-staging", profileId, { operationId: options.operationId }); check();
    const stagedPaths = { ...this.paths, agentsDir };
    for (const source of plan.snapshot.legacyFiles.filter(file => file.present && ["events.jsonl", "snapshot.json"].includes(file.name))) {
      const bytes = this.planner.read(source.path, MAX_JOURNAL).data;
      if (sha256(bytes) !== source.sha256) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "旧权威来源变化");
      atomicWritePrivateFile(path.join(agentsDir, profileId, "memory", source.name), bytes, { trustedRoot: this.paths.trustedRoot });
    }
    // No batch owns a native snapshot repair. Replay a no-op plan read-only,
    // preserving an absent or legitimately lagging legacy snapshot verbatim.
    const staged = new MemoryStore({ paths: stagedPaths, readOnly: plan.journalBatches.length === 0 }); staged.open();
    const states = [], batches = [];
    let journal = baselineJournal.present ? baselineJournal.data : Buffer.alloc(0);
    const capture = index => {
      const snapshotFile = path.join(agentsDir, profileId, "memory", "snapshot.json");
      const snapshot = this.planner.read(snapshotFile, MAX_PLAN_BYTES, true);
      const file = path.join(locations.operationDirectory, `snapshot-${index}.json`);
      if (snapshot.present) {
        if (exists(file)) {
          if (!this.planner.read(file, MAX_PLAN_BYTES).data.equals(snapshot.data)) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "已保存的复演 snapshot 与当前计划不一致");
        } else atomicWritePrivateFile(file, snapshot.data, { trustedRoot: this.paths.trustedRoot });
      }
      states.push({ revision: staged.getRevision(profileId), journalBytes: journal.length, journalHash: sha256(journal),
        snapshotPath: snapshot.present ? file : null, snapshotHash: snapshot.present ? snapshot.sha256 : null, stateHash: sha256(stable(this.state(staged, profileId))) });
    };
    try {
      staged.getRevision(profileId); capture(0);
      for (let index = 0; index < plan.journalBatches.length; index++) {
        const batch = plan.journalBatches[index];
        staged.upsertMany(batch.items, { expectedRevision: batch.expectedRevision });
        const next = this.planner.read(path.join(agentsDir, profileId, "memory", "events.jsonl"), MAX_JOURNAL).data;
        const row = next.subarray(journal.length);
        if (!next.subarray(0, journal.length).equals(journal) || row.at(-1) !== 10 || row.subarray(0, -1).includes(10)
          || staged.getRevision(profileId) !== batch.expectedRevision + 1) fail("MEMORY_ROLLBACK_APPLY_INVALID", "原 Store 复演与计划批次不一致");
        batches.push({ expectedRevision: batch.expectedRevision, seq: batch.expectedRevision + 1, items: batch.items,
          row: row.toString("utf8"), rowBytes: row.length, rowHash: sha256(row) });
        journal = next; capture(index + 1); check();
      }
    } finally { staged.close(); }
    this.planner.verify(profileId, options); check();
    const directoryPins = new Map(active.directoryIdentities.map(item => [item.path, item]));
    for (const { path: directoryPath, dev, ino, uid, mode } of auxiliaryAuthority.directories) {
      const identity = { path: directoryPath, dev, ino, uid, mode }, previous = directoryPins.get(directoryPath);
      if (previous && stable(previous) !== stable(identity)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "额外权威目录与原来源证明不一致");
      directoryPins.set(directoryPath, identity);
    }
    const previous = this.planner.directoryPins; this.planner.directoryPins = directoryPins;
    try { this.planner.owned(locations.operationDirectory, true); this.planner.owned(staging, true); }
    finally { this.planner.directoryPins = previous; }
    const intent = { format: "shoggoth-stopped-memory-rollback-apply", schemaVersion: 1, profileId, operationId: options.operationId,
      planHash: options.planHash, ownershipHash: options.ownershipHash, sourceFingerprint: plan.sourceFingerprint,
      revisions: plan.snapshot.revisions, journalPath: locations.journalPath, snapshotPath: locations.snapshotPath,
      baselineJournal: this.planner.stamp(baselineJournal), baselineSnapshot: plan.snapshot.legacyFiles.find(file => file.name === "snapshot.json"),
      auxiliaryAuthority, ...authorizationBinding,
      ...(plan.authorizationSnapshot ? { authorizationSnapshot: plan.authorizationSnapshot,
        authorizationAuxiliaryAuthority: plan.snapshot.authorizationAuxiliaryAuthority } : {}),
      directoryIdentities: [...directoryPins.values()].sort((a, b) => a.path.localeCompare(b.path)), batches, states,
      canSelectLegacyWriter: false };
    const applyIntentHash = this.publish(locations.intentPath, intent, intent.directoryIdentities, check);
    const operation = { locations, intent, plan, applyIntentHash, check };
    this.fault("rollback-apply-prepared", profileId, this.details(operation));
    return this.result(operation, "prepared", 0);
  }
  load(profileId, options) {
    const check = this.planner.proof(options), locations = this.locations(profileId, options.operationId);
    if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now < 0)) fail("MEMORY_ROLLBACK_APPLY_INVALID", "回退验收时间无效");
    if (![options.planHash, options.ownershipHash, options.applyIntentHash].every(value => HASH.test(value || ""))) fail("MEMORY_ROLLBACK_APPLY_INVALID", "回退事务需要三个不可变哈希");
    const bytes = this.publicationBytes(locations.intentPath);
    if (sha256(bytes) !== options.applyIntentHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "回退 intent 哈希不匹配");
    const intent = JSON.parse(bytes.toString("utf8"));
    if (intent.format !== "shoggoth-stopped-memory-rollback-apply" || intent.schemaVersion !== 1 || intent.profileId !== profileId
      || intent.operationId !== options.operationId || intent.planHash !== options.planHash || intent.ownershipHash !== options.ownershipHash
      || intent.journalPath !== locations.journalPath || intent.snapshotPath !== locations.snapshotPath || intent.canSelectLegacyWriter !== false) fail("MEMORY_ROLLBACK_APPLY_INVALID", "回退 intent 归属无效");
    this.planner.cas(intent.revisions, options);
    this.planner.assertDirectories(intent.directoryIdentities);
    const planPath = path.join(locations.directory, "rollback-plans", options.planHash, "plan.json");
    const planBytes = this.planner.read(planPath, MAX_PLAN_BYTES).data;
    if (sha256(planBytes) !== options.planHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "原回退计划变化");
    const plan = JSON.parse(planBytes.toString("utf8"));
    const ownershipBytes = this.planner.read(path.join(path.dirname(planPath), "ownership.json"), MAX_PLAN_BYTES).data;
    if (sha256(ownershipBytes) !== options.ownershipHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "原计划归属变化");
    const ownership = JSON.parse(ownershipBytes.toString("utf8"));
    if (ownership.schemaVersion !== 1 || ownership.planHash !== options.planHash || ownership.sourceFingerprint !== intent.sourceFingerprint
      || !Array.isArray(ownership.directories)) fail("MEMORY_ROLLBACK_APPLY_INVALID", "原计划目录归属无效");
    const authorizationBinding = authorizationPlanBinding(plan);
    if (stable(intent.authorizationSnapshot) !== stable(plan.authorizationSnapshot)
      || stable(intent.authorizationAuxiliaryAuthority) !== stable(plan.snapshot.authorizationAuxiliaryAuthority)
      || Object.entries(authorizationBinding).some(([key,value])=>intent[key] !== value || ownership[key] !== value)
      || !plan.authorizationSnapshot && [intent.authorizationSnapshotHash, intent.authorizationAuthorityHash, ownership.authorizationSnapshotHash, ownership.authorizationAuthorityHash].some(value=>value !== undefined)) fail("MEMORY_ROLLBACK_APPLY_INVALID", "intent/ownership 与不可变计划的授权前像不一致");
    if (plan.authorizationSnapshot && options.now !== undefined && options.now !== plan.authorizationSnapshot.now) fail("MEMORY_ROLLBACK_AUTHORIZATION_PLAN_BINDING_REQUIRED", "恢复时间与原授权前像不同");
    this.planner.assertDirectories(ownership.directories);
    if (!plan.mappingReady || plan.blockers.length || plan.legacyCompatibility?.blockers?.length || plan.sourceFingerprint !== intent.sourceFingerprint
      || stable(plan.journalBatches) !== stable(intent.batches.map(({ expectedRevision, items }) => ({ expectedRevision, items })))) fail("MEMORY_ROLLBACK_APPLY_INVALID", "intent 与原计划映射不一致");
    const active = JSON.parse(this.publicationBytes(locations.activePath).toString("utf8"));
    this.validateActive(active, profileId, options);
    if (active.directoryIdentities.some(pin => !intent.directoryIdentities.some(actual => stable(actual) === stable(pin)))) fail("MEMORY_ROLLBACK_APPLY_INVALID", "intent 缺少原准备目录归属");
    const preparation = this.readJson(locations.preparationPath);
    if (stable(preparation) !== stable({ ...this.activeValue(profileId, options), sourceFingerprint: intent.sourceFingerprint, ...authorizationBinding,
      auxiliaryFingerprint: intent.auxiliaryAuthority?.sha256, directoryIdentities: active.directoryIdentities })) fail("MEMORY_ROLLBACK_APPLY_INVALID", "准备事务归属变化");
    if (!intent.auxiliaryAuthority || !HASH.test(intent.auxiliaryAuthority.sha256 || "") || !Array.isArray(intent.auxiliaryAuthority.files)
      || !Array.isArray(intent.auxiliaryAuthority.directories)) fail("MEMORY_ROLLBACK_APPLY_INVALID", "intent 缺少额外权威来源证明");
    if (!Array.isArray(intent.states) || intent.states.length !== intent.batches.length + 1
      || intent.states[0].revision !== intent.revisions.legacy) fail("MEMORY_ROLLBACK_APPLY_INVALID", "复演状态数量或原 revision 无效");
    for (const [index, batch] of intent.batches.entries()) {
      const row = Buffer.from(batch.row), previous = intent.states[index], next = intent.states[index + 1];
      if (row.length !== batch.rowBytes || sha256(row) !== batch.rowHash || row.at(-1) !== 10 || row.subarray(0, -1).includes(10)
        || batch.seq !== batch.expectedRevision + 1 || previous.revision !== batch.expectedRevision || next.revision !== batch.seq
        || next.journalBytes !== previous.journalBytes + row.length) fail("MEMORY_ROLLBACK_APPLY_INVALID", "复演 journal 批次证据无效");
    }
    for (const state of intent.states) if (state.snapshotPath) {
      if (state.snapshotPath !== path.join(locations.operationDirectory, `snapshot-${intent.states.indexOf(state)}.json`)
        || this.planner.read(state.snapshotPath, MAX_PLAN_BYTES).sha256 !== state.snapshotHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "复演 snapshot 证据变化");
    }
    // Do not complete even an exact prepared publication before the independent
    // active/preparation/plan ownership, staged evidence and full auxiliary CAS.
    // Completed one-link publications only read; later owned native artifacts
    // remain subject to their exact journal/intent proof in recoverArtifacts.
    const operation = { locations, intent, plan, applyIntentHash: options.applyIntentHash, check };
    const publicationCheck = target => () => {
      check();
      if (fs.lstatSync(target).nlink !== 1) this.assertAuxiliary(operation);
    };
    this.publish(locations.intentPath, intent, intent.directoryIdentities, publicationCheck(locations.intentPath));
    this.publish(locations.activePath, active, intent.directoryIdentities, publicationCheck(locations.activePath));
    check(); return operation;
  }
  details(operation, index) { return { operationId: operation.intent.operationId, index, journalPath: operation.locations.journalPath,
    snapshotPath: operation.locations.snapshotPath, expectedRow: index === undefined ? undefined : operation.intent.batches[index]?.row,
    applyIntentHash: operation.applyIntentHash }; }
  result(operation, phase, completedBatches = 0) { return frozen({ profileId: operation.intent.profileId, operationId: operation.intent.operationId,
    planHash: operation.intent.planHash, ownershipHash: operation.intent.ownershipHash, applyIntentHash: operation.applyIntentHash,
    sourceFingerprint: operation.intent.sourceFingerprint, ...authorizationPlanBinding(operation.plan), preparedRevisions: operation.intent.revisions,
    intentPath: operation.locations.intentPath, receiptPath: operation.locations.receiptPath, operationDirectory: operation.locations.operationDirectory,
    phase, completedBatches, actualRevision: operation.intent.states[completedBatches].revision,
    journalHash: operation.intent.states[completedBatches].journalHash, canSelectLegacyWriter: false }); }
  assertOtherFiles(operation) {
    const snapshot = operation.plan.snapshot, { journalPath, snapshotPath } = operation.locations;
    const files = [snapshot.manifest, snapshot.legacySnapshot, ...snapshot.backupFiles, ...snapshot.legacyFiles,
      ...snapshot.files, ...snapshot.product.files, ...snapshot.core.files];
    operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
    for (const file of files) if (![journalPath, snapshotPath].includes(file.path)) {
      const actual = this.planner.read(file.path, MAX_JOURNAL, true);
      if (!this.planner.sameStamp(actual, file)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退期间其他权威来源发生变化");
    }
    const canonical = this.planner.workspaceFiles(operation.locations);
    if (stable(canonical.map(file => ({ ...this.planner.stamp(file), text: file.text }))) !== stable(snapshot.files)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "canonical 文件集合发生变化");
    operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
  }
  ensureJournal(operation) {
    if (operation.intent.baselineJournal.present) return;
    if (!exists(operation.locations.journalPath)) {
      this.assertAuxiliary(operation); operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      const fd = fs.openSync(operation.locations.journalPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      let identity;
      try { const stat = validatePrivateStat(fs.fstatSync(fd), operation.locations.journalPath); identity = { dev: stat.dev, ino: stat.ino }; fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fsyncPrivateParent(path.dirname(operation.locations.journalPath));
      this.publish(operation.locations.journalOwnershipPath, { schemaVersion: 1, applyIntentHash: operation.applyIntentHash, identity }, operation.intent.directoryIdentities, operation.check);
    }
    this.journalProof(operation, this.planner.read(operation.locations.journalPath, MAX_JOURNAL));
  }
  journalProof(operation, source) {
    if (!exists(operation.locations.journalOwnershipPath)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "新建 journal 没有本事务已发布证明，保留现场");
    const proof = JSON.parse(this.publicationBytes(operation.locations.journalOwnershipPath).toString("utf8"));
    const expected = { schemaVersion: 1, applyIntentHash: operation.applyIntentHash, identity: { dev: source.identity.dev, ino: source.identity.ino } };
    if (stable(proof) !== stable(expected)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "新建 journal inode 归属无效或已被替换");
    this.publish(operation.locations.journalOwnershipPath, proof, operation.intent.directoryIdentities, operation.check);
  }
  inspect(operation, { allowTail = false } = {}) {
    const { intent, locations } = operation; operation.check(); this.planner.assertDirectories(intent.directoryIdentities);
    for (const [target, expectedHash] of [[locations.intentPath, operation.applyIntentHash],
      [path.join(locations.directory, "rollback-plans", intent.planHash, "plan.json"), intent.planHash],
      [path.join(locations.directory, "rollback-plans", intent.planHash, "ownership.json"), intent.ownershipHash]]) {
      if (this.planner.read(target, MAX_PLAN_BYTES).sha256 !== expectedHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "事务不可变哈希在执行期间变化");
    }
    const active = this.readJson(locations.activePath); this.validateActive(active, intent.profileId, intent);
    if (stable(this.readJson(locations.preparationPath)) !== stable({ ...this.activeValue(intent.profileId, intent),
      sourceFingerprint: intent.sourceFingerprint, ...authorizationPlanBinding(operation.plan), auxiliaryFingerprint: intent.auxiliaryAuthority.sha256,
      directoryIdentities: active.directoryIdentities })) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "准备事务在执行期间变化");
    const source = this.planner.read(locations.journalPath, MAX_JOURNAL, true), bytes = source.present ? source.data : Buffer.alloc(0);
    if (intent.baselineJournal.present && (!source.present || source.identity.dev !== intent.baselineJournal.identity.dev
      || source.identity.ino !== intent.baselineJournal.identity.ino)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "旧 journal inode 已被替换");
    if (!intent.baselineJournal.present && source.present) {
      this.journalProof(operation, source);
    }
    const initial = intent.states[0];
    if (bytes.length < initial.journalBytes || sha256(bytes.subarray(0, initial.journalBytes)) !== initial.journalHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "旧 journal 原字节前缀发生变化");
    let count = 0, offset = initial.journalBytes;
    for (const batch of intent.batches) {
      const row = Buffer.from(batch.row);
      if (bytes.length - offset < row.length) break;
      if (!bytes.subarray(offset, offset + row.length).equals(row)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "journal 包含其他写入或未知批次");
      offset += row.length; count++;
    }
    const tail = bytes.subarray(offset);
    if (tail.length && (!allowTail || count === intent.batches.length || tail.includes(10)
      || !Buffer.from(intent.batches[count].row).subarray(0, tail.length).equals(tail))) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "journal 尾部不属于本事务下一批");
    const snapshot = this.planner.read(locations.snapshotPath, MAX_PLAN_BYTES, true);
    const permitted = new Set(intent.states.slice(0, count + 1).map(state => state.snapshotHash));
    if (intent.baselineSnapshot?.present) permitted.add(intent.baselineSnapshot.sha256);
    if (snapshot.present ? !permitted.has(snapshot.sha256) : intent.baselineSnapshot?.present) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "旧 snapshot 不属于已证明的 journal 前缀");
    const current = this.planner.capture(intent.profileId, operation.check, { acceptedReviewProof: operation.plan.snapshot.acceptedReviewProof }).capture;
    const readonly = new MemoryStore({ paths: this.paths, readOnly: true }); readonly.open();
    try { if (sha256(stable(this.state(readonly, intent.profileId))) !== intent.states[count].stateHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "旧 Store replay 与本事务前缀不一致"); }
    finally { readonly.close(); }
    // These two files and replay-derived fields are the only allowed deltas;
    // their exact bytes/state were checked above before normalization.
    if (intent.batches.length) {
      current.legacyFiles = current.legacyFiles.map(file => [locations.journalPath, locations.snapshotPath].includes(file.path)
        ? operation.plan.snapshot.legacyFiles.find(original => original.path === file.path) : file);
      current.legacyRecords = operation.plan.snapshot.legacyRecords;
      current.legacyContentRevisions = operation.plan.snapshot.legacyContentRevisions;
      if (Object.hasOwn(current, "legacyWriteProofs")) current.legacyWriteProofs = operation.plan.snapshot.legacyWriteProofs;
      current.revisions.legacy = intent.revisions.legacy;
    }
    if (sha256(stable(current)) !== intent.sourceFingerprint) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "回退期间其他权威来源发生变化");
    operation.check(); this.planner.assertDirectories(intent.directoryIdentities);
    this.assertAuxiliary(operation);
    return { count, offset, tail, source };
  }
  fileSystem(operation, index) {
    const api = Object.create(fs), descriptors = new Map(), details = this.details(operation, index);
    const emit = stage => this.fault(stage, operation.intent.profileId, details);
    const audit = (target, stat, bytes) => {
      let records = exists(operation.locations.artifactsPath) ? this.readJson(operation.locations.artifactsPath) : { schemaVersion: 1, applyIntentHash: operation.applyIntentHash, files: [] };
      if (records.applyIntentHash !== operation.applyIntentHash) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 证据归属冲突");
      records.files = records.files.filter(file => file.path !== target);
      records.files.push({ path: target, dev: stat.dev, ino: stat.ino, bytes: bytes?.length, sha256: bytes && sha256(bytes) });
      atomicWritePrivateFile(operation.locations.artifactsPath, stable(records) + "\n", { trustedRoot: this.paths.trustedRoot });
    };
    api.openSync = (target, flags, mode) => {
      operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      const writing = Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR));
      const before = target === operation.locations.journalPath && writing ? this.inspect(operation) : null;
      const fd = fs.openSync(target, flags, mode);
      try {
        const opened = fs.fstatSync(fd);
        if (before && (!before.source.present || opened.dev !== before.source.identity.dev || opened.ino !== before.source.identity.ino
          || opened.size !== before.source.bytes)) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "journal 在打开写入时发生变化");
        descriptors.set(fd, { target, writing });
        if (target === operation.locations.snapshotPath + ".tmp") audit(target, opened, Buffer.alloc(0));
        operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities); return fd;
      } catch (error) { descriptors.delete(fd); fs.closeSync(fd); throw error; }
    };
    const writableJournal = fd => descriptors.get(fd)?.target === operation.locations.journalPath && descriptors.get(fd).writing;
    api.writeSync = (...args) => {
      if (writableJournal(args[0])) {
        const observed = this.inspect(operation, { allowTail: true }), opened = fs.fstatSync(args[0]);
        if (opened.dev !== observed.source.identity.dev || opened.ino !== observed.source.identity.ino || opened.size !== observed.source.bytes
          || observed.count !== index) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "journal 在实际写入前变化");
        const actual = args[1].subarray(args[2], args[2] + args[3]), expected = Buffer.from(operation.intent.batches[index].row).subarray(observed.tail.length, observed.tail.length + actual.length);
        if (!actual.equals(expected)) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "原 Store 待写 row 与复演证据不同");
      }
      const result = fs.writeSync(...args); if (writableJournal(args[0])) emit("rollback-apply-journal-write"); return result;
    };
    api.fsyncSync = fd => { fs.fsyncSync(fd); if (writableJournal(fd)) emit("rollback-apply-journal-fsynced"); };
    api.closeSync = fd => {
      const descriptor = descriptors.get(fd); descriptors.delete(fd); fs.closeSync(fd);
      if (descriptor?.target === operation.locations.snapshotPath + ".tmp" && exists(descriptor.target)) {
        const data = this.planner.read(descriptor.target, MAX_PLAN_BYTES); audit(descriptor.target, fs.lstatSync(descriptor.target), data.data);
      }
      if (descriptor?.target === operation.locations.journalPath && descriptor.writing) emit("rollback-apply-journal-closed");
    };
    api.linkSync = (source, target) => { operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      const read = this.planner.read(source, MAX_PLAN_BYTES); audit(target, fs.lstatSync(source), read.data); return fs.linkSync(source, target); };
    api.renameSync = (source, target) => {
      operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      if (target === operation.locations.snapshotPath) {
        const read = this.planner.read(source, MAX_PLAN_BYTES), permitted = new Set(operation.intent.states.map(state => state.snapshotHash));
        if (operation.intent.baselineSnapshot?.present) permitted.add(operation.intent.baselineSnapshot.sha256);
        if (!permitted.has(read.sha256)) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "原 Store 待发布 snapshot 与复演证据不符");
      }
      const result = fs.renameSync(source, target);
      operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      if (target === operation.locations.snapshotPath) emit("rollback-apply-snapshot"); return result;
    };
    api.unlinkSync = target => { operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities); return fs.unlinkSync(target); };
    return api;
  }
  recoverArtifacts(operation) {
    const names = this.sourceArtifacts(operation.locations);
    if (!names.length) return;
    if (!exists(operation.locations.artifactsPath)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 事务缺少本操作身份凭据");
    const proof = this.readJson(operation.locations.artifactsPath);
    if (proof.applyIntentHash !== operation.applyIntentHash || !Array.isArray(proof.files)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 事务身份凭据无效");
    this.assertOtherFiles(operation);
    const journal = this.planner.read(operation.locations.journalPath, MAX_JOURNAL, true), journalBytes = journal.present ? journal.data : Buffer.alloc(0);
    if (!operation.intent.baselineJournal.present && journal.present) this.journalProof(operation, journal);
    const baseline = operation.intent.states[0];
    if (journalBytes.length < baseline.journalBytes || sha256(journalBytes.subarray(0, baseline.journalBytes)) !== baseline.journalHash
      || operation.intent.baselineJournal.present && (!journal.present || journal.identity.dev !== operation.intent.baselineJournal.identity.dev
        || journal.identity.ino !== operation.intent.baselineJournal.identity.ino)) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "snapshot 恢复前 journal 前像变化");
    const expectedTail = Buffer.from(operation.intent.batches.map(batch => batch.row).join("")), actualTail = journalBytes.subarray(baseline.journalBytes);
    if (actualTail.length > expectedTail.length || !actualTail.equals(expectedTail.subarray(0, actualTail.length))) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 恢复前 journal 含其他写入");
    const snapshots = operation.intent.states.filter(state => state.snapshotPath).map(state => this.planner.read(state.snapshotPath, MAX_PLAN_BYTES).data);
    const removals = [];
    for (const name of names) {
      const target = path.join(path.dirname(operation.locations.snapshotPath), name), stat = fs.lstatSync(target);
      const owned = proof.files.find(file => file.path === target && file.dev === stat.dev && file.ino === stat.ino);
      if (!owned || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLAN_BYTES || (stat.mode & 0o077)
        || typeof process.getuid === "function" && stat.uid !== process.getuid()
        || name !== "snapshot.json.tmp" && !/^snapshot\.json\.backup-[1-9][0-9]*-[a-f0-9]{16}$/.test(name)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 残留不属于本次操作");
      if (stat.nlink === 2) {
        const current = fs.lstatSync(operation.locations.snapshotPath);
        if (name === "snapshot.json.tmp" || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 2) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 残留链接身份不唯一");
      } else if (stat.nlink !== 1) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 残留链接无效");
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "snapshot 残留打开时变化");
        bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd), named = fs.lstatSync(target);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || named.dev !== stat.dev || named.ino !== stat.ino
          || named.nlink !== stat.nlink || bytes.length !== stat.size) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "snapshot 残留读取时变化");
      } finally { fs.closeSync(fd); }
      if (name === "snapshot.json.tmp" ? !snapshots.some(expected => bytes.length <= expected.length && bytes.equals(expected.subarray(0, bytes.length)))
        : owned.bytes !== bytes.length || owned.sha256 !== sha256(bytes)) fail("MEMORY_ROLLBACK_FOREIGN_TRANSACTION", "snapshot 残留内容不属于复演证据");
      removals.push({ target, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // Journal bytes are authoritative. These are only audited, exact native
    // snapshot artifacts, never a wildcard cleanup of another transaction.
    for (const removal of removals) {
      this.assertOtherFiles(operation); this.assertAuxiliary(operation, names); const stat = fs.lstatSync(removal.target);
      if (["dev", "ino", "size", "mtimeMs"].some(key => stat[key] !== removal[key])) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "snapshot 残留删除前变化");
      fs.unlinkSync(removal.target);
    }
    fsyncPrivateParent(path.dirname(operation.locations.snapshotPath));
  }
  execute(profileId, options, recovery) {
    const operation = this.load(profileId, options);
    if (recovery) this.recoverArtifacts(operation);
    else if (this.sourceArtifacts(operation.locations).length) fail("MEMORY_ROLLBACK_RECOVERY_REQUIRED", "本次 snapshot 事务需要显式恢复");
    let observed = this.inspect(operation, { allowTail: recovery });
    if (observed.tail.length) {
      this.assertAuxiliary(operation); operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
      const fd = fs.openSync(operation.locations.journalPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      try { const stat = validatePrivateStat(fs.fstatSync(fd), operation.locations.journalPath);
        if (stat.dev !== observed.source.identity.dev || stat.ino !== observed.source.identity.ino || stat.size !== observed.source.bytes
          || sha256(fs.readFileSync(fd)) !== observed.source.sha256) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "恢复前 journal 身份或字节变化");
        this.assertAuxiliary(operation); operation.check(); this.planner.assertDirectories(operation.intent.directoryIdentities);
        fs.ftruncateSync(fd, observed.offset); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      observed = this.inspect(operation);
    }
    if (operation.intent.batches.length) this.ensureJournal(operation);
    for (let index = observed.count; index < operation.intent.batches.length; index++) {
      this.inspect(operation); operation.check();
      this.fault("rollback-apply-before-batch", profileId, this.details(operation, index));
      this.inspect(operation);
      const store = new MemoryStore({ paths: this.paths, fs: this.fileSystem(operation, index) }); store.open();
      try { store.upsertMany(operation.intent.batches[index].items, { expectedRevision: operation.intent.batches[index].expectedRevision }); }
      finally { store.close(); }
      const actual = this.inspect(operation);
      if (actual.count !== index + 1) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "批次提交与实际 journal 不一致");
      this.fault("rollback-apply-after-batch", profileId, this.details(operation, index));
    }
    // A completed row with a stale snapshot is a native uncertain commit. Its
    // validated replay may repair this transaction's snapshot without a new row.
    observed = this.inspect(operation);
    const expected = operation.intent.states[observed.count];
    const snapshot = this.planner.read(operation.locations.snapshotPath, MAX_PLAN_BYTES, true);
    if ((snapshot.sha256 ?? null) !== expected.snapshotHash) {
      if (!operation.intent.batches.length) fail("MEMORY_ROLLBACK_SOURCE_CHANGED", "零批回退不能修复其他旧 snapshot 事务");
      const store = new MemoryStore({ paths: this.paths, fs: this.fileSystem(operation, Math.max(0, observed.count - 1)) }); store.open();
      try { store.getRevision(profileId); } finally { store.close(); }
    }
    const result = this.verify(profileId, options);
    this.publish(operation.locations.receiptPath, result, operation.intent.directoryIdentities, operation.check);
    this.fault("rollback-apply-completed", profileId, this.details(operation));
    return result;
  }
  apply(profileId, options) { return this.execute(profileId, options, false); }
  recover(profileId, options) { return this.execute(profileId, options, true); }
  verify(profileId, options) {
    const operation = this.load(profileId, options);
    if (this.sourceArtifacts(operation.locations).length) fail("MEMORY_ROLLBACK_RECOVERY_REQUIRED", "snapshot 事务仍未闭合");
    const observed = this.inspect(operation);
    if (observed.count !== operation.intent.batches.length) fail("MEMORY_ROLLBACK_APPLY_INCOMPLETE", "新事实尚未全部写入旧 journal");
    const expected = operation.intent.states[observed.count], snapshot = this.planner.read(operation.locations.snapshotPath, MAX_PLAN_BYTES, true);
    if ((snapshot.sha256 ?? null) !== expected.snapshotHash) fail("MEMORY_ROLLBACK_RECOVERY_REQUIRED", "旧 snapshot 仍需本事务恢复");
    const targets = new Map(operation.plan.snapshot.legacyRecords.map(item => [item.id, item]));
    for (const batch of operation.intent.batches) for (const item of batch.items) targets.set(item.id, item);
    const assertCurrent = () => {
      const current = this.inspect(operation), actualSnapshot = this.planner.read(operation.locations.snapshotPath, MAX_PLAN_BYTES, true);
      if (current.count !== operation.intent.batches.length || (actualSnapshot.sha256 ?? null) !== expected.snapshotHash) fail("MEMORY_ROLLBACK_APPLY_CONFLICT", "检索验收期间 journal/snapshot 发生变化");
      return true;
    };
    const { verifyLegacyRollback } = require("./legacy-rollback-verifier.cjs");
    const verifierPlan = this.evidencePlan(operation.plan, operation.locations, operation.intent);
    const legacy = verifyLegacyRollback({ paths: this.paths, profileId, plan: verifierPlan,
      expectedRecords: [...targets.values()], now: operation.plan.authorizationSnapshot?.now ?? options.now ?? Date.now(), assertCurrent,
      authorizationSnapshot: operation.plan.authorizationSnapshot });
    if (legacy.valid !== true || legacy.legacySearchVerified !== true || legacy.legacyRevision !== expected.revision
      || legacy.recallRevision !== operation.intent.revisions.recall || legacy.authorityPreserved !== true) fail("MEMORY_ROLLBACK_LEGACY_VERIFY_FAILED", "原检索/撤回验收结果不完整");
    assertCurrent();
    return frozen({ ...this.result(operation, "applied", observed.count), storageVerified: true, legacySearchVerified: true, legacyVerification: legacy,
      canSelectLegacyWriter: false });
  }
}

module.exports = { StoppedMemoryRollbackApply };
