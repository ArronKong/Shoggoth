"use strict";

const fs = require("node:fs"), path = require("node:path");
const { createHash } = require("node:crypto");
const { projectJournalRecovery } = require("./group-journal-recovery");
const { atomicWritePrivateFile, recoverInterruptedPrivateFile, statIfExists } = require("./agent-service/private-file");
const { groupSendPayloadDigest, canonicalGroupSendPayload } = require("./group-send-payload");
const MAX_BYTES = 16 * 1024 * 1024, MAX_ENTRY_BYTES = 256 * 1024, MAX_SENDS = 1000, MAX_DRAFTS = 256;
const RETENTION = 30 * 24 * 60 * 60 * 1000, activeStores = new Map();
const PHASES = new Set(["prepared", "submitting", "accepted_awaiting_echo", "observed", "rejected", "needs_verification"]);
const keyOf = (scope, group, id) => JSON.stringify([scope, group, id]);
const part = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const number = value => Number.isSafeInteger(value) && value >= 0;
const emptyComposer = () => ({ text: "", mentionIds: [], replyTo: null, replyTask: null, requestRef: null, newRequest: false, summaryMemberId: "", files: [] });
const terminal = row => row.phase === "observed" || row.phase === "rejected";
const clone = value => JSON.parse(JSON.stringify(value));
const failure = code => Object.assign(new Error(code), { code });
function closed(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw failure("GROUP_JOURNAL_INVALID");
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) throw failure("GROUP_JOURNAL_INVALID");
  const result = {};
  for (const key of keys) {
    const prop = Object.getOwnPropertyDescriptor(value, key);
    if (!prop || !Object.hasOwn(prop, "value") || !prop.enumerable) throw failure("GROUP_JOURNAL_INVALID");
    result[key] = prop.value;
  }
  return result;
}
function safeTree(value, depth = 0) {
  if (depth > 16) throw failure("GROUP_JOURNAL_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw failure("GROUP_JOURNAL_INVALID");
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    if (value.length > 2048) throw failure("GROUP_JOURNAL_INVALID");
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw failure("GROUP_JOURNAL_INVALID");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const prop = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !prop || !Object.hasOwn(prop, "value") || !prop.enumerable) throw failure("GROUP_JOURNAL_INVALID");
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) throw failure("GROUP_JOURNAL_INVALID");
    result[key] = safeTree(prop.value, depth + 1);
  }
  if (Array.isArray(value) && result.length !== value.length) throw failure("GROUP_JOURNAL_INVALID");
  return result;
}
function attachment(value) {
  const row = closed(value, ["id", "name", "mimeType", "size"], ["textOffset"]);
  if (!part(row.id) || typeof row.name !== "string" || typeof row.mimeType !== "string" || !number(row.size) || row.size === 0
    || Object.hasOwn(row, "textOffset") && !number(row.textOffset)) throw failure("GROUP_JOURNAL_INVALID");
  return safeTree(row);
}
function composer(value) {
  const row = closed(value, ["text", "mentionIds", "replyTo", "replyTask", "requestRef", "newRequest", "summaryMemberId", "files"]);
  if (typeof row.text !== "string" || !Array.isArray(row.mentionIds) || !row.mentionIds.every(part) || typeof row.newRequest !== "boolean"
    || typeof row.summaryMemberId !== "string" || !Array.isArray(row.files) || row.files.length > 8) throw failure("GROUP_JOURNAL_INVALID");
  row.files = row.files.map(value => {
    const file = closed(value, ["id", "name", "status", "attachment"]);
    if (!part(file.id) || typeof file.name !== "string" || !["ready", "uploading", "error"].includes(file.status)) throw failure("GROUP_JOURNAL_INVALID");
    if (file.attachment !== null) file.attachment = attachment(file.attachment);
    return file;
  });
  if (row.replyTo !== null) {
    const quote = closed(row.replyTo, ["id", "groupId", "seq", "threadId", "author", "body", "mentions", "createdAt"],
      ["origin", "fullResult", "handoffs", "taskRef", "attachments", "replyTo"]);
    if (!part(quote.id) || !part(quote.groupId) || !number(quote.seq) || typeof quote.body !== "string" || !quote.author || !["user", "member"].includes(quote.author.kind)) throw failure("GROUP_JOURNAL_INVALID");
    quote.author = closed(quote.author, ["kind"], ["memberId"]);
    if (quote.author.kind === "member" && !part(quote.author.memberId)) throw failure("GROUP_JOURNAL_INVALID");
    quote.mentions = closed(quote.mentions, ["memberIds", "broadcast", "unresolved"], ["unsupportedBroadcast"]);
    if (!Array.isArray(quote.mentions.memberIds) || !quote.mentions.memberIds.every(part) || typeof quote.mentions.broadcast !== "boolean"
      || !Array.isArray(quote.mentions.unresolved) || !quote.mentions.unresolved.every(part)) throw failure("GROUP_JOURNAL_INVALID");
    if (quote.origin) {
      quote.origin = closed(quote.origin, [], ["opportunityId", "runId", "taskId", "attemptId", "taskVersion", "discussionId", "rootUserMessageId", "inputThroughSeq", "summary", "coordinationStale", "artifacts", "requestRevision", "requestStale", "partial", "late"]);
      if (quote.origin.requestRevision !== undefined && (!number(quote.origin.requestRevision) || quote.origin.requestRevision < 1)
        || ["requestStale", "partial", "late"].some(key => quote.origin[key] !== undefined && typeof quote.origin[key] !== "boolean")) throw failure("GROUP_JOURNAL_INVALID");
    }
    if (quote.fullResult) quote.fullResult = closed(quote.fullResult, ["bytes", "digest"]);
    if (quote.taskRef) quote.taskRef = closed(quote.taskRef, ["taskId"]);
    if (quote.attachments) quote.attachments = quote.attachments.map(attachment);
    if (quote.replyTo) quote.replyTo = closed(quote.replyTo, ["seq", "messageId", "author", "excerpt"]);
    if (quote.handoffs) quote.handoffs = quote.handoffs.map(value => closed(value, ["memberId", "excerpt"]));
    row.replyTo = quote;
  }
  if (row.replyTask !== null) {
    const task = closed(row.replyTask, ["id", "objective"]);
    if (!part(task.id) || typeof task.objective !== "string") throw failure("GROUP_JOURNAL_INVALID"); row.replyTask = task;
  }
  if (row.requestRef !== null) {
    const request = closed(row.requestRef, ["id", "label", "mode"]);
    if (!part(request.id) || typeof request.label !== "string" || !["append", "replace"].includes(request.mode)) throw failure("GROUP_JOURNAL_INVALID"); row.requestRef = request;
  }
  return safeTree(row);
}
function input(value) {
  const row = closed(value, ["clientMessageId", "body", "mentions"], ["replyTo", "taskId", "attachments", "requestMode", "discussionId", "summaryMemberId", "expectedPolicyVersion", "ownerScope"]);
  if (!part(row.clientMessageId) || typeof row.body !== "string" || !Array.isArray(row.mentions) || !row.mentions.every(part)
    || row.replyTo != null && !number(row.replyTo) || row.expectedPolicyVersion != null && !number(row.expectedPolicyVersion)
    || row.requestMode !== undefined && !["auto", "new", "append", "replace"].includes(row.requestMode)
    || ["taskId", "discussionId", "summaryMemberId", "ownerScope"].some(key => row[key] !== undefined && !part(row[key]))) throw failure("GROUP_JOURNAL_INVALID");
  if (row.attachments !== undefined) {
    if (!Array.isArray(row.attachments) || row.attachments.length > 8) throw failure("GROUP_JOURNAL_INVALID"); row.attachments = row.attachments.map(attachment);
  }
  return safeTree(row);
}
function draft(value) {
  const row = closed(value, ["version", "key", "ownerScope", "groupId", "draftId", "revision", "storageRevision", "composer", "updatedAt"], ["detached"]);
  if (row.version !== 1 || !part(row.ownerScope) || !part(row.groupId) || !part(row.draftId) || row.key !== keyOf(row.ownerScope, row.groupId, row.draftId)
    || !number(row.revision) || !number(row.storageRevision) || row.storageRevision === 0 || !number(row.updatedAt)
    || row.detached !== undefined && row.detached !== true) throw failure("GROUP_JOURNAL_INVALID");
  row.composer = composer(row.composer); return safeTree(row);
}
function send(value) {
  const row = closed(value, ["journalVersion", "key", "ownerScope", "groupId", "clientMessageId", "payloadDigest", "inputSnapshot", "draftId", "draftRevision", "composerSnapshot", "attachmentRefs", "phase", "revision", "createdAt", "lastCheckedAt", "lastError", "acceptedMessageId", "acceptedSeq", "discussionId"]);
  if (row.journalVersion !== 1 || !part(row.ownerScope) || !part(row.groupId) || !part(row.clientMessageId)
    || row.key !== keyOf(row.ownerScope, row.groupId, row.clientMessageId) || !part(row.draftId) || !number(row.draftRevision)
    || !PHASES.has(row.phase) || !number(row.revision) || row.revision === 0 || !number(row.createdAt)
    || row.lastCheckedAt !== null && !number(row.lastCheckedAt) || row.lastError !== null && typeof row.lastError !== "string"
    || row.acceptedSeq !== null && !number(row.acceptedSeq) || row.acceptedMessageId !== null && !part(row.acceptedMessageId)
    || row.discussionId !== null && !part(row.discussionId) || !Array.isArray(row.attachmentRefs) || !row.attachmentRefs.every(part)) throw failure("GROUP_JOURNAL_INVALID");
  row.inputSnapshot = input(row.inputSnapshot); row.composerSnapshot = composer(row.composerSnapshot);
  if (row.inputSnapshot.clientMessageId !== row.clientMessageId || row.payloadDigest !== groupSendPayloadDigest({ groupId: row.groupId, ...row.inputSnapshot })) throw failure("GROUP_JOURNAL_CORRUPT");
  return safeTree(row);
}
function snapshot(value) {
  const state = closed(value, ["version", "revision", "sends", "drafts"]);
  if (state.version !== 1 || !number(state.revision) || !Array.isArray(state.sends) || !Array.isArray(state.drafts)) throw failure("GROUP_JOURNAL_CORRUPT");
  state.sends = state.sends.map(send); state.drafts = state.drafts.map(draft);
  for (const rows of [state.sends, state.drafts]) if (new Set(rows.map(row => row.key)).size !== rows.length) throw failure("GROUP_JOURNAL_CORRUPT");
  return state;
}
const sameNode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
function directoryStat(stat, mode) {
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.() || typeof process.getuid === "function" && stat.uid !== process.getuid()
    || mode !== undefined && (stat.mode & 0o7777) !== mode) throw failure("GROUP_JOURNAL_UNSAFE_PATH"); return stat;
}
function fileStat(stat, links = 1) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.nlink !== links || (stat.mode & 0o7777) !== 0o600
    || typeof process.getuid === "function" && stat.uid !== process.getuid() || !number(stat.size) || stat.size > MAX_BYTES) throw failure("GROUP_JOURNAL_UNSAFE_PATH"); return stat;
}

/** Main owns one private, atomic ledger across all renderer origins. The App single-instance lock owns the process. */
class DesktopGroupSendJournalStore {
  constructor({ userDataRoot, fs: fileSystem = fs, limits = {} } = {}) {
    if (typeof userDataRoot !== "string" || !path.isAbsolute(userDataRoot)) throw failure("GROUP_JOURNAL_INVALID");
    this.fs = fileSystem; this.trustedRoot = path.resolve(userDataRoot); this.root = path.join(this.trustedRoot, "group-send-journal");
    this.file = path.join(this.root, "journal.json"); this.owner = Object.freeze({}); this.mode = "new"; this.tail = Promise.resolve();
    this.state = null; this.fileIdentity = null; this.fileBytes = null; this.limits = { bytes: MAX_BYTES, entryBytes: MAX_ENTRY_BYTES, records: MAX_SENDS, drafts: MAX_DRAFTS, confirmedRetentionMs: RETENTION, ...limits };
  }
  enqueue(operation) { const task = this.tail.then(operation); this.tail = task.catch(() => {}); return task; }
  assertAnchors() {
    if (!sameNode(directoryStat(this.fs.lstatSync(this.trustedRoot)), this.trustedIdentity)
      || !sameNode(directoryStat(this.fs.lstatSync(this.root), 0o700), this.rootIdentity)) throw failure("GROUP_JOURNAL_UNSAFE_PATH");
  }
  readTarget(links = 1) {
    this.assertAnchors(); const before = fileStat(this.fs.lstatSync(this.file), links);
    const fd = this.fs.openSync(this.file, this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try { if (!sameFile(before, fileStat(this.fs.fstatSync(fd), links))) throw failure("GROUP_JOURNAL_UNSAFE_PATH"); bytes = this.fs.readFileSync(fd); }
    finally { this.fs.closeSync(fd); }
    const after = fileStat(this.fs.lstatSync(this.file), links); this.assertAnchors();
    if (!sameFile(before, after) || !Buffer.isBuffer(bytes) || bytes.length !== after.size) throw failure("GROUP_JOURNAL_UNSAFE_PATH");
    return { bytes, identity: after };
  }
  assertOriginal(links = 1) {
    this.assertAnchors();
    if (!this.fileIdentity) { if (statIfExists(this.fs, this.file)) throw failure("GROUP_JOURNAL_UNSAFE_PATH"); return; }
    const current = this.readTarget(links);
    if (!sameFile(current.identity, this.fileIdentity) || !current.bytes.equals(this.fileBytes)) throw failure("GROUP_JOURNAL_UNSAFE_PATH");
  }
  verifyDisk() {
    if (this.mode !== "open") throw failure("GROUP_JOURNAL_UNAVAILABLE");
    try { this.assertOriginal(); } catch { this.mode = "failed"; throw failure("GROUP_JOURNAL_COMMIT_UNKNOWN"); }
  }
  guardedFs() {
    const guarded = Object.create(this.fs);
    for (const method of ["lstatSync", "openSync", "fstatSync", "readFileSync", "writeSync", "fsyncSync", "fchmodSync", "readdirSync", "unlinkSync"]) guarded[method] = (...args) => {
      this.assertAnchors(); const value = this.fs[method](...args); this.assertAnchors(); return value;
    };
    guarded.closeSync = fd => { const result = this.fs.closeSync(fd); this.assertAnchors(); return result; };
    guarded.linkSync = (source, destination) => { this.assertAnchors(); if (source === this.file) this.assertOriginal(); const result = this.fs.linkSync(source, destination); this.assertAnchors(); return result; };
    guarded.renameSync = (source, destination) => { this.assertAnchors(); if (source === `${this.file}.tmp` && destination === this.file) this.assertOriginal(this.fileIdentity ? 2 : 1); const result = this.fs.renameSync(source, destination); this.assertAnchors(); return result; };
    return guarded;
  }
  bounded(state, prune = true) {
    if (prune) state.sends = state.sends.filter(row => !terminal(row) || Date.now() - (row.lastCheckedAt ?? row.createdAt) < this.limits.confirmedRetentionMs);
    if (state.sends.length > this.limits.records || state.drafts.length > this.limits.drafts
      || [...state.sends, ...state.drafts].some(row => Buffer.byteLength(JSON.stringify(row)) > this.limits.entryBytes)
      || Buffer.byteLength(JSON.stringify(state)) > this.limits.bytes) throw failure("GROUP_JOURNAL_FULL");
    return state;
  }
  commit(value) {
    const state = this.bounded(value), bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    this.assertOriginal();
    try {
      atomicWritePrivateFile(this.file, bytes, { trustedRoot: this.trustedRoot, fs: this.guardedFs(), expectedIdentity: this.fileIdentity });
      const current = this.readTarget(); if (!current.bytes.equals(bytes)) throw failure("GROUP_JOURNAL_COMMIT_UNKNOWN");
      this.fileIdentity = current.identity; this.fileBytes = current.bytes; this.state = state;
    } catch (error) {
      if (error?.committed || error?.committedUncertain) this.mode = "failed";
      else { try { this.assertOriginal(); } catch { this.mode = "failed"; } }
      throw failure(this.mode === "failed" ? "GROUP_JOURNAL_COMMIT_UNKNOWN" : "GROUP_JOURNAL_WRITE_FAILED");
    }
  }
  open() {
    if (this.mode !== "new") return Promise.reject(failure("GROUP_JOURNAL_UNAVAILABLE")); this.mode = "opening";
    return this.enqueue(() => {
      try {
        if (activeStores.has(this.root)) throw failure("GROUP_JOURNAL_ALREADY_OPEN"); activeStores.set(this.root, this.owner);
        this.trustedIdentity = directoryStat(this.fs.lstatSync(this.trustedRoot));
        const created = !statIfExists(this.fs, this.root);
        if (created) this.fs.mkdirSync(this.root, { mode: 0o700 });
        this.rootIdentity = directoryStat(this.fs.lstatSync(this.root), 0o700); this.assertAnchors();
        if (created) {
          const fd = this.fs.openSync(this.trustedRoot, this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
          try { if (!sameNode(directoryStat(this.fs.fstatSync(fd)), this.trustedIdentity)) throw failure("GROUP_JOURNAL_UNSAFE_PATH"); this.fs.fsyncSync(fd); }
          finally { this.fs.closeSync(fd); }
          this.assertAnchors();
        }
        for (const name of this.fs.readdirSync(this.root)) {
          if (name !== "journal.json" && name !== "journal.json.tmp" && !/^journal\.json\.backup-[1-9][0-9]*-[a-f0-9]{16}$/.test(name)) throw failure("GROUP_JOURNAL_UNSAFE_PATH");
          const stat = this.fs.lstatSync(path.join(this.root, name));
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw failure("GROUP_JOURNAL_UNSAFE_PATH");
        }
        const recovery = recoverInterruptedPrivateFile(this.file, { fs: this.guardedFs(), trustedRoot: this.trustedRoot });
        if (recovery === "uncertain") throw failure("GROUP_JOURNAL_COMMIT_UNKNOWN");
        if (statIfExists(this.fs, this.file)) {
          const current = this.readTarget(); let state;
          try { state = this.bounded(snapshot(JSON.parse(current.bytes.toString("utf8"))), false); }
          catch { throw failure("GROUP_JOURNAL_CORRUPT"); }
          if (!current.bytes.equals(Buffer.from(`${JSON.stringify(state)}\n`, "utf8"))) throw failure("GROUP_JOURNAL_CORRUPT");
          this.state = state; this.fileIdentity = current.identity; this.fileBytes = current.bytes;
        } else {
          if (recovery !== "none") throw failure("GROUP_JOURNAL_COMMIT_UNKNOWN");
          this.commit({ version: 1, revision: 0, sends: [], drafts: [] });
        }
        this.mode = "open"; return clone(this.state);
      } catch (error) { this.mode = "failed"; if (activeStores.get(this.root) === this.owner) activeStores.delete(this.root); throw failure(error?.code?.startsWith("GROUP_") ? error.code : "GROUP_JOURNAL_UNAVAILABLE"); }
    });
  }
  run(operation) { return this.enqueue(() => { this.verifyDisk(); return clone(operation()); }); }
  next() { if (this.state.revision === Number.MAX_SAFE_INTEGER) throw failure("GROUP_JOURNAL_FULL"); return { ...clone(this.state), revision: this.state.revision + 1 }; }
  read(value) {
    const request = closed(value, ["ownerScope", "groupId"]);
    if (!part(request.ownerScope) || !part(request.groupId)) return Promise.reject(failure("GROUP_JOURNAL_INVALID"));
    return this.run(() => ({ sends: this.state.sends.filter(row => row.ownerScope === request.ownerScope && row.groupId === request.groupId),
      foreignPending: this.state.sends.filter(row => row.ownerScope !== request.ownerScope && row.groupId === request.groupId && !terminal(row)).length,
      draft: this.state.drafts.filter(row => row.ownerScope === request.ownerScope && row.groupId === request.groupId && !row.detached).sort((a, b) => {
        const aEmpty = JSON.stringify(a.composer) === JSON.stringify(emptyComposer()), bEmpty = JSON.stringify(b.composer) === JSON.stringify(emptyComposer());
        return Number(aEmpty) - Number(bEmpty) || b.updatedAt - a.updatedAt;
      })[0] ?? null }));
  }
  recover(value) {
    const request = closed(value, ["ownerScope", "groupId", "offset", "snapshotDigest"]);
    if (!part(request.ownerScope) || !part(request.groupId) || !number(request.offset) || request.offset > 1256
      || !(request.snapshotDigest === null || /^[a-f0-9]{64}$/u.test(request.snapshotDigest))) return Promise.reject(failure("GROUP_JOURNAL_INVALID"));
    return this.enqueue(() => {
      if (!["open", "failed"].includes(this.mode)) throw failure("GROUP_JOURNAL_UNAVAILABLE");
      // Recheck the private anchored file even after normal open refused its contents.
      // Never repair, normalize, rename or import a damaged journal here.
      const current = this.readTarget(), snapshotDigest = createHash("sha256").update(current.bytes).digest("hex");
      if (request.offset > 0 && request.snapshotDigest !== snapshotDigest) throw failure("GROUP_JOURNAL_RECOVERY_CHANGED");
      let state; try { state = JSON.parse(current.bytes.toString("utf8")); }
      catch { throw failure("GROUP_JOURNAL_RECOVERY_UNAVAILABLE"); }
      return projectJournalRecovery(state, { ...request, snapshotDigest });
    });
  }
  importLegacy(value) {
    const request = closed(value, ["sends", "drafts"]);
    if (!Array.isArray(request.sends) || !Array.isArray(request.drafts) || request.sends.length > MAX_SENDS || request.drafts.length > MAX_DRAFTS) return Promise.reject(failure("GROUP_JOURNAL_INVALID"));
    request.sends = request.sends.map(send); request.drafts = request.drafts.map(draft);
    return this.run(() => {
      const state = this.next(); let changed = false;
      for (const old of request.sends) {
        const existing = state.sends.find(row => row.key === old.key);
        if (existing) { if (existing.payloadDigest !== old.payloadDigest) throw failure("GROUP_SEND_PAYLOAD_CONFLICT"); continue; }
        state.sends.push({ ...old, phase: "needs_verification", lastError: "GROUP_JOURNAL_MIGRATED", lastCheckedAt: null }); changed = true;
      }
      for (const old of request.drafts) {
        const existing = state.drafts.find(row => row.key === old.key);
        if (existing) {
          // A consumed or subsequently edited Main draft is newer than the old origin snapshot.
          if (existing.storageRevision >= old.storageRevision) continue;
          throw failure("GROUP_DRAFT_CONFLICT");
        }
        state.drafts.push(old); changed = true;
      }
      if (changed) this.commit(state);
      return { imported: true };
    });
  }
  saveComposer(value) {
    const request = closed(value, ["ownerScope", "groupId", "draftId", "revision", "composer", "expectedStorageRevision"], ["detached"]);
    if (![request.ownerScope, request.groupId, request.draftId].every(part) || !number(request.revision) || !number(request.expectedStorageRevision)
      || request.detached !== undefined && request.detached !== true) return Promise.reject(failure("GROUP_JOURNAL_INVALID"));
    request.composer = composer(request.composer);
    return this.run(() => {
      const key = keyOf(request.ownerScope, request.groupId, request.draftId), state = this.next();
      const previous = state.drafts.find(row => row.key === key);
      if ((previous?.storageRevision ?? 0) !== request.expectedStorageRevision || previous && previous.revision > request.revision) throw failure("GROUP_DRAFT_CONFLICT");
      const saved = { version: 1, key, ownerScope: request.ownerScope, groupId: request.groupId, draftId: request.draftId, revision: request.revision,
        storageRevision: request.expectedStorageRevision + 1, composer: request.composer, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1), ...(request.detached ? { detached: true } : {}) };
      const protectedIds = new Set(state.sends.filter(row => !terminal(row)).map(row => row.draftId));
      state.drafts = state.drafts.filter(row => row.key !== key && !(row.ownerScope === request.ownerScope && row.groupId === request.groupId
        && !protectedIds.has(row.draftId) && JSON.stringify(row.composer) === JSON.stringify(emptyComposer()))); state.drafts.push(saved);
      this.commit(state); return saved;
    });
  }
  prepare(value) {
    const request = closed(value, ["ownerScope", "groupId", "inputSnapshot", "draft"]);
    request.inputSnapshot = input(request.inputSnapshot); request.draft = draft(request.draft);
    if (!part(request.ownerScope) || request.ownerScope !== request.draft.ownerScope || request.groupId !== request.draft.groupId
      || request.inputSnapshot.ownerScope !== request.ownerScope) return Promise.reject(failure("GROUP_JOURNAL_SCOPE_UNAVAILABLE"));
    return this.run(() => {
      const state = this.next(), payloadDigest = groupSendPayloadDigest({ groupId: request.groupId, ...request.inputSnapshot });
      const key = keyOf(request.ownerScope, request.groupId, request.inputSnapshot.clientMessageId), existing = state.sends.find(row => row.key === key);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest || canonicalGroupSendPayload({ groupId: request.groupId, ...existing.inputSnapshot }) !== canonicalGroupSendPayload({ groupId: request.groupId, ...request.inputSnapshot })) throw failure("GROUP_SEND_PAYLOAD_CONFLICT"); return existing;
      }
      const saved = state.drafts.find(row => row.key === request.draft.key);
      if (!saved || saved.storageRevision < request.draft.storageRevision || saved.revision < request.draft.revision
        || saved.revision === request.draft.revision && JSON.stringify(saved.composer) !== JSON.stringify(request.draft.composer)) throw failure("GROUP_DRAFT_CONFLICT");
      const record = { journalVersion: 1, key, ownerScope: request.ownerScope, groupId: request.groupId, clientMessageId: request.inputSnapshot.clientMessageId,
        payloadDigest, inputSnapshot: request.inputSnapshot, draftId: request.draft.draftId, draftRevision: request.draft.revision, composerSnapshot: request.draft.composer,
        attachmentRefs: (request.inputSnapshot.attachments ?? []).map(row => row.id), phase: "prepared", revision: 1, createdAt: Date.now(),
        lastCheckedAt: null, lastError: null, acceptedMessageId: null, acceptedSeq: null, discussionId: null };
      state.sends.push(record); this.commit(state); return record;
    });
  }
  update(value) {
    const request = closed(value, ["record", "patch"]); request.record = send(request.record);
    request.patch = closed(request.patch, [], ["phase", "lastCheckedAt", "lastError", "acceptedMessageId", "acceptedSeq", "discussionId"]);
    if (request.patch.phase !== undefined && !PHASES.has(request.patch.phase)) return Promise.reject(failure("GROUP_JOURNAL_INVALID"));
    return this.run(() => {
      const state = this.next(), index = state.sends.findIndex(row => row.key === request.record.key), current = state.sends[index];
      if (!current || current.payloadDigest !== request.record.payloadDigest) throw failure("GROUP_SEND_PAYLOAD_CONFLICT");
      if (terminal(current) || current.revision !== request.record.revision && !["observed", "accepted_awaiting_echo"].includes(request.patch.phase)
        || current.phase === "accepted_awaiting_echo" && !["observed", "accepted_awaiting_echo"].includes(request.patch.phase ?? current.phase)) return current;
      const next = send({ ...current, ...request.patch, revision: current.revision + 1,
        lastError: request.patch.lastError === undefined ? current.lastError : request.patch.lastError?.slice(0, 2000) ?? null });
      state.sends[index] = next; this.commit(state); return next;
    });
  }
  accepted(value) {
    const request = closed(value, ["record", "message", "discussionId"]); request.record = send(request.record);
    const message = closed(request.message, ["id", "groupId", "seq"]);
    if (!part(message.id) || message.groupId !== request.record.groupId || !number(message.seq) || request.discussionId !== null && !part(request.discussionId)) return Promise.reject(failure("GROUP_SEND_LOOKUP_IDENTITY_MISMATCH"));
    return this.run(() => {
      const state = this.next(), index = state.sends.findIndex(row => row.key === request.record.key), current = state.sends[index];
      if (!current || current.payloadDigest !== request.record.payloadDigest) throw failure("GROUP_SEND_PAYLOAD_CONFLICT");
      if (current.acceptedMessageId !== null && current.acceptedMessageId !== message.id || current.acceptedSeq !== null && current.acceptedSeq !== message.seq) throw failure("GROUP_SEND_LOOKUP_IDENTITY_MISMATCH");
      const next = { ...current, phase: "observed", acceptedMessageId: message.id, acceptedSeq: message.seq, discussionId: request.discussionId, lastCheckedAt: Date.now(), lastError: null, revision: current.revision + 1 };
      const draftIndex = state.drafts.findIndex(row => row.ownerScope === current.ownerScope && row.groupId === current.groupId && row.draftId === current.draftId);
      let saved = state.drafts[draftIndex] ?? null;
      if (saved && saved.revision === current.draftRevision && JSON.stringify(saved.composer) === JSON.stringify(current.composerSnapshot)) {
        saved = { ...saved, composer: emptyComposer(), revision: saved.revision + 1, storageRevision: saved.storageRevision + 1, updatedAt: Date.now() }; state.drafts[draftIndex] = saved;
      }
      state.sends[index] = next; this.commit(state); return { record: next, draft: saved };
    });
  }
  close() { return this.enqueue(() => { this.mode = "closed"; if (activeStores.get(this.root) === this.owner) activeStores.delete(this.root); }); }
}
module.exports = { DesktopGroupSendJournalStore, closed, input, composer, draft, send, safeTree };
