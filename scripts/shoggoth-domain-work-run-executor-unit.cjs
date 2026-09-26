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
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { createWorkDispatcher } = require(path.join(ROOT, "app", "agent-service", "work-run.js"));
const { WorkRunCoordinator } = require(path.join(
  ROOT, "app", "agent-service", "work-run-coordinator.js",
));
const { RunExecutionStore } = require(path.join(ROOT, "app", "agent-service", "run-execution-store.js"));

let DomainWorkRunExecutor;
let domainOperationId;
let domainThreadSource;
let moduleLoadError = null;
try {
  ({
    DomainWorkRunExecutor,
    domainOperationId,
    domainThreadSource,
  } = require(path.join(ROOT, "app", "agent-service", "domain-work-run-executor.js")));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
const roots = new Set();
function test(name, fn) { tests.push({ name, fn }); }

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${label} timed out`);
}

class EmptyInbox {
  isLocked() { return false; }
  enqueue() { assert.fail("domain executor must not enqueue chat PendingCommand"); }
  get() { return null; }
  list() { return []; }
  transition() { assert.fail("domain executor must not transition chat PendingCommand"); }
}

class EmptyChatSessionStore {
  getSession() { return null; }
  requestBinding() { assert.fail("domain executor must not create ChatSession binding"); }
  completeBinding() { assert.fail("domain executor must not bind ChatSession"); }
  recoverBinding() { assert.fail("domain executor must not recover ChatSession"); }
  listPendingBindings() { return []; }
}

class FakeHost {
  constructor() {
    this.threads = [];
    this.subscribers = new Set();
    this.handlers = new Map();
    this.threadStartCalls = 0;
    this.threadResumeCalls = 0;
    this.turnStartCalls = 0;
    this.lastThreadStartParams = null;
    this.lastTurnStartParams = null;
    this.termination = deferred();
    this.terminated = this.termination.promise;
    this.terminated.catch(() => {});
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  registerServerRequestHandler(method, handler) {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }

  request(method, params) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`missing handler ${method}`);
    return handler(clone(params), { method, id: 1 });
  }

  async accountRead() {
    return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
  }

  emit(event) {
    for (const listener of [...this.subscribers]) listener(clone(event));
  }

  async threadList(params) {
    return {
      data: this.threads.filter((thread) => (thread.archived === true) === params.archived)
        .map(clone),
      nextCursor: null,
    };
  }

  async threadStart(params) {
    this.threadStartCalls += 1;
    this.lastThreadStartParams = clone(params);
    const thread = {
      id: `domain-thread-${this.threadStartCalls}`,
      threadSource: params.threadSource,
      archived: false,
      turns: [],
    };
    this.threads.push(thread);
    return { thread: clone(thread) };
  }

  async threadResume(params) {
    this.threadResumeCalls += 1;
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) {
      const error = new Error("thread not found");
      error.code = "THREAD_NOT_FOUND";
      throw error;
    }
    return { thread: clone(thread) };
  }

  async threadInjectItems(params) {
    assert.ok(this.threads.some(thread => thread.id === params.threadId));
    this.lastInjectedItems = clone(params);
    return {};
  }

  async threadRead(params) {
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) {
      const error = new Error("thread not found");
      error.code = "THREAD_NOT_FOUND";
      throw error;
    }
    return { thread: clone(thread) };
  }

  async turnStart(params) {
    this.turnStartCalls += 1;
    this.lastTurnStartParams = clone(params);
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    assert.ok(thread);
    const turn = {
      id: `domain-turn-${this.turnStartCalls}`,
      status: "inProgress",
      itemsView: "full",
      items: [{
        type: "userMessage",
        id: `domain-message-${this.turnStartCalls}`,
        clientId: params.clientUserMessageId,
      }],
    };
    thread.turns.push(turn);
    return { turn: clone(turn) };
  }

  completeTurn(turnId, text = "domain completed") {
    const thread = this.threads.find((candidate) => (
      candidate.turns.some((turn) => turn.id === turnId)
    ));
    assert.ok(thread);
    const turn = thread.turns.find((candidate) => candidate.id === turnId);
    turn.status = "completed";
    turn.items.push({
      type: "agentMessage", phase: "final_answer", delivery: "sync", text,
    });
    this.emit({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: thread.id,
      turnId,
      status: "completed",
    });
  }
}

function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-domain-executor-"));
  roots.add(root);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const clock = options.clock || { value: 10_000 };
  const productStore = new JsonlProductStore({ paths, now: () => clock.value });
  productStore.open();
  const profile = productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  productStore.putAgentProfile({
    ...profile,
    concurrency: {
      maxActive: options.maxActive ?? 2,
      maxWorkspaceWrites: options.maxWorkspaceWrites ?? 2,
    },
  });
  const dispatcher = createWorkDispatcher({ store: productStore, now: () => clock.value });
  const host = options.host || new FakeHost();
  const runExecutionStore = options.createRunExecutionStore?.(paths) || null;
  const coordinator = new WorkRunCoordinator({
    dispatcher,
    productStore,
    chatSessionStore: new EmptyChatSessionStore(),
    inbox: new EmptyInbox(),
    runtimePool: { async get() { return host; } },
    runExecutionStore,
    now: () => clock.value,
    randomUUID: (() => {
      let next = 0;
      return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    })(),
    assertSecretSafe: options.assertSecretSafe || (() => true),
    sanitizeSummary: (value) => value,
    terminalRetryDelaysMs: [],
    maxDomainExecutions: options.maxDomainExecutions,
  });
  const executor = moduleLoadError ? null : new DomainWorkRunExecutor({ coordinator });

  function enqueueRun({
    id, source = "kanban", sourceId = "source-one", workspace = undefined,
    idempotencyKey = `idem-${id}`,
  }) {
    const resolvedWorkspace = workspace === undefined
      ? path.join(root, `workspace-${id}`) : workspace;
    if (resolvedWorkspace !== null) fs.mkdirSync(resolvedWorkspace, { recursive: true });
    return dispatcher.enqueue({
      id,
      source,
      sourceId,
      idempotencyKey,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: resolvedWorkspace,
      retryOf: null,
    });
  }

  async function close() {
    await coordinator.close().catch(() => {});
    productStore.close();
    fs.rmSync(root, { recursive: true, force: true });
    roots.delete(root);
  }

  return { root, paths, clock, productStore, dispatcher, host, coordinator, executor,
    runExecutionStore, enqueueRun, close };
}

function payloadFor(run, overrides = {}) {
  if (run.source === "kanban") {
    return {
      run,
      card: { id: run.sourceId },
      prompt: overrides.prompt || "execute kanban card",
      recovered: overrides.recovered ?? false,
      onStateChange: overrides.onStateChange || (() => {}),
    };
  }
  return {
    run,
    job: { id: run.sourceId },
    prompt: overrides.prompt || "execute cron job",
    scheduledAt: overrides.scheduledAt ?? 10_000,
    operationId: run.idempotencyKey,
    threadPolicy: overrides.threadPolicy || "new",
    threadId: overrides.threadId ?? null,
    recovered: overrides.recovered ?? false,
  };
}

async function completeCurrent(ctx, runId, text) {
  await waitUntil(() => ctx.dispatcher.getRun(runId)?.status === "running", `${runId} running`);
  const running = ctx.dispatcher.getRun(runId);
  ctx.host.completeTurn(running.codexTurnId, text);
  await waitUntil(() => ctx.dispatcher.getRun(runId)?.status === "completed", `${runId} completed`);
}

test("DomainWorkRunExecutor 模块和 Coordinator 内部入口可用", async () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof DomainWorkRunExecutor, "function");
  assert.equal(typeof domainOperationId, "function");
  assert.equal(typeof domainThreadSource, "function");
  const ctx = makeFixture();
  await ctx.coordinator.open();
  assert.equal(typeof ctx.coordinator.executeDomainRun, "function");
  await ctx.close();
});

test("writable domain Run 缺少 workspace 时准入前失败且不遗留 starting", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({
    id: "cron-missing-workspace",
    source: "cron",
    sourceId: "job-missing-workspace",
    workspace: null,
  });
  await assert.rejects(
    ctx.executor.schedule(payloadFor(run)),
    (error) => error.code === "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN",
  );
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(ctx.host.threadStartCalls, 0);
  await ctx.close();
});

test("domain Codex 启动错误 durable 收敛 failed 而不是永久 starting", async () => {
  const host = new FakeHost();
  host.threadStart = async function threadStart() {
    this.threadStartCalls += 1;
    const error = new Error("runtime unavailable");
    error.code = "RPC_REMOTE_ERROR";
    throw error;
  };
  const ctx = makeFixture({ host });
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({
    id: "cron-start-failure",
    source: "cron",
    sourceId: "job-start-failure",
  });
  const terminal = await ctx.executor.schedule(payloadFor(run));
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.errorCode, "RUNTIME_START_SESSION_START_OR_RESUME_FAILED");
  assert.equal(host.threadStartCalls, 2, "turn acceptance 前的 runtime 错误只重试一次");
  assert.equal(host.turnStartCalls, 0);
  await ctx.close();
});

test("中央认证门禁让 Cron 与 Kanban 在 Runtime session 前 durable 失败", async () => {
  for (const source of ["cron", "kanban"]) {
    const host = new FakeHost();
    let accountReadCalls = 0;
    host.accountRead = async () => {
      accountReadCalls += 1;
      return { account: null, requiresOpenaiAuth: true };
    };
    const ctx = makeFixture({ host });
    await ctx.coordinator.open();
    const run = ctx.enqueueRun({
      id: `${source}-auth-required`,
      source,
      sourceId: `${source}-source-auth-required`,
      ...(source === "cron" ? { idempotencyKey: `${source}-auth-required:10000` } : {}),
    });
    const terminal = await ctx.executor.schedule(payloadFor(run));
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(accountReadCalls, 1);
    assert.equal(host.threadStartCalls, 0);
    assert.equal(host.turnStartCalls, 0);
    await ctx.close();
  }
});

test("Domain adapter 对 Kanban/Cron 使用严格 exact payload 并验证必要 run binding", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const kanban = ctx.enqueueRun({ id: "kanban-invalid-payload", sourceId: "card-invalid-payload" });
  const cron = ctx.enqueueRun({
    id: "cron-invalid-payload", source: "cron", sourceId: "job-invalid-payload",
    idempotencyKey: "job-invalid-payload:10000",
  });
  ctx.dispatcher.transition(kanban.id, "skipped", { resultSummary: "fixture terminal" });
  ctx.dispatcher.transition(cron.id, "skipped", { resultSummary: "fixture terminal" });
  const malformedRun = { ...kanban };
  delete malformedRun.profileId;
  const extraRun = { ...kanban, unexpected: true };
  const invalidStatusRun = { ...kanban, status: "not-a-work-run-status" };
  const invalidEventSeqRun = { ...kanban, eventSeq: "1" };
  const missingNullableRun = { ...kanban };
  delete missingNullableRun.retryOf;
  const undefinedNullableRun = { ...kanban, retryOf: undefined };
  const outcomes = await Promise.allSettled([
    ctx.executor.schedule({ ...payloadFor(kanban), unexpected: true }),
    ctx.executor.schedule((({ scheduledAt: _scheduledAt, ...payload }) => payload)(payloadFor(cron))),
    ctx.executor.schedule(payloadFor(malformedRun)),
    ctx.executor.schedule(payloadFor(extraRun)),
    ctx.executor.schedule(payloadFor(invalidStatusRun)),
    ctx.executor.schedule(payloadFor(invalidEventSeqRun)),
    ctx.executor.schedule(payloadFor(missingNullableRun)),
    ctx.executor.schedule(payloadFor(undefinedNullableRun)),
  ]);
  assert.deepEqual(outcomes.map((outcome) => ({
    status: outcome.status,
    code: outcome.reason?.code,
  })), [
    { status: "rejected", code: "DOMAIN_WORK_RUN_PAYLOAD_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_PAYLOAD_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
    { status: "rejected", code: "DOMAIN_WORK_RUN_INVALID" },
  ]);
  await ctx.close();
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("Cron threadId 在 adapter 与 Coordinator 都遵守 256B opaque Store 契约", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const cron = ctx.enqueueRun({
    id: "cron-thread-id-bounds", source: "cron", sourceId: "job-thread-id-bounds",
    idempotencyKey: "job-thread-id-bounds:10000",
  });
  ctx.dispatcher.transition(cron.id, "skipped", { resultSummary: "fixture terminal" });
  const oversizedThreadId = `t${"a".repeat(256)}`;
  await assert.rejects(
    ctx.executor.schedule(payloadFor(cron, {
      threadPolicy: "continue",
      threadId: oversizedThreadId,
    })),
    (error) => error.code === "DOMAIN_WORK_RUN_PAYLOAD_INVALID",
  );
  await assert.rejects(
    ctx.coordinator.executeDomainRun({
      runId: cron.id,
      operationId: domainOperationId(cron),
      prompt: "bounded thread id",
      threadSource: domainThreadSource(cron, "continue"),
      threadId: oversizedThreadId,
    }),
    (error) => error.code === "DOMAIN_WORK_RUN_EXECUTION_INVALID",
  );
  assert.deepEqual({
    domainCommands: ctx.coordinator.getMemoryStats().domainCommands,
    terminalWaiters: ctx.coordinator.getMemoryStats().terminalWaiters,
  }, { domainCommands: 0, terminalWaiters: 0 });
  await ctx.close();
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("Kanban queued Run 复用 Coordinator/Host 执行且不创建 ChatSession/PendingCommand", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const workspace = path.join(ctx.root, "kanban-workspace");
  fs.mkdirSync(workspace);
  const run = ctx.enqueueRun({ id: "kanban-run-one", workspace });
  let projected = 0;
  const task = ctx.executor.schedule(payloadFor(run, { onStateChange: () => { projected += 1; } }));
  await waitUntil(() => ctx.dispatcher.getRun(run.id)?.status === "running", "kanban running");
  const running = ctx.dispatcher.getRun(run.id);
  assert.equal(ctx.host.threadStartCalls, 1);
  assert.equal(ctx.host.turnStartCalls, 1);
  assert.equal(ctx.host.lastThreadStartParams.cwd, fs.realpathSync(workspace));
  assert.equal(ctx.host.lastTurnStartParams.clientUserMessageId, domainOperationId(run));
  ctx.host.completeTurn(running.codexTurnId, "kanban result");
  const terminal = await task;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.resultSummary, "kanban result");
  assert.ok(projected >= 2, "running 与 terminal 都应通知 domain projection");
  await ctx.close();
});

test("workspace/profile busy 保持 queued，前序 terminal 后自动 drain 且每个 Run 只启动一个 turn", async () => {
  const ctx = makeFixture({ maxActive: 1, maxWorkspaceWrites: 1 });
  await ctx.coordinator.open();
  const workspace = path.join(ctx.root, "shared-workspace");
  fs.mkdirSync(workspace);
  const first = ctx.enqueueRun({ id: "kanban-busy-first", sourceId: "card-first", workspace });
  const second = ctx.enqueueRun({ id: "kanban-busy-second", sourceId: "card-second", workspace });
  const firstTask = ctx.executor.schedule(payloadFor(first));
  await waitUntil(() => ctx.dispatcher.getRun(first.id)?.status === "running", "first running");
  const secondTask = ctx.executor.schedule(payloadFor(second));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.dispatcher.getRun(second.id).status, "queued");
  assert.equal(ctx.host.turnStartCalls, 1);
  await completeCurrent(ctx, first.id, "first result");
  await firstTask;
  await waitUntil(() => ctx.dispatcher.getRun(second.id)?.status === "running", "second drained");
  assert.equal(ctx.host.turnStartCalls, 2);
  await completeCurrent(ctx, second.id, "second result");
  await secondTask;
  assert.deepEqual(ctx.host.threads.flatMap((thread) => thread.turns)
    .map((turn) => turn.items[0].clientId).sort(), [
    domainOperationId(first), domainOperationId(second),
  ].sort());
  await ctx.close();
});

test("queued domain prompt 在真正 turn/start 前动态复检新注册 secret", async () => {
  const secretCanary = "late-domain-secret-canary";
  let blockedPrompt = null;
  const ctx = makeFixture({
    maxActive: 1,
    maxWorkspaceWrites: 1,
    assertSecretSafe(value, context) {
      if (context?.kind === "domainPrompt" && value?.prompt === blockedPrompt) {
        throw new Error(secretCanary);
      }
      return true;
    },
  });
  await ctx.coordinator.open();
  const first = ctx.enqueueRun({ id: "domain-secret-first", sourceId: "card-secret-first" });
  const second = ctx.enqueueRun({ id: "domain-secret-second", sourceId: "card-secret-second" });
  const firstTask = ctx.executor.schedule(payloadFor(first, { prompt: "first safe prompt" }));
  await waitUntil(() => ctx.dispatcher.getRun(first.id)?.status === "running", "secret first running");
  const secondTask = ctx.executor.schedule(payloadFor(second, { prompt: secretCanary }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.dispatcher.getRun(second.id).status, "queued");
  blockedPrompt = secretCanary;
  await completeCurrent(ctx, first.id, "first done");
  await firstTask;

  let promptError = null;
  await waitUntil(async () => {
    try {
      await ctx.coordinator.waitForIdle(second.id);
      return false;
    } catch (error) {
      promptError = error;
      return true;
    }
  }, "dynamic secret rejection");
  assert.equal(promptError.code, "DOMAIN_WORK_RUN_PROMPT_SECRET_REJECTED");
  assert.equal(JSON.stringify(promptError, Object.getOwnPropertyNames(promptError)).includes(secretCanary), false);
  assert.equal(ctx.host.turnStartCalls, 1);
  assert.notEqual(ctx.dispatcher.getRun(second.id).status, "running");
  await ctx.coordinator.close();
  await assert.rejects(secondTask, (error) => error.code === "WORK_RUN_COORDINATOR_CLOSING");
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("domain command/waiter 共享硬容量，拒绝项无残留且 terminal 释放后可复用", async () => {
  const ctx = makeFixture({
    maxActive: 1,
    maxWorkspaceWrites: 1,
    maxDomainExecutions: 2,
  });
  await ctx.coordinator.open();
  const workspace = path.join(ctx.root, "domain-capacity-workspace");
  fs.mkdirSync(workspace);
  const first = ctx.enqueueRun({ id: "domain-capacity-first", sourceId: "card-capacity-first", workspace });
  const second = ctx.enqueueRun({ id: "domain-capacity-second", sourceId: "card-capacity-second", workspace });
  const third = ctx.enqueueRun({ id: "domain-capacity-third", sourceId: "card-capacity-third", workspace });
  const firstTask = ctx.executor.schedule(payloadFor(first));
  let secondTask;
  try {
    await waitUntil(() => ctx.dispatcher.getRun(first.id)?.status === "running", "capacity first running");
    secondTask = ctx.executor.schedule(payloadFor(second));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      domainCommands: ctx.coordinator.getMemoryStats().domainCommands,
      terminalWaiters: ctx.coordinator.getMemoryStats().terminalWaiters,
    }, { domainCommands: 2, terminalWaiters: 2 });

    const thirdOutcome = await Promise.race([
      ctx.executor.schedule(payloadFor(third)).then(
        () => ({ kind: "resolved" }),
        (error) => ({ kind: "rejected", code: error?.code }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
    ]);
    assert.deepEqual(thirdOutcome, {
      kind: "rejected",
      code: "DOMAIN_WORK_RUN_EXECUTOR_BUSY",
    });
    assert.deepEqual({
      domainCommands: ctx.coordinator.getMemoryStats().domainCommands,
      terminalWaiters: ctx.coordinator.getMemoryStats().terminalWaiters,
    }, { domainCommands: 2, terminalWaiters: 2 });

    await completeCurrent(ctx, first.id, "capacity first");
    await firstTask;
    await completeCurrent(ctx, second.id, "capacity second");
    await secondTask;
    assert.deepEqual({
      domainCommands: ctx.coordinator.getMemoryStats().domainCommands,
      terminalWaiters: ctx.coordinator.getMemoryStats().terminalWaiters,
    }, { domainCommands: 0, terminalWaiters: 0 });

    const thirdRetry = ctx.executor.schedule(payloadFor(third));
    await completeCurrent(ctx, third.id, "capacity third");
    await thirdRetry;
    assert.deepEqual({
      domainCommands: ctx.coordinator.getMemoryStats().domainCommands,
      terminalWaiters: ctx.coordinator.getMemoryStats().terminalWaiters,
    }, { domainCommands: 0, terminalWaiters: 0 });
  } finally {
    await ctx.coordinator.close().catch(() => {});
    await Promise.allSettled([firstTask, secondTask].filter(Boolean));
    ctx.productStore.close();
    fs.rmSync(ctx.root, { recursive: true, force: true });
    roots.delete(ctx.root);
  }
});

test("同生命周期 recover 不重复启动 turn，Host approval/input 继续走统一 waiting 状态机", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({ id: "kanban-interactive" });
  const payload = payloadFor(run);
  const scheduled = ctx.executor.schedule(payload);
  await waitUntil(() => ctx.dispatcher.getRun(run.id)?.status === "running", "interactive running");
  const recovered = ctx.executor.recover({ ...payload, recovered: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.host.turnStartCalls, 1);
  const running = ctx.dispatcher.getRun(run.id);
  const approvalResponse = ctx.host.request("item/commandExecution/requestApproval", {
    threadId: running.codexThreadId,
    turnId: running.codexTurnId,
    itemId: "command-one",
    command: "echo safe",
    cwd: null,
    reason: "fixture",
  });
  await waitUntil(
    () => ctx.dispatcher.getRun(run.id)?.status === "waiting_approval",
    "waiting approval",
  );
  const approvalRun = ctx.dispatcher.getRun(run.id);
  await ctx.coordinator.respondApproval({
    operationId: "approve-domain-one",
    runId: run.id,
    requestId: approvalRun.waitingRequestId,
    choice: "once",
  });
  assert.deepEqual(await approvalResponse, { decision: "accept" });

  const inputResponse = ctx.host.request("mcpServer/elicitation/request", {
    threadId: running.codexThreadId,
    turnId: running.codexTurnId,
    serverName: "shoggoth",
    mode: "form",
    message: "Choose",
    requestedSchema: { type: "object" },
    elicitationId: "elicitation-one",
  });
  await waitUntil(
    () => ctx.dispatcher.getRun(run.id)?.status === "waiting_input",
    "waiting input",
  );
  const inputRun = ctx.dispatcher.getRun(run.id);
  await ctx.coordinator.respondInput({
    operationId: "input-domain-one",
    runId: run.id,
    requestId: inputRun.waitingRequestId,
    action: "submit",
    answers: { choice: "safe" },
  });
  assert.deepEqual(await inputResponse, { action: "accept", content: { choice: "safe" } });
  await completeCurrent(ctx, run.id, "interactive result");
  await Promise.all([scheduled, recovered]);
  assert.equal(ctx.host.turnStartCalls, 1);
  await ctx.close();
});

test("真实 Cron WorkRun 加密绑定在派发前持久，重建后只读取 completed 原生轮次而不重发", async () => {
  const key = crypto.randomBytes(32);
  const cryptoBroker = {
    async encrypt(input) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(input) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, input.subarray(0, 12));
      cipher.setAuthTag(input.subarray(12, 28));
      return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]);
    },
  };
  const ctx = makeFixture({ createRunExecutionStore: (paths) => new RunExecutionStore({ paths, cryptoBroker }) });
  let replacement;
  let reopenedProduct;
  try {
    await ctx.coordinator.open();
    const run = ctx.enqueueRun({ id: "cron-durable-recovery", source: "cron", sourceId: "job-durable-recovery" });
    const prompt = "private durable cron prompt fixture";
    const originalStart = ctx.host.turnStart.bind(ctx.host);
    let durableBeforeDispatch = false;
    ctx.host.turnStart = async (params) => {
      assert.equal(ctx.dispatcher.getRun(run.id).status, "starting");
      const saved = await ctx.runExecutionStore.get(ctx.dispatcher.getRun(run.id));
      assert.equal(saved.command.prompt, prompt);
      assert.equal(saved.command.operationId, domainOperationId(run));
      assert.equal(saved.contract.runtimeAccountGeneration, undefined);
      const folder = path.join(ctx.paths.stateDir, "run-executions");
      const contents = fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), "utf8");
      assert.equal(contents.includes(prompt), false);
      durableBeforeDispatch = true;
      return originalStart(params);
    };
    const firstTask = ctx.executor.schedule(payloadFor(run, { prompt, threadPolicy: "continue" }));
    void firstTask.catch(() => {});
    await waitUntil(() => ctx.dispatcher.getRun(run.id)?.status === "running", "durable cron running");
    assert.equal(durableBeforeDispatch, true);
    const running = ctx.dispatcher.getRun(run.id);
    await ctx.coordinator.close();
    ctx.productStore.close();
    // Native completion while the Service is absent: no old subscription can
    // settle ProductStore. The replacement must prove it from native history.
    ctx.host.completeTurn(running.codexTurnId, "completed while service was stopped");
    const replacementHost = new FakeHost();
    replacementHost.threads = clone(ctx.host.threads);
    reopenedProduct = new JsonlProductStore({ paths: ctx.paths, now: () => ctx.clock.value + 1 });
    reopenedProduct.open();
    const dispatcher = createWorkDispatcher({ store: reopenedProduct, now: () => ctx.clock.value + 1 });
    assert.equal(dispatcher.getRun(run.id).status, "running");
    const reopenedExecution = new RunExecutionStore({ paths: ctx.paths, cryptoBroker });
    replacement = new WorkRunCoordinator({
      dispatcher, productStore: reopenedProduct, runExecutionStore: reopenedExecution,
      chatSessionStore: new EmptyChatSessionStore(), inbox: new EmptyInbox(),
      runtimePool: { async get() { return replacementHost; } },
      now: () => ctx.clock.value + 1,
      assertSecretSafe: () => true, sanitizeSummary: (value) => value,
      terminalRetryDelaysMs: [], recoverOrphanedDomainRuns: true,
    });
    await replacement.open();
    await waitUntil(() => dispatcher.getRun(run.id)?.status === "completed", "durable cron native reconciliation");
    assert.equal(dispatcher.getRun(run.id).resultSummary, "completed while service was stopped");
    assert.equal(ctx.host.turnStartCalls, 1);
    assert.equal(replacementHost.turnStartCalls, 0);
    assert.equal(replacementHost.threadStartCalls, 0);
    assert.equal(await reopenedExecution.get(dispatcher.getRun(run.id)), null);
  } finally {
    await replacement?.close().catch(() => {});
    reopenedProduct?.close();
    await ctx.close();
    key.fill(0);
  }
});

test("Coordinator 重建后 active domain Run 缺少冻结合同，recover 安全 interrupted 且不启动 Host", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({ id: "cron-lost-contract", source: "cron", sourceId: "job-lost" });
  const firstTask = ctx.executor.schedule(payloadFor(run, { threadPolicy: "continue" }));
  await waitUntil(() => ctx.dispatcher.getRun(run.id)?.status === "running", "lost contract running");
  await ctx.coordinator.close();
  void firstTask.catch(() => {});

  const replacementHost = new FakeHost();
  const replacement = new WorkRunCoordinator({
    dispatcher: ctx.dispatcher,
    productStore: ctx.productStore,
    chatSessionStore: new EmptyChatSessionStore(),
    inbox: new EmptyInbox(),
    runtimePool: { async get() { return replacementHost; } },
    now: () => ctx.clock.value + 1,
    randomUUID: () => "99999999-9999-4999-8999-999999999999",
    assertSecretSafe: () => true,
    sanitizeSummary: (value) => value,
  });
  await replacement.open();
  const executor = new DomainWorkRunExecutor({ coordinator: replacement });
  const recovered = await executor.recover(payloadFor(
    ctx.dispatcher.getRun(run.id), { recovered: true, threadPolicy: "continue" },
  ));
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.errorCode, "EXECUTION_CONTRACT_LOST");
  assert.equal(replacementHost.turnStartCalls, 0);
  await replacement.close();
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("Coordinator close 会拒绝 domain terminal waiter，旧 executor ownership 不跨代悬挂", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({ id: "kanban-close-waiter" });
  const execution = ctx.executor.schedule(payloadFor(run));
  await waitUntil(() => ctx.dispatcher.getRun(run.id)?.status === "running", "close waiter running");
  await ctx.coordinator.close();
  const outcome = await Promise.race([
    execution.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", code: error?.code }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 50)),
  ]);
  assert.deepEqual(outcome, { kind: "rejected", code: "WORK_RUN_COORDINATOR_CLOSING" });
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("Cron continue 显式 threadId 必须同时匹配 durable threadSource", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const run = ctx.enqueueRun({
    id: "cron-explicit-foreign", source: "cron", sourceId: "job-explicit",
    idempotencyKey: "job-explicit:10000",
  });
  ctx.host.threads.push({
    id: "foreign-thread",
    threadSource: "shoggoth:cron:foreign-source",
    archived: false,
    turns: [],
  });
  const execution = ctx.executor.schedule(payloadFor(run, {
    threadPolicy: "continue",
    threadId: "foreign-thread",
  }));
  await assert.rejects(
    ctx.coordinator.waitForIdle(run.id),
    (error) => error.code === "CODEX_THREAD_RESUME_SOURCE_MISMATCH",
  );
  assert.equal(ctx.host.turnStartCalls, 0);
  assert.notEqual(ctx.dispatcher.getRun(run.id).status, "running");
  await ctx.coordinator.close();
  await assert.rejects(execution, (error) => error.code === "WORK_RUN_COORDINATOR_CLOSING");
  ctx.productStore.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  roots.delete(ctx.root);
});

test("Cron continue 按 Job 复用 thread，new 按 Run 隔离且 occurrence 不重复 turn", async () => {
  const ctx = makeFixture();
  await ctx.coordinator.open();
  const first = ctx.enqueueRun({
    id: "cron-continue-one", source: "cron", sourceId: "job-continue",
    idempotencyKey: "job-continue:10000",
  });
  const firstTask = ctx.executor.schedule(payloadFor(first, { threadPolicy: "continue" }));
  await completeCurrent(ctx, first.id, "cron one");
  await firstTask;
  const second = ctx.enqueueRun({
    id: "cron-continue-two", source: "cron", sourceId: "job-continue",
    idempotencyKey: "job-continue:20000",
  });
  const secondPayload = payloadFor(second, { threadPolicy: "continue" });
  const secondTask = ctx.executor.schedule(secondPayload);
  const duplicate = ctx.executor.schedule(secondPayload);
  await waitUntil(() => ctx.dispatcher.getRun(second.id)?.status === "running", "continue second");
  assert.equal(ctx.host.threadStartCalls, 1, "continue 必须复用同一个 durable threadSource");
  assert.ok(ctx.host.threadResumeCalls >= 1);
  assert.equal(ctx.host.turnStartCalls, 2);
  await completeCurrent(ctx, second.id, "cron two");
  await Promise.all([secondTask, duplicate]);

  const third = ctx.enqueueRun({
    id: "cron-new-three", source: "cron", sourceId: "job-continue",
    idempotencyKey: "job-continue:30000",
  });
  const thirdTask = ctx.executor.schedule(payloadFor(third, { threadPolicy: "new" }));
  await waitUntil(() => ctx.dispatcher.getRun(third.id)?.status === "running", "new third");
  assert.equal(ctx.host.threadStartCalls, 2, "new 必须按 Run 新建 thread");
  assert.notEqual(domainThreadSource(first, "continue"), domainThreadSource(third, "new"));
  await completeCurrent(ctx, third.id, "cron three");
  await thirdTask;
  assert.equal(ctx.host.turnStartCalls, 3);
  await ctx.close();
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`);
    }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
  else process.stdout.write(`${tests.length} domain executor tests passed\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
