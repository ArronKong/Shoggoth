"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { LIMITS, catalog, DAILY_EVENT, STEP_EVENT, getUtcDay, isEligibleBuild, telemetryTier,
  createActivityEvent, createTelemetryEvent, validateTelemetryEvent, validateTelemetrySignal } = require("./product-telemetry-schema");
const { STATE_VERSION, PAUSE_REASONS, createProductTelemetryStore } = require("./product-telemetry-store");
const { createPostHogTransport } = require("./product-telemetry-posthog");

const SYSTEM_CLOCK = { now: Date.now, monotonic: () => performance.now(), setTimeout, clearTimeout };
const emptyDetail = () => ({ lastSealedDay: null, draft: null, steps: [] });
const queueRow = event => ({ event, attemptsTotal: 0, attemptDay: null, attemptsToday: 0, nextAttemptAt: 0 });
const tierOf = row => telemetryTier(row.event.event);
const isFresh = (event, now) => now - Date.parse(event.timestamp) < LIMITS.ttlMs;

// The UI Host owns preferences, a single private state file and one sender.
// Signals carry only bounded statistics and never own or await business work.
function createProductTelemetry({ statePath, configStore, clock = SYSTEM_CLOCK, transport, buildConfig } = {}) {
  const build = Object.freeze({ ...buildConfig });
  const eligible = isEligibleBuild(build);
  const monotonic = clock.monotonic || clock.now;
  const fingerprint = eligible
    ? createHash("sha256").update(JSON.stringify([build.region, build.projectToken, build.revision])).digest("hex")
    : null;
  let fault = null;
  let store = null;
  let state = null;
  let draft = null;
  let preferences = null;
  let closed = false;
  let basicEpoch = null;
  let detailedEpoch = null;
  let activeDay = null;
  const heldOff = new Set();
  const operations = new Map();
  let timer = null;
  let timerAt = Infinity;
  let checkpointTimer = null;
  let flight = null;
  let sender = null;

  function loadState() {
    if (store) return;
    store = createProductTelemetryStore(statePath);
    state = store.state;
    if (state?.version === 1) state = { ...state, version: STATE_VERSION, detail: emptyDetail() };
    draft = state?.detail.draft ?? null;
  }

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
  }

  function clearCheckpoint() {
    if (checkpointTimer !== null) clock.clearTimeout(checkpointTimer);
    checkpointTimer = null;
  }

  function syncEpochs() {
    const basic = eligible && !closed && !fault && preferences?.enabled && !heldOff.has("enabled");
    const detailed = basic && preferences.detailedEnabled && !heldOff.has("detailedEnabled");
    if (!basic) {
      basicEpoch = null;
      activeDay = null;
      clearTimer();
      flight?.controller.abort();
    } else basicEpoch ||= randomUUID();
    if (!detailed) {
      detailedEpoch = null;
      operations.clear();
      clearCheckpoint();
      if (flight?.tier === "detailed") flight.controller.abort();
    } else detailedEpoch ||= randomUUID();
  }

  function pause(code) {
    fault = code;
    syncEpochs();
    draft = null;
    return false;
  }

  function commit(next) {
    try {
      store.write(next);
      state = next;
      return true;
    } catch { return pause("state_error"); }
  }

  function purge(tier) {
    try { loadState(); } catch { return pause("state_error"); }
    if (!assertStore()) return false;
    draft = null;
    if (!state) return true;
    const outbox = tier === "all" ? [] : state.outbox.filter(row => tierOf(row) === "basic");
    if (outbox.length === state.outbox.length && !state.detail.draft) return true;
    return commit({ ...state, outbox, detail: { ...state.detail, draft: null } });
  }

  function refreshPreferences() {
    if (!eligible || closed || fault) return false;
    try {
      const result = configStore.getTelemetryPreferences();
      if (result.status === "missing" && !state && !preferences) return false;
      if (result.status !== "ok") {
        return pause(result.status === "missing" ? "config_missing_with_state" : "config_error");
      }
      preferences = result.needsMigration ? configStore.writeTelemetryPreferences() : result.preferences;
      syncEpochs();
      if (!preferences.enabled || heldOff.has("enabled")) purge("all");
      else if (!preferences.detailedEnabled || heldOff.has("detailedEnabled")) purge("detailed");
      return basicEpoch !== null;
    } catch { return pause("config_error"); }
  }

  function assertStore() {
    try { store.assertCurrent(); return true; }
    catch { return pause("state_error"); }
  }

  function getSettings() {
    let saved;
    try { saved = configStore.getTelemetryPreferences().preferences; } catch { /* unavailable */ }
    if (eligible && !fault && !closed) {
      refreshPreferences();
      if (basicEpoch) schedule();
    }
    return {
      available: !!saved && !closed, collectionAvailable: eligible && !closed && !fault,
      enabled: saved?.enabled ?? false, detailedEnabled: saved?.detailedEnabled ?? false,
      basicEpoch, detailedEpoch,
    };
  }

  // Close first in memory, then persist the preference. A restart with saved
  // false purges before sending. A re-enable also requires successful cleanup,
  // so a crash or failed cleanup cannot make discarded data eligible again.
  function setPreference(field, enabled) {
    const settings = getSettings();
    const respond = error => ({ error, settings: getSettings() });
    if (typeof enabled !== "boolean" || !["enabled", "detailedEnabled"].includes(field)
      || !settings.available || (field === "detailedEnabled" && (!settings.enabled || heldOff.has("enabled")))) {
      return respond("unavailable");
    }
    const tier = field === "enabled" ? "all" : "detailed";
    const wasOff = !settings[field] || heldOff.has(field);
    if (!enabled) {
      heldOff.add(field);
      syncEpochs();
    } else if (wasOff && !purge(tier)) {
      return respond("cleanup_pending");
    }
    try { preferences = configStore.writeTelemetryPreferences(field, enabled); }
    catch {
      if (!enabled) purge(tier);
      return respond(enabled ? "not_saved" : "paused_not_saved");
    }
    heldOff.delete(field);
    syncEpochs();
    if (!enabled && !purge(tier)) return respond("cleanup_pending");
    return respond(null);
  }

  function enqueue(next, event) {
    const outbox = [...next.outbox, queueRow(event)];
    while (outbox.length > LIMITS.events || Buffer.byteLength(JSON.stringify({ ...next, outbox })) > LIMITS.stateBytes) {
      const oldestDetail = outbox.findIndex(row => tierOf(row) === "detailed");
      if (oldestDetail === -1) return null;
      outbox.splice(oldestDetail, 1);
    }
    return { ...next, outbox };
  }

  function prune(now) {
    if (!state) return true;
    const outbox = state.outbox.filter(row => isFresh(row.event, now) && row.attemptsTotal < LIMITS.attemptsTotal);
    return outbox.length === state.outbox.length || commit({ ...state, outbox });
  }

  function sealDay(now, day) {
    if (!draft || draft.properties.report_day >= day) return true;
    const event = draft;
    const detail = { ...state.detail, draft: null, lastSealedDay: event.properties.report_day };
    const next = { ...state, detail };
    if (!commit(isFresh(event, now) ? enqueue(next, event) ?? next : next)) return false;
    draft = null;
    clearCheckpoint();
    return true;
  }

  function checkpoint() {
    clearCheckpoint();
    if (!detailedEpoch || !draft || draft === state.detail.draft) return true;
    if (!refreshPreferences() || !detailedEpoch || !draft) return false;
    const now = clock.now();
    const day = getUtcDay(now);
    if (!day || !sealDay(now, day)) return false;
    return !draft || commit({ ...state, detail: { ...state.detail, draft } });
  }

  function schedule(delay = LIMITS.flushMs) {
    if (!basicEpoch || closed) return;
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
    if (args.length !== 0 || !refreshPreferences() || !assertStore()) return false;
    const now = clock.now();
    const day = getUtcDay(now);
    if (!day || !prune(now) || !sealDay(now, day)) return false;
    if (state && day <= state.lastActiveDay) {
      if (day === state.lastActiveDay) activeDay = day;
      return false;
    }
    const distinctId = state?.distinctId || randomUUID();
    const event = createActivityEvent({ distinctId, uuid: randomUUID(), nowMs: now, build });
    const next = enqueue({
      version: STATE_VERSION, distinctId, lastActiveDay: day, transportFingerprint: fingerprint,
      pausedReason: state?.pausedReason || null, detail: state?.detail ?? emptyDetail(), outbox: state?.outbox ?? [],
    }, event);
    if (!next || !commit(next)) return false;
    activeDay = day;
    schedule(LIMITS.firstFlushMs);
    return true;
  }

  function bump(properties, key) {
    if ((properties[key] || 0) < LIMITS.count) properties[key] = (properties[key] || 0) + 1;
    else properties.counts_capped = true;
  }

  function include(properties, key, value) {
    const values = [...new Set([...(properties[key] || []), value])].sort();
    if (values.length > LIMITS.list) properties[key + "_truncated"] = true;
    properties[key] = values.slice(0, LIMITS.list);
  }

  function recordStep(step, now) {
    if (state.detail.steps.includes(step) || !prune(now)) return false;
    const event = createTelemetryEvent(STEP_EVENT, {
      distinctId: state.distinctId, uuid: randomUUID(), nowMs: now, build,
    }, { step });
    const next = enqueue({ ...state, detail: { ...state.detail, steps: [...state.detail.steps, step] } }, event);
    if (!next || !commit(next)) return false;
    schedule(LIMITS.firstFlushMs);
    return true;
  }

  function recordDetail(kind, payload) {
    const now = clock.now();
    const day = getUtcDay(now);
    if (!state || !day || day < state.lastActiveDay || (kind !== "feature_end" && day !== activeDay)) return false;
    if (kind === "onboarding_step") {
      // The first chat step is derived only from a matched successful turn.
      return payload.step !== "first_chat_succeeded" && recordStep(payload.step, now);
    }
    if (!sealDay(now, day) || (state.detail.lastSealedDay && day <= state.detail.lastSealedDay)
      || (draft && day < draft.properties.report_day)) return false;
    const current = draft || createTelemetryEvent(DAILY_EVENT, {
      distinctId: state.distinctId, uuid: randomUUID(), nowMs: now, build,
    }, { catalog_version: catalog.version });
    const properties = { ...current.properties };
    let firstChat = false;
    if (kind === "page_used") {
      const key = "used_" + payload.page;
      if (properties[key]) return false;
      properties[key] = true;
    } else if (kind === "configuration_snapshot") {
      const key = "observed_" + payload.dimension;
      if (properties[key]) return false;
      Object.assign(properties, JSON.parse(JSON.stringify(payload.values)), { [key]: true });
    } else if (kind === "feature_start") {
      if (operations.has(payload.operationId)) return false;
      if (operations.size >= LIMITS.pending) {
        const at = monotonic();
        for (const [id, operation] of operations) {
          if (operation.finished || at - operation.at >= LIMITS.ttlMs) { operations.delete(id); break; }
        }
        if (operations.size >= LIMITS.pending) return false;
      }
      operations.set(payload.operationId, { at: monotonic(), feature: payload.feature, finished: false });
      bump(properties, payload.feature + "_attempt_count");
      include(properties, "used_backend_types", payload.backendType);
    } else if (kind === "feature_end") {
      const operation = operations.get(payload.operationId);
      if (!operation || operation.finished) return false;
      const elapsed = monotonic() - operation.at;
      operation.finished = true;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= LIMITS.ttlMs) return false;
      const bucket = catalog.durationBuckets[[1000, 5000, 30_000, 120_000].filter(limit => elapsed >= limit).length];
      bump(properties, operation.feature + "_" + payload.outcome + "_count");
      bump(properties, operation.feature + "_duration_" + bucket + "_count");
      if (payload.errorKind) bump(properties, "error_" + payload.errorKind + "_count");
      firstChat = operation.feature === "chat_send" && payload.outcome === "success";
      if (firstChat) {
        const { runtimeType = "unknown", providerId = "unknown", modelId = "unknown" } = payload.usage || {};
        include(properties, "used_runtime_types", runtimeType);
        include(properties, "used_provider_ids", providerId);
        include(properties, "used_model_ids", modelId);
        bump(properties, modelId === "unknown" ? "model_resolution_unknown_count" : "model_resolution_known_count");
      }
    }
    const next = { ...current, properties };
    if (Buffer.byteLength(JSON.stringify(next)) > LIMITS.eventBytes) return false;
    draft = next;
    if (checkpointTimer === null) {
      checkpointTimer = clock.setTimeout(checkpoint, LIMITS.checkpointMs);
      checkpointTimer?.unref?.();
    }
    if (firstChat) recordStep("first_chat_succeeded", now);
    return true;
  }

  function recordSignal(signal) {
    if (!validateTelemetrySignal(signal)) return false;
    if (signal.kind === "activity") return signal.collectionEpoch === basicEpoch && recordActivity();
    return signal.collectionEpoch === detailedEpoch && refreshPreferences()
      && signal.collectionEpoch === detailedEpoch && recordDetail(signal.kind, signal.payload);
  }

  async function dispatch(currentFlight) {
    if (!refreshPreferences() || !assertStore()) return false;
    const now = clock.now();
    const day = getUtcDay(now);
    if (!day || !prune(now) || !sealDay(now, day) || !state || state.pausedReason) return false;
    const ready = state.outbox.filter(row => Date.parse(row.event.timestamp) <= now
      && row.nextAttemptAt <= now && (!row.attemptDay || row.attemptDay <= day)
      && (row.attemptDay !== day || row.attemptsToday < LIMITS.attemptsPerDay));
    const tier = ready.some(row => tierOf(row) === "basic") ? "basic" : "detailed";
    const epochForTier = () => tier === "basic" ? basicEpoch : detailedEpoch;
    const epoch = epochForTier();
    if (!epoch) return false;
    const rows = ready.filter(row => tierOf(row) === tier).slice(0, LIMITS.batch);
    if (!rows.length) return false;
    currentFlight.tier = tier;
    if (!rows.every(row => validateTelemetryEvent(row.event))) return pause("state_error");
    const ids = new Set(rows.map(row => row.event.uuid));
    const outbox = state.outbox.map(row => {
      if (!ids.has(row.event.uuid)) return row;
      const attemptsToday = row.attemptDay === day ? row.attemptsToday + 1 : 1;
      const base = Math.min(LIMITS.retryMaxMs, LIMITS.retryMinMs * 2 ** (attemptsToday - 1));
      const delay = Math.min(LIMITS.retryMaxMs, Math.ceil(base * (1 + Math.random())));
      return { ...row, attemptsTotal: row.attemptsTotal + 1, attemptDay: day, attemptsToday, nextAttemptAt: now + delay };
    });
    // Persist consumed retry budget before dispatch. Recheck both preferences
    // and the captured epoch so a revoked batch can never resume after toggling.
    const allowed = () => !currentFlight.controller.signal.aborted && refreshPreferences() && epoch === epochForTier();
    if (!commit({ ...state, outbox }) || !allowed()) return false;
    const events = rows.map(row => JSON.parse(JSON.stringify(row.event)));
    let result;
    try { result = await sender.sendBatch(events, { signal: currentFlight.controller.signal }); }
    catch { result = { kind: "retry" }; }
    if (!allowed() || !assertStore() || result?.kind === "canceled") return false;
    if (result?.kind === "ok") {
      return commit({ ...state, outbox: state.outbox.filter(row => !ids.has(row.event.uuid)) });
    }
    if (result?.kind === "retry") {
      const retryAfter = Number.isFinite(result.retryAfterMs)
        ? Math.min(LIMITS.retryMaxMs, Math.max(0, result.retryAfterMs)) : 0;
      if (retryAfter > 0) return commit({ ...state, outbox: state.outbox.map(row => ids.has(row.event.uuid)
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
    const current = { controller: new AbortController(), promise: null, tier: null };
    flight = current;
    current.promise = Promise.resolve().then(() => dispatch(current)).catch(() => pause("state_error")).finally(() => {
      if (flight === current) flight = null;
      scheduleNext();
    });
    return current.promise;
  }

  function close() {
    if (closed) return;
    checkpoint();
    closed = true;
    syncEpochs();
    draft = null;
  }

  if (eligible) {
    try {
      loadState();
      sender = transport || createPostHogTransport({ projectToken: build.projectToken, region: build.region });
      if (typeof sender.sendBatch !== "function") pause("transport_error");
      else if (refreshPreferences() && (!state || state.transportFingerprint === fingerprint
        || commit({ ...state, transportFingerprint: fingerprint, pausedReason: null }))) schedule();
    } catch { pause("state_error"); }
  }

  return {
    recordActivity, recordSignal, getSettings, setPreference, flush, close,
    getStatus: () => ({ collecting: basicEpoch !== null, closed,
      pausedReason: fault || (eligible ? state?.pausedReason ?? null : "build_disabled"),
      queuedEvents: state?.outbox.length || 0, inFlight: Boolean(flight) }),
  };
}

module.exports = { createProductTelemetry };
