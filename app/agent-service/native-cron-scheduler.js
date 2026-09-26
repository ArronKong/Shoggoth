"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CronExpressionParser } = require("cron-parser");
const {
  IDEMPOTENCY_WINDOW_MS,
  MAX_OPERATION_FUTURE_SKEW_MS,
  computeNextOccurrence,
} = require("./native-cron-store");
const {
  ACTIVE_WORK_RUN_STATUSES,
  TERMINAL_WORK_RUN_STATUSES,
} = require("./work-run");
const { serviceError } = require("./security");

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TIMER_RETRY_DELAY_MS = 1_000;
const MAX_SETTLED_TASKS = 256;
const MAX_INFLIGHT_TASKS = 256;
const MAX_CRON_SCAN_STEPS = 512;
const MAX_CRON_RUN_SCAN = 65_536;
const MAX_FATAL_ERROR_PROTOTYPE_DEPTH = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CRON_INTENT_PREFIX = "shoggoth:cron:v2";
const CRON_INTENT_PATTERN = /^shoggoth:cron:v2:(manual|retry):([a-f0-9]{64}):([0-9]+):([a-f0-9]{64}):([a-f0-9]{64}):(run|target-disabled|overlap-skipped|overlap-queue-full)$/u;
const CRON_OCCURRENCE_INTENT_PATTERN = /^shoggoth:cron:v2:occurrence:([a-f0-9]{64}):([a-f0-9]{64}):(run|target-disabled|misfire-skipped|overlap-skipped|overlap-queue-full):([0-9]+)$/u;
const MANUAL_TRIGGER_FIELDS = Object.freeze(["operationId", "jobId", "createdAt"]);
const RETRY_RUN_FIELDS = Object.freeze(["operationId", "jobId", "retryOf", "createdAt"]);
const RETRYABLE_CRON_RUN_STATUSES = new Set([
  "failed", "canceled", "interrupted", "skipped",
]);
const OVERLAP_POLICIES = new Set(["skip", "queue"]);
const THREAD_POLICIES = new Set(["new", "continue"]);
const OCCURRENCE_DISPOSITIONS = Object.freeze({
  CRON_TARGET_DISABLED: "target-disabled",
  CRON_MISFIRE_SKIPPED: "misfire-skipped",
  CRON_OVERLAP_SKIPPED: "overlap-skipped",
  CRON_OVERLAP_QUEUE_FULL: "overlap-queue-full",
});

function schedulerError(code, message) {
  return serviceError(code, message);
}

function sanitizedExecutorError() {
  return schedulerError("CRON_EXECUTOR_FAILED", "Cron executor 执行失败");
}

function probeDataProperty(target, property) {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      return { ok: true, found: false, value: undefined };
    }
    const seen = new Set();
    let cursor = target;
    for (let depth = 0; depth < MAX_FATAL_ERROR_PROTOTYPE_DEPTH; depth += 1) {
      if (seen.has(cursor)) return { ok: false, found: false, value: undefined };
      seen.add(cursor);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return { ok: false, found: true, value: undefined };
        }
        return { ok: true, found: true, value: descriptor.value };
      }
      cursor = Object.getPrototypeOf(cursor);
      if (cursor === null) return { ok: true, found: false, value: undefined };
    }
    return { ok: false, found: false, value: undefined };
  } catch {
    return { ok: false, found: false, value: undefined };
  }
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function occurrenceBaseFingerprint(jobId, scheduledAt) {
  return sha256(JSON.stringify(["occurrence", jobId, scheduledAt]));
}

function baseIntentFingerprint(kind, intent) {
  return sha256(JSON.stringify([
    kind,
    intent.jobId,
    intent.retryOf,
    intent.createdAt,
    intent.profileId,
    intent.workspace,
  ]));
}

function executionFingerprint(execution) {
  return sha256(JSON.stringify([
    execution.profileId,
    execution.workspace,
    execution.prompt,
    execution.threadPolicy,
    execution.threadId,
  ]));
}

function occurrenceKey(jobId, scheduledAt, execution, disposition = "run") {
  return `${CRON_INTENT_PREFIX}:occurrence:${occurrenceBaseFingerprint(jobId, scheduledAt)}:${executionFingerprint(execution)}:${disposition}:${scheduledAt}`;
}

function occurrenceDisposition(disposition) {
  return disposition === null ? "run" : OCCURRENCE_DISPOSITIONS[disposition];
}

function occurrenceDispositionResult(disposition) {
  if (disposition === "run") return null;
  return Object.keys(OCCURRENCE_DISPOSITIONS)
    .find((key) => OCCURRENCE_DISPOSITIONS[key] === disposition) || null;
}

function cronIntentKey(kind, operationId, intent, execution, disposition = "run") {
  return `${CRON_INTENT_PREFIX}:${kind}:${sha256(operationId)}:${intent.createdAt}:${
    baseIntentFingerprint(kind, intent)
  }:${executionFingerprint(execution)}:${disposition}`;
}

function parseCronIntentKey(value) {
  if (typeof value !== "string") return null;
  const match = CRON_INTENT_PATTERN.exec(value);
  if (!match) return null;
  const createdAt = Number(match[3]);
  if (!validTimestamp(createdAt) || String(createdAt) !== match[3]) return null;
  return Object.freeze({
    kind: match[1],
    operationHash: match[2],
    createdAt,
    baseFingerprint: match[4],
    executionFingerprint: match[5],
    disposition: match[6],
  });
}

function parseOccurrenceIntentKey(value) {
  if (typeof value !== "string") return null;
  const match = CRON_OCCURRENCE_INTENT_PATTERN.exec(value);
  if (!match) return null;
  const scheduledAt = Number(match[4]);
  if (!validTimestamp(scheduledAt) || String(scheduledAt) !== match[4]) return null;
  return Object.freeze({
    version: 2,
    baseFingerprint: match[1],
    executionFingerprint: match[2],
    disposition: match[3],
    scheduledAt,
  });
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validOpaqueId(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && OPAQUE_ID_PATTERN.test(value);
}

function validExecutionText(value, maxBytes) {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validExecutionWorkspace(value) {
  return value === null || (validExecutionText(value, 4096) && path.isAbsolute(value));
}

function canonicalWorkspace(workspace) {
  if (workspace === null) return null;
  const resolved = path.resolve(workspace);
  const missing = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun workspace 无法安全解析");
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function describeCronRun(run) {
  const values = {};
  for (const field of [
    "source", "sourceId", "idempotencyKey", "profileId", "workspace", "status", "retryOf",
  ]) {
    const probe = probeDataProperty(run, field);
    if (!probe.ok || !probe.found) return null;
    values[field] = probe.value;
  }
  if (values.source !== "cron" || !UUID_PATTERN.test(values.sourceId)) return null;

  const intent = parseCronIntentKey(values.idempotencyKey);
  if (intent) {
    const expectedRetryOf = intent.kind === "retry" ? values.retryOf : null;
    if ((intent.kind === "retry") !== (values.retryOf !== null)
      || typeof values.profileId !== "string"
      || !(values.workspace === null || typeof values.workspace === "string")
      || intent.baseFingerprint !== baseIntentFingerprint(intent.kind, {
        jobId: values.sourceId,
        retryOf: expectedRetryOf,
        createdAt: intent.createdAt,
        profileId: values.profileId,
        workspace: values.workspace,
      })) return null;
    return Object.freeze({ kind: intent.kind, createdAt: intent.createdAt });
  }

  const occurrence = parseOccurrenceIntentKey(values.idempotencyKey);
  if (occurrence) {
    if (values.retryOf !== null
      || occurrence.baseFingerprint !== occurrenceBaseFingerprint(
        values.sourceId, occurrence.scheduledAt,
      )) return null;
    return Object.freeze({ kind: "schedule", createdAt: occurrence.scheduledAt });
  }

  return null;
}

function occurrenceSemanticKey(jobId, scheduledAt) {
  return `${jobId}:${scheduledAt}`;
}

function previousCronOccurrence(schedule, beforeOrAt) {
  const currentDate = new Date(beforeOrAt + 1);
  if (!Number.isFinite(currentDate.getTime())) return null;
  try {
    const value = CronExpressionParser.parse(schedule.expr, {
      currentDate,
      tz: schedule.tz,
    }).prev().getTime();
    return validTimestamp(value) && value <= beforeOrAt ? value : null;
  } catch {
    return null;
  }
}

function isScheduledOccurrence(job, scheduledAt) {
  // Store 创建 Job 时要求 nextRunAt 严格晚于 createdAt；创建前的数学周期点
  // 从未可能成为该 Job 的 occurrence，不能被伪造旧 WorkRun 借机恢复执行。
  if (!validTimestamp(scheduledAt) || scheduledAt <= job.createdAt) return false;
  if (job.schedule.kind === "at") return scheduledAt === job.schedule.at;
  if (job.schedule.kind === "every") {
    if (scheduledAt < job.schedule.anchorMs) return false;
    return (BigInt(scheduledAt) - BigInt(job.schedule.anchorMs))
      % BigInt(job.schedule.everyMs) === 0n;
  }
  const previous = previousCronOccurrence(job.schedule, scheduledAt);
  if (previous === scheduledAt) return true;
  return previous !== null && computeNextOccurrence(job.schedule, previous) === scheduledAt;
}

function dueOccurrences(job, wallNow, recovering, scanOptions = {}) {
  if (!job.enabled || job.nextRunAt === null || job.nextRunAt > wallNow) {
    return { occurrences: [], skip: false };
  }
  if (job.schedule.kind === "at") {
    return {
      occurrences: [job.nextRunAt],
      skip: job.misfirePolicy === "skip" && recovering && job.nextRunAt < wallNow,
    };
  }

  let latest = job.nextRunAt;
  let previous = null;
  let bounded = [];
  if (job.schedule.kind === "every") {
    const first = BigInt(job.nextRunAt);
    const every = BigInt(job.schedule.everyMs);
    const now = BigInt(wallNow);
    const count = ((now - first) / every) + 1n;
    latest = Number(first + (count - 1n) * every);
    previous = count > 1n ? latest - job.schedule.everyMs : null;
    const take = Number(count < BigInt(job.maxCatchUp) ? count : BigInt(job.maxCatchUp));
    const start = latest - (take - 1) * job.schedule.everyMs;
    bounded = Array.from({ length: take }, (_, index) => start + index * job.schedule.everyMs);
  } else {
    // cron-parser 在 DST spring gap 上的 prev/next 不是简单互逆：prev 会跳过
    // gap 日，而 next 会把该日映射到跳时后的合法时刻。先用 prev 快速定位
    // 最近窗口，再用与 Store 相同的 forward 真值收敛，避免从久远 nextRunAt
    // 逐次扫描，也避免漏掉 gap occurrence。
    const proportionalLimit = Math.min(
      MAX_CRON_SCAN_STEPS,
      (job.maxCatchUp * 4) + 16,
    );
    const requestedLimit = scanOptions.maxScanSteps ?? proportionalLimit;
    const scanLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(proportionalLimit, requestedLimit)
      : proportionalLimit;
    let scanSteps = 0;
    const consumeBudget = () => {
      scanSteps += 1;
      if (scanSteps > scanLimit) {
        throw schedulerError("CRON_SCHEDULE_UNBOUNDED", "Cron occurrence 扫描超出有界预算");
      }
    };
    let cursor = job.nextRunAt;
    let before = wallNow;
    const backwardSteps = Math.min(
      Math.floor(scanLimit / 2),
      (job.maxCatchUp * 2) + 4,
    );
    for (let step = 0; step < backwardSteps; step += 1) {
      consumeBudget();
      const previous = previousCronOccurrence(job.schedule, before);
      if (previous === null || previous < job.nextRunAt) break;
      cursor = previous;
      if (previous === 0) break;
      before = previous - 1;
    }
    const window = cursor <= wallNow ? [cursor] : [];
    const keep = Math.max(2, job.maxCatchUp);
    let reachedFuture = false;
    while (scanSteps < scanLimit) {
      consumeBudget();
      const next = computeNextOccurrence(job.schedule, cursor);
      if (next === null || next > wallNow) {
        reachedFuture = true;
        break;
      }
      if (next <= cursor) {
        throw schedulerError("CRON_SCHEDULE_INVALID", "Cron occurrence 未单调前进");
      }
      window.push(next);
      while (window.length > keep) window.shift();
      cursor = next;
    }
    if (!reachedFuture) {
      throw schedulerError("CRON_SCHEDULE_UNBOUNDED", "Cron occurrence 窗口无法有界收敛");
    }
    if (window.length === 0) return { occurrences: [], skip: false };
    latest = window.at(-1);
    previous = window.length > 1 ? window.at(-2) : null;
    bounded = window.slice(-job.maxCatchUp);
  }

  const hasMultiple = previous !== null;
  if (job.misfirePolicy === "all-bounded") {
    return { occurrences: bounded, skip: false };
  }
  if (job.misfirePolicy === "skip" && (hasMultiple || (recovering && latest < wallNow))) {
    return { occurrences: [latest], skip: true };
  }
  return { occurrences: [latest], skip: false };
}

class NativeCronScheduler {
  constructor(options = {}) {
    if (!options.cronStore || typeof options.cronStore.listJobs !== "function"
      || typeof options.cronStore.getJob !== "function"
      || typeof options.cronStore.setJobNextRunAt !== "function"
      || typeof options.cronStore.setJobEnabled !== "function") {
      throw schedulerError("CRON_STORE_REQUIRED", "NativeCronScheduler 需要 Cron Store");
    }
    if (!options.dispatcher || typeof options.dispatcher.enqueue !== "function"
      || typeof options.dispatcher.getRun !== "function"
      || typeof options.dispatcher.listRuns !== "function"
      || typeof options.dispatcher.transition !== "function") {
      throw schedulerError("CRON_DISPATCHER_REQUIRED", "NativeCronScheduler 需要 Work Dispatcher");
    }
    if (!options.executor || typeof options.executor.schedule !== "function"
      || typeof options.executor.recover !== "function") {
      throw schedulerError("CRON_EXECUTOR_REQUIRED", "NativeCronScheduler 需要 executor");
    }
    for (const [name, value] of [
      ["now", options.now], ["monotonicNow", options.monotonicNow],
      ["setTimer", options.setTimer], ["clearTimer", options.clearTimer],
      ["randomUUID", options.randomUUID], ["onFatalError", options.onFatalError],
      ["resolveWorkspace", options.resolveWorkspace],
      ["resolveTargetState", options.resolveTargetState],
    ]) {
      if (value !== undefined && typeof value !== "function") {
        throw schedulerError("CRON_SCHEDULER_OPTIONS_INVALID", `${name} 必须是函数`);
      }
    }
    this.cronStore = options.cronStore;
    this.dispatcher = options.dispatcher;
    this.executor = options.executor;
    this.now = options.now || Date.now;
    this.monotonicNow = options.monotonicNow || (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.onFatalError = options.onFatalError || null;
    this.resolveWorkspace = options.resolveWorkspace || ((_profileId, workspace) => workspace);
    this.resolveTargetState = options.resolveTargetState || (() => "enabled");
    this.state = "new";
    this.generation = 0;
    this.openPromise = null;
    this.closePromise = null;
    this.tickPromise = null;
    this.timer = null;
    this.inflight = new Map();
    this.activeByJob = new Map();
    this.settled = new Map();
    this.recoveryPending = false;
    this.lastError = null;
    this.poisonError = null;
    this.lastWallNow = null;
    this.lastMonotonicNow = null;
    this.wallClockHighWater = null;
  }

  open() {
    if (this.poisonError) return Promise.reject(this.poisonError);
    if (this.state === "open") return Promise.resolve(this);
    if (this.state === "opening") return this.openPromise;
    if (this.state === "closing") {
      return Promise.reject(schedulerError("CRON_SCHEDULER_CLOSING", "Cron Scheduler 正在关闭"));
    }
    if (this.state === "poisoned") {
      return Promise.reject(this.lastError);
    }
    const generation = ++this.generation;
    this.state = "opening";
    this.closePromise = null;
    this.openPromise = (async () => {
      this.#assertGeneration(generation);
      this.state = "open";
      try {
        await this.#tickFor(generation, true);
        this.#assertGeneration(generation);
        return this;
      } catch (error) {
        const failure = this.#fatalOrOriginal(error);
        if (this.generation === generation && this.state !== "poisoned") this.state = "closed";
        throw failure;
      }
    })();
    return this.openPromise;
  }

  close() {
    if (this.state === "closed" || this.state === "new") return Promise.resolve();
    if (this.state === "closing") return this.closePromise;
    this.state = "closing";
    this.generation += 1;
    this.#clearScheduledTimer();
    const pendingOpen = this.openPromise;
    const pendingTick = this.tickPromise;
    this.closePromise = (async () => {
      await Promise.allSettled([pendingOpen, pendingTick].filter(Boolean));
      this.#clearScheduledTimer();
      this.state = "closed";
      this.openPromise = null;
      this.tickPromise = null;
    })();
    return this.closePromise;
  }

  tick() {
    if (this.poisonError) return Promise.reject(this.poisonError);
    if (this.state !== "open") {
      return Promise.reject(schedulerError("CRON_SCHEDULER_CLOSED", "Cron Scheduler 未打开"));
    }
    if (this.tickPromise) return this.tickPromise;
    const generation = this.generation;
    const task = this.#tickFor(generation, false).catch((error) => {
      const failure = this.#fatalOrOriginal(error);
      if (this.poisonError) throw failure;
      this.#handleTimerError(failure, generation);
      throw failure;
    });
    const wrapped = task.finally(() => {
      if (this.tickPromise === wrapped) this.tickPromise = null;
    });
    this.tickPromise = wrapped;
    return wrapped;
  }

  triggerJob(input) {
    this.#assertGeneration(this.generation);
    if (!exactObject(input, MANUAL_TRIGGER_FIELDS) || !validOpaqueId(input.operationId)
      || !UUID_PATTERN.test(input.jobId) || !validTimestamp(input.createdAt)) {
      throw schedulerError("CRON_MANUAL_TRIGGER_INVALID", "Cron manual trigger 输入无效");
    }
    try {
      return this.#dispatchIntent("manual", input);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  retryRun(input) {
    this.#assertGeneration(this.generation);
    if (!exactObject(input, RETRY_RUN_FIELDS) || !validOpaqueId(input.operationId)
      || !UUID_PATTERN.test(input.jobId) || !validOpaqueId(input.retryOf)
      || !validTimestamp(input.createdAt)) {
      throw schedulerError("CRON_RETRY_INVALID", "Cron retry 输入无效");
    }
    try {
      return this.#dispatchIntent("retry", input);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
  }

  async waitForIdle(runId) {
    if (this.poisonError) throw this.poisonError;
    if (typeof runId !== "string" || runId.length === 0) {
      throw schedulerError("CRON_RUN_ID_INVALID", "runId 无效");
    }
    if (this.inflight.has(runId)) return this.inflight.get(runId).task;
    if (this.settled.has(runId)) {
      const outcome = this.settled.get(runId);
      this.settled.delete(runId);
      this.settled.set(runId, outcome);
      if (outcome.error) throw outcome.error;
      return outcome.value;
    }
    let run;
    try {
      run = this.dispatcher.getRun(runId);
    } catch (error) {
      throw this.#fatalOrOriginal(error);
    }
    if (!run) throw schedulerError("WORK_RUN_NOT_FOUND", "Cron WorkRun 不存在");
    return run;
  }

  #recoverDurableRuns(generation, runs, runIndex) {
    const jobs = new Map(this.cronStore.listJobs().map((job) => [job.id, job]));
    for (const job of jobs.values()) this.#observeWallClock(job.updatedAt);
    const runIndexes = new Map(runs.map((run, index) => [run.id, index]));
    const frozenJobs = new Map();
    const frozenJob = (job) => {
      let frozen = frozenJobs.get(job.id);
      if (!frozen) {
        frozen = this.#freezeJobExecution(job);
        frozenJobs.set(job.id, frozen);
      }
      return frozen;
    };
    const candidates = [];
    const intentOwners = new Set();
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      this.#assertGeneration(generation);
      const intent = runIndex.intentByRunId.get(run.id) || null;
      const occurrenceIntent = runIndex.occurrenceIntentByRunId.get(run.id) || null;
      const occurrence = runIndex.occurrenceByRunId.get(run.id) || null;
      if (run.idempotencyKey.startsWith(`${CRON_INTENT_PREFIX}:`)
        && !intent && !occurrenceIntent) {
        throw this.#markPoison("run");
      }
      if (!intent && !occurrence) {
        throw this.#markPoison("run");
      }
      if (intent) {
        if (intentOwners.has(intent.operationHash)) {
          throw this.#markPoison("run");
        }
        intentOwners.add(intent.operationHash);
        this.#observeWallClock(intent.createdAt);
        try {
          this.#assertBaseIntentBinding(run, intent);
          if (intent.kind === "retry") this.#assertRetryLineage(run, runIndex);
        } catch (error) {
          throw this.#fatalOrOriginal(error);
        }
      }
      if (!intent && occurrence) {
        const owners = runIndex.occurrenceOwners.get(
          occurrenceSemanticKey(run.sourceId, occurrence.scheduledAt),
        ) || [];
        try {
          this.#assertOccurrenceBaseBinding(run, occurrence);
          if (owners.length !== 1) {
            throw schedulerError("CRON_RUN_CORRUPT", "同一 Cron occurrence 存在多个 WorkRun");
          }
        } catch (error) {
          throw this.#fatalOrOriginal(error);
        }
      }
      if (TERMINAL_WORK_RUN_STATUSES.has(run.status)) {
        try {
          this.#assertTerminalDisposition(
            run, intent?.disposition ?? occurrence?.disposition ?? "run",
          );
          if (!intent) {
            this.#assertOccurrenceBaseBinding(run, occurrence);
          }
        } catch (error) {
          throw this.#fatalOrOriginal(error);
        }
        continue;
      }
      const job = jobs.get(run.sourceId);
      if (!job) {
        if (run.status === "queued") {
          runs[index] = this.dispatcher.transition(run.id, "canceled", {
            resultSummary: "CRON_JOB_DELETED",
          });
        } else {
          runs[index] = this.dispatcher.transition(run.id, "interrupted", {
            errorCode: "CRON_JOB_DELETED",
          });
        }
        continue;
      }
      try {
        if (intent) {
          const frozen = frozenJob(job);
          this.#assertExecutionBinding(intent, frozen.execution);
          if (run.profileId !== frozen.job.profileId || run.workspace !== frozen.job.workspace) {
            throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun execution 绑定损坏");
          }
        }
        else {
          if (!occurrence) {
            throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun occurrence 绑定损坏");
          }
          if (occurrence.version === 2) {
            this.#assertOccurrenceBaseBinding(run, occurrence);
            this.#assertOccurrenceExecutionBinding(run, occurrence, frozenJob(job));
          } else {
            throw schedulerError(
              "CRON_RUN_CORRUPT", "Cron occurrence 缺少冻结 execution contract",
            );
          }
        }
      } catch (error) {
        throw this.#fatalOrOriginal(error);
      }
      const frozen = frozenJob(job);
      const durableDisposition = intent?.disposition ?? occurrence?.disposition ?? "run";
      if (frozen.targetDisabled && durableDisposition === "run") {
        if (run.status === "queued") {
          const skipped = this.dispatcher.transition(run.id, "skipped", {
            resultSummary: "CRON_TARGET_DISABLED",
          });
          runs[index] = skipped;
          runIndex.byIdempotencyKey.set(skipped.idempotencyKey, skipped);
          const position = runIndex.positionByRunId.get(skipped.id);
          if (position) position.group[position.index] = skipped;
          if (occurrence) {
            const semanticOwners = runIndex.occurrenceOwners.get(
              occurrenceSemanticKey(skipped.sourceId, occurrence.scheduledAt),
            ) || [];
            const owner = semanticOwners.find((entry) => entry.run.id === skipped.id);
            if (owner) owner.run = skipped;
          }
          continue;
        }
        // 已经启动的 Run 保持既有恢复语义；禁用只阻止尚未开始的新执行。
      }
      if (durableDisposition !== "run") {
        if (run.status !== "queued") {
          throw this.#markPoison("run");
        }
        const resultSummary = occurrenceDispositionResult(durableDisposition);
        const skipped = this.dispatcher.transition(run.id, "skipped", { resultSummary });
        runs[index] = skipped;
        runIndex.byIdempotencyKey.set(skipped.idempotencyKey, skipped);
        const position = runIndex.positionByRunId.get(skipped.id);
        if (position) position.group[position.index] = skipped;
        if (occurrence) {
          const semanticOwners = runIndex.occurrenceOwners.get(
            occurrenceSemanticKey(skipped.sourceId, occurrence.scheduledAt),
          ) || [];
          const owner = semanticOwners.find((entry) => entry.run.id === skipped.id);
          if (owner) owner.run = skipped;
        }
        continue;
      }
      if (this.settled.get(run.id)?.generation === generation) continue;
      // 不在恢复旧 Run 时直接把 nextRunAt 跳到 wallNow 之后。后续 tick 会用
      // 相同 occurrence key 幂等命中该 Run，再按 misfire 策略补齐最新窗口，
      // 最后一次性推进 Job；否则 crash cut 会吞掉离线期间的 all-bounded 补跑。
      candidates.push({
        method: "recover",
        run,
        job: frozen.job,
        scheduledAt: intent?.createdAt
          ?? occurrence.scheduledAt,
        recovered: true,
      });
    }

    const byJob = new Map();
    for (const candidate of candidates) {
      const group = byJob.get(candidate.job.id) || [];
      group.push(candidate);
      byJob.set(candidate.job.id, group);
    }
    const plans = [];
    for (const group of byJob.values()) {
      const active = group
        .filter((candidate) => ACTIVE_WORK_RUN_STATUSES.has(candidate.run.status))
        .sort((left, right) => left.scheduledAt - right.scheduledAt);
      const queued = group
        .filter((candidate) => candidate.run.status === "queued")
        .sort((left, right) => left.scheduledAt - right.scheduledAt);
      plans.push(...active);
      // 每个 versioned `run` intent 已冻结了原调度决策；恢复只执行统一的
      // 两槽安全上限，不能让迟到的 Job.overlapPolicy 改写 durable intent。
      const queuedLimit = active.length === 0 ? 2 : 1;
      plans.push(...queued.slice(0, queuedLimit));
      for (const candidate of queued.slice(queuedLimit)) {
        this.#assertGeneration(generation);
        const skipped = this.dispatcher.transition(candidate.run.id, "skipped", {
          resultSummary: "CRON_OVERLAP_QUEUE_FULL",
        });
        const snapshotIndex = runIndexes.get(skipped.id);
        if (snapshotIndex !== undefined) {
          runs[snapshotIndex] = skipped;
          runIndex.byIdempotencyKey.set(skipped.idempotencyKey, skipped);
          const position = runIndex.positionByRunId.get(skipped.id);
          if (position) position.group[position.index] = skipped;
        }
      }
    }
    return plans;
  }

  async #tickFor(generation, recovering) {
    this.#assertGeneration(generation);
    this.#clearScheduledTimer();
    const cronRuns = this.#cronRunSnapshot(generation);
    let cronRunCount = cronRuns.length;
    const runIndex = this.#buildRunIndex(cronRuns);
    const durablePlans = this.#recoverDurableRuns(generation, cronRuns, runIndex);
    const executionPlans = new Map(durablePlans.map((plan) => [plan.run.id, plan]));
    const overlapReservations = new Map();
    for (const run of cronRuns) {
      const reservation = this.#overlapReservation(overlapReservations, run.sourceId);
      if (ACTIVE_WORK_RUN_STATUSES.has(run.status)) reservation.active = true;
      if (run.status === "queued") reservation.queued = true;
    }
    const wallNow = this.#wallNow();
    const monotonicNow = this.#monotonicTime();
    // wall clock 回拨不会倒退任何持久 nextRunAt；只重新计算下一次本地等待。
    this.lastWallNow = wallNow;
    this.lastMonotonicNow = monotonicNow;
    this.#observeWallClock(wallNow);
    for (const initial of this.cronStore.listJobs({ enabled: true })) {
      this.#assertGeneration(generation);
      const job = this.cronStore.getJob(initial.id);
      if (!job) continue;
      const frozen = this.#freezeJobExecution(job);
      if (!frozen.job.enabled || frozen.job.nextRunAt === null
        || frozen.job.nextRunAt > wallNow) continue;
      const due = dueOccurrences(frozen.job, wallNow, recovering);
      const plans = [];
      const reservation = this.#overlapReservation(overlapReservations, job.id);
      for (const scheduledAt of due.occurrences) {
        this.#assertGeneration(generation);
        const owners = runIndex.occurrenceOwners.get(
          occurrenceSemanticKey(job.id, scheduledAt),
        ) || [];
        const newDisposition = owners.length === 0
          ? (frozen.targetDisabled
            ? "CRON_TARGET_DISABLED"
            : this.#disposition(frozen.job, due.skip, reservation))
          : null;
        const key = occurrenceKey(
          job.id, scheduledAt, frozen.execution, occurrenceDisposition(newDisposition),
        );
        let run = owners.length === 1 ? owners[0].run : null;
        if (owners.length === 0 && cronRunCount >= MAX_CRON_RUN_SCAN) {
          throw schedulerError("CRON_RUN_CAPACITY", "Cron WorkRun 已达到容量上限");
        }
        try {
          if (owners.length > 1) {
            throw schedulerError("CRON_RUN_CORRUPT", "同一 Cron occurrence 存在多个 WorkRun");
          }
          if (run) {
            this.#assertOccurrenceBaseBinding(run, owners[0].occurrence);
            if (!TERMINAL_WORK_RUN_STATUSES.has(run.status)) {
              this.#assertOccurrenceBinding(run, frozen, scheduledAt);
            }
          }
          else {
            const proposed = {
              source: "cron",
              sourceId: job.id,
              idempotencyKey: key,
              profileId: frozen.job.profileId,
              workspace: frozen.job.workspace,
              retryOf: null,
            };
            this.#assertOccurrenceBinding(proposed, frozen, scheduledAt);
            const proposedId = this.#newRunId();
            run = newDisposition === "CRON_TARGET_DISABLED"
              ? this.dispatcher.enqueueSkipped(
                { id: proposedId, ...proposed }, "CRON_TARGET_DISABLED",
              )
              : this.dispatcher.enqueue({ id: proposedId, ...proposed });
            // enqueue 可能全局命中非 Cron source 的既有 idempotencyKey；这种情况下
            // 没有创建新 Run，返回后再校验不会制造 orphan。
            if (run.id !== proposedId) {
              this.#assertOccurrenceBinding(run, frozen, scheduledAt);
            } else {
              cronRunCount += 1;
            }
          }
        } catch (error) {
          throw this.#fatalOrOriginal(error);
        }
        if (executionPlans.has(run.id) || TERMINAL_WORK_RUN_STATUSES.has(run.status)) {
          plans.push({ run, execute: false, scheduledAt });
          continue;
        }
        const disposition = owners.length === 1
          ? occurrenceDispositionResult(owners[0].occurrence.disposition)
          : newDisposition;
        if (disposition) {
          const skipped = run.status === "queued"
            ? this.dispatcher.transition(run.id, "skipped", { resultSummary: disposition }) : run;
          plans.push({ run: skipped, execute: false, scheduledAt });
        } else {
          plans.push({ run, execute: run.status === "queued", scheduledAt });
        }
      }
      this.#assertGeneration(generation);
      this.#advanceJob(frozen.job, wallNow, generation);
      // Durable enqueue 后不再从 Store mutation 回显读取执行字段；executor 只拿
      // enqueue 前与 execution fingerprint 同源的冻结 Job snapshot。
      const executionJob = frozen.job;
      for (const plan of plans) {
        if (plan.execute && !executionPlans.has(plan.run.id)) {
          executionPlans.set(plan.run.id, {
            method: "schedule",
            run: plan.run,
            job: executionJob,
            scheduledAt: plan.scheduledAt,
            recovered: false,
          });
        }
      }
    }
    this.#assertGeneration(generation);
    this.#scheduleNextTimer(generation);
    this.lastError = null;
    for (const plan of executionPlans.values()) {
      this.#startExecution(
        plan.method, plan.run, plan.job, plan.scheduledAt, generation, plan.recovered,
      );
    }
  }

  #overlapReservation(reservations, jobId) {
    let reservation = reservations.get(jobId);
    if (!reservation) {
      reservation = { active: false, queued: false };
      reservations.set(jobId, reservation);
    }
    return reservation;
  }

  #cronRunSnapshot(generation) {
    this.#assertGeneration(generation);
    const runs = this.dispatcher.listRuns({ source: "cron" });
    if (runs.length > MAX_CRON_RUN_SCAN) {
      throw schedulerError("CRON_RUN_CAPACITY", "Cron WorkRun 扫描超出容量上限");
    }
    return runs;
  }

  #buildRunIndex(runs) {
    const byJob = new Map();
    const byIdempotencyKey = new Map();
    const positionByRunId = new Map();
    const intentByRunId = new Map();
    const intentOwners = new Map();
    const occurrenceIntentByRunId = new Map();
    const occurrenceByRunId = new Map();
    const occurrenceOwners = new Map();
    for (const run of runs) {
      let group = byJob.get(run.sourceId);
      if (!group) {
        group = [];
        byJob.set(run.sourceId, group);
      }
      positionByRunId.set(run.id, { group, index: group.length });
      group.push(run);
      byIdempotencyKey.set(run.idempotencyKey, run);
      const intent = parseCronIntentKey(run.idempotencyKey);
      if (intent) {
        intentByRunId.set(run.id, intent);
        const owners = intentOwners.get(intent.operationHash) || [];
        owners.push({ run, intent });
        intentOwners.set(intent.operationHash, owners);
      }
      const occurrenceIntent = parseOccurrenceIntentKey(run.idempotencyKey);
      if (occurrenceIntent) occurrenceIntentByRunId.set(run.id, occurrenceIntent);
      const occurrence = occurrenceIntent;
      if (occurrence) {
        occurrenceByRunId.set(run.id, occurrence);
        const semanticKey = occurrenceSemanticKey(run.sourceId, occurrence.scheduledAt);
        const owners = occurrenceOwners.get(semanticKey) || [];
        owners.push({ run, occurrence });
        occurrenceOwners.set(semanticKey, owners);
      }
    }
    return Object.freeze({
      byJob, byIdempotencyKey, positionByRunId, intentByRunId, intentOwners,
      occurrenceIntentByRunId, occurrenceByRunId, occurrenceOwners,
    });
  }

  #disposition(job, misfireSkip, reservation) {
    if (misfireSkip) return "CRON_MISFIRE_SKIPPED";
    if (job.overlapPolicy === "skip") {
      if (reservation.active || reservation.queued) return "CRON_OVERLAP_SKIPPED";
      reservation.active = true;
      return null;
    }
    if (!reservation.active && !reservation.queued) {
      reservation.active = true;
      return null;
    }
    if (reservation.queued) return "CRON_OVERLAP_QUEUE_FULL";
    reservation.queued = true;
    return null;
  }

  #advanceJob(job, wallNow, generation) {
    this.#assertGeneration(generation);
    if (job.schedule.kind === "at") {
      return this.cronStore.setJobEnabled({
        operationId: this.#advanceOperationId(job, "disabled"),
        jobId: job.id,
        enabled: false,
        nextRunAt: null,
        createdAt: wallNow,
      });
    }
    const nextRunAt = computeNextOccurrence(job.schedule, wallNow);
    if (nextRunAt === null) {
      return this.cronStore.setJobEnabled({
        operationId: this.#advanceOperationId(job, "exhausted"),
        jobId: job.id,
        enabled: false,
        nextRunAt: null,
        createdAt: wallNow,
      });
    }
    return this.cronStore.setJobNextRunAt({
      operationId: this.#advanceOperationId(job, nextRunAt),
      jobId: job.id,
      nextRunAt,
      createdAt: wallNow,
    });
  }

  #advanceOperationId(job, target) {
    return `cron-advance:${job.id}:${job.nextRunAt}:${target}`;
  }

  #assertOccurrenceBinding(run, frozen, scheduledAt) {
    const job = frozen.job;
    const occurrence = parseOccurrenceIntentKey(run?.idempotencyKey);
    if (run?.source !== "cron" || run.sourceId !== job.id
      || occurrence?.scheduledAt !== scheduledAt
      || run.profileId !== job.profileId || run.workspace !== job.workspace
      || run.retryOf !== null || !isScheduledOccurrence(job, scheduledAt)) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun occurrence 绑定损坏");
    }
    this.#assertOccurrenceBaseBinding(run, occurrence);
    if (occurrence.version === 2) {
      this.#assertOccurrenceExecutionBinding(run, occurrence, frozen);
    }
  }

  #assertOccurrenceBaseBinding(run, occurrence) {
    const jobMatches = occurrence?.version === 2
      && occurrence.baseFingerprint === occurrenceBaseFingerprint(run?.sourceId, occurrence.scheduledAt);
    if (!occurrence || run?.source !== "cron" || !UUID_PATTERN.test(run.sourceId)
      || !jobMatches || run.retryOf !== null) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun occurrence base 绑定损坏");
    }
  }

  #assertOccurrenceExecutionBinding(run, occurrence, frozen) {
    if (occurrence.executionFingerprint !== executionFingerprint(frozen.execution)
      || run.profileId !== frozen.job.profileId || run.workspace !== frozen.job.workspace) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun occurrence execution 绑定损坏");
    }
  }

  #dispatchIntent(kind, input) {
    const generation = this.generation;
    const runs = this.#cronRunSnapshot(generation);
    const runIndex = this.#buildRunIndex(runs);
    const expectedOperationHash = sha256(input.operationId);
    const owned = runIndex.intentOwners.get(expectedOperationHash) || [];
    if (owned.length > 1) {
      throw schedulerError("CRON_OPERATION_ID_CONFLICT", "operationId 已属于多个 Cron WorkRun");
    }
    if (owned.length === 1) {
      const existing = owned[0];
      this.#assertBaseIntentBinding(existing.run, existing.intent);
      const expectedRetryOf = kind === "retry" ? input.retryOf : null;
      if (existing.intent.kind !== kind || existing.intent.createdAt !== input.createdAt
        || existing.run.sourceId !== input.jobId || existing.run.retryOf !== expectedRetryOf) {
        throw schedulerError("CRON_OPERATION_ID_CONFLICT", "operationId 已用于不同 Cron 输入");
      }
      if (TERMINAL_WORK_RUN_STATUSES.has(existing.run.status)) {
        this.#assertTerminalDisposition(existing.run, existing.intent.disposition);
      }
      const recoveryAllowed = this.#assertReplayWindow(existing.intent.createdAt);
      if (!recoveryAllowed || TERMINAL_WORK_RUN_STATUSES.has(existing.run.status)) {
        return existing.run;
      }
      const currentJob = this.cronStore.getJob(existing.run.sourceId);
      if (!currentJob) return existing.run;
      try {
        const frozen = this.#freezeJobExecution(currentJob);
        this.#assertExecutionBinding(existing.intent, frozen.execution);
        if (existing.run.profileId !== frozen.job.profileId
          || existing.run.workspace !== frozen.job.workspace) return existing.run;
        const durableDisposition = frozen.targetDisabled
          ? "CRON_TARGET_DISABLED"
          : occurrenceDispositionResult(existing.intent.disposition);
        if (durableDisposition) {
          return existing.run.status === "queued"
            ? this.dispatcher.transition(existing.run.id, "skipped", {
              resultSummary: durableDisposition,
            }) : existing.run;
        }
        this.#startExecution(
          "recover", existing.run, frozen.job, existing.intent.createdAt, generation, true,
        );
      } catch (error) {
        if (error?.code !== "CRON_RUN_CORRUPT") throw error;
      }
      return existing.run;
    }

    if (runs.length >= MAX_CRON_RUN_SCAN) {
      throw schedulerError("CRON_RUN_CAPACITY", "Cron WorkRun 已达到容量上限");
    }

    this.#preflightOperationTimestamp(input.createdAt);
    const job = this.cronStore.getJob(input.jobId);
    if (!job) throw schedulerError("CRON_JOB_NOT_FOUND", "Cron Job 不存在");
    const frozen = this.#freezeJobExecution(job);
    const intent = Object.freeze({
      jobId: job.id,
      retryOf: kind === "retry" ? input.retryOf : null,
      createdAt: input.createdAt,
      profileId: frozen.execution.profileId,
      workspace: frozen.execution.workspace,
    });
    if (kind === "retry") this.#assertRetryReference(input.retryOf, frozen.job, runIndex);
    const reservation = { active: false, queued: false };
    for (const run of runs) {
      if (run.sourceId !== job.id) continue;
      if (ACTIVE_WORK_RUN_STATUSES.has(run.status)) reservation.active = true;
      if (run.status === "queued") reservation.queued = true;
    }
    const disposition = frozen.targetDisabled
      ? "CRON_TARGET_DISABLED"
      : this.#disposition(job, false, reservation);
    const runId = this.#newRunId();
    const key = cronIntentKey(
      kind, input.operationId, intent, frozen.execution, occurrenceDisposition(disposition),
    );
    const parsedIntent = parseCronIntentKey(key);
    const proposedRun = Object.freeze({
      source: "cron",
      sourceId: job.id,
      idempotencyKey: key,
      profileId: frozen.execution.profileId,
      workspace: frozen.execution.workspace,
      retryOf: intent.retryOf,
    });
    this.#assertBaseIntentBinding(proposedRun, parsedIntent);
    this.#assertExecutionBinding(parsedIntent, frozen.execution);
    const run = disposition === "CRON_TARGET_DISABLED"
      ? this.dispatcher.enqueueSkipped(
        { id: runId, ...proposedRun }, "CRON_TARGET_DISABLED",
      )
      : this.dispatcher.enqueue({ id: runId, ...proposedRun });
    // 单写者 snapshot 后的新建必然返回 runId；若全局 key 已被其它 source 占用，
    // enqueue 只返回旧 Run而不落新记录，此时允许在返回边界做纯字段校验。
    if (run.id !== runId) {
      this.#assertBaseIntentBinding(run, parsedIntent);
      this.#assertExecutionBinding(parsedIntent, frozen.execution);
    }
    if (disposition) {
      return run.status === "queued"
        ? this.dispatcher.transition(run.id, "skipped", { resultSummary: disposition })
        : run;
    }
    this.#startExecution("schedule", run, frozen.job, intent.createdAt, generation, false);
    return run;
  }

  #assertRetryReference(retryOf, job, runIndex) {
    const jobRuns = runIndex.byJob.get(job.id) || [];
    const prior = this.dispatcher.getRun(retryOf);
    const latest = jobRuns.at(-1) || null;
    if (!prior || prior.source !== "cron" || prior.sourceId !== job.id
      || prior.profileId !== job.profileId || latest?.id !== prior.id
      || !RETRYABLE_CRON_RUN_STATUSES.has(prior.status)) {
      throw schedulerError("CRON_RETRY_REFERENCE_INVALID", "retryOf 不是 Job 最新可重试终态 WorkRun");
    }
  }

  #assertBaseIntentBinding(run, intent) {
    const expectedRetry = intent?.kind === "retry";
    const reconstructed = intent && {
      jobId: run?.sourceId,
      retryOf: run?.retryOf ?? null,
      createdAt: intent.createdAt,
      profileId: run?.profileId,
      workspace: run?.workspace,
    };
    if (!intent || run?.source !== "cron" || !UUID_PATTERN.test(run.sourceId)
      || !validOpaqueId(run.profileId) || !(run.workspace === null
        || (typeof run.workspace === "string" && run.workspace.length > 0))
      || expectedRetry !== (run.retryOf !== null)
      || intent.baseFingerprint !== baseIntentFingerprint(intent.kind, reconstructed)) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun base intent 绑定损坏");
    }
  }

  #assertRetryLineage(run, runIndex) {
    const position = runIndex.positionByRunId.get(run.id);
    const prior = position && position.index > 0
      ? position.group[position.index - 1] : null;
    if (!prior || prior.id !== run.retryOf || prior.source !== "cron"
      || prior.sourceId !== run.sourceId || prior.profileId !== run.profileId
      || !RETRYABLE_CRON_RUN_STATUSES.has(prior.status)) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron retry WorkRun lineage 损坏");
    }
  }

  #assertExecutionBinding(intent, execution) {
    if (intent.executionFingerprint !== executionFingerprint(execution)) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron WorkRun execution 绑定损坏");
    }
  }

  #assertTerminalDisposition(run, disposition) {
    const expectedSummary = occurrenceDispositionResult(disposition);
    if (expectedSummary && (run.status !== "skipped"
      || run.resultSummary !== expectedSummary)) {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron durable disposition terminal 绑定损坏");
    }
  }

  #freezeJobExecution(job) {
    try {
      // Store 边界之外仍先取一次快照再校验，避免 getter/代理在 enqueue 前后
      // 改写 prompt、thread 或 workspace，留下无法安全恢复的 durable orphan。
      const snapshot = { ...job };
      if (!UUID_PATTERN.test(snapshot.id) || !validOpaqueId(snapshot.profileId)
        || !validExecutionText(snapshot.prompt, 1024 * 1024)
        || !validExecutionWorkspace(snapshot.workspace)
        || !OVERLAP_POLICIES.has(snapshot.overlapPolicy)
        || !THREAD_POLICIES.has(snapshot.threadPolicy)
        || !(snapshot.threadId === null || validOpaqueId(snapshot.threadId, 256))
        || (snapshot.threadPolicy === "new" && snapshot.threadId !== null)) {
        throw schedulerError("CRON_RUN_CORRUPT", "Cron Job execution material 损坏");
      }
      const targetState = this.resolveTargetState(snapshot.profileId);
      if (targetState !== "enabled" && targetState !== "disabled") {
        throw schedulerError("CRON_RUN_CORRUPT", "Cron Job target state 解析结果无效");
      }
      const resolvedWorkspace = this.resolveWorkspace(snapshot.profileId, snapshot.workspace);
      if (!validExecutionWorkspace(resolvedWorkspace)) {
        throw schedulerError("CRON_RUN_CORRUPT", "Cron Job workspace 解析结果无效");
      }
      const workspace = canonicalWorkspace(resolvedWorkspace);
      const frozenJob = Object.freeze({ ...snapshot, workspace });
      const execution = Object.freeze({
        profileId: snapshot.profileId,
        workspace,
        prompt: snapshot.prompt,
        threadPolicy: snapshot.threadPolicy,
        threadId: snapshot.threadId,
      });
      return Object.freeze({
        job: frozenJob,
        execution,
        targetDisabled: targetState === "disabled",
      });
    } catch {
      throw schedulerError("CRON_RUN_CORRUPT", "Cron Job execution material 损坏");
    }
  }

  #assertReplayWindow(createdAt) {
    const wallNow = this.#wallNow();
    const previousHighWater = this.wallClockHighWater ?? wallNow;
    const highWater = Math.max(previousHighWater, wallNow);
    if (createdAt < Math.max(0, highWater - IDEMPOTENCY_WINDOW_MS)) {
      throw schedulerError("CRON_OPERATION_EXPIRED", "Cron operation 已超出 30 天幂等窗口");
    }
    this.#observeWallClock(highWater);
    return wallNow >= previousHighWater;
  }

  #preflightOperationTimestamp(createdAt) {
    const wallNow = this.#wallNow();
    const highWater = this.wallClockHighWater ?? wallNow;
    if (wallNow < highWater) {
      throw schedulerError("CRON_CLOCK_ROLLBACK", "Cron operation 检测到 wall clock 回拨");
    }
    const trustedTime = Math.max(wallNow, highWater);
    if (createdAt > trustedTime + MAX_OPERATION_FUTURE_SKEW_MS) {
      throw schedulerError("CRON_TIMESTAMP_INVALID", "Cron operation createdAt 超出未来时钟偏差");
    }
    if (createdAt < Math.max(0, trustedTime - IDEMPOTENCY_WINDOW_MS)) {
      throw schedulerError("CRON_OPERATION_EXPIRED", "Cron operation 已超出 30 天幂等窗口");
    }
    this.#observeWallClock(trustedTime);
  }

  #observeWallClock(value) {
    if (!validTimestamp(value)) return;
    this.wallClockHighWater = this.wallClockHighWater === null
      ? value : Math.max(this.wallClockHighWater, value);
  }

  #startExecution(method, run, job, scheduledAt, generation, recovered) {
    const existing = this.inflight.get(run.id);
    if (existing || TERMINAL_WORK_RUN_STATUSES.has(run.status)) {
      if (existing && existing.generation !== generation) this.recoveryPending = true;
      return;
    }
    this.#assertGeneration(generation);
    const owner = this.activeByJob.get(run.sourceId);
    if (owner) {
      // Durable WorkRun 可在 executor Promise settle 前被外部收敛为 terminal；
      // 只有对应 inflight record 的 settle 才能释放 Job 单槽，否则会并发启动第二个 executor。
      this.recoveryPending = true;
      return;
    }
    if (this.inflight.size >= MAX_INFLIGHT_TASKS) {
      this.recoveryPending = true;
      return;
    }
    this.activeByJob.set(run.sourceId, run.id);
    let result;
    try {
      result = this.executor[method]({
        run,
        job,
        prompt: job.prompt,
        scheduledAt,
        operationId: run.idempotencyKey,
        threadPolicy: job.threadPolicy,
        threadId: job.threadId,
        recovered,
      });
    } catch (error) {
      result = Promise.reject(error);
    }
    // executor 属于领域外边界，raw Error 可能携带 prompt、路径或 provider 细节；
    // inflight promise 与 settled LRU 都只保留固定公开错误。
    const task = Promise.resolve(result).catch((error) => {
      this.#fatalOrOriginal(error);
      if (this.poisonError) throw this.poisonError;
      // 非持久化 executor 错误仍固定脱敏，不能让 raw provider/cause 越界。
      throw sanitizedExecutorError();
    });
    const record = { task, generation, jobId: run.sourceId };
    this.inflight.set(run.id, record);
    task.then(
      (value) => this.#settleTask(run.id, record, { value, error: null }),
      (error) => this.#settleTask(run.id, record, { value: null, error }),
    );
  }

  #settleTask(runId, record, outcome) {
    if (this.inflight.get(runId) !== record) return;
    this.inflight.delete(runId);
    if (this.activeByJob.get(record.jobId) === runId) this.activeByJob.delete(record.jobId);
    this.settled.delete(runId);
    this.settled.set(runId, { ...outcome, generation: record.generation });
    while (this.settled.size > MAX_SETTLED_TASKS) {
      this.settled.delete(this.settled.keys().next().value);
    }
    const needsTakeover = (outcome.error && record.generation !== this.generation)
      || this.recoveryPending;
    if (needsTakeover && this.state === "open") {
      this.recoveryPending = false;
      const takeoverGeneration = this.generation;
      queueMicrotask(() => {
        if (this.state !== "open" || this.generation !== takeoverGeneration) return;
        this.tick().catch(() => {});
      });
    }
  }

  #scheduleNextTimer(generation) {
    if (this.state !== "open" || generation !== this.generation) return;
    const next = this.cronStore.listJobs({ enabled: true })
      .map((job) => job.nextRunAt)
      .filter((value) => value !== null)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - this.#wallNow()));
    this.#armTimer(generation, delay);
  }

  #armTimer(generation, delay) {
    const timerGeneration = generation;
    this.timer = this.setTimer(() => {
      if (this.state !== "open" || this.generation !== timerGeneration) return;
      this.tick().catch(() => {});
    }, delay);
  }

  #handleTimerError(error, generation) {
    this.lastError = error;
    if (this.state !== "open" || this.generation !== generation) return;
    try {
      this.#clearScheduledTimer();
      this.#armTimer(generation, TIMER_RETRY_DELAY_MS);
    } catch {
      this.lastError = schedulerError(
        "CRON_TIMER_FAILED", "Cron Scheduler timer 重排失败",
      );
      this.state = "closed";
      this.generation += 1;
      this.#discardScheduledTimer();
    }
  }

  #clearScheduledTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  #discardScheduledTimer() {
    const timer = this.timer;
    this.timer = null;
    if (timer === null) return;
    try { this.clearTimer(timer); } catch {}
  }

  #wallNow() {
    const value = this.now();
    if (!validTimestamp(value)) throw schedulerError("CRON_TIMESTAMP_INVALID", "wall clock 无效");
    return value;
  }

  #monotonicTime() {
    const value = this.monotonicNow();
    if (!Number.isFinite(value) || value < 0) {
      throw schedulerError("CRON_MONOTONIC_CLOCK_INVALID", "monotonic clock 无效");
    }
    return value;
  }

  #newRunId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.randomUUID();
      if (UUID_PATTERN.test(value) && !this.dispatcher.getRun(value)) return value;
    }
    throw schedulerError("CRON_RUN_ID_CONFLICT", "无法生成唯一 Cron WorkRun ID");
  }

  #assertGeneration(generation) {
    if (this.poisonError) throw this.poisonError;
    if (generation !== this.generation || !["opening", "open"].includes(this.state)) {
      throw schedulerError("CRON_SCHEDULER_CLOSED", "Cron Scheduler generation 已关闭");
    }
  }

  #fatalKind(error) {
    const codeProbe = probeDataProperty(error, "code");
    if (!codeProbe.ok) return "poison";
    const commitProbe = probeDataProperty(error, "committedUncertain");
    if (!commitProbe.ok) return "poison";
    const poisonProbe = probeDataProperty(error, "poisoned");
    if (!poisonProbe.ok) return "poison";
    const code = codeProbe.value;
    if (commitProbe.value === true
      || (typeof code === "string" && code.endsWith("COMMIT_UNCERTAIN"))) return "commit";
    if (poisonProbe.value === true) return "poison";
    if (typeof code !== "string") return null;
    if (code.endsWith("_POISONED")) return "poison";
    if (code === "CRON_RUN_CORRUPT" || code.endsWith("_RUN_CORRUPT")) return "run";
    if (code === "STORE_CORRUPT" || code === "CRON_STORE_CORRUPT"
      || code.startsWith("STORE_CORRUPT_")
      || code.endsWith("_STORE_CORRUPT")) return "store";
    return null;
  }

  #fatalOrOriginal(error) {
    const kind = this.#fatalKind(error);
    return kind ? this.#markPoison(kind) : error;
  }

  #markPoison(kind) {
    if (this.poisonError) return this.poisonError;
    const [code, message] = kind === "commit"
      ? ["CRON_COMMIT_UNCERTAIN", "Cron 持久化状态不确定，必须重启 Service"]
      : kind === "run"
        ? ["CRON_RUN_CORRUPT", "Cron WorkRun 持久化绑定损坏，必须重启 Service"]
        : kind === "store"
          ? ["CRON_STORE_CORRUPT", "Cron 持久化存储损坏，必须重启 Service"]
          : ["CRON_SCHEDULER_POISONED", "Cron Scheduler 状态不安全，必须重启 Service"];
    const fatal = schedulerError(code, message);
    if (kind === "commit") fatal.committedUncertain = true;
    fatal.poisoned = true;
    Object.freeze(fatal);
    // 先发布 sticky poison；callback 即使同步重入，也只能观察同一脱敏错误。
    this.lastError = fatal;
    this.poisonError = fatal;
    this.state = "poisoned";
    this.generation += 1;
    this.#discardScheduledTimer();
    if (this.onFatalError) {
      try {
        Promise.resolve(this.onFatalError(fatal)).catch(() => {});
      } catch {}
    }
    return fatal;
  }
}

module.exports = {
  MAX_CRON_RUN_SCAN,
  MAX_CRON_SCAN_STEPS,
  MAX_INFLIGHT_TASKS,
  MAX_SETTLED_TASKS,
  MAX_TIMER_DELAY_MS,
  TIMER_RETRY_DELAY_MS,
  NativeCronScheduler,
  describeCronRun,
  dueOccurrences,
  occurrenceKey,
};
