"use strict";

const path = require("node:path");
const { core } = require("./host.cjs");
const { sha256 } = require("./migration.cjs");
const { isBorrowedMemoryDerived, extractBorrowedMemoryRefs, refsFromEvents } = require("./borrowed-memory-provenance.cjs");
const { recallDiagnostics, diagnosticCode } = require("./active-memory-diagnostics.cjs");
const { evidenceCurrent } = require("./active-memory-evidence.cjs");
const { isUiActionSubmission } = require("../ui-input-provenance");

const RECEIPTS = "recall-signal-receipts";
const DAY_MS = 24 * 60 * 60 * 1000;
// A user turn older than the window never counts. Receipts outlive it, so a
// replay inside the window always finds its earlier receipt.
const ACCEPT_WINDOW_MS = 7 * DAY_MS, RECEIPT_TTL_MS = 14 * DAY_MS, MAX_RECEIPTS = 20_000;
const MAX_STAGED_PER_RUN = 200;
// Mirrors the upstream short-term path rules (daily notes and the session
// corpus); other files never become promotion candidates.
const SHORT_TERM_PATH = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/u;
const SESSION_CORPUS = /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/u;
const DREAMING = /(?:^|\/)memory\/dreaming\//u;
const isShortTerm = relative => typeof relative === "string" && !DREAMING.test(relative)
  && (SHORT_TERM_PATH.test(relative) || SESSION_CORPUS.test(relative));
const resultKey = result => `${result.path}\0${result.startLine}\0${result.endLine}\0${sha256(result.snippet || "")}`;
// Entry markers are Shoggoth storage syntax, not memory. Upstream promotion
// re-reads the cited lines and matches them against the recorded snippet, so
// a marker-free snippet lands on the fact lines alone and joins the daily
// ingestion signal for the same claim.
const ENTRY_MARKER = /<!--\s*\/?shoggoth-memory-entry\b[^>]*-->/gu;
const cleanSnippet = snippet => String(snippet || "").replace(ENTRY_MARKER, " ").replace(/\s+/gu, " ").trim().replace(/^(?:[-*+]\s+)+/u, "");
const normalizeHistory = text => String(text || "").replace(/\s+/gu, " ").trim();
const EXTERNAL_CHAT = /^shoggoth:chat-send:(?:federation-(?:send|message)|group-(?:turn|task))-/u;

// Own recall signals for Dreaming promotion. A search only stages the own
// results it actually delivered, with their original relevance. The turn
// commits them after it completes without any borrowed dependency, keyed by
// the user's own question. Staging is in memory, so a crash can only lose
// that turn's signals; atomic receipts prevent counting a user event twice.
class RecallSignals {
  constructor(service) { this.service = service; this.pending = new Map(); }
  key(profileId, runId) { return `${profileId}\0${runId}`; }

  stage(input, results) {
    const run = input?.run;
    if (!run?.id || run.source !== "chat" || run.profileId !== input.profileId || EXTERNAL_CHAT.test(run.idempotencyKey || "")) return;
    const own = results.filter(result => result && result.borrowed !== true && result.source === "memory" && isShortTerm(result.path));
    if (!own.length) return;
    const key = this.key(input.profileId, run.id);
    // The search's own authorization scope; the commit rechecks every result
    // under it, exactly as the search admitted them.
    const entry = this.pending.get(key) || { profileId: input.profileId, results: new Map(),
      scope: { profileId: input.profileId, workspace: input.workspace, maxSensitivity: input.maxSensitivity, sessionId: input.sessionId, run } };
    for (const result of own) {
      const id = resultKey(result), previous = entry.results.get(id);
      if (!previous && entry.results.size >= MAX_STAGED_PER_RUN) continue;
      if (!previous || result.score > previous.score) entry.results.set(id, result);
    }
    this.pending.set(key, entry);
  }

  historyEvent(input, host, sessionId, eventId) {
    const session = host.sessions.current(input.profileId, sessionId);
    if (session.workspace !== input.workspace) return null;
    const raw = this.service.transcriptStore.getEvent(input.profileId, sessionId, eventId);
    if (!raw || raw.runId === input.run.id || isBorrowedMemoryDerived(raw) || isUiActionSubmission(raw)) return null;
    const page = this.service.conversationRecall.scanEligibleSession({ profileId: input.profileId,
      sessionId, afterSeq: raw.seq - 1, limit: 1, completedOnly: true });
    const event = page.events.find(row => row.eventId === eventId && row.seq === raw.seq);
    if (event) this.service.conversationRecall.assertCandidateSourceCurrent(input.profileId, event);
    return event || null;
  }

  // Join only to an existing canonical candidate. Internal corpus files stay
  // outside the search index and are never returned to a model by this join.
  historyCandidates(input, rows) {
    if (!input.run?.id || input.run.source !== "chat" || EXTERNAL_CHAT.test(input.run.idempotencyKey || "") || !rows.length) return [];
    const host = this.service.host(input.profileId), cfg = this.service.config(input.profileId);
    const { timezone } = core.resolveMemoryDreamingConfig({ cfg, pluginConfig: core.resolveMemoryDreamingPluginConfig(cfg) });
    const statePrefix = core.memoryCoreWorkspaceStateKey(host.workspaceDir);
    const query = host.database.db.prepare(`SELECT key,value FROM memory_state
      WHERE namespace=? AND key>=? AND key<? AND value IS NOT NULL
      AND json_extract(value,'$.value.path')=? LIMIT 10000`);
    const files = new Map();
    return rows.slice(0, MAX_STAGED_PER_RUN).flatMap(row => {
      try {
        if (row.borrowed || row.hidden || !row.eventId || !row.sessionId || !Number.isFinite(row.score)) return [];
        const event = this.historyEvent(input, host, row.sessionId, row.eventId);
        if (!event) return [];
        const relative = `memory/.dreams/session-corpus/${core.formatMemoryDreamingDay(event.occurredAt, timezone)}.txt`;
        if (!files.has(relative)) {
          const filesOwner = host.getAgentWorkspaceAccess(host.workspaceDir).memoryFiles;
          const lines = filesOwner.read(path.join(host.workspaceDir, relative)).toString("utf8").split("\n");
          const candidates = query.all(core.SHORT_TERM_RECALL_NAMESPACE, `${statePrefix}:`, `${statePrefix};`, relative)
            .map(item => ({ ...JSON.parse(item.value).value, stateKey: item.key }));
          files.set(relative, { lines, candidates });
        }
        const { lines, candidates } = files.get(relative);
        const body = normalizeHistory(event.text), delivered = normalizeHistory(row.snippet);
        const kind = event.kind === "user" ? "User" : "Assistant";
        const citation = `[${input.profileId}/sessions/${input.profileId}/${event.sessionId}#L${event.seq}] `;
        const legacy = `[${input.profileId}/sessions/${event.sessionId}#L${event.seq}] `;
        return candidates.flatMap(candidate => {
          const line = lines[candidate.startLine - 1], prefix = [citation, legacy].find(value => line?.startsWith(value));
          const excerpt = candidate.snippet?.replace(/^(?:User|Assistant):\s+/u, "").replace(/…$/u, "").trimEnd();
          if (candidate.promotedAt || candidate.startLine !== candidate.endLine || !prefix || !excerpt
            || !line.startsWith(`${prefix}${kind}: `) || !body.startsWith(excerpt) || !delivered.includes(excerpt)
            || !candidate.snippet.startsWith(`${kind}: `) || !candidate.snippet.startsWith(line.slice(prefix.length).replace(/…$/u, ""))) return [];
          return [{ path: relative, source: "memory", startLine: candidate.startLine, endLine: candidate.endLine,
            score: Math.max(0, Math.min(1, row.score)), snippet: candidate.snippet, provenance: candidate.provenance,
            sessionOrigin: { agentId: input.profileId, sessionId: event.sessionId },
            history: { eventId: event.eventId, sessionId: event.sessionId, seq: event.seq,
              hash: event.contentHash, sourceHash: sha256(line), excerpt, stateKey: candidate.stateKey } }];
        });
      } catch { return []; } // Optional signals must not interrupt chat or disclose inaccessible sources.
    });
  }

  currentResult(host, scope, result) {
    if (!result.history) return host.searchIndex.isCurrent(result)
      && (!result.recallEvidence || evidenceCurrent(host.searchIndex, result.recallEvidence));
    try {
      const { eventId, sessionId, seq, hash, sourceHash, stateKey } = result.history;
      const event = this.historyEvent(scope, host, sessionId, eventId);
      const row = host.database.db.prepare("SELECT value FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL")
        .get(core.SHORT_TERM_RECALL_NAMESPACE, stateKey);
      const candidate = row && JSON.parse(row.value).value;
      return event?.seq === seq && event.contentHash === hash && this.service.sourceSessionsVisible(
        scope.profileId, `${result.path}#L${result.startLine}-L${result.endLine}`, scope.workspace)
        && candidate?.path === result.path && candidate.startLine === result.startLine
        && candidate.endLine === result.endLine && candidate.snippet === result.snippet && !candidate.promotedAt
        && sha256(host.getAgentWorkspaceAccess(host.workspaceDir).memoryFiles
          .read(path.join(host.workspaceDir, result.path)).toString("utf8").split("\n")[result.startLine - 1]) === sourceHash;
    } catch { return false; }
  }

  discardProfile(profileId) {
    for (const [key, entry] of this.pending) if (entry.profileId === profileId) this.pending.delete(key);
  }

  // Called once per terminal turn, before the borrowing broker forgets the run.
  // A turn that staged signals but counted none leaves the reason, never text.
  async commit(run, status) {
    const key = this.key(run?.profileId, run?.id), entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry) return { committed: 0, reason: "none" };
    let outcome;
    try { outcome = await this.commitEntry(run, status, entry); }
    catch (error) { this.diagnose(entry, run, { outcome: "error", code: diagnosticCode(error) }); throw error; }
    if (!outcome.committed) this.diagnose(entry, run, { outcome: "discarded", code: outcome.reason.toUpperCase().replaceAll("-", "_") });
    return outcome;
  }

  diagnose(entry, run, record) {
    try { recallDiagnostics({ host: this.service.host(entry.profileId), runId: run.id, now: () => this.service.now() })({ stage: "recall-signal", ...record }); }
    catch { /* best effort, e.g. a stopped Profile */ }
  }

  async commitEntry(run, status, entry) {
    if (status !== "completed") return { committed: 0, reason: "not-completed" };
    const service = this.service, profileId = entry.profileId;
    if (service.sharing?.borrowedRefsForRun(run.id).length) return { committed: 0, reason: "borrowed" };
    const question = this.question(profileId, run);
    if (!question) return { committed: 0, reason: "no-user-question" };
    const host = service.host(profileId), now = host.database.now();
    if (!(question.occurredAt > now - ACCEPT_WINDOW_MS)) return { committed: 0, reason: "outside-window" };
    return service.searchScope.run(entry.scope, async () => {
      const isCurrent = result => this.currentResult(host, entry.scope, result);
      const current = host.run(() => [...entry.results.values()].filter(isCurrent));
      if (!current.length) return { committed: 0, reason: "no-current-result" };
      const receipts = host.database.openKeyedStore({ namespace: RECEIPTS, maxEntries: MAX_RECEIPTS,
        defaultTtlMs: RECEIPT_TTL_MS, overflowPolicy: "reject-new" });
      const admitted = [];
      for (const result of current) {
        const receipt = sha256(`${question.userEventId}\0${resultKey(result)}`);
        // Claimed before counting and never released: a later failure can
        // only undercount. A full store refuses new claims instead of
        // evicting ones a replay could still need.
        try { if (await receipts.registerIfAbsent(receipt, { at: now })) admitted.push(result); } catch { break; }
      }
      if (admitted.length) await host.searchIndex.recordRecallSignals({ questionKey: question.key,
        results: admitted, isCurrent, normalizeSnippet: cleanSnippet, nowMs: now });
      return { committed: admitted.length, reason: admitted.length ? "committed" : "already-counted" };
    });
  }

  // The user's own words for this turn, never a model query. Turns without a
  // real user event (cron, heartbeat, group) and any session that carries a
  // borrowed dependency never count.
  question(profileId, run) {
    const service = this.service, session = service.chatSessionStore.getSession(run.sourceId);
    if (!session || session.profileId !== profileId) return null;
    const events = service.transcriptStore.listEvents(profileId, session.id);
    if (refsFromEvents(events).length) return null;
    const user = events.findLast(event => event.kind === "user" && event.runId === run.id && !event.contextExcluded);
    const text = user?.content?.text;
    if (!user || typeof text !== "string" || !text.trim() || isBorrowedMemoryDerived(user) || extractBorrowedMemoryRefs(user.content).length) return null;
    const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
    return { userEventId: user.id, occurredAt: user.occurredAt, key: `user-question:${sha256(normalized).slice(0, 32)}` };
  }
}

module.exports = { RecallSignals, isShortTerm, RECALL_SIGNAL_RECEIPTS_NAMESPACE: RECEIPTS };
