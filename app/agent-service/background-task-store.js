"use strict";

// Durable index of native background tasks. The index holds identities and
// states only; each generation's exact prompt lives in its own private file so
// an interrupted dispatch can be resent with the same operation and input.
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const { MAX_GENERATIONS, MAX_TITLE_CHARS, REPORT_STATES, TASK_ID_PATTERN } = require("./background-task-protocol");

const MAX_TASKS = 4096;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const RECORD_FIELDS = ["id", "profileId", "sourceSessionKey", "sourceRunId", "sourceOperationId", "fingerprint",
  "bindingId", "runtime", "title", "childSessionKey", "childWorkspace", "generations", "stopRequestedAt",
  "closedReason", "createdAt", "updatedAt"];
const GENERATION_FIELDS = ["n", "operationId", "runId", "terminal", "report"];
const CLOSED_REASONS = new Set(["source_deleted", "child_deleted", "profile_removed", "start_failed"]);
const RUN_TERMINALS = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);

const fail = (message = "后台任务记录无效") => { throw serviceError("BACKGROUND_TASK_STORE_INVALID", message); };
const ownObject = value => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => ownObject(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const nullableId = value => value === null || id(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const nullableTime = value => value === null || time(value);

function validGeneration(item, index) {
  return exact(item, GENERATION_FIELDS) && item.n === index + 1 && id(item.operationId) && nullableId(item.runId)
    && (item.terminal === null || (exact(item.terminal, ["status", "errorCode", "finishedAt"])
      && RUN_TERMINALS.has(item.terminal.status) && nullableId(item.terminal.errorCode) && time(item.terminal.finishedAt)))
    && exact(item.report, ["state", "eventId", "updatedAt"]) && REPORT_STATES.includes(item.report.state)
    && nullableId(item.report.eventId) && time(item.report.updatedAt);
}

function validateRecord(record) {
  if (!exact(record, RECORD_FIELDS) || !TASK_ID_PATTERN.test(record.id) || !id(record.profileId)
    || !id(record.sourceSessionKey) || !id(record.sourceRunId) || !id(record.sourceOperationId)
    || !/^[a-f0-9]{64}$/u.test(record.fingerprint) || !id(record.bindingId) || !id(record.runtime)
    || typeof record.title !== "string" || !record.title.isWellFormed() || [...record.title].length > MAX_TITLE_CHARS
    || !nullableId(record.childSessionKey) || typeof record.childWorkspace !== "string" || !path.isAbsolute(record.childWorkspace)
    || !Array.isArray(record.generations) || record.generations.length < 1 || record.generations.length > MAX_GENERATIONS
    || !record.generations.every(validGeneration) || !nullableTime(record.stopRequestedAt)
    || !(record.closedReason === null || CLOSED_REASONS.has(record.closedReason))
    || !time(record.createdAt) || !time(record.updatedAt)) fail();
  return record;
}

class BackgroundTaskStore {
  constructor({ paths, now = Date.now }) {
    if (!paths?.stateDir || !paths?.trustedRoot) throw new TypeError("BackgroundTaskStore 需要 paths");
    this.paths = paths; this.now = now;
    this.dir = path.join(paths.stateDir, "background-tasks");
    this.file = path.join(this.dir, "index-v1.json");
    this.tasks = null;
  }

  #load() {
    if (this.tasks) return this.tasks;
    if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") {
      throw serviceError("BACKGROUND_TASK_UNAVAILABLE", "后台任务索引的上次写入状态不确定");
    }
    const tasks = new Map();
    if (lstatIfExists(this.file)) {
      let data;
      try { data = JSON.parse(readPrivateFile(this.file, { maxBytes: MAX_INDEX_BYTES })); } catch { fail("后台任务索引无法解析"); }
      if (!exact(data, ["version", "tasks"]) || data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > MAX_TASKS) fail();
      for (const record of data.tasks) {
        validateRecord(record);
        if (tasks.has(record.id)) fail("后台任务 ID 重复");
        tasks.set(record.id, record);
      }
    }
    this.tasks = tasks;
    return tasks;
  }

  #write(tasks) {
    const bytes = `${JSON.stringify({ version: 1, tasks: [...tasks.values()] })}\n`;
    if (Buffer.byteLength(bytes) > MAX_INDEX_BYTES) throw serviceError("BACKGROUND_TASK_LIMIT", "后台任务索引已满");
    atomicWritePrivateFile(this.file, bytes, { trustedRoot: this.paths.trustedRoot });
    this.tasks = tasks;
  }

  #promptFile(taskId, generation) {
    if (!TASK_ID_PATTERN.test(taskId) || !Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATIONS) fail();
    return path.join(this.dir, "prompts", `${taskId}-${generation}.txt`);
  }

  get(taskId) { return structuredClone(this.#load().get(taskId) ?? null); }

  list(filter = {}) {
    return [...this.#load().values()].filter(record => (!filter.profileId || record.profileId === filter.profileId)
      && (!filter.sourceSessionKey || record.sourceSessionKey === filter.sourceSessionKey))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(record => structuredClone(record));
  }

  findByChildSession(sessionKey) {
    if (typeof sessionKey !== "string") return null;
    for (const record of this.#load().values()) if (record.childSessionKey === sessionKey) return structuredClone(record);
    return null;
  }

  count(filter) { return this.list(filter).length; }

  // The prompt is committed before the index: a record never points to a
  // generation whose exact input cannot be read back.
  create(record, prompt) {
    const tasks = this.#load();
    if (tasks.has(record.id)) return this.get(record.id);
    if (tasks.size >= MAX_TASKS) throw serviceError("BACKGROUND_TASK_LIMIT", "后台任务数量已满");
    validateRecord(record);
    this.#writePrompt(record.id, 1, prompt);
    const next = new Map(tasks); next.set(record.id, structuredClone(record));
    this.#write(next);
    return this.get(record.id);
  }

  addGeneration(taskId, operationId, prompt) {
    const current = this.get(taskId);
    if (!current) fail("后台任务不存在");
    const n = current.generations.length + 1;
    if (n > MAX_GENERATIONS) throw serviceError("BACKGROUND_TASK_LIMIT", "后台任务续做次数已满");
    this.#writePrompt(taskId, n, prompt);
    return this.update(taskId, record => {
      record.generations.push({ n, operationId, runId: null, terminal: null,
        report: { state: "none", eventId: null, updatedAt: this.now() } });
      record.stopRequestedAt = null;
    });
  }

  update(taskId, mutate) {
    const tasks = this.#load();
    const prior = tasks.get(taskId);
    if (!prior) fail("后台任务不存在");
    const record = structuredClone(prior);
    mutate(record);
    record.updatedAt = Math.max(prior.updatedAt, this.now());
    validateRecord(record);
    const next = new Map(tasks); next.set(taskId, record);
    this.#write(next);
    return structuredClone(record);
  }

  readPrompt(taskId, generation) {
    const file = this.#promptFile(taskId, generation);
    if (!lstatIfExists(file)) return null;
    return readPrivateFile(file, { maxBytes: MAX_PROMPT_BYTES }).toString("utf8");
  }

  #writePrompt(taskId, generation, prompt) {
    if (typeof prompt !== "string" || !prompt.isWellFormed() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail("后台任务输入无效");
    const file = this.#promptFile(taskId, generation);
    if (lstatIfExists(file)) {
      if (readPrivateFile(file, { maxBytes: MAX_PROMPT_BYTES }).toString("utf8") !== prompt) {
        throw serviceError("BACKGROUND_TASK_CONFLICT", "后台任务输入与原记录不一致");
      }
      return;
    }
    atomicWritePrivateFile(file, prompt, { trustedRoot: this.paths.trustedRoot });
  }

  purgeProfile(profileId) {
    const tasks = this.#load();
    const removed = [...tasks.values()].filter(record => record.profileId === profileId);
    if (!removed.length) return 0;
    const next = new Map([...tasks].filter(([, record]) => record.profileId !== profileId));
    this.#write(next);
    for (const record of removed) for (const generation of record.generations) {
      try { fs.rmSync(this.#promptFile(record.id, generation.n), { force: true }); } catch {}
    }
    return removed.length;
  }
}

module.exports = { BackgroundTaskStore, validateBackgroundTaskRecord: validateRecord };
