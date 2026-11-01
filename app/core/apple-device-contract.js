"use strict";

// Shared by the desktop host and Service. These validators return a detached JSON
// value or throw TypeError; they never coerce untrusted tool input.
const APPLE_DEVICE_METHODS = Object.freeze([
  "connector.apple.status", "connector.apple.connect", "connector.apple.policy.set", "connector.apple.settings.open",
]);
const APPLE_DEVICE_RESOURCES = Object.freeze(["calendar", "reminders"]);
const AUTHORIZATIONS = Object.freeze(["notDetermined", "fullAccess", "writeOnly", "denied", "restricted", "unavailable"]);
const READ_POLICIES = Object.freeze(["allow", "ask", "deny"]);
const WRITE_POLICIES = READ_POLICIES;
const MAX_RESPONSE_BYTES = 60 * 1024;
const MAX_INPUT_BYTES = 32 * 1024;
const APPLE_DEVICE_PUBLIC_MESSAGES = Object.freeze({
  APPLE_DEVICE_ACCESS_DENIED: "此助理未获准访问该设备应用。",
  APPLE_DEVICE_ACCESS_REVOKED: "设备访问设置已更改，请重新发起操作。",
  APPLE_DEVICE_CONNECTION_REQUIRED: "请先在连接器的“你的设备”中连接此应用。",
  APPLE_DEVICE_AUTHORIZATION_DENIED: "系统未授予此应用所需的访问权限。",
  APPLE_DEVICE_PERMISSION_REQUIRED: "请先在连接器的“你的设备”中授予系统访问权限。",
  APPLE_DEVICE_HOST_UNAVAILABLE: "此 Mac 的设备连接暂不可用。",
  APPLE_DEVICE_UNAVAILABLE: "设备连接暂不可用。",
  APPLE_DEVICE_BUSY: "此 Mac 正在处理另一项设备操作，请等待其完成后重试。",
  APPLE_DEVICE_INVALID_HOST_RESULT: "设备返回的数据格式无效。",
  APPLE_DEVICE_INVALID_ARGUMENT: "设备操作参数无效。",
  APPLE_DEVICE_APPROVAL_REQUIRED: "此设备操作需要单独批准。",
  APPLE_DEVICE_APPROVAL_DENIED: "用户拒绝了本次设备操作。",
  APPLE_DEVICE_APPROVAL_EXPIRED: "本次设备审批已过期。",
  APPLE_DEVICE_APPROVAL_INVALID: "本次设备审批已失效。",
  APPLE_DEVICE_APPROVAL_UNAVAILABLE: "设备审批暂不可用。",
  APPLE_DEVICE_CANCELLED: "设备操作已取消。",
  APPLE_DEVICE_CANCELED: "设备操作已取消。",
  APPLE_DEVICE_IDENTITY_REQUIRED: "无法确认本次设备调用的助理和会话。",
  APPLE_DEVICE_REVISION_CONFLICT: "设备连接设置已更改，请刷新后重试。",
  APPLE_DEVICE_PROFILE_INVALID: "无法确认所选助理。",
  APPLE_DEVICE_SUBJECTS_UNAVAILABLE: "暂时无法读取助理列表。",
  APPLE_DEVICE_POLICY_CORRUPT: "设备权限配置无效，已停止访问。",
  APPLE_DEVICE_POLICY_WRITE_FAILED: "设备权限配置未能安全保存。",
  APPLE_DEVICE_LEDGER_CORRUPT: "设备操作记录无效，已停止写入。",
  APPLE_DEVICE_LEDGER_WRITE_FAILED: "设备操作记录未能安全保存。",
  APPLE_DEVICE_LEDGER_FULL: "设备操作记录已达容量上限。",
  APPLE_DEVICE_WRITE_UNCERTAIN: "上次设备写入结果尚未确认，请先读取核对，不能自动重试。",
  APPLE_DEVICE_CALL_CONFLICT: "同一次设备调用的参数不一致。",
  APPLE_DEVICE_TOOL_INVALID: "设备工具不存在。",
  APPLE_DEVICE_METHOD_INVALID: "设备管理操作不存在。",
  APPLE_DEVICE_NOT_FOUND: "所选日程或提醒事项已不存在。",
  APPLE_DEVICE_CONFLICT: "所选项目已更改，请重新读取并批准新的操作。",
  APPLE_DEVICE_READ_ONLY: "所选日历或清单不允许修改。",
  APPLE_DEVICE_TIMEOUT: "设备操作超时，请先读取核对本次写入结果。",
  APPLE_DEVICE_FAILED: "设备操作失败，请先读取核对本次写入结果。",
});
const OPAQUE = { type: "string", minLength: 1, maxLength: 4096 };
const TITLE = { type: "string", minLength: 1, maxLength: 512 };
const NOTES = { type: "string", maxLength: 8192 };
const ISO = { type: "string", maxLength: 64, format: "date-time" };
const REVISION = { type: "string", pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 };
const IDS = { type: "array", minItems: 0, maxItems: 32, uniqueItems: true, items: OPAQUE };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const eventFields = {
  title: TITLE, start: ISO, end: ISO, allDay: { type: "boolean" }, timeZone: { type: "string", minLength: 1, maxLength: 256 },
  notes: NOTES, location: { type: "string", maxLength: 2048 }, calendarId: OPAQUE,
};
const reminderFields = {
  title: TITLE, notes: NOTES, due: { anyOf: [ISO, { type: "null" }] }, priority: { type: "integer", minimum: 0, maximum: 9 }, listId: OPAQUE,
};
const TOOL_OPERATIONS = Object.freeze({
  apple_calendar_list: "calendar.list", apple_calendar_events: "calendar.events", apple_calendar_get: "calendar.get",
  apple_calendar_create: "calendar.create", apple_calendar_update: "calendar.update", apple_calendar_delete: "calendar.delete",
  apple_reminders_lists: "reminders.lists", apple_reminders_search: "reminders.search", apple_reminders_get: "reminders.get",
  apple_reminders_create: "reminders.create", apple_reminders_update: "reminders.update", apple_reminders_delete: "reminders.delete",
});
const OPERATION_SCHEMAS = Object.freeze({
  status: object({}), requestAccess: object({ resource: { type: "string", enum: APPLE_DEVICE_RESOURCES } }),
  "settings.open": object({ resource: { type: "string", enum: APPLE_DEVICE_RESOURCES } }),
  "calendar.list": object({}),
  "calendar.events": object({ start: ISO, end: ISO, calendarIds: IDS, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["start", "end"]),
  "calendar.get": object({ id: OPAQUE }),
  "calendar.create": object(eventFields, ["title", "start", "end"]),
  "calendar.update": object({ id: OPAQUE, expectedRevision: REVISION, scope: { type: "string", enum: ["this", "future"] }, patch: { ...object(eventFields, []), minProperties: 1 } }),
  "calendar.delete": object({ id: OPAQUE, expectedRevision: REVISION, scope: { type: "string", enum: ["this", "future"] } }),
  "reminders.lists": object({}),
  "reminders.search": object({ listIds: IDS, completed: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, []),
  "reminders.get": object({ id: OPAQUE }),
  "reminders.create": object(reminderFields, ["title"]),
  "reminders.update": object({ id: OPAQUE, expectedRevision: REVISION, patch: { ...object({ ...reminderFields, completed: { type: "boolean" } }, []), minProperties: 1 } }),
  "reminders.delete": object({ id: OPAQUE, expectedRevision: REVISION }),
});
const TOOL_INPUT_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries(TOOL_OPERATIONS).map(([name, operation]) => [name, OPERATION_SCHEMAS[operation]])));
const isPlain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, max = 4096, min = 0) => typeof value === "string" && value.isWellFormed() && !value.includes("\0")
  && Buffer.byteLength(value) <= max && value.length >= min && (min === 0 || value.trim().length > 0);
const id = value => text(value, 4096, 1);
const exact = (value, required, optional = []) => isPlain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const revision = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function invalid() { throw new TypeError("invalid Apple device contract"); }
function json(value, max = MAX_INPUT_BYTES) {
  let count = 0;
  const active = new Set();
  function visit(v, depth) {
    if (++count > 20000 || depth > 16) invalid();
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v === "string") { if (!text(v, max)) invalid(); return; }
    if ((!isPlain(v) && !Array.isArray(v)) || active.has(v)) invalid();
    if (Array.isArray(v) && (v.length > 4096 || Object.keys(v).length !== v.length)) invalid();
    active.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key) || !d.enumerable || !Object.hasOwn(d, "value")) invalid();
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > max) invalid();
  return JSON.parse(raw);
}
function iso(value) {
  if (!text(value, 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // Reject dates silently normalized by Date.parse (for example February 30).
  const date = value.slice(0, 10), day = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === date
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
    && (value.endsWith("Z") || Number(value.slice(-5, -3)) < 24 && Number(value.slice(-2)) < 60);
}
function matches(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => matches(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === "string") return text(value, schema.maxLength, schema.minLength)
    && (!schema.pattern || new RegExp(schema.pattern, "u").test(value)) && (schema.format !== "date-time" || iso(value));
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems || 0) && value.length <= schema.maxItems
    && (!schema.uniqueItems || new Set(value).size === value.length) && value.every(v => matches(v, schema.items));
  return exact(value, schema.required, Object.keys(schema.properties)) && Object.keys(value).length >= (schema.minProperties || 0)
    && Object.entries(value).every(([key, v]) => matches(v, schema.properties[key]));
}
const isWriteOperation = operation => /^(?:calendar|reminders)\.(?:create|update|delete)$/u.test(operation);
function validateAppleDeviceOperationParams(operation, value) {
  const result = json(value);
  if (!Object.hasOwn(OPERATION_SCHEMAS, operation) || !matches(result, OPERATION_SCHEMAS[operation])) invalid();
  const dates = operation === "calendar.update" ? result.patch : result;
  if (dates.start && dates.end && Date.parse(dates.end) <= Date.parse(dates.start)) invalid();
  if (operation === "calendar.events" && Date.parse(result.end) - Date.parse(result.start) > 366 * 86400000) invalid();
  return result;
}
function validateAppleDeviceInvokeParams(value) {
  const result = json(value);
  if (!exact(result, ["operation", "params", "operationId"]) || typeof result.operation !== "string") invalid();
  result.params = validateAppleDeviceOperationParams(result.operation, result.params);
  if (isWriteOperation(result.operation) ? !/^apple-write-[a-f0-9]{64}$/u.test(result.operationId || "") : result.operationId !== null) invalid();
  return result;
}
function profileIds(value) { return Array.isArray(value) && value.length <= 1024 && new Set(value).size === value.length && value.every(v => text(v, 256, 1)); }
function policy(value) { return exact(value, ["enabled", "readPolicy", "writePolicy", "disabledProfileIds"]) && typeof value.enabled === "boolean"
  && READ_POLICIES.includes(value.readPolicy) && WRITE_POLICIES.includes(value.writePolicy) && profileIds(value.disabledProfileIds); }
function validateAppleDevicePolicyState(value) {
  const result = json(value, 1024 * 1024);
  if (!exact(result, ["schemaVersion", "revision", "resources"]) || ![1, 2].includes(result.schemaVersion)
    || !revision(result.revision) || !exact(result.resources, APPLE_DEVICE_RESOURCES)) invalid();
  for (const resource of APPLE_DEVICE_RESOURCES) {
    const stored = result.resources[resource];
    if (!exact(stored, ["enabled", "readPolicy", ...(result.schemaVersion === 2 ? ["writePolicy"] : []), "disabledProfileIds"])) invalid();
    const next = { ...stored, writePolicy: result.schemaVersion === 1 ? "ask" : stored.writePolicy };
    validateAppleDeviceParams("connector.apple.policy.set", { resource, ...next, expectedRevision: result.revision });
    result.resources[resource] = next;
  }
  result.schemaVersion = 2;
  return result;
}
function hostStatus(value, withPolicy = false) {
  const keys = withPolicy ? ["revision", "available", "errorCode", "resources"] : ["available", "errorCode", "resources"];
  return exact(value, keys) && (!withPolicy || revision(value.revision)) && typeof value.available === "boolean"
    && (value.errorCode === null || typeof value.errorCode === "string" && /^APPLE_DEVICE_[A-Z0-9_]{1,80}$/u.test(value.errorCode))
    && Array.isArray(value.resources) && value.resources.length === 2 && new Set(value.resources.map(v => v.id)).size === 2
    && value.resources.every(v => exact(v, ["id", "authorization", ...(withPolicy ? ["enabled", "readPolicy", "writePolicy", "disabledProfileIds"] : [])])
      && APPLE_DEVICE_RESOURCES.includes(v.id) && AUTHORIZATIONS.includes(v.authorization) && (!withPolicy || policy({ enabled: v.enabled, readPolicy: v.readPolicy, writePolicy: v.writePolicy, disabledProfileIds: v.disabledProfileIds })));
}
function calendar(value) { return exact(value, ["id", "title", "allowsModifications", "isDefault"]) && id(value.id) && text(value.title, 512) && typeof value.allowsModifications === "boolean" && typeof value.isDefault === "boolean"; }
const nullableText = (value, max) => value === null || text(value, max);
function event(value) { return exact(value, ["id", "calendarId", "title", "start", "end", "allDay", "timeZone", "notes", "location", "recurring", "revision"])
  && id(value.id) && id(value.calendarId) && text(value.title, 512) && iso(value.start) && iso(value.end) && Date.parse(value.end) > Date.parse(value.start)
  && typeof value.allDay === "boolean" && nullableText(value.timeZone, 256) && nullableText(value.notes, 8192) && nullableText(value.location, 2048) && typeof value.recurring === "boolean" && sha(value.revision); }
function reminder(value) { return exact(value, ["id", "listId", "title", "notes", "due", "priority", "completed", "revision"])
  && id(value.id) && id(value.listId) && text(value.title, 512) && nullableText(value.notes, 8192) && (value.due === null || iso(value.due))
  && Number.isSafeInteger(value.priority) && value.priority >= 0 && value.priority <= 9 && typeof value.completed === "boolean" && sha(value.revision); }
function validateAppleDeviceInvokeResult(operation, value) {
  const result = json(value, MAX_RESPONSE_BYTES);
  let valid = false;
  if (["status", "requestAccess"].includes(operation)) valid = hostStatus(result);
  else if (operation === "settings.open") valid = exact(result, ["opened"]) && typeof result.opened === "boolean";
  else if (["calendar.list", "reminders.lists"].includes(operation)) {
    const key = operation === "calendar.list" ? "calendars" : "lists";
    valid = exact(result, [key]) && Array.isArray(result[key]) && result[key].length <= 100 && result[key].every(calendar);
  } else if (["calendar.events", "reminders.search"].includes(operation)) {
    const key = operation === "calendar.events" ? "events" : "reminders";
    valid = exact(result, [key, "truncated"]) && typeof result.truncated === "boolean" && Array.isArray(result[key]) && result[key].length <= 100 && result[key].every(key === "events" ? event : reminder);
  } else if (operation.endsWith(".delete") && isWriteOperation(operation)) valid = exact(result, ["id", "deleted"]) && id(result.id) && result.deleted === true;
  else if (/^(calendar|reminders)\.(get|create|update)$/u.test(operation)) {
    const key = operation.startsWith("calendar.") ? "event" : "reminder";
    valid = exact(result, [key]) && (key === "event" ? event(result[key]) : reminder(result[key]));
  }
  if (!valid) invalid();
  return result;
}
// Mutation results are receipts, not reads. Native DTOs remain full internally
// for validation/revision checks, but write permission cannot reveal old fields
// when reading is denied or separately requires an approval.
function validateAppleDeviceWriteReceipt(operation, value) {
  const result = json(value, MAX_RESPONSE_BYTES);
  if (!isWriteOperation(operation)) invalid();
  if (operation.endsWith(".delete")) {
    if (!exact(result, ["id", "deleted"]) || !id(result.id) || result.deleted !== true) invalid();
  } else {
    const key = operation.startsWith("calendar.") ? "event" : "reminder";
    if (!exact(result, [key]) || !exact(result[key], ["id", "revision"]) || !id(result[key].id) || !sha(result[key].revision)) invalid();
  }
  return result;
}
function validateAppleDeviceParams(method, value) {
  const result = json(value); let valid = false;
  if (method === "connector.apple.status") valid = exact(result, []);
  else if (method === "connector.apple.connect") valid = exact(result, ["resource", "expectedRevision"]) && APPLE_DEVICE_RESOURCES.includes(result.resource) && revision(result.expectedRevision);
  else if (method === "connector.apple.policy.set") valid = exact(result, ["resource", "enabled", "readPolicy", "writePolicy", "disabledProfileIds", "expectedRevision"])
    && APPLE_DEVICE_RESOURCES.includes(result.resource) && revision(result.expectedRevision) && policy({ enabled: result.enabled, readPolicy: result.readPolicy, writePolicy: result.writePolicy, disabledProfileIds: result.disabledProfileIds });
  else if (method === "connector.apple.settings.open") valid = exact(result, ["resource"]) && APPLE_DEVICE_RESOURCES.includes(result.resource);
  if (!valid) invalid(); return result;
}
function validateAppleDeviceResult(method, value) {
  const result = json(value, MAX_RESPONSE_BYTES);
  if (method === "connector.apple.settings.open") { if (!exact(result, ["opened"]) || typeof result.opened !== "boolean") invalid(); }
  else if (!APPLE_DEVICE_METHODS.includes(method) || !hostStatus(result, true)) invalid();
  return result;
}
module.exports = { APPLE_DEVICE_METHODS, APPLE_DEVICE_RESOURCES, APPLE_DEVICE_PUBLIC_MESSAGES, AUTHORIZATIONS, READ_POLICIES, WRITE_POLICIES, MAX_RESPONSE_BYTES,
  TOOL_OPERATIONS, TOOL_INPUT_SCHEMAS, OPERATION_SCHEMAS, isWriteOperation, validateAppleDeviceParams, validateAppleDeviceResult,
  validateAppleDevicePolicyState, validateAppleDeviceOperationParams, validateAppleDeviceInvokeParams, validateAppleDeviceInvokeResult, validateAppleDeviceWriteReceipt };
