"use strict";

const crypto = require("node:crypto");
const { normalizeSchedule } = require("./native-cron-store");
const { serviceError } = require("./security");
const { PUBLIC_MESSAGES } = require("./proactive-messages");

const DAY_MS = 86_400_000;
const IDEA_COOLDOWN_MS = 7 * DAY_MS;
const GROUPS = Object.freeze(["seed", "attention", "sprouted"]);
const CONFIG_FIELDS = Object.freeze(["id", "kind", "profileId", "enabled", "schedule", "timezone",
  "activeHours", "checklist", "scopes", "target", "push", "budget", "review"]);
const METHODS = Object.freeze({
  "proactive.document.get": ["profileId"],
  "proactive.document.set": ["profileId", "content", "expectedRevision"],
  "proactive.scratch.get": ["profileId"],
  "proactive.scratch.set": ["profileId", "content", "expectedRevision"],
  "proactive.agents.list": ["cursor", "limit"],
  "proactive.runtime.verify": ["profileId"],
  "proactive.targets.list": ["profileId", "cursor", "limit"],
  "proactive.runs.list": ["profileId", "cursor", "limit"],
  "proactive.monitor.get": ["kind", "profileId"],
  "proactive.monitor.list": ["profileId", "cursor", "limit"],
  "proactive.monitor.set": ["operationId", "expectedRevision", "config"],
  "proactive.monitor.history": ["id", "cursor", "limit"],
  "proactive.preview": ["config"],
  "proactive.notice.get": ["id"],
  "proactive.note.get": ["id"],
  "proactive.note.set": ["operationId", "id", "expectedRevision", "patch"],
  "proactive.notification-context": ["focused"],
});
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const at = value => Number.isSafeInteger(value) && value >= 0;
const historyCursor = value => {
  const match = typeof value === "string" && /^(\d{1,16}):(occ-[a-f0-9]{64})$/u.exec(value);
  return match && at(Number(match[1])) ? { createdAt: Number(match[1]), id: match[2] } : null;
};
const text = (value, max = 4096, empty = false) => typeof value === "string" && value.isWellFormed()
  && !value.includes("\0") && (empty || value.trim().length > 0) && Buffer.byteLength(value) <= max;
const scratchText = value => text(value, 4096, true) && Buffer.byteLength(JSON.stringify(value)) <= 8192;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, "value"));
const fail = (code = "PROACTIVE_INVALID") => { throw serviceError(code, PUBLIC_MESSAGES[code]); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function boundedJsonText(value, maxBytes) {
  if (value === null) return null;
  value = value.toWellFormed();
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  const points = [...value]; let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(points.slice(0, mid).join("") + "…")) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("") + "…";
}
function boundedCandidates(candidates, maxItems = 32, maxBytes = 48 * 1024) {
  const items = []; let bytes = 2;
  for (const candidate of candidates) {
    const item = { ...candidate, title: boundedJsonText(candidate.title, 512),
      excerpt: boundedJsonText(candidate.excerpt, candidate.group === "check" ? 512 : 1024),
      requestTitle: boundedJsonText(candidate.requestTitle, 512) };
    const size = Buffer.byteLength(JSON.stringify(item)) + Number(items.length > 0);
    if (items.length >= maxItems || bytes + size > maxBytes) break;
    bytes += size; items.push(item);
  }
  return { candidates: items, bounded: items.length < candidates.length };
}
const monitorId = (kind, profileId) => kind === "inspiration" ? "inspiration-daily" : `heartbeat-${digest(profileId)}`;
const validTimeOfDay = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
function validTimezone(value) {
  if (value === "system") return true;
  if (!text(value, 128)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
function validateConfig(value) {
  if (!exact(value, CONFIG_FIELDS) || !["heartbeat", "inspiration"].includes(value.kind)
    || !(value.profileId === null || id(value.profileId)) || (value.kind === "heartbeat" && !id(value.profileId))
    || value.id !== monitorId(value.kind, value.profileId) || typeof value.enabled !== "boolean"
    || (value.enabled && value.profileId === null) || !validTimezone(value.timezone)
    || (value.timezone === "system" && value.kind !== "heartbeat")
    || typeof value.push !== "boolean") fail();
  let schedule;
  try { schedule = normalizeSchedule(value.schedule); } catch { fail(); }
  if (value.kind === "heartbeat" && schedule.kind !== "every") fail();
  if (value.kind === "inspiration" && (schedule.kind !== "cron" || schedule.tz !== value.timezone
    || !/^\d{1,2} \d{1,2} \* \* \*$/u.test(schedule.expr))) fail();
  if (value.activeHours !== null && (!exact(value.activeHours, ["start", "end"])
    || !validTimeOfDay(value.activeHours.start) || !validTimeOfDay(value.activeHours.end)
    || value.activeHours.start === value.activeHours.end)) fail();
  if (!Array.isArray(value.checklist) || value.checklist.length > 24
    || !value.checklist.every(item => exact(item, ["id", "instruction", "enabled", "mode"])
      && id(item.id) && text(item.instruction, 2048) && typeof item.enabled === "boolean"
      && ["review", "attention"].includes(item.mode))
    || new Set(value.checklist.map(item => item.id)).size !== value.checklist.length) fail();
  if (!exact(value.scopes, ["inspiration", "runIds"]) || typeof value.scopes.inspiration !== "boolean"
    || !Array.isArray(value.scopes.runIds) || value.scopes.runIds.length > 32
    || !value.scopes.runIds.every(id) || new Set(value.scopes.runIds).size !== value.scopes.runIds.length) fail();
  if (!exact(value.target, value.target?.mode === "explicit" ? ["mode", "sessionKey"] : ["mode"])
    || !["dedicated", "explicit"].includes(value.target.mode)
    || (value.target.mode === "explicit" && !id(value.target.sessionKey))) fail();
  if (!exact(value.budget, ["maxRunsPerDay", "maxTokensPerDay"])
    || !Number.isInteger(value.budget.maxRunsPerDay) || value.budget.maxRunsPerDay < 1 || value.budget.maxRunsPerDay > 48
    || !Number.isInteger(value.budget.maxTokensPerDay) || value.budget.maxTokensPerDay < 1024
    || value.budget.maxTokensPerDay > (value.kind === "heartbeat" ? 10_000_000 : 1_000_000)) fail();
  if (value.kind === "heartbeat" ? value.review !== null : !exact(value.review, ["seedAgeDays", "sproutedAgeDays", "maxItems", "groups"])
    || ![value.review.seedAgeDays, value.review.sproutedAgeDays].every(days => Number.isInteger(days) && days >= 1 && days <= 365)
    || !Number.isInteger(value.review.maxItems) || value.review.maxItems < 1 || value.review.maxItems > 10
    || !Array.isArray(value.review.groups) || value.review.groups.length < 1 || value.review.groups.length > 3
    || !value.review.groups.every(group => GROUPS.includes(group)) || new Set(value.review.groups).size !== value.review.groups.length) fail();
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) fail();
  return structuredClone({ ...value, schedule });
}
function defaultConfig(kind, profileId, now, timezone = kind === "heartbeat" ? "system" : Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return validateConfig({ id: monitorId(kind, profileId), kind, profileId, enabled: kind === "heartbeat",
    schedule: kind === "heartbeat" ? { kind: "every", everyMs: 30 * 60_000, anchorMs: now }
      : { kind: "cron", expr: "0 10 * * *", tz: timezone }, timezone,
    activeHours: kind === "heartbeat" ? { start: "08:00", end: "22:00" } : null,
    checklist: [], scopes: { inspiration: kind === "inspiration", runIds: [] },
    target: { mode: "dedicated" }, push: true, budget: { maxRunsPerDay: kind === "heartbeat" ? 24 : 1,
      maxTokensPerDay: kind === "heartbeat" ? 10_000_000 : 20_000 },
    review: kind === "inspiration" ? { seedAgeDays: 1, sproutedAgeDays: 3, maxItems: 5, groups: [...GROUPS] } : null });
}
function validateParams(method, value) {
  if (!METHODS[method] || !exact(value, METHODS[method]) || Buffer.byteLength(JSON.stringify(value)) > 68 * 1024) fail();
  if (method === "proactive.monitor.get" && (!["heartbeat", "inspiration"].includes(value.kind)
    || !(value.profileId === null || id(value.profileId)) || (value.kind === "heartbeat" && !id(value.profileId)))) fail();
  if (method === "proactive.monitor.list" && !(value.profileId === null || id(value.profileId))) fail();
  if (method === "proactive.runtime.verify" && !id(value.profileId)) fail();
  if (["proactive.targets.list", "proactive.runs.list"].includes(method) && !id(value.profileId)) fail();
  for (const field of ["id", "operationId"]) if (Object.hasOwn(value, field) && !id(value[field])) fail();
  if (Object.hasOwn(value, "expectedRevision") && (method === "proactive.document.set"
    ? typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedRevision) : !at(value.expectedRevision))) fail();
  if (/^proactive\.(?:document|scratch)\./u.test(method) && !id(value.profileId)) fail();
  if (method === "proactive.document.set" && !text(value.content, 16384, true)) fail("PROACTIVE_DOCUMENT_INVALID");
  if (method === "proactive.scratch.set" && !scratchText(value.content)) fail();
  if (["proactive.agents.list", "proactive.monitor.list", "proactive.targets.list", "proactive.runs.list"].includes(method) && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50
    || !(value.cursor === null || id(value.cursor)))) fail();
  if (method === "proactive.monitor.history" && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50
    || !(value.cursor === null || historyCursor(value.cursor)))) fail();
  if (Object.hasOwn(value, "config")) validateConfig(value.config);
  if (method === "proactive.note.set") {
    if (!value.patch || Object.getPrototypeOf(value.patch) !== Object.prototype || !Object.keys(value.patch).length
      || Object.keys(value.patch).some(key => !["disabled", "snoozedUntil", "handled"].includes(key))
      || ["disabled", "handled"].some(key => Object.hasOwn(value.patch, key) && typeof value.patch[key] !== "boolean")
      || (Object.hasOwn(value.patch, "snoozedUntil") && !(value.patch.snoozedUntil === null || at(value.patch.snoozedUntil)))) fail();
  }
  if (method === "proactive.notification-context" && typeof value.focused !== "boolean") fail();
  return structuredClone(value);
}
function validateResponse(value) {
  if (!exact(value, ["runId", "outcome", "candidates", "reason", "body", ...(Object.hasOwn(value || {}, "scratch") ? ["scratch"] : [])])
    || (Object.hasOwn(value || {}, "scratch") && !scratchText(value.scratch)) || !id(value.runId)
    || !["silent", "notice"].includes(value.outcome) || !text(value.reason, 512, true) || !text(value.body, 4096, true)
    || !Array.isArray(value.candidates) || value.candidates.length > 32
    || !value.candidates.every(candidate => exact(candidate, ["id", "evidenceVersion"])
      && id(candidate.id) && /^[a-f0-9]{64}$/u.test(candidate.evidenceVersion))
    || new Set(value.candidates.map(candidate => candidate.id)).size !== value.candidates.length
    || (value.outcome === "notice" && (!value.candidates.length || !value.body.trim()))
    || (value.outcome === "silent" && value.candidates.length !== 0)) fail("PROACTIVE_RESPONSE_INVALID");
  return structuredClone(value);
}
function localParts(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone === "system" ? undefined : timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function inActiveHours(now, timezone, hours) {
  if (!hours) return true;
  const { time } = localParts(now, timezone);
  return hours.start < hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}

function validateCandidate(value) {
  const fields = ["id", "ideaId", "group", "reason", "enteredAt", "ageDays", "title", "excerpt", "favorite", "runId",
    "backendId", "agentId", "requestId", "requestExpiresAt", "requestTitle", "href", "eventKey", "evidenceVersion"];
  if (value?.group === "check") fields.push("evidence");
  if (!exact(value, fields) || !id(value.id) || !["seed", "attention", "sprouted", "check"].includes(value.group)
    || !text(value.reason, 128) || !at(value.enteredAt) || !at(value.ageDays) || !text(value.title, 1024, true)
    || !text(value.excerpt, 4096, true) || typeof value.favorite !== "boolean"
    || ![value.ideaId, value.runId, value.backendId, value.agentId, value.requestId].every(value => value === null || id(value))
    || !(value.requestExpiresAt === null || at(value.requestExpiresAt)) || !(value.requestTitle === null || text(value.requestTitle, 1024, true))
    || !text(value.href, 2048) || !/^\/(?:inspirations\?|chat\?|agents$)/u.test(value.href)
    || !text(value.eventKey, 1024) || !/^[a-f0-9]{64}$/u.test(value.evidenceVersion)) fail("PROACTIVE_RESPONSE_INVALID");
  if (value.group === "check" && (!Array.isArray(value.evidence) || value.evidence.length > 32
    || Buffer.byteLength(JSON.stringify(value.evidence)) > 12 * 1024)) fail("PROACTIVE_RESPONSE_INVALID");
  return value;
}
function validateNote(value) {
  if (!exact(value, ["id", "revision", "lastRemindedAt", "snoozedUntil", "disabled", "handled", "noticeId"])
    || !id(value.id) || !at(value.revision) || ![value.lastRemindedAt, value.snoozedUntil].every(value => value === null || at(value))
    || typeof value.disabled !== "boolean" || typeof value.handled !== "boolean" || !(value.noticeId === null || id(value.noticeId))) fail("PROACTIVE_STORE_CORRUPT");
  return value;
}
function validateOccurrence(value) {
  if (!exact(value, ["id", "monitorId", "scheduledAt", "createdAt", "revision", "config", "state", "reason", "runId",
    "candidates", "response", "finishedAt", "deferredUntil", "expiresAt", ...(Object.hasOwn(value || {}, "heartbeat") ? ["heartbeat"] : [])]) || !id(value.id) || !id(value.monitorId)
    || ![value.scheduledAt, value.createdAt, value.revision, value.expiresAt].every(at) || value.revision < 1
    || value.monitorId !== value.config?.id || !["claimed", "running", "deferred", "silent", "skipped", "published", "failed", "needs_verification"].includes(value.state)
    || !(value.reason === null || text(value.reason, 128)) || !(value.runId === null || id(value.runId))
    || ![value.finishedAt, value.deferredUntil].every(value => value === null || at(value)) || !Array.isArray(value.candidates)
    || value.candidates.length > 32 || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) fail("PROACTIVE_STORE_CORRUPT");
  validateConfig(value.config); value.candidates.forEach(validateCandidate);
  if (Object.hasOwn(value, "heartbeat")) {
    const h = value.heartbeat;
    if (value.config.kind !== "heartbeat" || !exact(h, ["revision", "content", "scratch", "web"])
      || !/^[a-f0-9]{64}$/u.test(h.revision) || !text(h.content, 16384, true)
      || !exact(h.scratch, ["revision", "content", "updatedAt"]) || !at(h.scratch.revision) || !at(h.scratch.updatedAt) || !scratchText(h.scratch.content)
      || !Array.isArray(h.web) || h.web.length > 4 || Buffer.byteLength(JSON.stringify(h)) > 48 * 1024) fail("PROACTIVE_STORE_CORRUPT");
  }
  if (value.response !== null) validateResponse(value.response);
  return value;
}
function validateNotice(value) {
  if (!exact(value, ["id", "occurrenceId", "monitorId", "profileId", "revision", "kind", "createdAt", "title", "body", "items",
    "target", "push", "sessionKey", "appState", "systemState", "systemReason", "dayKey"])
    || ![value.id, value.occurrenceId, value.monitorId, value.profileId].every(id) || !at(value.revision) || !at(value.createdAt)
    || !["heartbeat", "inspiration"].includes(value.kind) || !text(value.title, 512) || !text(value.body, 16 * 1024)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 10 || typeof value.push !== "boolean"
    || !(value.sessionKey === null || id(value.sessionKey)) || !["pending", "publishing", "published", "failed", "suppressed", "needs_verification"].includes(value.appState)
    || !["pending", "submitting", "submitted", "failed", "suppressed", "needs_verification"].includes(value.systemState)
    || !(value.systemReason === null || text(value.systemReason, 128))
    || !(value.dayKey === null || /^\d{4}-\d\d-\d\d$/u.test(value.dayKey))
    || !exact(value.target, value.target?.mode === "explicit" ? ["mode", "sessionKey"] : ["mode"])
    || !["dedicated", "explicit"].includes(value.target.mode) || (value.target.mode === "explicit" && !id(value.target.sessionKey))) fail("PROACTIVE_STORE_CORRUPT");
  value.items.forEach(validateCandidate); return value;
}
function validateTarget(value) {
  if (!exact(value, ["operationId", "profileId", "sessionKey", "createdAt", "deleted"])
    || !id(value.operationId) || !id(value.profileId) || !(value.sessionKey === null || id(value.sessionKey))
    || !at(value.createdAt) || typeof value.deleted !== "boolean") fail("PROACTIVE_STORE_CORRUPT");
  return value;
}
function validateMonitor(value) {
  if (!exact(value, ["config", "revision", "nextRunAt", "createdAt", "updatedAt"]) || !at(value.revision)
    || !(value.nextRunAt === null || at(value.nextRunAt)) || !at(value.createdAt) || !at(value.updatedAt)) fail("PROACTIVE_STORE_CORRUPT");
  validateConfig(value.config); return value;
}

function validateResult(method, result) {
  const bad = () => fail("PROACTIVE_RESPONSE_INVALID");
  if (!result || Object.getPrototypeOf(result) !== Object.prototype || Buffer.byteLength(JSON.stringify(result)) > 60 * 1024) bad();
  const monitor = value => {
    try { validateMonitor(value); } catch { bad(); }
  };
  const capability = value => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || typeof value.deterministic !== "boolean" || typeof value.semanticVerified !== "boolean"
      || !(value.reason === null || text(value.reason, 128))
      || Object.keys(value).some(key => !["deterministic", "semanticVerified", "reason", "runtime", "runtimeAccountId", "verification"].includes(key))) bad();
  };
  const status = value => {
    if (!exact(value, ["lastCheckAt", "lastNoticeAt", "reason", "state", "modelResponseRecords", "totalTokens", "capabilities", "delivery"])
      || ![value.lastCheckAt, value.lastNoticeAt].every(value => value === null || at(value))
      || !(value.reason === null || text(value.reason, 128)) || !text(value.state, 128) || !at(value.modelResponseRecords) || !at(value.totalTokens)) bad();
    capability(value.capabilities);
    if (value.delivery !== null && (!exact(value.delivery, ["appState", "systemState", "reason"])
      || !["pending", "publishing", "published", "failed", "suppressed", "needs_verification"].includes(value.delivery.appState)
      || !["pending", "submitting", "submitted", "failed", "suppressed", "needs_verification"].includes(value.delivery.systemState)
      || !(value.delivery.reason === null || text(value.delivery.reason, 128)))) bad();
  };
  const note = value => {
    if (!exact(value, ["id", "revision", "lastRemindedAt", "snoozedUntil", "disabled", "handled", "noticeId"])
      || !id(value.id) || !at(value.revision) || ![value.lastRemindedAt, value.snoozedUntil].every(value => value === null || at(value))
      || typeof value.disabled !== "boolean" || typeof value.handled !== "boolean" || !(value.noticeId === null || id(value.noticeId))) bad();
  };
  if (["proactive.document.get", "proactive.document.set"].includes(method)) {
    const d = result.document;
    if (!exact(result, ["document"]) || !exact(d, ["name", "content", "revision", "missing", "readOnly"])
      || d.name !== "HEARTBEAT.md" || !text(d.content, 16384, true) || !/^[a-f0-9]{64}$/u.test(d.revision)
      || typeof d.missing !== "boolean" || d.readOnly !== false) bad();
  } else if (["proactive.scratch.get", "proactive.scratch.set"].includes(method)) {
    const s = result.scratch;
    if (!exact(result, ["scratch"]) || !exact(s, ["revision", "content", "updatedAt"])
      || !at(s.revision) || !at(s.updatedAt) || !scratchText(s.content)) bad();
  } else if (["proactive.monitor.get", "proactive.monitor.set"].includes(method)) {
    if (!exact(result, ["monitor", "status"])) bad(); monitor(result.monitor); status(result.status);
  } else if (method === "proactive.monitor.list") {
    if (!exact(result, ["monitors", "nextCursor"]) || !Array.isArray(result.monitors) || result.monitors.length > 50
      || !(result.nextCursor === null || id(result.nextCursor))) bad();
    for (const item of result.monitors) { if (!exact(item, ["monitor", "status"])) bad(); monitor(item.monitor); status(item.status); }
  } else if (method === "proactive.agents.list") {
    if (!exact(result, ["agents", "nextCursor"]) || !Array.isArray(result.agents) || result.agents.length > 50
      || !(result.nextCursor === null || id(result.nextCursor))) bad();
    for (const value of result.agents) {
      if (!exact(value, ["id", "agentId", "backendId", "name", "runtime", "runtimeAccountId", "capabilities"])
        || ![value.id, value.agentId, value.backendId, value.runtime, value.runtimeAccountId].every(id) || !text(value.name, 512)) bad();
      capability(value.capabilities);
    }
  } else if (method === "proactive.runtime.verify") {
    if (!exact(result, ["capabilities"])) bad(); capability(result.capabilities);
  } else if (method === "proactive.targets.list") {
    if (!exact(result, ["targets", "nextCursor"]) || !Array.isArray(result.targets) || result.targets.length > 50
      || !(result.nextCursor === null || id(result.nextCursor))) bad();
    for (const target of result.targets) if (!exact(target, ["sessionKey", "title", "updatedAt"])
      || !id(target.sessionKey) || !text(target.title, 512) || !at(target.updatedAt)) bad();
  } else if (method === "proactive.runs.list") {
    if (!exact(result, ["runs", "nextCursor"]) || !Array.isArray(result.runs) || result.runs.length > 50
      || !(result.nextCursor === null || id(result.nextCursor))) bad();
    for (const run of result.runs) if (!exact(run, ["id", "source", "sourceId", "status"])
      || ![run.id, run.source, run.sourceId, run.status].every(id)) bad();
  } else if (method === "proactive.note.get" || method === "proactive.note.set") {
    if (!exact(result, ["note"])) bad(); note(result.note);
  } else if (method === "proactive.monitor.history") {
    if (!exact(result, ["checks", "nextCursor"]) || !Array.isArray(result.checks) || result.checks.length > 50
      || !(result.nextCursor === null || historyCursor(result.nextCursor))) bad();
    for (const value of result.checks) if (!exact(value, ["id", "scheduledAt", "createdAt", "state", "reason", "runId", "candidateCount", "finishedAt"])
      || !id(value.id) || ![value.scheduledAt, value.createdAt, value.candidateCount].every(at) || !text(value.state, 64)
      || !(value.reason === null || text(value.reason, 128)) || !(value.runId === null || id(value.runId))
      || !(value.finishedAt === null || at(value.finishedAt))) bad();
  } else if (method === "proactive.notification-context") {
    if (!exact(result, ["accepted"]) || result.accepted !== true) bad();
  } else if (method === "proactive.preview") {
    if (!exact(result, ["candidates", "unknown", "examined", "bounded"]) || !Array.isArray(result.candidates) || result.candidates.length > 32
      || !Array.isArray(result.unknown) || result.unknown.length > 20 || !at(result.examined) || typeof result.bounded !== "boolean") bad();
    result.candidates.forEach(validateCandidate);
    for (const value of result.unknown) if (!exact(value, ["ideaId", "reason"]) || !id(value.ideaId) || !text(value.reason, 128)) bad();
  } else if (method === "proactive.notice.get") {
    if (!exact(result, ["notice", "items"]) || !id(result.notice?.id) || !Array.isArray(result.items) || result.items.length > 10
      || !text(result.notice.body, 16 * 1024) || !text(result.notice.title, 512)) bad();
    for (const item of result.items) if (!id(item.id) || typeof item.actionable !== "boolean" || !text(item.href, 1024)) bad();
    validateNotice(result.notice);
    for (const { actionable, ...item } of result.items) validateCandidate(item);
  } else bad();
  return structuredClone(result);
}
module.exports = { DAY_MS, IDEA_COOLDOWN_MS, GROUPS, CONFIG_FIELDS, PUBLIC_MESSAGES, PROACTIVE_SERVICE_METHODS: Object.keys(METHODS),
  exact, id, at, text, scratchText, fail, digest, boundedJsonText, boundedCandidates, monitorId, validateConfig, defaultConfig, validateParams, validateResult, validateResponse,
  validateCandidate, validateOccurrence, validateNotice, validateNote, validateTarget, validateMonitor, historyCursor, localParts, inActiveHours, validTimezone };
