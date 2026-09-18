#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { NativeCronStore, computeNextOccurrence } = require(path.join(
  ROOT, "app", "agent-service", "native-cron-store.js",
));
const { resolveServicePaths } = require(path.join(
  ROOT, "app", "agent-service", "paths.js",
));
const { createWorkDispatcher } = require(path.join(
  ROOT, "app", "agent-service", "work-run.js",
));
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));

let NativeCronScheduler;
let dueOccurrences;
let describeCronRun;
let MAX_INFLIGHT_TASKS;
let MAX_CRON_SCAN_STEPS;
let MAX_CRON_RUN_SCAN;
let TIMER_RETRY_DELAY_MS;
let moduleLoadError = null;
try {
  ({
    NativeCronScheduler, dueOccurrences, describeCronRun, MAX_INFLIGHT_TASKS, MAX_CRON_SCAN_STEPS,
    MAX_CRON_RUN_SCAN, TIMER_RETRY_DELAY_MS,
  } = require(path.join(
    ROOT, "app", "agent-service", "native-cron-scheduler.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
const roots = new Set();
const EVERY_INTERVAL_MS = 60_000;
const tickAt = (value) => value * EVERY_INTERVAL_MS;
function test(name, fn) { tests.push({ name, fn }); }

function runtimePatch(sessionId, turnId) {
  const binding = {
    runtime: "codex",
    runtimeProfileId: `shoggoth-${DEFAULT_AGENT_PROFILE_ID}`,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  };
  return {
    runtimeSessionRef: { ...binding, sessionId },
    runtimeTurnRef: { ...binding, sessionId, turnId },
  };
}

function uuidFactory(offset = 0) {
  let value = offset;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cron-scheduler-"));
  roots.add(root);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const clock = options.clock || { value: tickAt(5), monotonic: 10_000 };
  const productStore = new JsonlProductStore({ paths, now: () => clock.value });
  productStore.open();
  const dispatcher = createWorkDispatcher({ store: productStore, now: () => clock.value });
  const cronStore = new NativeCronStore({
    paths,
    now: () => clock.value,
    randomUUID: uuidFactory(100),
    profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
  });
  cronStore.open();
  const executor = options.executor || {
    calls: [],
    schedule(payload) { this.calls.push({ kind: "schedule", ...payload }); },
    recover(payload) { this.calls.push({ kind: "recover", ...payload }); },
  };
  const timer = {
    nextId: 0,
    entries: new Map(),
    set(callback, delay) {
      const id = ++this.nextId;
      this.entries.set(id, { callback, delay });
      return id;
    },
    clear(id) { this.entries.delete(id); },
  };
  return {
    root, paths, clock, productStore, dispatcher, cronStore, executor, timer,
    createScheduler(overrides = {}) {
      return new NativeCronScheduler({
        cronStore,
        dispatcher,
        executor,
        now: () => clock.value,
        monotonicNow: () => clock.monotonic,
        setTimer: timer.set.bind(timer),
        clearTimer: timer.clear.bind(timer),
        randomUUID: uuidFactory(500),
        ...overrides,
      });
    },
    close() {
      cronStore.close();
      productStore.close();
    },
  };
}

function createEveryJob(ctx, overrides = {}) {
  const createdAt = overrides.createdAt ?? 1;
  const everyMs = overrides.everyMs ?? EVERY_INTERVAL_MS;
  const anchorMs = overrides.anchorMs ?? 0;
  const nextRunAt = overrides.nextRunAt ?? (
    anchorMs + (Math.floor((createdAt - anchorMs) / everyMs) + 1) * everyMs
  );
  return ctx.cronStore.createJob({
    operationId: overrides.operationId || `create-${Math.random().toString(16).slice(2)}`,
    name: overrides.name || "Scheduled review",
    enabled: true,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: overrides.prompt || "Review the workspace and summarize progress.",
    workspace: overrides.workspace ?? "/tmp/shoggoth-cron",
    schedule: { kind: "every", everyMs, anchorMs },
    misfirePolicy: overrides.misfirePolicy || "latest",
    maxCatchUp: overrides.maxCatchUp || 1,
    overlapPolicy: overrides.overlapPolicy || "skip",
    threadPolicy: overrides.threadPolicy || "new",
    threadId: overrides.threadId ?? null,
    nextRunAt,
    createdAt,
  });
}

function cronRuns(ctx, jobId) {
  return ctx.dispatcher.listRuns({ source: "cron", sourceId: jobId });
}

function forwardCronTruth(schedule, first, wallNow) {
  const occurrences = [first];
  let cursor = first;
  while (true) {
    const next = computeNextOccurrence(schedule, cursor);
    if (next === null || next > wallNow) return occurrences;
    assert.ok(next > cursor);
    occurrences.push(next);
    cursor = next;
    assert.ok(occurrences.length <= 10_000, "test forward truth must remain bounded");
  }
}

function testCronIntentKey(kind, operationId, jobId, retryOf, createdAt, options = {}) {
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const profileId = options.profileId ?? DEFAULT_AGENT_PROFILE_ID;
  const rawWorkspace = Object.prototype.hasOwnProperty.call(options, "workspace")
    ? options.workspace : "/tmp/shoggoth-cron";
  let workspace = rawWorkspace;
  if (rawWorkspace !== null) {
    const missing = [];
    let cursor = path.resolve(rawWorkspace);
    while (true) {
      try {
        workspace = path.join(fs.realpathSync.native(cursor), ...missing);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  }
  const prompt = options.prompt ?? "Review the workspace and summarize progress.";
  const threadPolicy = options.threadPolicy ?? "new";
  const threadId = options.threadId ?? null;
  const disposition = options.disposition ?? "run";
  const base = hash(JSON.stringify([
    kind, jobId, retryOf, createdAt, profileId, workspace,
  ]));
  const execution = hash(JSON.stringify([
    profileId, workspace, prompt, threadPolicy, threadId,
  ]));
  return `shoggoth:cron:v2:${kind}:${hash(operationId)}:${createdAt}:${base}:${execution}:${disposition}`;
}

function testOccurrenceIntentKey(job, scheduledAt, disposition = "run") {
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  let workspace = job.workspace;
  if (workspace !== null) {
    const missing = [];
    let cursor = path.resolve(workspace);
    while (true) {
      try {
        workspace = path.join(fs.realpathSync.native(cursor), ...missing);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  }
  const base = hash(JSON.stringify(["occurrence", job.id, scheduledAt]));
  const execution = hash(JSON.stringify([
    job.profileId, workspace, job.prompt, job.threadPolicy, job.threadId,
  ]));
  return `shoggoth:cron:v2:occurrence:${base}:${execution}:${disposition}:${scheduledAt}`;
}

function assertDescribeCronRunContract() {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const run = (idempotencyKey, overrides = {}) => ({
    source: "cron",
    sourceId: jobId,
    idempotencyKey,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: null,
    status: "queued",
    retryOf: null,
    ...overrides,
  });
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const occurrenceBase = hash(JSON.stringify(["occurrence", jobId, 120_000]));
  assert.deepEqual(describeCronRun(run(
    `shoggoth:cron:v2:occurrence:${occurrenceBase}:${"b".repeat(64)}:run:120000`,
  )), { kind: "schedule", createdAt: 120_000 });
  assert.deepEqual(describeCronRun(run(
    testCronIntentKey("manual", "describe-manual", jobId, null, 130_000, {
      disposition: "overlap-skipped", workspace: null,
    }),
  )), { kind: "manual", createdAt: 130_000 });
  assert.deepEqual(describeCronRun(run(
    testCronIntentKey("retry", "describe-retry", jobId, "run-prior", 140_000, {
      workspace: null,
    }),
    { retryOf: "run-prior" },
  )), { kind: "retry", createdAt: 140_000 });
  assert.deepEqual(describeCronRun(run(`${jobId}:150000`, {
    status: "completed",
  })), { kind: "schedule", createdAt: 150_000 });
  const badHash = "a".repeat(64);
  const base = {
    source: "cron", sourceId: jobId, profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: null, status: "queued", retryOf: null,
  };
  const cases = [
    null,
    { ...base, idempotencyKey: "bad-key" },
    { ...base, idempotencyKey: `${jobId}:150000` },
    { ...base, status: "completed", sourceId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: `${jobId}:150000` },
    { ...base, retryOf: "run-prior",
      idempotencyKey: testCronIntentKey("manual", "bad-manual", jobId, null, 130_000, {
        workspace: null,
      }) },
    { ...base,
      idempotencyKey: testCronIntentKey("retry", "bad-retry", jobId, "run-prior", 140_000, {
        workspace: null,
      }) },
    { ...base,
      idempotencyKey: `shoggoth:cron:v2:occurrence:${badHash}:${badHash}:run:0150000` },
  ];
  for (const value of cases) assert.equal(describeCronRun(value), null);
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "idempotencyKey", {
    enumerable: true,
    get() { reads += 1; throw new Error("secret getter"); },
  });
  assert.equal(describeCronRun(hostile), null);
  assert.equal(reads, 0);
}

test("NativeCronScheduler 模块与 describeCronRun 投影可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof NativeCronScheduler, "function");
  assert.equal(MAX_INFLIGHT_TASKS, 256);
  assert.equal(MAX_CRON_SCAN_STEPS, 512);
  assert.equal(MAX_CRON_RUN_SCAN, 65_536);
  assertDescribeCronRunContract();
  const ctx = fixture();
  assert.throws(
    () => ctx.createScheduler({ onFatalError: "invalid" }),
    (error) => error.code === "CRON_SCHEDULER_OPTIONS_INVALID",
  );
  assert.throws(
    () => ctx.createScheduler({ resolveTargetState: "invalid" }),
    (error) => error.code === "CRON_SCHEDULER_OPTIONS_INVALID",
  );
  ctx.close();
});

test("disabled AgentProfile 的定时 occurrence 记为 skipped 并推进计划", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-disabled-target-occurrence",
    createdAt: tickAt(5),
    nextRunAt: tickAt(6),
  });
  const scheduler = ctx.createScheduler({
    resolveTargetState(profileId) {
      assert.equal(profileId, DEFAULT_AGENT_PROFILE_ID);
      return "disabled";
    },
  });
  await scheduler.open();
  ctx.clock.value = tickAt(6);
  await scheduler.tick();
  const [run] = cronRuns(ctx, job.id);
  assert.equal(run.status, "skipped");
  assert.equal(run.resultSummary, "CRON_TARGET_DISABLED");
  assert.match(run.idempotencyKey, /:target-disabled:/u);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(7));
  assert.equal(ctx.executor.calls.length, 0);
  assert.equal(scheduler.state, "open");
  await scheduler.close();
  ctx.close();
});

test("disabled AgentProfile 的 manual trigger 可审计跳过且 exact replay 稳定", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-disabled-target-manual",
    createdAt: tickAt(5),
    nextRunAt: tickAt(6),
  });
  const scheduler = ctx.createScheduler({ resolveTargetState: () => "disabled" });
  await scheduler.open();
  const input = {
    operationId: "trigger-disabled-target-manual",
    jobId: job.id,
    createdAt: tickAt(5),
  };
  const run = scheduler.triggerJob(input);
  assert.equal(run.status, "skipped");
  assert.equal(run.resultSummary, "CRON_TARGET_DISABLED");
  assert.match(run.idempotencyKey, /:target-disabled$/u);
  assert.equal(scheduler.triggerJob(input).id, run.id);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("Cron target state 缺失或非法仍 fail closed", async () => {
  for (const resolveTargetState of [() => "missing", () => { throw new Error("missing"); }]) {
    const ctx = fixture();
    createEveryJob(ctx, {
      operationId: `create-invalid-target-${Math.random()}`,
      createdAt: tickAt(5),
      nextRunAt: tickAt(6),
    });
    const scheduler = ctx.createScheduler({ resolveTargetState });
    await assert.rejects(
      () => scheduler.open(),
      (error) => error.code === "CRON_RUN_CORRUPT",
    );
    assert.equal(ctx.executor.calls.length, 0);
    await scheduler.close();
    ctx.close();
  }
});

test("manual trigger 先持久唯一 Cron WorkRun 再执行且不持久 prompt", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-trigger",
    createdAt: tickAt(5),
  });
  const order = [];
  const dispatcher = {
    enqueue(input) {
      order.push("workrun");
      return ctx.dispatcher.enqueue(input);
    },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const executor = {
    calls: [],
    schedule(payload) {
      order.push("executor");
      this.calls.push(payload);
    },
    recover() { throw new Error("unexpected recover"); },
  };
  const scheduler = ctx.createScheduler({ dispatcher, executor });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "manual-trigger-1",
    jobId: job.id,
    createdAt: tickAt(5),
  });
  assert.deepEqual(order, ["workrun", "executor"]);
  assert.equal(run.source, "cron");
  assert.equal(run.sourceId, job.id);
  assert.equal(run.retryOf, null);
  assert.match(run.idempotencyKey, /^shoggoth:cron:v2:manual:/u);
  assert.equal(Object.prototype.hasOwnProperty.call(run, "prompt"), false);
  assert.equal(executor.calls[0].prompt, job.prompt);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, job.nextRunAt);
  await scheduler.close();
  ctx.close();
});

test("Cron workspace=null 在 durable WorkRun 前解析为 Profile 托管目录", async () => {
  const ctx = fixture();
  const managedWorkspace = path.join(ctx.paths.defaultWorkspaceDir, DEFAULT_AGENT_PROFILE_ID);
  const job = ctx.cronStore.createJob({
    operationId: "create-managed-workspace",
    name: "Managed workspace",
    enabled: true,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: "Use the managed workspace.",
    workspace: null,
    schedule: { kind: "every", everyMs: EVERY_INTERVAL_MS, anchorMs: 0 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: tickAt(6),
    createdAt: tickAt(5),
  });
  const resolutions = [];
  const scheduler = ctx.createScheduler({
    resolveWorkspace(profileId, requested) {
      resolutions.push({ profileId, requested });
      fs.mkdirSync(managedWorkspace, { recursive: true });
      return managedWorkspace;
    },
  });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "trigger-managed-workspace",
    jobId: job.id,
    createdAt: tickAt(5),
  });
  assert.ok(resolutions.length >= 1);
  assert.ok(resolutions.every(({ profileId, requested }) => (
    profileId === DEFAULT_AGENT_PROFILE_ID && requested === null
  )));
  assert.equal(run.workspace, fs.realpathSync(managedWorkspace));
  assert.equal(ctx.executor.calls[0].run.workspace, fs.realpathSync(managedWorkspace));
  assert.equal(ctx.executor.calls[0].job.workspace, fs.realpathSync(managedWorkspace));
  await scheduler.close();
  ctx.close();
});

test("Cron 显式 workspace 仍经过统一 resolver 且保持 canonical binding", async () => {
  const ctx = fixture();
  const explicitWorkspace = path.join(ctx.root, "explicit-workspace");
  fs.mkdirSync(explicitWorkspace);
  const job = createEveryJob(ctx, {
    operationId: "create-explicit-workspace",
    createdAt: tickAt(5),
    nextRunAt: tickAt(6),
    workspace: explicitWorkspace,
  });
  let calls = 0;
  const scheduler = ctx.createScheduler({
    resolveWorkspace(profileId, requested) {
      calls += 1;
      assert.equal(profileId, DEFAULT_AGENT_PROFILE_ID);
      assert.equal(requested, explicitWorkspace);
      return requested;
    },
  });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "trigger-explicit-workspace",
    jobId: job.id,
    createdAt: tickAt(5),
  });
  assert.ok(calls >= 1);
  assert.equal(run.workspace, fs.realpathSync(explicitWorkspace));
  await scheduler.close();
  ctx.close();
});

test("manual trigger exact replay 返回同 Run，operationId 改绑 job/time 时零新增", async () => {
  const ctx = fixture();
  const firstJob = createEveryJob(ctx, {
    operationId: "create-manual-replay-a", createdAt: tickAt(5),
  });
  const secondJob = createEveryJob(ctx, {
    operationId: "create-manual-replay-b", createdAt: tickAt(5), name: "Second job",
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const input = {
    operationId: "manual-replay-1", jobId: firstJob.id, createdAt: tickAt(5),
  };
  const first = scheduler.triggerJob(input);
  const replay = scheduler.triggerJob(input);
  assert.equal(replay.id, first.id);
  assert.equal(ctx.executor.calls.length, 1);
  assert.throws(
    () => scheduler.triggerJob({ ...input, jobId: secondJob.id }),
    (error) => error.code === "CRON_OPERATION_ID_CONFLICT",
  );
  assert.throws(
    () => scheduler.triggerJob({ ...input, createdAt: tickAt(5) + 1 }),
    (error) => error.code === "CRON_OPERATION_ID_CONFLICT",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, 1);
  await scheduler.close();
  ctx.close();
});

test("exact replay 对 unchanged queued Run 仅 singleflight recover 一次", async () => {
  let resolveRecovery;
  const recovery = new Promise((resolve) => { resolveRecovery = resolve; });
  const executor = {
    calls: [],
    schedule(payload) {
      this.calls.push({ kind: "schedule", ...payload });
      return Promise.reject(new Error("first dispatch failed"));
    },
    recover(payload) {
      this.calls.push({ kind: "recover", ...payload });
      return recovery;
    },
  };
  const ctx = fixture({ executor });
  const job = createEveryJob(ctx, {
    operationId: "create-replay-recover", createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const scheduler = ctx.createScheduler({ executor });
  await scheduler.open();
  const input = {
    operationId: "manual-replay-recover", jobId: job.id, createdAt: tickAt(5),
  };
  const run = scheduler.triggerJob(input);
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  assert.equal(scheduler.triggerJob(input).id, run.id);
  assert.equal(scheduler.triggerJob(input).id, run.id);
  assert.deepEqual(executor.calls.map((call) => call.kind), ["schedule", "recover"]);
  resolveRecovery();
  await scheduler.waitForIdle(run.id);
  await scheduler.close();
  ctx.close();
});

test("exact replay 在 clock 回拨与 Job 删除后仍先按 durable owner 稳定返回", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-replay-before-mutable-state", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const input = {
    operationId: "manual-replay-before-mutable-state",
    jobId: job.id,
    createdAt: tickAt(5),
  };
  const first = scheduler.triggerJob(input);
  ctx.cronStore.deleteJob({
    operationId: "delete-before-manual-replay", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.clock.value = tickAt(4);
  assert.equal(scheduler.triggerJob(input).id, first.id);
  assert.throws(
    () => scheduler.triggerJob({ ...input, createdAt: tickAt(5) + 1 }),
    (error) => error.code === "CRON_OPERATION_ID_CONFLICT",
  );
  assert.equal(ctx.executor.calls.length, 1);
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, 1);
  ctx.clock.value = tickAt(5) + (30 * 24 * 60 * 60 * 1000);
  assert.equal(scheduler.triggerJob(input).id, first.id);
  assert.equal(ctx.executor.calls.length, 1);
  ctx.clock.value += 1;
  assert.throws(
    () => scheduler.triggerJob(input),
    (error) => error.code === "CRON_OPERATION_EXPIRED",
  );
  await scheduler.close();
  ctx.close();
});

test("exact replay 遇到 Job execution config drift 稳定返回且不恢复副作用", async () => {
  const executor = {
    calls: [],
    schedule(payload) {
      this.calls.push({ kind: "schedule", ...payload });
      return Promise.reject(new Error("offline"));
    },
    recover(payload) { this.calls.push({ kind: "recover", ...payload }); },
  };
  const ctx = fixture({ executor });
  const job = createEveryJob(ctx, {
    operationId: "create-replay-config-drift", createdAt: tickAt(5), nextRunAt: tickAt(6),
    prompt: "original replay prompt",
  });
  const scheduler = ctx.createScheduler({ executor });
  await scheduler.open();
  const input = {
    operationId: "manual-replay-config-drift", jobId: job.id, createdAt: tickAt(5),
  };
  const run = scheduler.triggerJob(input);
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  ctx.cronStore.updateJob({
    operationId: "change-replay-config",
    jobId: job.id,
    patch: { prompt: "changed replay prompt must never execute" },
    createdAt: tickAt(5),
  });
  assert.equal(scheduler.triggerJob(input).id, run.id);
  assert.deepEqual(executor.calls.map((call) => call.kind), ["schedule"]);
  await scheduler.close();
  ctx.close();
});

test("retry 创建新 WorkRun 并精确保留 retryOf，旧 Run 结果不被覆盖", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-retry-job", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const prior = scheduler.triggerJob({
    operationId: "manual-before-retry", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.admit(prior.id, { onBusy: "queue" });
  ctx.dispatcher.transition(prior.id, "running", {
    ...runtimePatch("thread-prior", "turn-prior"),
  });
  ctx.dispatcher.transition(prior.id, "failed", { errorCode: "PRIOR_FAILED" });
  const retryInput = {
    operationId: "retry-operation-1",
    jobId: job.id,
    retryOf: prior.id,
    createdAt: tickAt(5) + 1,
  };
  assert.throws(
    () => scheduler.retryRun({ ...retryInput, operationId: "manual-before-retry" }),
    (error) => error.code === "CRON_OPERATION_ID_CONFLICT",
  );
  const retry = scheduler.retryRun(retryInput);
  assert.notEqual(retry.id, prior.id);
  assert.equal(retry.retryOf, prior.id);
  assert.match(retry.idempotencyKey, /^shoggoth:cron:v2:retry:/u);
  assert.equal(retry.codexThreadId, null);
  assert.equal(retry.codexTurnId, null);
  const preservedPrior = ctx.dispatcher.getRun(prior.id);
  assert.equal(preservedPrior.runtimeSessionRef.sessionId, "thread-prior");
  assert.equal(preservedPrior.runtimeTurnRef.turnId, "turn-prior");
  assert.equal(preservedPrior.errorCode, "PRIOR_FAILED");
  assert.equal(scheduler.retryRun(retryInput).id, retry.id);
  assert.throws(
    () => scheduler.retryRun({ ...retryInput, createdAt: tickAt(5) + 2 }),
    (error) => error.code === "CRON_OPERATION_ID_CONFLICT",
  );
  assert.throws(
    () => scheduler.retryRun({
      operationId: "retry-non-latest",
      jobId: job.id,
      retryOf: prior.id,
      createdAt: tickAt(5) + 2,
    }),
    (error) => error.code === "CRON_RETRY_REFERENCE_INVALID",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.executor.calls.length, 2);
  await scheduler.close();
  ctx.close();
});

test("manual trigger 复用 Cron overlap policy，skip 时只留 durable skipped Run", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-overlap", createdAt: tickAt(5), overlapPolicy: "skip",
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const active = scheduler.triggerJob({
    operationId: "manual-overlap-active", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.admit(active.id, { onBusy: "queue" });
  ctx.dispatcher.transition(active.id, "running");
  const skipped = scheduler.triggerJob({
    operationId: "manual-overlap-skipped", jobId: job.id, createdAt: tickAt(5) + 1,
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.resultSummary, "CRON_OVERLAP_SKIPPED");
  assert.equal(ctx.executor.calls.length, 1);
  assert.equal(ctx.dispatcher.listRuns({ source: "cron", sourceId: job.id }).length, 2);
  await scheduler.close();
  ctx.close();
});

test("manual overlap skip decision 在 transition crash cut 后不恢复执行", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-overlap-crash-cut",
    createdAt: tickAt(5), nextRunAt: tickAt(6), overlapPolicy: "skip",
  });
  const transitionError = Object.assign(new Error("known manual transition failure"), {
    code: "STORE_WRITE_FAILED",
  });
  let failedRunId = null;
  let failTransition = false;
  const dispatcher = {
    enqueue: (...args) => ctx.dispatcher.enqueue(...args),
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition(...args) {
      if (failTransition && args[1] === "skipped") {
        failedRunId = args[0];
        throw transitionError;
      }
      return ctx.dispatcher.transition(...args);
    },
  };
  const first = ctx.createScheduler({ dispatcher });
  await first.open();
  const active = first.triggerJob({
    operationId: "manual-overlap-crash-active", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.admit(active.id, { onBusy: "queue" });
  ctx.dispatcher.transition(active.id, "running");
  failTransition = true;
  assert.throws(
    () => first.triggerJob({
      operationId: "manual-overlap-crash-skipped",
      jobId: job.id,
      createdAt: tickAt(5) + 1,
    }),
    (error) => error === transitionError,
  );
  const queued = ctx.dispatcher.getRun(failedRunId);
  assert.equal(queued.status, "queued");
  assert.match(queued.idempotencyKey, /:overlap-skipped$/u);
  await first.close();

  failTransition = false;
  ctx.executor.calls.length = 0;
  const recovered = ctx.createScheduler();
  await recovered.open();
  assert.equal(ctx.dispatcher.getRun(queued.id).status, "skipped");
  assert.deepEqual(ctx.executor.calls.map((call) => call.run.id), [active.id]);
  await recovered.close();
  ctx.close();
});

test("retry 对 active/completed/跨 job/非最新引用均 fail closed 且零 orphan", async () => {
  const ctx = fixture();
  const firstJob = createEveryJob(ctx, {
    operationId: "create-retry-validation-a", createdAt: tickAt(5),
  });
  const secondJob = createEveryJob(ctx, {
    operationId: "create-retry-validation-b", createdAt: tickAt(5), name: "Other job",
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const active = scheduler.triggerJob({
    operationId: "manual-active", jobId: firstJob.id, createdAt: tickAt(5),
  });
  const baseCount = ctx.dispatcher.listRuns({ source: "cron" }).length;
  assert.throws(
    () => scheduler.retryRun({
      operationId: "retry-active", jobId: firstJob.id,
      retryOf: active.id, createdAt: tickAt(5) + 1,
    }),
    (error) => error.code === "CRON_RETRY_REFERENCE_INVALID",
  );
  assert.throws(
    () => scheduler.retryRun({
      operationId: "retry-cross-job", jobId: secondJob.id,
      retryOf: active.id, createdAt: tickAt(5) + 1,
    }),
    (error) => error.code === "CRON_RETRY_REFERENCE_INVALID",
  );
  ctx.dispatcher.admit(active.id, { onBusy: "queue" });
  ctx.dispatcher.transition(active.id, "running");
  ctx.dispatcher.transition(active.id, "completed", { resultSummary: "already done" });
  assert.throws(
    () => scheduler.retryRun({
      operationId: "retry-completed", jobId: firstJob.id,
      retryOf: active.id, createdAt: tickAt(5) + 1,
    }),
    (error) => error.code === "CRON_RETRY_REFERENCE_INVALID",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, baseCount);
  await scheduler.close();
  ctx.close();
});

test("manual operation 的过期、未来与 wall clock 回拨在 enqueue 前拒绝", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-time-fences", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.throws(
    () => scheduler.triggerJob({
      operationId: "manual-future", jobId: job.id,
      createdAt: tickAt(5) + (5 * 60_000) + 1,
    }),
    (error) => error.code === "CRON_TIMESTAMP_INVALID",
  );
  const first = scheduler.triggerJob({
    operationId: "manual-before-rollback", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.transition(first.id, "skipped", { resultSummary: "test terminal" });
  ctx.clock.value = tickAt(4);
  assert.throws(
    () => scheduler.triggerJob({
      operationId: "manual-after-rollback", jobId: job.id, createdAt: tickAt(4),
    }),
    (error) => error.code === "CRON_CLOCK_ROLLBACK",
  );
  ctx.clock.value = tickAt(5) + (30 * 24 * 60 * 60 * 1000);
  const boundary = scheduler.triggerJob({
    operationId: "manual-at-expiry-floor", jobId: job.id, createdAt: tickAt(5),
  });
  assert.equal(boundary.sourceId, job.id);
  ctx.clock.value += 1;
  assert.throws(
    () => scheduler.triggerJob({
      operationId: "manual-expired", jobId: job.id, createdAt: tickAt(5),
    }),
    (error) => error.code === "CRON_OPERATION_EXPIRED",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, 2);
  await scheduler.close();
  ctx.close();
});

test("manual enqueue 的 STORE_COMMIT_UNCERTAIN sticky poison 并清除 timer", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-uncertain", createdAt: tickAt(5),
  });
  const secret = "manual-uncertain-secret-must-not-survive";
  const uncertain = Object.assign(new Error(secret), {
    code: "STORE_COMMIT_UNCERTAIN", committedUncertain: true,
    cause: new Error(secret),
  });
  let rejectEnqueue = false;
  let enqueueCalls = 0;
  const dispatcher = {
    enqueue(...args) {
      enqueueCalls += 1;
      if (rejectEnqueue) throw uncertain;
      return ctx.dispatcher.enqueue(...args);
    },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const fatalSignals = [];
  let reentrantError = null;
  let scheduler;
  const input = {
    operationId: "manual-uncertain", jobId: job.id, createdAt: tickAt(5),
  };
  scheduler = ctx.createScheduler({
    dispatcher,
    onFatalError(error) {
      fatalSignals.push(error);
      try { scheduler.triggerJob(input); } catch (reentrant) { reentrantError = reentrant; }
      throw new Error("fatal-callback-secret-must-not-escape");
    },
  });
  await scheduler.open();
  assert.equal(ctx.timer.entries.size, 1);
  rejectEnqueue = true;
  let fatal;
  assert.throws(() => scheduler.triggerJob(input), (error) => {
    fatal = error;
    return error.code === "CRON_COMMIT_UNCERTAIN"
      && error.message === "Cron 持久化状态不确定，必须重启 Service";
  });
  assert.equal(scheduler.state, "poisoned");
  assert.equal(ctx.timer.entries.size, 0);
  assert.deepEqual(fatalSignals, [fatal]);
  assert.equal(reentrantError, fatal);
  assert.equal(Object.prototype.hasOwnProperty.call(fatal, "cause"), false);
  assert.equal(JSON.stringify(fatal, Object.getOwnPropertyNames(fatal)).includes(secret), false);
  assert.equal(Object.isFrozen(fatal), true);
  assert.throws(
    () => scheduler.retryRun({ ...input, retryOf: "prior-run" }),
    (error) => error === fatal,
  );
  await assert.rejects(() => scheduler.tick(), (error) => error === fatal);
  await assert.rejects(() => scheduler.open(), (error) => error === fatal);
  assert.equal(enqueueCalls, 1);
  await scheduler.close();
  await assert.rejects(() => scheduler.open(), (error) => error === fatal);
  assert.equal(fatalSignals.length, 1);
  ctx.close();
});

test("manual enqueue 前冻结 canonical workspace，symlink 迟到变化不制造 orphan", async () => {
  const ctx = fixture();
  const target = path.join(ctx.root, "workspace-target");
  const alias = path.join(ctx.root, "workspace-alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias);
  const job = createEveryJob(ctx, {
    operationId: "create-manual-workspace-freeze",
    createdAt: tickAt(5),
    workspace: alias,
  });
  let unlinkAfterEnqueue = true;
  const dispatcher = {
    enqueue(input) {
      const run = ctx.dispatcher.enqueue(input);
      if (unlinkAfterEnqueue) {
        unlinkAfterEnqueue = false;
        fs.unlinkSync(alias);
      }
      return run;
    },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const executor = {
    calls: [],
    schedule(payload) { this.calls.push(payload); },
    recover() { throw new Error("unexpected recover"); },
  };
  const scheduler = ctx.createScheduler({ dispatcher, executor });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "manual-workspace-freeze", jobId: job.id, createdAt: tickAt(5),
  });
  const canonicalTarget = fs.realpathSync.native(target);
  assert.equal(run.workspace, canonicalTarget);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].job.workspace, canonicalTarget);
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, 1);
  await scheduler.close();
  ctx.close();
});

test("manual enqueue 前验证全部 immutable execution material", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-invalid-execution-material", createdAt: tickAt(5),
  });
  let corruptPrompt = false;
  let enqueueCalls = 0;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "getJob") return (jobId) => {
        const current = target.getJob(jobId);
        return corruptPrompt && current ? { ...current, prompt: "invalid\0prompt" } : current;
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const dispatcher = {
    enqueue(...args) { enqueueCalls += 1; return ctx.dispatcher.enqueue(...args); },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const scheduler = ctx.createScheduler({ cronStore, dispatcher });
  await scheduler.open();
  corruptPrompt = true;
  assert.throws(
    () => scheduler.triggerJob({
      operationId: "invalid-execution-material", jobId: job.id, createdAt: tickAt(5),
    }),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(enqueueCalls, 0);
  assert.equal(ctx.dispatcher.listRuns({ source: "cron" }).length, 0);
  await scheduler.close();
  ctx.close();
});

test("重启对 queued manual durable intent 走 recover，binding 被改写则 fail closed", async () => {
  const failing = {
    schedule() { return Promise.reject(new Error("offline")); },
    recover() { throw new Error("unexpected recover"); },
  };
  const ctx = fixture({ executor: failing });
  const job = createEveryJob(ctx, {
    operationId: "create-manual-recovery", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler({ executor: failing });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "manual-recovery", jobId: job.id, createdAt: tickAt(5),
  });
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  await scheduler.close();

  const recoveredExecutor = {
    calls: [],
    schedule() { throw new Error("unexpected schedule"); },
    recover(payload) { this.calls.push(payload); },
  };
  const recovered = ctx.createScheduler({ executor: recoveredExecutor });
  await recovered.open();
  assert.equal(recoveredExecutor.calls.length, 1);
  assert.equal(recoveredExecutor.calls[0].run.id, run.id);
  assert.equal(recoveredExecutor.calls[0].operationId, run.idempotencyKey);
  await recovered.close();

  ctx.cronStore.updateJob({
    operationId: "change-manual-binding",
    jobId: job.id,
    patch: { workspace: "/tmp/changed-cron-workspace", nextRunAt: tickAt(6) },
    createdAt: tickAt(5),
  });
  const corrupted = ctx.createScheduler({ executor: recoveredExecutor });
  await assert.rejects(
    () => corrupted.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  await corrupted.close();
  ctx.close();
});

test("retry executor 失败保留 durable queued，重启只对新 retry Run 走 recover", async () => {
  const initialExecutor = {
    schedule(payload) {
      return payload.run.retryOf === null
        ? undefined : Promise.reject(new Error("retry executor unavailable"));
    },
    recover() { throw new Error("unexpected recover"); },
  };
  const ctx = fixture({ executor: initialExecutor });
  const job = createEveryJob(ctx, {
    operationId: "create-retry-recovery", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler({ executor: initialExecutor });
  await scheduler.open();
  const prior = scheduler.triggerJob({
    operationId: "manual-retry-recovery", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.admit(prior.id, { onBusy: "queue" });
  ctx.dispatcher.transition(prior.id, "running");
  ctx.dispatcher.transition(prior.id, "failed", { errorCode: "PRIOR_FAILED" });
  const retry = scheduler.retryRun({
    operationId: "retry-recovery", jobId: job.id,
    retryOf: prior.id, createdAt: tickAt(5) + 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => scheduler.waitForIdle(retry.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  assert.equal(ctx.dispatcher.getRun(retry.id).status, "queued");
  await scheduler.close();

  const recoveredExecutor = {
    calls: [],
    schedule() { throw new Error("unexpected schedule"); },
    recover(payload) { this.calls.push(payload); },
  };
  const recovered = ctx.createScheduler({ executor: recoveredExecutor });
  await recovered.open();
  assert.deepEqual(recoveredExecutor.calls.map((call) => call.run.id), [retry.id]);
  assert.equal(recoveredExecutor.calls[0].run.retryOf, prior.id);
  await recovered.close();
  ctx.close();
});

test("重启拒绝 malformed manual/retry intent key 且不执行", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-malformed-manual-intent", createdAt: tickAt(5),
  });
  ctx.dispatcher.enqueue({
    id: uuidFactory(495)(),
    source: "cron",
    sourceId: job.id,
    idempotencyKey: "shoggoth:cron:v2:manual:not-a-valid-intent",
    profileId: job.profileId,
    workspace: job.workspace,
    retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("重启拒绝同一 operation hash 绑定多个 Cron intent Run", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-duplicate-operation-intent", createdAt: tickAt(5),
  });
  const nextUuid = uuidFactory(496);
  for (const createdAt of [tickAt(5), tickAt(5) + 1]) {
    ctx.dispatcher.enqueue({
      id: nextUuid(),
      source: "cron",
      sourceId: job.id,
      idempotencyKey: testCronIntentKey(
        "manual", "duplicate-operation-owner", job.id, null, createdAt,
      ),
      profileId: job.profileId,
      workspace: job.workspace,
      retryOf: null,
    });
  }
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("retry recovery 用 per-job order/id index 保持线性扫描", async () => {
  const jobs = [];
  const runs = [];
  const runById = new Map();
  let sourceIdReads = 0;
  const nextJobId = uuidFactory(10_000);
  const trackedRun = (input) => {
    const sourceId = input.sourceId;
    const run = { ...input };
    Object.defineProperty(run, "sourceId", {
      configurable: false,
      enumerable: true,
      get() { sourceIdReads += 1; return sourceId; },
    });
    runs.push(run);
    runById.set(run.id, run);
    return run;
  };
  for (let index = 0; index < 100; index += 1) {
    const jobId = nextJobId();
    const priorId = `prior-${index}`;
    const retryId = `retry-${index}`;
    const job = {
      id: jobId,
      enabled: false,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      prompt: "Indexed recovery prompt",
      workspace: null,
      overlapPolicy: "skip",
      threadPolicy: "new",
      threadId: null,
      updatedAt: 1,
    };
    jobs.push(job);
    trackedRun({
      id: priorId,
      source: "cron",
      sourceId: jobId,
      idempotencyKey: `${jobId}:60000`,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null,
      retryOf: null,
      status: "failed",
    });
    trackedRun({
      id: retryId,
      source: "cron",
      sourceId: jobId,
      idempotencyKey: testCronIntentKey(
        "retry", `indexed-retry-${index}`, jobId, priorId, tickAt(5), {
          workspace: null,
          prompt: job.prompt,
        },
      ),
      profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null,
      retryOf: priorId,
      status: "queued",
    });
  }
  const cronStore = {
    listJobs(query = {}) { return query.enabled === true ? [] : jobs; },
    getJob(jobId) { return jobs.find((job) => job.id === jobId) || null; },
    setJobNextRunAt() { throw new Error("unexpected schedule mutation"); },
    setJobEnabled() { throw new Error("unexpected schedule mutation"); },
  };
  const dispatcher = {
    enqueue() { throw new Error("unexpected enqueue"); },
    getRun(runId) { return runById.get(runId) || null; },
    listRuns() { return runs; },
    transition() { throw new Error("unexpected transition"); },
  };
  const timer = { set() { throw new Error("unexpected timer"); }, clear() {} };
  const scheduler = new NativeCronScheduler({
    cronStore,
    dispatcher,
    executor: { schedule() {}, recover() {} },
    now: () => tickAt(5),
    monotonicNow: () => 1,
    setTimer: timer.set,
    clearTimer: timer.clear,
  });
  await scheduler.open();
  assert.ok(sourceIdReads < 5_000, `sourceId reads must stay linear, got ${sourceIdReads}`);
  await scheduler.close();
});

test("重启对 terminal v2 intent 仍校验 base source binding", async () => {
  const ctx = fixture();
  const firstJob = createEveryJob(ctx, {
    operationId: "create-terminal-base-a", createdAt: tickAt(5),
  });
  const secondJob = createEveryJob(ctx, {
    operationId: "create-terminal-base-b", createdAt: tickAt(5), name: "Second base job",
  });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(497)(),
    source: "cron",
    sourceId: secondJob.id,
    idempotencyKey: testCronIntentKey(
      "manual", "terminal-base-binding", firstJob.id, null, tickAt(5),
    ),
    profileId: secondJob.profileId,
    workspace: secondJob.workspace,
    retryOf: null,
  });
  ctx.dispatcher.transition(run.id, "skipped", { resultSummary: "terminal corrupt fixture" });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("exact replay 拒绝 durable skip disposition 被伪造成 completed terminal", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-terminal-disposition-exact", createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const input = {
    operationId: "terminal-disposition-exact",
    jobId: job.id,
    createdAt: tickAt(5),
  };
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_253)(), source: "cron", sourceId: job.id,
    idempotencyKey: testCronIntentKey(
      "manual", input.operationId, job.id, null, input.createdAt,
      { disposition: "overlap-skipped" },
    ),
    profileId: job.profileId, workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.admit(run.id, { onBusy: "queue" });
  ctx.dispatcher.transition(run.id, "running");
  ctx.dispatcher.transition(run.id, "completed", { resultSummary: "wrong terminal" });
  assert.throws(
    () => scheduler.triggerJob(input),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("occurrence key 的 timestamp 必须是 canonical decimal", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-noncanonical-occurrence" });
  ctx.dispatcher.enqueue({
    id: uuidFactory(498)(),
    source: "cron",
    sourceId: job.id,
    idempotencyKey: `${job.id}:060000`,
    profileId: job.profileId,
    workspace: job.workspace,
    retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("terminal occurrence 也必须先验证 canonical base identity", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-terminal-noncanonical-occurrence", createdAt: tickAt(5),
  });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_255)(), source: "cron", sourceId: job.id,
    idempotencyKey: `${job.id}:0${tickAt(5)}`, profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.transition(run.id, "skipped", { resultSummary: "already terminal" });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  assert.equal(cronRuns(ctx, job.id).length, 1);
  await scheduler.close();
  ctx.close();
});

test("terminal versioned occurrence 拒绝 base job 改绑", async () => {
  const ctx = fixture();
  const firstJob = createEveryJob(ctx, {
    operationId: "create-terminal-occurrence-base-a", createdAt: tickAt(5),
  });
  const secondJob = createEveryJob(ctx, {
    operationId: "create-terminal-occurrence-base-b", createdAt: tickAt(5),
    name: "Second occurrence base job",
  });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_257)(), source: "cron", sourceId: secondJob.id,
    idempotencyKey: testOccurrenceIntentKey(firstJob, tickAt(6)),
    profileId: secondJob.profileId, workspace: secondJob.workspace, retryOf: null,
  });
  ctx.dispatcher.transition(run.id, "skipped", { resultSummary: "terminal base fixture" });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("terminal versioned occurrence 的 skip summary 必须与 durable disposition 精确一致", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-terminal-occurrence-disposition", createdAt: tickAt(5),
  });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_261)(), source: "cron", sourceId: job.id,
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(6), "misfire-skipped"),
    profileId: job.profileId, workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.transition(run.id, "skipped", {
    resultSummary: "CRON_OVERLAP_SKIPPED",
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("同一 numeric occurrence 的多个 versioned owner 一律 fail closed", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-duplicate-occurrence-owner", createdAt: tickAt(5),
  });
  const nextUuid = uuidFactory(1_258);
  for (const occurrenceJob of [job, { ...job, prompt: "different execution fingerprint" }]) {
    const run = ctx.dispatcher.enqueue({
      id: nextUuid(), source: "cron", sourceId: job.id,
      idempotencyKey: testOccurrenceIntentKey(occurrenceJob, tickAt(6)),
      profileId: job.profileId, workspace: job.workspace, retryOf: null,
    });
    ctx.dispatcher.transition(run.id, "skipped", { resultSummary: "duplicate owner fixture" });
  }
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("queued intent 冻结 prompt/thread policy，Job 变化后恢复 fail closed", async () => {
  const initialExecutor = {
    schedule() { return Promise.reject(new Error("offline")); },
    recover() { throw new Error("unexpected recover"); },
  };
  const ctx = fixture({ executor: initialExecutor });
  const job = createEveryJob(ctx, {
    operationId: "create-execution-fingerprint", createdAt: tickAt(5),
    prompt: "original frozen prompt",
  });
  const scheduler = ctx.createScheduler({ executor: initialExecutor });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "manual-execution-fingerprint", jobId: job.id, createdAt: tickAt(5),
  });
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  await scheduler.close();
  ctx.cronStore.updateJob({
    operationId: "change-execution-material",
    jobId: job.id,
    patch: {
      prompt: "changed prompt must never execute",
      threadPolicy: "continue",
      threadId: "thread-changed",
    },
    createdAt: tickAt(5),
  });
  const recoveredExecutor = {
    calls: [],
    schedule() { throw new Error("unexpected schedule"); },
    recover(payload) { this.calls.push(payload); },
  };
  const recovered = ctx.createScheduler({ executor: recoveredExecutor });
  await assert.rejects(
    () => recovered.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(recoveredExecutor.calls.length, 0);
  await recovered.close();
  ctx.close();
});

test("scheduled occurrence 冻结 prompt/thread/profile/workspace 后才允许恢复", async () => {
  const initialExecutor = {
    schedule() { return Promise.reject(new Error("offline")); },
    recover() { throw new Error("unexpected recover"); },
  };
  const ctx = fixture({ executor: initialExecutor });
  const job = createEveryJob(ctx, {
    operationId: "create-occurrence-execution-freeze",
    prompt: "original occurrence prompt",
  });
  const scheduler = ctx.createScheduler({ executor: initialExecutor });
  await scheduler.open();
  const [run] = cronRuns(ctx, job.id);
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error.code === "CRON_EXECUTOR_FAILED",
  );
  await scheduler.close();
  ctx.cronStore.updateJob({
    operationId: "change-occurrence-execution-material",
    jobId: job.id,
    patch: {
      prompt: "changed prompt must never execute",
      threadPolicy: "continue",
      threadId: "changed-occurrence-thread",
    },
    createdAt: tickAt(5),
  });
  const recoveredExecutor = {
    calls: [],
    schedule() { throw new Error("unexpected schedule"); },
    recover(payload) { this.calls.push(payload); },
  };
  const recovered = ctx.createScheduler({ executor: recoveredExecutor });
  await assert.rejects(
    () => recovered.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(recoveredExecutor.calls.length, 0);
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  await recovered.close();
  ctx.close();
});

test("legacy queued occurrence 缺少执行指纹时 fail closed 且绝不猜新 prompt", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-legacy-occurrence-no-contract", createdAt: tickAt(5),
  });
  ctx.dispatcher.enqueue({
    id: uuidFactory(1_256)(), source: "cron", sourceId: job.id,
    idempotencyKey: `${job.id}:${tickAt(6)}`, profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("occurrence 先持久 WorkRun，再推进 Job，最后交给 executor", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx);
  const order = [];
  let cronRunSnapshots = 0;
  const dispatcher = {
    enqueue(input) { order.push("workrun"); return ctx.dispatcher.enqueue(input); },
    getRun: (id) => ctx.dispatcher.getRun(id),
    listRuns(query) {
      if (query?.source === "cron") cronRunSnapshots += 1;
      return ctx.dispatcher.listRuns(query);
    },
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => {
        order.push("advance");
        return target.setJobNextRunAt(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const executor = {
    calls: [],
    schedule(payload) {
      order.push("executor");
      this.calls.push(payload);
    },
    recover() { throw new Error("unexpected recover"); },
  };
  const scheduler = ctx.createScheduler({ dispatcher, cronStore, executor });
  await scheduler.open();
  assert.deepEqual(order, ["workrun", "advance", "executor"]);
  const [run] = cronRuns(ctx, job.id);
  assert.equal(run.idempotencyKey, testOccurrenceIntentKey(job, tickAt(5)));
  assert.equal(run.source, "cron");
  assert.equal(run.sourceId, job.id);
  assert.equal(Object.prototype.hasOwnProperty.call(run, "prompt"), false);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  assert.equal(executor.calls[0].prompt, job.prompt);
  assert.equal(executor.calls[0].scheduledAt, tickAt(5));
  assert.equal(cronRunSnapshots, 1);
  await scheduler.close();
  ctx.close();
});

test("occurrence enqueue 后只用冻结 execution material，不信任 advance 回显", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-frozen-after-advance",
    prompt: "frozen before durable enqueue",
  });
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => ({
        ...target.setJobNextRunAt(input),
        prompt: "tampered advance response",
        threadPolicy: "continue",
        threadId: "tampered-thread",
      });
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scheduler = ctx.createScheduler({ cronStore });
  await scheduler.open();
  assert.equal(ctx.executor.calls.length, 1);
  assert.equal(ctx.executor.calls[0].prompt, job.prompt);
  assert.equal(ctx.executor.calls[0].job.prompt, job.prompt);
  assert.equal(ctx.executor.calls[0].threadPolicy, job.threadPolicy);
  assert.equal(ctx.executor.calls[0].threadId, job.threadId);
  await scheduler.close();
  ctx.close();
});

test("continue without explicit threadId uses the durable job-scoped context", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-automatic-job-context",
    threadPolicy: "continue",
    threadId: null,
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.equal(ctx.executor.calls.length, 1);
  assert.equal(ctx.executor.calls[0].job.id, job.id);
  assert.equal(ctx.executor.calls[0].threadPolicy, "continue");
  assert.equal(ctx.executor.calls[0].threadId, null);
  await scheduler.close();
  ctx.close();
});

test("misfire skip decision 在 enqueue 前持久且 transition 失败后重启只收敛 skipped", async () => {
  for (const mode of ["known", "uncertain-uncommitted", "uncertain-committed"]) {
    const uncertain = mode !== "known";
    const ctx = fixture();
    const job = createEveryJob(ctx, {
      operationId: `create-durable-misfire-${mode}`,
      misfirePolicy: "skip",
    });
    const transitionError = Object.assign(new Error("transition failed after enqueue"), {
      code: uncertain ? "STORE_COMMIT_UNCERTAIN" : "STORE_WRITE_FAILED",
      committedUncertain: uncertain,
    });
    let failTransition = true;
    const dispatcher = {
      enqueue: (...args) => ctx.dispatcher.enqueue(...args),
      getRun: (...args) => ctx.dispatcher.getRun(...args),
      listRuns: (...args) => ctx.dispatcher.listRuns(...args),
      transition(...args) {
        if (failTransition && args[1] === "skipped") {
          if (mode === "uncertain-committed") ctx.dispatcher.transition(...args);
          throw transitionError;
        }
        return ctx.dispatcher.transition(...args);
      },
    };
    const first = ctx.createScheduler({ dispatcher });
    await assert.rejects(() => first.open(), (error) => uncertain
      ? error.code === "CRON_COMMIT_UNCERTAIN"
        && error.message === "Cron 持久化状态不确定，必须重启 Service"
      : error === transitionError);
    const [queued] = cronRuns(ctx, job.id);
    assert.equal(queued.status, mode === "uncertain-committed" ? "skipped" : "queued");
    assert.match(queued.idempotencyKey, /:misfire-skipped:300000$/u);
    assert.equal(ctx.executor.calls.length, 0);
    await first.close();

    failTransition = false;
    const recovered = ctx.createScheduler();
    await recovered.open();
    assert.equal(ctx.dispatcher.getRun(queued.id).status, "skipped");
    assert.equal(ctx.dispatcher.getRun(queued.id).resultSummary, "CRON_MISFIRE_SKIPPED");
    assert.equal(ctx.executor.calls.length, 0);
    assert.equal(cronRuns(ctx, job.id).length, 1);
    await recovered.close();
    ctx.close();
  }
});

test("overlap queue-full decision 的 crash cut 不会在重启后误执行 skipped Run", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-durable-overlap-queue-full",
    createdAt: tickAt(3), overlapPolicy: "queue",
  });
  const backlog = ctx.dispatcher.enqueue({
    id: uuidFactory(1_259)(), source: "cron", sourceId: job.id,
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(4)),
    profileId: job.profileId, workspace: job.workspace, retryOf: null,
  });
  const transitionError = Object.assign(new Error("known transition failure"), {
    code: "STORE_WRITE_FAILED",
  });
  let failTransition = true;
  const dispatcher = {
    enqueue: (...args) => ctx.dispatcher.enqueue(...args),
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    transition(...args) {
      if (failTransition && args[0] !== backlog.id && args[1] === "skipped") {
        throw transitionError;
      }
      return ctx.dispatcher.transition(...args);
    },
  };
  const first = ctx.createScheduler({ dispatcher });
  await assert.rejects(() => first.open(), (error) => error === transitionError);
  const skippedIntent = cronRuns(ctx, job.id).find((run) => run.id !== backlog.id);
  assert.equal(skippedIntent.status, "queued");
  assert.match(skippedIntent.idempotencyKey, /:overlap-queue-full:300000$/u);
  assert.equal(ctx.executor.calls.length, 0);
  await first.close();

  failTransition = false;
  const recovered = ctx.createScheduler();
  await recovered.open();
  assert.equal(ctx.dispatcher.getRun(skippedIntent.id).status, "skipped");
  assert.deepEqual(ctx.executor.calls.map((call) => call.run.id), [backlog.id]);
  await recovered.close();
  ctx.close();
});

test("Cron WorkRun snapshot 超过硬上限时 fail closed 且不推进或执行", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-run-scan-cap" });
  const terminal = { status: "completed", sourceId: "historical-cron-job" };
  const oversized = Array.from({ length: 65_537 }, () => terminal);
  const dispatcher = {
    enqueue: (...args) => ctx.dispatcher.enqueue(...args),
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns(query) {
      return query?.source === "cron" ? oversized : ctx.dispatcher.listRuns(query);
    },
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const scheduler = ctx.createScheduler({ dispatcher });
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CAPACITY",
  );
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, job.nextRunAt);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("manual trigger 在 Cron Run scan 恰好满容量时仅允许 exact replay", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-manual-run-scan-cap", createdAt: tickAt(5),
    nextRunAt: tickAt(6),
  });
  let atCapacity = false;
  let enqueueCalls = 0;
  const terminal = { status: "completed", sourceId: "historical-cron-job" };
  const dispatcher = {
    enqueue(...args) { enqueueCalls += 1; return ctx.dispatcher.enqueue(...args); },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns(query) {
      if (atCapacity && query?.source === "cron") {
        return [
          ...Array.from({ length: MAX_CRON_RUN_SCAN - 1 }, () => terminal),
          ...ctx.dispatcher.listRuns(query),
        ];
      }
      return ctx.dispatcher.listRuns(query);
    },
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const scheduler = ctx.createScheduler({ dispatcher });
  await scheduler.open();
  const replayInput = {
    operationId: "manual-at-cap-replay", jobId: job.id, createdAt: tickAt(5),
  };
  const existing = scheduler.triggerJob(replayInput);
  atCapacity = true;
  assert.equal(scheduler.triggerJob(replayInput).id, existing.id);
  assert.throws(
    () => scheduler.triggerJob({
      operationId: "manual-at-cap-new", jobId: job.id, createdAt: tickAt(5),
    }),
    (error) => error.code === "CRON_RUN_CAPACITY",
  );
  assert.equal(enqueueCalls, 1);
  await scheduler.close();
  ctx.close();
});

test("tick 多 occurrence 在容量边界只允许真正新增到硬上限", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-tick-run-cap",
    createdAt: tickAt(5),
    nextRunAt: tickAt(6),
    misfirePolicy: "all-bounded",
    maxCatchUp: 3,
    overlapPolicy: "queue",
  });
  const historicalJobId = "00000000-0000-4000-8000-999999999999";
  const executionHash = "0".repeat(64);
  const history = Array.from({ length: MAX_CRON_RUN_SCAN - 1 }, (_, index) => {
    const scheduledAt = index + 1;
    const baseHash = crypto.createHash("sha256")
      .update(JSON.stringify(["occurrence", historicalJobId, scheduledAt]))
      .digest("hex");
    return {
      id: `historical-${index}`,
      source: "cron",
      sourceId: historicalJobId,
      idempotencyKey: `shoggoth:cron:v2:occurrence:${baseHash}:${executionHash}:run:${scheduledAt}`,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null,
      retryOf: null,
      status: "completed",
      resultSummary: null,
    };
  });
  let includeHistory = false;
  let enqueueCalls = 0;
  const dispatcher = {
    enqueue(...args) { enqueueCalls += 1; return ctx.dispatcher.enqueue(...args); },
    getRun: (...args) => ctx.dispatcher.getRun(...args),
    listRuns(query) {
      const current = ctx.dispatcher.listRuns(query);
      return includeHistory && query?.source === "cron" ? [...history, ...current] : current;
    },
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    dispatcher, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  includeHistory = true;
  ctx.clock.value = tickAt(8);
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error.code === "CRON_RUN_CAPACITY",
  );
  assert.equal(enqueueCalls, 1);
  assert.equal(cronRuns(ctx, job.id).length, 1);
  assert.equal(ctx.executor.calls.length, 0);
  assert.equal(scheduler.state, "open");
  assert.equal(fatalSignals.length, 0);
  assert.equal([...ctx.timer.entries.values()][0].delay, TIMER_RETRY_DELAY_MS);
  await scheduler.close();
  ctx.close();
});

test("enqueue 同 key replay 必须精确绑定 Cron occurrence 才能推进 Job", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx);
  ctx.dispatcher.enqueue({
    id: uuidFactory(700)(),
    source: "chat",
    sourceId: "session-a",
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(5)),
    profileId: job.profileId,
    workspace: job.workspace,
    retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, job.nextRunAt);
  assert.equal(cronRuns(ctx, job.id).length, 0);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("recovery 拒绝不属于 Job 时序与执行上下文的 WorkRun", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-malicious-binding" });
  ctx.cronStore.setJobNextRunAt({
    operationId: "advance-before-malicious-binding",
    jobId: job.id,
    nextRunAt: tickAt(6),
    createdAt: tickAt(5),
  });
  const prior = ctx.dispatcher.enqueue({
    id: uuidFactory(720)(), source: "chat", sourceId: "prior-chat",
    idempotencyKey: "shoggoth:chat-send:prior", profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.enqueue({
    id: uuidFactory(730)(),
    source: "cron",
    sourceId: job.id,
    idempotencyKey: `${job.id}:123`,
    profileId: job.profileId,
    workspace: "/tmp/evil-cron-workspace",
    retryOf: prior.id,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("recovery 拒绝 Job 创建前仅数学上匹配的 occurrence", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-prehistory-binding" });
  ctx.dispatcher.enqueue({
    id: uuidFactory(740)(),
    source: "cron",
    sourceId: job.id,
    idempotencyKey: `${job.id}:0`,
    profileId: job.profileId,
    workspace: job.workspace,
    retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, job.nextRunAt);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("latest/all-bounded/skip 恢复策略只选择有界 occurrence", async () => {
  const policies = [
    { policy: "latest", maxCatchUp: 1, expected: [tickAt(5)], statuses: ["queued"] },
    {
      policy: "all-bounded", maxCatchUp: 2, overlapPolicy: "queue",
      expected: [tickAt(4), tickAt(5)], statuses: ["queued", "queued"],
    },
    { policy: "skip", maxCatchUp: 1, expected: [tickAt(5)], statuses: ["skipped"] },
  ];
  for (const entry of policies) {
    const ctx = fixture();
    const job = createEveryJob(ctx, {
      operationId: `create-${entry.policy}`,
      misfirePolicy: entry.policy,
      maxCatchUp: entry.maxCatchUp,
      overlapPolicy: entry.overlapPolicy,
    });
    const scheduler = ctx.createScheduler();
    await scheduler.open();
    const runs = cronRuns(ctx, job.id).sort((a, b) => (
      Number(a.idempotencyKey.split(":").at(-1))
      - Number(b.idempotencyKey.split(":").at(-1))
    ));
    assert.deepEqual(runs.map((run) => Number(run.idempotencyKey.split(":").at(-1))), entry.expected);
    assert.deepEqual(runs.map((run) => run.status), entry.statuses);
    assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
    await scheduler.close();
    ctx.close();
  }
});

test("cron timezone/DST 由固定 parser 反向选择最近 bounded occurrences", () => {
  const first = Date.UTC(2026, 2, 7, 7, 30, 0);
  const springGap = Date.UTC(2026, 2, 8, 7, 30, 0);
  const afterDst = Date.UTC(2026, 2, 9, 6, 30, 0);
  const due = dueOccurrences({
    enabled: true,
    nextRunAt: first,
    schedule: { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" },
    misfirePolicy: "all-bounded",
    maxCatchUp: 2,
  }, afterDst, true);
  assert.deepEqual(due, { occurrences: [springGap, afterDst], skip: false });
});

test("cron all-bounded 返回真实最近 maxCatchUp 次而不是固定两次", () => {
  const first = Date.UTC(2026, 0, 1, 0, 0, 0);
  const wallNow = Date.UTC(2026, 0, 10, 12, 0, 0);
  const due = dueOccurrences({
    enabled: true,
    nextRunAt: first,
    schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
    misfirePolicy: "all-bounded",
    maxCatchUp: 5,
  }, wallNow, true);
  assert.deepEqual(due.occurrences, [6, 7, 8, 9, 10].map(
    (day) => Date.UTC(2026, 0, day, 0, 0, 0),
  ));
});

test("cron all-bounded maxCatchUp=100 跨春秋 DST 与慢时区仍返回正确窗口", () => {
  const cases = [
    {
      schedule: { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" },
      first: Date.UTC(2026, 0, 1, 7, 30, 0),
      wallNow: Date.UTC(2026, 5, 15, 12, 0, 0),
    },
    {
      schedule: { kind: "cron", expr: "30 1 * * *", tz: "America/New_York" },
      first: Date.UTC(2026, 7, 1, 5, 30, 0),
      wallNow: Date.UTC(2026, 11, 15, 12, 0, 0),
    },
    {
      schedule: { kind: "cron", expr: "0 0 * * *", tz: "Pacific/Apia" },
      first: Date.UTC(2026, 0, 1, 11, 0, 0),
      wallNow: Date.UTC(2026, 5, 15, 12, 0, 0),
    },
  ];
  for (const entry of cases) {
    const expected = forwardCronTruth(entry.schedule, entry.first, entry.wallNow).slice(-100);
    let artificialWallTime = 0;
    const due = dueOccurrences({
      enabled: true,
      nextRunAt: entry.first,
      schedule: entry.schedule,
      misfirePolicy: "all-bounded",
      maxCatchUp: 100,
    }, entry.wallNow, true, {
      monotonicNow: () => { artificialWallTime += 1_000; return artificialWallTime; },
    });
    assert.equal(due.occurrences.length, 100);
    assert.deepEqual(due.occurrences, expected);
  }
});

test("cron bounded scan 耗尽确定性 parser step 上限时 fail closed", () => {
  assert.throws(
    () => dueOccurrences({
      enabled: true,
      nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" },
      misfirePolicy: "all-bounded",
      maxCatchUp: 5,
    }, Date.UTC(2026, 0, 10, 12, 0, 0), true, {
      maxScanSteps: 1,
    }),
    (error) => error.code === "CRON_SCHEDULE_UNBOUNDED",
  );
});

test("overlap skip 与 queue 最多保留一个等待 occurrence", async () => {
  const ctx = fixture();
  const skipJob = createEveryJob(ctx, {
    operationId: "create-overlap-skip", overlapPolicy: "skip", createdAt: tickAt(3),
  });
  const active = ctx.dispatcher.enqueue({
    id: uuidFactory(800)(), source: "cron", sourceId: skipJob.id,
    idempotencyKey: testOccurrenceIntentKey(skipJob, tickAt(4)), profileId: skipJob.profileId,
    workspace: skipJob.workspace, retryOf: null,
  });
  ctx.dispatcher.admit(active.id, { onBusy: "queue" });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.equal(cronRuns(ctx, skipJob.id).find(
    (run) => run.idempotencyKey.endsWith(`:${tickAt(5)}`),
  ).status, "skipped");
  await scheduler.close();
  ctx.close();

  const queuedCtx = fixture();
  const queueJob = createEveryJob(queuedCtx, {
    operationId: "create-overlap-queue", overlapPolicy: "queue", createdAt: tickAt(3),
  });
  const activeQueue = queuedCtx.dispatcher.enqueue({
    id: uuidFactory(900)(), source: "cron", sourceId: queueJob.id,
    idempotencyKey: testOccurrenceIntentKey(queueJob, tickAt(4)), profileId: queueJob.profileId,
    workspace: queueJob.workspace, retryOf: null,
  });
  queuedCtx.dispatcher.admit(activeQueue.id, { onBusy: "queue" });
  const queueScheduler = queuedCtx.createScheduler();
  await queueScheduler.open();
  assert.equal(cronRuns(queuedCtx, queueJob.id).filter((run) => run.status === "queued").length, 1);
  queuedCtx.clock.value = tickAt(6);
  await queueScheduler.tick();
  const latest = cronRuns(queuedCtx, queueJob.id).find(
    (run) => run.idempotencyKey.endsWith(`:${tickAt(6)}`),
  );
  assert.equal(latest.status, "skipped");
  assert.equal(latest.resultSummary, "CRON_OVERLAP_QUEUE_FULL");
  await queueScheduler.close();
  queuedCtx.close();
});

test("queue 模式没有 active 但已有 queued 时仍拒绝第二个积压", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-queued-only", overlapPolicy: "queue", createdAt: tickAt(3),
  });
  ctx.dispatcher.enqueue({
    id: uuidFactory(950)(), source: "cron", sourceId: job.id,
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(4)), profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const latest = cronRuns(ctx, job.id).find(
    (run) => run.idempotencyKey.endsWith(`:${tickAt(5)}`),
  );
  assert.equal(latest.status, "skipped");
  assert.equal(latest.resultSummary, "CRON_OVERLAP_QUEUE_FULL");
  assert.equal(cronRuns(ctx, job.id).filter((run) => run.status === "queued").length, 1);
  await scheduler.close();
  ctx.close();
});

test("all-bounded 同批 overlap skip 只启动第一个 occurrence", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-batch-skip",
    misfirePolicy: "all-bounded",
    maxCatchUp: 3,
    overlapPolicy: "skip",
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  const runs = cronRuns(ctx, job.id)
    .sort((left, right) => Number(left.idempotencyKey.split(":").at(-1))
      - Number(right.idempotencyKey.split(":").at(-1)));
  assert.deepEqual(runs.map((run) => run.status), ["queued", "skipped", "skipped"]);
  assert.equal(ctx.executor.calls.filter((call) => call.kind === "schedule").length, 1);
  await scheduler.close();
  ctx.close();
});

test("all-bounded 同批 overlap queue 最多一个执行中与一个等待", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-batch-queue",
    misfirePolicy: "all-bounded",
    maxCatchUp: 3,
    overlapPolicy: "queue",
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const runs = cronRuns(ctx, job.id)
    .sort((left, right) => Number(left.idempotencyKey.split(":").at(-1))
      - Number(right.idempotencyKey.split(":").at(-1)));
  assert.deepEqual(runs.map((run) => run.status), ["queued", "queued", "skipped"]);
  assert.deepEqual(ctx.executor.calls.map((call) => call.kind), ["schedule", "recover"]);
  await scheduler.close();
  ctx.close();
});

test("同 Job 两个 durable run 由 Scheduler 单槽执行并在 settle 后有界 handoff", async () => {
  const deferred = [];
  const executor = {
    calls: [],
    schedule(payload) {
      this.calls.push({ kind: "schedule", ...payload });
      return new Promise((resolve) => deferred.push(resolve));
    },
    recover(payload) {
      this.calls.push({ kind: "recover", ...payload });
      return new Promise((resolve) => deferred.push(resolve));
    },
  };
  const ctx = fixture({ executor });
  createEveryJob(ctx, {
    operationId: "create-per-job-single-slot",
    misfirePolicy: "all-bounded", maxCatchUp: 2, overlapPolicy: "queue",
  });
  const scheduler = ctx.createScheduler({ executor });
  await scheduler.open();
  assert.equal(executor.calls.length, 1);
  const firstRunId = executor.calls[0].run.id;
  deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.length, 2);
  assert.notEqual(executor.calls[1].run.id, firstRunId);
  deferred[1]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.length, 2);
  assert.equal(scheduler.inflight.size, 0);
  await scheduler.close();
  ctx.close();
});

test("WorkRun 提前变 terminal 也不能在旧 executor settle 前释放 Job 单槽", async () => {
  const deferred = [];
  const executor = {
    calls: [],
    schedule(payload) {
      this.calls.push({ kind: "schedule", ...payload });
      return new Promise((resolve) => deferred.push(resolve));
    },
    recover(payload) {
      this.calls.push({ kind: "recover", ...payload });
      return new Promise((resolve) => deferred.push(resolve));
    },
  };
  const ctx = fixture({ executor });
  const job = createEveryJob(ctx, {
    operationId: "create-terminal-owner-single-slot",
    createdAt: tickAt(5), nextRunAt: tickAt(6), overlapPolicy: "queue",
  });
  const scheduler = ctx.createScheduler({ executor });
  await scheduler.open();
  const first = scheduler.triggerJob({
    operationId: "terminal-owner-first", jobId: job.id, createdAt: tickAt(5),
  });
  ctx.dispatcher.transition(first.id, "skipped", { resultSummary: "EXTERNAL_TERMINAL" });
  const second = scheduler.triggerJob({
    operationId: "terminal-owner-second", jobId: job.id, createdAt: tickAt(5) + 1,
  });
  assert.equal(executor.calls.length, 1);
  assert.equal(scheduler.inflight.size, 1);
  assert.equal(scheduler.activeByJob.get(job.id), first.id);
  deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.length, 2);
  assert.equal(executor.calls[1].run.id, second.id);
  deferred[1]();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.close();
  ctx.close();
});

test("恢复只按 durable run disposition，不让迟到 overlapPolicy 改写旧决策", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-durable-run-overlap-drift", overlapPolicy: "queue",
  });
  ctx.cronStore.setJobNextRunAt({
    operationId: "advance-durable-run-overlap-drift",
    jobId: job.id,
    nextRunAt: tickAt(6),
    createdAt: tickAt(5),
  });
  const nextUuid = uuidFactory(1_260);
  for (const scheduledAt of [tickAt(4), tickAt(5)]) {
    ctx.dispatcher.enqueue({
      id: nextUuid(), source: "cron", sourceId: job.id,
      idempotencyKey: testOccurrenceIntentKey(job, scheduledAt),
      profileId: job.profileId, workspace: job.workspace, retryOf: null,
    });
  }
  ctx.cronStore.updateJob({
    operationId: "change-overlap-after-durable-run",
    jobId: job.id,
    patch: { overlapPolicy: "skip" },
    createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.executor.calls.filter((call) => call.kind === "recover").length, 2);
  assert.deepEqual(cronRuns(ctx, job.id).map((run) => run.status), ["queued", "queued"]);
  await scheduler.close();
  ctx.close();
});

test("重启恢复 versioned 多 queued Run 时仍强制 overlap 上限", async () => {
  for (const scenario of [
    {
      overlapPolicy: "skip",
      expectedStatuses: ["queued", "queued", "skipped"],
      expectedRecoveries: 2,
      skippedSummary: "CRON_OVERLAP_QUEUE_FULL",
    },
    {
      overlapPolicy: "queue",
      expectedStatuses: ["queued", "queued", "skipped"],
      expectedRecoveries: 2,
      skippedSummary: "CRON_OVERLAP_QUEUE_FULL",
    },
  ]) {
    const ctx = fixture();
    const job = createEveryJob(ctx, {
      operationId: `create-legacy-${scenario.overlapPolicy}`,
      overlapPolicy: scenario.overlapPolicy,
    });
    ctx.cronStore.setJobNextRunAt({
      operationId: `advance-legacy-${scenario.overlapPolicy}`,
      jobId: job.id,
      nextRunAt: tickAt(6),
      createdAt: ctx.clock.value,
    });
    const nextUuid = uuidFactory(scenario.overlapPolicy === "skip" ? 1_000 : 1_100);
    for (const scheduledAt of [tickAt(3), tickAt(4), tickAt(5)]) {
      ctx.dispatcher.enqueue({
        id: nextUuid(),
        source: "cron",
        sourceId: job.id,
        idempotencyKey: testOccurrenceIntentKey(job, scheduledAt),
        profileId: job.profileId,
        workspace: job.workspace,
        retryOf: null,
      });
    }
    const scheduler = ctx.createScheduler();
    await scheduler.open();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const runs = cronRuns(ctx, job.id)
      .sort((left, right) => Number(left.idempotencyKey.split(":").at(-1))
        - Number(right.idempotencyKey.split(":").at(-1)));
    assert.deepEqual(runs.map((run) => run.status), scenario.expectedStatuses);
    assert.equal(ctx.executor.calls.filter((call) => call.kind === "recover").length,
      scenario.expectedRecoveries);
    assert.equal(runs.at(-1).resultSummary, scenario.skippedSummary);
    await scheduler.close();
    ctx.close();
  }
});

test("inflight 达到硬上限时保留 durable queued 且不调用 executor", async () => {
  const deferred = [];
  const executor = {
    calls: [],
    schedule(payload) {
      this.calls.push(payload);
      return new Promise((resolve) => { deferred.push({ runId: payload.run.id, resolve }); });
    },
    recover(payload) {
      this.calls.push(payload);
      return new Promise((resolve) => { deferred.push({ runId: payload.run.id, resolve }); });
    },
  };
  const ctx = fixture({ executor });
  for (let index = 0; index < 257; index += 1) {
    createEveryJob(ctx, {
      operationId: `create-inflight-cap-${index}`,
      name: `Inflight cap ${index}`,
    });
  }
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.equal(executor.calls.length, 256);
  assert.equal(scheduler.inflight.size, 256);
  assert.equal(ctx.dispatcher.listRuns({ source: "cron", status: "queued" }).length, 257);
  ctx.dispatcher.transition(deferred[0].runId, "skipped", { resultSummary: "test settled" });
  deferred[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.length, 257);
  assert.equal(scheduler.inflight.size, 256);
  await scheduler.close();
  ctx.close();
});

test("崩溃于 WorkRun 后、推进 Job 前时，open 对账且不重复 occurrence", async () => {
  const ctx = fixture({ clock: { value: tickAt(1.5), monotonic: 2_000 } });
  const job = createEveryJob(ctx);
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_000)(), source: "cron", sourceId: job.id,
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(1)), profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  const order = [];
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => {
        order.push("advance");
        return target.setJobNextRunAt(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const executor = {
    schedule() { throw new Error("unexpected schedule"); },
    recover(payload) {
      order.push("recover");
      ctx.executor.calls.push({ kind: "recover", ...payload });
    },
  };
  const scheduler = ctx.createScheduler({ cronStore, executor });
  await scheduler.open();
  assert.deepEqual(order, ["advance", "recover"]);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(2));
  assert.equal(cronRuns(ctx, job.id).filter(
    (item) => item.idempotencyKey.endsWith(`:${tickAt(1)}`),
  ).length, 1);
  assert.deepEqual(ctx.executor.calls.map((call) => [call.kind, call.run.id]), [["recover", run.id]]);
  await scheduler.close();
  ctx.close();
});

test("terminal occurrence 已完成但 Job 未推进时只对账 nextRunAt，绝不重启副作用", async () => {
  const ctx = fixture({ clock: { value: tickAt(1.5), monotonic: 2_000 } });
  const job = createEveryJob(ctx, { operationId: "create-terminal-cut" });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_050)(), source: "cron", sourceId: job.id,
    idempotencyKey: `${job.id}:${tickAt(1)}`, profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.admit(run.id, { onBusy: "queue" });
  ctx.dispatcher.transition(run.id, "running", {
    ...runtimePatch("thread-terminal", "turn-terminal"),
  });
  ctx.dispatcher.transition(run.id, "completed", { resultSummary: "done" });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(2));
  assert.equal(cronRuns(ctx, job.id).length, 1);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("已删除 Job 的 queued Cron Run 收敛为 canceled 而不 poison 全局", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-deleted-queued" });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_060)(), source: "cron", sourceId: job.id,
    idempotencyKey: `${job.id}:${tickAt(1)}`, profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.cronStore.deleteJob({
    operationId: "delete-with-queued-run", jobId: job.id, createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.deepEqual(ctx.dispatcher.getRun(run.id), {
    ...ctx.dispatcher.getRun(run.id),
    status: "canceled",
    resultSummary: "CRON_JOB_DELETED",
  });
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("已删除 Job 的损坏 occurrence key 不能借 orphan 收敛绕过 base 验证", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-deleted-malformed" });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_065)(), source: "cron", sourceId: job.id,
    idempotencyKey: "malformed-deleted-occurrence", profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.cronStore.deleteJob({
    operationId: "delete-with-malformed-run", jobId: job.id, createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await assert.rejects(
    () => scheduler.open(),
    (error) => error.code === "CRON_RUN_CORRUPT",
  );
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("已删除 Job 的 active Cron Run 收敛为 interrupted 而不调用 executor", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, { operationId: "create-deleted-active" });
  const run = ctx.dispatcher.enqueue({
    id: uuidFactory(1_070)(), source: "cron", sourceId: job.id,
    idempotencyKey: `${job.id}:${tickAt(1)}`, profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  ctx.dispatcher.admit(run.id, { onBusy: "queue" });
  ctx.cronStore.deleteJob({
    operationId: "delete-with-active-run", jobId: job.id, createdAt: tickAt(5),
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.deepEqual(ctx.dispatcher.getRun(run.id), {
    ...ctx.dispatcher.getRun(run.id),
    status: "interrupted",
    errorCode: "CRON_JOB_DELETED",
  });
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("versioned occurrence 已持久但长期离线时恢复旧 Run 并补最近窗口", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-crash-catchup",
    misfirePolicy: "all-bounded",
    maxCatchUp: 2,
  });
  const old = ctx.dispatcher.enqueue({
    id: uuidFactory(1_100)(), source: "cron", sourceId: job.id,
    idempotencyKey: testOccurrenceIntentKey(job, tickAt(1)), profileId: job.profileId,
    workspace: job.workspace, retryOf: null,
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.deepEqual(
    cronRuns(ctx, job.id)
      .map((run) => Number(run.idempotencyKey.split(":").at(-1)))
      .sort((left, right) => left - right),
    [tickAt(1), tickAt(4), tickAt(5)],
  );
  assert.deepEqual(
    cronRuns(ctx, job.id).map((run) => [
      Number(run.idempotencyKey.split(":").at(-1)), run.status,
    ]).sort((left, right) => left[0] - right[0]),
    [[tickAt(1), "queued"], [tickAt(4), "skipped"], [tickAt(5), "skipped"]],
  );
  assert.deepEqual(ctx.executor.calls.map((call) => [call.kind, call.run.id]), [["recover", old.id]]);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  await scheduler.close();
  ctx.close();
});

test("one-shot at 触发后原子停用，时钟回拨与重复 tick 不复活", async () => {
  const ctx = fixture({ clock: { value: 5_000, monotonic: 10_000 } });
  const job = ctx.cronStore.createJob({
    operationId: "create-at",
    name: "One shot",
    enabled: true,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: "Run once",
    workspace: null,
    schedule: { kind: "at", at: 5_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: 5_000,
    createdAt: 1,
  });
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.deepEqual(ctx.cronStore.getJob(job.id), { ...ctx.cronStore.getJob(job.id), enabled: false, nextRunAt: null });
  ctx.clock.value = 4_000;
  ctx.clock.monotonic = 11_000;
  await scheduler.tick();
  ctx.clock.value = 6_000;
  ctx.clock.monotonic = 12_000;
  await scheduler.tick();
  assert.equal(cronRuns(ctx, job.id).length, 1);
  await scheduler.close();
  ctx.close();
});

test("周期 Job 的 wall clock 回拨只重排 timer，不倒退 nextRunAt 或重复派发", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx);
  const scheduler = ctx.createScheduler();
  await scheduler.open();
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  assert.equal([...ctx.timer.entries.values()][0].delay, EVERY_INTERVAL_MS);
  ctx.clock.value = tickAt(4);
  ctx.clock.monotonic = 11_000;
  await scheduler.tick();
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  assert.equal(cronRuns(ctx, job.id).length, 1);
  assert.equal([...ctx.timer.entries.values()][0].delay, tickAt(2));
  ctx.clock.value = tickAt(6);
  ctx.clock.monotonic = 13_000;
  await scheduler.tick();
  assert.equal(cronRuns(ctx, job.id).filter(
    (run) => run.idempotencyKey.endsWith(`:${tickAt(6)}`),
  ).length, 1);
  await scheduler.close();
  ctx.close();
});

test("tick singleflight、close fence 与 executor failure 保留 durable queue 供重启恢复", async () => {
  const ctx = fixture();
  let scheduleCalls = 0;
  const executor = {
    schedule() { scheduleCalls += 1; return Promise.reject(Object.assign(new Error("offline"), { code: "EXECUTOR_UNAVAILABLE" })); },
    recover(payload) { ctx.executor.calls.push({ kind: "recover", ...payload }); },
  };
  const job = createEveryJob(ctx);
  const scheduler = ctx.createScheduler({ executor });
  await Promise.all([scheduler.open(), scheduler.open()]);
  await assert.rejects(
    () => scheduler.waitForIdle(cronRuns(ctx, job.id)[0].id),
    (error) => error.code === "CRON_EXECUTOR_FAILED"
      && error.message === "Cron executor 执行失败",
  );
  assert.equal(scheduleCalls, 1);
  assert.equal(cronRuns(ctx, job.id)[0].status, "queued");
  await scheduler.close();

  const recovered = ctx.createScheduler();
  await recovered.open();
  assert.equal(ctx.executor.calls.filter((call) => call.kind === "recover").length, 1);
  await recovered.close();
  await assert.rejects(() => recovered.tick(), (error) => error.code === "CRON_SCHEDULER_CLOSED");
  ctx.close();
});

test("executor raw Error 在 inflight/settled 边界固定脱敏且不保留 cause/canary", async () => {
  const ctx = fixture();
  const canary = "cron-executor-raw-secret-canary";
  const raw = Object.assign(new Error(canary), {
    code: "RAW_EXECUTOR_FAILURE",
    cause: new Error(`cause-${canary}`),
    detail: canary,
  });
  const executor = {
    schedule() { return Promise.reject(raw); },
    recover() { return Promise.reject(raw); },
  };
  const fatalSignals = [];
  const job = createEveryJob(ctx, { operationId: "create-sanitized-executor" });
  const scheduler = ctx.createScheduler({
    executor, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  const [run] = cronRuns(ctx, job.id);
  let observed = null;
  try { await scheduler.waitForIdle(run.id); } catch (error) { observed = error; }
  assert.equal(observed?.code, "CRON_EXECUTOR_FAILED");
  assert.equal(observed?.message, "Cron executor 执行失败");
  assert.equal(Object.prototype.hasOwnProperty.call(observed, "cause"), false);
  assert.equal(
    JSON.stringify(observed, Object.getOwnPropertyNames(observed)).includes(canary),
    false,
  );
  const retained = scheduler.settled.get(run.id)?.error;
  assert.equal(retained?.code, "CRON_EXECUTOR_FAILED");
  assert.notStrictEqual(retained, raw);
  assert.equal(
    JSON.stringify(retained, Object.getOwnPropertyNames(retained)).includes(canary),
    false,
  );
  assert.equal(fatalSignals.length, 0);
  assert.equal(scheduler.state, "open");
  await scheduler.close();
  ctx.close();
});

test("background executor durable uncertainty sticky poison 并由新实例恢复 queued Run", async () => {
  const secret = "executor-durable-secret-must-not-survive";
  const uncertain = Object.assign(new Error(secret), {
    code: "STORE_COMMIT_UNCERTAIN",
    committedUncertain: true,
    cause: new Error(secret),
  });
  const fatalSignals = [];
  const executor = {
    schedule() { return Promise.reject(uncertain); },
    recover() { throw new Error("unexpected recover in poisoned instance"); },
  };
  const ctx = fixture({ executor });
  const job = createEveryJob(ctx, {
    operationId: "create-executor-durable-fatal",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const scheduler = ctx.createScheduler({
    executor,
    onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  const run = scheduler.triggerJob({
    operationId: "executor-durable-fatal", jobId: job.id, createdAt: tickAt(5),
  });
  await assert.rejects(
    () => scheduler.waitForIdle(run.id),
    (error) => error === fatalSignals[0] && error.code === "CRON_COMMIT_UNCERTAIN",
  );
  assert.equal(fatalSignals.length, 1);
  assert.equal(scheduler.state, "poisoned");
  assert.equal(ctx.timer.entries.size, 0);
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(JSON.stringify(
    fatalSignals[0], Object.getOwnPropertyNames(fatalSignals[0]),
  ).includes(secret), false);
  await scheduler.close();

  const recoveredExecutor = {
    calls: [],
    schedule() { throw new Error("unexpected schedule after restart"); },
    recover(payload) { this.calls.push(payload); },
  };
  const recovered = ctx.createScheduler({ executor: recoveredExecutor });
  await recovered.open();
  assert.deepEqual(recoveredExecutor.calls.map((call) => call.run.id), [run.id]);
  await recovered.close();
  ctx.close();
});

test("direct tick Store corrupt 固定脱敏 poison+fatal 且绝不重排", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-store-corrupt-fatal",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const secret = "store-corrupt-secret-must-not-survive";
  let corrupt = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && corrupt) return () => {
        const error = Object.assign(new Error(secret), {
          code: "STORE_CORRUPT_EVENT_LOG",
          cause: new Error(secret),
        });
        throw error;
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  corrupt = true;
  let fatal;
  await assert.rejects(() => scheduler.tick(), (error) => {
    fatal = error;
    return error.code === "CRON_STORE_CORRUPT"
      && error.message === "Cron 持久化存储损坏，必须重启 Service";
  });
  assert.deepEqual(fatalSignals, [fatal]);
  assert.equal(scheduler.state, "poisoned");
  assert.equal(ctx.timer.entries.size, 0);
  assert.equal(JSON.stringify(fatal, Object.getOwnPropertyNames(fatal)).includes(secret), false);
  await scheduler.close();
  ctx.close();
});

test("direct tick 上游 poisoned code 归一为 Scheduler fatal 而不进入重试循环", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-upstream-poisoned-fatal",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  let poisoned = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && poisoned) return () => {
        throw Object.assign(new Error("upstream poisoned raw"), {
          code: "UPSTREAM_STORE_POISONED", poisoned: true,
        });
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  poisoned = true;
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error === fatalSignals[0]
      && error.code === "CRON_SCHEDULER_POISONED",
  );
  assert.equal(fatalSignals.length, 1);
  assert.equal(scheduler.state, "poisoned");
  assert.equal(ctx.timer.entries.size, 0);
  await scheduler.close();
  ctx.close();
});

test("public waitForIdle 读取 Store corrupt 也进入同一 sticky fatal 边界", async () => {
  const ctx = fixture();
  let corruptRead = false;
  const dispatcher = {
    enqueue: (...args) => ctx.dispatcher.enqueue(...args),
    listRuns: (...args) => ctx.dispatcher.listRuns(...args),
    getRun(...args) {
      if (corruptRead) {
        throw Object.assign(new Error("wait read corrupt raw"), {
          code: "STORE_CORRUPT_SNAPSHOT",
        });
      }
      return ctx.dispatcher.getRun(...args);
    },
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    dispatcher, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  corruptRead = true;
  await assert.rejects(
    () => scheduler.waitForIdle("missing-run"),
    (error) => error === fatalSignals[0] && error.code === "CRON_STORE_CORRUPT",
  );
  assert.equal(fatalSignals.length, 1);
  assert.equal(scheduler.state, "poisoned");
  await scheduler.close();
  ctx.close();
});

test("fatal 分类遇到原型 accessor 时 getter 零调用并 fail closed", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-hostile-fatal-error",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const secret = "hostile-error-accessor-secret";
  let getterCalls = 0;
  let hostile = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && hostile) return () => {
        const error = new Error(secret);
        const errorPrototype = Object.create(Error.prototype, {
          code: {
            enumerable: true,
            get() {
              getterCalls += 1;
              throw new Error(secret);
            },
          },
        });
        Object.setPrototypeOf(error, errorPrototype);
        throw error;
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  hostile = true;
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error === fatalSignals[0]
      && error.code === "CRON_SCHEDULER_POISONED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret),
  );
  assert.equal(getterCalls, 0);
  assert.equal(scheduler.state, "poisoned");
  assert.equal(ctx.timer.entries.size, 0);
  await scheduler.close();
  ctx.close();
});

test("fatal 分类遇到 Proxy descriptor trap 时固定 generic poison", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-proxy-trap-fatal-error",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const secret = "fatal-proxy-trap-secret";
  let fail = false;
  let trapCalls = 0;
  const raw = new Proxy(new Error(secret), {
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error(secret);
    },
  });
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && fail) return () => { throw raw; };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  fail = true;
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error === fatalSignals[0]
      && error.code === "CRON_SCHEDULER_POISONED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret),
  );
  assert.equal(trapCalls, 1);
  assert.equal(fatalSignals.length, 1);
  await scheduler.close();
  ctx.close();
});

test("fatal code 可沿有限原型链读取 data descriptor 并保持脱敏", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-prototype-fatal-code",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const secret = "prototype-store-corrupt-secret";
  const errorPrototype = Object.create(Error.prototype, {
    code: { value: "STORE_CORRUPT_EVENT_LOG", enumerable: true },
  });
  const raw = new Error(secret);
  Object.setPrototypeOf(raw, errorPrototype);
  let fail = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && fail) return () => { throw raw; };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  fail = true;
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error === fatalSignals[0] && error.code === "CRON_STORE_CORRUPT",
  );
  assert.equal(fatalSignals.length, 1);
  assert.equal(JSON.stringify(
    fatalSignals[0], Object.getOwnPropertyNames(fatalSignals[0]),
  ).includes(secret), false);
  await scheduler.close();
  ctx.close();
});

test("fatal kind 对 stateful Proxy 只探测一次并保留 commit 分类", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-stateful-fatal-proxy",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  let descriptorCalls = 0;
  const raw = new Proxy({}, {
    getOwnPropertyDescriptor(_target, property) {
      descriptorCalls += 1;
      if (descriptorCalls > 3) throw new Error("second fatal probe must not happen");
      if (property === "code") {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: "STORE_COMMIT_UNCERTAIN",
        };
      }
      return undefined;
    },
    getPrototypeOf() { return null; },
  });
  let fail = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "listJobs" && fail) return () => { throw raw; };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore, onFatalError(error) { fatalSignals.push(error); },
  });
  await scheduler.open();
  fail = true;
  await assert.rejects(
    () => scheduler.tick(),
    (error) => error === fatalSignals[0] && error.code === "CRON_COMMIT_UNCERTAIN",
  );
  assert.equal(descriptorCalls, 3);
  assert.equal(fatalSignals.length, 1);
  await scheduler.close();
  ctx.close();
});

test("close/open 旧 executor 迟到失败由当前 generation 单次接管", async () => {
  const ctx = fixture();
  let rejectOld;
  const oldTask = new Promise((resolve, reject) => { rejectOld = reject; });
  const order = [];
  const executor = {
    schedule() {
      order.push("schedule-start");
      return oldTask.finally(() => { order.push("schedule-settled"); });
    },
    recover() {
      order.push("recover-current-generation");
    },
  };
  const job = createEveryJob(ctx, { operationId: "create-late-settle" });
  const scheduler = ctx.createScheduler({ executor });
  await scheduler.open();
  const [run] = cronRuns(ctx, job.id);
  await scheduler.close();
  await scheduler.open();
  assert.deepEqual(order, ["schedule-start"]);
  rejectOld(Object.assign(new Error("late failure"), { code: "EXECUTOR_LATE" }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [
    "schedule-start", "schedule-settled", "recover-current-generation",
  ]);
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(scheduler.inflight.size, 0);
  await scheduler.close();
  ctx.close();
});

test("occurrence 推进 commit-uncertain 会 sticky poison，绝不调用 executor", async () => {
  const ctx = fixture();
  createEveryJob(ctx);
  const uncertain = Object.assign(new Error("uncertain"), {
    code: "CRON_COMMIT_UNCERTAIN",
    committedUncertain: true,
  });
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return () => { throw uncertain; };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scheduler = ctx.createScheduler({ cronStore });
  let fatal;
  await assert.rejects(() => scheduler.open(), (error) => {
    fatal = error;
    return error.code === "CRON_COMMIT_UNCERTAIN";
  });
  await assert.rejects(() => scheduler.open(), (error) => error === fatal);
  await assert.rejects(() => scheduler.tick(), (error) => error === fatal);
  assert.equal(ctx.executor.calls.length, 0);
  await scheduler.close();
  ctx.close();
});

test("timer 回调中的 commit-uncertain 被消费并 poison，不产生 unhandled rejection", async () => {
  const ctx = fixture();
  createEveryJob(ctx, { operationId: "create-future", createdAt: tickAt(5) });
  const uncertain = Object.assign(new Error("timer uncertain"), {
    code: "CRON_COMMIT_UNCERTAIN",
    committedUncertain: true,
  });
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return () => { throw uncertain; };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatalSignals = [];
  const scheduler = ctx.createScheduler({
    cronStore,
    onFatalError(error) {
      fatalSignals.push(error);
      return Promise.reject(new Error("async-fatal-callback-secret"));
    },
  });
  await scheduler.open();
  const callback = [...ctx.timer.entries.values()][0].callback;
  ctx.clock.value = tickAt(6);
  callback();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fatalSignals.length, 1);
  await assert.rejects(() => scheduler.tick(), (error) => error === fatalSignals[0]);
  await scheduler.close();
  ctx.close();
});

test("timer 普通失败会有界重排并从 durable queued 恢复", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-transient-timer", createdAt: tickAt(5),
  });
  const transient = Object.assign(new Error("temporary write failure"), {
    code: "CRON_WRITE_FAILED",
  });
  let failOnce = true;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => {
        if (failOnce) {
          failOnce = false;
          throw transient;
        }
        return target.setJobNextRunAt(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scheduler = ctx.createScheduler({ cronStore });
  await scheduler.open();
  const firstCallback = [...ctx.timer.entries.values()][0].callback;
  ctx.clock.value = tickAt(6);
  firstCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.state, "open");
  assert.equal(scheduler.lastError, transient);
  assert.equal(ctx.timer.entries.size, 1);
  const retry = [...ctx.timer.entries.values()][0];
  assert.equal(retry.delay, 1_000);
  retry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(7));
  assert.equal(cronRuns(ctx, job.id).filter(
    (run) => run.idempotencyKey.endsWith(`:${tickAt(6)}`),
  ).length, 1);
  assert.deepEqual(ctx.executor.calls.map((call) => call.kind), ["recover"]);
  assert.equal(scheduler.lastError, null);
  await scheduler.close();
  ctx.close();
});

test("public direct tick 普通失败保留原错并有界重排 timer", async () => {
  const ctx = fixture();
  const job = createEveryJob(ctx, {
    operationId: "create-transient-direct-tick",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const transient = Object.assign(new Error("direct tick transient"), {
    code: "CRON_WRITE_FAILED",
  });
  let failOnce = true;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => {
        if (failOnce) {
          failOnce = false;
          throw transient;
        }
        return target.setJobNextRunAt(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scheduler = ctx.createScheduler({ cronStore });
  await scheduler.open();
  ctx.clock.value = tickAt(6);
  await assert.rejects(() => scheduler.tick(), (error) => error === transient);
  assert.equal(scheduler.state, "open");
  assert.equal(scheduler.lastError, transient);
  assert.equal(ctx.timer.entries.size, 1);
  const [retry] = [...ctx.timer.entries.values()];
  assert.equal(retry.delay, 1_000);
  assert.equal(ctx.cronStore.getJob(job.id).nextRunAt, tickAt(6));
  await scheduler.close();
  ctx.close();
});

test("direct tick 重排 timer 失败时保留主错并固定关闭清理", async () => {
  const ctx = fixture();
  createEveryJob(ctx, {
    operationId: "create-direct-tick-rearm-failure",
    createdAt: tickAt(5), nextRunAt: tickAt(6),
  });
  const transient = Object.assign(new Error("primary transient"), {
    code: "CRON_WRITE_FAILED",
  });
  const timerSecret = "timer-rearm-secret-must-not-survive";
  let failMutation = true;
  let failRetryTimer = false;
  const cronStore = new Proxy(ctx.cronStore, {
    get(target, property) {
      if (property === "setJobNextRunAt") return (input) => {
        if (failMutation) {
          failMutation = false;
          throw transient;
        }
        return target.setJobNextRunAt(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const setTimer = (callback, delay) => {
    if (failRetryTimer && delay === TIMER_RETRY_DELAY_MS) throw new Error(timerSecret);
    return ctx.timer.set(callback, delay);
  };
  const scheduler = ctx.createScheduler({ cronStore, setTimer });
  await scheduler.open();
  failRetryTimer = true;
  ctx.clock.value = tickAt(6);
  await assert.rejects(() => scheduler.tick(), (error) => error === transient);
  assert.equal(scheduler.state, "closed");
  assert.equal(scheduler.timer, null);
  assert.equal(ctx.timer.entries.size, 0);
  assert.equal(scheduler.lastError.code, "CRON_TIMER_FAILED");
  assert.equal(scheduler.lastError.message, "Cron Scheduler timer 重排失败");
  assert.equal(JSON.stringify(
    scheduler.lastError, Object.getOwnPropertyNames(scheduler.lastError),
  ).includes(timerSecret), false);
  await scheduler.close();
  ctx.close();
});

(async () => {
  let failed = 0;
  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`PASS ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${name}`);
        console.error(error?.stack || error);
      }
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`RESULT ${tests.length - failed}/${tests.length} pass`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
