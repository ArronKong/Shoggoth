"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensurePrivateDirectoryTree } = require("./security");
const { atomicWritePrivateFile, readPrivateFile, validatePrivateStat, validateDirectoryStat,
  openExistingPrivateFile, writeFully, fsyncPrivateParent, recoverInterruptedPrivateFile } = require("./private-file");
const { normalizePluginSelection } = require("./plugin-chat-selection");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const c = require("./chat-ui-contract");
const SEED = c.hash("shoggoth-chat-ui-journal-v1");
const MAX_RECORD = 128 * 1024;
const COMPACT_BYTES = 4 * 1024 * 1024;
const copy = value => structuredClone(value);
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const directoryIdentity = stat => `${stat.dev}:${stat.ino}`;
const marker = state => ({ version: 1, profileId: state.profileId, sessionId: state.sessionId, seq: state.seq, checksum: state.checksum });
function storeError(cause, uncertain = false) {
  if (cause?.code?.startsWith("UI_")) return cause;
  return c.uiError(uncertain ? "UI_COMMIT_UNCERTAIN" : "UI_STORAGE_FAILED", { cause });
}

// A single Service writer owns these private journals. They are facts; the
// small manifest only records the last verified chain checkpoint. HTML never
// lives in public message frames, ProductStore bindings, or mutable workspaces.
class ChatUiStore {
  constructor({ paths, fs: fileSystem = fs, atomicWrite = atomicWritePrivateFile,
    now = Date.now, limits = {}, secretMatcher, fault = () => {} }) {
    Object.assign(this, { paths, fs: fileSystem, atomicWrite, now, secretMatcher, fault });
    this.limits = { ...c.LIMITS, ...limits }; this.sessions = new Map(); this.publications = new Map();
    this.opened = false; this.lease = null;
  }
  _profileDir(profileId) { return path.join(this.paths.agentsDir, c.id(profileId), "chat-ui"); }
  _paths(profileId, sessionId) {
    const dir = path.join(this._profileDir(profileId), c.id(sessionId));
    return { dir, log: path.join(dir, "journal.jsonl"), manifest: path.join(dir, "manifest.json") };
  }
  _object(profileId, htmlHash) {
    if (!/^[a-f0-9]{64}$/u.test(htmlHash)) throw c.uiError("UI_STORAGE_CORRUPT");
    return path.join(this._profileDir(profileId), "objects", `${htmlHash}.html`);
  }
  _stat(target) { try { return this.fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
  _fileIdentity(target) { const stat = this._stat(target); if (!stat) return null; return identity(validatePrivateStat(stat, target)); }
  _assertOpen() {
    if (!this.opened || !this.lease) throw c.uiError("UI_STORAGE_FAILED");
    const stat = this._stat(this.lease.lockPath);
    if (!stat || stat.isSymbolicLink() || directoryIdentity(stat) !== this.leaseIdentity) throw c.uiError("UI_STORAGE_CORRUPT");
  }
  open() {
    if (this.opened) return;
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    this.lease = acquirePrivateWriterLease({ lockPath: path.join(this.paths.stateDir, "chat-ui.writer.lock"), trustedRoot: this.paths.trustedRoot, fs: this.fs, now: this.now });
    this.leaseIdentity = directoryIdentity(this.fs.lstatSync(this.lease.lockPath)); this.opened = true;
    try {
      for (const profileId of this.fs.readdirSync(this.paths.agentsDir)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(profileId)) continue;
        const profileDir = path.join(this.paths.agentsDir, profileId), profileStat = this.fs.lstatSync(profileDir);
        if (!profileStat.isDirectory()) { if (profileStat.isSymbolicLink()) throw c.uiError("UI_STORAGE_CORRUPT"); continue; }
        const dir = this._profileDir(profileId); if (!this._stat(dir)) continue;
        validateDirectoryStat(this.fs.lstatSync(dir), dir);
        for (const sessionId of this.fs.readdirSync(dir)) {
          if (sessionId === "objects" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(sessionId)) continue;
          this._load(profileId, sessionId);
        }
      }
    } catch (cause) { this.close(); throw storeError(cause); }
  }
  close() {
    const lease = this.lease;
    if (lease) lease.release();
    this.lease = null; this.opened = false; this.sessions.clear(); this.publications.clear();
  }
  _empty(profileId, sessionId) { return { profileId, sessionId, owner: null, epoch: 1, seq: 0, checksum: SEED,
    artifacts: new Map(), publications: new Map(), operations: new Map(), error: null }; }
  _current(state) {
    this._assertOpen(); if (state.error) throw state.error;
    const files = this._paths(state.profileId, state.sessionId);
    if (directoryIdentity(validateDirectoryStat(this.fs.lstatSync(files.dir), files.dir)) !== state.directoryIdentity
      || this._fileIdentity(files.log) !== state.logIdentity || this._fileIdentity(files.manifest) !== state.manifestIdentity) throw c.uiError("UI_STORAGE_CORRUPT");
    return state;
  }
  _load(profileId, sessionId) {
    this._assertOpen(); const key = `${c.id(profileId)}:${c.id(sessionId)}`;
    if (this.sessions.has(key)) return this._current(this.sessions.get(key));
    const state = this._empty(profileId, sessionId), files = this._paths(profileId, sessionId);
    ensurePrivateDirectoryTree(files.dir, this.paths.trustedRoot);
    state.directoryIdentity = directoryIdentity(validateDirectoryStat(this.fs.lstatSync(files.dir), files.dir));
    let checkpoint = null;
    try {
      for (const target of [files.log, files.manifest]) if (recoverInterruptedPrivateFile(target, { fs: this.fs,
        trustedRoot: this.paths.trustedRoot }) === "uncertain") throw c.uiError("UI_STORAGE_CORRUPT");
      if (this._stat(files.manifest)) {
        checkpoint = JSON.parse(readPrivateFile(files.manifest, { fs: this.fs, maxBytes: 4096 }));
        c.fields(checkpoint, ["version", "profileId", "sessionId", "seq", "checksum"], ["version", "profileId", "sessionId", "seq", "checksum"], "UI_STORAGE_CORRUPT");
        if (checkpoint.version !== 1 || checkpoint.profileId !== profileId || checkpoint.sessionId !== sessionId) throw c.uiError("UI_STORAGE_CORRUPT");
        c.positive(checkpoint.seq, "UI_STORAGE_CORRUPT", true);
      }
      let bytes = this._stat(files.log) ? readPrivateFile(files.log, { fs: this.fs, maxBytes: this.limits.profileHard }) : Buffer.alloc(0);
      if (bytes.length && bytes.at(-1) !== 10) {
        const size = bytes.lastIndexOf(10) + 1;
        const fd = openExistingPrivateFile(files.log, this.fs.constants.O_RDWR, this.fs);
        try { this.fs.ftruncateSync(fd, size); this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
        bytes = bytes.subarray(0, size);
      }
      let checkpointVerified = checkpoint === null || (checkpoint.seq === 0 && checkpoint.checksum === SEED);
      let compactAnchor = false, consumedBytes = 0;
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line) continue; consumedBytes += Buffer.byteLength(line) + 1; if (Buffer.byteLength(line) > MAX_RECORD) throw c.uiError("UI_STORAGE_CORRUPT");
        const record = JSON.parse(line);
        c.fields(record, ["version", "seq", "previous", "type", "payload", "checksum"], ["version", "seq", "previous", "type", "payload", "checksum"], "UI_STORAGE_CORRUPT");
        const unsigned = { ...record }; delete unsigned.checksum;
        if (state.seq === 0 && record.type === "checkpoint.begin") {
          const anchor = record.payload;
          c.positive(anchor.previousSeq, "UI_STORAGE_CORRUPT", true);
          if (!/^[a-f0-9]{64}$/u.test(anchor.previousChecksum) || record.seq !== anchor.previousSeq + 1
            || record.previous !== SEED) throw c.uiError("UI_STORAGE_CORRUPT");
          state.seq = anchor.previousSeq;
          compactAnchor = checkpoint?.seq === anchor.previousSeq && checkpoint.checksum === anchor.previousChecksum;
        }
        if (record.version !== 1 || record.seq !== state.seq + 1 || record.previous !== state.checksum || c.hash(unsigned) !== record.checksum) throw c.uiError("UI_STORAGE_CORRUPT");
        this._apply(state, record.type, record.payload); state.seq = record.seq; state.checksum = record.checksum;
        if (record.type === "checkpoint.end") { state.compactBytes = consumedBytes; if (compactAnchor) checkpointVerified = true; }
        if (checkpoint?.seq === state.seq && checkpoint.checksum === state.checksum) checkpointVerified = true;
      }
      if (state.checkpoint || !checkpointVerified || (checkpoint && checkpoint.seq > state.seq)) throw c.uiError("UI_STORAGE_CORRUPT");
      if (state.seq && (checkpoint?.seq !== state.seq || checkpoint?.checksum !== state.checksum)) this.atomicWrite(files.manifest, `${c.canonical(marker(state))}\n`, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      state.logIdentity = this._fileIdentity(files.log); state.manifestIdentity = this._fileIdentity(files.manifest);
      this.sessions.set(key, state);
      for (const pub of state.publications.values()) {
        const index = `${profileId}:${pub.callId}`;
        if (this.publications.has(index)) throw c.uiError("UI_STORAGE_CORRUPT");
        this.publications.set(index, { sessionId, publicationId: pub.publicationId });
      }
      return state;
    } catch (cause) { throw cause.code?.startsWith("UI_") ? cause : c.uiError("UI_STORAGE_CORRUPT", { cause }); }
  }
  _apply(state, type, payload) {
    c.record(payload, "UI_STORAGE_CORRUPT");
    if (type === "checkpoint.begin") {
      const fields = ["sessionKey", "previousSeq", "previousChecksum", "publicationCount", "operationCount", "finalEpoch"];
      c.fields(payload, fields, fields, "UI_STORAGE_CORRUPT");
      if (state.owner || state.checkpoint) throw c.uiError("UI_STORAGE_CORRUPT");
      c.id(payload.sessionKey); c.positive(payload.finalEpoch);
      c.positive(payload.publicationCount, "UI_STORAGE_CORRUPT", true); c.positive(payload.operationCount, "UI_STORAGE_CORRUPT", true);
      state.owner = { sessionKey: payload.sessionKey }; state.checkpoint = copy(payload); return;
    }
    if (type === "checkpoint.epoch") {
      c.fields(payload, ["epoch"], ["epoch"], "UI_STORAGE_CORRUPT");
      if (!state.checkpoint || !Number.isSafeInteger(payload.epoch) || payload.epoch < state.epoch
        || payload.epoch > state.checkpoint.finalEpoch) throw c.uiError("UI_STORAGE_CORRUPT");
      state.epoch = payload.epoch; return;
    }
    if (type === "checkpoint.state") {
      c.fields(payload, ["artifactId", "revision", "state", "stateRevision"], ["artifactId", "revision", "state", "stateRevision"], "UI_STORAGE_CORRUPT");
      const rev = state.artifacts.get(payload.artifactId)?.revisions.get(payload.revision);
      if (!state.checkpoint || !rev || rev.status !== "ready") throw c.uiError("UI_STORAGE_CORRUPT");
      c.positive(payload.stateRevision, "UI_STORAGE_CORRUPT", true);
      rev.state = c.normalizeState(payload.state, rev.declaration.stateSchema, this.secretMatcher); rev.stateRevision = payload.stateRevision; return;
    }
    if (type === "checkpoint.operation") {
      const fields = ["actionRequestId", "operationId", "artifactId", "revision", "sourceEventId", "actionId", "action", "baseStateRevision", "snapshot", "fingerprint", "createdAt", "sendEnvelope", "sendFingerprint", "stateRevision", "conversationEpoch", "status", "receipt", "publicCode", "updatedAt"];
      c.fields(payload, fields, fields.slice(0, 16), "UI_STORAGE_CORRUPT");
      const op = payload, rev = state.artifacts.get(op.artifactId)?.revisions.get(op.revision);
      for (const key of ["actionRequestId", "operationId", "artifactId", "sourceEventId", "actionId"]) c.id(op[key]);
      for (const key of ["revision", "conversationEpoch"]) c.positive(op[key]);
      for (const key of ["baseStateRevision", "stateRevision", "createdAt"]) c.positive(op[key], "UI_STORAGE_CORRUPT", true);
      if (!state.checkpoint || !rev || rev.sourceEventId !== op.sourceEventId || op.conversationEpoch !== rev.conversationEpoch
        || !/^[a-f0-9]{64}$/u.test(op.fingerprint) || !/^[a-f0-9]{64}$/u.test(op.sendFingerprint)
        || state.operations.has(op.actionRequestId) || [...state.operations.values()].some(value => value.operationId === op.operationId)
        || !["prepared", "accepted", "unknown", "expired", "failed"].includes(op.status)) throw c.uiError("UI_STORAGE_CORRUPT");
      if (op.updatedAt !== undefined) c.positive(op.updatedAt, "UI_STORAGE_CORRUPT", true);
      if (op.publicCode !== undefined && op.publicCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(op.publicCode)) throw c.uiError("UI_STORAGE_CORRUPT");
      this._validateReceipt(op.receipt ?? null);
      if (rev.status === "revoked") {
        if (op.sendEnvelope !== null || c.canonical(op.snapshot) !== "{}" || c.canonical(op.action) !== "{}") throw c.uiError("UI_STORAGE_CORRUPT");
      } else {
        c.normalizeState(op.snapshot, rev.declaration.stateSchema, this.secretMatcher);
        const action = rev.declaration.actions.find(value => value.actionId === op.actionId);
        if (!action || c.canonical(op.action) !== c.canonical(action) || c.hash(op.sendEnvelope) !== op.sendFingerprint) throw c.uiError("UI_STORAGE_CORRUPT");
        c.fields(op.sendEnvelope, ["operationId", "sessionKey", "prompt", "pluginSelection"], ["operationId", "sessionKey", "prompt"], "UI_STORAGE_CORRUPT");
        if (op.sendEnvelope.operationId !== op.operationId || op.sendEnvelope.sessionKey !== state.owner.sessionKey
          || typeof op.sendEnvelope.prompt !== "string" || !op.sendEnvelope.prompt.isWellFormed()
          || Buffer.byteLength(op.sendEnvelope.prompt) > 40 * 1024) throw c.uiError("UI_STORAGE_CORRUPT");
        if (op.sendEnvelope.pluginSelection !== undefined) normalizePluginSelection(op.sendEnvelope.pluginSelection);
      }
      c.sensitive(op, this.secretMatcher); state.operations.set(op.actionRequestId, copy(op)); return;
    }
    if (type === "checkpoint.end") {
      c.fields(payload, ["stateHash"], ["stateHash"], "UI_STORAGE_CORRUPT");
      const header = state.checkpoint;
      if (!header || state.epoch !== header.finalEpoch || state.publications.size !== header.publicationCount
        || state.operations.size !== header.operationCount || this._stateHash(state) !== payload.stateHash) throw c.uiError("UI_STORAGE_CORRUPT");
      delete state.checkpoint; return;
    }
    if (type === "session.init") {
      c.fields(payload, ["sessionKey"], ["sessionKey"], "UI_STORAGE_CORRUPT"); c.id(payload.sessionKey);
      if (state.owner) throw c.uiError("UI_STORAGE_CORRUPT"); state.owner = copy(payload); return;
    }
    if (!state.owner) throw c.uiError("UI_STORAGE_CORRUPT");
    if (type === "publication.prepare") {
      c.fields(payload, ["publicationId", "callId", "fingerprint", "tool", "artifactId", "revision", "sourceEventId", "segmentId", "creatorRunId", "creatorAttemptId", "conversationEpoch", "provenance", "status", "htmlHash", "htmlBytes", "declaration", "createdAt", "bridgeApiVersion", "rendererPolicyVersion", "resourceBundleId", "legacy"], ["publicationId", "callId", "fingerprint", "tool", "artifactId", "revision", "sourceEventId", "segmentId", "creatorRunId", "creatorAttemptId", "conversationEpoch", "provenance", "status", "htmlHash", "htmlBytes", "declaration", "createdAt", "bridgeApiVersion", "rendererPolicyVersion", "resourceBundleId"], "UI_STORAGE_CORRUPT");
      const pub = payload;
      if (pub.legacy !== undefined) {
        c.fields(pub.legacy, ["blockIndex", "sourceTextHash"], ["blockIndex", "sourceTextHash"], "UI_STORAGE_CORRUPT");
        c.positive(pub.legacy.blockIndex, "UI_STORAGE_CORRUPT", true);
        if (pub.tool !== "render_ui" || pub.revision !== 1 || pub.declaration.actions.length
          || !/^[a-f0-9]{64}$/u.test(pub.legacy.sourceTextHash)) throw c.uiError("UI_STORAGE_CORRUPT");
      }
      for (const key of ["callId", "publicationId", "artifactId", "sourceEventId", "segmentId", "creatorRunId", "creatorAttemptId"]) c.id(pub[key], "UI_STORAGE_CORRUPT");
      if (pub.status !== "preparing" || !/^[a-f0-9]{64}$/u.test(pub.fingerprint) || !/^[a-f0-9]{64}$/u.test(pub.htmlHash)
        || pub.conversationEpoch !== state.epoch || state.publications.has(pub.publicationId)
        || [...state.publications.values()].some(value => value.callId === pub.callId)
        || pub.htmlBytes > this.limits.html || pub.bridgeApiVersion !== 1 || pub.rendererPolicyVersion !== 1
        || pub.resourceBundleId !== c.RESOURCE_BUNDLE_ID) throw c.uiError("UI_STORAGE_CORRUPT");
      c.positive(pub.revision); c.positive(pub.htmlBytes); c.positive(pub.createdAt, "UI_STORAGE_CORRUPT", true);
      c.normalizePublication(pub.tool, pub.declaration, this.secretMatcher);
      if (c.canonical(c.normalizeProvenance(pub.provenance)) !== c.canonical(pub.provenance)) throw c.uiError("UI_STORAGE_CORRUPT");
      const artifact = state.artifacts.get(pub.artifactId);
      if (pub.revision !== Math.max(0, ...artifact?.revisions.keys() || []) + 1 || artifact?.revisions.has(pub.revision)) throw c.uiError("UI_STORAGE_CORRUPT");
      state.publications.set(pub.publicationId, copy(pub));
      if (!artifact) state.artifacts.set(pub.artifactId, { artifactId: pub.artifactId, headRevision: 0, originSourceEventId: pub.sourceEventId, revisions: new Map() });
      state.artifacts.get(pub.artifactId).revisions.set(pub.revision, { ...copy(pub), state: copy(pub.declaration.initialState), stateRevision: 0 }); return;
    }
    if (type === "publication.ready") {
      c.fields(payload, ["publicationId", "transcriptSeq"], ["publicationId", "transcriptSeq"], "UI_STORAGE_CORRUPT");
      const pub = state.publications.get(payload.publicationId); if (!pub || pub.status !== "preparing") throw c.uiError("UI_STORAGE_CORRUPT");
      c.positive(payload.transcriptSeq); pub.status = "ready"; pub.transcriptSeq = payload.transcriptSeq;
      const artifact = state.artifacts.get(pub.artifactId), rev = artifact.revisions.get(pub.revision);
      rev.status = "ready"; rev.transcriptSeq = payload.transcriptSeq; artifact.headRevision = pub.revision; return;
    }
    if (type === "state.save") {
      c.fields(payload, ["artifactId", "revision", "state", "stateRevision"], ["artifactId", "revision", "state", "stateRevision"], "UI_STORAGE_CORRUPT");
      const rev = state.artifacts.get(payload.artifactId)?.revisions.get(payload.revision);
      if (!rev || rev.status !== "ready" || payload.stateRevision !== rev.stateRevision + 1) throw c.uiError("UI_STORAGE_CORRUPT");
      rev.state = c.normalizeState(payload.state, rev.declaration.stateSchema, this.secretMatcher); rev.stateRevision = payload.stateRevision; return;
    }
    if (type === "operation.prepare") {
      const operationFields = ["actionRequestId", "operationId", "artifactId", "revision", "sourceEventId", "actionId", "action", "baseStateRevision", "snapshot", "fingerprint", "createdAt", "sendEnvelope", "sendFingerprint", "stateRevision", "conversationEpoch", "status"];
      c.fields(payload, operationFields, operationFields, "UI_STORAGE_CORRUPT");
      const op = payload; c.id(op.actionRequestId); c.id(op.operationId); c.id(op.artifactId); c.id(op.sourceEventId);
      const rev = state.artifacts.get(op.artifactId)?.revisions.get(op.revision);
      if (state.operations.has(op.actionRequestId) || !rev || rev.status !== "ready" || rev.sourceEventId !== op.sourceEventId
        || !/^[a-f0-9]{64}$/u.test(op.fingerprint) || op.conversationEpoch !== state.epoch || op.status !== "prepared") throw c.uiError("UI_STORAGE_CORRUPT");
      c.normalizeState(op.snapshot, rev.declaration.stateSchema, this.secretMatcher); c.sensitive(op.sendEnvelope, this.secretMatcher);
      if (op.baseStateRevision !== rev.stateRevision || op.stateRevision !== rev.stateRevision
        + Number(c.canonical(op.snapshot) !== c.canonical(rev.state))) throw c.uiError("UI_STORAGE_CORRUPT");
      c.positive(op.revision); c.positive(op.createdAt, "UI_STORAGE_CORRUPT", true); c.id(op.actionId);
      c.fields(op.sendEnvelope, ["operationId", "sessionKey", "prompt", "pluginSelection"], ["operationId", "sessionKey", "prompt"], "UI_STORAGE_CORRUPT");
      if (typeof op.sendEnvelope.prompt !== "string" || !op.sendEnvelope.prompt.isWellFormed()
        || Buffer.byteLength(op.sendEnvelope.prompt) > 40 * 1024) throw c.uiError("UI_STORAGE_CORRUPT");
      if (op.sendEnvelope.pluginSelection !== undefined) normalizePluginSelection(op.sendEnvelope.pluginSelection);
      const action = rev.declaration.actions.find(value => value.actionId === op.actionId);
      if (!action || c.canonical(action) !== c.canonical(op.action) || op.sendEnvelope?.operationId !== op.operationId
        || op.sendEnvelope?.sessionKey !== state.owner.sessionKey || c.hash(op.sendEnvelope) !== op.sendFingerprint) throw c.uiError("UI_STORAGE_CORRUPT");
      // One durable journal record confirms the clicked state and freezes its
      // operation. A crash cannot confirm the save while losing the snapshot.
      rev.state = copy(op.snapshot); rev.stateRevision = op.stateRevision;
      state.operations.set(op.actionRequestId, copy(op)); return;
    }
    if (type === "operation.receipt") {
      c.fields(payload, ["actionRequestId", "status", "receipt", "publicCode", "updatedAt"], ["actionRequestId", "status", "receipt", "publicCode", "updatedAt"], "UI_STORAGE_CORRUPT");
      c.positive(payload.updatedAt, "UI_STORAGE_CORRUPT", true);
      if (payload.publicCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(payload.publicCode)) throw c.uiError("UI_STORAGE_CORRUPT");
      this._validateReceipt(payload.receipt);
      const op = state.operations.get(payload.actionRequestId);
      if (!op || !["accepted", "unknown", "expired", "failed"].includes(payload.status)) throw c.uiError("UI_STORAGE_CORRUPT");
      Object.assign(op, copy(payload)); return;
    }
    if (type === "session.invalidate") {
      c.fields(payload, ["epoch", "reason"], ["epoch", "reason"], "UI_STORAGE_CORRUPT");
      if (payload.epoch !== state.epoch + 1) throw c.uiError("UI_STORAGE_CORRUPT"); state.epoch = payload.epoch;
      for (const op of state.operations.values()) if (op.status === "prepared") op.status = "expired"; return;
    }
    if (type === "revision.revoke") {
      c.fields(payload, ["artifactId", "revision"], ["artifactId", "revision"], "UI_STORAGE_CORRUPT");
      const rev = state.artifacts.get(payload.artifactId)?.revisions.get(payload.revision);
      if (!rev) throw c.uiError("UI_STORAGE_CORRUPT"); rev.status = "revoked"; rev.state = {};
      rev.declaration = { sourceFile: "revoked", title: "来源已失效", summary: "请重新生成", stateSchemaVersion: 1,
        stateSchema: { type: "object", properties: {}, additionalProperties: false }, initialState: {}, actions: [] };
      if (rev.tool === "update_ui") Object.assign(rev.declaration, { artifactId: rev.artifactId,
        expectedRevision: rev.declaration.expectedRevision || rev.revision - 1, updateNote: "来源已失效" });
      const pub = state.publications.get(rev.publicationId); Object.assign(pub, { status: "revoked", declaration: copy(rev.declaration) });
      for (const op of state.operations.values()) if (op.artifactId === rev.artifactId && op.revision === rev.revision) {
        op.snapshot = {}; op.sendEnvelope = null; op.action = {}; if (op.status !== "accepted") op.status = "expired";
      } return;
    }
    throw c.uiError("UI_STORAGE_CORRUPT");
  }
  usage(profileId) {
    this._assertOpen(); const root = this._profileDir(profileId); if (!this._stat(root)) return 0;
    let total = 0; const scan = dir => { validateDirectoryStat(this.fs.lstatSync(dir), dir);
      for (const name of this.fs.readdirSync(dir)) { const target = path.join(dir, name), stat = this.fs.lstatSync(target);
        if (stat.isDirectory()) scan(target); else total += validatePrivateStat(stat, target).size; } };
    scan(root); return total;
  }
  _capacity(profileId, bytes, appendingState = null) {
    if (this.usage(profileId) >= this.limits.profileSoft) {
      for (const state of this.sessions.values()) if (state.profileId === profileId && state !== appendingState
        && (this._stat(this._paths(profileId, state.sessionId).log)?.size || 0) >= (state.compactBytes || 0) + COMPACT_BYTES) this._compact(state);
      this.collectUnreferenced(profileId);
    }
    if (this.usage(profileId) + bytes > this.limits.profileHard) throw c.uiError("UI_STORAGE_CAPACITY");
    const available = this.fs.statfsSync?.(this.paths.stateDir);
    if (available && available.bavail * available.bsize < this.limits.freeDisk + bytes) throw c.uiError("UI_STORAGE_CAPACITY");
  }
  _append(state, type, payload) {
    this._current(state); c.sensitive(payload, this.secretMatcher);
    if ((this._stat(this._paths(state.profileId, state.sessionId).log)?.size || 0) >= (state.compactBytes || 0) + COMPACT_BYTES) this._compact(state);
    const next = this._empty(state.profileId, state.sessionId);
    Object.assign(next, copy({ ...state, error: null })); this._apply(next, type, payload);
    const unsigned = { version: 1, seq: state.seq + 1, previous: state.checksum, type, payload };
    const record = { ...unsigned, checksum: c.hash(unsigned) }, bytes = Buffer.from(`${c.canonical(record)}\n`);
    if (bytes.length > MAX_RECORD) throw c.uiError("UI_CONTENT_TOO_LARGE"); this._capacity(state.profileId, bytes.length + 1024, state);
    const files = this._paths(state.profileId, state.sessionId); let fd, started = false;
    try {
      this.fault("beforeJournal", { type, payload });
      if (this._stat(files.log)) fd = openExistingPrivateFile(files.log, this.fs.constants.O_WRONLY | this.fs.constants.O_APPEND, this.fs);
      else fd = this.fs.openSync(files.log, this.fs.constants.O_WRONLY | this.fs.constants.O_CREAT | this.fs.constants.O_EXCL | (this.fs.constants.O_NOFOLLOW || 0), 0o600);
      started = true; writeFully(this.fs, fd, bytes); this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = undefined;
      fsyncPrivateParent(files.dir, this.fs); this.fault("afterJournal", { type, payload });
      next.seq = record.seq; next.checksum = record.checksum;
      this.atomicWrite(files.manifest, `${c.canonical(marker(next))}\n`, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      next.logIdentity = this._fileIdentity(files.log); next.manifestIdentity = this._fileIdentity(files.manifest);
      Object.assign(state, next); this.fault("afterCommit", { type, payload }); return copy(payload);
    } catch (cause) {
      const error = storeError(cause, started || cause.committedUncertain);
      if (started) state.error = c.uiError("UI_COMMIT_UNCERTAIN", { cause }); throw error;
    } finally { if (fd !== undefined) this.fs.closeSync(fd); }
  }
  ensureSession({ profileId, transcriptSessionId, sessionKey }) {
    const state = this._load(profileId, transcriptSessionId); c.id(sessionKey);
    if (state.owner && state.owner.sessionKey !== sessionKey) throw c.uiError("UI_SCOPE_MISMATCH");
    if (!state.owner) this._append(state, "session.init", { sessionKey }); return state.epoch;
  }
  _owned(owner) {
    const state = this._load(owner.profileId, owner.transcriptSessionId);
    if (state.owner?.sessionKey !== owner.sessionKey) throw c.uiError("UI_SCOPE_MISMATCH"); return state;
  }
  lookupPublication(profileId, callId, fingerprint) {
    this._assertOpen(); const entry = this.publications.get(`${c.id(profileId)}:${c.id(callId)}`); if (!entry) return null;
    const pub = this._load(profileId, entry.sessionId).publications.get(entry.publicationId);
    if (fingerprint && pub.fingerprint !== fingerprint) throw c.uiError("UI_OPERATION_CONFLICT"); return { ...copy(pub), transcriptSessionId: entry.sessionId };
  }
  preparePublication({ owner, callId, fingerprint, tool, declaration, html, creatorRunId, creatorAttemptId, provenance, legacy = null }) {
    const existing = this.lookupPublication(owner.profileId, callId, fingerprint); if (existing) return existing;
    this.ensureSession(owner); const state = this._owned(owner);
    declaration = c.normalizePublication(tool, declaration, this.secretMatcher); c.id(creatorRunId); c.id(creatorAttemptId);
    if (typeof html !== "string" || !html.isWellFormed() || !html.trim() || html.includes("\0")) throw c.uiError("UI_REQUEST_INVALID");
    const htmlBytes = Buffer.byteLength(html); if (htmlBytes > this.limits.html) throw c.uiError("UI_CONTENT_TOO_LARGE"); c.sensitive(html, this.secretMatcher);
    const artifactId = tool === "update_ui" ? declaration.artifactId : crypto.randomUUID();
    const artifact = state.artifacts.get(artifactId);
    if (tool === "update_ui" && (!artifact || artifact.headRevision !== declaration.expectedRevision)) throw c.uiError("UI_REVISION_CONFLICT");
    if (artifact && [...artifact.revisions.values()].some(rev => rev.status === "preparing")) throw c.uiError("UI_REVISION_CONFLICT");
    const htmlHash = c.hash(html), object = this._object(owner.profileId, htmlHash);
    if (!this._stat(object)) { this._capacity(owner.profileId, htmlBytes + MAX_RECORD);
      this.atomicWrite(object, html, { fs: this.fs, trustedRoot: this.paths.trustedRoot }); }
    else if (c.hash(readPrivateFile(object, { fs: this.fs, maxBytes: this.limits.html })) !== htmlHash) throw c.uiError("UI_STORAGE_CORRUPT");
    this.fault("afterObject", { htmlHash });
    const pub = { publicationId: crypto.randomUUID(), callId: c.id(callId), fingerprint, tool, artifactId,
      revision: Math.max(0, ...artifact?.revisions.keys() || []) + 1, sourceEventId: legacy?.sourceEventId || `ui-source-${crypto.randomUUID()}`,
      segmentId: legacy ? `ui-legacy-${c.hash([legacy.sourceEventId, legacy.blockIndex, htmlHash]).slice(0, 48)}` : `ui-segment-${crypto.randomUUID()}`,
      ...(legacy ? { legacy: { blockIndex: legacy.blockIndex, sourceTextHash: legacy.sourceTextHash } } : {}),
      creatorRunId, creatorAttemptId, conversationEpoch: state.epoch, provenance: c.normalizeProvenance(provenance),
      status: "preparing", htmlHash, htmlBytes, declaration, createdAt: this.now(),
      bridgeApiVersion: 1, rendererPolicyVersion: 1, resourceBundleId: c.RESOURCE_BUNDLE_ID };
    this._append(state, "publication.prepare", pub);
    this.publications.set(`${owner.profileId}:${callId}`, { sessionId: owner.transcriptSessionId, publicationId: pub.publicationId });
    return { ...copy(pub), transcriptSessionId: owner.transcriptSessionId };
  }
  publicationsForRecovery() {
    this._assertOpen(); const result = [];
    for (const state of this.sessions.values()) for (const pub of this._current(state).publications.values())
      result.push({ ...copy(pub), profileId: state.profileId, transcriptSessionId: state.sessionId, sessionKey: state.owner.sessionKey });
    return result;
  }
  markPublicationReady(owner, publicationId, transcriptSeq) {
    const state = this._owned(owner), pub = state.publications.get(publicationId); if (!pub) throw c.uiError("UI_ARTIFACT_NOT_FOUND");
    if (pub.status === "ready") return this.revision(owner, pub.artifactId, pub.revision);
    this._append(state, "publication.ready", { publicationId, transcriptSeq }); return this.revision(owner, pub.artifactId, pub.revision);
  }
  revision(owner, artifactId, revision, sourceEventId) {
    const state = this._owned(owner), rev = state.artifacts.get(c.id(artifactId))?.revisions.get(c.positive(revision));
    if (!rev) throw c.uiError("UI_ARTIFACT_NOT_FOUND"); if (sourceEventId && rev.sourceEventId !== sourceEventId) throw c.uiError("UI_SCOPE_MISMATCH");
    return { ...copy(rev), headRevision: state.artifacts.get(artifactId).headRevision, currentEpoch: state.epoch };
  }
  part(rev) { return c.normalizePart({ type: "ui_artifact", schemaVersion: 1, artifactId: rev.artifactId, revision: rev.revision,
    sourceEventId: rev.sourceEventId, segmentId: rev.segmentId, title: rev.declaration.title, summary: rev.declaration.summary }); }
  readObject(owner, rev, offset = 0) {
    // Never accept a cached descriptor as authority after revocation.
    rev = this.revision(owner, rev.artifactId, rev.revision, rev.sourceEventId);
    if (rev.status !== "ready") throw c.uiError("UI_SOURCE_EXPIRED");
    c.positive(offset, "UI_REQUEST_INVALID", true);
    const bytes = readPrivateFile(this._object(owner.profileId, rev.htmlHash), { fs: this.fs, maxBytes: this.limits.html });
    if (bytes.length !== rev.htmlBytes || c.hash(bytes) !== rev.htmlHash) throw c.uiError("UI_STORAGE_CORRUPT");
    const end = Math.min(bytes.length, offset + this.limits.chunk); if (offset > bytes.length) throw c.uiError("UI_REQUEST_INVALID");
    return { encoding: "base64", data: bytes.subarray(offset, end).toString("base64"), offset, nextOffset: end, done: end === bytes.length, htmlHash: rev.htmlHash, htmlBytes: bytes.length };
  }
  saveState(owner, artifactId, revision, baseStateRevision, patch) {
    const state = this._owned(owner), rev = this.revision(owner, artifactId, revision);
    if (rev.status !== "ready" || rev.conversationEpoch !== state.epoch) throw c.uiError("UI_SOURCE_EXPIRED");
    if (rev.stateRevision !== baseStateRevision) throw c.uiError("UI_STATE_CONFLICT", { state: { state: rev.state, stateRevision: rev.stateRevision } });
    const next = c.normalizeState({ ...rev.state, ...c.normalizePatch(patch, rev.declaration.stateSchema, this.secretMatcher) }, rev.declaration.stateSchema, this.secretMatcher);
    this._append(state, "state.save", { artifactId, revision, state: next, stateRevision: rev.stateRevision + 1 });
    return { state: next, stateRevision: rev.stateRevision + 1 };
  }
  getOperation(owner, { actionRequestId, operationId }) {
    const state = this._owned(owner); const op = actionRequestId ? state.operations.get(actionRequestId)
      : [...state.operations.values()].find(value => value.operationId === operationId); return op ? copy(op) : null;
  }
  prepareOperation(owner, operation) {
    const state = this._owned(owner), old = state.operations.get(operation.actionRequestId);
    if (old) { if (old.fingerprint !== operation.fingerprint) throw c.uiError("UI_OPERATION_CONFLICT"); return copy(old); }
    const rev = this.revision(owner, operation.artifactId, operation.revision, operation.sourceEventId);
    if (rev.status !== "ready" || rev.conversationEpoch !== state.epoch) throw c.uiError("UI_SOURCE_EXPIRED");
    if (operation.baseStateRevision !== rev.stateRevision) throw c.uiError("UI_STATE_CONFLICT", { state: { state: rev.state, stateRevision: rev.stateRevision } });
    if (this.now() - operation.createdAt >= this.limits.retentionMs || operation.createdAt > this.now() + 5000) throw c.uiError("UI_OPERATION_EXPIRED");
    const snapshot = c.normalizeState(operation.snapshot, rev.declaration.stateSchema, this.secretMatcher);
    this._append(state, "operation.prepare", { ...operation, snapshot,
      stateRevision: rev.stateRevision + Number(c.canonical(snapshot) !== c.canonical(rev.state)), conversationEpoch: state.epoch, status: "prepared" });
    return this.getOperation(owner, { actionRequestId: operation.actionRequestId });
  }
  _validateReceipt(receipt) {
    if (receipt === null) return;
    c.fields(receipt, ["runId", "disposition", "status", "reason"], ["runId", "disposition", "status", "reason"], "UI_STORAGE_CORRUPT");
    c.id(receipt.runId, "UI_STORAGE_CORRUPT");
    if (!["started", "queued", "completed"].includes(receipt.disposition)
      || !["queued", "starting", "running", "waiting_input", "waiting_approval", "completed", "canceled", "failed", "interrupted", "skipped"].includes(receipt.status)
      || receipt.reason !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(receipt.reason)) throw c.uiError("UI_STORAGE_CORRUPT");
  }
  receipt(owner, actionRequestId, status, receipt = null, publicCode = null) {
    if (receipt?.run) {
      const value = require("./chat-service-protocol").validateChatServiceResult("chat.send", receipt);
      receipt = { runId: value.run.id, disposition: value.disposition, status: value.run.status, reason: value.reason };
    }
    this._validateReceipt(receipt);
    const state = this._owned(owner);
    this._append(state, "operation.receipt", { actionRequestId, status, receipt, publicCode, updatedAt: this.now() });
    return this.getOperation(owner, { actionRequestId });
  }
  operationById(operationId) {
    this._assertOpen(); c.id(operationId);
    for (const state of this.sessions.values()) for (const op of this._current(state).operations.values()) if (op.operationId === operationId) {
      return { owner: { profileId: state.profileId, transcriptSessionId: state.sessionId, sessionKey: state.owner.sessionKey }, operation: copy(op) };
    }
    return null;
  }
  operationsForRecovery() {
    this._assertOpen(); const result = [];
    for (const state of this.sessions.values()) for (const op of this._current(state).operations.values()) result.push({
      owner: { profileId: state.profileId, transcriptSessionId: state.sessionId, sessionKey: state.owner.sessionKey }, operation: copy(op) });
    return result;
  }
  invalidate(owner, reason) {
    const state = this._owned(owner); this._append(state, "session.invalidate", { epoch: state.epoch + 1, reason }); return state.epoch;
  }
  revokeRevision(owner, artifactId, revision) {
    const state = this._owned(owner);
    if (state.artifacts.get(artifactId)?.revisions.get(revision)?.status === "revoked") return;
    this._append(state, "revision.revoke", { artifactId, revision });
    this._compact(state); this.collectUnreferenced(owner.profileId, true);
  }
  _stateHash(state) {
    return c.hash({ owner: state.owner, epoch: state.epoch, publications: [...state.publications.values()],
      artifacts: [...state.artifacts.values()].map(value => ({ ...value, revisions: [...value.revisions.values()] })),
      operations: [...state.operations.values()] });
  }
  compact(owner) { return this._compact(this._owned(owner)); }
  _compact(state) {
    this._current(state); if (!state.owner) return;
    const next = this._empty(state.profileId, state.sessionId), records = [];
    next.seq = state.seq; next.directoryIdentity = state.directoryIdentity;
    const append = (type, payload) => {
      c.sensitive(payload, this.secretMatcher); this._apply(next, type, payload);
      const unsigned = { version: 1, seq: next.seq + 1, previous: next.checksum, type, payload };
      const record = { ...unsigned, checksum: c.hash(unsigned) }, bytes = Buffer.from(`${c.canonical(record)}\n`);
      if (bytes.length > MAX_RECORD) throw c.uiError("UI_CONTENT_TOO_LARGE");
      records.push(bytes); next.seq = record.seq; next.checksum = record.checksum;
    };
    append("checkpoint.begin", { sessionKey: state.owner.sessionKey, previousSeq: state.seq, previousChecksum: state.checksum,
      publicationCount: state.publications.size, operationCount: state.operations.size, finalEpoch: state.epoch });
    for (const value of state.publications.values()) {
      const pub = copy(value), rev = state.artifacts.get(pub.artifactId).revisions.get(pub.revision);
      if (pub.conversationEpoch !== next.epoch) append("checkpoint.epoch", { epoch: pub.conversationEpoch });
      const status = pub.status, transcriptSeq = pub.transcriptSeq;
      delete pub.transcriptSeq; pub.status = "preparing"; append("publication.prepare", pub);
      if (transcriptSeq !== undefined) {
        append("publication.ready", { publicationId: pub.publicationId, transcriptSeq });
        append("checkpoint.state", { artifactId: pub.artifactId, revision: pub.revision, state: rev.state, stateRevision: rev.stateRevision });
      }
      if (status === "revoked") append("revision.revoke", { artifactId: pub.artifactId, revision: pub.revision });
    }
    if (next.epoch !== state.epoch) append("checkpoint.epoch", { epoch: state.epoch });
    for (const operation of state.operations.values()) append("checkpoint.operation", copy(operation));
    if (this._stateHash(next) !== this._stateHash(state)) throw c.uiError("UI_STORAGE_CORRUPT");
    append("checkpoint.end", { stateHash: this._stateHash(next) });
    const bytes = Buffer.concat(records), files = this._paths(state.profileId, state.sessionId);
    const usage = this.usage(state.profileId), oldBytes = this._stat(files.log)?.size || 0;
    if (usage - oldBytes + bytes.length + 1024 > this.limits.profileHard) throw c.uiError("UI_STORAGE_CAPACITY");
    const available = this.fs.statfsSync?.(this.paths.stateDir);
    if (available && available.bavail * available.bsize < this.limits.freeDisk + bytes.length) throw c.uiError("UI_STORAGE_CAPACITY");
    let replacing = false;
    try {
      this.fault("beforeCompactJournal", {}); this._current(state); replacing = true;
      const stat = this.fs.lstatSync(files.log);
      this.atomicWrite(files.log, bytes, { fs: this.fs, trustedRoot: this.paths.trustedRoot, expectedIdentity: stat });
      this.fault("afterCompactJournal", {});
      this.atomicWrite(files.manifest, `${c.canonical(marker(next))}\n`, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
      next.logIdentity = this._fileIdentity(files.log); next.manifestIdentity = this._fileIdentity(files.manifest); next.compactBytes = bytes.length;
      Object.assign(state, next); this.fault("afterCompactCommit", {});
      return { beforeBytes: oldBytes, afterBytes: bytes.length };
    } catch (cause) {
      const error = storeError(cause, replacing || cause.committedUncertain);
      if (replacing) state.error = c.uiError("UI_COMMIT_UNCERTAIN", { cause }); throw error;
    }
  }
  collectUnreferenced(profileId, force = false) {
    if (!force && this.usage(profileId) < this.limits.profileSoft) return;
    const referenced = new Set();
    for (const state of this.sessions.values()) if (state.profileId === profileId)
      for (const artifact of this._current(state).artifacts.values()) for (const rev of artifact.revisions.values()) if (rev.status !== "revoked") referenced.add(rev.htmlHash);
    const dir = path.join(this._profileDir(profileId), "objects"); if (!this._stat(dir)) return;
    validateDirectoryStat(this.fs.lstatSync(dir), dir);
    for (const name of this.fs.readdirSync(dir)) if (/^[a-f0-9]{64}\.html$/u.test(name) && !referenced.has(name.slice(0, -5))) {
      validatePrivateStat(this.fs.lstatSync(path.join(dir, name)), path.join(dir, name)); this.fs.unlinkSync(path.join(dir, name));
    }
    fsyncPrivateParent(dir, this.fs);
  }
  forgetProfile(profileId) {
    c.id(profileId);
    for (const [key, state] of this.sessions) if (state.profileId === profileId) this.sessions.delete(key);
    for (const key of this.publications.keys()) if (key.startsWith(`${profileId}:`)) this.publications.delete(key);
  }
}
module.exports = { ChatUiStore, MAX_RECORD };
