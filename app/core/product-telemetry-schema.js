"use strict";

// Phase A only. There is no generic track(name, properties) API or detailed event.
const EVENT_NAME = "shoggoth_app_active";
const SCHEMA_VERSION = 1;
const POLICY_VERSION = 1;
const DAY_MS = 86_400_000;
const LIMITS = Object.freeze({
  stateBytes: 1024 * 1024, eventBytes: 16 * 1024,
  events: 128, batch: 20, ttlMs: 7 * DAY_MS, attemptsPerDay: 10, attemptsTotal: 70,
  flushMs: 60_000, firstFlushMs: 5_000, timeoutMs: 5_000, retryMinMs: 15_000, retryMaxMs: 900_000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,32})?$/u;
const TOKEN = /^phc_[a-zA-Z0-9]{8,180}$/u;
const OS_FAMILIES = new Set(["macos", "windows", "linux", "other"]);
const ARCHES = new Set(["arm64", "x64", "other"]);

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return keys.includes(key) && d?.enumerable === true && Object.hasOwn(d, "value");
  });
}

function getUtcDay(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 253402300799999) return null;
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isUtcDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day)
    && getUtcDay(Date.parse(`${day}T00:00:00.000Z`)) === day;
}

function validateTelemetryEvent(raw) {
  try {
    if (!exactObject(raw, ["event", "uuid", "distinct_id", "timestamp", "properties"])) return false;
    const p = raw.properties;
    if (raw.event !== EVENT_NAME || !isUuid(raw.uuid) || !isUuid(raw.distinct_id)
      || typeof raw.timestamp !== "string" || raw.timestamp.length !== 24
      || getUtcDay(Date.parse(raw.timestamp)) === null
      || new Date(raw.timestamp).toISOString() !== raw.timestamp
      || !exactObject(p, ["schema_version", "policy_version", "app_version", "os_family", "arch",
        "report_day", "$process_person_profile", "$geoip_disable"])) return false;
    return p.schema_version === SCHEMA_VERSION && p.policy_version === POLICY_VERSION
      && typeof p.app_version === "string" && VERSION.test(p.app_version)
      && OS_FAMILIES.has(p.os_family) && ARCHES.has(p.arch)
      && isUtcDay(p.report_day) && raw.timestamp.startsWith(p.report_day)
      && p.$process_person_profile === false && p.$geoip_disable === true
      && Buffer.byteLength(JSON.stringify(raw), "utf8") <= LIMITS.eventBytes;
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

function createActivityEvent({ distinctId, uuid, nowMs, build }) {
  const event = {
    event: EVENT_NAME, uuid, distinct_id: distinctId, timestamp: new Date(nowMs).toISOString(),
    properties: {
      schema_version: SCHEMA_VERSION, policy_version: POLICY_VERSION, app_version: build.appVersion,
      os_family: ({ darwin: "macos", win32: "windows", linux: "linux" })[build.platform] || "other",
      arch: build.arch === "arm64" || build.arch === "x64" ? build.arch : "other",
      report_day: getUtcDay(nowMs), $process_person_profile: false, $geoip_disable: true,
    },
  };
  if (!validateTelemetryEvent(event)) throw new Error("TELEMETRY_EVENT_INVALID");
  Object.freeze(event.properties);
  return Object.freeze(event);
}

module.exports = {
  EVENT_NAME, SCHEMA_VERSION, POLICY_VERSION, DAY_MS, LIMITS, exactObject, isUtcDay, getUtcDay,
  isUuid, isProjectToken, isEligibleBuild, validateTelemetryEvent, createActivityEvent,
};
