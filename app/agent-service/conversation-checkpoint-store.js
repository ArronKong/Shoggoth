"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");

const CHECKPOINT_VERSION = 2;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const SUMMARY_FIELDS = Object.freeze([
  "goal", "state", "decisions", "constraints", "rejectedApproaches", "files", "commands",
  "tests", "openQuestions", "nextActions",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const validId = value => typeof value === "string" && ID.test(value);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fail(code = "CHECKPOINT_INVALID") { throw serviceError(code, "会话摘要无效或原文已变化"); }
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function validateSummary(value) {
  if (!exact(value, SUMMARY_FIELDS)) fail();
  for (const field of SUMMARY_FIELDS) {
    if (!Array.isArray(value[field]) || value[field].length > 64
      || value[field].some(text => typeof text !== "string" || !text.trim() || !text.isWellFormed()
        || text.includes("\0") || Buffer.byteLength(text) > 4096 || hasSecret(text))) fail();
  }
  if (Buffer.byteLength(stable(value)) > 16 * 1024) fail("CHECKPOINT_SUMMARY_TOO_LARGE");
  return structuredClone(value);
}

// Hash the exact covered prefix, including exclusion flags and tool results.
// Later appends are compatible; an edit/exclusion within coverage invalidates it.
function coveredTranscript(events, throughSeq) {
  if (!Array.isArray(events) || !Number.isSafeInteger(throughSeq) || throughSeq < 1) fail();
  const prefix = events.filter(event => event.seq <= throughSeq);
  if (!prefix.length || prefix.at(-1).seq !== throughSeq) fail("CHECKPOINT_SOURCE_MISSING");
  return { events: prefix, hash: sha256(stable(prefix)) };
}

function validateCheckpoint(record) {
  const fields = ["version", "id", "profileId", "sessionId", "coveredThroughSeq", "coveredHash",
    "transcriptRevision", "previousId", "summary", "provenance", "createdAt", "contentHash"];
  if (record?.version === 2) fields.push("partial");
  if (!exact(record, fields) || ![1, CHECKPOINT_VERSION].includes(record.version)
    || !validId(record.profileId) || !validId(record.sessionId)
    || !Number.isSafeInteger(record.coveredThroughSeq) || record.coveredThroughSeq < (record.partial ? 0 : 1)
    || !Number.isSafeInteger(record.transcriptRevision) || record.transcriptRevision < 1
    || !HASH.test(record.coveredHash) || !HASH.test(record.contentHash)
    || record.id !== `checkpoint-${record.contentHash}`
    || !(record.previousId === null || /^checkpoint-[a-f0-9]{64}$/u.test(record.previousId))
    || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) fail();
  if (record.partial != null && (!exact(record.partial, ["seq", "offset", "length", "hash"])
    || !Number.isSafeInteger(record.partial.seq) || record.partial.seq <= record.coveredThroughSeq
    || !Number.isSafeInteger(record.partial.offset) || record.partial.offset < 1
    || !Number.isSafeInteger(record.partial.length) || record.partial.offset >= record.partial.length
    || !HASH.test(record.partial.hash))) fail();
  const p = record.provenance;
  if (!exact(p, ["runId", "bindingId", "runtime", "model", "method", ...(Object.hasOwn(p || {}, "sourceNativeSessionId")
    ? ["sourceNativeSessionId", "sourceBindingId"] : []), ...(Object.hasOwn(p || {}, "contextWindow") ? ["contextWindow"] : [])])
    || !validId(p.runId) || !validId(p.bindingId) || typeof p.runtime !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(p.runtime)
    || typeof p.model !== "string" || !p.model || p.model.length > 512 || !p.model.isWellFormed() || p.model.includes("\0") || hasSecret(p.model)
    || (Object.hasOwn(p, "sourceNativeSessionId") && (!validId(p.sourceBindingId)
      || !(p.sourceNativeSessionId === null || (typeof p.sourceNativeSessionId === "string"
        && p.sourceNativeSessionId.length > 0 && p.sourceNativeSessionId.length <= 512 && !p.sourceNativeSessionId.includes("\0")))))
    || (p.contextWindow !== undefined && (!Number.isSafeInteger(p.contextWindow) || p.contextWindow < 1))
    || p.method !== "model") fail();
  validateSummary(record.summary);
  const { id: _id, contentHash, ...material } = record;
  if (sha256(stable(material)) !== contentHash || Buffer.byteLength(stable(record)) > MAX_CHECKPOINT_BYTES) fail();
  return structuredClone(record);
}

class ConversationCheckpointStore {
  constructor({ paths, transcriptStore, now = Date.now }) {
    if (!paths?.agentsDir || !paths?.trustedRoot || !transcriptStore?.listEvents || !transcriptStore?.getRevision) {
      throw new TypeError("ConversationCheckpointStore needs Service paths and TranscriptStore");
    }
    this.paths = paths; this.transcriptStore = transcriptStore; this.now = now; this.opened = false;
  }
  open() { ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot); this.opened = true; }
  close() { this.opened = false; }
  #file(profileId, sessionId) {
    if (!this.opened) fail("CHECKPOINT_STORE_CLOSED");
    if (typeof profileId !== "string" || !ID.test(profileId) || typeof sessionId !== "string" || !ID.test(sessionId)) fail();
    const directory = path.join(this.paths.agentsDir, profileId, "conversation-checkpoints");
    ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
    return path.join(directory, `${sha256(sessionId)}.json`);
  }
  get(profileId, sessionId) {
    const file = this.#file(profileId, sessionId);
    if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("CHECKPOINT_COMMIT_UNCERTAIN");
    if (!lstatIfExists(file)) return null;
    let record;
    try { record = validateCheckpoint(JSON.parse(readPrivateFile(file, { maxBytes: MAX_CHECKPOINT_BYTES }))); }
    catch { fail("CHECKPOINT_STORE_CORRUPT"); }
    if (record.profileId !== profileId || record.sessionId !== sessionId) fail("CHECKPOINT_STORE_CORRUPT");
    return record;
  }
  compatible(profileId, sessionId, events = this.transcriptStore.listEvents(profileId, sessionId)) {
    const record = this.get(profileId, sessionId);
    if (!record) return null;
    try { return coveredTranscript(events, record.partial?.seq ?? record.coveredThroughSeq).hash === record.coveredHash ? record : null; }
    catch { return null; }
  }
  generations(profileId, sessionId, events = this.transcriptStore.listEvents(profileId, sessionId)) {
    const records = [];
    let record = this.compatible(profileId, sessionId, events);
    while (record && records.length < 512) {
      records.push(record);
      if (!record.previousId) break;
      const file = path.join(path.dirname(this.#file(profileId, sessionId)), `${record.previousId}.json`);
      if (!lstatIfExists(file)) break;
      const previous = validateCheckpoint(JSON.parse(readPrivateFile(file, { maxBytes: MAX_CHECKPOINT_BYTES })));
      if (previous.id !== record.previousId || previous.profileId !== profileId || previous.sessionId !== sessionId
        || coveredTranscript(events, previous.partial?.seq ?? previous.coveredThroughSeq).hash !== previous.coveredHash) break;
      record = previous;
    }
    return records;
  }
  portable(profileId, sessionId, events) {
    return this.generations(profileId, sessionId, events).find(record => !record.partial) ?? null;
  }
  invalidation(profileId, sessionId, nativeSessionId, bindingId) {
    const checkpoint = this.get(profileId, sessionId);
    if (!checkpoint || this.compatible(profileId, sessionId)) return null;
    const events = this.transcriptStore.listEvents(profileId, sessionId);
    const coverageHash = coveredTranscript(events, checkpoint.partial?.seq ?? checkpoint.coveredThroughSeq).hash;
    const file = `${this.#file(profileId, sessionId)}.invalidation`;
    if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("CHECKPOINT_COMMIT_UNCERTAIN");
    if (lstatIfExists(file)) {
      const saved = JSON.parse(readPrivateFile(file, { maxBytes: 4096 }));
      if (!saved || Object.keys(saved).sort().join() !== "bindingId,checkpointId,coverageHash,nativeSessionId,version"
        || saved.version !== 1 || typeof saved.nativeSessionId !== "string" || typeof saved.bindingId !== "string") fail("CHECKPOINT_STORE_CORRUPT");
      if (saved.checkpointId === checkpoint.id && saved.coverageHash === coverageHash) return saved;
    }
    if (!nativeSessionId) return null;
    const record = { version: 1, checkpointId: checkpoint.id, coverageHash, nativeSessionId, bindingId };
    atomicWritePrivateFile(file, `${JSON.stringify(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    return record;
  }
  commit({ profileId, sessionId, expectedRevision, throughSeq, coveredHash, previousId = null, partial = null, summary, provenance }) {
    const file = this.#file(profileId, sessionId);
    const events = this.transcriptStore.listEvents(profileId, sessionId);
    const current = this.compatible(profileId, sessionId, events);
    if (current?.coveredThroughSeq === throughSeq && current.coveredHash === coveredHash
      && stable(current.partial ?? null) === stable(partial)
      && current.provenance.runId === provenance?.runId) return current;
    const revision = this.transcriptStore.getRevision(profileId, sessionId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || revision < expectedRevision) fail("CHECKPOINT_STALE");
    const coverage = coveredTranscript(events, partial?.seq ?? throughSeq);
    if (coverage.hash !== coveredHash) fail("CHECKPOINT_STALE");
    const advances = !current || throughSeq > (current.partial?.seq ?? current.coveredThroughSeq)
      || (throughSeq === current.partial?.seq && !partial)
      || (throughSeq > current.coveredThroughSeq && (!current.partial || partial?.seq >= current.partial.seq))
      || (throughSeq === current.coveredThroughSeq && partial
        && (!current.partial || (partial.seq === current.partial.seq && partial.hash === current.partial.hash
          && partial.offset > current.partial.offset)));
    if ((current?.id ?? null) !== previousId || !advances) fail("CHECKPOINT_STALE");
    const material = { version: CHECKPOINT_VERSION, profileId, sessionId, coveredThroughSeq: throughSeq,
      coveredHash, transcriptRevision: expectedRevision, previousId, partial, summary: validateSummary(summary),
      provenance: structuredClone(provenance), createdAt: this.now() };
    const contentHash = sha256(stable(material));
    const record = validateCheckpoint({ ...material, id: `checkpoint-${contentHash}`, contentHash });
    const historyFile = path.join(path.dirname(file), `${record.id}.json`);
    // Immutable generations remain available for audit/restore even after the
    // latest pointer advances. An interrupted pointer commit cannot erase one.
    if (!lstatIfExists(historyFile)) atomicWritePrivateFile(historyFile, `${stable(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    atomicWritePrivateFile(file, `${stable(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    return record;
  }
}

module.exports = { ConversationCheckpointStore, CHECKPOINT_VERSION, SUMMARY_FIELDS, MAX_CHECKPOINT_BYTES,
  validateSummary, validateCheckpoint, coveredTranscript };
