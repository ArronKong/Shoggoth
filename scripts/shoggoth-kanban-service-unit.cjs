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
const { createWorkDispatcher } = require(path.join(ROOT, "app", "agent-service", "work-run.js"));
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));
const { MAX_NATIVE_KANBAN_STORE_BYTES, NativeKanbanStore } = require(path.join(
  ROOT, "app", "agent-service", "native-kanban-store.js",
));
const { atomicWritePrivateFile } = require(path.join(
  ROOT, "app", "agent-service", "private-file.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const DAY_MS = 24 * 60 * 60 * 1_000;

let KanbanRunService;
let moduleLoadError = null;
try {
  ({ KanbanRunService } = require(path.join(
    ROOT, "app", "agent-service", "kanban-run-service.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
const fixtureRoots = new Set();
function test(name, fn) { tests.push({ name, fn }); }

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

class FakeExecutor {
  constructor(options = {}) {
    this.calls = [];
    this.gates = options.gates ? [...options.gates] : [];
    this.failures = options.failures ? [...options.failures] : [];
    this.canceled = [];
  }

  schedule(payload) { return this.#execute("schedule", payload); }
  recover(payload) { return this.#execute("recover", payload); }

  #execute(kind, payload) {
    this.calls.push({
      kind,
      runId: payload.run.id,
      cardId: payload.card.id,
      prompt: payload.prompt,
      recovered: payload.recovered,
      onStateChange: payload.onStateChange,
    });
    const failure = this.failures.shift();
    if (failure) return Promise.reject(codedError(failure));
    return this.gates.shift()?.promise || Promise.resolve();
  }
}

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-kanban-service-"));
  fixtureRoots.add(root);
  return resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
}

function openStores(options = {}) {
  const paths = options.paths || makePaths();
  const clock = options.clock || { value: 10_000 };
  const productStore = new JsonlProductStore({ paths, now: () => clock.value });
  productStore.open();
  const dispatcher = createWorkDispatcher({ store: productStore, now: () => clock.value });
  const kanbanStore = new NativeKanbanStore({
    paths,
    now: () => clock.value,
    profileExists: (id) => productStore.getAgentProfile(id) !== null,
    getRun: (id) => productStore.getWorkRun(id),
    isSensitiveValue: options.isSensitiveValue,
    capacities: options.kanbanCapacities,
    atomicWrite: options.atomicWrite,
  });
  kanbanStore.open();
  return { paths, clock, productStore, dispatcher, kanbanStore };
}

function createProfile(ctx, suffix, enabled = true) {
  const base = ctx.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  return ctx.productStore.putAgentProfile({
    ...base,
    id: `kanban-profile-${suffix}`,
    agentId: `kanban-agent-${suffix}`,
    name: `Kanban ${suffix}`,
    runtimeProfileId: `kanban-runtime-${suffix}`,
    isDefault: false,
    enabled,
  });
}

function createCard(ctx, suffix = "one", profileId = DEFAULT_AGENT_PROFILE_ID) {
  const board = ctx.kanbanStore.createBoard({
    operationId: `board-${suffix}`,
    profileId,
    slug: `board-${suffix}`,
    name: `Board ${suffix}`,
    description: null,
    createdAt: ctx.clock.value,
  });
  return ctx.kanbanStore.createCard({
    operationId: `card-${suffix}`,
    boardId: board.id,
    profileId,
    title: `Card ${suffix}`,
    body: `Body ${suffix}`,
    status: "backlog",
    position: 0,
    createdAt: ctx.clock.value,
  });
}

function identityWorkspaceResolver(_profileId, requested) {
  return requested;
}

function enabledTargetResolver() {
  return "enabled";
}

function createService(ctx, executor, overrides = {}) {
  return new KanbanRunService({
    dispatcher: overrides.dispatcher || ctx.dispatcher,
    kanbanStore: overrides.kanbanStore || ctx.kanbanStore,
    executor,
    resolveWorkspace: overrides.resolveWorkspace || identityWorkspaceResolver,
    resolveTargetState: overrides.resolveTargetState || enabledTargetResolver,
    now: () => ctx.clock.value,
    randomUUID: overrides.randomUUID,
    onFatalError: overrides.onFatalError,
  });
}

function dispatchInput(card, suffix = "one") {
  return {
    operationId: `dispatch-${suffix}`,
    cardId: card.id,
    workspace: `/tmp/kanban-${suffix}`,
    createdAt: 10_000,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function closeStores(ctx) {
  ctx.kanbanStore.close();
  ctx.productStore.close();
}

function capacityContainer(profileId, remainingBytes) {
  const boardId = "10000000-0000-4000-8000-000000000001";
  const targetCardId = "20000000-0000-4000-8000-000000000064";
  const cards = {};
  for (let index = 1; index <= 64; index += 1) {
    const id = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    cards[id] = {
      id,
      boardId,
      profileId,
      title: `Card ${index}`,
      body: index < 64 ? "x".repeat(1024 * 1024) : "",
      status: "backlog",
      position: index,
      archivedAt: null,
      completionRequest: null,
      completion: null,
      createdAt: 10_000,
      updatedAt: 10_000,
    };
  }
  const container = {
    version: 4,
    revision: 0,
    clockHighWaterMs: 10_000,
    idempotencyFloorMs: 0,
    boards: {
      [boardId]: {
        id: boardId,
        profileId,
        slug: "main",
        name: "Main",
        description: null,
        createdAt: 10_000,
        updatedAt: 10_000,
      },
    },
    cards,
    comments: {},
    attachments: {},
    artifacts: {},
    cardRunLinks: {},
    auditEvents: {},
    operations: {},
  };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(container)}\n`, "utf8");
  const fillBytes = MAX_NATIVE_KANBAN_STORE_BYTES - remainingBytes - baseBytes;
  assert.ok(fillBytes >= 0 && fillBytes <= 1024 * 1024);
  cards[targetCardId].body = "y".repeat(fillBytes);
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(container)}\n`, "utf8"),
    MAX_NATIVE_KANBAN_STORE_BYTES - remainingBytes,
  );
  return { container, targetCardId };
}

function openCapacityStores(remainingBytes, runId) {
  const paths = makePaths();
  const clock = { value: 10_000 };
  const productStore = new JsonlProductStore({ paths, now: () => clock.value });
  productStore.open();
  const dispatcher = createWorkDispatcher({ store: productStore, now: () => clock.value });
  const { container, targetCardId } = capacityContainer(DEFAULT_AGENT_PROFILE_ID, remainingBytes);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.stateDir, "native-kanban.json"),
    `${JSON.stringify(container)}\n`,
    { mode: 0o600 },
  );
  const kanbanStore = new NativeKanbanStore({
    paths,
    now: () => clock.value,
    profileExists: (id) => productStore.getAgentProfile(id) !== null,
    getRun: (id) => productStore.getWorkRun(id),
  });
  kanbanStore.open();
  const service = createService(
    { paths, clock, productStore, dispatcher, kanbanStore },
    new FakeExecutor(),
    { randomUUID: () => runId },
  );
  service.open();
  return { paths, clock, productStore, dispatcher, kanbanStore, service, targetCardId };
}

test("KanbanRunService 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof KanbanRunService, "function");
});

test("构造器严格要求 workspace resolver", () => {
  const ctx = openStores();
  assert.throws(
    () => new KanbanRunService({
      dispatcher: ctx.dispatcher,
      kanbanStore: ctx.kanbanStore,
      executor: new FakeExecutor(),
      resolveTargetState: enabledTargetResolver,
    }),
    (error) => error.code === "KANBAN_SERVICE_OPTIONS_INVALID"
      && error.message === "resolveWorkspace 必须是函数",
  );
  closeStores(ctx);
});

test("构造器严格要求 target state resolver", () => {
  const ctx = openStores();
  assert.throws(
    () => new KanbanRunService({
      dispatcher: ctx.dispatcher,
      kanbanStore: ctx.kanbanStore,
      executor: new FakeExecutor(),
      resolveWorkspace: identityWorkspaceResolver,
    }),
    (error) => error.code === "KANBAN_SERVICE_OPTIONS_INVALID"
      && error.message === "resolveTargetState 必须是函数",
  );
  closeStores(ctx);
});

test("dispatch 先取 Card，再按 Card profile 解析并冻结 canonical workspace", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "resolved-workspace");
  const managedWorkspace = path.join(ctx.paths.trustedRoot, "managed-workspace");
  fs.mkdirSync(managedWorkspace);
  const resolutions = [];
  const service = createService(ctx, new FakeExecutor(), {
    resolveWorkspace(profileId, requested) {
      resolutions.push({ profileId, requested });
      return managedWorkspace;
    },
  });
  service.open();

  assert.throws(
    () => service.dispatchCard({
      operationId: "dispatch-missing-card-workspace",
      cardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspace: null,
      createdAt: ctx.clock.value,
    }),
    (error) => error.code === "KANBAN_CARD_NOT_FOUND",
  );
  assert.deepEqual(resolutions, []);

  const dispatched = service.dispatchCard({
    operationId: "dispatch-resolved-workspace",
    cardId: card.id,
    workspace: null,
    createdAt: ctx.clock.value,
  });
  assert.deepEqual(resolutions, [{ profileId: card.profileId, requested: null }]);
  assert.equal(dispatched.run.workspace, fs.realpathSync(managedWorkspace));
  await service.waitForIdle(dispatched.run.id);
  service.close();
  closeStores(ctx);
});

test("dispatch resolver 失败时不创建 Run/Link 且 Card 不变", () => {
  const ctx = openStores();
  const card = createCard(ctx, "resolver-failure");
  const before = ctx.kanbanStore.getCard(card.id);
  const executor = new FakeExecutor();
  const failure = codedError("WORKSPACE_RESOLUTION_FAILED");
  const service = createService(ctx, executor, {
    resolveWorkspace(profileId, requested) {
      assert.equal(profileId, card.profileId);
      assert.equal(requested, null);
      throw failure;
    },
  });
  service.open();

  assert.throws(
    () => service.dispatchCard({
      operationId: "dispatch-resolver-failure",
      cardId: card.id,
      workspace: null,
      createdAt: ctx.clock.value,
    }),
    (error) => error === failure,
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 0);
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 0);
  assert.deepEqual(ctx.kanbanStore.getCard(card.id), before);
  assert.equal(executor.calls.length, 0);
  service.close();
  closeStores(ctx);
});

test("dispatch 先持久化 WorkRun/CardRunLink/queued Card，之后才交给 executor", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  const order = [];
  const dispatcher = {
    enqueue(input) { order.push("workrun"); return ctx.dispatcher.enqueue(input); },
    enqueueSkipped: (...args) => ctx.dispatcher.enqueueSkipped(...args),
    getRun: (id) => ctx.dispatcher.getRun(id),
    listRuns: (query) => ctx.dispatcher.listRuns(query),
    transition: (...args) => ctx.dispatcher.transition(...args),
  };
  const kanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "linkCardRun") return (input, prepared) => {
        order.push("link");
        return target.linkCardRun(input, prepared);
      };
      if (property === "setCardStatus") return (input) => {
        order.push(`card:${input.status}`);
        return target.setCardStatus(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const executor = new FakeExecutor();
  const originalSchedule = executor.schedule.bind(executor);
  executor.schedule = (payload) => {
    order.push("executor");
    assert.equal(ctx.dispatcher.getRun(payload.run.id)?.status, "queued");
    assert.equal(ctx.kanbanStore.getCardRunLinkByRunId(payload.run.id)?.cardId, card.id);
    assert.equal(ctx.kanbanStore.getCard(card.id)?.status, "queued");
    return originalSchedule(payload);
  };
  const service = createService(ctx, executor, { dispatcher, kanbanStore });
  service.open();
  const result = service.dispatchCard(dispatchInput(card));
  assert.equal(result.run.source, "kanban");
  assert.equal(result.run.sourceId, card.id);
  assert.equal(result.run.retryOf, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result.run, "prompt"), false);
  assert.deepEqual(order, ["workrun", "link", "card:queued"]);
  await service.waitForIdle(result.run.id);
  assert.deepEqual(order, ["workrun", "link", "card:queued", "executor"]);
  assert.equal(executor.calls[0].prompt, "Card one\n\nBody one");
  service.close();
  closeStores(ctx);
});

test("disabled Profile 的新 dispatch 可审计跳过，且不影响共享 Service 执行健康 Profile", async () => {
  const ctx = openStores();
  const disabledProfile = ctx.productStore.putAgentProfile({
    ...ctx.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    enabled: false,
  });
  const healthyProfile = createProfile(ctx, "healthy");
  const disabledCard = createCard(ctx, "disabled-target", disabledProfile.id);
  const healthyCard = createCard(ctx, "healthy-target", healthyProfile.id);
  const executor = new FakeExecutor();
  const service = createService(ctx, executor, {
    resolveTargetState(profileId) {
      const profile = ctx.productStore.getAgentProfile(profileId);
      if (!profile) throw codedError("PROFILE_MISSING");
      return profile.enabled ? "enabled" : "disabled";
    },
  });
  service.open();

  const skipped = service.dispatchCard(dispatchInput(disabledCard, "disabled-target"));
  assert.equal(skipped.run.status, "skipped");
  assert.equal(skipped.run.resultSummary, "KANBAN_TARGET_DISABLED");
  assert.equal(skipped.run.errorCode, null);
  assert.equal(skipped.card.status, "canceled");
  assert.equal(ctx.kanbanStore.getCardRunLinkByRunId(skipped.run.id).cardId, disabledCard.id);
  assert.equal(executor.calls.length, 0);

  const healthy = service.dispatchCard(dispatchInput(healthyCard, "healthy-target"));
  await service.waitForIdle(healthy.run.id);
  assert.deepEqual(executor.calls.map((call) => call.runId), [healthy.run.id]);
  assert.equal(service.opened, true);
  assert.equal(service.poisonError, null);
  service.close();
  closeStores(ctx);
});

test("Run queued/running/waiting/completed 自动投影；有效完成请求进入 review", async () => {
  const gate = deferred();
  const executor = new FakeExecutor({ gates: [gate] });
  const ctx = openStores();
  const card = createCard(ctx);
  const service = createService(ctx, executor);
  service.open();
  const dispatched = service.dispatchCard(dispatchInput(card));
  await settle();
  const execution = executor.calls[0];
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "queued");

  ctx.dispatcher.admit(dispatched.run.id);
  execution.onStateChange();
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "queued");
  ctx.dispatcher.transition(dispatched.run.id, "running", {
    ...runtimePatch("thread-kanban", "turn-kanban"),
  });
  execution.onStateChange();
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "running");
  ctx.dispatcher.transition(dispatched.run.id, "waiting_approval", { waitingRequestId: "approval-1" });
  execution.onStateChange();
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "waiting");
  ctx.dispatcher.transition(dispatched.run.id, "running");
  execution.onStateChange();
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "running");

  assert.equal(service.completeCardByProduct, undefined);
  service.requestCompletionFromAgent({
    operationId: "agent-request-one",
    cardId: card.id,
    runId: dispatched.run.id,
    createdAt: ctx.clock.value,
  });
  ctx.dispatcher.transition(dispatched.run.id, "completed", { resultSummary: "done" });
  execution.onStateChange();
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "review");
  assert.equal(ctx.kanbanStore.getCard(card.id).completion, null);
  assert.equal(ctx.kanbanStore.getCard(card.id).completionRequest.runId, dispatched.run.id);
  const accepted = service.completeCardManually({
    operationId: "accept-review", cardId: card.id, actorId: "user-1",
    note: "Reviewed", createdAt: ctx.clock.value,
  });
  assert.equal(accepted.status, "done");
  gate.resolve();
  assert.equal((await service.waitForIdle(dispatched.run.id)).status, "completed");
  assert.deepEqual(executor.canceled, [], "没有 UI subscriber 也不能取消后台执行");
  service.close();
  closeStores(ctx);
});

test("completed 缺少 Agent request-complete 时停在 waiting；人工完成只写审计不伪造 Run", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card));
  ctx.dispatcher.admit(run.id);
  ctx.dispatcher.transition(run.id, "running", {
    ...runtimePatch("thread-no-request", "turn-no-request"),
  });
  service.reconcileRun(run.id);
  ctx.dispatcher.transition(run.id, "completed", { resultSummary: "done" });
  service.reconcileRun(run.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "waiting");
  assert.equal(ctx.kanbanStore.getCard(card.id).completion, null);

  const manual = service.completeCardManually({
    operationId: "manual-complete-one",
    cardId: card.id,
    actorId: "user-1",
    note: "Accepted without claiming the run succeeded",
    createdAt: ctx.clock.value,
  });
  assert.equal(manual.status, "done");
  assert.equal(manual.completion.mode, "manual");
  assert.equal(ctx.kanbanStore.listAuditEvents(card.id).length, 1);
  assert.equal(ctx.productStore.getWorkRun(run.id).status, "completed");
  service.close();
  closeStores(ctx);
});

test("waiting 状态已有完成请求时，WorkRun 可直接完成并进入 review", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const dispatched = service.dispatchCard(dispatchInput(card));
  const runId = dispatched.run.id;
  ctx.dispatcher.admit(runId);
  ctx.dispatcher.transition(runId, "running", runtimePatch("thread-waiting-review", "turn-waiting-review"));
  service.reconcileRun(runId);
  service.requestCompletionFromAgent({
    operationId: "agent-request-from-waiting",
    cardId: card.id,
    runId,
    createdAt: ctx.clock.value,
  });
  ctx.kanbanStore.setCardStatus({
    operationId: "human-blocks-before-completion",
    cardId: card.id,
    status: "waiting",
    actor: "human",
    actorId: "user-1",
    createdAt: ctx.clock.value,
  });
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "waiting");
  ctx.dispatcher.transition(runId, "completed", { resultSummary: "approved" });
  service.reconcileRun(runId);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "review");
  service.close();
  closeStores(ctx);
});

test("failed/interrupted 与 canceled/skipped 映射准确，人工 done 不被终态覆盖", async () => {
  const mappings = [
    ["failed", "failed", { errorCode: "RUN_FAILED" }],
    ["interrupted", "failed", { errorCode: "SERVICE_RESTARTED" }],
    ["canceled", "canceled", {}],
    ["skipped", "canceled", {}],
  ];
  for (const [runStatus, cardStatus, patch] of mappings) {
    const ctx = openStores();
    const card = createCard(ctx, runStatus);
    const service = createService(ctx, new FakeExecutor());
    service.open();
    const { run } = service.dispatchCard(dispatchInput(card, runStatus));
    if (runStatus === "skipped") {
      ctx.dispatcher.transition(run.id, "skipped");
    } else {
      ctx.dispatcher.admit(run.id);
      ctx.dispatcher.transition(run.id, "running", {
        ...runtimePatch(`thread-${runStatus}`, `turn-${runStatus}`),
      });
      service.reconcileRun(run.id);
      ctx.dispatcher.transition(run.id, runStatus, patch);
    }
    service.reconcileRun(run.id);
    assert.equal(ctx.kanbanStore.getCard(card.id).status, cardStatus, runStatus);
    service.close();
    closeStores(ctx);
  }

  const ctx = openStores();
  const card = createCard(ctx, "manual-active");
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "manual-active"));
  service.completeCardManually({
    operationId: "manual-active-done", cardId: card.id, actorId: "user-1",
    note: null, createdAt: ctx.clock.value,
  });
  ctx.dispatcher.transition(run.id, "canceled");
  service.reconcileRun(run.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "done");
  assert.equal(ctx.kanbanStore.getCard(card.id).completion.mode, "manual");
  service.close();
  closeStores(ctx);
});

test("retry 创建新 WorkRun 并精确 retryOf，旧 link 与旧 Run 永不覆盖", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  service.open();
  const first = service.dispatchCard(dispatchInput(card)).run;
  ctx.dispatcher.admit(first.id);
  ctx.dispatcher.transition(first.id, "running", {
    ...runtimePatch("thread-first", "turn-first"),
  });
  ctx.dispatcher.transition(first.id, "failed", { errorCode: "FIRST_FAILED" });
  service.reconcileRun(first.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "failed");

  const retryInput = {
    operationId: "retry-one",
    cardId: card.id,
    retryOf: first.id,
    workspace: "/tmp/kanban-retry",
    createdAt: ctx.clock.value,
  };
  const retry = service.retryCard(retryInput).run;
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.retryOf, first.id);
  assert.equal(ctx.productStore.getWorkRun(first.id).status, "failed");
  const links = ctx.kanbanStore.listCardRunLinks(card.id);
  assert.equal(links.length, 2);
  assert.equal(links.find((link) => link.runId === first.id)?.retryOf, null);
  assert.equal(links.find((link) => link.runId === retry.id)?.retryOf, first.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "queued");
  service.reconcileRun(first.id);
  assert.equal(
    ctx.kanbanStore.getCard(card.id).status,
    "queued",
    "旧 Run 的迟到通知不能反向覆盖最新 retry 状态",
  );
  assert.equal(service.retryCard(retryInput).run.id, retry.id);
  await settle();
  assert.equal(executor.calls.filter((call) => call.runId === retry.id).length, 1);
  service.close();
  closeStores(ctx);
});

test("retry 按 Card profile 解析 workspace，resolver 失败时不创建 Run/Link 且 Card 不变", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "retry-resolver-failure");
  const managedWorkspace = path.join(ctx.paths.trustedRoot, "retry-managed-workspace");
  fs.mkdirSync(managedWorkspace);
  const executor = new FakeExecutor();
  const resolutions = [];
  let failResolution = false;
  const failure = codedError("WORKSPACE_RESOLUTION_FAILED");
  const service = createService(ctx, executor, {
    resolveWorkspace(profileId, requested) {
      resolutions.push({ profileId, requested });
      if (failResolution) throw failure;
      return requested === null ? managedWorkspace : requested;
    },
  });
  service.open();
  const first = service.dispatchCard(dispatchInput(card, "retry-resolver-failure")).run;
  await service.waitForIdle(first.id);
  ctx.dispatcher.admit(first.id);
  ctx.dispatcher.transition(first.id, "running", {
    ...runtimePatch("thread-retry-resolver", "turn-retry-resolver"),
  });
  ctx.dispatcher.transition(first.id, "failed", { errorCode: "RETRY_RESOLVER_FIXTURE" });
  service.reconcileRun(first.id);

  const beforeCard = ctx.kanbanStore.getCard(card.id);
  const beforeRunIds = ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id })
    .map((run) => run.id);
  const beforeLinks = ctx.kanbanStore.listCardRunLinks(card.id);
  const beforeExecutorCalls = executor.calls.length;
  failResolution = true;
  assert.throws(
    () => service.retryCard({
      operationId: "retry-resolver-failure",
      cardId: card.id,
      retryOf: first.id,
      workspace: null,
      createdAt: ctx.clock.value,
    }),
    (error) => error === failure,
  );
  assert.deepEqual(resolutions.at(-1), { profileId: card.profileId, requested: null });
  assert.deepEqual(
    ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).map((run) => run.id),
    beforeRunIds,
  );
  assert.deepEqual(ctx.kanbanStore.listCardRunLinks(card.id), beforeLinks);
  assert.deepEqual(ctx.kanbanStore.getCard(card.id), beforeCard);
  assert.equal(executor.calls.length, beforeExecutorCalls);

  failResolution = false;
  const retry = service.retryCard({
    operationId: "retry-resolver-failure",
    cardId: card.id,
    retryOf: first.id,
    workspace: null,
    createdAt: ctx.clock.value,
  }).run;
  assert.equal(retry.workspace, fs.realpathSync(managedWorkspace));
  await service.waitForIdle(retry.id);
  service.close();
  closeStores(ctx);
});

test("retry 时间戳早于 prior link 时在创建 WorkRun 前拒绝", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "retry-clock");
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const first = service.dispatchCard(dispatchInput(card, "retry-clock")).run;
  ctx.dispatcher.admit(first.id);
  ctx.dispatcher.transition(first.id, "running", {
    ...runtimePatch("thread-retry-clock", "turn-retry-clock"),
  });
  ctx.dispatcher.transition(first.id, "failed", { errorCode: "CLOCK_FAILED" });
  service.reconcileRun(first.id);

  assert.throws(
    () => service.retryCard({
      operationId: "retry-clock-old",
      cardId: card.id,
      retryOf: first.id,
      workspace: "/tmp/kanban-retry-clock",
      createdAt: 9_999,
    }),
    (error) => error.code === "KANBAN_RETRY_TIMESTAMP_INVALID",
  );
  assert.deepEqual(
    ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).map((run) => run.id),
    [first.id],
    "非法时间戳不能留下无 link 的 durable WorkRun",
  );
  service.close();
  closeStores(ctx);
});

test("dispatch 在 enqueue 前拒绝 future/expired/capacity 且不留下 orphan WorkRun", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const ctx = openStores({ clock: { value: 40 * DAY } });
  const card = createCard(ctx, "preflight-time");
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  service.open();
  for (const [operationId, createdAt, code] of [
    ["preflight-expired", 9 * DAY, "KANBAN_OPERATION_EXPIRED"],
    ["preflight-future", 40 * DAY + 5 * 60 * 1_000 + 1, "KANBAN_TIMESTAMP_INVALID"],
  ]) {
    assert.throws(
      () => service.dispatchCard({ operationId, cardId: card.id, workspace: null, createdAt }),
      (error) => error.code === code,
    );
    assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 0);
  }
  assert.equal(executor.calls.length, 0);
  service.close();
  closeStores(ctx);

  const operationCapacity = openStores({ kanbanCapacities: { operations: 2 } });
  const operationCard = createCard(operationCapacity, "preflight-operation-capacity");
  const operationService = createService(operationCapacity, new FakeExecutor());
  operationService.open();
  assert.throws(
    () => operationService.dispatchCard(dispatchInput(operationCard, "operation-capacity")),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  assert.equal(operationCapacity.dispatcher.listRuns({ source: "kanban" }).length, 0);
  operationService.close();
  closeStores(operationCapacity);

  const linkCapacity = openStores({ kanbanCapacities: { cardRunLinks: 1 } });
  const firstCard = createCard(linkCapacity, "preflight-link-capacity-first");
  const linkService = createService(linkCapacity, new FakeExecutor());
  linkService.open();
  const firstRun = linkService.dispatchCard(
    dispatchInput(firstCard, "preflight-link-capacity-first"),
  ).run;
  linkCapacity.dispatcher.admit(firstRun.id);
  linkCapacity.dispatcher.transition(firstRun.id, "running", {
    ...runtimePatch("thread-preflight-link-capacity", "turn-preflight-link-capacity"),
  });
  linkCapacity.dispatcher.transition(firstRun.id, "failed", { errorCode: "CAPACITY_FIXTURE" });
  linkService.reconcileRun(firstRun.id);
  assert.throws(
    () => linkService.retryCard({
      operationId: "retry-preflight-link-capacity",
      cardId: firstCard.id,
      retryOf: firstRun.id,
      workspace: null,
      createdAt: 10_000,
    }),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  assert.deepEqual(
    linkCapacity.dispatcher.listRuns({ source: "kanban", sourceId: firstCard.id })
      .map((run) => run.id),
    [firstRun.id],
  );
  const secondCard = createCard(linkCapacity, "preflight-link-capacity-second");
  assert.throws(
    () => linkService.dispatchCard(dispatchInput(secondCard, "preflight-link-capacity-second")),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  assert.equal(
    linkCapacity.dispatcher.listRuns({ source: "kanban", sourceId: secondCard.id }).length,
    0,
  );
  linkService.close();
  closeStores(linkCapacity);

  let injectUncertain = false;
  const uncertain = openStores({
    atomicWrite(target, value, options) {
      if (injectUncertain) {
        const error = new Error("injected preflight uncertainty");
        error.committedUncertain = true;
        throw error;
      }
      return atomicWritePrivateFile(target, value, options);
    },
  });
  const uncertainCard = createCard(uncertain, "preflight-commit-uncertain");
  const uncertainService = createService(uncertain, new FakeExecutor());
  uncertainService.open();
  uncertain.clock.value += 1;
  injectUncertain = true;
  assert.throws(
    () => uncertainService.dispatchCard({
      operationId: "dispatch-preflight-commit-uncertain",
      cardId: uncertainCard.id,
      workspace: null,
      createdAt: uncertain.clock.value,
    }),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN" && error.committedUncertain === true,
  );
  assert.equal(uncertain.dispatcher.listRuns({ source: "kanban" }).length, 0);
  uncertainService.close();
  closeStores(uncertain);
});

test("dispatch exact dry-run 在 64MiB UTF-8 边界前拒绝并保证零 orphan", async () => {
  const runId = "90000000-0000-4000-8000-000000000001";
  const linkOperationId = `ks-link-${crypto.createHash("sha256")
    .update(JSON.stringify(["link", runId])).digest("hex")}`;
  const inputFor = (ctx) => ({
    operationId: "capacity-exact-dispatch",
    cardId: ctx.targetCardId,
    workspace: null,
    createdAt: 10_000,
  });
  const proposedRunFor = (ctx) => ({
    id: runId,
    source: "kanban",
    sourceId: ctx.targetCardId,
    idempotencyKey: `shoggoth:kanban:v2:${"a".repeat(64)}:10000:${"b".repeat(64)}`,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: null,
    retryOf: null,
  });
  const linkInputFor = (ctx) => ({
    operationId: linkOperationId,
    cardId: ctx.targetCardId,
    runId,
    retryOf: null,
    createdAt: 10_000,
  });

  const probe = openCapacityStores(4_096, runId);
  const probePath = path.join(probe.paths.stateDir, "native-kanban.json");
  const beforeBytes = fs.statSync(probePath).size;
  const probeRun = proposedRunFor(probe);
  const probeLinkInput = linkInputFor(probe);
  const probePrepared = probe.kanbanStore.preflightCardRunLink(probeLinkInput, probeRun);
  probe.dispatcher.enqueue(probeRun);
  probe.kanbanStore.linkCardRun(probeLinkInput, probePrepared);
  const exactGrowthBytes = fs.statSync(probePath).size - beforeBytes;
  assert.ok(exactGrowthBytes > 0 && exactGrowthBytes < 4_096);
  probe.service.close();
  closeStores(probe);

  const exact = openCapacityStores(exactGrowthBytes, runId);
  const exactRun = proposedRunFor(exact);
  const exactLinkInput = linkInputFor(exact);
  const exactPrepared = exact.kanbanStore.preflightCardRunLink(exactLinkInput, exactRun);
  exact.dispatcher.enqueue(exactRun);
  exact.kanbanStore.linkCardRun(exactLinkInput, exactPrepared);
  assert.equal(fs.statSync(path.join(exact.paths.stateDir, "native-kanban.json")).size,
    MAX_NATIVE_KANBAN_STORE_BYTES);
  assert.equal(exact.dispatcher.listRuns({ source: "kanban" }).length, 1);
  assert.equal(exact.kanbanStore.listCardRunLinks(exact.targetCardId).length, 1);
  exact.service.close();
  closeStores(exact);

  const overflow = openCapacityStores(exactGrowthBytes - 1, runId);
  assert.throws(
    () => overflow.service.dispatchCard(inputFor(overflow)),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  assert.equal(overflow.dispatcher.listRuns({ source: "kanban" }).length, 0);
  assert.equal(overflow.kanbanStore.listCardRunLinks(overflow.targetCardId).length, 0);
  overflow.service.close();
  closeStores(overflow);
  await settle();
});

test("dispatch preflight 遇 matcher 重入后同 operation 重试只创建唯一 link 并执行一次", async () => {
  let kanbanStore;
  let armed = false;
  let targetCardId = null;
  const ctx = openStores({
    isSensitiveValue(value) {
      if (armed && value === "Card prepared-matcher-reentry") {
        armed = false;
        kanbanStore.updateCard({
          operationId: "matcher-reentrant-update",
          cardId: targetCardId,
          patch: { title: "Matcher update survives" },
          createdAt: 10_000,
        });
      }
      return false;
    },
  });
  kanbanStore = ctx.kanbanStore;
  const card = createCard(ctx, "prepared-matcher-reentry");
  targetCardId = card.id;
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  service.open();
  const input = dispatchInput(card, "prepared-matcher-reentry");
  armed = true;

  assert.throws(
    () => service.dispatchCard(input),
    (error) => error.code === "KANBAN_PREPARED_STALE",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 0);
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 0);
  assert.equal(ctx.kanbanStore.getCard(card.id).title, "Matcher update survives");
  assert.equal(executor.calls.length, 0);

  const recovered = service.dispatchCard(input);
  await service.waitForIdle(recovered.run.id);
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 1);
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 1);
  assert.equal(executor.calls.length, 1);
  service.close();
  closeStores(ctx);
});

test("dispatch intent 使用 canonical workspace 做同参 replay 与换参冲突并执行 30 天窗口", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const ctx = openStores();
  const card = createCard(ctx, "intent-idempotency");
  const otherCard = createCard(ctx, "intent-idempotency-other");
  const realWorkspace = path.join(ctx.paths.trustedRoot, "workspace-real");
  const aliasWorkspace = path.join(ctx.paths.trustedRoot, "workspace-alias");
  const otherWorkspace = path.join(ctx.paths.trustedRoot, "workspace-other");
  fs.mkdirSync(realWorkspace);
  fs.mkdirSync(otherWorkspace);
  fs.symlinkSync(realWorkspace, aliasWorkspace);
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const original = {
    operationId: "dispatch-intent",
    cardId: card.id,
    workspace: aliasWorkspace,
    createdAt: ctx.clock.value,
  };
  const first = service.dispatchCard(original);
  const replay = service.dispatchCard({ ...original, workspace: realWorkspace });
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.workspace, fs.realpathSync(realWorkspace));
  for (const changed of [
    { ...original, workspace: otherWorkspace },
    { ...original, createdAt: original.createdAt + 1 },
    { ...original, cardId: otherCard.id },
  ]) {
    assert.throws(
      () => service.dispatchCard(changed),
      (error) => error.code === "KANBAN_OPERATION_ID_CONFLICT",
    );
  }
  assert.throws(
    () => service.retryCard({
      operationId: original.operationId,
      cardId: card.id,
      retryOf: first.run.id,
      workspace: realWorkspace,
      createdAt: original.createdAt,
    }),
    (error) => error.code === "KANBAN_OPERATION_ID_CONFLICT",
  );
  ctx.clock.value += 31 * DAY;
  assert.throws(
    () => service.dispatchCard({ ...original, workspace: realWorkspace }),
    (error) => error.code === "KANBAN_OPERATION_EXPIRED",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 1);
  service.close();
  closeStores(ctx);
});

test("workspace:null 的 replay 固定首次默认目录，新 operation 才读取更新后的默认目录", () => {
  const ctx = openStores();
  const firstCard = createCard(ctx, "default-workspace-a");
  const secondCard = createCard(ctx, "default-workspace-b");
  const workspaceA = path.join(ctx.paths.trustedRoot, "default-workspace-a");
  const workspaceB = path.join(ctx.paths.trustedRoot, "default-workspace-b");
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  let currentDefault = workspaceA;
  let resolutions = 0;
  const service = createService(ctx, new FakeExecutor(), {
    resolveWorkspace(profileId, requested) {
      assert.equal(profileId, DEFAULT_AGENT_PROFILE_ID);
      resolutions += 1;
      return requested ?? currentDefault;
    },
  });
  service.open();
  const input = {
    operationId: "dispatch-default-workspace-replay",
    cardId: firstCard.id,
    workspace: null,
    createdAt: ctx.clock.value,
  };
  const first = service.dispatchCard(input);
  assert.equal(first.run.workspace, fs.realpathSync(workspaceA));
  assert.equal(resolutions, 1);

  currentDefault = workspaceB;
  const replay = service.dispatchCard(input);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.workspace, fs.realpathSync(workspaceA));
  assert.equal(resolutions, 1, "同 operation replay 不得重新解析可变默认目录");

  const next = service.dispatchCard({
    operationId: "dispatch-new-default-workspace",
    cardId: secondCard.id,
    workspace: null,
    createdAt: ctx.clock.value,
  });
  assert.equal(next.run.workspace, fs.realpathSync(workspaceB));
  assert.equal(resolutions, 2);
  service.close();
  closeStores(ctx);
});

test("dispatch workspace 解析错误固定脱敏且在 enqueue 前零 orphan", () => {
  const ctx = openStores();
  const card = createCard(ctx, "workspace-resolution-i3");
  const service = createService(ctx, new FakeExecutor());
  const registeredValue = "m0i3registeredvalue-5d91a4";
  service.open();
  let caught = null;
  try {
    service.dispatchCard({
      operationId: "dispatch-workspace-resolution-i3",
      cardId: card.id,
      workspace: path.join("/dev/null", registeredValue),
      createdAt: ctx.clock.value,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, "WORKSPACE_RESOLUTION_FAILED");
  assert.equal(caught.message, "无法解析 workspace");
  assert.equal(caught.cause, undefined);
  assert.equal(String(caught).includes(registeredValue), false);
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban" }).length, 0);
  service.close();
  closeStores(ctx);
});

test("open 在补链前拒绝与 WorkRun 绑定不匹配的 durable dispatch intent", () => {
  const ctx = openStores();
  const card = createCard(ctx, "durable-intent-tamper");
  ctx.dispatcher.enqueue({
    id: "11111111-1111-4111-8111-111111111111",
    source: "kanban",
    sourceId: card.id,
    idempotencyKey: `shoggoth:kanban:v2:${"a".repeat(64)}:10000:${"b".repeat(64)}`,
    profileId: card.profileId,
    workspace: "/tmp/durable-intent-tamper",
    retryOf: null,
  });
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  assert.throws(
    () => service.open(),
    (error) => error.code === "KANBAN_RUN_INTENT_INVALID",
  );
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 0);
  assert.equal(executor.calls.length, 0);
  closeStores(ctx);
});

test("同一 Service close/open 不会重复交付仍由 executor 持有的 Run", async () => {
  const gate = deferred();
  const ctx = openStores();
  const card = createCard(ctx, "reopen-inflight");
  const executor = new FakeExecutor({ gates: [gate] });
  const service = createService(ctx, executor);
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "reopen-inflight"));
  await settle();
  assert.equal(executor.calls.length, 1);
  service.close();
  service.open();
  await settle();
  assert.equal(executor.calls.length, 1);
  gate.resolve();
  await service.waitForIdle(run.id);
  service.close();
  closeStores(ctx);
});

test("executor 尚未取得 ownership 时 close/open 由新 generation 恰好接管一次", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "reopen-before-executor");
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "reopen-before-executor"));

  service.close();
  service.open();
  await settle();
  await settle();

  assert.equal(executor.calls.length, 1, "stale generation 必须释放尚未取得的 ownership");
  assert.equal(executor.calls[0].runId, run.id);
  assert.equal(executor.calls[0].recovered, true);
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  service.close();
  closeStores(ctx);
});

test("waitForIdle 跟随 close/open handoff 的新 tail 直到当前 ownership settle", async () => {
  const gate = deferred();
  const ctx = openStores();
  const card = createCard(ctx, "wait-handoff");
  const executor = new FakeExecutor({ gates: [gate] });
  const service = createService(ctx, executor);
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "wait-handoff"));
  service.close();
  service.open();

  let settled = false;
  const waiting = service.waitForIdle(run.id).then((value) => {
    settled = true;
    return value;
  });
  await settle();
  await settle();
  assert.equal(executor.calls.length, 1);
  assert.equal(service.runTails.size, 1);
  assert.equal(service.launchedRunIds.size, 1);
  assert.equal(settled, false, "旧 tail settle 不能让 waitForIdle 提前返回");

  gate.resolve();
  assert.equal((await waiting).id, run.id);
  assert.equal(service.runTails.size, 0);
  assert.equal(service.launchedRunIds.size, 0);
  service.close();
  closeStores(ctx);
});

test("close/open 后旧 executor 迟到失败由新 generation 有界重新接管", async () => {
  const gate = deferred();
  const ctx = openStores();
  const card = createCard(ctx, "reopen-late-failure");
  const executor = new FakeExecutor({ gates: [gate] });
  const service = createService(ctx, executor);
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "reopen-late-failure"));
  await settle();
  assert.equal(executor.calls.length, 1);

  service.close();
  service.open();
  await settle();
  assert.equal(executor.calls.length, 1, "旧 executor 未 settle 前不能重复交付");
  gate.reject(codedError("LATE_EXECUTOR_FAILURE"));
  await settle();
  await settle();

  assert.equal(executor.calls.length, 2, "迟到失败后新 generation 必须恰好接管一次");
  assert.equal(executor.calls[1].runId, run.id);
  assert.equal(executor.calls[1].recovered, true);
  assert.equal((await service.waitForIdle(run.id)).status, "queued");
  service.close();
  closeStores(ctx);
});

test("同一 Run eventSeq 下的人为 Card 偏移可被再次投影且 operationId 不冲突", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "reproject");
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "reproject"));
  ctx.dispatcher.admit(run.id);
  ctx.dispatcher.transition(run.id, "running", {
    ...runtimePatch("thread-reproject", "turn-reproject"),
  });
  service.reconcileRun(run.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "running");

  ctx.clock.value += 1;
  ctx.kanbanStore.setCardStatus({
    operationId: "human-reproject-waiting",
    cardId: card.id,
    status: "waiting",
    actor: "human",
    actorId: "user-1",
    createdAt: ctx.clock.value,
  });
  assert.equal(ctx.dispatcher.getRun(run.id).status, "running");
  assert.equal(service.reconcileRun(run.id).status, "running");
  service.close();
  closeStores(ctx);
});

test("queued WorkRun 可通过合法桥接收敛人工移动到 running 的 Card", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "queued-reproject");
  const service = createService(ctx, new FakeExecutor());
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "queued-reproject"));
  ctx.kanbanStore.setCardStatus({
    operationId: "human-queued-reproject-running",
    cardId: card.id,
    status: "running",
    actor: "human",
    actorId: "user-1",
    createdAt: ctx.clock.value,
  });
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(service.reconcileRun(run.id).status, "queued");
  service.close();
  closeStores(ctx);
});

test("WorkRun 已提交但 link 写失败的 crash cut 可在 open 时修复且启动幂等", async () => {
  const ctx = openStores({ clock: { value: 10_000 } });
  const card = createCard(ctx);
  const firstExecutor = new FakeExecutor();
  let failLink = true;
  const throwingKanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "linkCardRun") return (input, prepared) => {
        if (failLink) {
          failLink = false;
          throw codedError("INJECTED_LINK_FAILURE");
        }
        return target.linkCardRun(input, prepared);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const firstService = createService(ctx, firstExecutor, { kanbanStore: throwingKanbanStore });
  firstService.open();
  assert.throws(
    () => firstService.dispatchCard(dispatchInput(card)),
    (error) => error.code === "INJECTED_LINK_FAILURE",
  );
  const [durableRun] = ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id });
  assert.ok(durableRun);
  assert.equal(ctx.kanbanStore.getCardRunLinkByRunId(durableRun.id), null);
  assert.equal(firstExecutor.calls.length, 0);
  firstService.close();
  closeStores(ctx);

  ctx.clock.value += 31 * DAY_MS;
  const restartedCtx = openStores({ paths: ctx.paths, clock: ctx.clock });

  const recoveryExecutor = new FakeExecutor();
  const recovered = createService(restartedCtx, recoveryExecutor);
  recovered.open();
  await settle();
  const recoveredLink = restartedCtx.kanbanStore.getCardRunLinkByRunId(durableRun.id);
  assert.equal(recoveredLink.cardId, card.id);
  assert.equal(recoveredLink.createdAt, ctx.clock.value, "过期 crash intent 应使用当前可信时间补链");
  assert.equal(restartedCtx.kanbanStore.getCard(card.id).status, "queued");
  assert.equal(recoveryExecutor.calls.length, 1);
  assert.equal(recoveryExecutor.calls[0].recovered, true);
  assert.equal(recovered.open(), recovered);
  await settle();
  assert.equal(recoveryExecutor.calls.length, 1);
  recovered.close();
  closeStores(restartedCtx);
});

test("dispatch reservation 跨长空闲 crash 与时钟回拨仍可恢复 root orphan", async () => {
  const ctx = openStores({ clock: { value: 1_000 } });
  const card = createCard(ctx, "root-clock-reservation");
  let failLink = true;
  const throwingKanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "linkCardRun") return (input, prepared) => {
        if (failLink) {
          failLink = false;
          throw codedError("INJECTED_ROOT_LINK_FAILURE");
        }
        return target.linkCardRun(input, prepared);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const first = createService(ctx, new FakeExecutor(), { kanbanStore: throwingKanbanStore });
  first.open();
  ctx.clock.value = 10 * DAY_MS;
  assert.throws(
    () => first.dispatchCard({
      operationId: "dispatch-root-clock-reservation",
      cardId: card.id,
      workspace: "/tmp/kanban-root-clock-reservation",
      createdAt: ctx.clock.value,
    }),
    (error) => error.code === "INJECTED_ROOT_LINK_FAILURE",
  );
  const [orphan] = ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id });
  assert.ok(orphan);
  first.close();
  closeStores(ctx);

  ctx.clock.value = 1_000;
  const restartedCtx = openStores({ paths: ctx.paths, clock: ctx.clock });
  const executor = new FakeExecutor();
  const recovered = createService(restartedCtx, executor);
  recovered.open();
  await recovered.waitForIdle(orphan.id);
  assert.equal(restartedCtx.kanbanStore.getCardRunLinkByRunId(orphan.id).createdAt, 10 * DAY_MS);
  assert.equal(executor.calls.filter((call) => call.runId === orphan.id).length, 1);
  recovered.close();
  closeStores(restartedCtx);
});

test("首次 dispatch 补链失败后不同 operationId 不得创建第二个 root WorkRun", () => {
  const ctx = openStores();
  const card = createCard(ctx, "single-root-after-cut");
  let failLink = true;
  const throwingKanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "linkCardRun") return (input, prepared) => {
        if (failLink) {
          failLink = false;
          throw codedError("INJECTED_ROOT_LINK_FAILURE");
        }
        return target.linkCardRun(input, prepared);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = createService(ctx, new FakeExecutor(), { kanbanStore: throwingKanbanStore });
  service.open();
  assert.throws(
    () => service.dispatchCard(dispatchInput(card, "single-root-first")),
    (error) => error.code === "INJECTED_ROOT_LINK_FAILURE",
  );
  assert.throws(
    () => service.dispatchCard(dispatchInput(card, "single-root-second")),
    (error) => error.code === "KANBAN_CARD_NOT_DISPATCHABLE",
  );
  assert.equal(ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id }).length, 1);
  service.close();
  closeStores(ctx);
});

test("open 在补链和启动前拒绝同一 Card 的多个 root WorkRun", () => {
  const ctx = openStores();
  const card = createCard(ctx, "multiple-root-open");
  for (const [id, key] of [
    ["11111111-1111-4111-8111-111111111111", "root-one"],
    ["22222222-2222-4222-8222-222222222222", "root-two"],
  ]) {
    ctx.dispatcher.enqueue({
      id,
      source: "kanban",
      sourceId: card.id,
      idempotencyKey: key,
      profileId: card.profileId,
      workspace: `/tmp/${key}`,
      retryOf: null,
    });
  }
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  assert.throws(
    () => service.open(),
    (error) => error.code === "KANBAN_RUN_LINEAGE_INVALID",
  );
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 0);
  assert.equal(executor.calls.length, 0);
  closeStores(ctx);
});

test("retry link crash 后跨 Store 重启与大幅时钟回拨仍可按持久高水位恢复", async () => {
  const trustedHighWater = 40 * DAY_MS;
  const ctx = openStores({ clock: { value: trustedHighWater } });
  const card = createCard(ctx, "retry-link-clock-rollback");
  let failRetryLink = true;
  const throwingKanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "linkCardRun") return (input, prepared) => {
        if (input.retryOf !== null && failRetryLink) {
          failRetryLink = false;
          throw codedError("INJECTED_RETRY_LINK_FAILURE");
        }
        return target.linkCardRun(input, prepared);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const first = createService(ctx, new FakeExecutor(), { kanbanStore: throwingKanbanStore });
  first.open();
  const firstRun = first.dispatchCard({
    operationId: "dispatch-retry-link-clock-rollback",
    cardId: card.id,
    workspace: "/tmp/kanban-retry-link-clock-rollback",
    createdAt: ctx.clock.value,
  }).run;
  ctx.dispatcher.admit(firstRun.id);
  ctx.dispatcher.transition(firstRun.id, "running", {
    ...runtimePatch("thread-retry-link-clock-rollback", "turn-retry-link-clock-rollback"),
  });
  ctx.dispatcher.transition(firstRun.id, "failed", { errorCode: "FIRST_FAILED" });
  first.reconcileRun(firstRun.id);
  assert.throws(
    () => first.retryCard({
      operationId: "retry-link-clock-rollback",
      cardId: card.id,
      retryOf: firstRun.id,
      workspace: "/tmp/kanban-retry-link-clock-rollback",
      createdAt: ctx.clock.value,
    }),
    (error) => error.code === "INJECTED_RETRY_LINK_FAILURE",
  );
  const runs = ctx.dispatcher.listRuns({ source: "kanban", sourceId: card.id });
  const orphan = runs[1];
  assert.ok(orphan);
  assert.equal(ctx.kanbanStore.getCardRunLinkByRunId(orphan.id), null);
  first.close();
  closeStores(ctx);

  ctx.clock.value = 1_000;
  const restartedCtx = openStores({ paths: ctx.paths, clock: ctx.clock });
  const executor = new FakeExecutor();
  const recovered = createService(restartedCtx, executor);
  recovered.open();
  await recovered.waitForIdle(orphan.id);
  const link = restartedCtx.kanbanStore.getCardRunLinkByRunId(orphan.id);
  assert.equal(link.retryOf, firstRun.id);
  assert.equal(link.createdAt, trustedHighWater, "补链必须使用已持久化的安全单调时间");
  assert.equal(executor.calls.filter((call) => call.runId === orphan.id).length, 1);

  const rejectedFuture = trustedHighWater + (5 * 60 * 1_000) + 1;

  assert.throws(
    () => restartedCtx.kanbanStore.setCardStatus({
      operationId: "malicious-future-after-rollback",
      cardId: card.id,
      status: "canceled",
      actor: "human",
      actorId: "attacker",
      createdAt: rejectedFuture,
    }),
    (error) => error.code === "KANBAN_TIMESTAMP_INVALID",
    "任意 future input 不能抬高持久时钟门禁",
  );
  recovered.close();
  closeStores(restartedCtx);

  const secondRestart = openStores({ paths: ctx.paths, clock: ctx.clock });
  assert.throws(
    () => secondRestart.kanbanStore.setCardStatus({
      operationId: "malicious-future-after-second-restart",
      cardId: card.id,
      status: "canceled",
      actor: "human",
      actorId: "attacker",
      createdAt: rejectedFuture,
    }),
    (error) => error.code === "KANBAN_TIMESTAMP_INVALID",
    "可信高水位必须跨重启保持且不能由拒绝的 future input 改写",
  );
  closeStores(secondRestart);
});

test("Store 全重启从 durable Run/link 恢复，外部来源不参与 Kanban 调度", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  ctx.dispatcher.enqueue({
    id: "chat-run", source: "chat", sourceId: "chat-session",
    idempotencyKey: "chat-idem", profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: "/tmp/chat", retryOf: null,
  });
  const first = createService(ctx, new FakeExecutor());
  first.open();
  const run = first.dispatchCard(dispatchInput(card)).run;
  first.close();
  closeStores(ctx);

  const restartedCtx = openStores({ paths: ctx.paths, clock: ctx.clock });
  const executor = new FakeExecutor();
  const restarted = createService(restartedCtx, executor);
  restarted.open();
  await settle();
  assert.equal(restartedCtx.productStore.getWorkRun(run.id).status, "queued");
  assert.equal(restartedCtx.kanbanStore.getCardRunLinkByRunId(run.id).cardId, card.id);
  assert.deepEqual(executor.calls.map((call) => call.runId), [run.id]);
  restarted.close();
  closeStores(restartedCtx);
});

test("disabled Profile 的 queued Run 在 open recovery 收敛为 skipped 且不启动 Runtime", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "disabled-queued-recovery");
  const firstExecutor = new FakeExecutor();
  const first = createService(ctx, firstExecutor);
  first.open();
  const { run } = first.dispatchCard(dispatchInput(card, "disabled-queued-recovery"));
  first.close();
  await settle();
  assert.equal(firstExecutor.calls.length, 0);
  ctx.productStore.putAgentProfile({
    ...ctx.productStore.getAgentProfile(card.profileId),
    enabled: false,
  });

  const recoveryExecutor = new FakeExecutor();
  const recovered = createService(ctx, recoveryExecutor, {
    resolveTargetState(profileId) {
      const profile = ctx.productStore.getAgentProfile(profileId);
      if (!profile) throw codedError("PROFILE_MISSING");
      return profile.enabled ? "enabled" : "disabled";
    },
  });
  recovered.open();
  const settled = await recovered.waitForIdle(run.id);
  assert.equal(settled.status, "skipped");
  assert.equal(settled.resultSummary, "KANBAN_TARGET_DISABLED");
  assert.equal(settled.errorCode, null);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "canceled");
  assert.equal(recoveryExecutor.calls.length, 0);
  assert.equal(recovered.opened, true);
  assert.equal(recovered.poisonError, null);
  recovered.close();
  closeStores(ctx);
});

test("disabled Profile 的 active Run 保持 recover 语义，不被伪装成未启动 skip", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "disabled-active-recovery");
  const first = createService(ctx, new FakeExecutor());
  first.open();
  const { run } = first.dispatchCard(dispatchInput(card, "disabled-active-recovery"));
  await first.waitForIdle(run.id);
  ctx.dispatcher.admit(run.id);
  ctx.dispatcher.transition(run.id, "running", {
    ...runtimePatch("thread-disabled-active", "turn-disabled-active"),
  });
  first.reconcileRun(run.id);
  first.close();
  ctx.productStore.putAgentProfile({
    ...ctx.productStore.getAgentProfile(card.profileId),
    enabled: false,
  });

  const recoveryExecutor = new FakeExecutor();
  const recovered = createService(ctx, recoveryExecutor, {
    resolveTargetState(profileId) {
      const profile = ctx.productStore.getAgentProfile(profileId);
      if (!profile) throw codedError("PROFILE_MISSING");
      return profile.enabled ? "enabled" : "disabled";
    },
  });
  recovered.open();
  await recovered.waitForIdle(run.id);
  const active = ctx.dispatcher.getRun(run.id);
  assert.equal(active.status, "running");
  assert.equal(active.resultSummary, null);
  assert.equal(active.errorCode, null);
  assert.deepEqual(recoveryExecutor.calls.map((call) => ({
    kind: call.kind,
    runId: call.runId,
    recovered: call.recovered,
  })), [{ kind: "recover", runId: run.id, recovered: true }]);
  recovered.close();
  closeStores(ctx);
});

test("queued recovery 的 missing Profile target state 继续 fail closed", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "missing-target-recovery");
  const first = createService(ctx, new FakeExecutor());
  first.open();
  const { run } = first.dispatchCard(dispatchInput(card, "missing-target-recovery"));
  first.close();
  await settle();

  const executor = new FakeExecutor();
  const recovered = createService(ctx, executor, {
    resolveTargetState() { throw codedError("PROFILE_MISSING"); },
  });
  assert.throws(
    () => recovered.open(),
    (error) => error.code === "KANBAN_RUN_CORRUPT"
      && error.message === "Kanban AgentProfile target state 无效",
  );
  assert.equal(ctx.dispatcher.getRun(run.id).status, "queued");
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "queued");
  assert.equal(executor.calls.length, 0);
  assert.equal(recovered.opened, false);
  assert.equal(recovered.poisonError, null);
  closeStores(ctx);
});

test("durable Run 与 Card 的 Profile 绑定损坏仍在 recovery 前 fail closed", () => {
  const ctx = openStores();
  const card = createCard(ctx, "profile-binding-corrupt");
  const foreignProfile = createProfile(ctx, "foreign-binding");
  const workspace = path.join(fs.realpathSync("/tmp"), "kanban-profile-binding-corrupt");
  const operationHash = crypto.createHash("sha256").update("profile-binding-corrupt").digest("hex");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
    card.id, workspace, null, ctx.clock.value,
  ])).digest("hex");
  ctx.dispatcher.enqueue({
    id: "33333333-3333-4333-8333-333333333333",
    source: "kanban",
    sourceId: card.id,
    idempotencyKey: `shoggoth:kanban:v2:${operationHash}:${ctx.clock.value}:${fingerprint}`,
    profileId: foreignProfile.id,
    workspace,
    retryOf: null,
  });
  const executor = new FakeExecutor();
  const service = createService(ctx, executor);
  assert.throws(
    () => service.open(),
    (error) => error.code === "KANBAN_RUN_BINDING_INVALID",
  );
  assert.equal(ctx.kanbanStore.listCardRunLinks(card.id).length, 0);
  assert.equal(executor.calls.length, 0);
  closeStores(ctx);
});

test("executor 启动失败不回滚 durable queue，新 Service open 可重新接管", async () => {
  const ctx = openStores();
  const card = createCard(ctx);
  const failedExecutor = new FakeExecutor({ failures: ["EXECUTOR_UNAVAILABLE"] });
  const fatalSignals = [];
  const first = createService(ctx, failedExecutor, {
    onFatalError(error) { fatalSignals.push(error); },
  });
  first.open();
  const { run } = first.dispatchCard(dispatchInput(card));
  await assert.rejects(
    () => first.waitForIdle(run.id),
    (error) => error.code === "KANBAN_EXECUTOR_FAILED",
  );
  assert.equal(ctx.productStore.getWorkRun(run.id).status, "queued");
  assert.equal(ctx.kanbanStore.getCardRunLinkByRunId(run.id).cardId, card.id);
  assert.equal(ctx.kanbanStore.getCard(card.id).status, "queued");
  assert.equal(fatalSignals.length, 0, "普通 executor 失败不是 Service fatal");
  first.close();

  const recoveryExecutor = new FakeExecutor();
  const recovered = createService(ctx, recoveryExecutor);
  recovered.open();
  await recovered.waitForIdle(run.id);
  assert.equal(recoveryExecutor.calls.length, 1);
  assert.equal(recoveryExecutor.calls[0].recovered, true);
  recovered.close();
  closeStores(ctx);
});

test("background hostile fatal 只做一次 descriptor-safe 分类并固定脱敏 poison", async () => {
  const cases = [];

  const getterReads = { committedUncertain: 0, code: 0, message: 0, cause: 0 };
  const accessorError = {};
  for (const property of Object.keys(getterReads)) {
    Object.defineProperty(accessorError, property, {
      configurable: true,
      get() {
        getterReads[property] += 1;
        return property === "committedUncertain" ? true : `accessor-secret-${property}`;
      },
    });
  }
  cases.push({ name: "accessor", error: accessorError, assertSafe() {
    assert.deepEqual(getterReads, { committedUncertain: 0, code: 0, message: 0, cause: 0 });
  } });

  let descriptorReads = 0;
  let rawReads = 0;
  const proxyError = new Proxy({}, {
    getOwnPropertyDescriptor(_target, property) {
      if (property === "code") descriptorReads += 1;
      throw new Error("proxy-descriptor-secret");
    },
    get() {
      rawReads += 1;
      return "proxy-raw-secret";
    },
  });
  cases.push({ name: "proxy", error: proxyError, assertSafe() {
    assert.equal(descriptorReads, 1, "fatal kind 不得对同一 background error 重复分类");
    assert.equal(rawReads, 0, "分类与脱敏不得触发 Proxy raw getter");
  } });

  let deepPrototype = Object.create(null);
  Object.defineProperty(deepPrototype, "code", {
    value: "STORE_COMMIT_UNCERTAIN", configurable: true,
  });
  for (let depth = 0; depth < 20; depth += 1) deepPrototype = Object.create(deepPrototype);
  cases.push({ name: "overdeep", error: deepPrototype, assertSafe() {} });

  for (const [index, hostile] of cases.entries()) {
    const ctx = openStores();
    const card = createCard(ctx, `hostile-fatal-${index}`);
    const fatalSignals = [];
    let reentrantError = null;
    let service;
    const executor = {
      schedule() { return Promise.reject(hostile.error); },
      recover() { return this.schedule(); },
    };
    service = createService(ctx, executor, {
      onFatalError(error) {
        fatalSignals.push(error);
        try { service.reconcileRun("hostile-reentrant"); } catch (failure) {
          reentrantError = failure;
        }
        return Promise.reject(new Error("fatal-callback-secret"));
      },
    });
    service.open();
    const { run } = service.dispatchCard(dispatchInput(card, `hostile-fatal-${index}`));
    await assert.rejects(
      () => service.waitForIdle(run.id),
      (error) => error === fatalSignals[0]
        && error.code === "KANBAN_COMMIT_UNCERTAIN"
        && error.message === "Kanban 持久化状态不确定，必须重启 Service"
        && !Object.prototype.hasOwnProperty.call(error, "cause")
        && !String(error.stack).includes("secret"),
    );
    assert.equal(fatalSignals.length, 1, `${hostile.name} 只能发送一次 fatal signal`);
    assert.strictEqual(reentrantError, fatalSignals[0]);
    hostile.assertSafe();
    service.close();
    assert.throws(() => service.open(), (error) => error === fatalSignals[0]);
    assert.equal(fatalSignals.length, 1, `${hostile.name} sticky poison 不得重复 signal`);
    closeStores(ctx);
  }
});

test("background executor durable uncertainty 保留 canonical code 并仅发送一次脱敏 fatal signal", async () => {
  for (const [caseIndex, [sourceCode, expectedCode]] of [
    ["STORE_COMMIT_UNCERTAIN", "STORE_COMMIT_UNCERTAIN"],
    ["KANBAN_COMMIT_UNCERTAIN", "KANBAN_COMMIT_UNCERTAIN"],
    ["PENDING_COMMAND_COMMIT_UNCERTAIN", "PENDING_COMMAND_COMMIT_UNCERTAIN"],
    ["secret-in-code-COMMIT_UNCERTAIN", "KANBAN_COMMIT_UNCERTAIN"],
  ].entries()) {
    const ctx = openStores();
    const cards = [
      createCard(ctx, `fatal-executor-${caseIndex}-one`),
      createCard(ctx, `fatal-executor-${caseIndex}-two`),
    ];
    const secret = `fatal-executor-secret-${caseIndex}`;
    const executor = {
      schedule() {
        const error = codedError(sourceCode);
        error.message = secret;
        error.cause = new Error(secret);
        return Promise.reject(error);
      },
      recover() { return this.schedule(); },
    };
    const fatalSignals = [];
    const service = createService(ctx, executor, {
      onFatalError(error) {
        fatalSignals.push(error);
        if (sourceCode === "PENDING_COMMAND_COMMIT_UNCERTAIN") {
          return Promise.reject(new Error("fatal-callback-async-secret-must-not-escape"));
        }
        return undefined;
      },
    });
    service.open();
    const runs = cards.map((card, index) => service.dispatchCard(
      dispatchInput(card, `fatal-executor-${caseIndex}-${index}`),
    ).run);

    const results = await Promise.allSettled(runs.map((run) => service.waitForIdle(run.id)));
    assert.equal(results.every((result) => result.status === "rejected"), true);
    const [fatal] = fatalSignals;
    assert.equal(fatalSignals.length, 1, `${sourceCode} 同一 Service 只允许一次 fatal signal`);
    assert.equal(fatal.code, expectedCode);
    assert.equal(fatal.message, "Kanban 持久化状态不确定，必须重启 Service");
    assert.equal(Object.prototype.hasOwnProperty.call(fatal, "cause"), false);
    assert.equal(String(fatal.stack).includes(secret), false);
    assert.equal(results.every((result) => result.reason === fatal), true);

    for (const operation of [
      () => service.dispatchCard(dispatchInput(cards[0], `fatal-after-${caseIndex}`)),
      () => service.retryCard({
        operationId: `fatal-retry-${caseIndex}`,
        cardId: cards[0].id,
        retryOf: runs[0].id,
        workspace: null,
        createdAt: ctx.clock.value,
      }),
      () => service.reconcileRun(runs[0].id),
      () => service.requestCompletionFromAgent({
        operationId: `fatal-completion-${caseIndex}`,
        cardId: cards[0].id,
        runId: runs[0].id,
        createdAt: ctx.clock.value,
      }),
      () => service.completeCardManually({
        operationId: `fatal-manual-${caseIndex}`,
        cardId: cards[0].id,
        actorId: "user-1",
        note: null,
        createdAt: ctx.clock.value,
      }),
    ]) {
      assert.throws(operation, (error) => error === fatal);
    }

    service.close();
    assert.equal(service.runTails.size, 0);
    assert.equal(service.launchedRunIds.size, 0);
    assert.throws(() => service.open(), (error) => error === fatal);
    assert.equal(fatalSignals.length, 1, "close/open 不得重置 sticky poison 或重复信号");
    closeStores(ctx);
  }
});

test("background reconcile STORE_COMMIT_UNCERTAIN 在 callback 重入与抛错时仍保留主 fatal", async () => {
  const ctx = openStores();
  const card = createCard(ctx, "fatal-reconcile");
  const secret = "fatal-reconcile-secret-must-not-survive";
  let injectUncertain = false;
  const kanbanStore = new Proxy(ctx.kanbanStore, {
    get(target, property) {
      if (property === "setCardStatus") return (input) => {
        if (injectUncertain) {
          const error = codedError("STORE_COMMIT_UNCERTAIN");
          error.message = secret;
          error.cause = new Error(secret);
          throw error;
        }
        return target.setCardStatus(input);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const executor = {
    async schedule(payload) {
      ctx.dispatcher.admit(payload.run.id);
      ctx.dispatcher.transition(payload.run.id, "running", {
        ...runtimePatch("thread-fatal-reconcile", "turn-fatal-reconcile"),
      });
      injectUncertain = true;
      payload.onStateChange();
    },
    async recover(payload) { return this.schedule(payload); },
  };
  const fatalSignals = [];
  let reentrantError = null;
  let service;
  service = createService(ctx, executor, {
    onFatalError(error) {
      fatalSignals.push(error);
      try { service.reconcileRun("not-a-run"); } catch (reentrant) { reentrantError = reentrant; }
      throw new Error("fatal-callback-secret-must-not-escape");
    },
    kanbanStore,
  });
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "fatal-reconcile"));

  await assert.rejects(
    () => service.waitForIdle(run.id),
    (error) => error === fatalSignals[0]
      && error.code === "STORE_COMMIT_UNCERTAIN"
      && error.message === "Kanban 持久化状态不确定，必须重启 Service"
      && !String(error.stack).includes(secret),
  );
  assert.equal(fatalSignals.length, 1);
  assert.strictEqual(reentrantError, fatalSignals[0]);
  assert.equal(service.runTails.size, 0);
  assert.equal(service.launchedRunIds.size, 0);
  service.close();
  closeStores(ctx);
});

test("旧 generation 迟到 durable uncertainty 会 poison 当前 Service 且绝不 handoff 重启", async () => {
  const gate = deferred();
  const ctx = openStores();
  const card = createCard(ctx, "fatal-late-generation");
  const executor = new FakeExecutor({ gates: [gate] });
  const fatalSignals = [];
  const service = createService(ctx, executor, {
    onFatalError(error) { fatalSignals.push(error); },
  });
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "fatal-late-generation"));
  await settle();
  assert.equal(executor.calls.length, 1);

  service.close();
  service.open();
  gate.reject(codedError("STORE_COMMIT_UNCERTAIN"));
  await settle();
  await settle();

  assert.equal(executor.calls.length, 1, "durable uncertainty 后不得重启旧 WorkRun");
  assert.equal(fatalSignals.length, 1);
  await assert.rejects(() => service.waitForIdle(run.id), (error) => error === fatalSignals[0]);
  service.close();
  assert.throws(() => service.open(), (error) => error === fatalSignals[0]);
  closeStores(ctx);
});

test("旧 executor 普通失败后 handoff 遇 durable uncertainty 不得被先前的泛化错误覆盖", async () => {
  const gate = deferred();
  const ctx = openStores();
  const card = createCard(ctx, "fatal-late-handoff");
  let failHandoff = false;
  const dispatcher = {
    enqueue: (input) => ctx.dispatcher.enqueue(input),
    enqueueSkipped: (...args) => ctx.dispatcher.enqueueSkipped(...args),
    listRuns: (query) => ctx.dispatcher.listRuns(query),
    transition: (...args) => ctx.dispatcher.transition(...args),
    getRun(id) {
      if (failHandoff) {
        const error = codedError("STORE_COMMIT_UNCERTAIN");
        error.message = "fatal-late-handoff-secret";
        throw error;
      }
      return ctx.dispatcher.getRun(id);
    },
  };
  const executor = new FakeExecutor({ gates: [gate] });
  const fatalSignals = [];
  const service = createService(ctx, executor, {
    dispatcher,
    onFatalError(error) { fatalSignals.push(error); },
  });
  service.open();
  const { run } = service.dispatchCard(dispatchInput(card, "fatal-late-handoff"));
  await settle();

  service.close();
  service.open();
  failHandoff = true;
  gate.reject(codedError("ORDINARY_LATE_EXECUTOR_FAILURE"));
  await settle();
  await settle();

  assert.equal(executor.calls.length, 1);
  assert.equal(fatalSignals.length, 1);
  assert.equal(fatalSignals[0].code, "STORE_COMMIT_UNCERTAIN");
  assert.equal(String(fatalSignals[0].stack).includes("fatal-late-handoff-secret"), false);
  await assert.rejects(() => service.waitForIdle(run.id), (error) => error === fatalSignals[0]);
  assert.equal(service.runErrors.has(run.id), false, "fatal 不得污染普通 runErrors");
  service.close();
  closeStores(ctx);
});

test("executor 成功 settle 后清理 run tail 与 ownership", async () => {
  const ctx = openStores();
  const executor = {
    async schedule(payload) {
      ctx.dispatcher.transition(payload.run.id, "canceled");
      payload.onStateChange();
    },
    async recover(payload) {
      ctx.dispatcher.transition(payload.run.id, "canceled");
      payload.onStateChange();
    },
  };
  const service = createService(ctx, executor);
  service.open();
  const runIds = [];
  for (let index = 0; index < 4; index += 1) {
    const suffix = `settled-cleanup-${index}`;
    const card = createCard(ctx, suffix);
    runIds.push(service.dispatchCard(dispatchInput(card, suffix)).run.id);
  }
  await Promise.allSettled([...service.runTails.values()]);
  assert.equal(runIds.every((runId) => ctx.dispatcher.getRun(runId).status === "canceled"), true);
  assert.equal(service.runTails.size, 0);
  assert.equal(service.launchedRunIds.size, 0);
  service.close();
  closeStores(ctx);
});

test("executor 原始错误不保留且失败记录有界并在 close 清空", async () => {
  const ctx = openStores();
  const secret = "executor-secret-must-not-survive";
  const executor = new FakeExecutor({ failures: Array(66).fill(secret) });
  const service = createService(ctx, executor);
  service.open();
  for (let index = 0; index < 66; index += 1) {
    const suffix = `bounded-error-${index}`;
    const card = createCard(ctx, suffix);
    service.dispatchCard(dispatchInput(card, suffix));
  }
  const results = await Promise.allSettled([...service.runTails.values()]);
  assert.equal(results.every((result) => result.status === "rejected"
    && result.reason?.code === "KANBAN_EXECUTOR_FAILED"
    && !String(result.reason?.message).includes(secret)), true);
  assert.equal(service.runTails.size, 0);
  assert.equal(service.launchedRunIds.size, 0);
  assert.ok(service.runErrors.size <= 64);
  assert.equal([...service.runErrors.values()].some(
    (error) => String(error?.message).includes(secret) || error?.code === secret,
  ), false);
  service.close();
  assert.equal(service.runErrors.size, 0);
  closeStores(ctx);
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
    for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`RESULT ${tests.length - failed}/${tests.length} pass`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
