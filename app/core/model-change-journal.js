"use strict";

// ModelChangeJournal 是模型变更恢复的唯一持久事实来源。任何读取、校验、加锁或
// 写入失败都必须向上抛出稳定错误，绝不退化为仅内存状态。
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const VERSION = 1;
const MAX_TERMINAL_ENTRIES = 200;
const TERMINAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NON_TERMINAL = new Set(["in_progress", "partial", "blocked", "needs_secret", "cleanup_pending"]);
const TERMINAL = new Set(["applied", "failed", "compensated"]);
const ALL_STATUSES = new Set([...NON_TERMINAL, ...TERMINAL]);
const COMMIT_STATES = ["precommit", "committing", "committed"];
const ENTRY_FIELDS = [
  "version", "operationId", "requestDigest", "previewTokenDigest", "backendId", "providerKey", "kind",
  "mode", "source", "target", "fingerprints", "stage", "status", "commitState", "modelDiff", "createdProvider",
  "providerDiff", "secretStep", "steps", "error", "result", "createdAt", "updatedAt",
];
const ENTRY_INPUT_FIELDS = new Set([
  "operationId", "requestDigest", "previewTokenDigest", "backendId", "providerKey", "kind", "mode", "source", "target",
  "fingerprints", "modelDiff", "providerDiff", "createdProvider", "secretStep",
]);
// full = 完整立即应用(引用迁移+运行态收敛);config-only = 仅写配置,生效由显式 activation 完成。
const ENTRY_MODES = new Set(["full", "config-only"]);
const STEP_FIELDS = [
  "scannerId", "store", "referenceKey", "stage", "before", "after", "undo", "writeStatus", "readback", "error",
  "startedAt", "finishedAt",
];
const STAGE_PATCH_FIELDS = new Set([
  "fingerprints", "status", "commitState", "modelDiff", "createdProvider", "secretStep", "error", "result",
]);
const PUBLIC_MODEL_FIELDS = new Set([
  "id", "name", "provider", "backendId", "profile", "contextWindow", "maxTokens", "reasoning", "pricing",
  "acpProviderRef",
]);
const PRICING_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const MAX_LOCK_OWNER_LENGTH = 200;
const SECRET_KEY_ALIASES = new Set([
  "apikey", "xapikey", "token", "accesstoken", "refreshtoken", "authorization",
  "clientsecret", "secret", "password", "credential", "credentials",
]);

/**
 * Journal 自身维护封闭的引用 diff 注册表，避免 scanner 把完整 Session/Cron/Provider
 * 原对象塞进 undo。每项只声明可恢复所需的模型引用字段及其类型。
 */
const REFERENCE_DIFF_REGISTRY = new Map([
  ["openclaw.config.v2\0config", {
    model: "string", primary: "string", fallbacks: "string-array", provider: "string", modelId: "string",
  }],
  ["openclaw.sessions.v1\0sessions", { model: "string", provider: "string", modelId: "string" }],
  ["openclaw.cron.v1\0cron", { provider: "string", model: "string", fallbacks: "string-array" }],
  ["hermes.provider.v1\0provider", {
    profile: "string", provider: "string", modelId: "string", model: "public-model",
  }],
  ["hermes.main.v1\0main", { profile: "string", provider: "string", model: "string" }],
  ["hermes.auxiliary.v1\0auxiliary", { profile: "string", provider: "string", model: "string" }],
  ["hermes.cron.v1\0cron", {
    profile: "string", provider: "string", model: "string", fallbacks: "string-array",
  }],
  ["hermes.sessions.v1\0sessions", { profile: "string", provider: "string", model: "string", modelId: "string" }],
]);

/** 带稳定 code/status/stage 的 journal 错误，供唯一 API catch 安全映射。 */
class ModelChangeJournalError extends Error {
  constructor(code, message, { status = 500, stage = "journal", details, committed = false } = {}) {
    super(`${code}: ${message}`);
    this.name = "ModelChangeJournalError";
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.details = details;
    this.committed = committed === true;
  }
}

/** 判断值是否为可预测序列化的普通对象。 */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 统一构造 schema 错误，避免错误消息回显用户数据。 */
function schemaError(message) {
  return new ModelChangeJournalError("journal_schema", message);
}

/** 检查对象键集合完全等于固定 schema，禁止未知字段静默落盘。 */
function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw schemaError(`${label} 必须是普通对象`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw schemaError(`${label} 字段不符合固定 schema`);
  }
}

/** 校验必填非空字符串。 */
function assertRequiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw schemaError(`${label} 必须是非空字符串`);
}

/** 校验 journal 时间戳必须是非负有限数。 */
function assertTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0) throw schemaError(`${label} 必须是有效时间戳`);
}

/** secret key alias 统一归一化；明确 digest/hash/fingerprint/checksum 后缀允许持久化。 */
function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[\s_-]/g, "");
  if (/(?:digest|hash|fingerprint|checksum)/.test(normalized)) return false;
  return SECRET_KEY_ALIASES.has(normalized);
}

/** 使用 URL parser 检查字符串中的 HTTP(S) URL 是否携带 username/password。 */
function containsCredentialUrl(value) {
  if (typeof value !== "string") return false;
  const candidates = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.username || parsed.password) return true;
    } catch {
      // 普通文本中的非完整 URL 由上层字段 schema 处理，这里只负责可解析 URL 的 userinfo。
    }
  }
  return false;
}

/** 拒绝任意 Authorization scheme 载荷与 token/apiKey 赋值，避免 secret 藏进文本。 */
function containsCredentialAssignment(value) {
  if (typeof value !== "string") return false;
  return /\bauthorization\s*[:=]\s*[^\s,;]+\s+[^\s,;\]}]+/i.test(value)
    || /\b(?:(?:x[\s_-]?)?api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|token|password|credentials?)\b\s*(?:provided\s*)?[:=]\s*["']?[^\s"',;\]}]+/i.test(value);
}

/** 裸 Bearer/Basic 后只要存在非空载荷就 fail-closed，不使用长度或熵猜测。 */
function containsBareAuthorizationCredential(value) {
  if (typeof value !== "string") return false;
  return /\b(?:bearer|basic)\s+[^\s,;\]}]+/i.test(value);
}

/** key/value 共用同一 credential 文本判定，避免只扫描值造成字段名旁路。 */
function containsCredentialText(value) {
  if (typeof value !== "string") return false;
  const knownTokenPrefix = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|xoxb-[A-Za-z0-9_-]+|AKIA[0-9A-Z]+|AIza[0-9A-Za-z_-]+)/;
  return containsCredentialAssignment(value)
    || containsBareAuthorizationCredential(value)
    || knownTokenPrefix.test(value);
}

/**
 * 深度验证值可无损 JSON 序列化，并拒绝任何 secret key 或带凭证 URL。
 * Journal 只持久化 plain object/array/JSON primitive，避免 toJSON 隐式泄密。
 */
function assertSafeJson(value, label = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (containsCredentialUrl(value) || containsCredentialText(value)) {
      throw new ModelChangeJournalError("journal_secret", `${label} 包含禁止的凭证文本`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw schemaError(`${label} 包含非有限数字`);
    return;
  }
  if (typeof value !== "object") throw schemaError(`${label} 包含不可序列化值`);
  if (seen.has(value)) throw schemaError(`${label} 包含循环引用`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertSafeJson(item, `${label}[${index}]`, seen));
      return;
    }
    if (!isPlainObject(value)) throw schemaError(`${label} 必须由普通对象组成`);
    for (const [key, child] of Object.entries(value)) {
      if (isSecretKey(key)) {
        throw new ModelChangeJournalError("journal_secret", `${label} 包含禁止的凭证字段`);
      }
      if (containsCredentialUrl(key) || containsCredentialText(key)) {
        throw new ModelChangeJournalError("journal_secret", `${label} 的字段名包含禁止的凭证文本`);
      }
      assertSafeJson(child, `${label}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/** 校验公共模型快照，只允许目录公开字段及封闭 pricing 数值结构。 */
function validatePublicModel(value, label) {
  if (!isPlainObject(value)) throw schemaError(`${label} 必须是公共模型对象`);
  const keys = Object.keys(value);
  if (!keys.length) throw schemaError(`${label} 不能为空`);
  for (const key of keys) {
    if (!PUBLIC_MODEL_FIELDS.has(key)) throw schemaError(`${label} 包含未声明的模型字段`);
  }
  assertRequiredString(value.id, `${label}.id`);
  for (const field of ["name", "provider", "backendId", "profile", "acpProviderRef"]) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] !== null) {
      assertRequiredString(value[field], `${label}.${field}`);
    }
  }
  for (const field of ["contextWindow", "maxTokens"]) {
    if (Object.prototype.hasOwnProperty.call(value, field)
      && (!Number.isSafeInteger(value[field]) || value[field] <= 0)) {
      throw schemaError(`${label}.${field} 必须是正安全整数`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "reasoning") && typeof value.reasoning !== "boolean") {
    throw schemaError(`${label}.reasoning 必须是布尔值`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "pricing")) {
    if (!isPlainObject(value.pricing)) throw schemaError(`${label}.pricing 必须是普通对象`);
    for (const [key, amount] of Object.entries(value.pricing)) {
      if (!PRICING_FIELDS.has(key) || !Number.isFinite(amount)) {
        throw schemaError(`${label}.pricing 包含未声明或无效字段`);
      }
    }
  }
  assertSafeJson(value, label);
}

/** modelDiff 固定为 before/after 两个公共模型快照，create/delete 可使用 null。 */
function validateModelDiff(modelDiff, label = "modelDiff") {
  if (modelDiff === null) return;
  const fields = Object.prototype.hasOwnProperty.call(modelDiff, "profiles")
    ? ["before", "after", "profiles"]
    : ["before", "after"];
  assertExactKeys(modelDiff, fields, label);
  for (const side of ["before", "after"]) {
    if (modelDiff[side] !== null) validatePublicModel(modelDiff[side], `${label}.${side}`);
  }
  if (modelDiff.before === null && modelDiff.after === null) throw schemaError(`${label} 不能两侧都为空`);
  if (fields.includes("profiles")) {
    if (!Array.isArray(modelDiff.profiles) || modelDiff.profiles.length === 0) {
      throw schemaError(`${label}.profiles 必须是非空数组`);
    }
    const seen = new Set();
    modelDiff.profiles.forEach((row, index) => {
      assertExactKeys(row, ["profile", "before", "after"], `${label}.profiles[${index}]`);
      assertRequiredString(row.profile, `${label}.profiles[${index}].profile`);
      if (seen.has(row.profile)) throw schemaError(`${label}.profiles 包含重复 Profile`);
      seen.add(row.profile);
      for (const side of ["before", "after"]) {
        if (row[side] !== null) validatePublicModel(row[side], `${label}.profiles[${index}].${side}`);
      }
      if (row.before === null && row.after === null) throw schemaError(`${label}.profiles[${index}] 不能两侧都为空`);
    });
  }
}

/** Provider 更新只持久化变更前后公开配置摘要，禁止 URL 或凭证进入 journal。 */
function validateProviderDiff(providerDiff, label = "providerDiff") {
  if (providerDiff === null) return;
  const fields = Object.prototype.hasOwnProperty.call(providerDiff, "profiles")
    ? ["beforeDigest", "afterDigest", "profiles"]
    : ["beforeDigest", "afterDigest"];
  assertExactKeys(providerDiff, fields, label);
  for (const field of ["beforeDigest", "afterDigest"]) {
    if (typeof providerDiff[field] !== "string" || !/^[0-9a-f]{64}$/.test(providerDiff[field])) {
      throw schemaError(`${label}.${field} 必须是 SHA-256 摘要`);
    }
  }
  if (fields.includes("profiles")) {
    if (!Array.isArray(providerDiff.profiles) || providerDiff.profiles.length === 0) {
      throw schemaError(`${label}.profiles 必须是非空数组`);
    }
    const seen = new Set();
    providerDiff.profiles.forEach((row, index) => {
      assertExactKeys(row, ["profile", "beforeDigest", "afterDigest"], `${label}.profiles[${index}]`);
      assertRequiredString(row.profile, `${label}.profiles[${index}].profile`);
      if (seen.has(row.profile)) throw schemaError(`${label}.profiles 包含重复 Profile`);
      seen.add(row.profile);
      for (const field of ["beforeDigest", "afterDigest"]) {
        if (typeof row[field] !== "string" || !/^[0-9a-f]{64}$/.test(row[field])) {
          throw schemaError(`${label}.profiles[${index}].${field} 必须是 SHA-256 摘要`);
        }
      }
    });
  }
}

/** 使用已经确认匹配的封闭字段 schema 校验单个 before/after/undo/readback。 */
function validateReferenceDiff(fields, value, label) {
  if (value === null) return;
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw schemaError(`${label} 必须是非空引用 diff`);
  for (const [key, fieldValue] of Object.entries(value)) {
    const type = fields[key];
    if (!type) throw schemaError(`${label} 包含未声明的引用字段`);
    if (type === "string") {
      if (fieldValue !== null) assertRequiredString(fieldValue, `${label}.${key}`);
      continue;
    }
    if (type === "string-array") {
      if (!Array.isArray(fieldValue)) throw schemaError(`${label}.${key} 必须是字符串数组`);
      fieldValue.forEach((item, index) => assertRequiredString(item, `${label}.${key}[${index}]`));
      continue;
    }
    if (type === "public-model") {
      if (fieldValue !== null) validatePublicModel(fieldValue, `${label}.${key}`);
      continue;
    }
    throw schemaError(`${label}.${key} 使用未知字段类型`);
  }
  assertSafeJson(value, label);
}

/** 通过 JSON 往返生成与 journal 落盘语义一致的隔离副本。 */
function cloneJson(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 验证固定的引用迁移步骤 schema。 */
function validateStep(step, label = "step") {
  assertExactKeys(step, STEP_FIELDS, label);
  for (const field of ["scannerId", "store", "referenceKey", "stage", "writeStatus"]) {
    assertRequiredString(step[field], `${label}.${field}`);
  }
  // scannerId/store 必须先整体命中一次注册表；即使四个 diff 都为 null 也不能绕过。
  const referenceFields = REFERENCE_DIFF_REGISTRY.get(`${step.scannerId}\0${step.store}`);
  if (!referenceFields) throw schemaError(`${label} 的 scannerId/store 未注册`);
  for (const field of ["before", "after", "undo", "readback"]) {
    validateReferenceDiff(referenceFields, step[field], `${label}.${field}`);
  }
  if (step.error !== null && !isPlainObject(step.error) && typeof step.error !== "string") {
    throw schemaError(`${label}.error 必须是普通对象、字符串或 null`);
  }
  assertTimestamp(step.startedAt, `${label}.startedAt`);
  assertTimestamp(step.finishedAt, `${label}.finishedAt`, { nullable: true });
  if (step.finishedAt !== null && step.finishedAt < step.startedAt) {
    throw schemaError(`${label}.finishedAt 不能早于 startedAt`);
  }
  assertSafeJson(step, label);
}

/** 验证完整 operation entry 可用于崩溃恢复。 */
function validateEntry(entry, label = "entry") {
  assertExactKeys(entry, ENTRY_FIELDS, label);
  if (entry.version !== VERSION) throw schemaError(`${label}.version 不受支持`);
  for (const field of ["operationId", "requestDigest", "previewTokenDigest", "backendId", "providerKey", "kind", "stage", "secretStep"]) {
    assertRequiredString(entry[field], `${label}.${field}`);
  }
  if (!ALL_STATUSES.has(entry.status)) throw schemaError(`${label}.status 不受支持`);
  if (!ENTRY_MODES.has(entry.mode)) throw schemaError(`${label}.mode 不受支持`);
  if (!COMMIT_STATES.includes(entry.commitState)) throw schemaError(`${label}.commitState 不受支持`);
  for (const field of ["source", "target", "modelDiff"]) {
    if (entry[field] !== null && !isPlainObject(entry[field])) {
      throw schemaError(`${label}.${field} 必须是普通对象或 null`);
    }
  }
  if (!isPlainObject(entry.fingerprints)) throw schemaError(`${label}.fingerprints 必须是普通对象`);
  validateModelDiff(entry.modelDiff, `${label}.modelDiff`);
  validateProviderDiff(entry.providerDiff, `${label}.providerDiff`);
  if (typeof entry.createdProvider !== "boolean") throw schemaError(`${label}.createdProvider 必须是布尔值`);
  if (!Array.isArray(entry.steps)) throw schemaError(`${label}.steps 必须是数组`);
  entry.steps.forEach((step, index) => validateStep(step, `${label}.steps[${index}]`));
  if (entry.error !== null && !isPlainObject(entry.error) && typeof entry.error !== "string") {
    throw schemaError(`${label}.error 必须是普通对象、字符串或 null`);
  }
  assertTimestamp(entry.createdAt, `${label}.createdAt`);
  assertTimestamp(entry.updatedAt, `${label}.updatedAt`);
  if (entry.updatedAt < entry.createdAt) throw schemaError(`${label}.updatedAt 不能早于 createdAt`);
  assertSafeJson(entry, label);
}

/**
 * 只从白名单输入构造固定 schema；允许先构造缺字段 row，由 begin 在首次写入前
 * fail-closed，便于调用方统一建立 operation 对象。
 */
function createEntry(input = {}, now = Date.now()) {
  if (!isPlainObject(input)) throw schemaError("createEntry input 必须是普通对象");
  for (const key of Object.keys(input)) {
    if (!ENTRY_INPUT_FIELDS.has(key)) throw schemaError("createEntry input 包含未知字段");
  }
  assertSafeJson(input, "createEntry input");
  const timestamp = now === undefined ? Date.now() : now;
  return {
    version: VERSION,
    operationId: input.operationId,
    requestDigest: input.requestDigest,
    previewTokenDigest: input.previewTokenDigest,
    backendId: input.backendId,
    providerKey: input.providerKey,
    kind: input.kind,
    mode: input.mode === "config-only" ? "config-only" : "full",
    source: input.source || null,
    target: input.target,
    fingerprints: input.fingerprints || {},
    stage: "preflight",
    status: "in_progress",
    commitState: "precommit",
    modelDiff: input.modelDiff || null,
    providerDiff: input.providerDiff || null,
    createdProvider: input.createdProvider === true,
    secretStep: input.secretStep || "not_required",
    steps: [],
    error: null,
    result: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** 验证 journal 根文件并恢复为以 operationId 索引的 Map。 */
function parseState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelChangeJournalError("journal_corrupt", "journal JSON 已损坏");
  }
  assertExactKeys(parsed, ["version", "operations"], "journal");
  if (parsed.version !== VERSION || !Array.isArray(parsed.operations)) throw schemaError("journal 根 schema 不受支持");
  const operations = new Map();
  parsed.operations.forEach((rawEntry, index) => {
    // mode 字段晚于 v1 首发加入;旧文件条目一律视为完整模式,读取时原位升级。
    const entry = isPlainObject(rawEntry) && !("mode" in rawEntry) ? { ...rawEntry, mode: "full" } : rawEntry;
    validateEntry(entry, `journal.operations[${index}]`);
    if (operations.has(entry.operationId)) throw schemaError("journal 包含重复 operationId");
    operations.set(entry.operationId, cloneJson(entry));
  });
  return operations;
}

/** 从磁盘读取完整状态；只有 ENOENT 表示合法空 journal。 */
function readState(filePath) {
  try {
    return parseState(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return new Map();
    if (error instanceof ModelChangeJournalError) throw error;
    throw new ModelChangeJournalError("journal_read", "无法读取 model change journal");
  }
}

/** 创建父目录；失败属于持久层不可用，稳定映射为 journal_write。 */
function ensureParentDirectory(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    throw new ModelChangeJournalError("journal_write", "无法创建 journal 父目录");
  }
}

/** 将完整状态写入独占临时文件，fsync 后原子 rename，并同步父目录持久化目录项。 */
function writeStateAtomically(filePath, operations, faults = {}) {
  ensureParentDirectory(filePath);
  const nonce = randomBytes(16).toString("hex");
  const temporaryPath = `${filePath}.${process.pid}.${nonce}.tmp`;
  let descriptor = null;
  let directoryDescriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    const payload = JSON.stringify({ version: VERSION, operations: [...operations.values()] });
    const bytes = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    if (typeof faults.beforeRename === "function") faults.beforeRename();
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    renamed = true;
    if (typeof faults.beforeParentFsync === "function") faults.beforeParentFsync();
    directoryDescriptor = fs.openSync(path.dirname(filePath), "r");
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
    directoryDescriptor = null;
  } catch {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* 仅关闭当前调用创建的 fd。 */ }
    }
    if (directoryDescriptor !== null) {
      try { fs.closeSync(directoryDescriptor); } catch { /* 仅关闭当前调用创建的目录 fd。 */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(temporaryPath); } catch { /* 临时文件未创建时无需清理。 */ }
    }
    throw new ModelChangeJournalError("journal_write", "无法持久化 model change journal", { committed: renamed });
  }
}

/** 校验锁文件内容，损坏锁不能按过期锁静默接管。 */
function parseLock(raw) {
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    throw new ModelChangeJournalError("journal_lock_corrupt", "journal lock JSON 已损坏", { status: 409 });
  }
  const expectedKeys = ["owner", "pid", "nonce", "expiresAt"].sort();
  const actualKeys = isPlainObject(lock) ? Object.keys(lock).sort() : [];
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || typeof lock.owner !== "string" || !lock.owner
    || !Number.isInteger(lock.pid) || lock.pid < 0
    || typeof lock.nonce !== "string" || !/^[0-9a-f]{32}$/.test(lock.nonce)
    || !Number.isFinite(lock.expiresAt)) {
    throw new ModelChangeJournalError("journal_lock_corrupt", "journal lock schema 已损坏", { status: 409 });
  }
  try {
    if (lock.owner.length > MAX_LOCK_OWNER_LENGTH || /[\u0000-\u001f\u007f]/.test(lock.owner)) {
      throw schemaError("lock owner 格式不合法");
    }
    assertSafeJson(lock.owner, "lock owner");
  } catch {
    throw new ModelChangeJournalError("journal_lock_corrupt", "journal lock owner 不安全", { status: 409 });
  }
  return lock;
}

/** 将租约 JSON 原地写入持有的 fd，并强制 fsync。 */
function writeLeaseDescriptor(descriptor, lease) {
  const bytes = Buffer.from(JSON.stringify({
    owner: lease.owner,
    pid: lease.pid,
    nonce: lease.nonce,
    expiresAt: lease.expiresAt,
  }), "utf8");
  fs.ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
  fs.fsyncSync(descriptor);
}

/** PID 0 是本模块的 released 标记；EPERM 表示进程存在但无权发信号，也视为存活。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

/** 比较持有 fd 与 canonical 路径 inode，防止内容 nonce 检查后的路径替换竞态。 */
function leaseHasCanonicalIdentity(lease) {
  try {
    const held = fs.fstatSync(lease.descriptor);
    const canonical = fs.statSync(lease.lockPath);
    return held.dev === canonical.dev && held.ino === canonical.ino;
  } catch {
    return false;
  }
}

/** 校验 canonical inode、owner/pid/nonce 都仍属于当前 lease。 */
function readOwnedCanonicalLease(lease) {
  if (!leaseHasCanonicalIdentity(lease)) {
    throw new ModelChangeJournalError("journal_locked", "lease canonical identity 已丢失", { status: 409 });
  }
  let current;
  try {
    current = parseLock(fs.readFileSync(lease.lockPath, "utf8"));
  } catch (error) {
    if (error instanceof ModelChangeJournalError) throw error;
    throw new ModelChangeJournalError("journal_locked", "lease canonical 路径不可读", { status: 409 });
  }
  if (!leaseHasCanonicalIdentity(lease)
    || current.nonce !== lease.nonce
    || current.owner !== lease.owner
    || current.pid !== lease.pid) {
    throw new ModelChangeJournalError("journal_locked", "lease 已被其他 owner 替换", { status: 409 });
  }
  return current;
}

/** 尽力删除只由当前 acquire 调用原子 rename 出来的 stale 文件。 */
function cleanupStaleFiles(staleFiles) {
  for (const stalePath of staleFiles) {
    try { fs.unlinkSync(stalePath); } catch { /* stale 不影响当前有效锁，后续可由临时目录清理。 */ }
  }
  staleFiles.clear();
}

/** stale 内容无法确认时用 hard-link 原子 no-clobber 恢复；EEXIST 时保留 stale 与新 owner。 */
function restoreOrPreserveStale(lockPath, stalePath) {
  try {
    fs.linkSync(stalePath, lockPath);
  } catch {
    // EEXIST 或其它失败都保留 stale；绝不使用会覆盖 canonical 的普通 rename。
    return;
  }
  try { fs.unlinkSync(stalePath); } catch { /* hard-link 已恢复 canonical，保留 stale 也安全。 */ }
}

/** lock owner 在创建任何文件前执行统一 secret 扫描及长度/控制字符门禁。 */
function assertSafeLockOwner(owner) {
  assertRequiredString(owner, "lock owner");
  if (owner.length > MAX_LOCK_OWNER_LENGTH || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw schemaError("lock owner 格式不合法");
  }
  assertSafeJson(owner, "lock owner");
}

/**
 * 用 O_EXCL 创建租约。过期锁先 rename 到唯一 stale 路径，再重新竞争创建；
 * 永不 unlink 原 lockPath，因此不会误删竞争者刚创建的新锁。
 */
function acquireLease(lockPath, owner, now, lockTtlMs) {
  assertSafeLockOwner(owner);
  ensureParentDirectory(lockPath);
  const nonce = randomBytes(16).toString("hex");
  const staleFiles = new Set();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let descriptor;
    const lease = { owner, pid: process.pid, nonce, expiresAt: now() + lockTtlMs, lockPath };
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      lease.descriptor = descriptor;
      writeLeaseDescriptor(descriptor, lease);
      cleanupStaleFiles(staleFiles);
      return lease;
    } catch (error) {
      if (descriptor !== undefined) {
        const failedPath = `${lockPath}.failed-${process.pid}-${nonce}`;
        let movedFailedLease = false;
        try {
          if (leaseHasCanonicalIdentity(lease)) {
            fs.renameSync(lockPath, failedPath);
            movedFailedLease = true;
          }
        } catch { /* 无法确认 inode 时保留 canonical，后续读取会 fail-closed。 */ }
        try { fs.closeSync(descriptor); } catch { /* 只关闭当前 acquire 创建的 fd。 */ }
        if (movedFailedLease) {
          try { fs.unlinkSync(failedPath); } catch { /* 只清理当前 acquire 已隔离的失败 inode。 */ }
        }
      }
      if (!error || error.code !== "EEXIST") {
        cleanupStaleFiles(staleFiles);
        if (error instanceof ModelChangeJournalError) throw error;
        throw new ModelChangeJournalError("journal_write", "无法创建 journal lock");
      }
    }

    let current;
    try {
      current = parseLock(fs.readFileSync(lockPath, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      cleanupStaleFiles(staleFiles);
      if (error instanceof ModelChangeJournalError) throw error;
      throw new ModelChangeJournalError("journal_lock_corrupt", "无法读取 journal lock", { status: 409 });
    }
    if (current.expiresAt > now() || isProcessAlive(current.pid)) {
      cleanupStaleFiles(staleFiles);
      throw new ModelChangeJournalError("journal_locked", "journal 正由其他 operation 持有", { status: 409 });
    }

    const takeoverNonce = randomBytes(12).toString("hex");
    const stalePath = `${lockPath}.stale-${process.pid}-${current.nonce}-${takeoverNonce}`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      cleanupStaleFiles(staleFiles);
      throw new ModelChangeJournalError("journal_write", "无法接管过期 journal lock");
    }
    staleFiles.add(stalePath);

    // rename 后再次核对 nonce/过期时间；若心跳已续租或路径被替换，尽力恢复且拒绝接管。
    let moved;
    try {
      moved = parseLock(fs.readFileSync(stalePath, "utf8"));
    } catch (error) {
      staleFiles.delete(stalePath);
      restoreOrPreserveStale(lockPath, stalePath);
      cleanupStaleFiles(staleFiles);
      if (error instanceof ModelChangeJournalError) throw error;
      throw new ModelChangeJournalError("journal_lock_corrupt", "接管后的 stale lock 无法读取", { status: 409 });
    }
    if (moved.nonce !== current.nonce || moved.expiresAt > now() || isProcessAlive(moved.pid)) {
      staleFiles.delete(stalePath);
      restoreOrPreserveStale(lockPath, stalePath);
      cleanupStaleFiles(staleFiles);
      throw new ModelChangeJournalError("journal_locked", "journal lock 已被续租或替换", { status: 409 });
    }
  }
  cleanupStaleFiles(staleFiles);
  throw new ModelChangeJournalError("journal_locked", "journal lock 竞争未完成", { status: 409 });
}

/**
 * 通过持有 fd 把原 inode 标为 released 后关闭；canonical 即使已指向后来者 inode
 * 也不会被 unlink 或覆盖。若释放前已失去 canonical identity，仍标记旧 inode并报错。
 */
function releaseLease(lease) {
  let ownershipError = null;
  try {
    readOwnedCanonicalLease(lease);
  } catch (error) {
    ownershipError = error instanceof ModelChangeJournalError
      ? error
      : new ModelChangeJournalError("journal_locked", "释放前 lease identity 已丢失", { status: 409 });
  }
  let writeError = null;
  // canonical 已换成新 inode 时可安全标记旧 fd；同 inode 内容被替换时绝不覆盖后来者内容。
  const shouldMarkReleased = !ownershipError || !leaseHasCanonicalIdentity(lease);
  if (shouldMarkReleased) {
    try {
      writeLeaseDescriptor(lease.descriptor, {
        owner: "released",
        pid: 0,
        nonce: lease.nonce,
        expiresAt: 0,
      });
    } catch {
      writeError = new ModelChangeJournalError("journal_write", "无法标记 lease released");
    }
  }
  try { fs.closeSync(lease.descriptor); } catch { /* fd 仅用于当前租约。 */ }
  if (writeError) throw writeError;
  if (ownershipError) throw ownershipError;
}

/** 校验 lease 仍为 canonical 且 owner PID 存活，并通过原 fd 同步续租后再次核验。 */
function assertAndRenewLease(lease, now, lockTtlMs) {
  const current = readOwnedCanonicalLease(lease);
  if (!isProcessAlive(current.pid)) {
    throw new ModelChangeJournalError("journal_locked", "lease owner PID 已失效", { status: 409 });
  }
  lease.expiresAt = now() + lockTtlMs;
  try {
    writeLeaseDescriptor(lease.descriptor, lease);
  } catch {
    throw new ModelChangeJournalError("journal_write", "lease 续租写入失败");
  }
  const renewed = readOwnedCanonicalLease(lease);
  if (renewed.expiresAt <= now()) {
    throw new ModelChangeJournalError("journal_locked", "lease 续租后仍已过期", { status: 409 });
  }
  return renewed;
}

/** Provider callback 使用的 fencing guard；任何所有权失败都会同步 abort 并永久失效。 */
function createProviderLeaseGuard(lease, now, lockTtlMs) {
  const controller = new AbortController();
  let lostError = null;

  function markLost(error) {
    if (!lostError) {
      lostError = error instanceof ModelChangeJournalError
        ? error
        : new ModelChangeJournalError("journal_locked", "Provider lease 已失效", { status: 409 });
      controller.abort(lostError);
    }
    return lostError;
  }

  const guard = Object.freeze({
    token: lease.nonce,
    signal: controller.signal,
    /** 每一个外部 mutation 前必须调用；成功会同步续租并二次核对 canonical identity。 */
    assertActive() {
      if (lostError) throw lostError;
      try {
        assertAndRenewLease(lease, now, lockTtlMs);
      } catch (error) {
        throw markLost(error);
      }
    },
  });

  return { guard, markLost, getLostError: () => lostError };
}

/** 终态裁剪只作用于 applied/failed/compensated，非终态无论数量和年龄都保留。 */
function pruneOperations(operations, now) {
  const cutoff = now() - TERMINAL_MAX_AGE_MS;
  const recentTerminal = [];
  for (const entry of operations.values()) {
    if (!TERMINAL.has(entry.status)) continue;
    if (entry.updatedAt < cutoff) {
      operations.delete(entry.operationId);
      continue;
    }
    recentTerminal.push(entry);
  }
  recentTerminal.sort((left, right) => (
    right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || right.operationId.localeCompare(left.operationId)
  ));
  for (const entry of recentTerminal.slice(MAX_TERMINAL_ENTRIES)) operations.delete(entry.operationId);
}

/** 创建不可降级的 model change journal 实例。 */
function createModelChangeJournal(filePath, {
  now = Date.now,
  lockTtlMs = 30_000,
  timers = globalThis,
  faults = {},
} = {}) {
  assertRequiredString(filePath, "journal filePath");
  if (typeof now !== "function") throw schemaError("now 必须是函数");
  if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) throw schemaError("lockTtlMs 必须是正数");
  if (!timers || typeof timers.setInterval !== "function" || typeof timers.clearInterval !== "function") {
    throw schemaError("timers 必须提供 setInterval/clearInterval");
  }
  if (!isPlainObject(faults)) throw schemaError("faults 必须是普通对象");

  let operations = readState(filePath);
  let activeExclusiveLease = null;
  const exclusiveContext = new AsyncLocalStorage();

  /** 每个 mutator 的第一道门：必须来自当前 exclusive callback 且仍拥有磁盘 lock nonce。 */
  function assertMutatorAccess() {
    if (!activeExclusiveLease || exclusiveContext.getStore() !== activeExclusiveLease.nonce) {
      throw new ModelChangeJournalError("journal_not_locked", "journal mutator 必须在 withExclusiveLock 内调用");
    }
    // global callback 预期很短，但每个 mutator 仍同步续租，超时活 owner 也不会失去 fencing。
    assertAndRenewLease(activeExclusiveLease, now, lockTtlMs);
  }

  /** 所有 mutator 通过 copy-on-write 提交，写失败不会留下仅内存的新状态。 */
  function mutate(update) {
    assertMutatorAccess();
    const next = new Map([...operations].map(([operationId, entry]) => [operationId, cloneJson(entry)]));
    const result = update(next);
    pruneOperations(next, now);
    try {
      writeStateAtomically(filePath, next, faults);
      operations = next;
    } catch (error) {
      // rename 后 parent fsync 失败属于“不确定但已提交”；内存必须与可重开磁盘保持一致。
      if (error instanceof ModelChangeJournalError && error.committed) operations = next;
      throw error;
    }
    return cloneJson(result);
  }

  /** 读取并校验目标 operation，避免 mutator 对不存在条目静默成功。 */
  function requireOperation(state, operationId) {
    assertRequiredString(operationId, "operationId");
    const entry = state.get(operationId);
    if (!entry) {
      throw new ModelChangeJournalError("journal_not_found", "operation 不存在", { status: 404 });
    }
    return entry;
  }

  const journal = {
    filePath,

    /** 全局 journal 读改写锁；获得锁后总是从磁盘重新载入，消除跨实例陈旧状态。 */
    async withExclusiveLock(owner, run) {
      if (typeof run !== "function") throw schemaError("withExclusiveLock run 必须是函数");
      if (activeExclusiveLease) {
        throw new ModelChangeJournalError("journal_locked", "当前实例已持有 global lock", { status: 409 });
      }
      const lease = acquireLease(`${filePath}.lock`, owner, now, lockTtlMs);
      let result;
      let runError = null;
      try {
        operations = readState(filePath);
        activeExclusiveLease = lease;
        result = await exclusiveContext.run(lease.nonce, run);
      } catch (error) {
        runError = error;
      } finally {
        activeExclusiveLease = null;
      }
      let releaseError = null;
      try { releaseLease(lease); } catch (error) { releaseError = error; }
      if (runError) throw runError;
      if (releaseError) throw releaseError;
      return result;
    },

    /** Provider 级跨进程锁；整个 backend apply/recover 回调期间按 TTL/3 心跳续租。 */
    async withProviderLock(scope, owner, run) {
      assertRequiredString(scope, "provider scope");
      if (typeof run !== "function") throw schemaError("withProviderLock run 必须是函数");
      const scopeHash = createHash("sha256").update(scope).digest("hex").slice(0, 16);
      const lease = acquireLease(`${filePath}.provider-${scopeHash}.lock`, owner, now, lockTtlMs);
      const leaseGuard = createProviderLeaseGuard(lease, now, lockTtlMs);
      const interval = timers.setInterval(() => {
        if (leaseGuard.getLostError()) return;
        try {
          leaseGuard.guard.assertActive();
        } catch (error) {
          leaseGuard.markLost(error);
        }
      }, Math.max(1, Math.floor(lockTtlMs / 3)));
      let result;
      let runError = null;
      try {
        result = await run(leaseGuard.guard);
        leaseGuard.guard.assertActive();
      } catch (error) {
        runError = error;
      } finally {
        timers.clearInterval(interval);
      }
      let releaseError = null;
      try { releaseLease(lease); } catch (error) { releaseError = error; }
      if (runError) throw runError;
      if (leaseGuard.getLostError()) throw leaseGuard.getLostError();
      if (releaseError) throw releaseError;
      return result;
    },

    /** 建立 operation；同 ID+digest 幂等，不同 digest 冲突，preview token 跨 ID 只能消费一次。 */
    begin(entry) {
      assertMutatorAccess();
      validateEntry(entry);
      const current = operations.get(entry.operationId);
      if (current) {
        if (current.requestDigest !== entry.requestDigest) {
          throw new ModelChangeJournalError("operation_reused", "operationId 已绑定不同请求", { status: 409 });
        }
        return cloneJson(current);
      }
      for (const existing of operations.values()) {
        if (existing.previewTokenDigest === entry.previewTokenDigest) {
          throw new ModelChangeJournalError("preview_reused", "preview token 已绑定其他 operation", { status: 409 });
        }
      }
      return mutate((next) => {
        const stored = cloneJson(entry);
        next.set(stored.operationId, stored);
        return stored;
      });
    },

    /** 返回隔离副本，调用方不能绕开 mutator 修改内存状态。 */
    get(operationId) {
      assertRequiredString(operationId, "operationId");
      operations = readState(filePath);
      return cloneJson(operations.get(operationId) || null);
    },

    /** 枚举全部非终态 operation，按创建时间和 ID 稳定排序用于启动恢复。 */
    listPending() {
      operations = readState(filePath);
      return [...operations.values()]
        .filter((entry) => NON_TERMINAL.has(entry.status))
        .sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
        .map(cloneJson);
    },

    /** 更新阶段及固定白名单元数据，并强制 commitState 单向逐级推进。 */
    setStage(operationId, stage, patch = {}) {
      assertMutatorAccess();
      assertRequiredString(stage, "stage");
      if (!isPlainObject(patch)) throw schemaError("setStage patch 必须是普通对象");
      for (const key of Object.keys(patch)) {
        if (!STAGE_PATCH_FIELDS.has(key)) throw schemaError("setStage patch 包含未知字段");
      }
      assertSafeJson(patch, "setStage patch");
      return mutate((next) => {
        const entry = requireOperation(next, operationId);
        if (Object.prototype.hasOwnProperty.call(patch, "commitState")) {
          if (!COMMIT_STATES.includes(patch.commitState)) throw schemaError("commitState 不受支持");
          const before = COMMIT_STATES.indexOf(entry.commitState);
          const after = COMMIT_STATES.indexOf(patch.commitState);
          if (after < before || after > before + 1) {
            throw new ModelChangeJournalError("journal_transition", "commitState 只能单向逐级推进", { status: 409 });
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "status") && !ALL_STATUSES.has(patch.status)) {
          throw schemaError("status 不受支持");
        }
        if (Object.prototype.hasOwnProperty.call(patch, "createdProvider") && typeof patch.createdProvider !== "boolean") {
          throw schemaError("createdProvider 必须是布尔值");
        }
        if (Object.prototype.hasOwnProperty.call(patch, "secretStep")) assertRequiredString(patch.secretStep, "secretStep");
        Object.assign(entry, cloneJson(patch), { stage, updatedAt: now() });
        validateEntry(entry);
        return entry;
      });
    },

    /** 追加具备 scanner/store/referenceKey 与回读证据的固定 schema 步骤。 */
    recordStep(operationId, step) {
      assertMutatorAccess();
      validateStep(step);
      return mutate((next) => {
        const entry = requireOperation(next, operationId);
        entry.steps.push(cloneJson(step));
        entry.stage = step.stage;
        entry.updatedAt = now();
        validateEntry(entry);
        return entry;
      });
    },

    /** 写入终态或可恢复非终态结果；状态集合固定，结果仍执行深度 secret 检查。 */
    finish(operationId, status, result) {
      assertMutatorAccess();
      if (!ALL_STATUSES.has(status)) throw schemaError("finish status 不受支持");
      assertSafeJson(result, "finish result");
      return mutate((next) => {
        const entry = requireOperation(next, operationId);
        entry.status = status;
        entry.result = cloneJson(result);
        entry.updatedAt = now();
        validateEntry(entry);
        return entry;
      });
    },

    /** 显式执行终态裁剪；非终态条目不受数量和时间限制。 */
    prune() {
      assertMutatorAccess();
      const before = operations.size;
      mutate((next) => {
        pruneOperations(next, now);
        return null;
      });
      return before - operations.size;
    },
  };

  return journal;
}

module.exports = {
  ModelChangeJournalError,
  createModelChangeJournal,
  createEntry,
  isNonTerminalStatus: (status) => NON_TERMINAL.has(status),
};
