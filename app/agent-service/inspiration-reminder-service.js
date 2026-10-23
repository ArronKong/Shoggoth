"use strict";

const { DAY_MS, digest, at, boundedCandidates } = require("./proactive-service-protocol");
const BUCKETS = Object.freeze({ seed: "saved", attention: "active", sprouted: "result" });
const UNKNOWN_ERRORS = /(?:UNKNOWN|NEEDS_VERIFICATION|RECOVERY_UNAVAILABLE|ACCEPTANCE_UNCERTAIN)/u;

function inspirationReminderCandidate(idea, config, now) {
  if (!idea || idea.archivedAt !== null || idea.deletedAt != null) return { candidate: null, unknown: null };
  const execution = idea.latestExecution;
  const status = execution?.status ?? idea.status;
  let group, reason, enteredAt, request = null;
  if (status === "saved" || status === "skipped") {
    group = "seed"; reason = "seed_review"; enteredAt = idea.createdAt;
    if (now < enteredAt + config.review.seedAgeDays * DAY_MS) return { candidate: null, unknown: null };
  } else if (status === "completed") {
    group = "sprouted"; reason = "sprouted_review";
    if (!at(execution?.finishedAt)) return { candidate: null, unknown: { ideaId: idea.id, reason: "stage_time_unknown" } };
    enteredAt = Math.max(execution.finishedAt, idea.restoredAt ?? 0);
    if (now < enteredAt + config.review.sproutedAgeDays * DAY_MS) return { candidate: null, unknown: null };
  } else if (["waiting_input", "waiting_approval"].includes(status)) {
    const attention = execution?.attention;
    if (attention?.active !== true || !attention.request || attention.request.runId !== execution.runId
      || (attention.request.expiresAt !== null && attention.request.expiresAt <= now)) return { candidate: null, unknown: null };
    group = "attention"; request = attention.request;
    reason = request.kind === "user_input" ? "waiting_input" : "waiting_approval";
    enteredAt = attention.occurredAt;
  } else if (["failed", "interrupted"].includes(status) && !UNKNOWN_ERRORS.test(execution?.errorCode || "")) {
    group = "attention"; reason = "execution_failed"; enteredAt = execution?.finishedAt;
    if (!at(enteredAt)) return { candidate: null, unknown: { ideaId: idea.id, reason: "failure_time_unknown" } };
  } else if (status === "unknown" || UNKNOWN_ERRORS.test(execution?.errorCode || "")) {
    return { candidate: null, unknown: { ideaId: idea.id, reason: "execution_needs_verification" } };
  } else return { candidate: null, unknown: null };
  if (!config.review.groups.includes(group)) return { candidate: null, unknown: null };
  if (!at(enteredAt) || enteredAt > now) return { candidate: null, unknown: { ideaId: idea.id, reason: "stage_time_unknown" } };
  const ageDays = Math.floor((now - enteredAt) / DAY_MS);
  const candidate = { id: idea.id, ideaId: idea.id, group, reason, enteredAt, ageDays,
    title: (idea.title || idea.body?.trim().split("\n")[0] || idea.attachments?.[0]?.name || "").slice(0, 120).toWellFormed(),
    excerpt: [...(idea.body || "")].slice(0, 240).join(""), favorite: idea.favorite,
    runId: execution?.runId ?? null, backendId: execution?.backendId ?? null, agentId: execution?.agentId ?? null,
    requestId: request?.requestId ?? null, requestExpiresAt: request?.expiresAt ?? null,
    requestTitle: request ? request.title.slice(0, 160).toWellFormed() : null,
    href: `/inspirations?id=${encodeURIComponent(idea.id)}&filter=${BUCKETS[group]}`,
    eventKey: `idea:${idea.id}:${execution?.runId ?? "saved"}:${request?.requestId ?? reason}`,
    evidenceVersion: digest([idea.id, idea.revision, idea.archivedAt, idea.restoredAt ?? null,
      execution?.id ?? null, status, execution?.finishedAt ?? null, request?.requestId ?? null,
      request?.expiresAt ?? null, execution?.attention?.active ?? false]) };
  return { candidate, unknown: null };
}

class InspirationReminderService {
  constructor({ inspirationStore, inspirationService, proactiveStore, now = Date.now }) {
    this.ideas = inspirationStore; this.inspiration = inspirationService; this.store = proactiveStore; this.now = now;
  }
  scopedRunCandidate(run, config) {
    // Explicitly selecting an Inspiration Run must still use the note's global
    // cooldown and latest execution, including when the broad note scope is off.
    if (run.source !== "inspiration" || !this.store.ideaEligible(run.sourceId, this.now())) return null;
    try {
      const idea = this.inspiration.reminderView(run.sourceId);
      if (idea.latestExecution?.runId !== run.id) return null;
      return inspirationReminderCandidate(idea, config, this.now()).candidate;
    } catch { return null; }
  }
  collect(config, { preview = false } = {}) {
    this.inspiration.refreshReminderProjection();
    const now = this.now(), candidates = [], unknown = [], seen = new Set();
    let examined = 0, bounded = false;
    for (const group of config.review.groups) {
      let cursor = null;
      // A bounded indexed scan never reads execution transcripts. Persist a
      // rotating continuation so a large quiet/disabled prefix cannot starve
      // later notes forever. Always include the first page for fresh attention.
      const continuation = preview ? null : this.store.getCursor(`inspiration:${group}`);
      for (let page = 0; page < 5; page++) {
        if (page === 1 && continuation !== null) cursor = continuation;
        const result = this.ideas.reminderPage(BUCKETS[group], cursor, 50);
        for (const saved of result.ideas) {
          if (seen.has(saved.id)) continue;
          seen.add(saved.id); examined++;
          if (!this.store.ideaEligible(saved.id, now)) continue;
          try {
            const value = inspirationReminderCandidate(this.inspiration.reminderView(saved.id), config, now);
            if (value.candidate) candidates.push(value.candidate);
            if (value.unknown) unknown.push(value.unknown);
          } catch { unknown.push({ ideaId: saved.id, reason: "source_unreadable" }); }
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 4) bounded = true;
      }
      if (!preview) this.store.setCursor(`inspiration:${group}`, cursor);
    }
    // Age has no ceiling. Long-waiting seeds can eventually outrank a steady
    // stream of newer failures, while approvals start with the highest score.
    const score = candidate => ({ waiting_approval: 21, waiting_input: 21, execution_failed: 14,
      sprouted_review: 7, seed_review: 0 }[candidate.reason] ?? 0) + candidate.ageDays + Number(candidate.favorite) * 2;
    candidates.sort((a, b) => score(b) - score(a) || a.enteredAt - b.enteredAt || a.id.localeCompare(b.id));
    const result = boundedCandidates(candidates);
    return { candidates: result.candidates, unknown: unknown.slice(0, 20), examined, bounded: bounded || result.bounded };
  }
  revalidate(candidate, config, now = this.now(), { reservedNoticeId = null } = {}) {
    const note = this.store.getNote(candidate.ideaId);
    if (note.disabled || note.handled || (note.snoozedUntil !== null && note.snoozedUntil > now)
      || (!reservedNoticeId && !this.store.ideaEligible(candidate.ideaId, now))
      || (reservedNoticeId && note.noticeId !== reservedNoticeId)) return null;
    try {
      const value = inspirationReminderCandidate(this.inspiration.reminderView(candidate.ideaId), config, now).candidate;
      return value?.evidenceVersion === candidate.evidenceVersion ? value : null;
    } catch { return null; }
  }
}
module.exports = { InspirationReminderService, inspirationReminderCandidate };
