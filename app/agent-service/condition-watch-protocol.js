"use strict";

const crypto = require("node:crypto");
const { canonicalJson } = require("./tool-registry");
const { serviceError } = require("./security");
const { publicUrl } = require("./web-service");

const MIN_INTERVAL = 60_000;
const MAX_INTERVAL = 7 * 86_400_000;
const SOURCE_KINDS = ["public_json", "public_html", "feed", "directory", "log_file"];
const ACTIONS = ["notify", "agent_review"];
const COMPARISONS = { public_json: ["equals", "lt", "lte", "gt", "gte", "changed"],
  public_html: ["equals", "contains", "changed"], feed: ["new_item"], directory: ["new_entry"], log_file: ["new_line"] };
const MESSAGES = Object.freeze({
  WATCH_INVALID: "守望参数或条件无效", WATCH_UNAVAILABLE: "条件守望暂不可用",
  WATCH_NOT_FOUND: "找不到此条件守望", WATCH_CONFLICT: "守望已更新，请读取当前状态后再操作",
  WATCH_CAPACITY: "已达到守望数量或请求限额", WATCH_TEST_REQUIRED: "请先通过当前定义的试跑",
  WATCH_ACCESS_DENIED: "当前用户消息或工作区未授权此守望", WATCH_TARGET_INVALID: "原会话或原成员不可用",
  WATCH_SOURCE_INVALID: "来源内容无法解析为所需的值", WATCH_SOURCE_DENIED: "来源超出守望的读取范围",
  WATCH_TIMEOUT: "读取来源超时", WATCH_SOURCE_UNAVAILABLE: "暂时无法读取来源",
  WATCH_RATE_LIMITED: "来源或本机请求已限流", WATCH_CANCELED: "守望已暂停、变更或停止",
  WATCH_DELIVERY_UNAVAILABLE: "无法确认原会话的投递状态",
  WATCH_REVIEW_UNAVAILABLE: "当前助理的默认模型通道无法进行无工具复核",
  WATCH_REVIEW_LIMITED: "本守望或所属助理的复核次数已达上限",
  WATCH_REVIEW_INVALID: "模型复核结果无效或引用了其他证据",
  WATCH_REVIEW_USAGE_UNKNOWN: "模型复核的用量未能确认",
  WATCH_REVIEW_UNCERTAIN: "模型复核未能确认完成，需从该命中手动重试",
  WATCH_REVIEW_ROUTE_CHANGED: "模型复核期间助理的模型或通道已变化",
});

function fail(code = "WATCH_INVALID") { throw serviceError(code, MESSAGES[code]); }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function isObject(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, required, optional = []) {
  return isObject(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function validText(value, max) {
  return typeof value === "string" && value.isWellFormed() && value.trim().length > 0
    && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
const opaqueId = value => typeof value === "string" && /^[\w.:-]{1,256}$/u.test(value);
const isWatchId = value => typeof value === "string" && /^watch-[a-f0-9]{64}$/u.test(value);
const isEventId = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const at = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const revision = value => Number.isSafeInteger(value) && value > 0;
const scalar = value => typeof value === "boolean" || Number.isSafeInteger(value) || validText(value, 512);
const secretName = /token|secret|pass(?:word|wd)?|api[-_]?key|auth(?:orization)?|signature|credential|session|^sig$|^key$/iu;

function watchUrl(value) {
  if (!validText(value, 2048)) fail("WATCH_SOURCE_DENIED");
  let url;
  try { url = publicUrl(value); } catch { fail("WATCH_SOURCE_DENIED"); }
  if (url.protocol !== "https:" || url.port || !url.hostname.includes(".")
    || [...url.searchParams.keys()].some(key => secretName.test(key))) fail("WATCH_SOURCE_DENIED");
  return url;
}

const isLocalSource = source => ["directory", "log_file"].includes(source.kind);

function normalizeSource(source) {
  if (!isObject(source) || !SOURCE_KINDS.includes(source.kind)) fail();
  if (isLocalSource(source)) {
    if (!fields(source, ["kind", "path"]) || !validText(source.path, 1024)
      || (source.kind !== "directory" || source.path !== ".")
        && source.path.split("/").some(part => !part || part.startsWith(".") || /[\\:]/u.test(part))) fail();
    return { kind: source.kind, path: source.path };
  }
  const extra = source.kind === "public_json" ? ["path"] : source.kind === "public_html" ? ["elementId"] : [];
  if (!fields(source, ["kind", "url", ...extra])) fail();
  const result = { kind: source.kind, url: watchUrl(source.url).href };
  if (source.kind === "public_json") {
    if (!Array.isArray(source.path) || source.path.length > 16 || source.path.some(part =>
      !validText(part, 100) || ["__proto__", "constructor", "prototype"].includes(part))) fail();
    result.path = [...source.path];
  }
  if (source.kind === "public_html") {
    if (typeof source.elementId !== "string" || !/^[\w:.-]{1,128}$/u.test(source.elementId)) fail();
    result.elementId = source.elementId;
  }
  return result;
}

function normalizeDefinition(input) {
  if (!fields(input, ["name", "source", "predicate"],
    ["intervalMs", "confirmation", "notifyIfInitiallyMatched", "stopAfterDelivery", "deadlineAt", "action", "reviewInstruction"])
    || !validText(input.name, 160)) fail();
  const source = normalizeSource(input.source);
  const { predicate } = input;
  if (!isObject(predicate) || !COMPARISONS[source.kind].includes(predicate.op)) fail();
  const { op } = predicate;
  const numeric = ["lt", "lte", "gt", "gte"].includes(op);
  const additions = ["new_item", "new_entry", "new_line"].includes(op);
  const valueRequired = !additions && op !== "changed";
  const filterFields = op === "new_item" ? ["titleContains"] : op === "new_entry" ? ["prefix", "extension"] : numeric ? ["unit"] : [];
  const required = op === "new_line" ? ["contains"] : valueRequired ? ["value"] : [];
  if (!fields(predicate, ["op", ...required], filterFields)
    || valueRequired && !scalar(predicate.value)
    || op === "new_line" && !validText(predicate.contains, 128)
    || numeric && (!Number.isSafeInteger(predicate.value) || !validText(predicate.unit, 40))
    || source.kind === "public_html" && valueRequired && !validText(predicate.value, 512)
    || filterFields.some(key => Object.hasOwn(predicate, key) && !validText(predicate[key], 128))) fail();
  const intervalMs = input.intervalMs ?? (isLocalSource(source) ? MIN_INTERVAL : 5 * MIN_INTERVAL);
  const confirmation = input.confirmation ?? 1;
  const notifyIfInitiallyMatched = input.notifyIfInitiallyMatched ?? false;
  const stopAfterDelivery = input.stopAfterDelivery ?? false;
  const deadlineAt = input.deadlineAt ?? null;
  const action = input.action ?? "notify";
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL || intervalMs > MAX_INTERVAL
    || ![1, 2].includes(confirmation) || additions && confirmation !== 1
    || typeof notifyIfInitiallyMatched !== "boolean" || (additions || op === "changed") && notifyIfInitiallyMatched
    || typeof stopAfterDelivery !== "boolean" || deadlineAt !== null && !at(deadlineAt) || !ACTIONS.includes(action)
    || (action === "agent_review" ? isLocalSource(source) || !validText(input.reviewInstruction, 512)
      : Object.hasOwn(input, "reviewInstruction"))) fail();
  return { name: input.name.trim(), source, predicate: { ...predicate }, intervalMs, confirmation,
    notifyIfInitiallyMatched, stopAfterDelivery, deadlineAt, action,
    ...(action === "agent_review" ? { reviewInstruction: input.reviewInstruction } : {}) };
}

const METHODS = Object.freeze({
  "watch.capabilities": [], "watch.list": [], "watch.get": ["watchId"],
  "watch.create": ["operationId", "definition", "target"], "watch.update": ["operationId", "watchId", "expectedRevision", "definition"],
  "watch.test": ["watchId", "expectedRevision"], "watch.setEnabled": ["operationId", "watchId", "expectedRevision", "enabled"],
  "watch.checkNow": ["operationId", "watchId", "expectedRevision"],
  "watch.history": ["watchId"], "watch.delete": ["operationId", "watchId", "expectedRevision"],
  "watch.retryEvent": ["operationId", "watchId", "expectedRevision", "eventId"],
});
const optionalParams = { "watch.list": ["profileId", "agentId", "cursor", "limit"], "watch.history": ["cursor", "limit"] };

function validateParams(method, args) {
  if (!Object.hasOwn(METHODS, method) || !fields(args, METHODS[method], optionalParams[method] || [])) fail();
  if (Object.hasOwn(args, "watchId") && !isWatchId(args.watchId)
    || Object.hasOwn(args, "operationId") && !opaqueId(args.operationId)
    || Object.hasOwn(args, "expectedRevision") && !revision(args.expectedRevision)
    || Object.hasOwn(args, "eventId") && !isEventId(args.eventId)
    || Object.hasOwn(args, "enabled") && typeof args.enabled !== "boolean"
    || args.profileId != null && !opaqueId(args.profileId)
    || args.agentId != null && (!opaqueId(args.agentId) || args.profileId != null)
    || args.cursor != null && !(method === "watch.list" ? isWatchId(args.cursor) : revision(args.cursor))
    || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 15)) fail();
  if (method === "watch.create" && (!fields(args.target, ["sessionKey"]) || !opaqueId(args.target.sessionKey))) fail();
  return { ...args, ...(Object.hasOwn(args, "definition") ? { definition: normalizeDefinition(args.definition) } : {}) };
}

function validateWatch(watch) {
  if (!fields(watch, ["id", "profileId", "agentId", "definition", "state", "revision", "version", "nextDueAt", "reason", "target",
    "failure", "lastSuccessAt", "value", "preview"], ["reviewAvailable"])
    || !isWatchId(watch.id) || !opaqueId(watch.profileId) || watch.agentId !== null && !opaqueId(watch.agentId)
    || !revision(watch.revision) || !revision(watch.version)
    || !["draft", "enabled", "paused", "finishing", "completed", "blocked"].includes(watch.state)
    || watch.nextDueAt !== null && !at(watch.nextDueAt) || watch.lastSuccessAt !== null && !at(watch.lastSuccessAt)
    || watch.value !== null && !scalar(watch.value)
    || watch.reviewAvailable !== undefined && typeof watch.reviewAvailable !== "boolean") fail("WATCH_UNAVAILABLE");
  normalizeDefinition(watch.definition);
  const { target } = watch;
  const targetKey = target?.kind === "chat" ? "sessionKey" : "groupId";
  if (!fields(target, ["kind", "name", targetKey], ["unavailable"])
    || !["chat", "group"].includes(target.kind) || !opaqueId(target[targetKey])
    || target.name !== null && typeof target.name !== "string"
    || target.unavailable !== undefined && target.unavailable !== true) fail("WATCH_UNAVAILABLE");
  return watch;
}

function validateResult(method, result) {
  if (method === "watch.capabilities") {
    if (!fields(result, ["available", "sourceKinds", "minIntervalMs", "maxIntervalMs"], ["actions"]) || result.available !== true
      || !Array.isArray(result.sourceKinds) || result.sourceKinds.some(kind => !SOURCE_KINDS.includes(kind))
      || result.actions !== undefined && (!Array.isArray(result.actions) || result.actions.some(action => !ACTIONS.includes(action)))) fail("WATCH_UNAVAILABLE");
  } else if (method === "watch.list") {
    if (!fields(result, ["watches", "nextCursor"]) || !Array.isArray(result.watches) || result.watches.length > 15
      || result.nextCursor !== null && !isWatchId(result.nextCursor)) fail("WATCH_UNAVAILABLE");
    result.watches.forEach(validateWatch);
  } else if (method === "watch.history") {
    if (!fields(result, ["checks", "nextCursor"]) || !Array.isArray(result.checks) || result.checks.length > 15
      || result.nextCursor !== null && !revision(result.nextCursor)
      || result.checks.some(item => !isEventId(item?.id) || !isWatchId(item.watchId) || !at(item.startedAt)
        || item.finishedAt !== null && !at(item.finishedAt) || item.event !== null && !isEventId(item.event?.id))) fail("WATCH_UNAVAILABLE");
  } else if (method === "watch.delete") {
    if (!fields(result, ["watchId", "deleted"]) || !isWatchId(result.watchId) || result.deleted !== true) fail("WATCH_UNAVAILABLE");
  } else if (method === "watch.checkNow") {
    if (!fields(result, ["checkId"]) || !isEventId(result.checkId)) fail("WATCH_UNAVAILABLE");
  } else {
    if (!fields(result, ["watch"], ["watchId", "eventId"])) fail("WATCH_UNAVAILABLE");
    validateWatch(result.watch);
  }
  return result;
}

const toolMethods = Object.freeze({
  watch_create: "setup", watch_list: "watch.list", watch_get: "watch.get", watch_test: "watch.test",
  watch_set_enabled: "watch.setEnabled", watch_update: "watch.update", watch_check_now: "watch.checkNow",
  watch_history: "watch.history", watch_delete: "watch.delete", watch_retry_event: "watch.retryEvent",
});
const toolDescriptions = {
  watch_create: "Create, dry-run and enable a condition watch in this conversation. Supply the exact current user request as sourceQuote, a supported source and a machine-checkable predicate. For a log_file in a direct chat, use the workspace-relative path and new_line with a literal contains filter. Use action agent_review only for public sources and only when the user requests model review after a hit. Copy the user's review criteria verbatim from sourceQuote into reviewInstruction. The Service binds the origin and returns the real state. A failed preview leaves a draft.",
  watch_list: "List condition watches owned by this Agent in the current conversation. Follow nextCursor for more results.",
  watch_get: "Read one condition watch in the current conversation including its current revision.",
  watch_test: "Preview the saved condition without changing its live baseline or sending a notification.",
  watch_set_enabled: "Pause or resume a condition watch from a current user request. Enabling a draft requires a successful preview.",
  watch_update: "Save an edit to a condition watch. To change the review criteria, copy them verbatim from the current sourceQuote. Preview and enable the new revision if the source, condition, action or stopping rule changed.",
  watch_check_now: "Perform a real check for an enabled watch. A hit may publish to the original conversation.",
  watch_history: "Read checks, hits, model review outcomes and delivery receipts for a watch in the current conversation. Follow nextCursor for older checks.",
  watch_delete: "Delete a condition watch after the user explicitly asks to remove it.",
  watch_retry_event: "Retry the specified existing hit when the user requests it. A failed or unconfirmed model review can use another model call. A delivery retry reconciles the receipt in the original conversation.",
};
const readTools = new Set(["watch_list", "watch_get", "watch_history"]);
const schemaObject = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const string = maxLength => ({ type: "string", minLength: 1, maxLength });
const definitionSchema = schemaObject({
  name: string(160), intervalMs: { type: "integer", minimum: MIN_INTERVAL, maximum: MAX_INTERVAL },
  source: { oneOf: [
    schemaObject({ kind: { const: "public_json" }, url: string(2048), path: { type: "array", maxItems: 16, items: string(100) } }, ["kind", "url", "path"]),
    schemaObject({ kind: { const: "public_html" }, url: string(2048), elementId: string(128) }, ["kind", "url", "elementId"]),
    schemaObject({ kind: { const: "feed" }, url: string(2048) }, ["kind", "url"]),
    schemaObject({ kind: { const: "directory" }, path: string(1024) }, ["kind", "path"]),
    schemaObject({ kind: { const: "log_file" }, path: string(1024) }, ["kind", "path"]),
  ] },
  predicate: schemaObject({ op: { enum: [...new Set(Object.values(COMPARISONS).flat())] },
    value: { type: ["boolean", "integer", "string"] }, unit: string(40),
    titleContains: string(128), prefix: string(128), extension: string(128), contains: string(128) }, ["op"]),
  confirmation: { type: "integer", enum: [1, 2] }, notifyIfInitiallyMatched: { type: "boolean" },
  stopAfterDelivery: { type: "boolean" }, deadlineAt: { type: ["integer", "null"] }, action: { enum: ACTIONS }, reviewInstruction: string(512),
}, ["name", "source", "predicate"]);
const argumentSchema = {
  watchId: string(70), expectedRevision: { type: "integer", minimum: 1 }, definition: definitionSchema,
  sourceQuote: string(2048), enabled: { type: "boolean" }, eventId: string(64),
};
const toolPagination = Object.freeze({
  watch_list: { cursor: { type: ["string", "null"], pattern: "^watch-[a-f0-9]{64}$" } },
  watch_history: { cursor: { type: ["integer", "null"], minimum: 1 } },
});
const toolDefinitions = Object.entries(toolMethods).map(([name, method]) => {
  const keys = method === "setup" ? ["definition"] : METHODS[method].filter(key => key !== "operationId");
  if (!readTools.has(name)) keys.push("sourceQuote");
  const pagination = toolPagination[name];
  const properties = Object.fromEntries(keys.map(key => [key, argumentSchema[key]]));
  if (pagination) Object.assign(properties, pagination, { limit: { type: "integer", minimum: 1, maximum: 15 } });
  return { name, inputSchema: schemaObject(properties, keys) };
});
function toolArguments(name, args) {
  const spec = toolDefinitions.find(tool => tool.name === name);
  if (!spec || !fields(args, spec.inputSchema.required, Object.hasOwn(toolPagination, name) ? ["cursor", "limit"] : [])
    || args.sourceQuote !== undefined && !validText(args.sourceQuote, 2048)) fail();
  const { sourceQuote, ...input } = args;
  if (name === "watch_create") return { sourceQuote, definition: normalizeDefinition(input.definition) };
  const method = toolMethods[name];
  const params = validateParams(method, { ...input, ...(METHODS[method].includes("operationId") ? { operationId: "pending" } : {}) });
  delete params.operationId;
  return { ...params, ...(sourceQuote === undefined ? {} : { sourceQuote }) };
}

module.exports = { MIN_INTERVAL, MAX_INTERVAL, SOURCE_KINDS, ACTIONS, MESSAGES, METHODS, digest, fail, fields, validText, isLocalSource,
  isWatchId, isEventId, at, scalar, watchUrl, normalizeDefinition, validateParams, validateResult, toolMethods, toolDescriptions,
  toolDefinitions, toolArguments, readTools };
