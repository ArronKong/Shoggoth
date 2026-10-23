"use strict";

const { GroupActivityProjection, safeValue } = require("./group-activity");
const MAX_DRAFT_CHARS = 4000;
function tail(text) {
  const chars = [...text];
  return chars.length <= MAX_DRAFT_CHARS ? text : `…${chars.slice(-MAX_DRAFT_CHARS + 1).join("")}`;
}

// One rebuildable observer per group turn, not per member. Drafts and activity are
// private projections; public messages remain Store-owned. onActivity lets the driver
// see new movement (inactivity timeout) and tool starts (giving up the speaking slot).
class GroupDraftTracker {
  constructor({ store, nativeExecutor, externalExecutor = null, onChanged = () => {}, onActivity = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 800, onError = () => {}, now = Date.now }) {
    Object.assign(this, { store, nativeExecutor, externalExecutor, onChanged, onActivity, setTimer, clearTimer, pollMs, onError, now });
    this.states = new Map(); this.stopped = false;
  }
  start() { this.stopped = false; }
  watch(id) {
    if (this.stopped || this.states.has(id)) return;
    this.states.set(id, { id, text: null, projection: null, streamId: null, afterSeq: 0, timer: null, groupId: null });
    this.#schedule(id);
  }
  #currentState(id) {
    const state = this.states.get(id); if (!state?.projection) return null;
    try {
      const record = this.store.getOpportunity(id);
      return record && state.projection.matches(this.#binding(record)) ? state : null;
    } catch { return null; }
  }
  draftFor(id) { return this.#currentState(id)?.text ?? null; }
  activityFor(id) { return this.#currentState(id)?.projection?.snapshot() ?? null; }
  forget(id) {
    const state = this.states.get(id); if (!state) return;
    if (state.timer) this.clearTimer(state.timer);
    this.states.delete(id);
  }
  stop() { this.stopped = true; for (const id of [...this.states.keys()]) this.forget(id); }
  #schedule(id) {
    const state = this.states.get(id); if (!state || this.stopped) return;
    state.timer = this.setTimer(() => { state.timer = null; void this.#poll(id); }, this.pollMs);
    state.timer?.unref?.();
  }
  #binding(record) {
    return { groupId: record.groupId, discussionId: record.discussionId, memberId: record.memberId,
      opportunityId: record.id, taskId: null, attemptId: null, runId: record.runId,
      executionGeneration: [record.fence ?? "", record.sessionKey ?? "", record.runId ?? "", record.external?.executionId ?? ""].join(":") };
  }
  async #poll(id) {
    const state = this.states.get(id); if (!state || this.stopped) return;
    let record;
    try { record = this.store.getOpportunity(id); }
    catch (error) { this.onError(error); this.forget(id); return; }
    if (!record || !["running", "waiting"].includes(record.state)) { this.forget(id); return; }
    state.groupId = record.groupId;
    const binding = this.#binding(record);
    if (!state.projection?.matches(binding)) {
      state.projection = new GroupActivityProjection(binding, { now: this.now });
      state.text = null; state.streamId = null; state.afterSeq = 0;
    }
    const projection = state.projection;
    const prior = JSON.stringify({ ...projection.snapshot(), observedAt: null });
    let text = state.text;
    try {
      if (record.runKind === "external") {
        // Legacy hosts have no event facts. Their status remains usable; no tool
        // or reading phase is inferred from prose or polling frequency.
        const activity = await this.externalExecutor?.activity?.(record);
        if (this.states.get(id) !== state || state.projection !== projection) return;
        if (activity) projection.adopt(activity);
        const draft = await this.externalExecutor?.draft(record);
        if (typeof draft === "string") {
          text = safeValue(draft, 0, { bytes: 16 * 1024 });
          if (!activity) projection.observeDraft(text);
        }
      } else if (record.runId) {
        await this.#readNative(state, projection, record.runId);
        text = projection.draft() ?? text;
        const snapshot = this.nativeExecutor.getRun?.(record.runId);
        if (snapshot) projection.observeStatus(snapshot.status, { at: snapshot.finishedAt ?? this.now(),
          cancelRequested: Boolean(record.abortReason), recovery: Boolean(record.recovery) });
      }
    } catch (error) { this.onError(error); }
    // A forgotten/rebound execution cannot receive the late RPC's text/activity.
    if (this.states.get(id) !== state || state.projection !== projection) return;
    let current;
    try { current = this.store.getOpportunity(id); } catch { this.forget(id); return; }
    if (!current || !projection.matches(this.#binding(current))) { this.#schedule(id); return; }
    if (current.runKind === "external") projection.observeStatus(current.recovery ? "unknown" : current.interaction?.status === "pending"
      ? current.interaction.request?.kind === "runtime_approval" ? "waiting_approval" : "waiting_input"
        : current.observation?.status ?? "running", {
      recovery: Boolean(current.recovery), cancelRequested: Boolean(current.abortReason) });
    const nextText = typeof text === "string" ? tail(text) : state.text;
    if (nextText !== state.text || prior !== JSON.stringify({ ...projection.snapshot(), observedAt: null })) {
      state.text = nextText; this.onChanged(record.groupId);
      try { this.onActivity(id, projection.snapshot()); } catch (error) { this.onError(error); }
    }
    this.#schedule(id);
  }
  async #readNative(state, projection, runId) {
    for (let page = 0; page < 5; page++) {
      const cursor = { streamId: state.streamId, afterSeq: state.afterSeq };
      const result = await this.nativeExecutor.readEvents({ runId, ...cursor });
      if (state.projection !== projection || this.stopped || result.runId !== undefined && result.runId !== runId) return;
      if (!projection.setStream(result.streamId)) return;
      if (state.streamId !== result.streamId) { state.streamId = result.streamId; state.afterSeq = 0; }
      projection.observeEvents(result.events ?? [], result.streamId);
      // Gaps only recover facts from a bound snapshot, never fabricate missing
      // text/tool events or count a snapshot read as business progress.
      const snapshot = result.snapshot?.run ?? result.snapshot?.data?.run;
      if (snapshot?.id === runId) projection.observeStatus(snapshot.status, { at: snapshot.finishedAt ?? this.now() });
      state.afterSeq = result.gap ? result.latestSeq : result.nextCursor;
      if (!result.hasMore) break;
    }
  }
}
module.exports = { GroupDraftTracker };
