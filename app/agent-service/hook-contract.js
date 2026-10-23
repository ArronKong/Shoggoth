"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");
const HOOK_SCHEMA_VERSION = 1;
const HOOK_LIMITS = Object.freeze({ perProfile: 64, total: 1024, perEvent: 16, scriptBytes: 262144,
  inputBytes: 32768, outputBytes: 8192, stderrBytes: 4096, contextBytes: 4096, contextRunBytes: 16384,
  decisionMs: 2000, maxDecisionMs: 10000, eventMs: 15000, actionMs: 10000, maxActionMs: 60000,
  observeMs: 2000, workers: 4, queue: 1024, depth: 2, testMs: 5000, retentionMs: 30 * 86400000, pageSize: 50,
  storeBytes: 268435456, scriptStoreBytes: 67108864, scriptPackages: 4096 });
const HOOK_EVENTS = Object.freeze({
  "session.created": ["observe"], "session.closed": ["observe"], "run.before": ["guard", "observe"],
  "context.prepare": ["transform"], "run.started": ["observe"], "tool.before": ["transform", "guard"],
  "tool.after": ["observe", "action"], "tool.result.transform": ["transform"],
  "approval.requested": ["observe"], "approval.resolved": ["observe"],
  "context.checkpoint.before": ["observe"], "context.checkpoint.after": ["observe"],
  "run.completed": ["observe"], "run.failed": ["observe"], "run.canceled": ["observe"],
  "run.interrupted": ["observe"], "run.skipped": ["observe"],
  "model.request.before": ["observe"], "model.request.after": ["observe"],
  "context.native_compacted": ["observe"], "subagent.started": ["observe"], "subagent.finished": ["observe"],
});
const HOOK_PUBLIC_ERROR_CODES = Object.freeze([
  "HOOK_ACTION_FAILED", "HOOK_APPROVAL_DENIED", "HOOK_APPROVAL_REQUIRED", "HOOK_APPROVAL_UNAVAILABLE",
  "HOOK_ARGUMENTS_INVALID", "HOOK_AUTHORITY_INVALID", "HOOK_BLOCKED", "HOOK_CANCELED",
  "HOOK_CAPACITY", "HOOK_CLEANUP_UNVERIFIED", "HOOK_COMPATIBILITY_UNSUPPORTED", "HOOK_EVENT_UNSUPPORTED",
  "HOOK_EXECUTION_CONFLICT", "HOOK_EXECUTION_FAILED", "HOOK_EXECUTION_INTERRUPTED", "HOOK_FORBIDDEN",
  "HOOK_GRANT_REQUIRED", "HOOK_HANDLER_UNAVAILABLE", "HOOK_INVALID", "HOOK_NATIVE_CALL_CONFLICT",
  "HOOK_NEEDS_VERIFICATION", "HOOK_NOT_FOUND", "HOOK_OBSERVER_FAILED", "HOOK_OPERATION_CONFLICT",
  "HOOK_OUTPUT_CAPACITY", "HOOK_OUTPUT_INVALID", "HOOK_PLUGIN_CONNECTION_REQUIRED", "HOOK_PLUGIN_OBSERVER_UNAVAILABLE",
  "HOOK_PLUGIN_UNAVAILABLE", "HOOK_RESULT_FACT_CHANGED", "HOOK_RESULT_TRANSFORM_FAILED", "HOOK_REVISION_CONFLICT",
  "HOOK_REVOKED", "HOOK_RUNTIME_CHANGED", "HOOK_RUNTIME_UNSUPPORTED", "HOOK_SANDBOX_UNAVAILABLE",
  "HOOK_SNAPSHOT_CONFLICT", "HOOK_SNAPSHOT_REQUIRED", "HOOK_SOURCE_CHANGED", "HOOK_STORE_CORRUPT",
  "HOOK_TEST_FAILED", "HOOK_TEST_REQUIRED", "HOOK_TIMEOUT", "HOOK_TOOL_CONTRACT_INVALID",
  "HOOK_TOOL_CONTRACT_UNAVAILABLE", "HOOK_TOOL_UNAVAILABLE", "HOOK_UNAVAILABLE", "HOOK_WORKER_FAILED",
  "HOOK_WORKER_UNAVAILABLE", "HOOK_WORKSPACE_BUSY", "HOOK_WORKSPACE_FORBIDDEN", "HOOK_WORKSPACE_INVALID",
  "HOOK_WORKSPACE_REQUIRED", "HOOK_WRITE_FORBIDDEN",
]);
const HOOK_SOURCES = Object.freeze(["chat", "cron", "kanban", "inspiration"]);
const HOOK_TOOL_SCOPES = Object.freeze(["product", "native_mcp", "plugin_mcp", "runtime_builtin", "runtime_mcp"]);
const BUILTINS = Object.freeze({
  "guard.block": ["guard"], "guard.require_approval": ["guard"], "guard.condition": ["guard"],
  "arguments.patch": ["transform"], "result.redact": ["transform"],
  "context.literal": ["transform"], "context.file": ["transform"],
  "observe.record": ["observe"], "workspace.copy": ["action"],
});
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const AUTHORITY_KEYS = new Set(["profileId", "runId", "operationId", "source", "sourceId", "bindingId",
  "runtimeAccountId", "runtimeProfileId", "sessionToken", "confirmation", "skipHooks", "serverId", "toolName"]);
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const text = (value, bytes, empty = false) => typeof value === "string" && value.isWellFormed()
  && !value.includes("\0") && (empty || value.length > 0) && Buffer.byteLength(value) <= bytes;
const object = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
function fail(code = "HOOK_INVALID", message = "Hook 参数或执行结果无效") { throw serviceError(code, message); }
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
function safeJson(value, maxBytes = HOOK_LIMITS.inputBytes) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 24) fail("HOOK_CAPACITY");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); return; }
    if (typeof item === "string") { if (!text(item, maxBytes, true)) fail(); return; }
    if (!Array.isArray(item) && !object(item)) fail();
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), "value")) fail();
      visit(item[key], depth + 1);
    }
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) fail("HOOK_CAPACITY");
  return JSON.parse(encoded);
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function relativePath(value) {
  if (!text(value, 1024) || path.isAbsolute(value) || value.includes("\\")
    || value.split("/").some(part => !part || part === "." || part === "..")) fail();
  return value;
}
function dataPath(value) {
  if (!text(value, 256) || value.split(".").some(part => FORBIDDEN_KEYS.has(part)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(part))) fail();
  return value;
}
function validateBuiltin(name, config, event) {
  if (!object(config)) fail();
  if (name === "guard.block" || name === "guard.require_approval") {
    keys(config, ["reason"]); if (!text(config.reason, 1024)) fail();
  } else if (name === "guard.condition") {
    keys(config, ["conditions", "decision", "reason"], ["mode", "missing"]);
    if (!Array.isArray(config.conditions) || !config.conditions.length || config.conditions.length > 16
      || !["block", "require_approval"].includes(config.decision) || !text(config.reason, 1024)
      || config.mode !== undefined && !["all", "any"].includes(config.mode)
      || config.missing !== undefined && !["block", "ignore"].includes(config.missing)) fail();
    for (const condition of config.conditions) {
      keys(condition, ["path", "op"], ["value"]); dataPath(condition.path);
      if (!["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in", "exists"].includes(condition.op)
        || condition.op !== "exists" && !Object.hasOwn(condition, "value")
        || condition.op === "in" && (!Array.isArray(condition.value) || condition.value.length > 32)) fail();
    }
    if (event === "run.before" && config.decision === "require_approval") fail();
  } else if (name === "arguments.patch") {
    keys(config, ["patch"]); if (!object(config.patch) || Object.keys(config.patch).some(key => AUTHORITY_KEYS.has(key))) fail();
    if (event !== "tool.before") fail();
  } else if (name === "result.redact") {
    keys(config, ["patterns"], ["replacement"]);
    if (event !== "tool.result.transform" || !Array.isArray(config.patterns) || !config.patterns.length
      || config.patterns.length > 3 || config.patterns.some(item => !["phone", "card", "email"].includes(item))
      || config.replacement !== undefined && !text(config.replacement, 64)) fail();
  } else if (name === "context.literal" || name === "context.file") {
    if (event !== "context.prepare") fail();
    if (name === "context.literal") { keys(config, ["text"]); if (!text(config.text, HOOK_LIMITS.contextBytes)) fail(); }
    else { keys(config, ["relativePath"]); relativePath(config.relativePath); }
  } else if (name === "observe.record") {
    keys(config, [], ["tags"]); if (config.tags !== undefined
      && (!Array.isArray(config.tags) || config.tags.length > 8 || config.tags.some(tag => !text(tag, 64)))) fail();
  } else if (name === "workspace.copy") {
    keys(config, ["from", "to"]); relativePath(config.from); relativePath(config.to);
  } else fail();
  if (name === "guard.require_approval" && event !== "tool.before") fail();
}
function validateDefinition(input, workspace) {
  const value = safeJson(input, HOOK_LIMITS.scriptBytes + HOOK_LIMITS.inputBytes);
  keys(value, ["schemaVersion", "name", "event", "kind", "scope", "matcher", "handler"],
    ["priority", "required", "timeoutMs", "failurePolicy"]);
  if (value.schemaVersion !== 1 || !text(value.name, 128) || !HOOK_EVENTS[value.event]?.includes(value.kind)) fail();
  keys(value.scope, ["workspace", "sources"]);
  if (!["current", "profile"].includes(value.scope.workspace)
    || !Array.isArray(value.scope.sources) || !value.scope.sources.length
    || value.scope.sources.length > 4 || new Set(value.scope.sources).size !== value.scope.sources.length
    || value.scope.sources.some(source => !HOOK_SOURCES.includes(source))) fail();
  keys(value.matcher, [], ["toolScopes", "toolNames", "serverId", "componentId"]);
  if (value.event.startsWith("tool.")) {
    if (!Array.isArray(value.matcher.toolScopes) || !value.matcher.toolScopes.length
      || value.matcher.toolScopes.length > 5 || value.matcher.toolScopes.some(scope => !HOOK_TOOL_SCOPES.includes(scope))
      || !Array.isArray(value.matcher.toolNames) || !value.matcher.toolNames.length || value.matcher.toolNames.length > 32
      || value.matcher.toolNames.some(name => !text(name, 128) || !/^[A-Za-z0-9_.*:/-]+$/u.test(name) || (name.match(/\*/gu) || []).length > 4)) fail();
  } else if (Object.keys(value.matcher).length) fail();
  for (const field of ["serverId", "componentId"]) if (value.matcher[field] !== undefined && !id(value.matcher[field])) fail();
  if (value.handler.type === "builtin") {
    keys(value.handler, ["type", "name", "config"]);
    if (!BUILTINS[value.handler.name]?.includes(value.kind)) fail();
    validateBuiltin(value.handler.name, value.handler.config, value.event);
  } else if (value.handler.type === "script") {
    keys(value.handler, ["type", "language", "source"], ["access", "compatibility"]);
    if (!["javascript", "python"].includes(value.handler.language) || !text(value.handler.source, HOOK_LIMITS.scriptBytes)) fail();
    if (value.handler.compatibility !== undefined && (!["claude-code-pretooluse-v1", "cursor-tool-permission-v1"].includes(value.handler.compatibility)
      || value.kind !== "guard" || value.event !== "tool.before")) fail("HOOK_COMPATIBILITY_UNSUPPORTED");
    if (value.handler.access !== undefined) {
      keys(value.handler.access, [], ["workspaceRead"]);
      if (value.handler.access.workspaceRead !== undefined && typeof value.handler.access.workspaceRead !== "boolean") fail();
      if (value.handler.access.workspaceRead === true && value.scope.workspace !== "current") fail();
    }
  } else fail();
  const maxMs = value.kind === "action" ? HOOK_LIMITS.maxActionMs : HOOK_LIMITS.maxDecisionMs;
  const timeoutMs = value.timeoutMs ?? (value.kind === "action" ? HOOK_LIMITS.actionMs : value.kind === "observe" ? HOOK_LIMITS.observeMs : HOOK_LIMITS.decisionMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxMs
    || value.priority !== undefined && (!Number.isInteger(value.priority) || Math.abs(value.priority) > 10000)
    || value.required !== undefined && typeof value.required !== "boolean"
    || value.failurePolicy !== undefined && !["block", "continue"].includes(value.failurePolicy)
    || value.kind !== "observe" && (value.required === false || value.failurePolicy === "continue")) fail();
  if (value.kind === "action" && value.scope.workspace !== "current") fail();
  if (value.handler.type === "builtin" && value.handler.name === "context.file" && value.scope.workspace !== "current") fail();
  if (value.scope.workspace === "current" && (typeof workspace !== "string" || !path.isAbsolute(workspace))) fail("HOOK_WORKSPACE_REQUIRED");
  return { ...value, scope: { ...value.scope, workspace: value.scope.workspace === "current" ? path.resolve(workspace) : null },
    priority: value.priority ?? 0, required: value.kind !== "observe" || value.required === true,
    timeoutMs, failurePolicy: value.kind === "observe" ? value.failurePolicy ?? "continue" : "block" };
}
function validateOutput(definition, output) {
  const value = safeJson(output, HOOK_LIMITS.outputBytes);
  if (definition.kind === "guard") {
    keys(value, ["decision"], ["reason"]);
    if (!["allow", "block", "require_approval"].includes(value.decision)
      || value.decision === "require_approval" && definition.event !== "tool.before"
      || value.reason !== undefined && !text(value.reason, 1024)) fail("HOOK_OUTPUT_INVALID");
  } else if (definition.kind === "transform") {
    if (definition.event === "tool.before") {
      keys(value, ["patch"]); if (!object(value.patch) || Object.keys(value.patch).some(key => AUTHORITY_KEYS.has(key))) fail("HOOK_OUTPUT_INVALID");
    } else if (definition.event === "context.prepare") {
      keys(value, ["text"]); if (!text(value.text, HOOK_LIMITS.contextBytes, true)) fail("HOOK_OUTPUT_INVALID");
    } else keys(value, ["result"]);
  } else if (definition.kind === "action") {
    keys(value, ["status", "sideEffect"], ["artifacts"]);
    if (!["completed", "failed"].includes(value.status) || !["none", "known", "unknown"].includes(value.sideEffect)
      || value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.length > 16)) fail("HOOK_OUTPUT_INVALID");
    for (const artifact of value.artifacts || []) relativePath(artifact);
  } else if (!object(value)) fail("HOOK_OUTPUT_INVALID");
  return value;
}
function glob(pattern, value) {
  if (typeof value !== "string") return false;
  return new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^\x24{}()|[\]\\]/gu, "\\$&")).join(".*") + "$", "u").test(value);
}
function matches(definition, event) {
  if (definition.event !== event.event || !definition.scope.sources.includes(event.source)
    || definition.scope.workspace !== null && definition.scope.workspace !== event.workspace) return false;
  const matcher = definition.matcher;
  if (!event.event.startsWith("tool.")) return true;
  return matcher.toolScopes.includes(event.tool?.scope)
    && matcher.toolNames.some(name => glob(name, event.tool?.name))
    && (matcher.serverId === undefined || matcher.serverId === event.tool?.serverId)
    && (matcher.componentId === undefined || matcher.componentId === event.tool?.componentId);
}
function dataAccess(definition) {
  const name = definition.handler.name;
  return { payload: definition.handler.type === "script" || ["guard.condition", "arguments.patch", "result.redact"].includes(name),
    workspaceRead: ["context.file", "workspace.copy"].includes(name) || definition.kind === "action"
      || definition.handler.access?.workspaceRead === true, workspaceWrite: definition.kind === "action" };
}
module.exports = { HOOK_PUBLIC_ERROR_CODES, HOOK_SCHEMA_VERSION, HOOK_LIMITS, HOOK_EVENTS, HOOK_SOURCES, HOOK_TOOL_SCOPES,
  BUILTINS, AUTHORITY_KEYS, id, text, object, keys, fail, safeJson, canonical, digest, relativePath,
  dataPath, validateDefinition, validateOutput, glob, matches, dataAccess };
