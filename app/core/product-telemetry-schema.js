"use strict";

const catalog = require("./data/product-telemetry-catalog.json");
const EVENT_NAME = "shoggoth_app_active";
const DAILY_EVENT = "shoggoth_daily_feature_usage";
const STEP_EVENT = "shoggoth_onboarding_step";
const SCHEMA_VERSION = 2;
const POLICY_VERSION = 2;
const DAY_MS = 86_400_000;
const LIMITS = Object.freeze({
  stateBytes: 1024 * 1024, eventBytes: 16 * 1024, signalBytes: 16 * 1024,
  events: 128, batch: 20, pending: 1024, list: 64, configurationCount: 1000, count: 1_000_000,
  ttlMs: 7 * DAY_MS, attemptsPerDay: 10, attemptsTotal: 70, checkpointMs: 1000,
  flushMs: 60_000, firstFlushMs: 5_000, timeoutMs: 5_000, retryMinMs: 15_000, retryMaxMs: 900_000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,32})?$/u;
const TOKEN = /^phc_[a-zA-Z0-9]{8,180}$/u;
const OS_FAMILIES = new Set(["macos", "windows", "linux", "other"]);
const ARCHES = new Set(["arm64", "x64", "other"]);
const PAGES = new Set(Object.values(catalog.pages));
const BACKENDS = new Set(catalog.backendTypes);
const RUNTIMES = new Set(catalog.runtimeTypes);
const PROVIDERS = new Set([...Object.keys(catalog.providerModels), "custom", "other", "unknown"]);
const MODELS = new Set(["custom", "other", "unknown", ...Object.entries(catalog.providerModels)
  .flatMap(([provider, ids]) => ids.map(id => provider + "/" + id))]);
const CONNECTORS = new Set([
  ...catalog.officialConnectorIds.map(id => "official/" + id),
  ...catalog.featuredConnectorIds.map(id => "featured/" + id),
]);
const STEPS = new Set(catalog.steps);
const ERROR_KINDS = new Set(catalog.errorKinds);
const OUTCOMES = new Set(["success", "error", "canceled"]);
const COMMON_KEYS = ["schema_version", "policy_version", "app_version", "os_family", "arch",
  "report_day", "$process_person_profile", "$geoip_disable"];
const ENVELOPE_KEYS = ["event", "uuid", "distinct_id", "timestamp", "properties"];

function plainKeys(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  return keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && field.enumerable && Object.hasOwn(field, "value");
  }) ? keys : null;
}

function exactObject(value, keys) {
  const own = plainKeys(value);
  return own !== null && own.length === keys.length && own.every(key => keys.includes(key));
}

function boundedList(value, max, check) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field?.enumerable || !Object.hasOwn(field, "value") || !check(field.value, i)) return false;
  }
  return true;
}

function allowedList(values, choices) {
  return boundedList(values, LIMITS.list, (value, i) => choices.has(value) && (i === 0 || values[i - 1] < value));
}
const isCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const isTrue = value => value === true;
const counter = value => isCount(value, LIMITS.count);
const configCount = value => isCount(value, LIMITS.configurationCount);

const snapshotFields = {
  backend: { configured_backend_types: value => allowedList(value, BACKENDS) },
  runtime: { configured_runtime_types: value => allowedList(value, RUNTIMES) },
  provider: { configured_provider_ids: value => allowedList(value, PROVIDERS), configured_provider_count: configCount },
  model: { configured_model_ids: value => allowedList(value, MODELS), configured_model_count: configCount },
  connector: { enabled_connector_ids: value => allowedList(value, CONNECTORS), enabled_connector_count: configCount,
    ...Object.fromEntries(catalog.connectorKinds.map(kind => ["connector_kind_" + kind + "_count", configCount])) },
  skill: { enabled_skill_count: configCount,
    ...Object.fromEntries(catalog.skillSources.map(source => ["skill_source_" + source + "_count", configCount])) },
  agent: { agent_count: configCount },
};
for (const fields of Object.values(snapshotFields)) {
  for (const [key, check] of Object.entries(fields)) {
    if (check === configCount) fields[key + "_capped"] = isTrue;
    else fields[key + "_truncated"] = isTrue;
  }
}

const dailyFields = new Map([
  ["counts_capped", isTrue],
  ["model_resolution_known_count", counter], ["model_resolution_unknown_count", counter],
  ["used_backend_types", value => allowedList(value, BACKENDS)],
  ["used_runtime_types", value => allowedList(value, RUNTIMES)],
  ["used_provider_ids", value => allowedList(value, PROVIDERS)],
  ["used_model_ids", value => allowedList(value, MODELS)],
  ["used_model_ids_truncated", isTrue],
]);
for (const [dimension, fields] of Object.entries(snapshotFields)) {
  dailyFields.set("observed_" + dimension, isTrue);
  for (const [key, check] of Object.entries(fields)) dailyFields.set(key, check);
}
for (const page of PAGES) dailyFields.set("used_" + page, isTrue);
for (const kind of ERROR_KINDS) dailyFields.set("error_" + kind + "_count", counter);
for (const feature of Object.keys(catalog.features)) {
  for (const result of ["attempt", ...OUTCOMES]) dailyFields.set(feature + "_" + result + "_count", counter);
  for (const bucket of catalog.durationBuckets) dailyFields.set(feature + "_duration_" + bucket + "_count", counter);
}

function validSnapshot(dimension, values) {
  if (typeof dimension !== "string" || !Object.hasOwn(snapshotFields, dimension)) return false;
  const fields = snapshotFields[dimension];
  const keys = plainKeys(values);
  return keys !== null && keys.every(key => Object.hasOwn(fields, key) && fields[key](values[key]))
    && Object.keys(fields).every(key => key.endsWith("_truncated") || key.endsWith("_capped") || keys.includes(key));
}

function getUtcDay(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 253402300799999) return null;
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isUtcDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day)
    && getUtcDay(Date.parse(day + "T00:00:00.000Z")) === day;
}

function telemetryTier(eventName) {
  if (eventName === EVENT_NAME) return "basic";
  if (eventName === DAILY_EVENT || eventName === STEP_EVENT) return "detailed";
  return null;
}

function validateTelemetryEvent(raw) {
  try {
    if (!exactObject(raw, ENVELOPE_KEYS) || !isUuid(raw.uuid) || !isUuid(raw.distinct_id)
      || typeof raw.timestamp !== "string" || raw.timestamp.length !== 24
      || getUtcDay(Date.parse(raw.timestamp)) === null
      || new Date(raw.timestamp).toISOString() !== raw.timestamp) return false;
    const p = raw.properties;
    const keys = plainKeys(p);
    if (!keys || !COMMON_KEYS.every(key => keys.includes(key))) return false;
    const current = p.schema_version === SCHEMA_VERSION && p.policy_version === POLICY_VERSION;
    const legacy = raw.event === EVENT_NAME && p.schema_version === 1 && p.policy_version === 1;
    if ((!current && !legacy) || typeof p.app_version !== "string" || !VERSION.test(p.app_version)
      || !OS_FAMILIES.has(p.os_family) || !ARCHES.has(p.arch) || !isUtcDay(p.report_day)
      || !raw.timestamp.startsWith(p.report_day) || p.$process_person_profile !== false || p.$geoip_disable !== true) return false;
    const extras = keys.filter(key => !COMMON_KEYS.includes(key));
    if (raw.event === EVENT_NAME) return extras.length === 0;
    if (raw.event === STEP_EVENT) return extras.length === 1 && extras[0] === "step" && STEPS.has(p.step);
    if (raw.event !== DAILY_EVENT || raw.timestamp !== p.report_day + "T00:00:00.000Z"
      || p.catalog_version !== catalog.version
      || !extras.every(key => key === "catalog_version" || dailyFields.get(key)?.(p[key]))) return false;
    for (const [dimension, fields] of Object.entries(snapshotFields)) {
      if (!Object.keys(fields).some(key => keys.includes(key))) {
        if (p["observed_" + dimension]) return false;
        continue;
      }
      const values = Object.fromEntries(Object.keys(fields).filter(key => keys.includes(key)).map(key => [key, p[key]]));
      if (!p["observed_" + dimension] || !validSnapshot(dimension, values)) return false;
    }
    return Buffer.byteLength(JSON.stringify(raw), "utf8") <= LIMITS.eventBytes;
  } catch { return false; }
}

function validateTelemetrySignal(signal) {
  try {
    if (!exactObject(signal, ["kind", "collectionEpoch", "payload"]) || !isUuid(signal.collectionEpoch)) return false;
    const { kind, payload } = signal;
    switch (kind) {
      case "activity":
        return exactObject(payload, []);
      case "page_used":
        return exactObject(payload, ["page"]) && PAGES.has(payload.page);
      case "feature_start":
        return exactObject(payload, ["feature", "operationId", "backendType"]) && isUuid(payload.operationId)
          && typeof payload.feature === "string" && Object.hasOwn(catalog.features, payload.feature)
          && BACKENDS.has(payload.backendType);
      case "feature_end":
        return exactObject(payload, ["operationId", "outcome", "errorKind", "usage"]) && isUuid(payload.operationId)
          && OUTCOMES.has(payload.outcome) && (payload.outcome === "error" ? ERROR_KINDS.has(payload.errorKind) : payload.errorKind === null)
          && (payload.usage === null || (exactObject(payload.usage, ["runtimeType", "providerId", "modelId"])
            && RUNTIMES.has(payload.usage.runtimeType) && PROVIDERS.has(payload.usage.providerId) && MODELS.has(payload.usage.modelId)));
      case "configuration_snapshot":
        return exactObject(payload, ["dimension", "values"]) && validSnapshot(payload.dimension, payload.values)
          && Buffer.byteLength(JSON.stringify(signal), "utf8") <= LIMITS.signalBytes;
      case "onboarding_step":
        return exactObject(payload, ["step"]) && STEPS.has(payload.step);
      default:
        return false;
    }
  } catch { return false; }
}

function isUuid(value) { return typeof value === "string" && UUID.test(value); }
function isProjectToken(value) { return typeof value === "string" && TOKEN.test(value); }
function isEligibleBuild(build) {
  return Boolean(build && build.exportEnabled === true && build.isPackaged === true
    && isProjectToken(build.projectToken) && (build.region === "us" || build.region === "eu")
    && Number.isSafeInteger(build.revision) && build.revision > 0
    && typeof build.appVersion === "string" && VERSION.test(build.appVersion));
}

function createTelemetryEvent(eventName, { distinctId, uuid, nowMs, build }, extra = {}) {
  const reportDay = getUtcDay(nowMs);
  const event = {
    event: eventName, uuid, distinct_id: distinctId,
    timestamp: eventName === DAILY_EVENT ? reportDay + "T00:00:00.000Z" : new Date(nowMs).toISOString(),
    properties: {
      schema_version: SCHEMA_VERSION, policy_version: POLICY_VERSION, app_version: build.appVersion,
      os_family: ({ darwin: "macos", win32: "windows", linux: "linux" })[build.platform] || "other",
      arch: build.arch === "arm64" || build.arch === "x64" ? build.arch : "other",
      report_day: reportDay, $process_person_profile: false, $geoip_disable: true,
      ...extra,
    },
  };
  if (!validateTelemetryEvent(event)) throw new Error("TELEMETRY_EVENT_INVALID");
  Object.freeze(event.properties);
  return Object.freeze(event);
}

function createActivityEvent(input) { return createTelemetryEvent(EVENT_NAME, input); }

module.exports = {
  EVENT_NAME, DAILY_EVENT, STEP_EVENT, SCHEMA_VERSION, POLICY_VERSION, DAY_MS, LIMITS, catalog,
  exactObject, boundedList, isUtcDay, getUtcDay, isUuid, isProjectToken, isEligibleBuild,
  telemetryTier, validateTelemetrySignal, validateTelemetryEvent, createActivityEvent, createTelemetryEvent,
};
