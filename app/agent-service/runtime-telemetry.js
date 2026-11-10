"use strict";
const crypto = require("node:crypto"), path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists } = require("./security");
const EVENTS = new Set(["runtime.admission.admitted", "runtime.admission.queued", "runtime.startup.waiting", "runtime.startup.started",
  "runtime.context.usage_updated", "runtime.compaction.requested", "runtime.compaction.completed", "runtime.binding.changed",
  "session.runtime.switched", "runtime.preflight.failed", "runtime.stage", "runtime.switch.first_turn", "runtime.handle.violation",
  "runtime.capability.difference"]);
class RuntimeTelemetry {
  constructor({ now = Date.now, sink = () => {} } = {}) { this.now = now; this.sink = sink; this.events = []; this.counters = {}; this.cryptoWaitMs = 0; this.pendingSwitches = new Set(); this.stageSamples = new Map(); }
  record(name, input = {}) {
    if (!EVENTS.has(name)) return;
    const event = { name, at: this.now() };
    for (const key of ["runId", "operationId", "sessionKey", "bindingId"]) if (typeof input[key] === "string") event[key + "Hash"] = crypto.createHash("sha256").update(input[key]).digest("hex");
    if (name === "session.runtime.switched" && event.sessionKeyHash) {
      this.pendingSwitches.add(event.sessionKeyHash);
      while (this.pendingSwitches.size > 4096) this.pendingSwitches.delete(this.pendingSwitches.values().next().value);
    }
    for (const key of ["source", "reason", "quality", "stage", "outcome"]) if (typeof input[key] === "string" && /^[a-zA-Z0-9_.-]{1,80}$/u.test(input[key])) event[key] = input[key];
    if (typeof input.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(input.code)) event.code = input.code;
    if (Number.isSafeInteger(input.count) && input.count >= 0 && input.count <= 1_000_000_000) event.count = input.count;
    if (Number.isSafeInteger(input.durationMs) && input.durationMs >= 0) event.durationMs = input.durationMs;
    for (const key of ["startedAt", "finishedAt", "attempt"]) if (Number.isSafeInteger(input[key]) && input[key] >= 0) event[key] = input[key];
    if (["created", "reused", "unknown"].includes(input.hostState)) event.hostState = input.hostState;
    this.counters[name] = Math.min(Number.MAX_SAFE_INTEGER, (this.counters[name] || 0) + 1);
    if (name === "runtime.switch.first_turn") {
      const metric = input.outcome === "error" ? "switchFirstTurnFailed" : input.outcome === "success" ? "switchFirstTurnSucceeded" : "switchFirstTurnUnknown";
      this.counters[metric] = (this.counters[metric] || 0) + 1;
    }
    if (name === "runtime.stage" && event.stage) {
      if (!this.stageSamples.has(event.stage) && this.stageSamples.size < 128) this.stageSamples.set(event.stage, { count: 0, success: 0, error: 0, unknown: 0 });
      const sample = this.stageSamples.get(event.stage);
      if (sample) { sample.count = Math.min(Number.MAX_SAFE_INTEGER, sample.count + 1);
        const outcome = ["success", "error"].includes(event.outcome) ? event.outcome : "unknown";
        sample[outcome] = Math.min(Number.MAX_SAFE_INTEGER, sample[outcome] + 1); }
    }
    if (/crypto|encrypt/u.test(event.stage || "")) this.cryptoWaitMs = Math.min(Number.MAX_SAFE_INTEGER, this.cryptoWaitMs + (event.durationMs || 0));
    this.events.push(event); if (this.events.length > 512) this.events.shift();
    try { Promise.resolve(this.sink(structuredClone(event))).catch(() => {}); } catch {}
  }
  recordSwitchFirstTurn({ sessionKey, runId, outcome }) {
    const key = crypto.createHash("sha256").update(sessionKey).digest("hex");
    if (!this.pendingSwitches.delete(key)) return;
    this.record("runtime.switch.first_turn", { runId, outcome });
  }
  snapshot() { const failed = this.counters.switchFirstTurnFailed || 0, succeeded = this.counters.switchFirstTurnSucceeded || 0;
    return structuredClone({ version: 1, scope: "service-process", counters: this.counters, cryptoWaitMs: this.cryptoWaitMs,
      switchFirstTurnFailureRate: failed + succeeded ? failed / (failed + succeeded) : null,
      switchFirstTurnSamples: { known: failed + succeeded, unknown: this.counters.switchFirstTurnUnknown || 0, succeeded, failed },
      stageSamples: Object.fromEntries(this.stageSamples),
      events: this.events.slice(-64), retainedEvents: this.events.length }); }
}
// Durable queue arrival times are scheduling metadata, not execution authority.
// Invalid cache entries are discarded; the encrypted command remains authority.
class RuntimeQueueClock extends Map {
  constructor({ paths, now = Date.now }) { super(); this.paths = paths; this.now = now; this.loaded = false;
    this.file = path.join(paths.cacheDir, "runtime-queue-clock-v1.json"); }
  load() { if (this.loaded) return; this.loaded = true;
    try {
      if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain" || !lstatIfExists(this.file)) return;
      const data = JSON.parse(readPrivateFile(this.file, { maxBytes: 8 * 1024 * 1024 }));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 65536) return;
      for (const [id, at] of data.entries) if (typeof id === "string" && id.length <= 512 && Number.isSafeInteger(at) && at >= 0 && at <= this.now()) super.set(id, at);
    } catch { super.clear(); }
  }
  save() { try { atomicWritePrivateFile(this.file, JSON.stringify({ version: 1, entries: [...this] }) + "\n", { trustedRoot: this.paths.trustedRoot }); } catch {} }
  get(key) { this.load(); return super.get(key); } has(key) { this.load(); return super.has(key); }
  set(key, value) { this.load(); if (super.has(key)) return this;
    super.set(key, value); while (this.size > 65536) super.delete(this.keys().next().value); this.save(); return this; }
  delete(key) { this.load(); const changed = super.delete(key); if (changed) this.save(); return changed; }
}
function observeCryptoBroker(broker, telemetry) {
  const methods = new Map();
  return new Proxy(broker, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (!methods.has(key)) methods.set(key, ["encrypt", "decrypt", "loadOrCreateForService", "readForHelper"].includes(key)
      ? async (...args) => {
        const started = performance.now(); let outcome = "success";
        try { return await value.apply(target, args); } catch (error) { outcome = "error"; throw error; }
        finally { telemetry.record("runtime.stage", { stage: `crypto_${key}`, outcome,
          durationMs: Math.max(0, Math.round(performance.now() - started)) }); }
      } : value.bind(target));
    return methods.get(key);
  } });
}
module.exports = { RuntimeTelemetry, RuntimeQueueClock, observeCryptoBroker, EVENTS };
