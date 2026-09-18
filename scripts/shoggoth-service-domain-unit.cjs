#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(
  ROOT, "app", "agent-service", "paths.js",
));
const { requestService, readClientToken } = require(path.join(
  ROOT, "app", "agent-service", "client.js",
));
const { createAgentService, PROTOCOL_VERSION } = require(path.join(
  ROOT, "app", "agent-service", "server.js",
));
const {
  DOMAIN_SERVICE_METHODS,
  MAX_FRAME_BYTES,
} = require(path.join(ROOT, "app", "agent-service", "domain-service-protocol.js"));
const { NativeDomainServiceController } = require(path.join(
  ROOT, "app", "agent-service", "native-domain-service-controller.js",
));
const { DEFAULT_AGENT_PROFILE_ID } = require(path.join(
  ROOT, "app", "agent-service", "product-store.js",
));

const tests = [];
let completed = 0;
function test(name, fn) { tests.push({ name, fn }); }

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";
const AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const LINK_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const RUN_ID = "run-1";
const PRIOR_RUN_ID = "run-prior";
const SHA_BODY = crypto.createHash("sha256").update("body").digest("hex");

function contentMeta() {
  return { byteLength: 4, sha256: SHA_BODY, preview: "body" };
}

function board(overrides = {}) {
  return {
    id: BOARD_ID, profileId: PROFILE_ID, slug: "main-board", name: "Main",
    description: null, createdAt: 100, updatedAt: 100, ...overrides,
  };
}

function card(overrides = {}) {
  return {
    id: CARD_ID, boardId: BOARD_ID, profileId: PROFILE_ID, title: "Ship IPC",
    bodyMeta: contentMeta(), status: "backlog", position: 0,
    archivedAt: null, completionRequest: null, completion: null, createdAt: 101, updatedAt: 101,
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    id: COMMENT_ID, cardId: CARD_ID, authorType: "human", authorId: "user-1",
    bodyMeta: contentMeta(), createdAt: 102, ...overrides,
  };
}

function attachment() {
  return {
    id: ATTACHMENT_ID, cardId: CARD_ID, name: "report.txt", mimeType: "text/plain",
    sizeBytes: 4, sha256: SHA_BODY, storageKey: "attachments/report.txt", createdAt: 103,
  };
}

function artifact() {
  return {
    id: ARTIFACT_ID, cardId: CARD_ID, runId: RUN_ID, name: "result.txt", kind: "file",
    mimeType: "text/plain", sizeBytes: 4, sha256: SHA_BODY,
    storageKey: "artifacts/result.txt", createdAt: 104,
  };
}

function auditEvent() {
  return {
    id: AUDIT_ID, cardId: CARD_ID, kind: "manual_completion", actorId: "user-1",
    runId: null, note: null, createdAt: 105,
  };
}

function cardRunLink(overrides = {}) {
  return {
    id: LINK_ID, cardId: CARD_ID, runId: RUN_ID, retryOf: null, createdAt: 106,
    ...overrides,
  };
}

function workRun(overrides = {}) {
  return {
    id: RUN_ID, source: "kanban", sourceId: CARD_ID, idempotencyKey: "dispatch-key",
    profileId: PROFILE_ID, workspace: null, status: "queued", codexThreadId: null,
    codexTurnId: null, eventSeq: 1, waitingRequestId: null, startedAt: null,
    finishedAt: null, resultSummary: null, errorCode: null, retryOf: null,
    ...overrides,
  };
}

function cronJob(overrides = {}) {
  return {
    id: JOB_ID, name: "Nightly", enabled: false, profileId: PROFILE_ID,
    promptMeta: contentMeta(), workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    threadPolicy: "new", threadId: null, nextRunAt: null,
    createdAt: 100, updatedAt: 100, ...overrides,
  };
}

const chunk = Object.freeze({
  text: "body", offsetBytes: 0, totalBytes: 4, sha256: SHA_BODY,
  nextCursor: null, hasMore: false,
});

const VALID_PARAMS = new Map([
  ["kanban.board.list", { profileId: PROFILE_ID, cursor: null, limit: 25 }],
  ["kanban.board.get", { boardId: BOARD_ID }],
  ["kanban.board.create", {
    operationId: "op-board-create", profileId: PROFILE_ID, slug: "main-board",
    name: "Main", description: null, createdAt: 100,
  }],
  ["kanban.board.update", {
    operationId: "op-board-update", boardId: BOARD_ID,
    patch: { description: "updated" }, createdAt: 101,
  }],
  ["kanban.card.list", { boardId: BOARD_ID, status: null, cursor: null, limit: 25 }],
  ["kanban.card.get", { cardId: CARD_ID }],
  ["kanban.card.body.read", { cardId: CARD_ID, cursor: null, maxBytes: 32_768 }],
  ["kanban.card.create", {
    operationId: "op-card-create", boardId: BOARD_ID, profileId: PROFILE_ID,
    title: "Ship", body: "body", status: "backlog", position: 0, createdAt: 102,
  }],
  ["kanban.card.update", {
    operationId: "op-card-update", cardId: CARD_ID,
    patch: { title: "Ship safely", body: null, position: 1 }, createdAt: 103,
  }],
  ["kanban.card.status.set", {
    operationId: "op-card-status", cardId: CARD_ID, status: "queued", createdAt: 104,
  }],
  ["kanban.card.archived.set", {
    operationId: "op-card-archive", cardId: CARD_ID, archived: true, createdAt: 104,
  }],
  ["kanban.card.complete.manual", {
    operationId: "op-card-manual", cardId: CARD_ID, note: null, createdAt: 105,
  }],
  ["kanban.comment.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.comment.body.read", { commentId: COMMENT_ID, cursor: null, maxBytes: 4 }],
  ["kanban.comment.add", {
    operationId: "op-comment-add", cardId: CARD_ID, body: "hello", createdAt: 106,
  }],
  ["kanban.attachment.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.artifact.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.audit.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.run.list", { cardId: CARD_ID, status: null, cursor: null, limit: 25 }],
  ["kanban.run.dispatch", {
    operationId: "op-dispatch", cardId: CARD_ID, workspace: null, createdAt: 107,
  }],
  ["kanban.run.retry", {
    operationId: "op-retry", cardId: CARD_ID, retryOf: PRIOR_RUN_ID,
    workspace: "/tmp/project", createdAt: 108,
  }],
  ["cron.job.list", { profileId: PROFILE_ID, enabled: null, cursor: null, limit: 25 }],
  ["cron.job.get", { jobId: JOB_ID }],
  ["cron.job.prompt.read", { jobId: JOB_ID, cursor: null, maxBytes: 4_096 }],
  ["cron.job.create", {
    operationId: "op-job-create", name: "Nightly", enabled: true, profileId: PROFILE_ID,
    prompt: "Run checks", workspace: null,
    schedule: { kind: "cron", expr: "0 0 * * *", tz: "Asia/Shanghai" },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    threadPolicy: "new", threadId: null, createdAt: 109,
  }],
  ["cron.job.update", {
    operationId: "op-job-update", jobId: JOB_ID,
    patch: { prompt: "Run all checks", schedule: { kind: "at", at: 20_000 } },
    createdAt: 110,
  }],
  ["cron.job.delete", { operationId: "op-job-delete", jobId: JOB_ID, createdAt: 111 }],
  ["cron.job.enabled.set", {
    operationId: "op-job-enabled", jobId: JOB_ID, enabled: false, createdAt: 112,
  }],
  ["cron.run.list", { jobId: JOB_ID, status: null, cursor: null, limit: 25 }],
  ["cron.run.trigger", { operationId: "op-trigger", jobId: JOB_ID, createdAt: 113 }],
  ["cron.run.retry", {
    operationId: "op-cron-retry", jobId: JOB_ID, retryOf: PRIOR_RUN_ID, createdAt: 114,
  }],
]);

const VALID_RESULTS = new Map([
  ["kanban.board.list", { boards: [board()], nextCursor: null, hasMore: false }],
  ["kanban.board.get", { board: board() }],
  ["kanban.board.create", { board: board() }],
  ["kanban.board.update", { board: board({ updatedAt: 101 }) }],
  ["kanban.card.list", { cards: [card()], nextCursor: null, hasMore: false }],
  ["kanban.card.get", { card: card() }],
  ["kanban.card.body.read", chunk],
  ["kanban.card.create", { card: card() }],
  ["kanban.card.update", { card: card({ updatedAt: 103 }) }],
  ["kanban.card.status.set", { card: card({ status: "queued", updatedAt: 104 }) }],
  ["kanban.card.archived.set", { card: card({ archivedAt: 104, updatedAt: 104 }) }],
  ["kanban.card.complete.manual", {
    card: card({
      status: "done", updatedAt: 105,
      completion: { mode: "manual", runId: null, actorId: "user-1", at: 105, note: null },
    }),
    audit: auditEvent(),
  }],
  ["kanban.comment.list", { comments: [comment()], nextCursor: null, hasMore: false }],
  ["kanban.comment.body.read", chunk],
  ["kanban.comment.add", { comment: comment() }],
  ["kanban.attachment.list", { attachments: [attachment()], nextCursor: null, hasMore: false }],
  ["kanban.artifact.list", { artifacts: [artifact()], nextCursor: null, hasMore: false }],
  ["kanban.audit.list", { auditEvents: [auditEvent()], nextCursor: null, hasMore: false }],
  ["kanban.run.list", { runs: [workRun()], nextCursor: null, hasMore: false }],
  ["kanban.run.dispatch", {
    run: workRun(), card: card({ status: "queued" }), link: cardRunLink(),
  }],
  ["kanban.run.retry", {
    run: workRun({ retryOf: PRIOR_RUN_ID }), card: card({ status: "queued" }),
    link: cardRunLink({ retryOf: PRIOR_RUN_ID }),
  }],
  ["cron.job.list", { jobs: [cronJob()], nextCursor: null, hasMore: false }],
  ["cron.job.get", { job: cronJob() }],
  ["cron.job.prompt.read", chunk],
  ["cron.job.create", { job: cronJob() }],
  ["cron.job.update", { job: cronJob({ updatedAt: 110 }) }],
  ["cron.job.delete", { jobId: JOB_ID, deleted: true }],
  ["cron.job.enabled.set", { job: cronJob({ updatedAt: 112 }) }],
  ["cron.run.list", {
    runs: [{
      run: workRun({ source: "cron", sourceId: JOB_ID }),
      kind: "schedule", createdAt: 113,
    }],
    nextCursor: null, hasMore: false,
  }],
  ["cron.run.trigger", { run: workRun({ source: "cron", sourceId: JOB_ID }) }],
  ["cron.run.retry", {
    run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: PRIOR_RUN_ID }),
  }],
]);

function safeStorageFixture() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8"),
  };
}

function newPaths(prefix = "sg-domain-service-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  return { root, paths };
}

async function ipc(paths, method, params, id = `domain-${method}`) {
  return requestService(paths, {
    id, token: readClientToken(paths), version: PROTOCOL_VERSION, method, params,
  });
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待条件超时");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ServiceDomainHost {
  constructor() {
    this.threads = [];
    this.listeners = new Set();
    this.turnStartCalls = 0;
    this.lastThreadStartParams = null;
    this.lastTurnStartParams = null;
    this.terminated = new Promise(() => {});
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerServerRequestHandler() { return () => {}; }

  async accountRead() {
    return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
  }

  async threadList(params) {
    return {
      data: this.threads.filter((thread) => (thread.archived === true) === params.archived)
        .map(structuredClone),
      nextCursor: null,
    };
  }

  async threadStart(params) {
    this.lastThreadStartParams = structuredClone(params);
    const thread = {
      id: "service-domain-thread",
      threadSource: params.threadSource,
      archived: false,
      turns: [],
    };
    this.threads.push(thread);
    return { thread: structuredClone(thread) };
  }

  async threadResume(params) {
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { code: "THREAD_NOT_FOUND" });
    return { thread: structuredClone(thread) };
  }

  async threadRead(params) {
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw Object.assign(new Error("thread not found"), { code: "THREAD_NOT_FOUND" });
    return { thread: structuredClone(thread) };
  }

  async turnStart(params) {
    this.turnStartCalls += 1;
    this.lastTurnStartParams = structuredClone(params);
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    assert.ok(thread);
    const turn = {
      id: "service-domain-turn",
      status: "inProgress",
      itemsView: "full",
      items: [{ type: "userMessage", id: "service-user", clientId: params.clientUserMessageId }],
    };
    thread.turns.push(turn);
    return { turn: structuredClone(turn) };
  }

  complete(text) {
    const thread = this.threads[0];
    const turn = thread.turns[0];
    turn.status = "completed";
    turn.items.push({ type: "agentMessage", phase: "final_answer", delivery: "sync", text });
    for (const listener of this.listeners) listener({
      known: true,
      type: "complete",
      method: "turn/completed",
      threadId: thread.id,
      turnId: turn.id,
      status: "completed",
    });
  }
}

async function createDurableDomainRun(service, paths, domain, suffix, createdAt) {
  if (domain === "kanban") {
    const { board: createdBoard } = await ipc(paths, "kanban.board.create", {
      operationId: `${suffix}-board-create`,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      slug: `${suffix}-board`,
      name: `${suffix} board`,
      description: null,
      createdAt,
    });
    const { card: createdCard } = await ipc(paths, "kanban.card.create", {
      operationId: `${suffix}-card-create`,
      boardId: createdBoard.id,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      title: `${suffix} card`,
      body: "body",
      status: "backlog",
      position: 0,
      createdAt,
    });
    return (await ipc(paths, "kanban.run.dispatch", {
      operationId: `${suffix}-dispatch`,
      cardId: createdCard.id,
      workspace: null,
      createdAt,
    })).run;
  }
  const { job } = await ipc(paths, "cron.job.create", {
    operationId: `${suffix}-job-create`,
    name: `${suffix} job`,
    enabled: false,
    profileId: DEFAULT_AGENT_PROFILE_ID,
    prompt: "Run recovery fixture",
    workspace: null,
    schedule: { kind: "at", at: createdAt + 60_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    createdAt,
  });
  return (await ipc(paths, "cron.run.trigger", {
    operationId: `${suffix}-trigger`, jobId: job.id, createdAt,
  })).run;
}

test("Service 默认构造、暴露并按 start generation 重建 NativeDomainServiceController", async () => {
  const { root, paths } = newPaths();
  const service = createAgentService({ paths, version: "domain-default" });
  assert.equal(service.nativeDomainServiceController instanceof NativeDomainServiceController, true);
  const beforeStart = service.nativeDomainServiceController;
  try {
    await service.start();
    assert.strictEqual(service.nativeDomainServiceController, beforeStart);
    const status = await ipc(paths, "service.status", {});
    assert.deepEqual(status.domainAvailability, {
      kanban: { available: true, reason: null },
      cron: { available: true, reason: null },
    });
    const firstBoards = await ipc(paths, "kanban.board.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 25,
    });
    assert.equal(firstBoards.boards.length, 1);
    assert.equal(firstBoards.boards[0].slug, "default");
    const defaultBoardId = firstBoards.boards[0].id;
    const availability = service.getDomainAvailability();
    assert.equal(Object.isFrozen(availability), true);
    assert.equal(Object.isFrozen(availability.kanban), true);
    await service.stop({ notify: false });
    await service.start();
    assert.notStrictEqual(service.nativeDomainServiceController, beforeStart);
    const restartedBoards = await ipc(paths, "kanban.board.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 25,
    });
    assert.deepEqual(restartedBoards.boards.map((board) => board.id), [defaultBoardId]);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实 Service 空 workspace Cron 使用托管目录并通过权威 DTO 完成", async () => {
  const { root, paths } = newPaths("sg-cron-workspace-");
  const createdAt = 15_000;
  const host = new ServiceDomainHost();
  const service = createAgentService({
    paths,
    version: "domain-cron-workspace",
    safeStorage: safeStorageFixture(),
    now: () => createdAt,
    runtimePool: {
      async get() { return host; },
      async stopAll() {},
    },
  });
  try {
    await service.start();
    const { job } = await ipc(paths, "cron.job.create", {
      operationId: "managed-workspace-job",
      name: "Managed workspace job",
      enabled: false,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      prompt: "Complete from managed workspace",
      workspace: null,
      schedule: { kind: "at", at: createdAt + 60_000 },
      misfirePolicy: "latest",
      maxCatchUp: 1,
      overlapPolicy: "skip",
      threadPolicy: "new",
      threadId: null,
      createdAt,
    });
    const { run } = await ipc(paths, "cron.run.trigger", {
      operationId: "managed-workspace-trigger",
      jobId: job.id,
      createdAt,
    });
    await waitFor(() => service.workDispatcher.getRun(run.id)?.status === "running");
    const managedWorkspace = fs.realpathSync(path.join(
      paths.defaultWorkspaceDir,
      DEFAULT_AGENT_PROFILE_ID,
    ));
    const running = service.workDispatcher.getRun(run.id);
    assert.equal(running.workspace, managedWorkspace);
    assert.equal(host.lastThreadStartParams.cwd, managedWorkspace);
    assert.equal(host.lastTurnStartParams.cwd, managedWorkspace);
    assert.equal(host.turnStartCalls, 1);

    host.complete("managed workspace completed");
    await waitFor(() => service.workDispatcher.getRun(run.id)?.status === "completed");
    const page = await ipc(paths, "cron.run.list", {
      jobId: job.id, status: null, cursor: null, limit: 25,
    });
    assert.equal(page.runs.length, 1);
    assert.equal(page.runs[0].run.status, "completed");
    assert.equal(page.runs[0].run.resultSummary, "managed workspace completed");
    assert.equal(page.runs[0].run.codexThreadId, "service-domain-thread");
    assert.equal(page.runs[0].run.codexTurnId, "service-domain-turn");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧默认 Controller 的挂起 mutation 跨 stop/restart 迟到 fatal 不得终止新 generation", async () => {
  const { root, paths } = newPaths("sg-domain-old-controller-");
  const gate = deferred();
  const runtimeFaults = [];
  const service = createAgentService({
    paths,
    version: "domain-old-controller",
    safeStorage: safeStorageFixture(),
    onDomainRuntimeError(domain, error, cleanupError) {
      runtimeFaults.push({ domain, error, cleanupError });
    },
  });
  service.nativeKanbanStore.createBoard = () => gate.promise;
  try {
    const beforeStart = service.nativeDomainServiceController;
    await service.start();
    assert.strictEqual(service.nativeDomainServiceController, beforeStart);
    const pending = beforeStart.handle(
      "kanban.board.create", VALID_PARAMS.get("kanban.board.create"),
    );
    await Promise.resolve();
    await service.stop({ notify: false });
    await service.start();
    assert.notStrictEqual(service.nativeDomainServiceController, beforeStart);

    const lateFatal = Object.assign(new Error("old-controller-private-canary"), {
      code: "KANBAN_COMMIT_UNCERTAIN", committedUncertain: true,
    });
    gate.reject(lateFatal);
    await assert.rejects(
      pending,
      (error) => error.code === "KANBAN_COMMIT_UNCERTAIN"
        && !error.message.includes("old-controller-private-canary"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtimeFaults.length, 0, "旧 Controller callback 不属于当前 generation");
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.deepEqual(service.getDomainAvailability().kanban, { available: true, reason: null });
    assert.equal((await ipc(paths, "service.status", {})).healthy, true);
  } finally {
    gate.resolve();
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实 Socket 对 31 个 exact domain method 统一校验、分派并复核 result", async () => {
  assert.deepEqual([...VALID_PARAMS.keys()], [...DOMAIN_SERVICE_METHODS]);
  assert.deepEqual([...VALID_RESULTS.keys()], [...DOMAIN_SERVICE_METHODS]);
  const { root, paths } = newPaths();
  const calls = [];
  const controller = {
    async handle(...args) {
      const [method, params] = args;
      calls.push({ method, params: structuredClone(params), argc: args.length });
      return structuredClone(VALID_RESULTS.get(method));
    },
  };
  const service = createAgentService({
    paths, version: "domain-dispatch", safeStorage: safeStorageFixture(),
    nativeDomainServiceController: controller,
  });
  try {
    await service.start();
    assert.strictEqual(service.nativeDomainServiceController, controller);
    for (const [method, params] of VALID_PARAMS) {
      assert.deepEqual(await ipc(paths, method, params), VALID_RESULTS.get(method), method);
    }
    assert.deepEqual(calls.map((call) => call.method), [...DOMAIN_SERVICE_METHODS]);
    assert.equal(calls.every((call) => call.argc === 2), true);
    assert.deepEqual(calls.map((call) => call.params), [...VALID_PARAMS.values()]);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("domain IPC 在 Controller 前拒绝坏 envelope/params/token/version/64KiB，并只公开错误映射", async () => {
  const { root, paths } = newPaths();
  let calls = 0;
  let mode = "ok";
  const rawCanary = "private-domain-error-canary";
  const controller = {
    async handle(method) {
      calls += 1;
      if (mode === "error") {
        const error = new Error(rawCanary);
        error.code = "KANBAN_BOARD_NOT_FOUND";
        throw error;
      }
      if (mode === "bad-result") return { board: { rawCanary } };
      return structuredClone(VALID_RESULTS.get(method));
    },
  };
  const service = createAgentService({
    paths, version: "domain-errors", safeStorage: safeStorageFixture(),
    nativeDomainServiceController: controller,
  });
  try {
    await service.start();
    const token = readClientToken(paths);
    const base = {
      id: "bad-envelope", token, version: PROTOCOL_VERSION,
      method: "kanban.board.get", params: VALID_PARAMS.get("kanban.board.get"),
    };
    for (const request of [
      { ...base, extra: true },
      { ...base, params: { ...base.params, extra: true } },
      { ...base, token: "wrong" },
      { ...base, version: PROTOCOL_VERSION + 1 },
    ]) {
      await assert.rejects(requestService(paths, request), (error) => [
        "INVALID_PARAMS", "AUTH_FAILED", "PROTOCOL_VERSION_MISMATCH",
      ].includes(error.code));
    }
    assert.equal(calls, 0);

    const frameRequest = {
      id: "domain-frame-budget", token, version: PROTOCOL_VERSION,
      method: "kanban.card.create",
      params: { ...VALID_PARAMS.get("kanban.card.create"), body: "" },
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(frameRequest), "utf8");
    frameRequest.params.body = "x".repeat(MAX_FRAME_BYTES - baseBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(frameRequest), "utf8"), MAX_FRAME_BYTES);
    await assert.rejects(
      requestService(paths, frameRequest),
      (error) => error.code === "REQUEST_TOO_LARGE",
    );
    assert.equal(calls, 0);

    mode = "error";
    await assert.rejects(
      ipc(paths, "kanban.board.get", VALID_PARAMS.get("kanban.board.get")),
      (error) => error.code === "KANBAN_BOARD_NOT_FOUND"
        && error.message === "Board 不存在" && !error.message.includes(rawCanary),
    );
    mode = "bad-result";
    await assert.rejects(
      ipc(paths, "kanban.board.get", VALID_PARAMS.get("kanban.board.get")),
      (error) => error.code === "DOMAIN_RESPONSE_INVALID"
        && !error.message.includes(rawCanary),
    );
    mode = "ok";
    await assert.rejects(
      ipc(paths, "kanban.board.future", {}),
      (error) => error.code === "UNKNOWN_METHOD",
    );
    assert.equal(calls, 2);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function createTwoBoardsAndCursor(service, paths, prefix) {
  for (let index = 0; index < 2; index += 1) {
    await ipc(paths, "kanban.board.create", {
      operationId: `${prefix}-create-${index}`,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      slug: `${prefix}-${index}`,
      name: `Board ${index}`,
      description: null,
      createdAt: Date.now(),
    });
  }
  const first = await ipc(paths, "kanban.board.list", {
    profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 2,
  });
  assert.equal(first.boards.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  return first.nextCursor;
}

test("domain cursor 默认跨 generation 失效，显式 domainCursorSecret 跨代稳定", async () => {
  const rotatingFixture = newPaths("sg-domain-cursor-rotate-");
  const rotating = createAgentService({ paths: rotatingFixture.paths, version: "domain-cursor" });
  let staleCursor;
  try {
    await rotating.start();
    staleCursor = await createTwoBoardsAndCursor(
      rotating, rotatingFixture.paths, "rotating-board",
    );
    const oldController = rotating.nativeDomainServiceController;
    await rotating.stop({ notify: false });
    await rotating.start();
    assert.notStrictEqual(rotating.nativeDomainServiceController, oldController);
    await assert.rejects(
      ipc(rotatingFixture.paths, "kanban.board.list", {
        profileId: DEFAULT_AGENT_PROFILE_ID, cursor: staleCursor, limit: 2,
      }),
      (error) => error.code === "INVALID_PARAMS",
    );
  } finally {
    await rotating.stop({ notify: false }).catch(() => {});
    fs.rmSync(rotatingFixture.root, { recursive: true, force: true });
  }

  const stableFixture = newPaths("sg-domain-cursor-stable-");
  const stable = createAgentService({
    paths: stableFixture.paths,
    version: "domain-cursor",
    domainCursorSecret: Buffer.alloc(32, 0x4d),
  });
  try {
    await stable.start();
    const cursor = await createTwoBoardsAndCursor(stable, stableFixture.paths, "stable-board");
    await stable.stop({ notify: false });
    await stable.start();
    const continued = await ipc(stableFixture.paths, "kanban.board.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor, limit: 2,
    });
    assert.equal(continued.boards.length, 1);
    assert.equal(continued.hasMore, false);
  } finally {
    await stable.stop({ notify: false }).catch(() => {});
    fs.rmSync(stableFixture.root, { recursive: true, force: true });
  }
});

function methods(target, names, implementation = () => null) {
  for (const name of names) target[name] = implementation;
  return target;
}

test("真实 Service 重启由 Kanban/Cron owner 各 recover active run 恰好一次", async () => {
  for (const domain of ["kanban", "cron"]) {
    const { root, paths } = newPaths(`sg-own-${domain[0]}-`);
    const createdAt = 10_000;
    const firstGate = deferred();
    let firstDispatcher = null;
    const firstCalls = [];
    const first = createAgentService({
      paths,
      version: `domain-owner-recover-${domain}`,
      safeStorage: safeStorageFixture(),
      now: () => createdAt,
      onWorkDispatcherReady(dispatcher) { firstDispatcher = dispatcher; },
      domainWorkRunExecutor: {
        schedule(payload) {
          firstCalls.push({ method: "schedule", runId: payload.run.id });
          firstDispatcher.admit(payload.run.id);
          return firstGate.promise;
        },
        recover(payload) {
          firstCalls.push({ method: "recover", runId: payload.run.id });
          return firstGate.promise;
        },
      },
    });
    let second = null;
    try {
      await first.start();
      const run = await createDurableDomainRun(
        first, paths, domain, `owner-recover-${domain}`, createdAt,
      );
      await waitFor(() => firstCalls.length === 1);
      const before = firstDispatcher.getRun(run.id);
      assert.equal(before.status, "starting");
      await first.stop({ notify: false });

      let secondDispatcher = null;
      const secondCalls = [];
      second = createAgentService({
        paths,
        version: `domain-owner-recover-${domain}`,
        safeStorage: safeStorageFixture(),
        now: () => createdAt + 1,
        onWorkDispatcherReady(dispatcher) { secondDispatcher = dispatcher; },
        domainWorkRunExecutor: {
          schedule(payload) {
            secondCalls.push({ method: "schedule", runId: payload.run.id });
            return Promise.resolve();
          },
          recover(payload) {
            secondCalls.push({ method: "recover", runId: payload.run.id });
            return Promise.resolve();
          },
        },
      });
      await second.start();
      await waitFor(() => secondCalls.length === 1);
      assert.deepEqual(secondCalls, [{ method: "recover", runId: run.id }]);
      const after = secondDispatcher.getRun(run.id);
      assert.equal(after.status, "starting", `${domain} active run 不得被通用恢复抢占`);
      assert.equal(after.eventSeq, before.eventSeq, `${domain} owner recover 不得重复 durable turn`);
      assert.equal(after.errorCode, null);
    } finally {
      firstGate.resolve();
      await second?.stop({ notify: false }).catch(() => {});
      await first.stop({ notify: false }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Kanban/Cron startup background uncertainty 拒绝本代且绝不发布 Socket", async () => {
  for (const domain of ["kanban", "cron"]) {
    const { root, paths } = newPaths(`sg-fatal-${domain[0]}-`);
    const createdAt = 20_000;
    const firstGate = deferred();
    const first = createAgentService({
      paths,
      version: `domain-startup-fatal-${domain}`,
      safeStorage: safeStorageFixture(),
      now: () => createdAt,
      domainWorkRunExecutor: {
        schedule() { return firstGate.promise; },
        recover() { return firstGate.promise; },
      },
    });
    let second = null;
    try {
      await first.start();
      const run = await createDurableDomainRun(
        first, paths, domain, `startup-fatal-${domain}`, createdAt,
      );
      assert.equal(first.workDispatcher.getRun(run.id).status, "queued");
      await first.stop({ notify: false });

      const runtimeFaults = [];
      let cleanupStopAllCalls = 0;
      const rawFatal = Object.assign(new Error(`startup-${domain}-private-canary`), {
        code: "STORE_COMMIT_UNCERTAIN",
        committedUncertain: true,
        cause: new Error(`startup-${domain}-cause-canary`),
      });
      second = createAgentService({
        paths,
        version: `domain-startup-fatal-${domain}`,
        safeStorage: safeStorageFixture(),
        now: () => createdAt + 1,
        domainWorkRunExecutor: {
          schedule() { return Promise.reject(rawFatal); },
          recover() { return Promise.reject(rawFatal); },
        },
        runtimePool: domain === "cron" ? {
          get() { throw new Error("runtime-get-not-used"); },
          async stopAll() {
            cleanupStopAllCalls += 1;
            throw new Error("startup-cleanup-private-canary");
          },
        } : undefined,
        onRuntimeError(error, cleanupError) {
          runtimeFaults.push({ error, cleanupError });
          throw new Error("runtime-callback-must-not-replace-startup-fatal");
        },
      });
      let startError = null;
      try { await second.start(); } catch (error) { startError = error; }
      const expected = domain === "kanban"
        ? ["STORE_COMMIT_UNCERTAIN", "Kanban 持久化状态不确定，必须重启 Service"]
        : ["CRON_COMMIT_UNCERTAIN", "Cron 持久化状态不确定，必须重启 Service"];
      assert.equal(startError?.code, expected[0]);
      assert.equal(startError?.message, expected[1]);
      assert.equal(Object.prototype.hasOwnProperty.call(startError, "cause"), false);
      assert.equal(String(startError?.stack).includes("private-canary"), false);
      assert.equal(cleanupStopAllCalls, domain === "cron" ? 1 : 0);
      assert.equal(runtimeFaults.length, 0, "startup fatal 不走已发布 generation reporter");
      assert.deepEqual(second.getDomainAvailability()[domain], {
        available: false, reason: "runtime_fatal",
      });
      assert.equal(fs.existsSync(paths.socketPath), false);
      assert.equal(fs.existsSync(paths.lockPath), false);
    } finally {
      firstGate.resolve();
      await second?.stop({ notify: false }).catch(() => {});
      await first.stop({ notify: false }).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startup domain health 只按有界 data code 降级 locked，其余固定脱敏 fail-start", async () => {
  for (const domain of ["kanban", "cron"]) {
    const upper = domain.toUpperCase();
    const lockedCode = `${upper}_SENSITIVE_CHECK_FAILED`;
    const unavailableCode = `${upper}_UNAVAILABLE`;
    const unavailableMessage = domain === "kanban"
      ? "Kanban Service 暂时不可用" : "Cron Service 暂时不可用";
    const cases = [];

    let accessorHits = 0;
    const accessorError = {};
    Object.defineProperty(accessorError, "code", {
      configurable: true,
      get() { accessorHits += 1; return lockedCode; },
    });
    cases.push({
      name: "accessor", error: accessorError, cleanupFailure: true,
      expectedCode: unavailableCode, expectedMessage: unavailableMessage,
      assertSafe() { assert.equal(accessorHits, 0); },
    });

    let proxyRawHits = 0;
    const proxyError = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error(`${domain}-descriptor-canary`); },
      get() { proxyRawHits += 1; return lockedCode; },
    });
    cases.push({
      name: "proxy", error: proxyError,
      expectedCode: unavailableCode, expectedMessage: unavailableMessage,
      assertSafe() { assert.equal(proxyRawHits, 0); },
    });

    let deepError = Object.create(null);
    Object.defineProperty(deepError, "code", { value: lockedCode, configurable: true });
    for (let depth = 0; depth < 20; depth += 1) deepError = Object.create(deepError);
    cases.push({
      name: "overdeep", error: deepError,
      expectedCode: unavailableCode, expectedMessage: unavailableMessage,
      assertSafe() {},
    });

    for (const kind of ["commit", "corrupt"]) {
      const code = kind === "commit"
        ? `${upper}_COMMIT_UNCERTAIN` : `${upper}_STORE_CORRUPT`;
      const message = kind === "commit"
        ? `${domain === "kanban" ? "Kanban" : "Cron"} 持久化状态不确定，必须重启 Service`
        : `${domain === "kanban" ? "Kanban" : "Cron"} 持久化存储损坏，必须重启 Service`;
      const prototype = Object.create(Error.prototype);
      Object.defineProperty(prototype, "code", { value: code, configurable: true });
      const fatal = Object.create(prototype);
      Object.defineProperty(fatal, "message", {
        value: `${domain}-${kind}-health-raw-canary`, configurable: true,
      });
      cases.push({
        name: kind, error: fatal, expectedCode: code, expectedMessage: message, assertSafe() {},
      });
    }

    for (const scenario of cases) {
      const { root, paths } = newPaths(`sg-h-${domain[0]}-${scenario.name[0]}-`);
      let closeCalls = 0;
      const failingStore = domain === "kanban" ? {
        async open() { throw scenario.error; },
        listBoards() { return []; },
        async close() {
          closeCalls += 1;
          if (scenario.cleanupFailure) throw new Error(`${domain}-cleanup-health-canary`);
        },
      } : {
        async open() { throw scenario.error; },
        listJobs() { return []; },
        async close() {
          closeCalls += 1;
          if (scenario.cleanupFailure) throw new Error(`${domain}-cleanup-health-canary`);
        },
      };
      const healthyKanban = {
        async open() {}, listBoards() { return []; }, async close() {},
      };
      const healthyCron = {
        async open() {}, listJobs() { return []; }, async close() {},
      };
      const inert = { async open() {}, async close() {}, poisonError: null };
      const service = createAgentService({
        paths,
        version: `domain-health-${domain}-${scenario.name}`,
        safeStorage: safeStorageFixture(),
        nativeKanbanStore: domain === "kanban" ? failingStore : healthyKanban,
        nativeCronStore: domain === "cron" ? failingStore : healthyCron,
        kanbanRunService: inert,
        nativeCronScheduler: inert,
        domainWorkRunExecutor: { schedule() {}, recover() {} },
        nativeDomainServiceController: { handle() { throw new Error("not used"); } },
      });
      let startError = null;
      try {
        try { await service.start(); } catch (error) { startError = error; }
        scenario.assertSafe();
        assert.equal(startError?.code, scenario.expectedCode, `${domain}/${scenario.name}`);
        assert.equal(startError?.message, scenario.expectedMessage, `${domain}/${scenario.name}`);
        assert.equal(String(startError?.stack).includes("canary"), false);
        assert.equal(fs.existsSync(paths.socketPath), false);
        assert.equal(fs.existsSync(paths.lockPath), false);
        assert.equal(closeCalls >= 1, true);
      } finally {
        await service.stop({ notify: false }).catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    for (const location of ["own", "prototype"]) {
      const { root, paths } = newPaths(`sg-l-${domain[0]}-${location[0]}-`);
      const locked = location === "own"
        ? Object.assign(new Error("locked-health-canary"), { code: lockedCode })
        : Object.create(Object.defineProperty(Object.create(Error.prototype), "code", {
          value: lockedCode, configurable: true,
        }));
      const failingStore = domain === "kanban" ? {
        async open() { throw locked; }, listBoards() { return []; }, async close() {},
      } : {
        async open() { throw locked; }, listJobs() { return []; }, async close() {},
      };
      const service = createAgentService({
        paths,
        version: `domain-health-locked-${domain}-${location}`,
        safeStorage: safeStorageFixture(),
        nativeKanbanStore: domain === "kanban" ? failingStore : {
          async open() {}, listBoards() { return []; }, async close() {},
        },
        nativeCronStore: domain === "cron" ? failingStore : {
          async open() {}, listJobs() { return []; }, async close() {},
        },
        kanbanRunService: { async open() {}, async close() {}, poisonError: null },
        nativeCronScheduler: { async open() {}, async close() {}, poisonError: null },
        domainWorkRunExecutor: { schedule() {}, recover() {} },
        nativeDomainServiceController: { handle() { throw new Error("not used"); } },
      });
      try {
        await service.start();
        assert.deepEqual(service.getDomainAvailability()[domain], {
          available: false, reason: "sensitive_check_unavailable",
        });
        assert.equal(fs.existsSync(paths.socketPath), true);
      } finally {
        await service.stop({ notify: false }).catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("locked domain availability gate 在 Controller 内零触碰 Store/Service/Dispatcher", async () => {
  const { root, paths } = newPaths("sg-domain-locked-gate-");
  let touches = 0;
  const locked = Object.assign(new Error("locked matcher canary"), {
    code: "KANBAN_SENSITIVE_CHECK_FAILED",
  });
  const kanbanStore = methods({
    async open() { throw locked; }, async close() {},
  }, [
    "listBoards", "getBoard", "createBoard", "updateBoard", "listCards", "getCard",
    "createCard", "updateCard", "setCardStatus", "setCardArchived", "listComments", "getComment",
    "addComment", "listAttachments", "listArtifacts", "listAuditEvents",
    "listCardRunLinks", "getCardRunLinkByRunId",
  ], () => { touches += 1; throw new Error("locked domain touched"); });
  const cronStore = methods({
    async open() {}, async close() {}, listJobs() { return []; },
  }, ["getJob", "createJob", "updateJobDerived", "deleteJob", "setJobEnabledDerived"]);
  const kanbanRunService = methods({ async open() {}, async close() {} }, [
    "dispatchCard", "retryCard", "completeCardManually",
  ], () => { touches += 1; throw new Error("locked service touched"); });
  const cronScheduler = methods({ async open() {}, async close() {} }, [
    "tick", "triggerJob", "retryRun",
  ]);
  const service = createAgentService({
    paths,
    version: "domain-locked-gate",
    nativeKanbanStore: kanbanStore,
    kanbanRunService,
    nativeCronStore: cronStore,
    nativeCronScheduler: cronScheduler,
    domainWorkRunExecutor: { schedule() {}, recover() {} },
  });
  try {
    await service.start();
    const availability = service.getDomainAvailability();
    assert.deepEqual(availability.kanban, {
      available: false, reason: "sensitive_check_unavailable",
    });
    await assert.rejects(
      ipc(paths, "kanban.board.list", VALID_PARAMS.get("kanban.board.list")),
      (error) => error.code === "KANBAN_UNAVAILABLE",
    );
    assert.equal(touches, 0);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("真实 Socket 先返回 commit-uncertain 公共错误，再单次隔离故障领域", async () => {
  const { root, paths } = newPaths("sg-domain-fatal-response-");
  const fatal = Object.assign(new Error("private commit canary"), {
    code: "KANBAN_COMMIT_UNCERTAIN",
    committedUncertain: true,
  });
  const kanbanStore = methods({
    async open() {}, async close() {}, listBoards() { return []; },
    getBoard() { throw fatal; },
  }, [
    "createBoard", "updateBoard", "listCards", "getCard", "createCard", "updateCard",
    "setCardStatus", "setCardArchived", "listComments", "getComment", "addComment", "listAttachments",
    "listArtifacts", "listAuditEvents", "listCardRunLinks", "getCardRunLinkByRunId",
  ]);
  const cronStore = methods({
    async open() {}, async close() {}, listJobs() { return []; },
  }, ["getJob", "createJob", "updateJobDerived", "deleteJob", "setJobEnabledDerived"]);
  const kanbanRunService = methods({ async open() {}, async close() {}, poisonError: null }, [
    "dispatchCard", "retryCard", "completeCardManually",
  ]);
  const cronScheduler = methods({ async open() {}, async close() {}, poisonError: null }, [
    "tick", "triggerJob", "retryRun",
  ]);
  const runtimeFaults = [];
  const service = createAgentService({
    paths,
    version: "domain-fatal-response",
    nativeKanbanStore: kanbanStore,
    kanbanRunService,
    nativeCronStore: cronStore,
    nativeCronScheduler: cronScheduler,
    domainWorkRunExecutor: { schedule() {}, recover() {} },
    onDomainRuntimeError(domain, error, cleanupError) {
      runtimeFaults.push({ domain, error, cleanupError });
    },
  });
  try {
    await service.start();
    await assert.rejects(
      ipc(paths, "kanban.board.get", VALID_PARAMS.get("kanban.board.get")),
      (error) => error.code === "KANBAN_COMMIT_UNCERTAIN"
        && error.message === "Kanban 提交结果不确定，请刷新后确认",
    );
    await waitFor(() => runtimeFaults.length === 1
      && service.getDomainAvailability().kanban.reason === "runtime_fatal");
    assert.equal(runtimeFaults.length, 1);
    assert.equal(runtimeFaults[0].domain, "kanban");
    assert.equal(runtimeFaults[0].error.code, "KANBAN_COMMIT_UNCERTAIN");
    assert.equal(runtimeFaults[0].cleanupError, null);
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.deepEqual(service.getDomainAvailability(), {
      kanban: { available: false, reason: "runtime_fatal" },
      cron: { available: true, reason: null },
    });
    assert.equal((await ipc(paths, "service.status", {})).healthy, true);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      completed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  console.log("BOUNDARY offline/fake: domain controller dispatch 使用本地 fake；cursor/locked 使用真实 Unix socket 与本地 Store，未联网/模型");
  console.log("[shoggoth-service-domain-unit] PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

process.on("beforeExit", () => {
  if (completed !== tests.length) {
    console.error(`FAIL domain Service 测试提前退出: ${completed}/${tests.length}`);
    process.exitCode = 1;
  }
});
