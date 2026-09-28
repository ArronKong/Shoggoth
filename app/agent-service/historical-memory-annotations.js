"use strict";

const MAX_REFS = 8;
const SOURCE_NOTE = "Only the listed memory versions linked to this user event are outdated. Other statements in the event may still be current.";
const ECHO_NOTE = "This historical assistant output may echo the listed outdated memory versions from the same Run. It is not evidence of the user's current facts; other statements may still be current.";
const UNCERTAIN_SOURCE_NOTE = "The listed memory versions are outdated, but an older in-place edit makes their attribution to this user event uncertain. Do not infer the user said the edited content; other statements in the event may still be current.";
const UNCERTAIN_ECHO_NOTE = "This historical assistant output may echo outdated memory from the same Run. Older in-place edits make the original-event attribution uncertain; this output is not evidence of current user facts.";

function bounded(refs, note) {
  if (!refs?.length) return null;
  return { refs: refs.slice(0, MAX_REFS), total: refs.length,
    truncated: refs.length > MAX_REFS, note };
}

// MemoryStore is the only source of a version's status. Transcript and FTS rows
// merely locate old messages; a same-Run assistant message has no exact quote
// binding, so it receives a possible-echo notice instead of a factual label.
class HistoricalMemoryAnnotations {
  constructor({ memoryStore, recallPolicy, now = Date.now }) {
    if (!memoryStore?.getRevision || !memoryStore?.list
      || !recallPolicy?.getRevision || !recallPolicy?.getMemoryReason
      || typeof now !== "function") {
      throw new TypeError("HistoricalMemoryAnnotations dependencies 无效");
    }
    this.memories = memoryStore;
    this.policy = recallPolicy;
    this.now = now;
    this.cache = new Map();
  }

  forgetProfile(profileId) { this.cache.delete(profileId); }
  clear() { this.cache.clear(); }

  view(profileId) {
    const memoryRevision = this.memories.getRevision(profileId);
    const policyRevision = this.policy.getRevision(profileId);
    const now = this.now();
    const cached = this.cache.get(profileId);
    if (cached?.memoryRevision === memoryRevision && cached.policyRevision === policyRevision
      && now >= cached.builtAt && now < cached.nextExpiry) return cached;

    const bySource = new Map();
    const byRun = new Map();
    let nextExpiry = Infinity;
    for (const item of this.memories.listHistoricalSourceItems?.(profileId)
      ?? this.memories.list(profileId)) {
      let status = null;
      if (item.status === "superseded") status = "superseded";
      else if (item.status === "deleted"
        && this.policy.getMemoryReason(profileId, item) === "expired") status = "expired";
      else if (item.status === "active" && item.validUntil !== null) {
        if (item.validUntil <= now) status = "expired";
        else nextExpiry = Math.min(nextExpiry, item.validUntil);
      }
      // Only the first pair created by a product save or reviewed candidate is
      // an exact user-event/Run binding. UI/import markers elsewhere are not.
      if (!status || item.sourceRefs?.length < 2) continue;
      const [sourceEventId, runId] = item.sourceRefs;
      if (!bySource.has(`${sourceEventId}\0${runId}`)) bySource.set(`${sourceEventId}\0${runId}`, []);
      const ref = item.sourceBindingVerified === false
        ? { id: item.id, status, sourceBinding: "legacy_unverified" }
        : { id: item.id, status };
      bySource.get(`${sourceEventId}\0${runId}`).push(ref);
      if (!byRun.has(runId)) byRun.set(runId, []);
      byRun.get(runId).push({ ...ref, sourceEventId });
    }
    for (const refs of bySource.values()) refs.sort((a, b) => a.id.localeCompare(b.id));
    for (const refs of byRun.values()) refs.sort((a, b) => a.id.localeCompare(b.id));
    const view = { memoryRevision, policyRevision, builtAt: now, nextExpiry,
      hasHistorical: bySource.size > 0,
      forEvent(event) {
        if (event?.kind !== "user") return null;
        const refs = bySource.get(`${event.id}\0${event.runId}`);
        return bounded(refs, refs?.some((ref) => ref.sourceBinding === "legacy_unverified")
          ? UNCERTAIN_SOURCE_NOTE : SOURCE_NOTE);
      },
      forAssistant(event, sourceSeq = () => null) {
        if (event?.kind !== "assistant") return null;
        const refs = byRun.get(event.runId)?.filter((ref) => {
          const seq = sourceSeq(ref.sourceEventId, event.runId);
          // A later user message in a multi-event Run cannot have been echoed
          // by an earlier assistant message. An unavailable source is uncertain,
          // so retain the possible-echo warning rather than claim safety.
          return !Number.isSafeInteger(seq) || seq <= event.seq;
        });
        const notice = bounded(refs,
          refs?.some((ref) => ref.sourceBinding === "legacy_unverified")
            ? UNCERTAIN_ECHO_NOTE : ECHO_NOTE);
        return notice ? { kind: "possible_echo", ...notice } : null;
      },
    };
    this.cache.set(profileId, view);
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return view;
  }
}

module.exports = { HistoricalMemoryAnnotations };
