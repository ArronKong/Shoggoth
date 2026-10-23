"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { HistoricalMemoryAnnotations } = require("./historical-memory-annotations");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");
const { normalizeBorrowedMemoryRefs, mergeBorrowedMemoryRefs, refsFromEvents, extractBorrowedMemoryRefs,
  borrowedMemoryPlaceholder } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");

const CHECKPOINT_VERSION = 2;
// Version 1 did not capture pre-admission recall on resumed sessions. Retire
// it once: missing historical dependencies cannot be reconstructed reliably.
// Version 3 adds memoryInvalidationRevision; version 2 is still accepted.
const NATIVE_MEMORY_ANCHOR_VERSION = 3;
const CHECKPOINT_MEMORY_ANCHOR_VERSION = 2;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const SUMMARY_FIELDS = Object.freeze([
  "goal", "state", "decisions", "constraints", "rejectedApproaches", "files", "commands",
  "tests", "openQuestions", "nextActions",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const validId = value => typeof value === "string" && ID.test(value);
const validNativeSessionId = value => typeof value === "string" && value.length > 0
  && value.length <= 512 && value.isWellFormed() && !value.includes("\0");
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fail(code = "CHECKPOINT_INVALID") { throw serviceError(code, "会话摘要无效或原文已变化"); }
// A new memory item reaches a continuing native session through the current
// memory block, so it does not invalidate earlier context. Only an edit,
// removal or retirement of an existing item does. Records written before
// memoryInvalidationRevision existed keep the stricter full-revision check.
function memoryRevisionCurrent(record, revision, invalidationRevision) {
  return Object.hasOwn(record, "memoryInvalidationRevision")
    ? record.memoryInvalidationRevision === invalidationRevision
    : record.memoryRevision === revision;
}
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
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
  if (Object.hasOwn(record || {}, "borrowedMemoryRefs")) fields.push("borrowedMemoryRefs");
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
  if (record.borrowedMemoryRefs !== undefined) normalizeBorrowedMemoryRefs(record.borrowedMemoryRefs);
  const { id: _id, contentHash, ...material } = record;
  if (sha256(stable(material)) !== contentHash || Buffer.byteLength(stable(record)) > MAX_CHECKPOINT_BYTES) fail();
  return structuredClone(record);
}

class ConversationCheckpointStore {
  constructor({ paths, transcriptStore, memoryStore = null, recallPolicy = null,
    borrowedMemoryDependenciesCurrent = null, now = Date.now }) {
    if (!paths?.agentsDir || !paths?.trustedRoot || !transcriptStore?.listEvents || !transcriptStore?.getRevision) {
      throw new TypeError("ConversationCheckpointStore needs Service paths and TranscriptStore");
    }
    if (memoryStore !== null && (!memoryStore.getRevision || !memoryStore.list)) {
      throw new TypeError("ConversationCheckpointStore needs MemoryStore revision and list");
    }
    if (recallPolicy !== null && (!recallPolicy.getRevision || !recallPolicy.hasRevocations)) {
      throw new TypeError("ConversationCheckpointStore needs RecallPolicy revision and revocation status");
    }
    this.paths = paths; this.transcriptStore = transcriptStore; this.memoryStore = memoryStore;
    this.recallPolicy = recallPolicy;
    this.borrowedMemoryDependenciesCurrent = borrowedMemoryDependenciesCurrent;
    this.historicalMemory = memoryStore && recallPolicy?.getMemoryReason
      ? new HistoricalMemoryAnnotations({ memoryStore, recallPolicy, now }) : null;
    this.now = now; this.opened = false; this.memoryStates = new Map();
  }
  open() { ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot); this.opened = true; }
  close() { this.opened = false; this.memoryStates.clear(); this.historicalMemory?.clear(); }
  hasRevocations(profileId) { return this.recallPolicy?.hasRevocations(profileId) === true; }
  hasHistoricalSource(profileId, events, { fromSeq = 0, throughSeq = Infinity } = {}) {
    if (!this.historicalMemory) return false;
    const view = this.historicalMemory.view(profileId);
    if (!view.hasHistorical) return false;
    const userSeqs = new Map(events.filter((event) => event.kind === "user")
      .map((event) => [event.id, { runId: event.runId, seq: event.seq }]));
    const sourceSeq = (eventId, runId) => {
      const source = userSeqs.get(eventId);
      return source?.runId === runId ? source.seq : null;
    };
    return events.some((event) => event.seq > fromSeq && event.seq <= throughSeq
      && !event.contextExcluded && ["user", "assistant"].includes(event.kind)
      && (view.forEvent(event) || view.forAssistant(event, sourceSeq)));
  }
  memoryState(profileId) {
    if (!this.memoryStore) return { revision: null, invalidationRevision: null, freshUntil: null };
    // Read both counters from one memory state. A store without invalidation
    // tracking treats every change as an invalidation.
    const revisions = this.memoryStore.getRevisions?.(profileId);
    const revision = revisions ? revisions.revision : this.memoryStore.getRevision(profileId);
    const invalidationRevision = revisions ? revisions.invalidationRevision : revision;
    const cached = this.memoryStates.get(profileId);
    if (cached?.revision === revision && cached.invalidationRevision === invalidationRevision
      && (cached.freshUntil === null || this.now() < cached.freshUntil)) return cached;
    const now = this.now();
    let freshUntil = null;
    for (const item of this.memoryStore.list(profileId, { status: "active" })) {
      if (item.validUntil !== null && item.validUntil > now) freshUntil = freshUntil === null
        ? item.validUntil : Math.min(freshUntil, item.validUntil);
    }
    const state = { revision, invalidationRevision, freshUntil };
    this.memoryStates.set(profileId, state);
    return state;
  }
  borrowedDependenciesCurrent(profileId, sessionId, refs) {
    const normalized = normalizeBorrowedMemoryRefs(refs || []);
    if (!normalized.length) return true;
    if (normalized.some(ref => ref.requesterProfileId !== profileId)) return false;
    try { return this.borrowedMemoryDependenciesCurrent?.(profileId, sessionId, normalized) === true; }
    catch { return false; }
  }
  projectCompactionEvent(profileId, sessionId, event) {
    const refs = extractBorrowedMemoryRefs(event);
    if (refs.length && !this.borrowedDependenciesCurrent(profileId, sessionId, refs)) {
      return { seq: event.seq, kind: event.kind, content: {
        text: borrowedMemoryPlaceholder(refs, "invalid"), persistPolicy: "reference_only",
      } };
    }
    return { seq: event.seq, kind: event.kind,
      content: this.transcriptStore.contextEvent?.(profileId, sessionId, event)?.content ?? event.content,
      ...(refs.length ? { borrowedMemoryRefs: refs } : {}) };
  }
  #projectCompactionSource(profileId, sessionId, events, descriptor) {
    const projected = events.filter(event => event.seq > descriptor.fromSeq && event.seq <= descriptor.throughSeq
      && !event.contextExcluded && ["user", "assistant", "tool_call", "tool_result"].includes(event.kind))
      .map(event => this.projectCompactionEvent(profileId, sessionId, event));
    const refs = mergeBorrowedMemoryRefs(...projected.map(extractBorrowedMemoryRefs));
    if (!descriptor.fragment) return { source: projected, refs };
    const fragment = descriptor.fragment;
    if (!exact(fragment, ["seq", "offset", "end", "length", "hash"])
      || projected.length !== 1 || fragment.seq !== projected[0].seq
      || !Number.isSafeInteger(fragment.offset) || fragment.offset < 0
      || !Number.isSafeInteger(fragment.end) || fragment.end <= fragment.offset
      || !Number.isSafeInteger(fragment.length) || fragment.end > fragment.length
      || !HASH.test(fragment.hash)) fail("CHECKPOINT_STALE");
    const encoded = JSON.stringify(projected[0]);
    if (encoded.length !== fragment.length || sha256(encoded) !== fragment.hash) fail("CHECKPOINT_STALE");
    return { refs, source: [{ seq: fragment.seq, kind: projected[0].kind,
      fragment: { text: encoded.slice(fragment.offset, fragment.end), offset: fragment.offset,
        length: fragment.length, hash: fragment.hash, encoding: "json" } }] };
  }
  createSourceProjection({ profileId, sessionId, events, previous, throughSeq, partial, source }) {
    const fragment = source.find(event => event.fragment)?.fragment;
    const descriptor = { version: 1, fromSeq: previous?.coveredThroughSeq ?? 0,
      throughSeq: partial?.seq ?? throughSeq,
      fragment: fragment ? { seq: source[0].seq, offset: fragment.offset,
        end: fragment.offset + fragment.text.length, length: fragment.length, hash: fragment.hash } : null,
      sourceHash: sha256(stable(source)), borrowedMemoryRefs: [] };
    const projected = this.#projectCompactionSource(profileId, sessionId, events, descriptor);
    if (sha256(stable(projected.source)) !== descriptor.sourceHash) fail("CHECKPOINT_STALE");
    descriptor.borrowedMemoryRefs = mergeBorrowedMemoryRefs(previous?.borrowedMemoryRefs, projected.refs);
    return descriptor;
  }
  assertSourceProjectionCurrent(plan) {
    const { profileId, sessionId, throughSeq, partial, coveredHash, previousId = null, sourceProjection } = plan;
    const events = this.transcriptStore.listEvents(profileId, sessionId);
    if (coveredTranscript(events, partial?.seq ?? throughSeq).hash !== coveredHash) fail("CHECKPOINT_STALE");
    // Older persisted commands and direct commits cannot drop provenance.
    if (!sourceProjection) {
      const refs = refsFromEvents(events, { throughSeq: partial?.seq ?? throughSeq });
      if (!this.borrowedDependenciesCurrent(profileId, sessionId, refs)) fail("CHECKPOINT_STALE");
      return refs;
    }
    if (!exact(sourceProjection, ["version", "fromSeq", "throughSeq", "fragment", "sourceHash", "borrowedMemoryRefs"])
      || sourceProjection.version !== 1 || !Number.isSafeInteger(sourceProjection.fromSeq) || sourceProjection.fromSeq < 0
      || sourceProjection.throughSeq !== (partial?.seq ?? throughSeq) || !HASH.test(sourceProjection.sourceHash)) fail("CHECKPOINT_STALE");
    const previous = this.compatible(profileId, sessionId, events);
    if ((previous?.id ?? null) !== previousId
      || sourceProjection.fromSeq !== (previous?.coveredThroughSeq ?? 0)) fail("CHECKPOINT_STALE");
    const projected = this.#projectCompactionSource(profileId, sessionId, events, sourceProjection);
    const refs = mergeBorrowedMemoryRefs(previous?.borrowedMemoryRefs, projected.refs);
    if (sha256(stable(projected.source)) !== sourceProjection.sourceHash
      || stable(normalizeBorrowedMemoryRefs(sourceProjection.borrowedMemoryRefs)) !== stable(refs)
      || !this.borrowedDependenciesCurrent(profileId, sessionId, refs)) fail("CHECKPOINT_STALE");
    return refs;
  }
  sessionBorrowedMemoryRefs(profileId, sessionId) {
    return refsFromEvents(this.transcriptStore.listEvents(profileId, sessionId));
  }
  #memoryCompatible(profileId, record) {
    if (!this.borrowedDependenciesCurrent(profileId, record.sessionId, record.borrowedMemoryRefs)) return false;
    // Compaction has no per-fact provenance, so any revocation invalidates a
    // summary and prevents it from carrying a forgotten utterance forward.
    if (this.hasRevocations(profileId)) return false;
    if (!this.memoryStore) return true;
    const current = this.memoryState(profileId);
    if (current.freshUntil !== null && this.now() >= current.freshUntil) return false;
    const file = this.#memoryAnchorFile(profileId, record.sessionId, record.id);
    if (!lstatIfExists(file)) return false;
    let anchor;
    try { anchor = JSON.parse(readPrivateFile(file, { maxBytes: 4096 })); }
    catch { fail("CHECKPOINT_STORE_CORRUPT"); }
    const { checksum: anchorChecksum, ...anchorBody } = anchor || {};
    const tracked = anchor?.version === CHECKPOINT_MEMORY_ANCHOR_VERSION;
    if (!exact(anchor, ["version", "profileId", "checkpointId", "memoryRevision",
      ...(tracked ? ["memoryInvalidationRevision"] : []), "memoryFreshUntil", "checksum"])
      || ![1, CHECKPOINT_MEMORY_ANCHOR_VERSION].includes(anchor.version) || anchor.profileId !== profileId
      || (tracked && !validRevision(anchor.memoryInvalidationRevision))
      || anchor.checkpointId !== record.id
      || !memoryRevisionCurrent(anchor, current.revision, current.invalidationRevision)
      || anchor.memoryFreshUntil !== current.freshUntil
      || anchorChecksum !== sha256(stable(anchorBody))) return false;
    return true;
  }
  #memoryAnchorFile(profileId, sessionId, checkpointId) {
    return path.join(path.dirname(this.#file(profileId, sessionId)), `${checkpointId}.memory-anchor.json`);
  }
  #nativeMemoryAnchorFile(profileId, sessionId) {
    return path.join(path.dirname(this.#file(profileId, sessionId)), `${sha256(sessionId)}.native-memory-anchor.json`);
  }
  nativeMemoryVersion(profileId, sessionId = null) {
    // A native Runtime retains its own conversation history. This version is
    // independent of product checkpoints, which may never have existed.
    if (!this.memoryStore || !this.recallPolicy) return null;
    const memory = this.memoryState(profileId);
    return { memoryRevision: memory.revision, memoryInvalidationRevision: memory.invalidationRevision,
      memoryFreshUntil: memory.freshUntil, policyRevision: this.recallPolicy.getRevision(profileId),
      ...(sessionId ? { borrowedMemoryRefs: this.sessionBorrowedMemoryRefs(profileId, sessionId) } : {}) };
  }
  #nativeMemoryAnchor(profileId, sessionId) {
    const file = this.#nativeMemoryAnchorFile(profileId, sessionId);
    if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") {
      fail("CHECKPOINT_COMMIT_UNCERTAIN");
    }
    if (!lstatIfExists(file)) return null;
    let anchor;
    try { anchor = JSON.parse(readPrivateFile(file, { maxBytes: 256 * 1024 })); }
    catch { fail("CHECKPOINT_STORE_CORRUPT"); }
    const { checksum, ...body } = anchor || {};
    const tracked = anchor?.version === NATIVE_MEMORY_ANCHOR_VERSION;
    if (!exact(anchor, ["version", "profileId", "sessionId", "nativeSessionId", "bindingId",
      "memoryRevision", ...(tracked ? ["memoryInvalidationRevision"] : []), "memoryFreshUntil", "policyRevision", "checksum",
      ...(Object.hasOwn(anchor || {}, "borrowedMemoryRefs") ? ["borrowedMemoryRefs"] : [])])
      || ![1, 2, NATIVE_MEMORY_ANCHOR_VERSION].includes(anchor.version) || anchor.profileId !== profileId || anchor.sessionId !== sessionId
      || !validNativeSessionId(anchor.nativeSessionId) || !validId(anchor.bindingId)
      || !validRevision(anchor.memoryRevision)
      || (tracked && !validRevision(anchor.memoryInvalidationRevision))
      || !(anchor.memoryFreshUntil === null || Number.isSafeInteger(anchor.memoryFreshUntil)
        && anchor.memoryFreshUntil >= 0)
      || !Number.isSafeInteger(anchor.policyRevision) || anchor.policyRevision < 1
      || !HASH.test(checksum) || sha256(stable(body)) !== checksum) fail("CHECKPOINT_STORE_CORRUPT");
    if (anchor.borrowedMemoryRefs !== undefined) normalizeBorrowedMemoryRefs(anchor.borrowedMemoryRefs);
    return anchor;
  }
  nativeSessionBorrowedMemoryRefs(profileId, sessionId, nativeSessionId, bindingId) {
    if (!validNativeSessionId(nativeSessionId) || !validId(bindingId)) fail();
    const anchor = this.#nativeMemoryAnchor(profileId, sessionId);
    if (!anchor || anchor.nativeSessionId !== nativeSessionId || anchor.bindingId !== bindingId) return [];
    const refs = normalizeBorrowedMemoryRefs(anchor.borrowedMemoryRefs || []);
    if (refs.some(ref => ref.requesterProfileId !== profileId)) fail("CHECKPOINT_STORE_CORRUPT");
    // Recovery uses only verified dependency metadata. Current authorization
    // must still be checked by the caller; an old anchor never grants body access.
    return refs;
  }
  // Version 1 anchors are always stale (see NATIVE_MEMORY_ANCHOR_VERSION).
  #nativeMemoryCurrent(anchor, current) {
    return anchor.version !== 1
      && memoryRevisionCurrent(anchor, current.memoryRevision, current.memoryInvalidationRevision)
      && anchor.memoryFreshUntil === current.memoryFreshUntil
      && anchor.policyRevision === current.policyRevision;
  }
  nativeSessionStale(profileId, sessionId, nativeSessionId, bindingId) {
    if (!nativeSessionId || !this.memoryStore || !this.recallPolicy) return false;
    const anchor = this.#nativeMemoryAnchor(profileId, sessionId);
    const current = this.nativeMemoryVersion(profileId);
    return !anchor
      || !this.borrowedDependenciesCurrent(profileId, sessionId, anchor.borrowedMemoryRefs)
      || anchor.nativeSessionId !== nativeSessionId || anchor.bindingId !== bindingId
      || !this.#nativeMemoryCurrent(anchor, current);
  }
  recordNativeSession(profileId, sessionId, nativeSessionId, bindingId, expected) {
    if (!this.memoryStore || !this.recallPolicy) return false;
    if (!validNativeSessionId(nativeSessionId) || !validId(bindingId)) fail();
    const current = this.nativeMemoryVersion(profileId);
    if (!expected || expected.memoryRevision !== current.memoryRevision
      || (expected.memoryInvalidationRevision !== undefined
        && expected.memoryInvalidationRevision !== current.memoryInvalidationRevision)
      || expected.memoryFreshUntil !== current.memoryFreshUntil
      || expected.policyRevision !== current.policyRevision) return false;
    const prior = this.#nativeMemoryAnchor(profileId, sessionId);
    const continuing = prior?.nativeSessionId === nativeSessionId && prior.bindingId === bindingId;
    // A resumed Runtime still holds every previously accepted borrowed fact,
    // even when the current Product snapshot contains fewer dependencies.
    const borrowedMemoryRefs = mergeBorrowedMemoryRefs(continuing ? prior.borrowedMemoryRefs || [] : [],
      expected.borrowedMemoryRefs !== undefined
        ? normalizeBorrowedMemoryRefs(expected.borrowedMemoryRefs) : this.sessionBorrowedMemoryRefs(profileId, sessionId));
    if (continuing && !this.#nativeMemoryCurrent(prior, current)) return false;
    if (!this.borrowedDependenciesCurrent(profileId, sessionId, borrowedMemoryRefs)) return false;
    const body = { version: NATIVE_MEMORY_ANCHOR_VERSION, profileId, sessionId, nativeSessionId, bindingId, ...current,
      ...(borrowedMemoryRefs.length ? { borrowedMemoryRefs } : {}) };
    const anchor = { ...body, checksum: sha256(stable(body)) };
    atomicWritePrivateFile(this.#nativeMemoryAnchorFile(profileId, sessionId), `${stable(anchor)}\n`,
      { trustedRoot: this.paths.trustedRoot });
    return true;
  }
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
    if (!record || !this.#memoryCompatible(profileId, record)) return null;
    const throughSeq = record.partial?.seq ?? record.coveredThroughSeq;
    if (this.hasHistoricalSource(profileId, events, { throughSeq })) return null;
    try { return coveredTranscript(events, throughSeq).hash === record.coveredHash ? record : null; }
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
        || !this.#memoryCompatible(profileId, previous)
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
    const guarded = Boolean(this.memoryStore || this.recallPolicy);
    const memory = this.memoryState(profileId);
    const policyRevision = this.recallPolicy?.getRevision(profileId) ?? null;
    const file = `${this.#file(profileId, sessionId)}.${guarded ? "memory-invalidation" : "invalidation"}`;
    if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("CHECKPOINT_COMMIT_UNCERTAIN");
    if (lstatIfExists(file)) {
      const saved = JSON.parse(readPrivateFile(file, { maxBytes: 4096 }));
      const tracked = guarded && saved?.version === 3;
      if (!exact(saved, guarded ? ["version", "checkpointId", "coverageHash", "nativeSessionId", "bindingId",
        "memoryRevision", ...(tracked ? ["memoryInvalidationRevision"] : []), "memoryFreshUntil", "policyRevision"]
        : ["version", "checkpointId", "coverageHash", "nativeSessionId", "bindingId"])
        || !(guarded ? [2, 3] : [1]).includes(saved.version)
        || (tracked && saved.memoryInvalidationRevision !== null && !validRevision(saved.memoryInvalidationRevision))
        || typeof saved.nativeSessionId !== "string" || typeof saved.bindingId !== "string") fail("CHECKPOINT_STORE_CORRUPT");
      if (saved.checkpointId === checkpoint.id && saved.coverageHash === coverageHash
        && (!guarded || (memoryRevisionCurrent(saved, memory.revision, memory.invalidationRevision)
          && saved.memoryFreshUntil === memory.freshUntil
          && saved.policyRevision === policyRevision))) return saved;
    }
    if (!nativeSessionId) return null;
    const record = { version: guarded ? 3 : 1, checkpointId: checkpoint.id, coverageHash,
      nativeSessionId, bindingId,
      ...(guarded ? { memoryRevision: memory.revision, memoryInvalidationRevision: memory.invalidationRevision,
        memoryFreshUntil: memory.freshUntil, policyRevision } : {}) };
    atomicWritePrivateFile(file, `${JSON.stringify(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    return record;
  }
  commit({ profileId, sessionId, expectedRevision, expectedMemoryRevision = null,
    expectedMemoryFreshUntil = null, throughSeq, coveredHash, previousId = null,
    partial = null, summary, provenance, borrowedMemoryRefs = [], sourceProjection = null }) {
    const file = this.#file(profileId, sessionId);
    if (this.hasRevocations(profileId)) fail("CHECKPOINT_STALE");
    const memory = this.memoryState(profileId);
    if (this.memoryStore && (expectedMemoryRevision !== memory.revision
      || expectedMemoryFreshUntil !== memory.freshUntil)) fail("CHECKPOINT_STALE");
    const events = this.transcriptStore.listEvents(profileId, sessionId);
    if (this.hasHistoricalSource(profileId, events,
      { throughSeq: partial?.seq ?? throughSeq })) fail("CHECKPOINT_STALE");
    const current = this.compatible(profileId, sessionId, events);
    if (current?.coveredThroughSeq === throughSeq && current.coveredHash === coveredHash
      && stable(current.partial ?? null) === stable(partial)
      && current.provenance.runId === provenance?.runId) return current;
    const borrowedRefs = mergeBorrowedMemoryRefs(borrowedMemoryRefs,
      this.assertSourceProjectionCurrent({ profileId, sessionId, throughSeq, partial, coveredHash,
        previousId, sourceProjection }));
    if (!this.borrowedDependenciesCurrent(profileId, sessionId, borrowedRefs)) fail("CHECKPOINT_STALE");
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
      provenance: structuredClone(provenance), createdAt: this.now(),
      ...(borrowedRefs.length ? { borrowedMemoryRefs: borrowedRefs } : {}) };
    const contentHash = sha256(stable(material));
    const record = validateCheckpoint({ ...material, id: `checkpoint-${contentHash}`, contentHash });
    const historyFile = path.join(path.dirname(file), `${record.id}.json`);
    // Immutable generations remain available for audit/restore even after the
    // latest pointer advances. An interrupted pointer commit cannot erase one.
    if (!lstatIfExists(historyFile)) atomicWritePrivateFile(historyFile, `${stable(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    if (this.memoryStore) {
      const anchorFile = this.#memoryAnchorFile(profileId, sessionId, record.id);
      const anchor = { version: CHECKPOINT_MEMORY_ANCHOR_VERSION, profileId, checkpointId: record.id,
        memoryRevision: memory.revision, memoryInvalidationRevision: memory.invalidationRevision,
        memoryFreshUntil: memory.freshUntil };
      anchor.checksum = sha256(stable(anchor));
      if (lstatIfExists(anchorFile)) {
        let saved;
        try { saved = JSON.parse(readPrivateFile(anchorFile, { maxBytes: 4096 })); }
        catch { fail("CHECKPOINT_STORE_CORRUPT"); }
        if (stable(saved) !== stable(anchor)) fail("CHECKPOINT_STALE");
      } else atomicWritePrivateFile(anchorFile, `${stable(anchor)}\n`, { trustedRoot: this.paths.trustedRoot });
    }
    atomicWritePrivateFile(file, `${stable(record)}\n`, { trustedRoot: this.paths.trustedRoot });
    return record;
  }
}

module.exports = { ConversationCheckpointStore, CHECKPOINT_VERSION, SUMMARY_FIELDS, MAX_CHECKPOINT_BYTES,
  validateSummary, validateCheckpoint, coveredTranscript };
