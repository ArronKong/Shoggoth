"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, validatePrivateStat, writeFully } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { validateCanonicalOwnedDirectory, sameIdentity } = require("./runtime-storage-inspector");

const SCHEMA_VERSION = 1;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
// Larger full bodies cannot enter the conversation recall index. Keep their
// exact hash protection while bounding the cached literals used for wrappers.
const MAX_SOURCE_LITERAL_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REASONS = new Set(["forgotten", "user_deleted", "expired", "legacy_unknown"]);
const SUPPRESSING_REASONS = new Set(["forgotten", "user_deleted", "legacy_unknown"]);

function policyError(code, message) { return serviceError(code, message); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function checksum(value) {
  const copy = { ...value };
  delete copy.checksum;
  return crypto.createHash("sha256").update(stableJson(copy)).digest("hex");
}
function normalizeContent(value) { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(); }
function hashContent(value) { return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex"); }
function earliestContentCutoff(state) {
  let earliest = Infinity;
  for (const cutoff of state.contentCutoffs.values()) earliest = Math.min(earliest, cutoff.createdAt);
  return earliest;
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function assertId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw policyError("RECALL_POLICY_INVALID", `${field} 无效`);
  return value;
}
function fileIdentity(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
function sourceRefs(item) {
  // Product saves use [source event, run, optional workspace]. Older imports
  // and UI writes have no transcript identity; their content is matched below.
  return item.sourceRefs.filter((ref) => !/^(?:workspace:|user-edit:|codex-memory:)/u.test(ref));
}

class RecallPolicyStore {
  constructor(options) {
    this.paths = options.paths;
    this.memoryStore = options.memoryStore;
    this.transcriptStore = options.transcriptStore || null;
    this.chatSessionStore = options.chatSessionStore || null;
    this.strictSourceResolution = options.strictSourceResolution === true;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.states = new Map();
    this.onChange = null;
    this.indexPending = new Set();
    this.opened = false;
  }
  setOnChange(callback) {
    if (callback !== null && typeof callback !== "function") throw new TypeError("RecallPolicy callback 无效");
    this.onChange = callback;
  }
  _notifyIndex(profileId) {
    if (!this.onChange) return;
    try { this.onChange(profileId); this.indexPending.delete(profileId); }
    catch { this.indexPending.add(profileId); }
  }
  open(profileIds = []) {
    if (this.opened) return;
    this.opened = true;
    // A damaged Profile must not stop the user's audit/repair UI or healthy
    // Profiles from starting. Its own Agent reads still fail closed.
    for (const profileId of profileIds) {
      try { this.assertReady(profileId); }
      catch (error) { if (error.code !== "RECALL_POLICY_UNAVAILABLE") throw error; }
    }
  }
  close() { this.opened = false; this.states.clear(); this.indexPending.clear(); }
  forgetProfile(profileId) {
    this.states.delete(profileId); this.indexPending.delete(profileId);
    // Called only by the full Profile purge, after its authority data is gone.
    const targets = this._paths(profileId);
    if (!lstatIfExists(targets.installationDir)) return;
    const directory = validateCanonicalOwnedDirectory(targets.installationDir,
      { trustedRoot: this.paths.trustedRoot });
    const anchor = lstatIfExists(targets.installation);
    if (anchor) {
      validatePrivateStat(anchor, targets.installation);
      this.fs.unlinkSync(targets.installation);
    }
    // Fsync even when the file is already absent. A prior attempt may have
    // unlinked it but failed before making the directory update durable.
    const fd = this.fs.openSync(targets.installationDir,
      this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
    try {
      if (!sameIdentity(directory, this.fs.fstatSync(fd))) {
        throw policyError("RECALL_POLICY_UNAVAILABLE", "撤回账本安装目录在清理时改变");
      }
      this.fs.fsyncSync(fd);
    } finally { this.fs.closeSync(fd); }
  }
  _paths(profileId) {
    const profileDir = path.join(this.paths.agentsDir, assertId(profileId, "profileId"));
    const dir = path.join(profileDir, "memory");
    const installationDir = path.join(this.paths.agentsDir, ".recall-policy-installations");
    return { dir, log: path.join(dir, "recall-policy.jsonl"), seal: path.join(dir, "recall-policy.seal.json"),
      marker: path.join(profileDir, "recall-policy-installed.json"),
      installationDir, installation: path.join(installationDir, `${profileId}.json`) };
  }
  _unavailable(cause) {
    const error = policyError("RECALL_POLICY_UNAVAILABLE", "撤回账本不可验证，已暂停 Agent 记忆读取");
    error.cause = cause;
    return error;
  }
  _init(profileId, targets) {
    const init = { schemaVersion: SCHEMA_VERSION, seq: 1, type: "recall.init", profileId,
      createdAt: this.now() };
    init.checksum = checksum(init);
    const lines = [init];
    for (const item of this.memoryStore.list(profileId, { status: "deleted" })) {
      lines.push(this._record(profileId, lines.length + 1, item, "legacy_unknown",
        `legacy-${crypto.createHash("sha256").update(item.id).digest("hex")}`, this.now()));
    }
    this._writeInstallation(profileId, targets, init.checksum, lines.at(-1).seq,
      lines.at(-1).checksum);
    atomicWritePrivateFile(targets.log, `${lines.map(stableJson).join("\n")}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
    this._writeSeal(profileId, targets, init.checksum);
    this._writeMarker(profileId, targets, init.checksum, lines.at(-1).seq, lines.at(-1).checksum);
  }
  _writeMarker(profileId, targets, initChecksum, headSeq, headChecksum) {
    // This independent marker is written before an intent is appended. A crash
    // between the two writes blocks reads instead of forgetting that intent.
    const marker = { schemaVersion: SCHEMA_VERSION, profileId, initChecksum, headSeq, headChecksum };
    marker.checksum = checksum(marker);
    atomicWritePrivateFile(targets.marker, `${stableJson(marker)}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
  }
  _writeInstallation(profileId, targets, initChecksum, headSeq, headChecksum) {
    // This lives outside the Profile directory and advances before either
    // local marker or journal. Losing or rolling back all three local files
    // cannot turn an installed Profile into a first-time migration.
    const installation = { schemaVersion: SCHEMA_VERSION, profileId, initChecksum,
      headSeq, headChecksum };
    installation.checksum = checksum(installation);
    atomicWritePrivateFile(targets.installation, `${stableJson(installation)}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
  }
  _writeSeal(profileId, targets, initChecksum) {
    const seal = { schemaVersion: SCHEMA_VERSION, profileId, initChecksum };
    seal.checksum = checksum(seal);
    atomicWritePrivateFile(targets.seal, `${stableJson(seal)}\n`, {
      fs: this.fs, trustedRoot: this.paths.trustedRoot,
    });
  }
  _record(profileId, seq, item, reason, operationId, createdAt, relatedItems = [], revocationSourceRefs = []) {
    const refs = [...new Set([...sourceRefs(item), ...revocationSourceRefs])];
    const record = { schemaVersion: SCHEMA_VERSION, seq, type: "recall.reason", profileId,
      operationId, memoryId: item.id, memoryRevision: this.memoryStore.getRevision(profileId),
      contentHash: hashContent(item.content), normalizedContent: normalizeContent(item.content),
      sourceRefs: refs,
      related: relatedItems.filter((related) => related.id !== item.id).map((related) => ({
        memoryId: related.id, contentHash: hashContent(related.content),
        normalizedContent: normalizeContent(related.content), sourceRefs: sourceRefs(related),
      })),
      reason, createdAt };
    record.checksum = checksum(record);
    return record;
  }
  _validateRecord(record, profileId, seq, initChecksum) {
    if (seq === 1) {
      if (!exactKeys(record, ["schemaVersion", "seq", "type", "profileId", "createdAt", "checksum"])
        || record.type !== "recall.init" || record.schemaVersion !== SCHEMA_VERSION
        || record.seq !== 1 || record.profileId !== profileId
        || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || !HASH_PATTERN.test(record.checksum) || checksum(record) !== record.checksum
        || (initChecksum && record.checksum !== initChecksum)) {
        throw policyError("RECALL_POLICY_CORRUPT", "撤回账本初始化记录无效");
      }
      return;
    }
    if (record?.type === "recall.expiry_commit") {
      if (!exactKeys(record, ["schemaVersion", "seq", "type", "profileId", "expiredOperationId",
        "memoryId", "primarySeq", "primaryChecksum", "createdAt", "checksum"])
        || record.schemaVersion !== SCHEMA_VERSION || record.seq !== seq || record.profileId !== profileId
        || !ID_PATTERN.test(record.expiredOperationId) || !ID_PATTERN.test(record.memoryId)
        || !Number.isSafeInteger(record.primarySeq) || record.primarySeq < 1
        || !HASH_PATTERN.test(record.primaryChecksum)
        || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || !HASH_PATTERN.test(record.checksum) || checksum(record) !== record.checksum) {
        throw policyError("RECALL_POLICY_CORRUPT", "撤回账本到期提交证明无效");
      }
      return;
    }
    if (!exactKeys(record, ["schemaVersion", "seq", "type", "profileId", "operationId", "memoryId",
      "memoryRevision", "contentHash", "normalizedContent", "sourceRefs", "related", "reason", "createdAt", "checksum"])
      || record.schemaVersion !== SCHEMA_VERSION || record.seq !== seq
      || record.type !== "recall.reason" || record.profileId !== profileId
      || !ID_PATTERN.test(record.operationId) || !ID_PATTERN.test(record.memoryId)
      || !Number.isSafeInteger(record.memoryRevision) || record.memoryRevision < 0
      || !HASH_PATTERN.test(record.contentHash)
      || typeof record.normalizedContent !== "string" || !record.normalizedContent
      || !record.normalizedContent.isWellFormed() || record.normalizedContent.includes("\0")
      || Buffer.byteLength(record.normalizedContent, "utf8") > 8 * 1024
      || hashContent(record.normalizedContent) !== record.contentHash
      // A memory may already have 64 source refs. A direct forget adds the
      // command's verified user event and Run to the same durable intent.
      || !Array.isArray(record.sourceRefs)
      || record.sourceRefs.length > (record.reason === "forgotten" ? 66 : 64)
      || record.sourceRefs.some((ref) => typeof ref !== "string" || !ID_PATTERN.test(ref))
      || !Array.isArray(record.related) || record.related.length > 1024
      || new Set(record.related.map((related) => related.memoryId)).size !== record.related.length
      || record.related.some((related) => !exactKeys(related,
        ["memoryId", "contentHash", "normalizedContent", "sourceRefs"])
        || !ID_PATTERN.test(related.memoryId) || related.memoryId === record.memoryId
        || !HASH_PATTERN.test(related.contentHash)
        || typeof related.normalizedContent !== "string" || !related.normalizedContent
        || !related.normalizedContent.isWellFormed() || related.normalizedContent.includes("\0")
        || Buffer.byteLength(related.normalizedContent, "utf8") > 8 * 1024
        || hashContent(related.normalizedContent) !== related.contentHash
        || !Array.isArray(related.sourceRefs) || related.sourceRefs.length > 64
        || related.sourceRefs.some((ref) => typeof ref !== "string" || !ID_PATTERN.test(ref)))
      || !REASONS.has(record.reason) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !HASH_PATTERN.test(record.checksum) || checksum(record) !== record.checksum) {
      throw policyError("RECALL_POLICY_CORRUPT", "撤回账本记录无效");
    }
  }
  _read(profileId, targets) {
    const buffer = readPrivateFile(targets.log, { fs: this.fs, maxBytes: MAX_LOG_BYTES });
    if (!buffer.length || buffer.at(-1) !== 0x0a) throw policyError("RECALL_POLICY_CORRUPT", "撤回账本末尾不完整");
    const lines = buffer.toString("utf8").slice(0, -1).split("\n");
    const records = lines.map((line) => {
      try { return JSON.parse(line); } catch { throw policyError("RECALL_POLICY_CORRUPT", "撤回账本 JSON 无效"); }
    });
    for (let i = 0; i < records.length; i += 1) this._validateRecord(records[i], profileId, i + 1);
    const seal = JSON.parse(readPrivateFile(targets.seal, { fs: this.fs, maxBytes: 4096 }).toString("utf8"));
    if (!exactKeys(seal, ["schemaVersion", "profileId", "initChecksum", "checksum"])
      || seal.schemaVersion !== SCHEMA_VERSION || seal.profileId !== profileId
      || !HASH_PATTERN.test(seal.initChecksum) || !HASH_PATTERN.test(seal.checksum)
      || checksum(seal) !== seal.checksum) throw policyError("RECALL_POLICY_CORRUPT", "撤回账本 seal 无效");
    this._validateRecord(records[0], profileId, 1, seal.initChecksum);
    const marker = JSON.parse(readPrivateFile(targets.marker, { fs: this.fs, maxBytes: 4096 }).toString("utf8"));
    if (!exactKeys(marker, ["schemaVersion", "profileId", "initChecksum", "headSeq", "headChecksum", "checksum"])
      || marker.schemaVersion !== SCHEMA_VERSION || marker.profileId !== profileId
      || marker.initChecksum !== seal.initChecksum || marker.headSeq !== records.length
      || marker.headChecksum !== records.at(-1).checksum || checksum(marker) !== marker.checksum) {
      throw policyError("RECALL_POLICY_CORRUPT", "撤回账本安装标记无效");
    }
    const installation = JSON.parse(readPrivateFile(targets.installation,
      { fs: this.fs, maxBytes: 4096 }).toString("utf8"));
    if (!exactKeys(installation, ["schemaVersion", "profileId", "initChecksum",
      "headSeq", "headChecksum", "checksum"])
      || installation.schemaVersion !== SCHEMA_VERSION || installation.profileId !== profileId
      || installation.initChecksum !== seal.initChecksum || installation.headSeq !== records.length
      || installation.headChecksum !== records.at(-1).checksum
      || checksum(installation) !== installation.checksum) {
      throw policyError("RECALL_POLICY_CORRUPT", "撤回账本独立安装锚无效");
    }
    const state = { profileId, records, byOperation: new Map(), byMemory: new Map(), suppressedRefs: new Set(),
      expiryCommits: new Map(),
      suppressionSources: [], normalizedContents: new Map(), sourceTextCutoffs: new Map(),
      sourceLiteralCutoffs: new Map(), forgottenContents: new Set(),
      contentCutoffs: new Map(),
      derivedRuns: new Set(), derivedRevision: 0, derivedSourceRevision: null,
      freshUserEvents: new Map(), freshUserSourceRevision: null,
      reauthorizedContents: new Map(), reauthorizedMemoryRevision: null,
      reauthorizedSourceRevision: null, reauthorizedBuiltAt: 0, reauthorizedNextChange: 0,
      historicalVisibilityCache: null,
      hasSuppressions: false, revision: records.length };
    for (const record of records.slice(1)) this._addRecord(state, record);
    state.identity = fileIdentity(validatePrivateStat(this.fs.lstatSync(targets.log), targets.log));
    state.sealIdentity = fileIdentity(validatePrivateStat(this.fs.lstatSync(targets.seal), targets.seal));
    state.markerIdentity = fileIdentity(validatePrivateStat(this.fs.lstatSync(targets.marker), targets.marker));
    state.installationIdentity = fileIdentity(validatePrivateStat(
      this.fs.lstatSync(targets.installation), targets.installation));
    return state;
  }
  _addRecord(state, record) {
    if (record.type === "recall.expiry_commit") {
      const reason = state.byOperation.get(record.expiredOperationId);
      if (!reason || reason.reason !== "expired" || reason.memoryId !== record.memoryId
        || record.primarySeq <= reason.memoryRevision) {
        throw policyError("RECALL_POLICY_CORRUPT", "到期提交证明没有对应的撤回意图");
      }
      state.expiryCommits.set(record.expiredOperationId, record);
      return;
    }
    const prior = state.byOperation.get(record.operationId);
    if (prior && stableJson(prior) !== stableJson(record)) {
      throw policyError("RECALL_POLICY_CORRUPT", "撤回账本 operationId 冲突");
    }
    state.byOperation.set(record.operationId, record);
    for (const memoryId of [record.memoryId, ...record.related.map((item) => item.memoryId)]) {
      if (!state.byMemory.has(memoryId)) state.byMemory.set(memoryId, []);
      state.byMemory.get(memoryId).push(record);
    }
    if (SUPPRESSING_REASONS.has(record.reason)) {
      state.hasSuppressions = true;
      state.forgottenContents.add(record.normalizedContent);
      state.contentCutoffs.set(record.normalizedContent,
        { memoryRevision: record.memoryRevision, createdAt: record.createdAt });
      for (const ref of record.sourceRefs) state.suppressedRefs.add(ref);
      state.suppressionSources.push({ refs: record.sourceRefs, content: record.normalizedContent,
        createdAt: record.createdAt });
      for (const related of record.related) {
        state.forgottenContents.add(related.normalizedContent);
        state.contentCutoffs.set(related.normalizedContent,
          { memoryRevision: record.memoryRevision, createdAt: record.createdAt });
        for (const ref of related.sourceRefs) state.suppressedRefs.add(ref);
        state.suppressionSources.push({ refs: related.sourceRefs,
          content: related.normalizedContent, createdAt: record.createdAt });
      }
    }
    state.derivedRevision = 0;
    state.derivedSourceRevision = null;
    state.reauthorizedMemoryRevision = null;
    state.reauthorizedSourceRevision = null;
  }
  _sourceRevision(state) {
    // Resolving a legacy event-only source depends on both the session catalog
    // and the transcript journal. A later append or restored session can reveal
    // its Run without changing the withdrawal ledger itself.
    if (typeof this.chatSessionStore?.getRevision !== "function"
      || typeof this.transcriptStore?.getChangeRevision !== "function") return null;
    try {
      const sessionRevision = this.chatSessionStore.getRevision();
      const transcriptRevision = this.transcriptStore.getChangeRevision(state.profileId);
      if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0
        || !Number.isSafeInteger(transcriptRevision) || transcriptRevision < 0) {
        throw policyError("RECALL_POLICY_SOURCE_UNAVAILABLE", "原话来源版本无效");
      }
      return `${sessionRevision}:${transcriptRevision}`;
    } catch (cause) { throw this._unavailable(cause); }
  }
  _deriveRuns(state) {
    const sourceRevision = this._sourceRevision(state);
    // Test doubles and older stores without a source revision cannot safely
    // cache a derivation whose input may have changed.
    if (sourceRevision !== null && state.derivedRevision === state.revision
      && state.derivedSourceRevision === sourceRevision) return;
    const unresolved = new Map();
    const addUnresolved = (source) => unresolved.set(source.content,
      Math.max(unresolved.get(source.content) ?? 0, source.createdAt));
    if (state.suppressedRefs.size === 0) {
      for (const source of state.suppressionSources) addUnresolved(source);
      state.normalizedContents = unresolved;
      state.sourceTextCutoffs = new Map();
      state.sourceLiteralCutoffs = new Map();
      state.derivedRevision = state.revision;
      state.derivedSourceRevision = sourceRevision;
      return;
    }
    if (!this.chatSessionStore || !this.transcriptStore) {
      if (this.strictSourceResolution) throw this._unavailable(
        policyError("RECALL_POLICY_SOURCE_UNAVAILABLE", "原话来源存储不可用"));
      for (const source of state.suppressionSources) addUnresolved(source);
      state.normalizedContents = unresolved;
      state.sourceTextCutoffs = new Map();
      state.sourceLiteralCutoffs = new Map();
      state.derivedRevision = state.revision;
      state.derivedSourceRevision = sourceRevision;
      return;
    }
    const runs = new Set();
    const resolvedRefs = new Set();
    const resolvedTextRefs = new Set();
    const freshUserEvents = new Map();
    const earliestRenewal = earliestContentCutoff(state);
    const sourceTextCutoffs = new Map();
    const sourceLiteralCutoffs = new Map();
    const sourceRefSources = new Map();
    for (const source of state.suppressionSources) for (const ref of source.refs) {
      if (!sourceRefSources.has(ref)) sourceRefSources.set(ref, []);
      sourceRefSources.get(ref).push(source);
    }
    try {
      for (const session of this.chatSessionStore.listSessions()) {
        if (session.profileId !== state.profileId) continue;
        for (const event of this.transcriptStore.listEvents(state.profileId, session.id)) {
          if (event.kind === "user" && event.runId
            && Number.isSafeInteger(event.occurredAt) && event.occurredAt > earliestRenewal) {
            if (!freshUserEvents.has(event.id)) freshUserEvents.set(event.id, new Map());
            const seen = freshUserEvents.get(event.id);
            seen.set(event.runId, Math.max(seen.get(event.runId) ?? 0, event.occurredAt));
          }
          if (state.suppressedRefs.has(event.id)) {
            resolvedRefs.add(event.id);
            if (event.runId) runs.add(event.runId);
            // The claim may paraphrase its user message. Resolve its verified
            // body so a verbatim copy in another Run, including an assistant
            // quote with a prefix/suffix, cannot bypass the revoked source.
            if (event.kind === "user") {
              if (event.content?.contextRef && typeof this.transcriptStore.contextEvent !== "function"
                && this.strictSourceResolution) {
                throw policyError("RECALL_POLICY_SOURCE_UNAVAILABLE", "原话正文不可验证");
              }
              // contextExcluded hides the event from the Agent, but a later
              // forget still needs the verified full body to suppress copies.
              const resolved = event.content?.contextRef
                ? this.transcriptStore.contextEvent?.(state.profileId, session.id,
                  event.contextExcluded ? { ...event, contextExcluded: false } : event) : event;
              const text = resolved?.content?.text;
              if (typeof text === "string" && text.trim()) {
                const hash = hashContent(text);
                if (!sourceTextCutoffs.has(hash)) sourceTextCutoffs.set(hash, new Map());
                const cutoffs = sourceTextCutoffs.get(hash);
                for (const source of sourceRefSources.get(event.id) || []) {
                  cutoffs.set(source.content, Math.max(cutoffs.get(source.content) ?? 0,
                    source.createdAt));
                }
                if (Buffer.byteLength(text, "utf8") <= MAX_SOURCE_LITERAL_BYTES) {
                  sourceLiteralCutoffs.set(normalizeContent(text), cutoffs);
                }
                resolvedTextRefs.add(event.id);
              }
            }
          }
          if (event.runId && state.suppressedRefs.has(event.runId)) {
            resolvedRefs.add(event.runId);
            runs.add(event.runId);
          }
        }
      }
    } catch (cause) { throw this._unavailable(cause); }
    state.derivedRuns = runs;
    // A missing reference or unreadable legacy source has no verified body.
    // Keep the conservative claim-content fallback for that source.
    for (const source of state.suppressionSources) {
      if (source.refs.length === 0 || source.refs.some((ref) => !resolvedRefs.has(ref))
        || source.refs.some((ref) => resolvedRefs.has(ref) && !resolvedTextRefs.has(ref)
          && !runs.has(ref))) addUnresolved(source);
    }
    state.normalizedContents = unresolved;
    state.sourceTextCutoffs = sourceTextCutoffs;
    state.sourceLiteralCutoffs = sourceLiteralCutoffs;
    state.freshUserEvents = freshUserEvents;
    state.freshUserSourceRevision = sourceRevision;
    state.derivedRevision = state.revision;
    state.derivedSourceRevision = sourceRevision;
  }
  _append(state, record, targets) {
    const line = `${stableJson(record)}\n`;
    const size = this.fs.lstatSync(targets.log).size;
    if (size + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES) {
      throw policyError("RECALL_POLICY_CAPACITY_EXCEEDED", "撤回账本超过容量限制");
    }
    let fd;
    try {
      this._writeInstallation(state.profileId, targets, state.records[0].checksum,
        record.seq, record.checksum);
      this._writeMarker(state.profileId, targets, state.records[0].checksum,
        record.seq, record.checksum);
      fd = this.fs.openSync(targets.log, this.fs.constants.O_APPEND | this.fs.constants.O_WRONLY
        | (this.fs.constants.O_NOFOLLOW || 0));
      validatePrivateStat(this.fs.fstatSync(fd), targets.log);
      writeFully(this.fs, fd, line, "RECALL_POLICY_WRITE_FAILED");
      this.fs.fsyncSync(fd);
    } catch (cause) {
      this.states.delete(state.profileId);
      throw this._unavailable(cause);
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
    state.records.push(record);
    state.revision = record.seq;
    this._addRecord(state, record);
    state.identity = fileIdentity(validatePrivateStat(this.fs.lstatSync(targets.log), targets.log));
    state.markerIdentity = fileIdentity(validatePrivateStat(this.fs.lstatSync(targets.marker), targets.marker));
    state.installationIdentity = fileIdentity(validatePrivateStat(
      this.fs.lstatSync(targets.installation), targets.installation));
    if (SUPPRESSING_REASONS.has(record.reason)) this._notifyIndex(state.profileId);
  }
  _reconcile(state, targets) {
    const items = this.memoryStore.list(state.profileId);
    for (const item of items) {
      const records = state.byMemory.get(item.id) || [];
      const covers = (record) => (record.memoryId === item.id && record.contentHash === hashContent(item.content))
        || record.related.some((related) => related.memoryId === item.id
          && related.contentHash === hashContent(item.content));
      const matching = records.filter(covers).at(-1);
      const matchingSuppression = records.find((record) => covers(record)
        && SUPPRESSING_REASONS.has(record.reason));
      // A restored primary journal or an older App can replace a genuine
      // expiry deletion with a user deletion at the same revision. The expiry
      // reason alone cannot distinguish them; compare the committed primary
      // record proof, and conservatively suppress if it is missing or changed.
      const expiryCommit = matching?.reason === "expired"
        ? state.expiryCommits.get(matching.operationId) : null;
      const primaryProof = expiryCommit
        ? this.memoryStore.getItemWriteProof(state.profileId, item.id) : null;
      const verifiedExpiry = matching?.reason === "expired" && expiryCommit && primaryProof
        && expiryCommit.primarySeq === primaryProof.seq
        && expiryCommit.primaryChecksum === primaryProof.checksum;
      if (item.status === "deleted" && !matchingSuppression && (!matching || !verifiedExpiry)) {
        const record = this._record(state.profileId, state.revision + 1, item, "legacy_unknown",
          `legacy-${crypto.createHash("sha256").update(`${item.id}\0${hashContent(item.content)}\0${this.memoryStore.getRevision(state.profileId)}`).digest("hex")}`, this.now());
        this._append(state, record, targets);
      }
      if (item.status !== "deleted" && matchingSuppression) {
        // A crash after fsync of the intent may leave the primary store active.
        // Complete the same logical deletion only when its content is unchanged.
        this.memoryStore.upsert({ ...item, status: "deleted", updatedAt: Math.max(item.updatedAt, this.now()) });
      }
      if (item.status !== "deleted" && records.some((record) => SUPPRESSING_REASONS.has(record.reason))
        && !matching) throw policyError("RECALL_POLICY_CONFLICT", "撤回后记忆内容变化，需要人工核验");
    }
  }
  _load(profileId) {
    if (!this.opened) throw policyError("RECALL_POLICY_CLOSED", "撤回账本未打开");
    const targets = this._paths(profileId);
    try {
      ensurePrivateDirectoryTree(targets.dir, this.paths.trustedRoot);
      ensurePrivateDirectoryTree(targets.installationDir, this.paths.trustedRoot);
      const logStat = lstatIfExists(targets.log);
      const sealStat = lstatIfExists(targets.seal);
      const markerStat = lstatIfExists(targets.marker);
      const installationStat = lstatIfExists(targets.installation);
      if (!logStat && !sealStat && !markerStat && !installationStat) this._init(profileId, targets);
      else if (!logStat || !sealStat || !markerStat || !installationStat) {
        // Never regenerate the anchor from a possibly rolled-back journal.
        throw policyError("RECALL_POLICY_CORRUPT", "撤回账本或独立安装标记缺失");
      }
      const state = this._read(profileId, targets);
      this._reconcile(state, targets);
      this.states.set(profileId, state);
      return state;
    } catch (cause) { this.states.delete(profileId); throw this._unavailable(cause); }
  }
  assertReady(profileId) {
    const targets = this._paths(profileId);
    const state = this.states.get(profileId);
    if (state) {
      try {
        const logStat = validatePrivateStat(this.fs.lstatSync(targets.log), targets.log);
        const sealStat = validatePrivateStat(this.fs.lstatSync(targets.seal), targets.seal);
        const markerStat = validatePrivateStat(this.fs.lstatSync(targets.marker), targets.marker);
        const installationStat = validatePrivateStat(
          this.fs.lstatSync(targets.installation), targets.installation);
        if (state.identity === fileIdentity(logStat) && state.sealIdentity === fileIdentity(sealStat)
          && state.markerIdentity === fileIdentity(markerStat)
          && state.installationIdentity === fileIdentity(installationStat)) return state;
      } catch (cause) { this.states.delete(profileId); throw this._unavailable(cause); }
      this.states.delete(profileId);
    }
    return this._load(profileId);
  }
  getRevision(profileId) { return this.assertReady(profileId).revision; }
  getHistoricalVisibilityRevision(profileId) {
    const state = this.assertReady(profileId);
    if (!state.hasSuppressions) return state.revision;
    this._deriveRuns(state);
    const authorized = this._reauthorizedContents(state);
    const cached = state.historicalVisibilityCache;
    if (cached?.revision === state.revision && cached.runs === state.derivedRuns
      && cached.normalized === state.normalizedContents
      && cached.sourceText === state.sourceTextCutoffs
      && cached.sourceLiterals === state.sourceLiteralCutoffs
      && cached.authorized === authorized) return cached.digest;
    const ordered = (entries) => [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const visibility = [
      [...state.derivedRuns].sort(),
      ordered(state.normalizedContents),
      ordered(state.sourceTextCutoffs).map(([hash, cutoffs]) => [hash, ordered(cutoffs)]),
      ordered(state.sourceLiteralCutoffs).map(([literal, cutoffs]) => [hashContent(literal), ordered(cutoffs)]),
      ordered(authorized).map(([event, contents]) => [event, ordered(contents)]),
    ];
    const digest = `${state.revision}:${crypto.createHash("sha256").update(stableJson(visibility)).digest("hex")}`;
    state.historicalVisibilityCache = { revision: state.revision, runs: state.derivedRuns,
      normalized: state.normalizedContents, sourceText: state.sourceTextCutoffs,
      sourceLiterals: state.sourceLiteralCutoffs,
      authorized, digest };
    return digest;
  }
  getStatus(profileId) {
    const state = this.assertReady(profileId);
    return { ready: true, revision: state.revision, indexPending: this.indexPending.has(profileId), code: null };
  }
  getMemoryReason(profileId, item) {
    const state = this.assertReady(profileId);
    if (!item || item.profileId !== profileId || item.status !== "deleted") return null;
    const hash = hashContent(item.content);
    const records = state.byMemory.get(item.id) || [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if ((record.memoryId === item.id && record.contentHash === hash)
        || record.related.some((related) => related.memoryId === item.id
          && related.contentHash === hash)) return record.reason;
    }
    return null;
  }
  hasRevocations(profileId) {
    return this.assertReady(profileId).hasSuppressions;
  }
  _freshUserEvents(state) {
    const sourceRevision = this._sourceRevision(state);
    if (sourceRevision !== null && state.freshUserSourceRevision === sourceRevision) {
      return state.freshUserEvents;
    }
    const events = new Map();
    const earliestRenewal = earliestContentCutoff(state);
    try {
      for (const session of this.chatSessionStore.listSessions()) {
        if (session.profileId !== state.profileId) continue;
        for (const event of this.transcriptStore.listEvents(state.profileId, session.id)) {
          if (event.kind !== "user" || !event.runId
            || !Number.isSafeInteger(event.occurredAt)
            || event.occurredAt <= earliestRenewal) continue;
          if (!events.has(event.id)) events.set(event.id, new Map());
          const runs = events.get(event.id);
          runs.set(event.runId, Math.max(runs.get(event.runId) ?? 0, event.occurredAt));
        }
      }
    } catch (cause) { throw this._unavailable(cause); }
    state.freshUserEvents = events;
    state.freshUserSourceRevision = sourceRevision;
    return events;
  }
  _hasFreshExplicitSource(state, refs, since) {
    if (refs.some((ref) => ref.startsWith("user-edit:"))) return true;
    const eventRefs = new Set(refs.filter((ref) => !/^(?:workspace:|codex-memory:)/u.test(ref)));
    if (eventRefs.size === 0) return false;
    if (!this.chatSessionStore || !this.transcriptStore) return !this.strictSourceResolution;
    const sources = this._freshUserEvents(state);
    for (const eventId of eventRefs) {
      for (const [runId, occurredAt] of sources.get(eventId) || []) {
        if (eventRefs.has(runId) && occurredAt > since) return true;
      }
    }
    return false;
  }
  _isMemoryVisible(state, profileId, item) {
    if (!item || item.profileId !== profileId) return false;
    if (!state.hasSuppressions) return true;
    if ((state.byMemory.get(item.id) || []).some((record) => SUPPRESSING_REASONS.has(record.reason))) return false;
    // A single utterance may produce multiple claims without a supersedes
    // relationship. Revoking its source also hides those sibling claims.
    if (item.sourceRefs.some((ref) => state.suppressedRefs.has(ref))) return false;
    const cutoff = state.contentCutoffs.get(normalizeContent(item.content));
    if (!cutoff) return true;
    // Distinct events/scopes can hold identical claims. Any copy whose text
    // existed before the forget is hidden, even without a shared source ref.
    const contentRevision = this.memoryStore.getContentRevision(profileId, item.id);
    if (contentRevision === null || contentRevision <= cutoff.memoryRevision
      || item.createdAt <= cutoff.createdAt) return false;
    // New explicit user input may reauthorize the fact. Imported material and
    // old or unverified events cannot resurrect it merely by being rewritten.
    return this._hasFreshExplicitSource(state, item.sourceRefs, cutoff.createdAt);
  }
  isMemoryVisible(profileId, item) { return this._isMemoryVisible(this.assertReady(profileId), profileId, item); }
  _reauthorizedContents(state) {
    const memoryRevision = this.memoryStore.getRevision(state.profileId);
    const sourceRevision = state.derivedSourceRevision;
    const now = this.now();
    if (sourceRevision !== null && state.reauthorizedMemoryRevision === memoryRevision
      && state.reauthorizedSourceRevision === sourceRevision
      && now >= state.reauthorizedBuiltAt
      && now < state.reauthorizedNextChange) return state.reauthorizedContents;
    const byEvent = new Map();
    let nextChange = Infinity;
    try {
      for (const item of this.memoryStore.list(state.profileId, { status: "active" })) {
        const normalized = normalizeContent(item.content);
        const cutoff = state.contentCutoffs.get(normalized);
        if (!cutoff || item.sourceRefs?.length < 2) continue;
        if (item.sensitivity === "restricted") continue;
        if (item.validFrom > now) { nextChange = Math.min(nextChange, item.validFrom); continue; }
        if (item.validUntil !== null && item.validUntil <= now) continue;
        if (item.validUntil !== null) nextChange = Math.min(nextChange, item.validUntil);
        const [eventId, runId] = item.sourceRefs;
        if (!eventId || !runId || eventId.startsWith("user-edit:")
          || eventId.startsWith("codex-memory:") || state.suppressedRefs.has(eventId)
          || state.suppressedRefs.has(runId) || !this._isMemoryVisible(state, state.profileId, item)
          || !this._hasFreshExplicitSource(state, [eventId, runId], cutoff.createdAt)) continue;
        const key = `${eventId}\0${runId}`;
        if (!byEvent.has(key)) byEvent.set(key, new Map());
        const contents = byEvent.get(key);
        contents.set(normalized, Math.max(contents.get(normalized) ?? 0, item.createdAt));
      }
    } catch (cause) { throw this._unavailable(cause); }
    state.reauthorizedContents = byEvent;
    state.reauthorizedMemoryRevision = memoryRevision;
    state.reauthorizedSourceRevision = sourceRevision;
    state.reauthorizedBuiltAt = now;
    state.reauthorizedNextChange = nextChange;
    return byEvent;
  }
  _isEventVisible(state, event) {
    if (!event || typeof event !== "object") return false;
    this._deriveRuns(state);
    if (state.suppressedRefs.has(event.id)
      || (event.runId && (state.suppressedRefs.has(event.runId) || state.derivedRuns.has(event.runId)))) return false;
    const content = event.content?.text;
    if (typeof content === "string") {
      const normalized = normalizeContent(content);
      let authorization;
      const reauthorizedAfter = (forgotten, cutoff) => {
        if (event.kind !== "user" || !event.runId || !Number.isSafeInteger(event.occurredAt)
          || event.occurredAt <= cutoff) return false;
        authorization ??= this._reauthorizedContents(state).get(`${event.id}\0${event.runId}`);
        return (authorization?.get(forgotten) ?? 0) > cutoff;
      };
      for (const [forgotten, cutoff] of state.normalizedContents) {
        if (normalized.includes(forgotten) && !reauthorizedAfter(forgotten, cutoff)) return false;
      }
      const sourceCutoffs = state.sourceTextCutoffs.get(hashContent(content));
      if (sourceCutoffs) for (const [forgotten, cutoff] of sourceCutoffs) {
        if (!reauthorizedAfter(forgotten, cutoff)) return false;
      }
      for (const [literal, cutoffs] of state.sourceLiteralCutoffs) {
        if (normalized === literal || !normalized.includes(literal)) continue;
        for (const [forgotten, cutoff] of cutoffs) {
          if (!reauthorizedAfter(forgotten, cutoff)) return false;
        }
      }
    }
    return true;
  }
  isEventVisible(profileId, event) { return this._isEventVisible(this.assertReady(profileId), event); }
  isSourceVisible(profileId, refs) {
    const state = this.assertReady(profileId);
    if (!Array.isArray(refs)) return false;
    // A fresh user event can reauthorize a fact, but mixing it with any
    // revoked event or Run must not launder the old source back into memory.
    return refs.every((ref) => typeof ref === "string" && !state.suppressedRefs.has(ref));
  }
  hasRevokedContent(profileId, content) {
    const state = this.assertReady(profileId);
    const normalized = normalizeContent(content);
    for (const forgotten of state.forgottenContents) if (normalized.includes(forgotten)) return true;
    return false;
  }
  snapshot(profileId) {
    const state = this.assertReady(profileId);
    return Object.freeze({ revision: state.revision,
      hasRevocations: state.hasSuppressions,
      isMemoryVisible: (item) => this._isMemoryVisible(state, profileId, item),
      isEventVisible: (event) => this._isEventVisible(state, event) });
  }
  recordReason({ profileId, item, relatedItems = [], reason, operationId = this.randomUUID(),
    revocationSourceRefs = [] }) {
    if (!REASONS.has(reason) || !item || item.profileId !== profileId) {
      throw policyError("RECALL_POLICY_INVALID", "撤回原因或记忆无效");
    }
    if (!Array.isArray(relatedItems) || relatedItems.length > 1024
      || relatedItems.some((related) => related.profileId !== profileId || related.id === item.id)
      || new Set(relatedItems.map((related) => related.id)).size !== relatedItems.length) {
      throw policyError("RECALL_POLICY_INVALID", "撤回版本链无效");
    }
    if (!Array.isArray(revocationSourceRefs) || revocationSourceRefs.length > 2
      || revocationSourceRefs.some((ref) => typeof ref !== "string" || !ID_PATTERN.test(ref))
      || (revocationSourceRefs.length > 0 && reason !== "forgotten")) {
      throw policyError("RECALL_POLICY_INVALID", "撤回请求来源无效");
    }
    assertId(operationId, "operationId");
    const state = this.assertReady(profileId);
    const prior = state.byOperation.get(operationId);
    if (prior) {
      if (prior.memoryId !== item.id || prior.contentHash !== hashContent(item.content) || prior.reason !== reason) {
        throw policyError("RECALL_POLICY_CONFLICT", "operationId 已用于其他撤回");
      }
      // A pending call written by an older version may have committed the
      // reason without the command's source. Repair it with a second ordinary
      // v1 reason record; no journal schema or primary memory changes.
      if (revocationSourceRefs.some((ref) => !prior.sourceRefs.includes(ref))) {
        const supplementalId = `forget-source-${crypto.createHash("sha256").update(operationId).digest("hex")}`;
        const supplement = state.byOperation.get(supplementalId);
        if (supplement) {
          if (supplement.memoryId !== item.id || supplement.contentHash !== hashContent(item.content)
            || supplement.reason !== reason
            || revocationSourceRefs.some((ref) => !supplement.sourceRefs.includes(ref))) {
            throw policyError("RECALL_POLICY_CONFLICT", "撤回请求来源与已记录操作冲突");
          }
        } else {
          const repair = this._record(profileId, state.revision + 1, item, reason,
            supplementalId, this.now(), relatedItems, revocationSourceRefs);
          this._append(state, repair, this._paths(profileId));
        }
      }
      return prior;
    }
    const record = this._record(profileId, state.revision + 1, item, reason, operationId,
      this.now(), relatedItems, revocationSourceRefs);
    this._append(state, record, this._paths(profileId));
    return record;
  }
  recordExpiryCommit({ profileId, item, operationId }) {
    assertId(operationId, "operationId");
    if (!item || item.profileId !== profileId || item.status !== "deleted") {
      throw policyError("RECALL_POLICY_INVALID", "到期提交记忆无效");
    }
    const state = this.assertReady(profileId);
    const reason = state.byOperation.get(operationId);
    const committed = this.memoryStore.get(profileId, item.id);
    const primaryProof = this.memoryStore.getItemWriteProof(profileId, item.id);
    if (!reason || reason.reason !== "expired" || reason.memoryId !== item.id
      || reason.contentHash !== hashContent(item.content)
      || !committed || committed.status !== "deleted" || hashContent(committed.content) !== reason.contentHash
      || !primaryProof || primaryProof.seq <= reason.memoryRevision) {
      throw policyError("RECALL_POLICY_CONFLICT", "到期提交与主记忆不一致");
    }
    const prior = state.expiryCommits.get(operationId);
    if (prior?.primarySeq === primaryProof.seq && prior.primaryChecksum === primaryProof.checksum) return prior;
    const record = { schemaVersion: SCHEMA_VERSION, seq: state.revision + 1,
      type: "recall.expiry_commit", profileId, expiredOperationId: operationId, memoryId: item.id,
      primarySeq: primaryProof.seq, primaryChecksum: primaryProof.checksum, createdAt: this.now() };
    record.checksum = checksum(record);
    this._append(state, record, this._paths(profileId));
    return record;
  }
}

module.exports = { RecallPolicyStore, normalizeContent, hashContent };
