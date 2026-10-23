"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const METHODS = Object.freeze(["memory.provider.owner.context", "memory.provider.owner.apply", "memory.provider.owner.recover"]);
const PUBLIC_MESSAGES = Object.freeze({
  MEMORY_OWNER_INVALID: "记忆账号设置无效", MEMORY_OWNER_CONFLICT: "记忆账号已更新，请刷新后重试",
  MEMORY_OWNER_FORBIDDEN: "当前请求不能管理此记忆账号", MEMORY_OWNER_RETIRED: "记忆账号目录已关闭",
  MEMORY_OWNER_CAPACITY: "记忆账号目录已满", MEMORY_OWNER_RECOVERY_REQUIRED: "记忆账号事务需要核验或恢复",
  MEMORY_OWNER_UNCERTAIN: "记忆账号写入结果尚未确认", MEMORY_OWNER_CLEANUP_PENDING: "旧凭据等待安全清理",
  MEMORY_OWNER_STORAGE_CHANGED: "记忆账号目录在事务期间发生变化", MEMORY_OWNER_STORAGE_UNSAFE: "记忆账号私有目录不安全",
  MEMORY_OWNER_CREDENTIAL_CHANGED: "记忆账号凭据已变化", MEMORY_OWNER_RETIRE_FAILED: "旧记忆资源未能完成退出",
});
function fail(code = "MEMORY_OWNER_INVALID") { throw Object.assign(new Error(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.MEMORY_OWNER_INVALID), { code }); }
function need(value, code) { if (!value) fail(code); }
function id(value) { need(typeof value === "string" && ID.test(value) && !forbidden.has(value)); return value; }
function integer(value) { need(Number.isSafeInteger(value) && value >= 0); return value; }
function text(value, max = 256, nonempty = false) {
  need(typeof value === "string" && value.length <= max && value.isWellFormed()
    && !/[\u0000-\u001f\u007f]/u.test(value) && (!nonempty || value.trim().length > 0)); return value;
}
function record(value, shape, required = []) {
  need(value && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(keys.every(key => typeof key === "string" && !forbidden.has(key) && Object.hasOwn(shape, key))
    && required.every(key => Object.hasOwn(value, key)));
  const result = {};
  for (const key of Object.keys(shape)) if (Object.hasOwn(value, key)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
    result[key] = shape[key](descriptor.value);
  }
  return Object.freeze(result);
}
const scope = value => {
  const result = record(value, { kind: entry => { need(["global", "profile"].includes(entry)); return entry; }, profileId: id }, ["kind"]);
  need(result.kind === "global" ? !Object.hasOwn(result, "profileId") : Object.hasOwn(result, "profileId")); return result;
};
function endpoint(value) {
  text(value, 4096, true); need(value === value.trim() && !/\s/u.test(value));
  let url; try { url = new URL(value); } catch { fail(); }
  need(["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.search && !url.hash);
  return url.href.replace(/\/$/u, "");
}
const sensitiveName = /auth|cookie|token|api[-_]?key|password|secret|credential|signature|session|bearer|jwt/iu;
const transportHeaders = new Set(["host", "connection", "proxy-connection", "keep-alive", "content-length", "transfer-encoding", "trailer", "te", "upgrade"]);
const sensitiveValue = /(?:^|\s)(?:bearer|basic|digest|token)\s+|(?:^|\b)(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{12,})/iu;
function headers(value) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length <= 64);
  const result = {}, seen = new Set();
  const names = Reflect.ownKeys(value); need(names.every(name => typeof name === "string"));
  for (const name of names.sort()) {
    need(typeof name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name)
      && !forbidden.has(name) && !sensitiveName.test(name) && !transportHeaders.has(name.toLowerCase()) && !seen.has(name.toLowerCase()));
    const descriptor = Object.getOwnPropertyDescriptor(value, name); need(descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
    text(descriptor.value, 4096); need(!sensitiveValue.test(descriptor.value));
    seen.add(name.toLowerCase()); result[name] = descriptor.value;
  }
  return Object.freeze(result);
}
const builtinApis = Object.freeze({ openai: "openai-completions", voyage: "openai-completions", mistral: "openai-completions", ollama: "openai-completions", gemini: "google-generative-ai" });
function provider(value) { id(value); need(!["none", "auto", "local", "llama-cpp", "shoggoth-e5"].includes(value)); return value; }
function api(value) { need(["openai-completions", "openai-responses", "google-generative-ai"].includes(value)); return value; }
function mutation(value) {
  const result = record(value, {
    action: entry => { need(["create", "update", "revoke"].includes(entry)); return entry; }, operationId: id,
    expectedCatalogRevision: integer, ownerRef: id, expectedOwnerRevision: integer, scope, providerId: provider, api,
    label: entry => text(entry, 128, true), baseUrl: endpoint, headers,
    secretAction: entry => { need(["set", "preserve", "clear"].includes(entry)); return entry; },
    secret: entry => { need(typeof entry === "string" && entry.length > 0 && Buffer.byteLength(entry) <= 16384
      && entry.isWellFormed() && !entry.includes("\0")); return entry; },
  }, ["action", "operationId", "expectedCatalogRevision"]);
  if (result.action === "create") {
    need(["scope", "providerId", "label", "baseUrl", "secretAction"].every(key => Object.hasOwn(result, key))
      && !Object.hasOwn(result, "ownerRef") && !Object.hasOwn(result, "expectedOwnerRevision") && result.secretAction !== "preserve");
    if (Object.hasOwn(builtinApis, result.providerId)) need(!result.api || result.api === builtinApis[result.providerId]);
    else need(["openai-completions", "openai-responses"].includes(result.api));
  } else {
    need(Object.hasOwn(result, "ownerRef") && Object.hasOwn(result, "expectedOwnerRevision")
      && !["scope", "providerId", "api"].some(key => Object.hasOwn(result, key)));
    if (result.action === "update") need(["label", "baseUrl", "secretAction"].every(key => Object.hasOwn(result, key)));
    else need(!["label", "baseUrl", "headers", "secretAction", "secret"].some(key => Object.hasOwn(result, key)));
  }
  need(result.secretAction === "set" ? Object.hasOwn(result, "secret") : !Object.hasOwn(result, "secret"));
  need(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  return result;
}
function recovery(value) {
  return record(value, { operationId: id, mode: entry => { need(["resume", "cancel"].includes(entry)); return entry; },
    secret: entry => { need(typeof entry === "string" && entry.length > 0 && Buffer.byteLength(entry) <= 16384
      && entry.isWellFormed() && !entry.includes("\0")); return entry; } }, ["operationId", "mode"]);
}
function refs(value) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length <= 128);
  const shape = Object.create(null); for (const key of Reflect.ownKeys(value)) { id(key); shape[key] = id; }
  return record(value, Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b))));
}
function ownValue(value, key) {
  if (value === undefined || value === null) return undefined;
  need(Object.getPrototypeOf(value) === Object.prototype);
  if (!Object.hasOwn(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key); need(descriptor?.enumerable && Object.hasOwn(descriptor, "value")); return descriptor.value;
}
function capture(value, budget = { bytes: 1048576, nodes: 20000 }, depth = 0) {
  need(--budget.nodes >= 0 && depth <= 24);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { need(Number.isFinite(value)); return value; }
  if (typeof value === "string") { text(value, 1048576); budget.bytes -= Buffer.byteLength(value); need(budget.bytes >= 0); return value; }
  need(value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype
    || Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype));
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) need(Reflect.ownKeys(value).length === value.length + 1);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    need(typeof key === "string" && !forbidden.has(key)); budget.bytes -= Buffer.byteLength(key); need(budget.bytes >= 0);
    const descriptor = Object.getOwnPropertyDescriptor(value, key); need(descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
    result[key] = capture(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(result);
}
function effectiveRefs(cfg, agentId) {
  id(agentId);
  const global = ownValue(ownValue(ownValue(cfg, "memory"), "search"), "providerRefs");
  const selected = ownValue(ownValue(ownValue(cfg, "agents"), "entries"), agentId);
  const local = ownValue(ownValue(ownValue(selected, "memory"), "search"), "providerRefs");
  return Object.freeze({ ...refs(global ?? {}), ...refs(local ?? {}) });
}
function metadata(row) {
  return Object.freeze({ ownerRef: row.ownerRef, label: row.label, scope: row.scope, providerId: row.providerId, api: row.api,
    baseUrl: row.baseUrl, revision: row.revision, status: row.status, hasCredential: row.credentialRef !== null });
}
function array(value, validate, max) {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1);
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); need(descriptor?.enumerable && Object.hasOwn(descriptor, "value")); return validate(descriptor.value);
  }));
}
function validateParams(method, value) {
  need(METHODS.includes(method));
  if (method === METHODS[0]) return record(value, { profileId: id });
  if (method === METHODS[1]) return mutation(value);
  return recovery(value);
}
function validateResult(method, value) {
  need(METHODS.includes(method));
  const status = entry => { need(["active", "revoked"].includes(entry)); return entry; };
  const boolean = entry => { need(typeof entry === "boolean"); return entry; };
  let result;
  if (method === METHODS[0]) result = record(value, { catalogRevision: integer,
    owners: entry => array(entry, row => record(row, { ownerRef: id, label: entry => text(entry, 128, true), scope, providerId: provider, api,
      baseUrl: endpoint, revision: integer, status, hasCredential: boolean },
    ["ownerRef", "label", "scope", "providerId", "api", "baseUrl", "revision", "status", "hasCredential"]), 128),
    pendingOperations: entry => array(entry, operation => record(operation, { operationId: id, ownerRef: id,
      phase: entry => { need(["reserved", "credential_ready", "published", "retired"].includes(entry)); return entry; } }, ["operationId", "ownerRef", "phase"]), 1024),
  }, ["catalogRevision", "owners", "pendingOperations"]);
  else result = record(value, { operationId: id, ownerRef: id, catalogRevision: integer, ownerRevision: integer,
    status: entry => { need(["active", "revoked", "cancelled"].includes(entry)); return entry; },
    cleanupComplete: entry => { need(entry === true); return entry; }, phase: entry => { need(["completed", "cancelled"].includes(entry)); return entry; }, current: boolean,
  }, ["operationId", "ownerRef", "catalogRevision", "ownerRevision", "status", "cleanupComplete", "phase", "current"]);
  need(Buffer.byteLength(JSON.stringify({ id: "i".repeat(128), ok: true, result })) + 1 <= 65536);
  if (method !== METHODS[0]) need(result.phase === "cancelled" ? result.status === "cancelled" && result.current === false : result.status !== "cancelled");
  return result;
}
function publicError(error) { const code = Object.hasOwn(PUBLIC_MESSAGES, error?.code) ? error.code : "MEMORY_OWNER_INVALID";
  return Object.freeze({ code, message: PUBLIC_MESSAGES[code] }); }
module.exports = { METHODS, PUBLIC_MESSAGES, fail, need, id, integer, record, scope, endpoint, headers, mutation, recovery,
  effectiveRefs, ownValue, capture, metadata, publicError, builtinApis, validateParams, validateResult };
