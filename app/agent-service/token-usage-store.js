"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  atomicWritePrivateFile,
  openExistingPrivateFile,
  preparePrivateParent,
  readPrivateFile,
  statIfExists,
  writeFully,
} = require("./private-file");
const { validateTokenUsageSummary, validateUsageRange } = require("./token-usage-protocol");
const { resolveUsageCost, validUsd } = require("../core/usage-cost");

const STORE_VERSION = 1;
const DEFAULT_MAX_RECORDS = 200_000;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_MODEL_ROWS = 24;
const MAX_AGENT_ROWS = 32;
const MAX_MODEL_TIMELINE_ROWS = 240;
const MAX_PROFILE_SCOPE_SIZE = 8192;
const SOURCES = new Set(["chat", "kanban", "cron", "inspiration"]);
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const USAGE_FIELDS = Object.freeze([
  "totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
  "outputTokens", "reasoningOutputTokens",
]);
const RECORD_FIELDS = Object.freeze([
  "id", "profileId", "agentId", "agentName", "source", "sourceId", "threadId", "turnId",
  "model", "provider", ...USAGE_FIELDS, "createdAt",
]);

function usageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function safeString(value, field, maxBytes = 512, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw usageError("TOKEN_USAGE_INVALID", `${field} 无效`);
  }
}

function safeCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw usageError("TOKEN_USAGE_INVALID", `${field} 无效`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function recordChecksum(record) {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function recordIdentity(input) {
  return `usage-${crypto.createHash("sha256").update(JSON.stringify([
    input.threadId, input.turnId, input.responseId,
  ])).digest("hex")}`;
}

function validateRecord(value) {
  if (!exactObject(value, RECORD_FIELDS) && !exactObject(value, [...RECORD_FIELDS, "costUsd"])) {
    throw usageError("TOKEN_USAGE_INVALID", "Token usage record 字段无效");
  }
  safeString(value.id, "id", 70);
  if (!/^usage-[a-f0-9]{64}$/u.test(value.id)) {
    throw usageError("TOKEN_USAGE_INVALID", "Token usage record id 无效");
  }
  safeString(value.profileId, "profileId", 128);
  safeString(value.agentId, "agentId", 128);
  safeString(value.agentName, "agentName", 512);
  if (!SOURCES.has(value.source)) throw usageError("TOKEN_USAGE_INVALID", "source 无效");
  safeString(value.sourceId, "sourceId", 512);
  safeString(value.threadId, "threadId", 512);
  safeString(value.turnId, "turnId", 512);
  safeString(value.model, "model", 512, true);
  safeString(value.provider, "provider", 512, true);
  for (const field of USAGE_FIELDS) safeCount(value[field], field);
  if (Object.hasOwn(value, "costUsd") && !validUsd(value.costUsd)) throw usageError("TOKEN_USAGE_INVALID", "costUsd 无效");
  safeCount(value.createdAt, "createdAt");
  return clone(value);
}

function validateRecordInput(input) {
  const fields = [
    "profileId", "agentId", "agentName", "source", "sourceId", "threadId", "turnId",
    "responseId", "model", "provider", "usage", "createdAt",
  ];
  if ((!exactObject(input, fields) && !exactObject(input, [...fields, "costUsd"])) || !exactObject(input.usage, USAGE_FIELDS)) {
    throw usageError("TOKEN_USAGE_INVALID", "Token usage 输入无效");
  }
  safeString(input.responseId, "responseId", 512);
  return validateRecord({
    id: recordIdentity(input),
    profileId: input.profileId,
    agentId: input.agentId,
    agentName: input.agentName,
    source: input.source,
    sourceId: input.sourceId,
    threadId: input.threadId,
    turnId: input.turnId,
    model: input.model,
    provider: input.provider,
    ...input.usage,
    createdAt: input.createdAt,
    ...(Object.hasOwn(input, "costUsd") ? { costUsd: input.costUsd } : {}),
  });
}

function dayString(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timelineDate(timestamp, range) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  if (range === "1y") {
    // UI 的一年视图本来就按周展示；在 Service 侧先收敛，避免 64KB IPC
    // 帧随着历史增长失效。周一作为稳定桶起点。
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  } else if (range === "all") {
    // 全部历史按月展示。总计仍覆盖全部记录，只收敛趋势明细。
    date.setDate(1);
  }
  return dayString(date.getTime());
}

function rangeStart(range, now) {
  if (range === "all") return 0;
  const days = { today: 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[range];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return start.getTime();
}

function emptyParts() {
  return {
    totalTokens: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

function displayParts(record) {
  const parts = {
    totalTokens: record.totalTokens,
    totalCost: 0,
    inputTokens: Math.max(
      0,
      record.inputTokens - record.cachedInputTokens - record.cacheWriteInputTokens,
    ),
    outputTokens: Math.max(0, record.outputTokens - record.reasoningOutputTokens),
    cacheReadTokens: record.cachedInputTokens,
    cacheWriteTokens: record.cacheWriteInputTokens,
    reasoningTokens: record.reasoningOutputTokens,
  };
  const resolved = resolveUsageCost(record, parts);
  parts.totalCost = resolved.cost ?? 0;
  return { parts, missing: resolved.cost === null, estimated: resolved.estimated };
}

function addParts(target, parts) {
  for (const field of [
    "totalTokens", "totalCost", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
  ]) target[field] += parts[field];
  return target;
}

function mapRow(map, key, create, parts) {
  const row = map.get(key) || create();
  addParts(row, parts);
  map.set(key, row);
  return row;
}

function summaryScope(options) {
  if (options === undefined) return { backendId: "shoggoth", profileIds: null };
  if (!exactObject(options, ["backendId", "profileIds"])
    || typeof options.backendId !== "string" || !BACKEND_ID_PATTERN.test(options.backendId)
    || !(options.profileIds instanceof Set) || options.profileIds.size > MAX_PROFILE_SCOPE_SIZE) {
    throw usageError("TOKEN_USAGE_INVALID", "Token usage 归属范围无效");
  }
  const profileIds = new Set();
  for (const profileId of options.profileIds) {
    safeString(profileId, "profileId", 128);
    profileIds.add(profileId);
  }
  return { backendId: options.backendId, profileIds };
}

class TokenUsageStore {
  constructor(options = {}) {
    if (!options.paths?.stateDir || !options.paths?.trustedRoot || !options.paths?.tokenUsagePath) {
      throw usageError("TOKEN_USAGE_PATHS_REQUIRED", "TokenUsageStore 需要完整 Service paths");
    }
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.isSensitiveValue = options.isSensitiveValue || null;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1
      || this.maxRecords > DEFAULT_MAX_RECORDS
      || !Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1024
      || this.maxFileBytes > DEFAULT_MAX_FILE_BYTES
      || (this.isSensitiveValue !== null && typeof this.isSensitiveValue !== "function")) {
      throw usageError("TOKEN_USAGE_INVALID_OPTIONS", "TokenUsageStore 配置无效");
    }
    this.records = new Map();
    this.opened = false;
    this.commitUncertain = false;
  }

  open() {
    if (this.opened) return this;
    preparePrivateParent(this.paths.tokenUsagePath, this.paths.trustedRoot, this.fs);
    if (!statIfExists(this.fs, this.paths.tokenUsagePath)) {
      atomicWritePrivateFile(this.paths.tokenUsagePath, "", {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
    }
    this.records.clear();
    this.commitUncertain = false;
    const bytes = readPrivateFile(this.paths.tokenUsagePath, {
      fs: this.fs,
      maxBytes: this.maxFileBytes,
    });
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeLength = lastNewline < 0 ? 0 : lastNewline + 1;
    const complete = bytes.subarray(0, completeLength).toString("utf8");
    const lines = complete.length === 0 ? [] : complete.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      let envelope;
      try { envelope = JSON.parse(lines[index]); } catch {
        throw usageError("TOKEN_USAGE_STORE_CORRUPT", `token-usage 第 ${index + 1} 行不是 JSON`);
      }
      if (!exactObject(envelope, ["version", "record", "checksum"])
        || envelope.version !== STORE_VERSION || typeof envelope.checksum !== "string") {
        throw usageError("TOKEN_USAGE_STORE_CORRUPT", "Token usage envelope 无效");
      }
      const record = validateRecord(envelope.record);
      if (envelope.checksum !== recordChecksum(record)) {
        throw usageError("TOKEN_USAGE_STORE_CORRUPT", "Token usage checksum 无效");
      }
      const existing = this.records.get(record.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw usageError("TOKEN_USAGE_STORE_CORRUPT", "Token usage id 冲突");
      }
      this.records.set(record.id, record);
      if (this.records.size > this.maxRecords) {
        throw usageError("TOKEN_USAGE_STORE_CORRUPT", "Token usage 容量超限");
      }
    }
    if (completeLength !== bytes.length) {
      const fd = openExistingPrivateFile(
        this.paths.tokenUsagePath,
        this.fs.constants.O_RDWR,
        this.fs,
      );
      try {
        this.fs.ftruncateSync(fd, completeLength);
        this.fs.fsyncSync(fd);
      } finally { this.fs.closeSync(fd); }
    }
    this.opened = true;
    return this;
  }

  close() {
    this.opened = false;
  }

  #assertOpen() {
    if (!this.opened) throw usageError("TOKEN_USAGE_STORE_CLOSED", "TokenUsageStore 未打开");
    if (this.commitUncertain) {
      throw usageError("TOKEN_USAGE_COMMIT_UNCERTAIN", "Token usage 提交状态不确定");
    }
  }

  #assertSafe(record) {
    if (!this.isSensitiveValue) return;
    for (const value of [
      record.profileId, record.agentId, record.agentName, record.sourceId,
      record.threadId, record.turnId, record.model, record.provider,
    ]) {
      if (value !== null && this.isSensitiveValue(value) === true) {
        throw usageError("TOKEN_USAGE_SENSITIVE_VALUE", "Token usage 含已登记敏感值");
      }
    }
  }

  record(input) {
    this.#assertOpen();
    const normalized = validateRecordInput(input);
    this.#assertSafe(normalized);
    const existing = this.records.get(normalized.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw usageError("TOKEN_USAGE_ID_CONFLICT", "Token usage response id 已用于其他数据");
      }
      return clone(existing);
    }
    if (this.records.size >= this.maxRecords) {
      throw usageError("TOKEN_USAGE_CAPACITY", "Token usage 容量已满");
    }
    const envelope = {
      version: STORE_VERSION,
      record: normalized,
      checksum: recordChecksum(normalized),
    };
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024) {
      throw usageError("TOKEN_USAGE_INVALID", "Token usage record 超过行上限");
    }
    const fd = openExistingPrivateFile(
      this.paths.tokenUsagePath,
      this.fs.constants.O_WRONLY | this.fs.constants.O_APPEND,
      this.fs,
    );
    let writeAttempted = false;
    let operationError = null;
    let closeError = null;
    try {
      writeAttempted = true;
      writeFully(this.fs, fd, line, "TOKEN_USAGE_WRITE_FAILED");
      this.fs.fsyncSync(fd);
    } catch (error) { operationError = error; }
    try { this.fs.closeSync(fd); } catch (error) { closeError = error; }
    if (operationError || closeError) {
      if (writeAttempted) {
        this.commitUncertain = true;
        throw usageError("TOKEN_USAGE_COMMIT_UNCERTAIN", "Token usage 提交状态不确定");
      }
      throw operationError || closeError;
    }
    this.records.set(normalized.id, normalized);
    return clone(normalized);
  }

  purgeProfile(profileId) {
    this.#assertOpen();
    safeString(profileId, "profileId", 128);
    const records = new Map([...this.records].filter(([, record]) => record.profileId !== profileId));
    if (records.size === this.records.size) return;
    const text = [...records.values()].map((record) => `${JSON.stringify({
      version: STORE_VERSION, record, checksum: recordChecksum(record),
    })}\n`).join("");
    try {
      atomicWritePrivateFile(this.paths.tokenUsagePath, text, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
    } catch (error) {
      if (error?.committed !== true) {
        if (error?.committedUncertain) this.commitUncertain = true;
        throw error;
      }
    }
    this.records = records;
  }

  list(query = {}) {
    this.#assertOpen();
    if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.getPrototypeOf(query) !== Object.prototype
      || Object.keys(query).some((field) => !["threadId", "turnId", "profileId"].includes(field))) {
      throw usageError("TOKEN_USAGE_INVALID", "Token usage 查询无效");
    }
    let records = [...this.records.values()];
    for (const field of ["threadId", "turnId", "profileId"]) {
      if (query[field] !== undefined) {
        safeString(query[field], field, 512);
        records = records.filter((record) => record[field] === query[field]);
      }
    }
    return records.sort((left, right) => left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)).map(clone);
  }

  summarize(rawRange = "30d", options) {
    this.#assertOpen();
    const range = validateUsageRange(rawRange);
    const scope = summaryScope(options);
    const cutoff = rangeStart(range, this.now());
    const records = [...this.records.values()].filter((record) => record.createdAt >= cutoff
      && (scope.profileIds === null || scope.profileIds.has(record.profileId)));
    const totals = emptyParts();
    const daily = new Map();
    const byModel = new Map();
    const byAgent = new Map();
    const bySession = new Map();
    const modelDaily = new Map();
    let missingCostEntries = 0;
    let estimatedCostEntries = 0;
    for (const record of records) {
      const { parts, missing, estimated } = displayParts(record);
      if (missing) missingCostEntries++;
      if (estimated) estimatedCostEntries++;
      addParts(totals, parts);
      const date = timelineDate(record.createdAt, range);
      mapRow(daily, date, () => ({ date, ...emptyParts() }), parts);
      const model = record.model || "unknown";
      const modelKey = `${model}\0${record.provider || ""}`;
      const modelRow = mapRow(byModel, modelKey, () => ({
        model,
        provider: record.provider,
        count: 0,
        ...emptyParts(),
      }), parts);
      modelRow.count += 1;
      mapRow(byAgent, record.agentId, () => ({
        agentId: record.agentId,
        agentName: record.agentName,
        profileId: record.profileId,
        model: record.model,
        provider: record.provider,
        ...emptyParts(),
      }), parts);
      const modelDayKey = `${date}\0${model}\0${record.provider || ""}`;
      const dayModel = modelDaily.get(modelDayKey) || {
        date,
        model,
        provider: record.provider,
        tokens: 0,
        cost: 0,
      };
      dayModel.tokens += record.totalTokens;
      dayModel.cost += parts.totalCost;
      modelDaily.set(modelDayKey, dayModel);
      const sessionKey = `${record.source}\0${record.sourceId}`;
      const session = bySession.get(sessionKey) || {
        key: `${scope.backendId}:${record.source}:${record.sourceId}`,
        label: record.source === "chat" ? `${record.agentName} · Chat` : `${record.agentName} · ${record.source}`,
        sessionId: record.sourceId,
        agentId: record.agentId,
        model: record.model,
        modelTokens: new Map(),
        totalTokens: 0,
        totalCost: 0,
        updatedAt: 0,
      };
      session.totalTokens += record.totalTokens;
      session.totalCost += parts.totalCost;
      session.updatedAt = Math.max(session.updatedAt, record.createdAt);
      session.model = record.model || session.model;
      session.modelTokens.set(model, (session.modelTokens.get(model) || 0) + record.totalTokens);
      bySession.set(sessionKey, session);
    }
    const completeTotals = { ...totals, missingCostEntries, estimatedCostEntries };
    const agentRows = [...byAgent.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const summary = {
      series: {
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
        totals: { ...completeTotals },
      },
      breakdown: {
        byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, MAX_MODEL_ROWS),
        byAgent: agentRows.map(({ agentId, agentName: _name, profileId: _profile, model: _model,
          provider: _provider, ...parts }) => ({ agentId, ...parts })).slice(0, MAX_AGENT_ROWS),
        bySource: agentRows.map((row) => ({
          id: row.agentId,
          label: row.agentName,
          kind: "agent",
          backendId: scope.backendId,
          profile: row.profileId,
          model: row.model,
          provider: row.provider,
          totalTokens: row.totalTokens,
          totalCost: row.totalCost,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          reasoningTokens: row.reasoningTokens,
        })).slice(0, MAX_AGENT_ROWS),
        totals: { ...completeTotals },
        modelDaily: [...modelDaily.values()]
          .sort((a, b) => a.date.localeCompare(b.date) || b.tokens - a.tokens)
          .slice(-MAX_MODEL_TIMELINE_ROWS),
        topSessions: [...bySession.values()]
          .sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, 20)
          .map(({ modelTokens, ...row }) => ({
            ...row,
            models: [...modelTokens.entries()]
              .map(([model, tokens]) => ({ model, tokens }))
              .sort((a, b) => b.tokens - a.tokens),
          })),
        sourceKind: "agent",
      },
    };
    return validateTokenUsageSummary(summary);
  }
}

module.exports = {
  RECORD_FIELDS,
  STORE_VERSION,
  TokenUsageStore,
  recordChecksum,
  validateRecord,
};
