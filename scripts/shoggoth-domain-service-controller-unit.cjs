#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  MAX_FRAME_BYTES,
  MAX_PAGE_LIMIT,
  validateDomainServiceResult,
} = require(path.join(ROOT, "app", "agent-service", "domain-service-protocol.js"));
const {
  NativeDomainServiceController,
  TRUSTED_LOCAL_ACTOR_ID,
} = require(path.join(ROOT, "app", "agent-service", "native-domain-service-controller.js"));
const {
  computeNextOccurrence,
} = require(path.join(ROOT, "app", "agent-service", "native-cron-store.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE_ID = "11111111-1111-4111-8111-222222222222";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";
const AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const LINK_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_JOB_ID = "99999999-9999-4999-8999-888888888888";
const RUN_ID = "run-current";
const PRIOR_RUN_ID = "run-prior";
const CURSOR_SECRET = Buffer.alloc(32, 23);

function clone(value) { return structuredClone(value); }

function board(overrides = {}) {
  return {
    id: BOARD_ID,
    profileId: PROFILE_ID,
    slug: "main-board",
    name: "Main",
    description: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function card(overrides = {}) {
  return {
    id: CARD_ID,
    boardId: BOARD_ID,
    profileId: PROFILE_ID,
    title: "Ship controller",
    body: "A😀BC",
    status: "backlog",
    position: 0,
    archivedAt: null,
    completionRequest: null,
    completion: null,
    createdAt: 101,
    updatedAt: 101,
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    id: COMMENT_ID,
    cardId: CARD_ID,
    authorType: "human",
    authorId: TRUSTED_LOCAL_ACTOR_ID,
    body: "comment body",
    createdAt: 102,
    ...overrides,
  };
}

function attachment(overrides = {}) {
  return {
    id: ATTACHMENT_ID,
    cardId: CARD_ID,
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: crypto.createHash("sha256").update("body").digest("hex"),
    storageKey: "attachments/report.txt",
    createdAt: 103,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    cardId: CARD_ID,
    runId: RUN_ID,
    name: "result.txt",
    kind: "file",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: crypto.createHash("sha256").update("body").digest("hex"),
    storageKey: "artifacts/result.txt",
    createdAt: 104,
    ...overrides,
  };
}

function audit(overrides = {}) {
  return {
    id: AUDIT_ID,
    cardId: CARD_ID,
    kind: "manual_completion",
    actorId: TRUSTED_LOCAL_ACTOR_ID,
    runId: null,
    note: "manual note",
    createdAt: 220,
    ...overrides,
  };
}

function link(overrides = {}) {
  return {
    id: LINK_ID,
    cardId: CARD_ID,
    runId: RUN_ID,
    retryOf: null,
    createdAt: 210,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: RUN_ID,
    source: "kanban",
    sourceId: CARD_ID,
    idempotencyKey: "kanban-intent",
    profileId: PROFILE_ID,
    workspace: null,
    status: "queued",
    codexThreadId: null,
    codexTurnId: null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
    ...overrides,
  };
}

function cronJob(overrides = {}) {
  return {
    id: JOB_ID,
    name: "Nightly",
    enabled: true,
    profileId: PROFILE_ID,
    prompt: "Run checks",
    workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: 1_000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function exactReplay(map, kind, input, create) {
  const serialized = JSON.stringify([kind, input]);
  const existing = map.get(input.operationId);
  if (existing) {
    if (existing.serialized !== serialized) {
      const error = new Error("secret operation conflict");
      error.code = kind.startsWith("cron")
        ? "CRON_OPERATION_ID_CONFLICT" : "KANBAN_OPERATION_ID_CONFLICT";
      throw error;
    }
    return clone(existing.result);
  }
  const result = create();
  map.set(input.operationId, { serialized, result: clone(result) });
  return clone(result);
}

function makeFixture(options = {}) {
  const calls = [];
  const operations = new Map();
  const state = {
    boards: (options.boards || [board()]).map(clone),
    cards: (options.cards || [card()]).map(clone),
    comments: (options.comments || [comment()]).map(clone),
    attachments: (options.attachments || [attachment()]).map(clone),
    artifacts: (options.artifacts || [artifact()]).map(clone),
    audits: (options.audits || []).map(clone),
    links: (options.links || [link()]).map(clone),
    jobs: (options.jobs || [cronJob()]).map(clone),
    runs: (options.runs || [run(), run({
      id: PRIOR_RUN_ID,
      status: "failed",
      finishedAt: 180,
      errorCode: "FAILED",
    }), run({
      id: "cron-run",
      source: "cron",
      sourceId: JOB_ID,
      idempotencyKey: "private-cron-intent",
      status: "failed",
      finishedAt: 200,
      errorCode: "FAILED",
    })]).map(clone),
  };
  let availability = options.availability || {
    kanban: { available: true, reason: null },
    cron: { available: true, reason: null },
  };
  const find = (items, id) => items.find((item) => item.id === id) || null;
  const record = (name, input) => calls.push({ name, input: clone(input) });

  const kanbanStore = {
    listBoards() { record("kanban.listBoards", null); return clone(state.boards); },
    getBoard(id) { record("kanban.getBoard", id); return clone(find(state.boards, id)); },
    createBoard(input) {
      record("kanban.createBoard", input);
      return exactReplay(operations, "kanban.createBoard", input, () => {
        const value = board({
          id: BOARD_ID,
          profileId: input.profileId,
          slug: input.slug,
          name: input.name,
          description: input.description,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        state.boards.push(value);
        return value;
      });
    },
    updateBoard(input) {
      record("kanban.updateBoard", input);
      return exactReplay(operations, "kanban.updateBoard", input, () => {
        const current = find(state.boards, input.boardId);
        const value = { ...current, ...input.patch, updatedAt: Math.max(current.updatedAt, input.createdAt) };
        state.boards[state.boards.indexOf(current)] = value;
        return value;
      });
    },
    listCards(query = {}) {
      record("kanban.listCards", query);
      return clone(state.cards.filter((value) => query.boardId === undefined || value.boardId === query.boardId));
    },
    getCard(id) { record("kanban.getCard", id); return clone(find(state.cards, id)); },
    createCard(input) {
      record("kanban.createCard", input);
      return exactReplay(operations, "kanban.createCard", input, () => {
        const value = card({ ...input, id: CARD_ID, completionRequest: null, completion: null,
          updatedAt: input.createdAt });
        state.cards.push(value);
        return value;
      });
    },
    updateCard(input) {
      record("kanban.updateCard", input);
      return exactReplay(operations, "kanban.updateCard", input, () => {
        const current = find(state.cards, input.cardId);
        const value = { ...current, ...input.patch, updatedAt: Math.max(current.updatedAt, input.createdAt) };
        state.cards[state.cards.indexOf(current)] = value;
        return value;
      });
    },
    setCardStatus(input) {
      record("kanban.setCardStatus", input);
      return exactReplay(operations, "kanban.setCardStatus", input, () => {
        const current = find(state.cards, input.cardId);
        const value = { ...current, status: input.status, updatedAt: input.createdAt };
        state.cards[state.cards.indexOf(current)] = value;
        return value;
      });
    },
    setCardArchived(input) {
      record("kanban.setCardArchived", input);
      return exactReplay(operations, "kanban.setCardArchived", input, () => {
        const current = find(state.cards, input.cardId);
        const value = {
          ...current,
          archivedAt: input.archived ? input.createdAt : null,
          updatedAt: Math.max(current.updatedAt, input.createdAt),
        };
        state.cards[state.cards.indexOf(current)] = value;
        return value;
      });
    },
    listComments(cardId) {
      record("kanban.listComments", cardId);
      return clone(state.comments.filter((value) => value.cardId === cardId));
    },
    getComment(id) { record("kanban.getComment", id); return clone(find(state.comments, id)); },
    addComment(input) {
      record("kanban.addComment", input);
      return exactReplay(operations, "kanban.addComment", input, () => {
        const value = comment({ ...input, id: COMMENT_ID });
        state.comments.push(value);
        return value;
      });
    },
    listAttachments(cardId) {
      record("kanban.listAttachments", cardId);
      return clone(state.attachments.filter((value) => value.cardId === cardId));
    },
    listArtifacts(cardId) {
      record("kanban.listArtifacts", cardId);
      return clone(state.artifacts.filter((value) => value.cardId === cardId));
    },
    listAuditEvents(cardId) {
      record("kanban.listAuditEvents", cardId);
      return clone(state.audits.filter((value) => value.cardId === cardId));
    },
    listCardRunLinks(cardId) {
      record("kanban.listCardRunLinks", cardId);
      return clone(state.links.filter((value) => value.cardId === cardId));
    },
    getCardRunLinkByRunId(runId) {
      record("kanban.getCardRunLinkByRunId", runId);
      return clone(state.links.find((value) => value.runId === runId) || null);
    },
    completeCardManually(input) {
      record("kanban.completeCardManually", input);
      return exactReplay(operations, "kanban.completeCardManually", input, () => {
        const current = find(state.cards, input.cardId);
        const value = { ...current, status: "done", completion: {
          mode: "manual", runId: null, actorId: input.actorId, at: input.createdAt, note: input.note,
        }, updatedAt: input.createdAt };
        state.cards[state.cards.indexOf(current)] = value;
        state.audits.push(audit({ actorId: input.actorId, note: input.note, createdAt: input.createdAt }));
        return value;
      });
    },
  };

  const workDispatcher = {
    getRun(id) { record("dispatcher.getRun", id); return clone(find(state.runs, id)); },
    listRuns(query = {}) {
      record("dispatcher.listRuns", query);
      return clone(state.runs.filter((value) => Object.entries(query)
        .every(([key, expected]) => value[key] === expected)));
    },
  };

  const authoritativeDispatch = (input, retryOf) => {
    const runId = retryOf === null ? RUN_ID : "run-retry";
    let currentRun = find(state.runs, runId);
    if (!currentRun) {
      currentRun = run({ id: runId, retryOf, idempotencyKey: `intent-${input.operationId}` });
      state.runs.push(currentRun);
    }
    let currentLink = state.links.find((value) => value.runId === runId);
    if (!currentLink) {
      currentLink = link({ id: retryOf === null ? LINK_ID : "88888888-8888-4888-8888-999999999999",
        runId, retryOf, createdAt: input.createdAt });
      state.links.push(currentLink);
    }
    const currentCard = find(state.cards, input.cardId);
    currentCard.status = "queued";
    currentCard.updatedAt = Math.max(currentCard.updatedAt, input.createdAt);
    return { run: clone(currentRun), card: clone(currentCard), link: clone(currentLink) };
  };

  const kanbanRunService = {
    dispatchCard(input) {
      record("kanbanRun.dispatchCard", input);
      return exactReplay(operations, "kanbanRun.dispatchCard", input,
        () => authoritativeDispatch(input, null));
    },
    retryCard(input) {
      record("kanbanRun.retryCard", input);
      return exactReplay(operations, "kanbanRun.retryCard", input,
        () => authoritativeDispatch(input, input.retryOf));
    },
    completeCardManually(input) {
      record("kanbanRun.completeCardManually", input);
      return kanbanStore.completeCardManually(input);
    },
    poisonError: null,
  };

  const cronStore = {
    listJobs(query = {}) {
      record("cron.listJobs", query);
      return clone(state.jobs.filter((value) => Object.entries(query)
        .every(([key, expected]) => value[key] === expected)));
    },
    getJob(id) { record("cron.getJob", id); return clone(find(state.jobs, id)); },
    createJob(input) {
      record("cron.createJob", input);
      return exactReplay(operations, "cron.createJob", input, () => {
        const value = cronJob({ ...input, id: JOB_ID, updatedAt: input.createdAt });
        state.jobs.push(value);
        return value;
      });
    },
    updateJob() { throw new Error("legacy cron.updateJob touched"); },
    updateJobDerived(input) {
      record("cron.updateJobDerived", input);
      return exactReplay(operations, "cron.updateJobDerived", input, () => {
        const current = find(state.jobs, input.jobId);
        const updatedAt = Math.max(current.updatedAt, input.createdAt);
        const merged = { ...current, ...input.patch, updatedAt };
        if ((merged.threadPolicy === "new") !== (merged.threadId === null)) {
          const error = new Error("invalid final thread binding");
          error.code = "CRON_JOB_INVALID";
          throw error;
        }
        const value = {
          ...merged,
          nextRunAt: merged.enabled ? computeNextOccurrence(merged.schedule, updatedAt) : null,
        };
        state.jobs[state.jobs.indexOf(current)] = value;
        return value;
      });
    },
    deleteJob(input) {
      record("cron.deleteJob", input);
      return exactReplay(operations, "cron.deleteJob", input, () => {
        const index = state.jobs.findIndex((value) => value.id === input.jobId);
        if (index >= 0) state.jobs.splice(index, 1);
        return null;
      });
    },
    setJobEnabled() { throw new Error("legacy cron.setJobEnabled touched"); },
    setJobEnabledDerived(input) {
      record("cron.setJobEnabledDerived", input);
      return exactReplay(operations, "cron.setJobEnabledDerived", input, () => {
        const current = find(state.jobs, input.jobId);
        const updatedAt = Math.max(current.updatedAt, input.createdAt);
        const value = { ...current, enabled: input.enabled,
          nextRunAt: input.enabled ? computeNextOccurrence(current.schedule, updatedAt) : null,
          updatedAt };
        state.jobs[state.jobs.indexOf(current)] = value;
        return value;
      });
    },
    commitUncertain: false,
  };

  const cronScheduler = {
    tickCount: 0,
    poisonError: null,
    async tick() { record("cronScheduler.tick", null); this.tickCount += 1; },
    triggerJob(input) {
      record("cronScheduler.triggerJob", input);
      return exactReplay(operations, "cronScheduler.triggerJob", input, () => {
        const value = run({ id: "cron-trigger", source: "cron", sourceId: input.jobId,
          idempotencyKey: `cron-${input.operationId}`, retryOf: null });
        state.runs.push(value);
        return value;
      });
    },
    retryRun(input) {
      record("cronScheduler.retryRun", input);
      return exactReplay(operations, "cronScheduler.retryRun", input, () => {
        const value = run({ id: "cron-retry", source: "cron", sourceId: input.jobId,
          idempotencyKey: `cron-${input.operationId}`, retryOf: input.retryOf });
        state.runs.push(value);
        return value;
      });
    },
  };

  const fatalSignals = [];
  const controllerOptions = {
    kanbanStore,
    kanbanRunService,
    cronStore,
    cronScheduler,
    workDispatcher,
    getDomainAvailability() {
      record("availability", null);
      return clone(availability);
    },
    onFatalDomainError(domain, error) {
      fatalSignals.push({ domain, error });
      if (options.fatalCallbackRejects) return Promise.reject(new Error("callback secret"));
      return undefined;
    },
    cursorSecret: options.cursorSecret || CURSOR_SECRET,
    describeCronRun: options.describeCronRun || (() => ({ kind: "manual", createdAt: 200 })),
    now: () => 500,
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const controller = new NativeDomainServiceController(controllerOptions);
  return {
    controller, controllerOptions, calls, state, fatalSignals, kanbanStore, kanbanRunService,
    cronStore, cronScheduler, workDispatcher,
    setAvailability(value) { availability = clone(value); },
  };
}

function assertCode(error, code) {
  assert.equal(error?.code, code);
  assert.equal(typeof error?.message, "string");
  return true;
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => assertCode(error, code));
}

test("constructor 拒绝缺失核心依赖与不安全 cursor secret", () => {
  const fixture = makeFixture();
  for (const field of [
    "kanbanStore", "kanbanRunService", "cronStore", "cronScheduler", "workDispatcher",
    "getDomainAvailability",
  ]) {
    assert.throws(() => new NativeDomainServiceController({
      ...fixture.controllerOptions,
      [field]: null,
    }), TypeError, field);
  }
  assert.throws(() => new NativeDomainServiceController({
    ...fixture.controllerOptions,
    cursorSecret: Buffer.alloc(8),
  }), TypeError);
});

test("31 个方法完成路由并且 DTO 从不包含 Card/Comment body 或 Cron prompt", async () => {
  const fixture = makeFixture({ links: [] });
  const originalHandle = fixture.controller.handle.bind(fixture.controller);
  fixture.controller.handle = async (method, params) => {
    try { return await originalHandle(method, params); } catch (error) {
      throw new Error(`${method}: ${JSON.stringify(error)}`);
    }
  };
  const p = {
    boardList: { profileId: PROFILE_ID, cursor: null, limit: 25 },
    boardCreate: { operationId: "op-board-create", profileId: PROFILE_ID, slug: "new-board",
      name: "New", description: null, createdAt: 200 },
    boardUpdate: { operationId: "op-board-update", boardId: BOARD_ID,
      patch: { name: "Updated" }, createdAt: 201 },
    cardList: { boardId: BOARD_ID, status: null, cursor: null, limit: 25 },
    cardCreate: { operationId: "op-card-create", boardId: BOARD_ID, profileId: PROFILE_ID,
      title: "New card", body: "new body", status: "backlog", position: 1, createdAt: 202 },
    cardUpdate: { operationId: "op-card-update", cardId: CARD_ID,
      patch: { title: "Updated card" }, createdAt: 203 },
    cardStatus: { operationId: "op-card-status", cardId: CARD_ID,
      status: "queued", createdAt: 204 },
    cardArchived: { operationId: "op-card-archive", cardId: CARD_ID,
      archived: true, createdAt: 204 },
    manual: { operationId: "op-manual", cardId: CARD_ID, note: "manual note", createdAt: 220 },
    page: { cardId: CARD_ID, cursor: null, limit: 25 },
    commentAdd: { operationId: "op-comment", cardId: CARD_ID, body: "hello", createdAt: 205 },
    dispatch: { operationId: "op-dispatch", cardId: CARD_ID, workspace: null, createdAt: 210 },
    retry: { operationId: "op-retry", cardId: CARD_ID, retryOf: PRIOR_RUN_ID,
      workspace: "/tmp/project", createdAt: 211 },
    cronList: { profileId: PROFILE_ID, enabled: null, cursor: null, limit: 25 },
    cronCreate: { operationId: "op-cron-create", name: "Created", enabled: true,
      profileId: PROFILE_ID, prompt: "prompt", workspace: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
      threadPolicy: "new", threadId: null, createdAt: 300 },
    cronUpdate: { operationId: "op-cron-update", jobId: JOB_ID,
      patch: { prompt: "changed" }, createdAt: 301 },
    cronDelete: { operationId: "op-cron-delete", jobId: JOB_ID, createdAt: 304 },
    cronEnabled: { operationId: "op-cron-enabled", jobId: JOB_ID,
      enabled: false, createdAt: 303 },
    cronTrigger: { operationId: "op-trigger", jobId: JOB_ID, createdAt: 305 },
    cronRetry: { operationId: "op-cron-retry", jobId: JOB_ID,
      retryOf: PRIOR_RUN_ID, createdAt: 306 },
  };

  const results = [];
  results.push(await fixture.controller.handle("kanban.board.list", p.boardList));
  results.push(await fixture.controller.handle("kanban.board.get", { boardId: BOARD_ID }));
  results.push(await fixture.controller.handle("kanban.board.create", p.boardCreate));
  results.push(await fixture.controller.handle("kanban.board.update", p.boardUpdate));
  results.push(await fixture.controller.handle("kanban.card.list", p.cardList));
  results.push(await fixture.controller.handle("kanban.card.get", { cardId: CARD_ID }));
  results.push(await fixture.controller.handle("kanban.card.body.read",
    { cardId: CARD_ID, cursor: null, maxBytes: 5 }));
  results.push(await fixture.controller.handle("kanban.card.create", p.cardCreate));
  results.push(await fixture.controller.handle("kanban.card.update", p.cardUpdate));
  results.push(await fixture.controller.handle("kanban.card.status.set", p.cardStatus));
  results.push(await fixture.controller.handle("kanban.card.archived.set", p.cardArchived));
  results.push(await makeFixture().controller.handle("kanban.card.complete.manual", p.manual));
  results.push(await fixture.controller.handle("kanban.comment.list", p.page));
  results.push(await fixture.controller.handle("kanban.comment.body.read",
    { commentId: COMMENT_ID, cursor: null, maxBytes: 32_768 }));
  results.push(await fixture.controller.handle("kanban.comment.add", p.commentAdd));
  results.push(await fixture.controller.handle("kanban.attachment.list", p.page));
  results.push(await fixture.controller.handle("kanban.artifact.list", p.page));
  results.push(await fixture.controller.handle("kanban.audit.list", p.page));
  results.push(await fixture.controller.handle("kanban.run.list",
    { cardId: CARD_ID, status: null, cursor: null, limit: 25 }));
  results.push(await fixture.controller.handle("kanban.run.dispatch", p.dispatch));
  results.push(await fixture.controller.handle("kanban.run.retry", p.retry));
  results.push(await fixture.controller.handle("cron.job.list", p.cronList));
  results.push(await fixture.controller.handle("cron.job.get", { jobId: JOB_ID }));
  results.push(await fixture.controller.handle("cron.job.prompt.read",
    { jobId: JOB_ID, cursor: null, maxBytes: 32_768 }));
  results.push(await fixture.controller.handle("cron.job.create", p.cronCreate));
  results.push(await fixture.controller.handle("cron.job.update", p.cronUpdate));
  results.push(await fixture.controller.handle("cron.job.enabled.set", p.cronEnabled));
  results.push(await fixture.controller.handle("cron.run.list", {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 25,
  }));
  results.push(await fixture.controller.handle("cron.run.trigger", p.cronTrigger));
  results.push(await fixture.controller.handle("cron.run.retry", p.cronRetry));
  results.push(await fixture.controller.handle("cron.job.delete", p.cronDelete));

  assert.equal(results.length, 31);
  for (const result of results) {
    const serialized = JSON.stringify(result);
    assert.equal(/"body":/u.test(serialized), false, serialized);
    assert.equal(/"prompt":/u.test(serialized), false, serialized);
  }
  assert.deepEqual(results[5].card.bodyMeta.preview, "A😀BC");
  assert.equal(results[12].comments[0].bodyMeta.preview, "comment body");
  assert.equal(results[22].job.promptMeta.preview, "Run checks");
  assert.equal(results[6].text, "A😀");
  assert.equal(results[13].text, "comment body");
  assert.equal(results[23].text, "Run checks");
  assert.equal(fixture.cronScheduler.tickCount, 4);
});

test("所有 params 在接触 availability/dependency 前校验，unknown actor/nextRunAt 被拒绝", async () => {
  const fixture = makeFixture();
  for (const [method, params] of [
    ["kanban.board.get", { boardId: BOARD_ID, actor: "spoofed" }],
    ["kanban.card.complete.manual", {
      operationId: "manual-invalid", cardId: CARD_ID, note: null, actorId: "spoofed", createdAt: 200,
    }],
    ["cron.job.create", {
      operationId: "cron-invalid", name: "Bad", enabled: true, profileId: PROFILE_ID,
      prompt: "prompt", workspace: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
      threadPolicy: "new", threadId: null, nextRunAt: 1_000, createdAt: 200,
    }],
  ]) {
    await expectCode(() => fixture.controller.handle(method, params), "INVALID_PARAMS");
  }
  assert.equal(fixture.calls.length, 0);
});

test("本地 actor 固定且 operationId/createdAt 原样进入 mutation，replay 不重写", async () => {
  const fixture = makeFixture();
  const status = {
    operationId: "same-status-op", cardId: CARD_ID, status: "queued", createdAt: 240,
  };
  await fixture.controller.handle("kanban.card.status.set", status);
  await fixture.controller.handle("kanban.card.status.set", status);
  const statusCalls = fixture.calls.filter((entry) => entry.name === "kanban.setCardStatus");
  assert.equal(statusCalls.length, 2);
  for (const entry of statusCalls) assert.deepEqual(entry.input, {
    ...status,
    actor: "human",
    actorId: TRUSTED_LOCAL_ACTOR_ID,
  });

  const commentParams = {
    operationId: "same-comment-op", cardId: CARD_ID, body: "hello", createdAt: 241,
  };
  await fixture.controller.handle("kanban.comment.add", commentParams);
  const commentCall = fixture.calls.find((entry) => entry.name === "kanban.addComment");
  assert.deepEqual(commentCall.input, {
    ...commentParams,
    authorType: "human",
    authorId: TRUSTED_LOCAL_ACTOR_ID,
  });
});

test("Kanban dispatch/retry 返回 Store 与 Dispatcher 的权威 card/link/run 并锁定 retryOf", async () => {
  const fixture = makeFixture({ links: [] });
  const dispatched = await fixture.controller.handle("kanban.run.dispatch", {
    operationId: "dispatch-authoritative", cardId: CARD_ID, workspace: null, createdAt: 250,
  });
  assert.deepEqual(dispatched.run, fixture.workDispatcher.getRun(RUN_ID));
  assert.deepEqual(dispatched.link, fixture.kanbanStore.getCardRunLinkByRunId(RUN_ID));
  assert.equal(dispatched.card.id, fixture.kanbanStore.getCard(CARD_ID).id);
  assert.equal(Object.prototype.hasOwnProperty.call(dispatched.card, "body"), false);
  const retried = await fixture.controller.handle("kanban.run.retry", {
    operationId: "retry-authoritative", cardId: CARD_ID,
    retryOf: PRIOR_RUN_ID, workspace: null, createdAt: 251,
  });
  assert.equal(retried.run.retryOf, PRIOR_RUN_ID);
  assert.equal(retried.link.retryOf, PRIOR_RUN_ID);
  assert.equal(retried.run.id, retried.link.runId);
});

test("manual completion 只能使用可信本地 actor，并 join 唯一审计", async () => {
  const fixture = makeFixture();
  const params = {
    operationId: "manual-trusted", cardId: CARD_ID, note: "manual note", createdAt: 260,
  };
  const result = await fixture.controller.handle("kanban.card.complete.manual", params);
  assert.equal(result.card.completion.actorId, TRUSTED_LOCAL_ACTOR_ID);
  assert.equal(result.audit.actorId, TRUSTED_LOCAL_ACTOR_ID);
  const call = fixture.calls.find((entry) => entry.name === "kanbanRun.completeCardManually");
  assert.deepEqual(call.input, { ...params, actorId: TRUSTED_LOCAL_ACTOR_ID });

  const duplicate = makeFixture();
  duplicate.kanbanRunService.completeCardManually = (input) => {
    duplicate.kanbanStore.completeCardManually(input);
    duplicate.state.audits.push(clone(duplicate.state.audits[0]));
  };
  await expectCode(() => duplicate.controller.handle("kanban.card.complete.manual", params),
    "DOMAIN_RESPONSE_INVALID");
});

test("Cron create/update/enable 由 schedule+effective updatedAt 推导 nextRunAt，随后 await tick", async () => {
  const fixture = makeFixture();
  const created = await fixture.controller.handle("cron.job.create", {
    operationId: "cron-create-truth", name: "Truth", enabled: true,
    profileId: PROFILE_ID, prompt: "prompt", workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    threadPolicy: "new", threadId: null, createdAt: 300,
  });
  assert.equal(created.job.nextRunAt, 1_000);
  const createCall = fixture.calls.find((entry) => entry.name === "cron.createJob");
  assert.equal(createCall.input.nextRunAt, 1_000);

  const updated = await fixture.controller.handle("cron.job.update", {
    operationId: "cron-update-truth", jobId: JOB_ID,
    patch: { schedule: { kind: "at", at: 2_000 } }, createdAt: 350,
  });
  assert.equal(updated.job.nextRunAt, 2_000);
  const updateCall = fixture.calls.find((entry) => entry.name === "cron.updateJobDerived");
  assert.deepEqual(updateCall.input.patch, { schedule: { kind: "at", at: 2_000 } });

  const disabled = await fixture.controller.handle("cron.job.enabled.set", {
    operationId: "cron-disable-truth", jobId: JOB_ID, enabled: false, createdAt: 360,
  });
  assert.equal(disabled.job.nextRunAt, null);
  await fixture.controller.handle("cron.job.delete", {
    operationId: "cron-delete-truth", jobId: JOB_ID, createdAt: 370,
  });
  assert.equal(fixture.cronScheduler.tickCount, 4);
  assert.deepEqual(
    fixture.calls.filter((entry) => ["cron.createJob", "cron.updateJobDerived", "cron.setJobEnabledDerived",
      "cron.deleteJob", "cronScheduler.tick"].includes(entry.name)).map((entry) => entry.name),
    ["cron.createJob", "cronScheduler.tick", "cron.updateJobDerived", "cronScheduler.tick",
      "cron.setJobEnabledDerived", "cronScheduler.tick", "cron.deleteJob", "cronScheduler.tick"],
  );
});

test("Cron derived mutation 在 tick 后读权威 Job，删除后 exact replay 回退 immutable result", async () => {
  const fixture = makeFixture();
  const params = {
    operationId: "derived-replay", jobId: JOB_ID, patch: { name: "mutation-result" },
    createdAt: 380,
  };
  fixture.cronScheduler.tick = async () => {
    const current = fixture.state.jobs.find((value) => value.id === JOB_ID);
    if (current) current.name = "after-tick-authoritative";
  };
  const first = await fixture.controller.handle("cron.job.update", params);
  assert.equal(first.job.name, "after-tick-authoritative");
  await fixture.controller.handle("cron.job.update", {
    operationId: "derived-later-update", jobId: JOB_ID,
    patch: { prompt: "later update" }, createdAt: 381,
  });
  await fixture.controller.handle("cron.job.delete", {
    operationId: "derived-later-delete", jobId: JOB_ID, createdAt: 382,
  });
  const replay = await fixture.controller.handle("cron.job.update", params);
  assert.equal(replay.job.name, "mutation-result");
  assert.equal(fixture.calls.filter((entry) => entry.name === "cron.updateJobDerived"
    && entry.input.operationId === params.operationId).length, 2);
});

test("Cron mutation 的普通 tick 失败公开返回且不 poison，exact replay 可再次 tick", async () => {
  const fixture = makeFixture();
  let tickCalls = 0;
  fixture.cronScheduler.tick = async () => {
    tickCalls += 1;
    if (tickCalls === 1) throw new Error("ordinary tick private failure");
  };
  const params = {
    operationId: "tick-retry", jobId: JOB_ID, patch: { name: "tick retry" }, createdAt: 385,
  };
  await expectCode(() => fixture.controller.handle("cron.job.update", params), "INTERNAL_ERROR");
  const replay = await fixture.controller.handle("cron.job.update", params);
  assert.equal(replay.job.name, "tick retry");
  assert.equal(tickCalls, 2);
  assert.equal(fixture.fatalSignals.length, 0);
});

test("Controller 映射 derived thread、capacity、timestamp 与 state 的固定公开错误", async () => {
  const thread = makeFixture();
  await expectCode(() => thread.controller.handle("cron.job.update", {
    operationId: "thread-invalid", jobId: JOB_ID,
    patch: { threadPolicy: "continue" }, createdAt: 390,
  }), "INVALID_PARAMS");

  for (const [method, dependency, code, expected, params] of [
    ["kanban.card.create", "kanbanStore", "KANBAN_CARD_CAPACITY", "KANBAN_CAPACITY", {
      operationId: "capacity-card", boardId: BOARD_ID, profileId: PROFILE_ID,
      title: "capacity", body: null, status: "backlog", position: 0, createdAt: 391,
    }],
    ["cron.job.create", "cronStore", "CRON_JOB_CAPACITY", "CRON_CAPACITY", {
      operationId: "capacity-cron", name: "capacity", enabled: true, profileId: PROFILE_ID,
      prompt: "prompt", workspace: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
      threadPolicy: "new", threadId: null, createdAt: 392,
    }],
    ["kanban.board.create", "kanbanStore", "KANBAN_TIMESTAMP_INVALID", "INVALID_PARAMS", {
      operationId: "time-board", profileId: PROFILE_ID, slug: "time-board",
      name: "time", description: null, createdAt: 393,
    }],
    ["cron.run.trigger", "cronScheduler", "CRON_OVERLAP_QUEUE_FULL", "STATE_CONFLICT", {
      operationId: "state-cron", jobId: JOB_ID, createdAt: 394,
    }],
  ]) {
    const fixture = makeFixture();
    const target = fixture[dependency];
    const route = method === "kanban.card.create" ? "createCard"
      : method === "kanban.board.create" ? "createBoard"
        : method === "cron.job.create" ? "createJob" : "triggerJob";
    target[route] = () => { const error = new Error("private"); error.code = code; throw error; };
    await expectCode(() => fixture.controller.handle(method, params), expected);
  }
});

test("Cron manual trigger/retry 立即返回 durable WorkRun 并保留 operation/retry lineage", async () => {
  const fixture = makeFixture();
  const triggerParams = { operationId: "manual-cron", jobId: JOB_ID, createdAt: 400 };
  const triggered = await fixture.controller.handle("cron.run.trigger", triggerParams);
  assert.equal(triggered.run.id, "cron-trigger");
  assert.equal(triggered.run.retryOf, null);
  assert.deepEqual(fixture.calls.find((entry) => entry.name === "cronScheduler.triggerJob").input,
    triggerParams);
  assert.equal((await fixture.controller.handle("cron.run.trigger", triggerParams)).run.id,
    triggered.run.id);

  const retryParams = {
    operationId: "retry-cron", jobId: JOB_ID, retryOf: PRIOR_RUN_ID, createdAt: 401,
  };
  const retried = await fixture.controller.handle("cron.run.retry", retryParams);
  assert.equal(retried.run.id, "cron-retry");
  assert.equal(retried.run.retryOf, PRIOR_RUN_ID);
  assert.deepEqual(fixture.calls.find((entry) => entry.name === "cronScheduler.retryRun").input,
    retryParams);
});

test("HMAC keyset cursor 绑定 method/filter/snapshot，可跨 Controller restart 且拒绝篡改", async () => {
  const boards = [0, 1, 2].map((index) => board({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    slug: `board-${index}`,
    createdAt: 100 + index,
    updatedAt: 100 + index,
  }));
  const firstFixture = makeFixture({ boards });
  const params = { profileId: PROFILE_ID, cursor: null, limit: 1 };
  const first = await firstFixture.controller.handle("kanban.board.list", params);
  assert.equal(first.boards.length, 1);
  assert.equal(first.hasMore, true);
  const restarted = makeFixture({ boards, cursorSecret: CURSOR_SECRET });
  const second = await restarted.controller.handle("kanban.board.list", {
    ...params, cursor: first.nextCursor,
  });
  assert.equal(second.boards[0].id, boards[1].id);

  const tail = first.nextCursor.endsWith("A") ? "B" : "A";
  await expectCode(() => restarted.controller.handle("kanban.board.list", {
    ...params,
    cursor: `${first.nextCursor.slice(0, -1)}${tail}`,
  }), "INVALID_PARAMS");
  await expectCode(() => restarted.controller.handle("kanban.board.list", {
    profileId: OTHER_PROFILE_ID, cursor: first.nextCursor, limit: 1,
  }), "INVALID_PARAMS");

  restarted.state.boards[1].name = "revision changed";
  await expectCode(() => restarted.controller.handle("kanban.board.list", {
    ...params, cursor: first.nextCursor,
  }), "INVALID_PARAMS");
});

test("分页动态收缩确保最多100项且最终响应 frame 不超过64KiB", async () => {
  const boards = Array.from({ length: 12 }, (_, index) => board({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    slug: `large-${index}`,
    description: String(index % 10).repeat(15 * 1_024),
    createdAt: 100 + index,
    updatedAt: 100 + index,
  }));
  const fixture = makeFixture({ boards });
  const result = await fixture.controller.handle("kanban.board.list", {
    profileId: PROFILE_ID, cursor: null, limit: MAX_PAGE_LIMIT,
  });
  assert.equal(result.boards.length > 0 && result.boards.length < boards.length, true);
  assert.equal(result.boards.length <= MAX_PAGE_LIMIT, true);
  assert.equal(Buffer.byteLength(`${JSON.stringify({
    id: "r".repeat(256), ok: true, result,
  })}\n`) <= MAX_FRAME_BYTES, true);

  const tightBoards = Array.from({ length: 101 }, (_, index) => board({
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
    slug: `tight-${index}`,
    description: "x".repeat(512),
    createdAt: 1_000 + index,
    updatedAt: 1_000 + index,
  }));
  const tight = await makeFixture({ boards: tightBoards }).controller.handle(
    "kanban.board.list",
    { profileId: PROFILE_ID, cursor: null, limit: MAX_PAGE_LIMIT },
  );
  assert.equal(Buffer.byteLength(`${JSON.stringify({
    id: "\u0001".repeat(256), ok: true, result: tight,
  })}\n`) <= MAX_FRAME_BYTES, true);
});

test("params/DTO invalid 与 Store raw error 都映射成固定 public error，不泄露 secret", async () => {
  const fixture = makeFixture();
  fixture.kanbanStore.getBoard = () => {
    const error = new Error("raw-secret-canary board lookup");
    error.code = "SOME_PRIVATE_FAILURE";
    error.stack = "raw-secret-canary stack";
    throw error;
  };
  await assert.rejects(
    fixture.controller.handle("kanban.board.get", { boardId: BOARD_ID }),
    (error) => error.code === "INTERNAL_ERROR"
      && !JSON.stringify(error).includes("raw-secret-canary")
      && !Object.prototype.hasOwnProperty.call(error, "cause")
      && !Object.prototype.hasOwnProperty.call(error, "stack"),
  );
});

test("fatal/health/availability 探测不执行 accessor 或 Proxy getter，失败时固定 fail-closed", async () => {
  const accessorError = makeFixture();
  let accessorHits = 0;
  const unsafe = {};
  Object.defineProperty(unsafe, "code", {
    enumerable: true,
    get() { accessorHits += 1; throw new Error("raw code getter"); },
  });
  accessorError.kanbanStore.getBoard = () => { throw unsafe; };
  await expectCode(() => accessorError.controller.handle("kanban.board.get", {
    boardId: BOARD_ID,
  }), "KANBAN_UNAVAILABLE");
  await expectCode(() => accessorError.controller.handle("kanban.board.get", {
    boardId: BOARD_ID,
  }), "KANBAN_UNAVAILABLE");
  assert.equal(accessorHits, 0);
  assert.equal(accessorError.fatalSignals.length, 1);

  const proxyError = makeFixture();
  let proxyGetterHits = 0;
  const commitUncertain = new Proxy({
    code: "STORE_COMMIT_UNCERTAIN", committedUncertain: true,
  }, {
    get() { proxyGetterHits += 1; throw new Error("proxy getter"); },
  });
  proxyError.kanbanStore.getBoard = () => { throw commitUncertain; };
  await expectCode(() => proxyError.controller.handle("kanban.board.get", {
    boardId: BOARD_ID,
  }), "KANBAN_COMMIT_UNCERTAIN");
  assert.equal(proxyGetterHits, 0);

  const health = makeFixture();
  let healthGetterHits = 0;
  Object.defineProperty(health.kanbanStore, "commitUncertain", {
    configurable: true,
    get() { healthGetterHits += 1; throw new Error("health getter"); },
  });
  health.kanbanStore.getBoard = () => { throw new Error("ordinary private failure"); };
  await expectCode(() => health.controller.handle("kanban.board.get", {
    boardId: BOARD_ID,
  }), "KANBAN_UNAVAILABLE");
  assert.equal(healthGetterHits, 0);

  const availabilityFixture = makeFixture();
  let availabilityGetterHits = 0;
  const availability = new Proxy({
    kanban: { available: true, reason: null },
    cron: { available: true, reason: null },
  }, {
    get() { availabilityGetterHits += 1; throw new Error("availability getter"); },
    getOwnPropertyDescriptor() { throw new Error("availability descriptor trap"); },
  });
  const controller = new NativeDomainServiceController({
    ...availabilityFixture.controllerOptions,
    getDomainAvailability() { return availability; },
  });
  await expectCode(() => controller.handle("kanban.board.get", { boardId: BOARD_ID }),
    "KANBAN_UNAVAILABLE");
  assert.equal(availabilityGetterHits, 0);
});

test("commit-uncertain/poison 先映射并按 domain sticky fail-close，fatal callback 恰一次且失败被消费", async () => {
  const fixture = makeFixture({ fatalCallbackRejects: true });
  let boardTouches = 0;
  fixture.kanbanStore.createBoard = () => {
    boardTouches += 1;
    const error = new Error("fatal raw secret");
    error.code = "STORE_COMMIT_UNCERTAIN";
    error.committedUncertain = true;
    throw error;
  };
  const params = {
    operationId: "fatal-board", profileId: PROFILE_ID, slug: "fatal-board",
    name: "Fatal", description: null, createdAt: 450,
  };
  await expectCode(() => fixture.controller.handle("kanban.board.create", params),
    "KANBAN_COMMIT_UNCERTAIN");
  await expectCode(() => fixture.controller.handle("kanban.board.create", params),
    "KANBAN_COMMIT_UNCERTAIN");
  await Promise.resolve();
  assert.equal(boardTouches, 1);
  assert.equal(fixture.fatalSignals.length, 1);
  assert.equal(fixture.fatalSignals[0].domain, "kanban");
  assert.deepEqual(Object.keys(fixture.fatalSignals[0].error).sort(), ["code", "message"]);
  assert.equal(Object.isFrozen(fixture.fatalSignals[0].error), true);
  assert.equal(JSON.stringify(fixture.fatalSignals).includes("fatal raw secret"), false);

  const cronResult = await fixture.controller.handle("cron.job.get", { jobId: JOB_ID });
  assert.equal(cronResult.job.id, JOB_ID, "Kanban fatal 不得拖垮 Cron");

  let cronTouches = 0;
  fixture.cronStore.createJob = () => {
    cronTouches += 1;
    const error = new Error("cron fatal raw secret");
    error.code = "CRON_COMMIT_UNCERTAIN";
    error.committedUncertain = true;
    throw error;
  };
  const cronParams = {
    operationId: "fatal-cron", name: "Fatal", enabled: true, profileId: PROFILE_ID,
    prompt: "prompt", workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    threadPolicy: "new", threadId: null, createdAt: 450,
  };
  await expectCode(() => fixture.controller.handle("cron.job.create", cronParams),
    "CRON_COMMIT_UNCERTAIN");
  await expectCode(() => fixture.controller.handle("cron.job.create", cronParams),
    "CRON_COMMIT_UNCERTAIN");
  await Promise.resolve();
  assert.equal(cronTouches, 1);
  assert.equal(fixture.fatalSignals.length, 2);
  assert.equal(fixture.fatalSignals[1].domain, "cron");

  const poisonFixture = makeFixture();
  const poison = new Error("private cron run grammar detail");
  poison.code = "CRON_RUN_CORRUPT";
  poisonFixture.cronScheduler.poisonError = poison;
  poisonFixture.cronScheduler.triggerJob = () => { throw poison; };
  const poisonParams = { operationId: "cron-poison", jobId: JOB_ID, createdAt: 451 };
  await expectCode(() => poisonFixture.controller.handle("cron.run.trigger", poisonParams),
    "CRON_UNAVAILABLE");
  await expectCode(() => poisonFixture.controller.handle("cron.run.trigger", poisonParams),
    "CRON_UNAVAILABLE");
  assert.equal(poisonFixture.fatalSignals.length, 1);
  assert.deepEqual(poisonFixture.fatalSignals[0], {
    domain: "cron",
    error: {
      code: "CRON_UNAVAILABLE",
      message: "Cron Service 暂时不可用",
    },
  });
});

test("缺少 describeCronRun 时只让 cron.run.list 固定 unavailable，其余 Cron 方法仍可用", async () => {
  const fixture = makeFixture();
  const controller = new NativeDomainServiceController({
    ...fixture.controllerOptions,
    describeCronRun: undefined,
  });
  await expectCode(() => controller.handle("cron.run.list", {
    jobId: JOB_ID, status: null, cursor: null, limit: 25,
  }), "CRON_UNAVAILABLE");
  assert.equal((await controller.handle("cron.job.get", { jobId: JOB_ID })).job.id, JOB_ID);
});

test("cron.run.list 只接受 helper exact 描述，投影 kind/createdAt 并按时间 keyset", async () => {
  const cronRuns = [
    run({ id: "cron-later", source: "cron", sourceId: JOB_ID,
      idempotencyKey: "opaque-later", status: "failed", finishedAt: 300, errorCode: "FAILED" }),
    run({ id: "cron-earlier", source: "cron", sourceId: JOB_ID,
      idempotencyKey: "opaque-earlier", status: "failed", finishedAt: 200, errorCode: "FAILED" }),
  ];
  const fixture = makeFixture({
    runs: cronRuns,
    describeCronRun(value) {
      return value.id === "cron-earlier"
        ? { kind: "schedule", createdAt: 100 }
        : { kind: "manual", createdAt: 200 };
    },
  });
  const result = await fixture.controller.handle("cron.run.list", {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 1,
  });
  assert.deepEqual(result.runs[0], {
    run: cronRuns[1], kind: "schedule", createdAt: 100,
  });
  validateDomainServiceResult("cron.run.list", result, {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 1,
  });

  const foreign = run({
    id: "cron-foreign", source: "cron", sourceId: OTHER_JOB_ID,
    profileId: PROFILE_ID, status: "failed", finishedAt: 201, errorCode: "FAILED",
  });
  fixture.workDispatcher.listRuns = () => [...cronRuns, foreign];
  const filtered = await fixture.controller.handle("cron.run.list", {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 25,
  });
  assert.deepEqual(filtered.runs.map((item) => item.run.id), ["cron-earlier", "cron-later"]);

  const malformed = makeFixture({
    describeCronRun() { return { kind: "manual", createdAt: 100, internal: "secret" }; },
  });
  await expectCode(() => malformed.controller.handle("cron.run.list", {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 1,
  }), "DOMAIN_RESPONSE_INVALID");
});

test("content cursor 在 Unicode 字节边界无损前进，资源版本变化返回 RESOURCE_CHANGED", async () => {
  const fixture = makeFixture({ cards: [card({ body: "A😀BCDEF" })] });
  const params = { cardId: CARD_ID, cursor: null, maxBytes: 5 };
  const first = await fixture.controller.handle("kanban.card.body.read", params);
  assert.equal(first.text, "A😀");
  const unchangedRestart = makeFixture({ cards: [card({ body: "A😀BCDEF" })] });
  assert.equal((await unchangedRestart.controller.handle("kanban.card.body.read", {
    ...params, cursor: first.nextCursor,
  })).text, "BCDEF");
  fixture.state.cards[0].body = "A😀changed";
  await expectCode(() => fixture.controller.handle("kanban.card.body.read", {
    ...params, cursor: first.nextCursor,
  }), "RESOURCE_CHANGED");
  const restarted = makeFixture({ cards: [card({ body: "A😀changed" })] });
  await expectCode(() => restarted.controller.handle("kanban.card.body.read", {
    ...params, cursor: first.nextCursor,
  }), "RESOURCE_CHANGED");

  const promptFixture = makeFixture({ jobs: [cronJob({ prompt: "A😀BCDEF" })] });
  const promptParams = { jobId: JOB_ID, cursor: null, maxBytes: 5 };
  const promptFirst = await promptFixture.controller.handle("cron.job.prompt.read", promptParams);
  assert.equal(promptFirst.text, "A😀");
  promptFixture.state.jobs[0].prompt = "A😀changed";
  await expectCode(() => promptFixture.controller.handle("cron.job.prompt.read", {
    ...promptParams, cursor: promptFirst.nextCursor,
  }), "RESOURCE_CHANGED");

  const commentFixture = makeFixture();
  commentFixture.calls.splice(0);
  await commentFixture.controller.handle("kanban.comment.body.read", {
    commentId: COMMENT_ID, cursor: null, maxBytes: 32_768,
  });
  assert.deepEqual(commentFixture.calls.map((entry) => entry.name), [
    "availability", "kanban.getComment",
  ]);
});

test("locked/unavailable domain 在 guard 后固定失败且零触碰对应 Store/Service", async () => {
  for (const lockedDomain of ["kanban", "cron"]) {
    const fixture = makeFixture({
      availability: {
        kanban: { available: lockedDomain !== "kanban", reason: null },
        cron: { available: lockedDomain !== "cron", reason: null },
      },
    });
    const forbidden = lockedDomain === "kanban"
      ? [[fixture.kanbanStore, "commitUncertain"], [fixture.kanbanRunService, "poisonError"]]
      : [[fixture.cronStore, "commitUncertain"], [fixture.cronScheduler, "poisonError"]];
    for (const [dependency, field] of forbidden) {
      Object.defineProperty(dependency, field, {
        configurable: true,
        get() { throw new Error(`availability guard touched ${field}`); },
      });
    }
    const method = lockedDomain === "kanban" ? "kanban.board.list" : "cron.job.list";
    const params = lockedDomain === "kanban"
      ? { profileId: PROFILE_ID, cursor: null, limit: 25 }
      : { profileId: PROFILE_ID, enabled: null, cursor: null, limit: 25 };
    await expectCode(() => fixture.controller.handle(method, params),
      lockedDomain === "kanban" ? "KANBAN_UNAVAILABLE" : "CRON_UNAVAILABLE");
    assert.deepEqual(fixture.calls.map((entry) => entry.name), ["availability"]);
    const other = lockedDomain === "kanban"
      ? await fixture.controller.handle("cron.job.get", { jobId: JOB_ID })
      : await fixture.controller.handle("kanban.board.get", { boardId: BOARD_ID });
    assert.equal(lockedDomain === "kanban" ? other.job.id : other.board.id,
      lockedDomain === "kanban" ? JOB_ID : BOARD_ID);
  }
});

async function main() {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      process.stdout.write(`✓ ${entry.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`✗ ${entry.name}\n${error?.stack || JSON.stringify(error)}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
