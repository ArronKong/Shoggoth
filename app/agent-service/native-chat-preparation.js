"use strict";

const { readRuntimeAuthenticationState } = require("./runtime-adapter");

// Speculative work owns no Run, account admission, workspace writer or native
// session. The ordinary dispatch path revalidates all of those authorities.
class NativeChatPreparation {
  constructor({ resolve, runtimeManager, warmMemory = () => {}, now = Date.now, telemetry = { record() {} } }) {
    this.resolve = resolve; this.runtimeManager = runtimeManager; this.warmMemory = warmMemory;
    this.now = now; this.telemetry = telemetry; this.pending = new Map(); this.recent = new Map(); this.closed = false; this.generation = 0;
  }
  async prepare(input) {
    if (this.closed) return { supported: true, state: "unavailable" };
    let target;
    try { target = this.resolve(input); } catch { return { supported: true, state: "unavailable" }; }
    if (!target) return { supported: true, state: "unavailable" };
    try { this.warmMemory(target.profileId); } catch {}
    // Execution processes in the other pools are per Run. Keeping those alive
    // would retain unusable processes rather than accelerate the next turn.
    if (target.binding.runtime !== "codex") return { supported: true, state: "scheduled" };
    const generation = this.generation;
    const key = JSON.stringify([generation, target.binding, target.identity]);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 2) return { supported: true, state: "busy" };
    if (this.recent.get(key) > this.now() && this.runtimeManager.peek?.(target.binding, target.options)) {
      try { target.assertCurrent(); } catch { return { supported: true, state: "unavailable" }; }
      this.runtimeManager.keepWarm?.(target.binding);
      const at = this.now();
      this.telemetry.record("runtime.stage", { stage: "runtime_prewarm", source: target.binding.runtime,
        outcome: "success", startedAt: at, finishedAt: at, durationMs: 0, hostState: "reused",
        sessionKey: input.sessionKey, bindingId: target.binding.runtimeProfileId });
      return { supported: true, state: "ready" };
    }
    const startedAt = this.now();
    const work = (async () => {
      let outcome = "error", code, hostState = "unknown";
      try {
        const action = async () => {
          target.assertCurrent();
          const observed = this.runtimeManager.acquireObserved
            ? await this.runtimeManager.acquireObserved(target.binding, target.options)
            : { handle: await this.runtimeManager.acquire(target.binding, target.options), hostState: "unknown" };
          const host = observed.handle;
          hostState = observed.hostState;
          target.assertCurrent();
          if (this.closed || generation !== this.generation) return { supported: true, state: "unavailable" };
          await readRuntimeAuthenticationState(host, { allowDeferred: true });
          target.assertCurrent();
          if (this.closed || generation !== this.generation) return { supported: true, state: "unavailable" };
          // Model discovery is already cached/coalesced by the Runtime. Keep
          // its failure isolated and let real admission surface precise errors.
          if (typeof host.modelsList === "function") await host.modelsList({ cursor: null, limit: 64 });
          target.assertCurrent();
          if (this.closed || generation !== this.generation) return { supported: true, state: "unavailable" };
          this.runtimeManager.keepWarm?.(target.binding);
          this.recent.set(key, this.now() + 10_000);
          while (this.recent.size > 16) this.recent.delete(this.recent.keys().next().value);
          outcome = "success";
          return { supported: true, state: "ready" };
        };
        return await (this.runtimeManager.withActivity ? this.runtimeManager.withActivity(action) : action());
      } catch (error) { code = error?.code; return { supported: true, state: "unavailable" }; }
      finally { this.telemetry.record("runtime.stage", { stage: "runtime_prewarm", source: target.binding.runtime,
        outcome, code, hostState, startedAt, finishedAt: this.now(), durationMs: Math.max(0, this.now() - startedAt),
        sessionKey: input.sessionKey, bindingId: target.binding.runtimeProfileId }); }
    })();
    this.pending.set(key, work);
    try { return await work; } finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
  open() { this.closed = false; }
  close() { this.closed = true; this.generation++; this.recent.clear(); }
  async drain() { await Promise.allSettled([...this.pending.values()]); }
}

module.exports = { NativeChatPreparation };
