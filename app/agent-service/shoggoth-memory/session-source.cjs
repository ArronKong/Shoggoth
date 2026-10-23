"use strict";

const { isHistoricalChatSession } = require("../historical-chat-session");
const { serviceError } = require("../security");
const { core } = require("./host.cjs");
const { isBorrowedMemoryDerived } = require("./borrowed-memory-provenance.cjs");
const { isUiActionSubmission } = require("../ui-input-provenance");
const { findProfileSession, listProfileSessions } = require("../chat-session-lookup");

// Active Memory rechecks its evidence on nearly every host call. A projection
// is reused only while its full authority stamp and the historical-memory view
// (supersession and time-based expiry) are unchanged.
const MAX_CACHED_PROJECTIONS = 64;
const MAX_CACHED_PROJECTION_BYTES = 2 * 1024 * 1024;

// OpenClaw consumes a normalized transcript. Only Shoggoth's authenticated
// Product transcript can supply it; a Runtime's own log is never authoritative.
class ProductMemorySessions {
  constructor({ sessions, transcripts, recall, database, assertProfile }) {
    this.sessions = sessions; this.transcripts = transcripts; this.recall = recall;
    this.database = database; this.assertProfile = assertProfile;
    this.requiresStartupContentRecheck = true;
    this.projections = new Map();
  }
  list(profileId) {
    this.assertProfile(profileId);
    const forgotten = new Set(this.database.tombstones(profileId).map(row => row.sessionId));
    return listProfileSessions(this.sessions, profileId).filter(session => isHistoricalChatSession(session) && !forgotten.has(session.id)
      && !this.sessions.getCronSessionOrigin?.(session.sessionKey))
      .map(session => ({ ...session, interactive: true, updatedAt: session.updatedAt || 0 }));
  }
  // Same admission as list(), for one session without projecting the roster.
  current(profileId, sessionId) {
    this.assertProfile(profileId);
    const session = findProfileSession(this.sessions, profileId, sessionId);
    if (!session || !isHistoricalChatSession(session) || this.sessions.getCronSessionOrigin?.(session.sessionKey)
      || this.database.tombstones(profileId).some(row => row.sessionId === sessionId)) {
      throw serviceError("MEMORY_SESSION_REVOKED", "会话已撤回或不属于当前助理");
    }
    return { ...session, interactive: true, updatedAt: session.updatedAt || 0 };
  }
  stamp(profileId, sessionId) {
    const session = this.current(profileId, sessionId);
    return JSON.stringify([session, this.transcripts.getRevision(profileId, sessionId),
      this.recall.getVisibilityRevision(profileId), this.recall.policy.getRevision(profileId)]);
  }
  read(profileId, sessionId) {
    const session = this.current(profileId, sessionId), stamp = this.stamp(profileId, sessionId);
    const epoch = this.recall.candidateSourceEpoch?.(profileId) ?? null, key = `${profileId}\0${sessionId}`;
    const cached = this.projections.get(key);
    if (cached?.stamp === stamp && cached.epoch === epoch) return structuredClone(cached.value);
    const lines = [], lineMap = [], timestamps = [], provenance = [];
    let afterSeq = 0, size = 0, pendingRun = false;
    for (;;) {
      const page = this.recall.scanEligibleSession({ profileId, sessionId, afterSeq, limit: 100, completedOnly: true });
      for (const event of page.events) {
        if (isBorrowedMemoryDerived(event) || isUiActionSubmission(event)) continue;
        try { this.recall.assertCandidateSourceCurrent(profileId, event); }
        catch (error) { if (error.code === "MEMORY_CANDIDATE_SOURCE_OUTDATED") continue; throw error; }
        const line = `${event.kind === "user" ? "User" : "Assistant"}: ${event.text.replace(/\s+/gu, " ").trim()}`;
        size += Buffer.byteLength(line) + 1;
        if (size > 16 * 1024 * 1024) throw serviceError("MEMORY_TRANSCRIPT_TOO_LARGE", "会话超过记忆扫描上限");
        lines.push(line); lineMap.push(event.seq); timestamps.push(event.occurredAt);
        provenance.push({ originClass: event.kind === "user" ? "owner" : "agent", sessionKind: "interactive",
          observedAt: event.occurredAt, channel: "webchat", chatType: "direct" });
      }
      // A turn whose Run has not completed ends the page early. It may complete
      // without a transcript write, so that projection is never reused.
      if (!page.hasMore || page.throughSeq <= afterSeq) { pendingRun = page.hasMore; break; }
      afterSeq = page.throughSeq;
    }
    if (stamp !== this.stamp(profileId, sessionId)) throw serviceError("MEMORY_SESSION_CHANGED", "会话在读取期间发生变化");
    const content = lines.join("\n"), mtimeMs = timestamps.reduce((latest, time) => Math.max(latest, time), session.updatedAt || 0);
    // Equal text at different Product sequences is a different source. Use the
    // upstream snapshot identity so citations cannot survive a sequence change.
    const hash = core.hashSessionEntrySnapshot({ content, lineMap, messageTimestampsMs: timestamps,
      lineProvenance: provenance, resetRecallCutoff: null });
    const value = { content, hash, authorityStamp: stamp, lineMap, messageTimestampsMs: timestamps, lineProvenance: provenance,
      // Native SQLite transcript stats use maxSeq when mutation wall time is
      // unavailable. Product's durable journal revision includes context edits.
      mtimeMs, revisionMs: this.transcripts.getRevision(profileId, sessionId), size: Buffer.byteLength(content), sessionKind: "interactive" };
    this.projections.delete(key);
    if (!pendingRun && value.size <= MAX_CACHED_PROJECTION_BYTES) {
      this.projections.set(key, { stamp, epoch, value: structuredClone(value) });
      while (this.projections.size > MAX_CACHED_PROJECTIONS) this.projections.delete(this.projections.keys().next().value);
    }
    return value;
  }
  stat(profileId, sessionId) { return this.read(profileId, sessionId); }
  transcriptStats(profileId, sessionId) {
    const value = this.read(profileId, sessionId);
    const snapshot = this.transcripts.getIndexSnapshot(profileId, sessionId);
    // These are normalized eligible Product events and bytes. No Product
    // journal sequence or source hash is represented as a wall-clock time.
    return { eventCount: value.lineMap.length, maxSeq: snapshot.lastSeq, sizeBytes: value.size };
  }
  subscribeChanges(listener, { profileId, signal } = {}) {
    this.assertProfile(profileId);
    if (typeof listener !== "function") throw new TypeError("Invalid memory session listener");
    const controller = new AbortController();
    const stops = [];
    const unsubscribe = () => {
      controller.abort();
      signal?.removeEventListener("abort", unsubscribe);
      for (const stop of stops.splice(0)) stop();
    };
    if (signal?.aborted) { unsubscribe(); return unsubscribe; }
    const emit = update => { if (!controller.signal.aborted) listener(update); };
    try {
      stops.push(this.transcripts.subscribeChanges(event => {
        if (event.profileId !== profileId) return;
        const session = findProfileSession(this.sessions, profileId, event.sessionId);
        if (!session) { emit({ reconcile: true }); return; }
        emit({ target: { agentId: profileId, sessionId: session.id, sessionKey: session.sessionKey || "" } });
      }, { signal: controller.signal }));
      stops.push(this.sessions.subscribeChanges(event => {
        if (event.profileIds.includes(profileId)) emit({ reconcile: true });
      }, { signal: controller.signal }));
      stops.push(this.recall.policy.subscribeChanges(event => {
        if (event.profileId === profileId) emit({ reconcile: true });
      }, { signal: controller.signal }));
      signal?.addEventListener("abort", unsubscribe, { once: true });
    } catch (error) { unsubscribe(); throw error; }
    return unsubscribe;
  }
  metadata(profileId, sessionId) {
    this.current(profileId, sessionId);
    return { channel: "webchat", chatType: "direct" };
  }
}

module.exports = { ProductMemorySessions };
