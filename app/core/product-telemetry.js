"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { LIMITS, getUtcDay, isEligibleBuild, createActivityEvent, validateTelemetryEvent } = require("./product-telemetry-schema");
const { STATE_VERSION, PAUSE_REASONS, createProductTelemetryStore } = require("./product-telemetry-store");
const { createPostHogTransport } = require("./product-telemetry-posthog");

const SYSTEM_CLOCK = { now: Date.now, setTimeout, clearTimeout };

// Low-priority UI-only auxiliary state. It never reads a business store, accepts
// arbitrary event properties, logs payloads, waits for a model, or owns a service.
function createProductTelemetry({ statePath, readConfigStatus, clock = SYSTEM_CLOCK, transport, buildConfig } = {}) {
  const build = Object.freeze({ ...buildConfig });
  const eligible = isEligibleBuild(build);
  let fault = eligible ? null : "build_disabled";
  let state = null;
  let store = null;
  let sender = null;
  let closed = false;
  let timer = null;
  let timerAt = Infinity;
  let flight = null;
  const fingerprint = eligible
    ? createHash("sha256").update(JSON.stringify([build.region, build.projectToken, build.revision])).digest("hex")
    : null;

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
  }

  function pause(code) {
    fault = code;
    clearTimer();
    flight?.controller.abort();
    return false;
  }

  function healthy() {
    if (!eligible || closed || fault) return false;
    try {
      const status = readConfigStatus();
      if (status !== "ok" && !(status === "missing" && state === null)) return pause("config_error");
    } catch { return pause("config_error"); }
    try { store.assertCurrent(); }
    catch { return pause("state_error"); }
    return true;
  }

  function commit(next) {
    try {
      store.write(next);
      state = next;
      return true;
    } catch { return pause("state_error"); }
  }

  function prune(now) {
    if (!state) return true;
    const outbox = state.outbox.filter((row) => now - Date.parse(row.event.timestamp) < LIMITS.ttlMs
      && row.attemptsTotal < LIMITS.attemptsTotal);
    return outbox.length === state.outbox.length || commit({ ...state, outbox });
  }

  function schedule(delay = LIMITS.flushMs) {
    if (closed || fault || !eligible) return;
    const at = clock.now() + delay;
    if (timer !== null && timerAt <= at) return;
    clearTimer();
    timerAt = at;
    timer = clock.setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      return flush();
    }, delay);
    timer?.unref?.();
  }

  function scheduleNext() {
    let delay = LIMITS.flushMs;
    if (state && !state.pausedReason) {
      const now = clock.now();
      const day = getUtcDay(now);
      for (const row of state.outbox) {
        if (row.attemptDay && (row.attemptDay > day
          || (row.attemptDay === day && row.attemptsToday >= LIMITS.attemptsPerDay))) continue;
        if (row.nextAttemptAt > now) delay = Math.min(delay, row.nextAttemptAt - now);
      }
    }
    schedule(Math.max(1, delay));
  }

  function recordActivity(...args) {
    if (args.length !== 0 || !healthy()) return false;
    const now = clock.now();
    const day = getUtcDay(now);
    if (!day || !prune(now)) return false;
    // Monotonic day watermark also prevents duplicates after the 35-day marker
    // window or a large clock rollback. An incorrect future clock may undercount.
    if (state && day <= state.lastActiveDay) return false;
    if (state && state.outbox.length >= LIMITS.events) return false;
    try {
      const distinctId = state?.distinctId || randomUUID();
      const event = createActivityEvent({ distinctId, uuid: randomUUID(), nowMs: now, build });
      const next = {
        version: STATE_VERSION, distinctId, lastActiveDay: day, transportFingerprint: fingerprint,
        pausedReason: state?.pausedReason || null,
        outbox: [...(state?.outbox || []), { event, attemptsTotal: 0, attemptDay: null, attemptsToday: 0, nextAttemptAt: 0 }],
      };
      // The identity, day receipt and outbox are committed together BEFORE any
      // dispatch. At one event/day, no per-interaction write/debounce is needed.
      if (!commit(next)) return false;
      schedule(LIMITS.firstFlushMs);
      return true;
    } catch { return pause("state_error"); }
  }

  async function dispatch(currentFlight) {
    if (!healthy()) return false;
    const now = clock.now();
    const day = getUtcDay(now);
    if (!day || !prune(now) || !state || state.pausedReason) return false;
    const rows = state.outbox.filter((row) => Date.parse(row.event.timestamp) <= now
      && row.nextAttemptAt <= now && (!row.attemptDay || row.attemptDay <= day)
      && (row.attemptDay !== day || row.attemptsToday < LIMITS.attemptsPerDay)).slice(0, LIMITS.batch);
    if (!rows.length) return false;
    if (!rows.every((row) => validateTelemetryEvent(row.event))) return pause("state_error");
    const ids = new Set(rows.map((row) => row.event.uuid));
    const outbox = state.outbox.map((row) => {
      if (!ids.has(row.event.uuid)) return row;
      const attemptsToday = row.attemptDay === day ? row.attemptsToday + 1 : 1;
      const base = Math.min(LIMITS.retryMaxMs, LIMITS.retryMinMs * 2 ** (attemptsToday - 1));
      const delay = Math.min(LIMITS.retryMaxMs, Math.ceil(base * (1 + Math.random())));
      return { ...row, attemptsTotal: row.attemptsTotal + 1, attemptDay: day, attemptsToday, nextAttemptAt: now + delay };
    });
    // Persist the consumed budget and next eligible time before sending, so a
    // crash or lost ACK cannot reset attempts or immediately hammer the receiver.
    if (!commit({ ...state, outbox }) || !healthy() || currentFlight.controller.signal.aborted) return false;
    const events = rows.map((row) => {
      const snapshot = JSON.parse(JSON.stringify(row.event));
      Object.freeze(snapshot.properties);
      return Object.freeze(snapshot);
    });
    let result;
    try { result = await sender.sendBatch(events, { signal: currentFlight.controller.signal }); }
    catch { result = { kind: "retry" }; }
    if (closed || currentFlight.controller.signal.aborted || !healthy()) return false;
    if (result?.kind === "canceled") return false;
    if (result?.kind === "ok") {
      // Merge against CURRENT state: a real interaction on a new day may have
      // arrived while the batch was in flight. Never overwrite that newer event.
      return commit({ ...state, outbox: state.outbox.filter((row) => !ids.has(row.event.uuid)) });
    }
    if (result?.kind === "retry") {
      const retryAfter = Number.isFinite(result.retryAfterMs)
        ? Math.min(LIMITS.retryMaxMs, Math.max(0, result.retryAfterMs)) : 0;
      if (retryAfter > 0) return commit({ ...state, outbox: state.outbox.map((row) => ids.has(row.event.uuid)
        ? { ...row, nextAttemptAt: Math.max(row.nextAttemptAt, clock.now() + retryAfter) } : row) });
      return false;
    }
    const code = result?.kind === "pause" && result.code !== null && PAUSE_REASONS.has(result.code)
      ? result.code : "protocol_error";
    return commit({ ...state, pausedReason: code });
  }

  function flush() {
    if (flight) return flight.promise;
    if (!eligible || closed || fault) return Promise.resolve(false);
    clearTimer();
    const current = { controller: new AbortController(), promise: null };
    flight = current;
    current.promise = Promise.resolve().then(() => dispatch(current)).catch(() => pause("state_error")).finally(() => {
      if (flight === current) flight = null;
      scheduleNext();
    });
    return current.promise;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimer();
    flight?.controller.abort();
    // Every accepted basic event is already durable. Do not create an exit event
    // or wait for network ACK; no extra before-quit/preventDefault dependency.
  }

  if (eligible) {
    try {
      store = createProductTelemetryStore(statePath);
      state = store.state;
      if (healthy()) {
        sender = transport || createPostHogTransport({ projectToken: build.projectToken, region: build.region });
        if (typeof sender.sendBatch !== "function") pause("transport_error");
        else if (!state || state.transportFingerprint === fingerprint
          || commit({ ...state, transportFingerprint: fingerprint, pausedReason: null })) schedule();
      }
    } catch { pause("state_error"); }
  }

  return {
    recordActivity, flush, close,
    // Main/internal tests only. The preload never exposes status or identity.
    getStatus: () => ({ collecting: eligible && !closed && !fault, closed,
      pausedReason: fault || state?.pausedReason || null, queuedEvents: state?.outbox.length || 0, inFlight: Boolean(flight) }),
  };
}

module.exports = { createProductTelemetry };
