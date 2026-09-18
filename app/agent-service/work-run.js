"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { assertNoSensitiveFields, storeError } = require("./product-store");

const WORK_RUN_STATUSES = Object.freeze([
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "skipped",
]);
const WORK_RUN_STATUS_SET = new Set(WORK_RUN_STATUSES);
const ACTIVE_WORK_RUN_STATUSES = new Set([
  "starting", "running", "waiting_approval", "waiting_input",
]);
const TERMINAL_WORK_RUN_STATUSES = new Set([
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const LEGAL_WORK_RUN_TRANSITIONS = Object.freeze({
  queued: new Set(["starting", "canceled", "skipped"]),
  starting: new Set(["running", "failed", "canceled", "interrupted"]),
  running: new Set([
    "waiting_approval", "waiting_input", "completed", "failed", "canceled", "interrupted",
  ]),
  waiting_approval: new Set(["running", "waiting_input", "failed", "canceled", "interrupted"]),
  waiting_input: new Set(["running", "waiting_approval", "failed", "canceled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  interrupted: new Set(),
  skipped: new Set(),
});
const WORK_RUN_SOURCES = new Set(["chat", "kanban", "cron", "inspiration"]);
const TRANSITION_PATCH_FIELDS = new Set([
  "contextSnapshotId", "runtimeSessionRef", "runtimeTurnRef", "waitingRequestId", "resultSummary", "errorCode",
]);
const ADMISSION_TRANSITION = Symbol("admission-transition");

function workRunError(code, message) {
  return storeError(code, message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw workRunError("INVALID_WORK_RUN", `${field} 必须是非空字符串`);
  }
}

function clone(value) {
  return structuredClone(value);
}

function workspaceResolutionError() {
  return workRunError("WORKSPACE_RESOLUTION_FAILED", "无法解析 workspace");
}

function canonicalWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace.trim().length === 0) return null;
  let resolved;
  try {
    resolved = path.resolve(workspace);
  } catch {
    throw workspaceResolutionError();
  }
  const missing = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw workspaceResolutionError();
      let parent;
      try {
        parent = path.dirname(cursor);
        missing.unshift(path.basename(cursor));
      } catch {
        throw workspaceResolutionError();
      }
      if (parent === cursor) return resolved;
      cursor = parent;
    }
  }
}

function sameRuntimeSessionRef(left, right) {
  return left !== null && right !== null
    && left.runtime === right.runtime
    && left.runtimeProfileId === right.runtimeProfileId
    && left.runtimeAccountId === right.runtimeAccountId
    && left.sessionId === right.sessionId;
}

function createWorkDispatcher(options = {}) {
  const { store } = options;
  if (!store || typeof store.getWorkRun !== "function" || typeof store.putWorkRun !== "function"
    || typeof store.recoverActiveRunAfterServiceRestart !== "function") {
    throw workRunError("PRODUCT_STORE_REQUIRED", "WorkDispatcher 需要 ProductStore");
  }
  const now = options.now || Date.now;
  const admissions = new Map();

  function getRun(id) {
    return store.getWorkRun(id);
  }

  function listRuns(query = {}) {
    return store.listWorkRuns(query);
  }

  function writableFor(run) {
    if (admissions.has(run.id)) return admissions.get(run.id).writable;
    const profile = store.getAgentProfile(run.profileId);
    return profile?.permissionPolicy?.sandbox !== "read-only";
  }

  function canonicalWorkspaceFor(run) {
    if (admissions.has(run.id)) return admissions.get(run.id).workspace;
    return canonicalWorkspace(run.workspace);
  }

  function enqueueInitial(input, skippedSummary = null) {
    assertNoSensitiveFields(input, "WorkRun input");
    if (input && typeof input.idempotencyKey === "string") {
      const existing = store.getWorkRunByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw workRunError("INVALID_WORK_RUN", "WorkRun input 必须是对象");
    }
    for (const field of ["id", "sourceId", "idempotencyKey", "profileId"]) {
      requireNonEmptyString(input[field], field);
    }
    if (!WORK_RUN_SOURCES.has(input.source)) {
      throw workRunError("INVALID_WORK_RUN", "source 必须是 chat、kanban、cron 或 inspiration");
    }
    if (input.workspace !== null && input.workspace !== undefined
      && (typeof input.workspace !== "string" || input.workspace.trim().length === 0)) {
      throw workRunError("INVALID_WORK_RUN", "workspace 必须是非空路径字符串或 null");
    }
    const workspace = canonicalWorkspace(input.workspace ?? null);
    if (!store.getAgentProfile(input.profileId)) {
      throw workRunError("UNKNOWN_AGENT_PROFILE", `AgentProfile 不存在: ${input.profileId}`);
    }
    const existingId = store.getWorkRun(input.id);
    if (existingId) throw workRunError("WORK_RUN_ID_CONFLICT", `WorkRun id 已存在: ${input.id}`);
    if (input.retryOf !== undefined && input.retryOf !== null) {
      requireNonEmptyString(input.retryOf, "retryOf");
      if (!store.getWorkRun(input.retryOf)) {
        throw workRunError("UNKNOWN_RETRY_WORK_RUN", `retryOf WorkRun 不存在: ${input.retryOf}`);
      }
    }
    const unknown = Object.keys(input).filter((key) => ![
      "id", "source", "sourceId", "idempotencyKey", "profileId", "workspace", "retryOf",
    ].includes(key));
    if (unknown.length > 0) {
      throw workRunError("INVALID_WORK_RUN", `WorkRun input 含未知字段: ${unknown.join(", ")}`);
    }
    const skippedAt = skippedSummary === null ? null : now();
    return store.putWorkRun({
      id: input.id,
      source: input.source,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      profileId: input.profileId,
      workspace,
      status: skippedSummary === null ? "queued" : "skipped",
      contextSnapshotId: null,
      runtimeSessionRef: null,
      runtimeTurnRef: null,
      eventSeq: 1,
      waitingRequestId: null,
      startedAt: null,
      finishedAt: skippedAt,
      resultSummary: skippedSummary,
      errorCode: null,
      retryOf: input.retryOf ?? null,
    });
  }

  function enqueue(input) {
    return enqueueInitial(input);
  }

  function enqueueSkipped(input, resultSummary) {
    const allowed = (input?.source === "cron" && resultSummary === "CRON_TARGET_DISABLED")
      || (input?.source === "kanban" && resultSummary === "KANBAN_TARGET_DISABLED");
    if (!allowed) {
      throw workRunError(
        "INVALID_WORK_RUN",
        "仅允许持久化已停用 Cron/Kanban target 的审计跳过记录",
      );
    }
    return enqueueInitial(input, resultSummary);
  }

  function assertThreadAdmission(candidate) {
    if (!ACTIVE_WORK_RUN_STATUSES.has(candidate.status)
      || candidate.runtimeSessionRef === null) return;
    const conflict = store.listWorkRuns().find((run) => run.id !== candidate.id
      && ACTIVE_WORK_RUN_STATUSES.has(run.status)
      && sameRuntimeSessionRef(run.runtimeSessionRef, candidate.runtimeSessionRef));
    if (conflict) {
      throw workRunError(
        "THREAD_ACTIVE_TURN_CONFLICT",
        `Runtime session ${candidate.runtimeSessionRef.sessionId} 已有 active turn (${conflict.id})`,
      );
    }
  }

  function transition(id, nextStatus, patch = {}, authority = null) {
    const run = store.getWorkRun(id);
    if (!run) throw workRunError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${id}`);
    if (!WORK_RUN_STATUS_SET.has(nextStatus)) {
      throw workRunError("INVALID_WORK_RUN_STATUS", `未知 WorkRun status: ${nextStatus}`);
    }
    if (!LEGAL_WORK_RUN_TRANSITIONS[run.status]?.has(nextStatus)) {
      throw workRunError(
        "INVALID_WORK_RUN_TRANSITION",
        `非法 WorkRun 状态迁移: ${run.status} -> ${nextStatus}`,
      );
    }
    if (run.status === "queued" && nextStatus === "starting" && authority !== ADMISSION_TRANSITION) {
      throw workRunError("WORK_RUN_ADMISSION_REQUIRED", "queued -> starting 必须经过 admit 准入");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw workRunError("INVALID_WORK_RUN_PATCH", "WorkRun patch 必须是对象");
    }
    assertNoSensitiveFields(patch, "WorkRun patch");
    const unknown = Object.keys(patch).filter((key) => !TRANSITION_PATCH_FIELDS.has(key));
    if (unknown.length > 0) {
      throw workRunError("INVALID_WORK_RUN_PATCH", `WorkRun patch 含未知字段: ${unknown.join(", ")}`);
    }
    for (const field of Object.keys(patch)) {
      if (["runtimeSessionRef", "runtimeTurnRef"].includes(field)) continue;
      if (patch[field] !== null && (typeof patch[field] !== "string" || patch[field].length === 0)) {
        throw workRunError("INVALID_WORK_RUN_PATCH", `${field} 必须是非空字符串或 null`);
      }
    }
    const time = now();
    const terminalTime = run.startedAt === null ? time : Math.max(time, run.startedAt);
    const candidate = {
      ...run,
      ...clone(patch),
      status: nextStatus,
      eventSeq: run.eventSeq + 1,
      startedAt: run.startedAt ?? (ACTIVE_WORK_RUN_STATUSES.has(nextStatus) ? time : null),
      finishedAt: TERMINAL_WORK_RUN_STATUSES.has(nextStatus) ? terminalTime : null,
    };
    if (nextStatus !== "waiting_approval" && nextStatus !== "waiting_input") {
      candidate.waitingRequestId = null;
    }
    assertThreadAdmission(candidate);
    const saved = store.putWorkRun(candidate);
    if (TERMINAL_WORK_RUN_STATUSES.has(nextStatus)) admissions.delete(id);
    return saved;
  }

  function busyResult(run, reason, onBusy) {
    if (onBusy === "reject") throw workRunError(reason, `WorkRun 准入被拒绝: ${reason}`);
    return { disposition: "queued", reason, run };
  }

  function admit(id, admissionOptions = {}) {
    const run = store.getWorkRun(id);
    if (!run) throw workRunError("WORK_RUN_NOT_FOUND", `WorkRun 不存在: ${id}`);
    if (run.status !== "queued") {
      throw workRunError("WORK_RUN_NOT_QUEUED", `只有 queued WorkRun 可以准入: ${id}`);
    }
    const onBusy = admissionOptions.onBusy ?? "queue";
    if (onBusy !== "queue" && onBusy !== "reject") {
      throw workRunError("INVALID_ADMISSION_POLICY", "onBusy 必须是 queue 或 reject");
    }
    const writable = admissionOptions.writable !== false;
    const profile = store.getAgentProfile(run.profileId);
    if (!profile || !profile.enabled) {
      throw workRunError("AGENT_PROFILE_DISABLED", `AgentProfile 不可用: ${run.profileId}`);
    }
    const active = store.listWorkRuns().filter((candidate) => candidate.id !== run.id
      && ACTIVE_WORK_RUN_STATUSES.has(candidate.status));
    const workspace = canonicalWorkspace(run.workspace);
    if (writable && workspace) {
      const workspaceConflict = active.find((candidate) => writableFor(candidate)
        && canonicalWorkspaceFor(candidate) === workspace);
      if (workspaceConflict) return busyResult(run, "WORKSPACE_WRITE_BUSY", onBusy);
    }
    const profileActive = active.filter((candidate) => candidate.profileId === run.profileId);
    if (profileActive.length >= profile.concurrency.maxActive) {
      return busyResult(run, "PROFILE_ACTIVE_LIMIT", onBusy);
    }
    if (writable) {
      const profileWrites = profileActive.filter(writableFor).length;
      if (profileWrites >= profile.concurrency.maxWorkspaceWrites) {
        return busyResult(run, "PROFILE_WORKSPACE_WRITE_LIMIT", onBusy);
      }
    }
    const contextSnapshotId = admissionOptions.contextSnapshotId ?? null;
    if (contextSnapshotId !== null
      && (typeof contextSnapshotId !== "string" || !/^ctx-[a-f0-9]{64}$/u.test(contextSnapshotId))) {
      throw workRunError("INVALID_CONTEXT_SNAPSHOT", "contextSnapshotId 无效");
    }
    const started = transition(run.id, "starting", { contextSnapshotId }, ADMISSION_TRANSITION);
    // workspace 与 writable 均以准入时视图固定；active 期间 symlink 改指不能改变锁语义。
    admissions.set(run.id, { writable, workspace });
    return { disposition: "started", reason: null, run: started };
  }

  function recoverActiveRunAfterServiceRestart(id) {
    const recovered = store.recoverActiveRunAfterServiceRestart(id);
    admissions.delete(id);
    return recovered;
  }

  return Object.freeze({
    admit,
    enqueue,
    enqueueSkipped,
    getRun,
    listRuns,
    recoverActiveRunAfterServiceRestart,
    transition,
  });
}

module.exports = {
  ACTIVE_WORK_RUN_STATUSES,
  LEGAL_WORK_RUN_TRANSITIONS,
  TERMINAL_WORK_RUN_STATUSES,
  WORK_RUN_STATUSES,
  canonicalWorkspace,
  createWorkDispatcher,
};
