"use strict";

// OpenClaw's bundled session-memory hook, adapted to Product sessions. When a
// direct conversation ends, its newest messages are kept as a short excerpt in
// today's daily note, so the next conversation starts with them (bootstrap
// loads today's and yesterday's notes). No model call. A conversation ends
// when the user opens a new one with the same Agent, after IDLE_MS without a
// new message, or at the nightly maintenance pass. Every excerpt line keeps
// its source evidence: a forgotten session or an excluded message also leaves
// the excerpt (forgetSession and sourceEvidenceVisible).
//
// Per-session progress (captured and reviewed sequence) lives in the Agent's
// own state store and is shared with the nightly review.

const { core } = require("./host.cjs");
const { sha256 } = require("./migration.cjs");
const { hasSecret, hasPii } = require("../memory-engine");
const { serviceError } = require("../security");
const { MAX_CONTENT_BYTES } = require("../memory-store");
const { diagnosticCode } = require("./active-memory-diagnostics.cjs");

const PROGRESS_NAMESPACE = "session-memory-progress";
const BASELINE_KEY = "baseline";
const MAX_MESSAGES = 15; // OpenClaw session-memory default
const MAX_LINE_CHARS = 500;
const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 10 * 60_000;
// First run only looks back this far; older conversations count as done.
const BACKFILL_MS = 7 * 24 * 60 * 60_000;
const ENTRY_MARKER = /<!--\s*\/?(?:shoggoth|openclaw)-memory/iu;

const sessionKey = sessionId => `session:${sessionId}`;
const clip = (line, maxBytes) => {
  const chars = Array.from(line);
  let bytes = 0, end = 0;
  for (; end < Math.min(chars.length, MAX_LINE_CHARS); end++) {
    const size = Buffer.byteLength(chars[end]);
    if (bytes + size + (end + 1 < chars.length ? Buffer.byteLength("…") : 0) > maxBytes) break;
    bytes += size;
  }
  return chars.slice(0, end).join("") + (end < chars.length ? "…" : "");
};

class SessionCapture {
  constructor(service) {
    this.service = service;
    this.locks = new Map();
    this.timer = null;
    this.sweeping = false;
    // Group-chat member sessions are not direct conversations (set by the Service).
    this.isInternalSession = () => false;
  }

  start(signal) {
    this.stop();
    this.timer = setInterval(() => {
      if (this.sweeping || signal.aborted) return;
      this.sweeping = true;
      this.sweep({ signal }).catch(() => {}).finally(() => { this.sweeping = false; });
    }, SWEEP_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  store(profileId) {
    return this.service.host(profileId).database.openKeyedStore({ namespace: PROGRESS_NAMESPACE, maxEntries: 50_000 });
  }
  async progress(profileId, sessionId) {
    return { capturedSeq: 0, reviewedSeq: 0, ...(await this.store(profileId).lookup(sessionKey(sessionId)) || {}) };
  }
  // Sequences only move forward.
  async advance(profileId, sessionId, patch) {
    await this.store(profileId).update(sessionKey(sessionId), current => {
      const next = { capturedSeq: 0, reviewedSeq: 0, ...(current || {}) };
      for (const [name, value] of Object.entries(patch)) {
        next[name] = name.endsWith("Seq") ? Math.max(next[name] || 0, value) : value;
      }
      return { ...next, updatedAt: this.service.now() };
    });
  }
  async baseline(profileId) {
    const store = this.store(profileId);
    await store.registerIfAbsent(BASELINE_KEY, { since: this.service.now() - BACKFILL_MS });
    return (await store.lookup(BASELINE_KEY)).since;
  }

  // Direct conversations this Agent may learn from (cron and forgotten
  // sessions are already excluded by the Product session reader).
  sessions(profileId) {
    return this.service.host(profileId).sessions.list(profileId).filter(session => !this.isInternalSession(session.sessionKey));
  }

  day(profileId, time) {
    const cfg = this.service.config(profileId);
    const config = core.resolveMemoryDeepDreamingConfig({ cfg, pluginConfig: core.resolveMemoryDreamingPluginConfig(cfg) });
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone || undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return { day: core.formatMemoryDreamingDay(time, config.timezone), clock: clock.format(time) };
  }

  async withLock(profileId, sessionId, task) {
    const key = `${profileId}\0${sessionId}`, previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  // Keeps the messages after the last capture. idleMs > 0 skips a conversation
  // whose newest message is more recent than that.
  capture(profileId, sessionId, { reason, idleMs = 0, signal } = {}) {
    return this.withLock(profileId, sessionId, () => this.captureLocked(profileId, sessionId, { reason, idleMs, signal }));
  }
  async captureLocked(profileId, sessionId, { reason, idleMs, signal }) {
    const service = this.service, host = service.host(profileId);
    signal?.throwIfAborted();
    let session, source;
    try {
      session = host.sessions.current(profileId, sessionId);
      if (this.isInternalSession(session.sessionKey)) return { written: 0, reason: "ineligible" };
      source = host.sessions.read(profileId, sessionId);
    } catch (error) {
      if (["MEMORY_SESSION_REVOKED", "MEMORY_SESSION_CHANGED"].includes(error.code)) return { written: 0, reason: "ineligible" };
      throw error;
    }
    const [progress, since] = await Promise.all([this.progress(profileId, sessionId), this.baseline(profileId)]);
    const lines = source.content ? source.content.split("\n") : [];
    const fresh = lines.map((line, index) => ({ line, seq: source.lineMap[index], at: source.messageTimestampsMs[index] }))
      .filter(row => row.seq > progress.capturedSeq && row.at >= since);
    const observed = { observedSeq: this.lastSeq(profileId, sessionId) };
    if (!fresh.length) { await this.advance(profileId, sessionId, observed); return { written: 0, reason: "nothing-new" }; }
    const now = service.now();
    if (idleMs > 0 && now - fresh.at(-1).at < idleMs) return { written: 0, reason: "active" };
    const lastSeq = fresh.at(-1).seq;
    // A credential line would block the whole note from entering context.
    const kept = fresh.slice(-MAX_MESSAGES).filter(row => !hasSecret(row.line) && !ENTRY_MARKER.test(row.line));
    if (!kept.some(row => row.line.startsWith("User: "))) {
      await this.advance(profileId, sessionId, { capturedSeq: lastSeq, ...observed });
      return { written: 0, reason: "no-user-message" };
    }
    const { day, clock } = this.day(profileId, now);
    const header = `Session excerpt (${reason}) ${day} ${clock} · session ${sessionId.slice(0, 8)}`;
    const lineBytes = Math.floor((MAX_CONTENT_BYTES - Buffer.byteLength(header) - kept.length * 3) / kept.length);
    const content = [header, ...kept.map(row => `- ${clip(row.line, lineBytes)}`)].join("\n");
    const id = `session-excerpt-${sha256(`${profileId}:${sessionId}:${lastSeq}`).slice(0, 40)}`;
    if (!service.store.get(profileId, id)) {
      const stamp = host.sessions.stamp(profileId, sessionId);
      const check = () => {
        signal?.throwIfAborted(); host.assertCurrent();
        if (host.sessions.stamp(profileId, sessionId) !== stamp) throw serviceError("MEMORY_SOURCE_REVOKED", "会话摘录的来源已经变化");
      };
      await service.store.upsertMany([{ id, profileId, scope: "agent", type: "episodic", content,
        sourceRefs: [`session-excerpt:${sessionId}`], confidence: 0.5, sensitivity: hasPii(content) ? "private" : "normal",
        status: "active", validFrom: now, validUntil: null, supersedes: null, createdAt: now, updatedAt: now,
        memoryPath: `memory/${day}.md`, sourceEvidence: kept.map(row => ({ sessionId, seq: row.seq, hash: sha256(row.line) })) }],
      { assertCurrent: check });
    }
    await this.advance(profileId, sessionId, { capturedSeq: lastSeq, ...observed });
    return { written: 1, reason: "captured", id };
  }

  // Session updatedAt follows settings, not messages: the transcript's last
  // sequence tells whether a conversation changed.
  lastSeq(profileId, sessionId) { return this.service.transcriptStore.getLastEventSeq(profileId, sessionId) || 0; }

  // Captures every eligible conversation of one Agent that changed since it
  // was last looked at. One that last changed before the baseline counts as
  // done for excerpts and the nightly review alike.
  async captureProfile(profileId, { reason, idleMs = IDLE_MS, exceptSessionId = null, signal } = {}) {
    const since = await this.baseline(profileId), transcripts = this.service.transcriptStore;
    let written = 0;
    for (const session of this.sessions(profileId)) {
      signal?.throwIfAborted();
      if (session.id === exceptSessionId) continue;
      try {
        const lastSeq = this.lastSeq(profileId, session.id), progress = await this.progress(profileId, session.id);
        if (progress.observedSeq === lastSeq) continue;
        const last = lastSeq > 0 ? transcripts.listEventsPage(profileId, session.id, lastSeq - 1, 1)[0] : null;
        if (!last || last.occurredAt < since) {
          await this.advance(profileId, session.id, { observedSeq: lastSeq, capturedSeq: lastSeq, reviewedSeq: lastSeq });
          continue;
        }
        if (idleMs > 0 && this.service.now() - last.occurredAt < idleMs) continue;
        written += (await this.capture(profileId, session.id, { reason, idleMs, signal })).written;
      } catch (error) {
        if (signal?.aborted) throw error;
        this.service.logger?.warn?.(`memory: session excerpt skipped: ${diagnosticCode(error)}`);
      }
    }
    return { written };
  }

  async sweep({ reason = "idle", idleMs = IDLE_MS, signal } = {}) {
    for (const profile of this.service.profiles()) {
      if (!this.service.opened || signal?.aborted) return;
      if (profile.enabled === false || this.service.blockedProfiles.has(profile.id)) continue;
      try { await this.captureProfile(profile.id, { reason, idleMs, signal }); }
      catch (error) { if (signal?.aborted) return; this.service.logger?.warn?.(`memory: session excerpt sweep skipped: ${diagnosticCode(error)}`); }
    }
  }

  // The user opened a new conversation: the Agent's other conversations end.
  onSessionCreated(profileId, sessionId) {
    if (!this.service.opened) return Promise.resolve({ written: 0 });
    return this.captureProfile(profileId, { reason: "new-session", idleMs: 0, exceptSessionId: sessionId })
      .catch(error => { this.service.logger?.warn?.(`memory: session excerpt skipped: ${diagnosticCode(error)}`); return { written: 0 }; });
  }
}

module.exports = { SessionCapture, SESSION_CAPTURE_IDLE_MS: IDLE_MS, SESSION_CAPTURE_MAX_MESSAGES: MAX_MESSAGES,
  SESSION_CAPTURE_BACKFILL_MS: BACKFILL_MS };
