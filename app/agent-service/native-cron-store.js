"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { types: utilTypes } = require("node:util");
const { CronExpressionParser } = require("cron-parser");
const {
  atomicWritePrivateFile,
  preparePrivateParent,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { serviceError } = require("./security");

const NATIVE_CRON_STORE_VERSION = 2;
const LEGACY_NATIVE_CRON_STORE_VERSION = 1;
const MAX_NATIVE_CRON_STORE_BYTES = 64 * 1024 * 1024;
const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OPERATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MIN_EVERY_INTERVAL_MS = 60_000;
const DEFAULT_CAPACITIES = Object.freeze({ jobs: 4096, operations: 65536 });
const MISFIRE_POLICIES = new Set(["skip", "latest", "all-bounded"]);
const OVERLAP_POLICIES = new Set(["skip", "queue"]);
const THREAD_POLICIES = new Set(["new", "continue"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JOB_FIELDS = Object.freeze([
  "id", "name", "enabled", "profileId", "prompt", "workspace", "schedule",
  "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
  "nextRunAt", "createdAt", "updatedAt",
]);
const OPERATION_FIELDS = Object.freeze([
  "operationId", "kind", "fingerprint", "createdAt", "resultType", "result",
]);
const CONTAINER_FIELDS = Object.freeze([
  "version", "revision", "idempotencyFloorMs", "jobs", "operations",
]);
const CREATE_FIELDS = Object.freeze([
  "operationId", "name", "enabled", "profileId", "prompt", "workspace", "schedule",
  "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId",
  "nextRunAt", "createdAt",
]);
const UPDATE_FIELDS = Object.freeze([
  "name", "prompt", "workspace", "schedule", "misfirePolicy", "maxCatchUp",
  "overlapPolicy", "threadPolicy", "threadId", "nextRunAt",
]);
const DERIVED_UPDATE_FIELDS = Object.freeze(UPDATE_FIELDS.filter((field) => field !== "nextRunAt"));
const LEGACY_OPERATION_RESULT_TYPES = Object.freeze({
  create_job: "job",
  update_job: "job",
  set_job_enabled: "job",
  set_job_next_run_at: "job",
  delete_job: "none",
});
const OPERATION_RESULT_TYPES = Object.freeze({
  ...LEGACY_OPERATION_RESULT_TYPES,
  update_job_derived: "job",
  set_job_enabled_derived: "job",
});

function cronError(code, message) {
  return serviceError(code, message);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeOwnDataValue(target, property) {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null
      || utilTypes.isProxy(target)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    return descriptor && own(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotOwnJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)
    || ancestors.has(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("unstable JSON object");
  }
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("symbol key");
    const result = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor.enumerable !== true || !own(descriptor, "value")
        || descriptor.value === undefined) throw new TypeError("accessor or hidden field");
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotOwnJson(descriptor.value, ancestors),
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => own(value, field));
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && OPAQUE_ID_PATTERN.test(value);
}

function validText(value, maxBytes, nullable = false, allowEmpty = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && (allowEmpty || value.length > 0)
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validWorkspace(value) {
  return value === null || (validText(value, 4096) && path.isAbsolute(value));
}

function scheduleError(corrupt = false) {
  return cronError(
    corrupt ? "CRON_STORE_CORRUPT" : "CRON_SCHEDULE_INVALID",
    corrupt ? "Native Cron schedule 损坏" : "Cron schedule 输入无效",
  );
}

function normalizeScheduleData(value, corrupt = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw scheduleError(corrupt);
  if (value.kind === "at") {
    if (!exactObject(value, ["kind", "at"]) || !validTimestamp(value.at)) {
      throw scheduleError(corrupt);
    }
    return { kind: "at", at: value.at };
  }
  if (value.kind === "every") {
    if (!exactObject(value, ["kind", "everyMs", "anchorMs"])
      || !Number.isSafeInteger(value.everyMs) || value.everyMs < MIN_EVERY_INTERVAL_MS
      || !validTimestamp(value.anchorMs)) throw scheduleError(corrupt);
    return { kind: "every", everyMs: value.everyMs, anchorMs: value.anchorMs };
  }
  if (value.kind === "cron") {
    if (!exactObject(value, ["kind", "expr", "tz"])
      || !validText(value.expr, 512) || !validText(value.tz, 128)
      || /[\u0000-\u001f\u007f]/u.test(value.expr)) {
      throw scheduleError(corrupt);
    }
    try {
      // Cron 语义（字段范围、组合约束和 IANA timezone）只由固定版本 parser 判定。
      CronExpressionParser.parse(value.expr, { currentDate: new Date(0), tz: value.tz });
    } catch {
      throw scheduleError(corrupt);
    }
    return { kind: "cron", expr: value.expr, tz: value.tz };
  }
  throw scheduleError(corrupt);
}

function normalizeSchedule(value, corrupt = false) {
  let snapshot;
  try { snapshot = snapshotOwnJson(value); } catch {
    throw scheduleError(corrupt);
  }
  return normalizeScheduleData(snapshot, corrupt);
}

function computeNextOccurrence(schedule, afterMs) {
  if (!validTimestamp(afterMs)) {
    throw cronError("CRON_TIMESTAMP_INVALID", "next occurrence 基准时间无效");
  }
  const normalized = normalizeSchedule(schedule);
  if (normalized.kind === "at") return normalized.at > afterMs ? normalized.at : null;
  if (normalized.kind === "every") {
    const anchor = BigInt(normalized.anchorMs);
    const every = BigInt(normalized.everyMs);
    const after = BigInt(afterMs);
    const occurrence = after < anchor
      ? anchor
      : anchor + (((after - anchor) / every) + 1n) * every;
    return occurrence <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(occurrence) : null;
  }
  const currentDate = new Date(afterMs);
  if (!Number.isFinite(currentDate.getTime())) return null;
  try {
    const occurrence = CronExpressionParser.parse(normalized.expr, {
      currentDate,
      tz: normalized.tz,
    }).next().getTime();
    return validTimestamp(occurrence) && occurrence > afterMs ? occurrence : null;
  } catch {
    return null;
  }
}

function jobError(corrupt = false) {
  return cronError(
    corrupt ? "CRON_STORE_CORRUPT" : "CRON_JOB_INVALID",
    corrupt ? "Native Cron Job 损坏" : "Cron Job 输入无效",
  );
}

function nextRunError(corrupt = false) {
  return cronError(
    corrupt ? "CRON_STORE_CORRUPT" : "CRON_NEXT_RUN_INVALID",
    corrupt ? "Native Cron nextRunAt 与 schedule 不一致" : "nextRunAt 与 schedule 不一致",
  );
}

function normalizeJob(value, corrupt = false) {
  if (!exactObject(value, JOB_FIELDS) || !UUID_PATTERN.test(value.id)
    || !validText(value.name, 512) || typeof value.enabled !== "boolean"
    || !validOpaqueId(value.profileId) || !validText(value.prompt, 1024 * 1024)
    || !validWorkspace(value.workspace) || !MISFIRE_POLICIES.has(value.misfirePolicy)
    || !Number.isSafeInteger(value.maxCatchUp) || value.maxCatchUp < 1 || value.maxCatchUp > 100
    || !OVERLAP_POLICIES.has(value.overlapPolicy) || !THREAD_POLICIES.has(value.threadPolicy)
    || !(value.threadId === null || validOpaqueId(value.threadId, 256))
    || (value.threadPolicy === "new" && value.threadId !== null)
    || !(value.nextRunAt === null || validTimestamp(value.nextRunAt))
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt) throw jobError(corrupt);
  let schedule;
  try {
    schedule = normalizeScheduleData(value.schedule, corrupt);
  } catch (error) {
    if (corrupt && safeOwnDataValue(error, "code") !== "CRON_STORE_CORRUPT") throw jobError(true);
    throw error;
  }
  const result = {
    ...Object.fromEntries(JOB_FIELDS.map((field) => [field, value[field]])),
    schedule,
  };
  if (!result.enabled) {
    if (result.nextRunAt !== null) throw nextRunError(corrupt);
    return result;
  }
  let expected;
  try { expected = computeNextOccurrence(schedule, result.updatedAt); } catch {
    throw nextRunError(corrupt);
  }
  if (expected === null || result.nextRunAt !== expected) throw nextRunError(corrupt);
  return result;
}

function normalizeOperationShape(value, corrupt = false, resultTypes = OPERATION_RESULT_TYPES) {
  const invalid = () => cronError(
    corrupt ? "CRON_STORE_CORRUPT" : "CRON_OPERATION_INVALID",
    corrupt ? "Native Cron Operation 损坏" : "Cron operation 输入无效",
  );
  if (!exactObject(value, OPERATION_FIELDS) || !validOpaqueId(value.operationId)
    || !own(resultTypes, value.kind) || !SHA256_PATTERN.test(value.fingerprint)
    || !validTimestamp(value.createdAt) || !["job", "none"].includes(value.resultType)
    || resultTypes[value.kind] !== value.resultType
    || (value.resultType === "none" && value.result !== null)) throw invalid();
  let result = null;
  if (value.resultType === "job") {
    if (value.result === null) throw invalid();
    try { result = normalizeJob(value.result, corrupt); } catch (error) {
      if (corrupt) throw invalid();
      throw error;
    }
  }
  return {
    operationId: value.operationId,
    kind: value.kind,
    fingerprint: value.fingerprint,
    createdAt: value.createdAt,
    resultType: value.resultType,
    result,
  };
}

function normalizeOperation(value, corrupt = false) {
  return normalizeOperationShape(value, corrupt, OPERATION_RESULT_TYPES);
}

function normalizeLegacyOperation(value, corrupt = false) {
  return normalizeOperationShape(value, corrupt, LEGACY_OPERATION_RESULT_TYPES);
}

function normalizeMap(value, limit, normalize, label, idField) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length > limit) {
    throw cronError("CRON_STORE_CORRUPT", `${label} 容器损坏`);
  }
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    const item = normalize(raw, true);
    if (item[idField] !== id) throw cronError("CRON_STORE_CORRUPT", `${label} 索引损坏`);
    return [id, item];
  }));
}

function validateContainerShape(value, version, operationNormalizer) {
  if (!exactObject(value, CONTAINER_FIELDS) || value.version !== version
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !validTimestamp(value.idempotencyFloorMs)) {
    throw cronError("CRON_STORE_CORRUPT", "Native Cron 容器损坏");
  }
  const jobs = normalizeMap(value.jobs, DEFAULT_CAPACITIES.jobs, normalizeJob, "Cron Job", "id");
  const operations = normalizeMap(
    value.operations,
    DEFAULT_CAPACITIES.operations,
    operationNormalizer,
    "Cron Operation",
    "operationId",
  );
  if (Object.values(operations).some((operation) => (
    operation.createdAt < value.idempotencyFloorMs
  ))) throw cronError("CRON_STORE_CORRUPT", "Cron Operation 超出幂等窗口");
  return {
    version,
    revision: value.revision,
    idempotencyFloorMs: value.idempotencyFloorMs,
    jobs,
    operations,
  };
}

function validateContainer(value) {
  return validateContainerShape(value, NATIVE_CRON_STORE_VERSION, normalizeOperation);
}

function migrateV1Container(value, trustedTime) {
  const legacy = validateContainerShape(
    value, LEGACY_NATIVE_CRON_STORE_VERSION, normalizeLegacyOperation,
  );
  const idempotencyFloorMs = Math.max(
    legacy.idempotencyFloorMs,
    Math.max(0, trustedTime - IDEMPOTENCY_WINDOW_MS),
  );
  return validateContainer({
    ...legacy,
    version: NATIVE_CRON_STORE_VERSION,
    revision: legacy.revision + 1,
    idempotencyFloorMs,
    operations: Object.fromEntries(Object.entries(legacy.operations)
      .filter(([, operation]) => operation.createdAt >= idempotencyFloorMs)),
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function fingerprintOperation(kind, input) {
  let snapshot;
  try { snapshot = snapshotOwnJson(input); } catch {
    throw cronError("CRON_OPERATION_INVALID", "Cron operation 输入无效");
  }
  return fingerprintOperationData(kind, snapshot);
}

function fingerprintOperationData(kind, input) {
  return crypto.createHash("sha256").update(canonicalJson({ kind, input })).digest("hex");
}

function assertNoSensitive(value, matcher, location = "payload", seen = new Set()) {
  if (typeof value === "string") {
    if (matcher) {
      let sensitive;
      try { sensitive = matcher(value); } catch {
        throw cronError("CRON_SENSITIVE_CHECK_FAILED", "敏感值判定器执行失败");
      }
      if (sensitive === true) throw cronError("CRON_SENSITIVE_VALUE", "拒绝持久化敏感值");
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw cronError("CRON_INVALID_JSON", `${location} 不是可持久化 JSON`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitive(item, matcher, `${location}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (["token", "apikey", "authorization", "secret", "password", "credential", "privatekey", "cookie"]
        .some((term) => normalized.includes(term))) {
        throw cronError("CRON_SENSITIVE_FIELD", `拒绝持久化敏感字段: ${location}.${key}`);
      }
      assertNoSensitive(item, matcher, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizeCapacities(input) {
  if (input === undefined) return { ...DEFAULT_CAPACITIES };
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some((key) => !own(DEFAULT_CAPACITIES, key))) {
    throw cronError("CRON_CAPACITY_INVALID", "Cron 容量配置无效");
  }
  const result = { ...DEFAULT_CAPACITIES };
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_CAPACITIES[key]) {
      throw cronError("CRON_CAPACITY_INVALID", "Cron 容量配置无效");
    }
    result[key] = value;
  }
  return result;
}

class NativeCronStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot) {
      throw cronError("CRON_PATHS_REQUIRED", "NativeCronStore 需要 Service paths");
    }
    if (typeof options.profileExists !== "function") {
      throw cronError("CRON_REFERENCE_RESOLVER_REQUIRED", "NativeCronStore 需要 Profile resolver");
    }
    if (options.isSensitiveValue !== undefined && typeof options.isSensitiveValue !== "function") {
      throw cronError("CRON_OPTIONS_INVALID", "isSensitiveValue 必须是函数");
    }
    this.paths = options.paths;
    this.filePath = path.join(this.paths.stateDir, "native-cron.json");
    this.fs = options.fs || fs;
    this.atomicWrite = options.atomicWrite || atomicWritePrivateFile;
    this.acquireWriterLease = options.acquireWriterLease || acquirePrivateWriterLease;
    this.profileExists = options.profileExists;
    this.isSensitiveValue = options.isSensitiveValue || null;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.capacities = normalizeCapacities(options.capacities);
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
    this.commitUncertain = false;
    this.container = this.#emptyContainer();
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot, this.fs);
    const lease = this.acquireWriterLease({
      lockPath: path.join(this.paths.stateDir, "native-cron.writer.lock"),
      trustedRoot: this.paths.trustedRoot,
      fs: this.fs,
    });
    try {
      const recovery = recoverInterruptedPrivateFile(this.filePath, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      if (recovery === "uncertain") {
        // 先保留 recovery 证据与 writer ownership，避免 matcher/parse/resolver
        // 的次级失败覆盖 CRON_COMMIT_UNCERTAIN；Service cleanup 可正常 close。
        this.container = this.#emptyContainer();
        this.commitUncertain = true;
        this.writerLease = lease;
        this.cleanupPending = false;
        this.opened = true;
        return this;
      }
      const stat = statIfExists(this.fs, this.filePath);
      const openTime = this.#currentTime();
      const parsed = stat ? this.#parse(readPrivateFile(this.filePath, {
        fs: this.fs,
        maxBytes: MAX_NATIVE_CRON_STORE_BYTES,
      }), openTime) : { container: this.#emptyContainer(), migrated: false };
      this.container = parsed.container;
      assertNoSensitive(this.container, this.isSensitiveValue);
      this.#assertExternalReferences(this.container);
      this.commitUncertain = false;
      if (parsed.migrated) this.container = this.#write(this.container);
      else this.#refreshWindow(openTime, Boolean(stat));
      this.writerLease = lease;
      this.cleanupPending = false;
      this.opened = true;
      return this;
    } catch (openError) {
      try {
        lease.release();
      } catch (releaseError) {
        this.writerLease = lease;
        this.cleanupPending = true;
        const cleanupError = cronError("LEASE_RELEASE_FAILED", "NativeCronStore writer lease 清理失败");
        cleanupError.cause = releaseError;
        throw new AggregateError([openError, cleanupError], "NativeCronStore open 与 lease 清理均失败");
      }
      this.writerLease = null;
      this.cleanupPending = false;
      throw openError;
    }
  }

  close() {
    const lease = this.writerLease;
    if (lease) {
      try { lease.release(); } catch (error) {
        this.cleanupPending = true;
        throw error;
      }
    }
    this.writerLease = null;
    this.cleanupPending = false;
    this.opened = false;
    this.commitUncertain = false;
    this.container = this.#emptyContainer();
  }

  createJob(input) {
    input = this.#assertMutationBase(input, CREATE_FIELDS);
    const schedule = normalizeScheduleData(input.schedule);
    const jobInput = { ...input, schedule };
    if (!validOpaqueId(input.profileId)) throw cronError("CRON_JOB_INVALID", "createJob 输入无效");
    this.#validateJobInput(jobInput);
    return this.#mutate("create_job", jobInput, (candidate) => {
      if (!this.#profileExists(input.profileId)) {
        throw cronError("CRON_REFERENCE_INVALID", "Cron Job.profileId 不存在");
      }
      this.#assertCapacity(candidate, "jobs");
      const job = normalizeJob({
        id: this.#newId(candidate.jobs),
        name: input.name,
        enabled: input.enabled,
        profileId: input.profileId,
        prompt: input.prompt,
        workspace: input.workspace,
        schedule,
        misfirePolicy: input.misfirePolicy,
        maxCatchUp: input.maxCatchUp,
        overlapPolicy: input.overlapPolicy,
        threadPolicy: input.threadPolicy,
        threadId: input.threadId,
        nextRunAt: input.nextRunAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      candidate.jobs[job.id] = job;
      return job;
    });
  }

  updateJob(input) {
    input = this.#assertMutationBase(input, ["operationId", "jobId", "patch", "createdAt"]);
    if (!UUID_PATTERN.test(input.jobId) || !this.#validPatch(input.patch)
      || (own(input.patch, "schedule") && !own(input.patch, "nextRunAt"))) {
      throw cronError("CRON_JOB_INVALID", "updateJob 输入无效");
    }
    const patch = clone(input.patch);
    if (own(patch, "schedule")) patch.schedule = normalizeScheduleData(patch.schedule);
    return this.#mutate("update_job", { ...input, patch }, (candidate) => {
      const job = candidate.jobs[input.jobId];
      if (!job) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      const updated = normalizeJob({
        ...job,
        ...patch,
        updatedAt: Math.max(job.updatedAt, input.createdAt),
      });
      candidate.jobs[job.id] = updated;
      return updated;
    });
  }

  updateJobDerived(input) {
    input = this.#assertMutationBase(input, ["operationId", "jobId", "patch", "createdAt"]);
    if (!UUID_PATTERN.test(input.jobId) || !this.#validPatch(input.patch, DERIVED_UPDATE_FIELDS)) {
      throw cronError("CRON_JOB_INVALID", "updateJobDerived 输入无效");
    }
    const patch = clone(input.patch);
    if (own(patch, "schedule")) patch.schedule = normalizeScheduleData(patch.schedule);
    return this.#mutate("update_job_derived", { ...input, patch }, (candidate) => {
      const job = candidate.jobs[input.jobId];
      if (!job) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      const updatedAt = Math.max(job.updatedAt, input.createdAt);
      const merged = { ...job, ...patch, updatedAt };
      // Controller 级输入不携带派生字段；在同一候选快照中从最终状态固定 nextRunAt。
      const nextRunAt = merged.enabled
        ? computeNextOccurrence(merged.schedule, updatedAt)
        : null;
      const updated = normalizeJob({ ...merged, nextRunAt });
      candidate.jobs[job.id] = updated;
      return updated;
    });
  }

  setJobEnabled(input) {
    input = this.#assertMutationBase(input, [
      "operationId", "jobId", "enabled", "nextRunAt", "createdAt",
    ]);
    if (!UUID_PATTERN.test(input.jobId) || typeof input.enabled !== "boolean"
      || !(input.nextRunAt === null || validTimestamp(input.nextRunAt))
      || (!input.enabled && input.nextRunAt !== null)) {
      throw cronError("CRON_NEXT_RUN_INVALID", "nextRunAt 与 enabled 不一致");
    }
    return this.#mutate("set_job_enabled", input, (candidate) => {
      const job = candidate.jobs[input.jobId];
      if (!job) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      const updated = normalizeJob({
        ...job,
        enabled: input.enabled,
        nextRunAt: input.nextRunAt,
        updatedAt: Math.max(job.updatedAt, input.createdAt),
      });
      candidate.jobs[job.id] = updated;
      return updated;
    });
  }

  setJobEnabledDerived(input) {
    input = this.#assertMutationBase(input, ["operationId", "jobId", "enabled", "createdAt"]);
    if (!UUID_PATTERN.test(input.jobId) || typeof input.enabled !== "boolean") {
      throw cronError("CRON_JOB_INVALID", "setJobEnabledDerived 输入无效");
    }
    return this.#mutate("set_job_enabled_derived", input, (candidate) => {
      const job = candidate.jobs[input.jobId];
      if (!job) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      const updatedAt = Math.max(job.updatedAt, input.createdAt);
      const nextRunAt = input.enabled
        ? computeNextOccurrence(job.schedule, updatedAt)
        : null;
      const updated = normalizeJob({
        ...job,
        enabled: input.enabled,
        nextRunAt,
        updatedAt,
      });
      candidate.jobs[job.id] = updated;
      return updated;
    });
  }

  setJobNextRunAt(input) {
    input = this.#assertMutationBase(input, ["operationId", "jobId", "nextRunAt", "createdAt"]);
    if (!UUID_PATTERN.test(input.jobId)
      || !(input.nextRunAt === null || validTimestamp(input.nextRunAt))) {
      throw cronError("CRON_JOB_INVALID", "setJobNextRunAt 输入无效");
    }
    return this.#mutate("set_job_next_run_at", input, (candidate) => {
      const job = candidate.jobs[input.jobId];
      if (!job) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      if (!job.enabled && input.nextRunAt !== null) {
        throw cronError("CRON_NEXT_RUN_INVALID", "停用 Job 不能设置 nextRunAt");
      }
      const updated = normalizeJob({
        ...job,
        nextRunAt: input.nextRunAt,
        updatedAt: Math.max(job.updatedAt, input.createdAt),
      });
      candidate.jobs[job.id] = updated;
      return updated;
    });
  }

  deleteJob(input) {
    input = this.#assertMutationBase(input, ["operationId", "jobId", "createdAt"]);
    if (!UUID_PATTERN.test(input.jobId)) {
      throw cronError("CRON_JOB_INVALID", "deleteJob 输入无效");
    }
    return this.#mutate("delete_job", input, (candidate) => {
      if (!candidate.jobs[input.jobId]) throw cronError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
      delete candidate.jobs[input.jobId];
      return null;
    });
  }

  purgeProfile(profileId) {
    this.#assertOpen();
    if (!validOpaqueId(profileId)) throw cronError("CRON_JOB_INVALID", "Profile 无效");
    const candidate = { ...this.container, revision: this.container.revision + 1 };
    candidate.jobs = Object.fromEntries(Object.entries(this.container.jobs)
      .filter(([, job]) => job.profileId !== profileId));
    candidate.operations = Object.fromEntries(Object.entries(this.container.operations)
      .filter(([, operation]) => operation.result?.profileId !== profileId));
    this.container = this.#write(candidate);
  }

  getJob(jobId) {
    this.#assertOpen();
    if (!UUID_PATTERN.test(jobId)) throw cronError("CRON_JOB_INVALID", "jobId 无效");
    return clone(this.container.jobs[jobId] || null);
  }

  listJobs(query = {}) {
    this.#assertOpen();
    if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.getPrototypeOf(query) !== Object.prototype
      || Object.keys(query).some((key) => !["profileId", "enabled"].includes(key))
      || (own(query, "profileId") && !validOpaqueId(query.profileId))
      || (own(query, "enabled") && typeof query.enabled !== "boolean")) {
      throw cronError("CRON_JOB_INVALID", "Cron Job 查询无效");
    }
    return Object.values(this.container.jobs).map(clone)
      .filter((job) => !own(query, "profileId") || job.profileId === query.profileId)
      .filter((job) => !own(query, "enabled") || job.enabled === query.enabled)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  #assertMutationBase(input, fields) {
    this.#assertOpen();
    let snapshot;
    try { snapshot = snapshotOwnJson(input); } catch {
      throw cronError("CRON_OPERATION_INVALID", "Cron operation 输入无效");
    }
    assertNoSensitive(snapshot, this.isSensitiveValue);
    if (!exactObject(snapshot, fields) || !validOpaqueId(snapshot.operationId)
      || !validTimestamp(snapshot.createdAt)) {
      throw cronError("CRON_OPERATION_INVALID", "Cron operation 输入无效");
    }
    return snapshot;
  }

  #validateJobInput(input) {
    try {
      normalizeJob({
        id: "00000000-0000-4000-8000-000000000000",
        ...Object.fromEntries(JOB_FIELDS.slice(1).map((field) => [
          field,
          field === "updatedAt" ? input.createdAt : input[field],
        ])),
      });
    } catch (error) {
      if (["CRON_SCHEDULE_INVALID", "CRON_NEXT_RUN_INVALID"]
        .includes(safeOwnDataValue(error, "code"))) throw error;
      throw cronError("CRON_JOB_INVALID", "createJob 输入无效");
    }
  }

  #validPatch(value, allowedFields = UPDATE_FIELDS) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length === 0
      || Object.keys(value).some((key) => !allowedFields.includes(key))) return false;
    if (own(value, "name") && !validText(value.name, 512)) return false;
    if (own(value, "prompt") && !validText(value.prompt, 1024 * 1024)) return false;
    if (own(value, "workspace") && !validWorkspace(value.workspace)) return false;
    if (own(value, "misfirePolicy") && !MISFIRE_POLICIES.has(value.misfirePolicy)) return false;
    if (own(value, "maxCatchUp") && (!Number.isSafeInteger(value.maxCatchUp)
      || value.maxCatchUp < 1 || value.maxCatchUp > 100)) return false;
    if (own(value, "overlapPolicy") && !OVERLAP_POLICIES.has(value.overlapPolicy)) return false;
    if (own(value, "threadPolicy") && !THREAD_POLICIES.has(value.threadPolicy)) return false;
    if (own(value, "threadId") && !(value.threadId === null || validOpaqueId(value.threadId, 256))) {
      return false;
    }
    if (own(value, "nextRunAt") && !(value.nextRunAt === null || validTimestamp(value.nextRunAt))) {
      return false;
    }
    return true;
  }

  #mutate(kind, input, apply) {
    const fingerprint = fingerprintOperationData(kind, input);
    const existing = own(this.container.operations, input.operationId)
      ? this.container.operations[input.operationId] : null;
    if (existing && (existing.kind !== kind || existing.fingerprint !== fingerprint)) {
      throw cronError("CRON_OPERATION_ID_CONFLICT", "operationId 已用于不同操作");
    }
    let time;
    try { time = this.#currentTime(); } catch (error) {
      if (existing && existing.createdAt >= this.container.idempotencyFloorMs) {
        return clone(existing.result);
      }
      throw error;
    }
    const windowCandidate = this.#windowCandidate(time);
    if (existing && existing.createdAt >= windowCandidate.idempotencyFloorMs) {
      return clone(existing.result);
    }
    if (input.createdAt > time + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw cronError("CRON_TIMESTAMP_INVALID", "operation createdAt 超出未来时钟偏差");
    }
    if (input.createdAt <= windowCandidate.idempotencyFloorMs) {
      throw cronError("CRON_OPERATION_EXPIRED", "operation 已超出 30 天幂等窗口");
    }
    this.#assertCapacity(windowCandidate, "operations");
    // window 推进与业务 mutation 共用一个局部候选；known failure 不污染内存或磁盘。
    const candidate = clone(windowCandidate);
    const result = apply(candidate);
    candidate.operations[input.operationId] = normalizeOperation({
      operationId: input.operationId,
      kind,
      fingerprint,
      createdAt: input.createdAt,
      resultType: result === null ? "none" : "job",
      result,
    });
    candidate.revision += 1;
    this.container = this.#write(candidate);
    return clone(candidate.operations[input.operationId].result);
  }

  #assertCapacity(candidate, key) {
    if (Object.keys(candidate[key]).length >= this.capacities[key]) {
      throw cronError("CRON_CAPACITY", `${key} 容量已满`);
    }
  }

  #profileExists(profileId) {
    try { return this.profileExists(profileId) === true; } catch {
      throw cronError("CRON_REFERENCE_CHECK_FAILED", "Profile 引用校验失败");
    }
  }

  #assertExternalReferences(candidate) {
    for (const job of Object.values(candidate.jobs)) {
      if (!this.#profileExists(job.profileId)) {
        throw cronError("CRON_REFERENCE_INVALID", "Cron Job.profileId 不存在");
      }
    }
  }

  #newId(map) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.randomUUID();
      if (UUID_PATTERN.test(id) && !own(map, id)) return id;
    }
    throw cronError("CRON_ID_CONFLICT", "无法生成唯一 Cron Job ID");
  }

  #currentTime() {
    let value;
    try { value = this.now(); } catch {
      throw cronError("CRON_TIMESTAMP_INVALID", "本地时钟无效");
    }
    if (!validTimestamp(value) || value > Number.MAX_SAFE_INTEGER - MAX_OPERATION_FUTURE_SKEW_MS) {
      throw cronError("CRON_TIMESTAMP_INVALID", "本地时钟无效");
    }
    return value;
  }

  #refreshWindow(time, persist = true) {
    const candidate = this.#windowCandidate(time, persist);
    if (candidate === this.container) return;
    this.container = persist ? this.#write(candidate) : validateContainer(candidate);
  }

  #windowCandidate(time, persist = false) {
    const floor = Math.max(
      this.container.idempotencyFloorMs,
      Math.max(0, time - IDEMPOTENCY_WINDOW_MS),
    );
    const operations = Object.fromEntries(Object.entries(this.container.operations)
      .filter(([, operation]) => operation.createdAt >= floor));
    if (floor === this.container.idempotencyFloorMs
      && Object.keys(operations).length === Object.keys(this.container.operations).length) {
      return this.container;
    }
    return {
      ...this.container,
      revision: persist ? this.container.revision + 1 : this.container.revision,
      idempotencyFloorMs: floor,
      operations,
    };
  }

  #parse(bytes, trustedTime) {
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value?.version === LEGACY_NATIVE_CRON_STORE_VERSION) {
        return { container: migrateV1Container(value, trustedTime), migrated: true };
      }
      return { container: validateContainer(value), migrated: false };
    } catch (error) {
      const code = safeOwnDataValue(error, "code");
      if (code === "CRON_STORE_CORRUPT") throw error;
      if (typeof code === "string" && code.startsWith("UNSAFE_")) throw error;
      throw cronError("CRON_STORE_CORRUPT", "Native Cron 容器损坏");
    }
  }

  #write(candidate) {
    const validated = validateContainer(candidate);
    this.#assertExternalReferences(validated);
    assertNoSensitive(validated, this.isSensitiveValue);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_CRON_STORE_BYTES) {
      throw cronError("CRON_CAPACITY", "Native Cron 文件容量已满");
    }
    try {
      this.atomicWrite(this.filePath, serialized, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    } catch (error) {
      if (safeOwnDataValue(error, "committed") === true) return validated;
      if (safeOwnDataValue(error, "committedUncertain") === true) {
        this.commitUncertain = true;
        this.container = this.#emptyContainer();
        const uncertain = cronError(
          "CRON_COMMIT_UNCERTAIN", "Native Cron 提交状态不确定，必须重新打开",
        );
        uncertain.committedUncertain = true;
        throw uncertain;
      }
      const code = safeOwnDataValue(error, "code");
      if (typeof code === "string" && code.startsWith("UNSAFE_")) throw error;
      throw cronError("CRON_WRITE_FAILED", "Native Cron 写入失败");
    }
    return validated;
  }

  #emptyContainer() {
    return {
      version: NATIVE_CRON_STORE_VERSION,
      revision: 0,
      idempotencyFloorMs: 0,
      jobs: {},
      operations: {},
    };
  }

  #assertOpen() {
    if (this.commitUncertain) {
      throw cronError("CRON_COMMIT_UNCERTAIN", "Native Cron 提交状态不确定，必须重新打开");
    }
    if (!this.opened) throw cronError("CRON_STORE_CLOSED", "NativeCronStore 未打开");
  }
}

module.exports = {
  DEFAULT_CAPACITIES,
  IDEMPOTENCY_WINDOW_MS,
  MAX_NATIVE_CRON_STORE_BYTES,
  MAX_OPERATION_FUTURE_SKEW_MS,
  MIN_EVERY_INTERVAL_MS,
  MISFIRE_POLICIES,
  NATIVE_CRON_STORE_VERSION,
  NativeCronStore,
  OVERLAP_POLICIES,
  THREAD_POLICIES,
  computeNextOccurrence,
  fingerprintOperation,
  normalizeSchedule,
  validateContainer,
};
