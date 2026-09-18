#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DOMAIN_SERVICE_METHODS,
  MAX_CONTENT_PREVIEW_BYTES,
  MAX_CONTENT_READ_BYTES,
  MAX_CURSOR_BYTES,
  MAX_FRAME_BYTES,
  MAX_ITEM_BYTES,
  PUBLIC_MESSAGES,
  createContentMeta,
  createDomainQueryCursorCodec,
  chunkDomainContent,
  mapDomainServiceError,
  paginateDomainServiceItems,
  validateDomainServiceParams,
  validateDomainServiceRequest,
  validateDomainServiceResult,
} = require(path.join(ROOT, "app", "agent-service", "domain-service-protocol.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function expectCode(action, code) {
  assert.throws(action, (error) => error?.code === code, `expected ${code}`);
}

const SHA_EMPTY = crypto.createHash("sha256").update("").digest("hex");
const SHA_BODY = crypto.createHash("sha256").update("body").digest("hex");
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";
const AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const LINK_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_CARD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "run-1";
const PRIOR_RUN_ID = "run-prior";

function contentMeta(overrides = {}) {
  return { byteLength: 4, sha256: SHA_BODY, preview: "body", ...overrides };
}

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
    title: "Ship protocol",
    bodyMeta: contentMeta(),
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
    authorId: "user-1",
    bodyMeta: contentMeta(),
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
    sha256: SHA_BODY,
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
    sha256: SHA_BODY,
    storageKey: "artifacts/result.txt",
    createdAt: 104,
    ...overrides,
  };
}

function auditEvent(overrides = {}) {
  return {
    id: AUDIT_ID,
    cardId: CARD_ID,
    kind: "manual_completion",
    actorId: "user-1",
    runId: null,
    note: null,
    createdAt: 105,
    ...overrides,
  };
}

function cardRunLink(overrides = {}) {
  return {
    id: LINK_ID,
    cardId: CARD_ID,
    runId: RUN_ID,
    retryOf: null,
    createdAt: 106,
    ...overrides,
  };
}

function workRun(overrides = {}) {
  return {
    id: RUN_ID,
    source: "kanban",
    sourceId: CARD_ID,
    idempotencyKey: "dispatch-key",
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

function cronRunListItem(overrides = {}) {
  return {
    run: workRun({ source: "cron", sourceId: JOB_ID }),
    kind: "schedule",
    createdAt: 113,
    ...overrides,
  };
}

function cronJob(overrides = {}) {
  return {
    id: JOB_ID,
    name: "Nightly",
    enabled: false,
    profileId: PROFILE_ID,
    promptMeta: contentMeta(),
    workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function request(method, params, overrides = {}) {
  return {
    id: "request-1",
    token: "t".repeat(64),
    version: 1,
    method,
    params,
    ...overrides,
  };
}

function indexedUuid(index) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
}

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
  ["kanban.card.list", {
    boardId: BOARD_ID, status: null, cursor: null, limit: 25,
  }],
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
  ["kanban.comment.body.read", { commentId: COMMENT_ID, cursor: null, maxBytes: 1 }],
  ["kanban.comment.add", {
    operationId: "op-comment-add", cardId: CARD_ID, body: "hello", createdAt: 106,
  }],
  ["kanban.attachment.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.artifact.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.audit.list", { cardId: CARD_ID, cursor: null, limit: 25 }],
  ["kanban.run.list", {
    cardId: CARD_ID, status: null, cursor: null, limit: 25,
  }],
  ["kanban.run.dispatch", {
    operationId: "op-dispatch", cardId: CARD_ID, workspace: null, createdAt: 107,
  }],
  ["kanban.run.retry", {
    operationId: "op-retry", cardId: CARD_ID,
    retryOf: PRIOR_RUN_ID, workspace: "/tmp/project", createdAt: 108,
  }],
  ["cron.job.list", {
    profileId: PROFILE_ID, enabled: null, cursor: null, limit: 25,
  }],
  ["cron.job.get", { jobId: JOB_ID }],
  ["cron.job.prompt.read", { jobId: JOB_ID, cursor: null, maxBytes: 4_096 }],
  ["cron.job.create", {
    operationId: "op-job-create", name: "Nightly", enabled: true,
    profileId: PROFILE_ID, prompt: "Run checks", workspace: null,
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
  ["cron.run.list", {
    jobId: JOB_ID, status: "failed", cursor: null, limit: 25,
  }],
  ["cron.run.trigger", { operationId: "op-trigger", jobId: JOB_ID, createdAt: 113 }],
  ["cron.run.retry", {
    operationId: "op-cron-retry", jobId: JOB_ID,
    retryOf: PRIOR_RUN_ID, createdAt: 114,
  }],
]);

test("注册唯一且顺序稳定的 Native Kanban/Cron Service 方法集", () => {
  assert.deepEqual([...DOMAIN_SERVICE_METHODS], [
    "kanban.board.list", "kanban.board.get", "kanban.board.create", "kanban.board.update",
    "kanban.card.list", "kanban.card.get", "kanban.card.body.read", "kanban.card.create",
    "kanban.card.update", "kanban.card.status.set", "kanban.card.archived.set",
    "kanban.card.complete.manual",
    "kanban.comment.list", "kanban.comment.body.read", "kanban.comment.add",
    "kanban.attachment.list", "kanban.artifact.list", "kanban.audit.list",
    "kanban.run.list", "kanban.run.dispatch", "kanban.run.retry",
    "cron.job.list", "cron.job.get", "cron.job.prompt.read", "cron.job.create",
    "cron.job.update", "cron.job.delete", "cron.job.enabled.set",
    "cron.run.list", "cron.run.trigger", "cron.run.retry",
  ]);
  assert.equal(new Set(DOMAIN_SERVICE_METHODS).size, DOMAIN_SERVICE_METHODS.length);
  assert.deepEqual([...VALID_PARAMS.keys()], [...DOMAIN_SERVICE_METHODS]);
});

test("每个 method 接受自身 exact params 并返回无别名 canonical clone", () => {
  for (const [method, params] of VALID_PARAMS) {
    const output = validateDomainServiceParams(method, params);
    assert.deepEqual(output, params, method);
    assert.notEqual(output, params, method);
  }
});

test("params 拒绝 unknown、missing、undefined、accessor、非 plain object 和未知 method", () => {
  for (const [method, params] of VALID_PARAMS) {
    expectCode(() => validateDomainServiceParams(method, { ...params, unknown: true }), "INVALID_PARAMS");
    const first = Object.keys(params)[0];
    const missing = { ...params };
    delete missing[first];
    expectCode(() => validateDomainServiceParams(method, missing), "INVALID_PARAMS");
    expectCode(() => validateDomainServiceParams(method, { ...params, [first]: undefined }), "INVALID_PARAMS");
  }
  expectCode(() => validateDomainServiceParams("kanban.board.get", Object.create(null)), "INVALID_PARAMS");
  const accessor = {};
  Object.defineProperty(accessor, "boardId", { enumerable: true, get: () => BOARD_ID });
  expectCode(() => validateDomainServiceParams("kanban.board.get", accessor), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("unknown.method", {}), "INVALID_PARAMS");
});

test("分页、content read 与 opaque id 使用硬边界", () => {
  expectCode(() => validateDomainServiceParams("kanban.board.list", {
    profileId: PROFILE_ID, cursor: null, limit: 0,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.board.list", {
    profileId: PROFILE_ID, cursor: null, limit: 101,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.board.list", {
    profileId: PROFILE_ID, cursor: "x".repeat(MAX_CURSOR_BYTES + 1), limit: 1,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.card.body.read", {
    cardId: CARD_ID, cursor: null, maxBytes: 0,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.card.body.read", {
    cardId: CARD_ID, cursor: null, maxBytes: MAX_CONTENT_READ_BYTES + 1,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.board.get", {
    boardId: `b${"x".repeat(128)}`,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.board.get", { boardId: "bad/id" }), "INVALID_PARAMS");
  assert.equal(validateDomainServiceParams("kanban.run.retry",
    VALID_PARAMS.get("kanban.run.retry")).retryOf, PRIOR_RUN_ID);
});

test("Native entity/profile IDs 使用 UUID，Cron path/thread 与 Artifact kind 对齐 Store 边界", () => {
  expectCode(() => validateDomainServiceParams("kanban.board.list", {
    profileId: "profile-1", cursor: null, limit: 1,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceResult("kanban.board.get", {
    board: board({ id: "board-1" }),
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.get", {
    card: card({ boardId: "board-1" }),
  }), "DOMAIN_RESPONSE_INVALID");
  for (const [method, result] of [
    ["kanban.comment.add", { comment: comment({ id: "comment-1" }) }],
    ["kanban.attachment.list", {
      attachments: [attachment({ id: "attachment-1" })], nextCursor: null, hasMore: false,
    }],
    ["kanban.artifact.list", {
      artifacts: [artifact({ id: "artifact-1" })], nextCursor: null, hasMore: false,
    }],
    ["kanban.audit.list", {
      auditEvents: [auditEvent({ id: "audit-1" })], nextCursor: null, hasMore: false,
    }],
    ["cron.job.get", { job: cronJob({ id: "job-1" }) }],
  ]) expectCode(() => validateDomainServiceResult(method, result), "DOMAIN_RESPONSE_INVALID");

  const create = VALID_PARAMS.get("cron.job.create");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create, workspace: "relative/project",
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: cronJob({ workspace: "relative/project" }),
  }), "DOMAIN_RESPONSE_INVALID");
  assert.equal(validateDomainServiceParams("cron.job.create", {
    ...create, threadPolicy: "continue", threadId: "t".repeat(256),
  }).threadId.length, 256);
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create, threadPolicy: "continue", threadId: "t".repeat(257),
  }), "INVALID_PARAMS");
  validateDomainServiceResult("kanban.artifact.list", {
    artifacts: [artifact({ kind: "k".repeat(64) })], nextCursor: null, hasMore: false,
  });
  expectCode(() => validateDomainServiceResult("kanban.artifact.list", {
    artifacts: [artifact({ kind: "k".repeat(65) })], nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.attachment.list", {
    attachments: [attachment({ storageKey: "/private/report.txt" })],
    nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
});

test("client mutation 不接受 actor、actorId 或 Cron nextRunAt", () => {
  expectCode(() => validateDomainServiceParams("kanban.card.status.set", {
    ...VALID_PARAMS.get("kanban.card.status.set"), actor: "human",
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.card.complete.manual", {
    ...VALID_PARAMS.get("kanban.card.complete.manual"), actorId: "user-1",
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("kanban.comment.add", {
    ...VALID_PARAMS.get("kanban.comment.add"), authorType: "agent", authorId: "agent-1",
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...VALID_PARAMS.get("cron.job.create"), nextRunAt: 120_000,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("cron.job.update", {
    ...VALID_PARAMS.get("cron.job.update"), patch: { nextRunAt: 120_000 },
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("cron.job.enabled.set", {
    ...VALID_PARAMS.get("cron.job.enabled.set"), nextRunAt: null,
  }), "INVALID_PARAMS");
});

test("patch 必须非空、字段受限且值不能为 undefined", () => {
  for (const method of ["kanban.board.update", "kanban.card.update", "cron.job.update"]) {
    const valid = VALID_PARAMS.get(method);
    expectCode(() => validateDomainServiceParams(method, { ...valid, patch: {} }), "INVALID_PARAMS");
    expectCode(() => validateDomainServiceParams(method, {
      ...valid, patch: { ...valid.patch, injected: true },
    }), "INVALID_PARAMS");
    const field = Object.keys(valid.patch)[0];
    expectCode(() => validateDomainServiceParams(method, {
      ...valid, patch: { ...valid.patch, [field]: undefined },
    }), "INVALID_PARAMS");
  }
});

test("slug 必须是 ASCII 字符串，不能依赖 RegExp 隐式类型转换", () => {
  expectCode(() => validateDomainServiceParams("kanban.board.create", {
    ...VALID_PARAMS.get("kanban.board.create"), slug: 123,
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceResult("kanban.board.get", {
    board: board({ slug: 123 }),
  }), "DOMAIN_RESPONSE_INVALID");
});

test("复用固定 cron schedule 语义并拒绝非法组合", () => {
  const create = VALID_PARAMS.get("cron.job.create");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create, schedule: { kind: "every", everyMs: 59_999, anchorMs: 0 },
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create, schedule: { kind: "cron", expr: "not cron", tz: "Asia/Shanghai" },
  }), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create, threadPolicy: "new", threadId: "thread-1",
  }), "INVALID_PARAMS");
  assert.equal(validateDomainServiceParams("cron.job.create", {
    ...create, threadPolicy: "continue", threadId: null,
  }).threadId, null);
});

test("Cron params-first 校验可静态判定的 thread binding 与 enabled at 时间", () => {
  const create = VALID_PARAMS.get("cron.job.create");
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...create,
    schedule: { kind: "at", at: create.createdAt },
  }), "INVALID_PARAMS");
  assert.equal(validateDomainServiceParams("cron.job.create", {
    ...create,
    schedule: { kind: "at", at: create.createdAt + 1 },
  }).schedule.at, create.createdAt + 1);
  assert.equal(validateDomainServiceParams("cron.job.create", {
    ...create,
    enabled: false,
    schedule: { kind: "at", at: create.createdAt },
  }).enabled, false);

  const update = VALID_PARAMS.get("cron.job.update");
  for (const patch of [{ threadPolicy: "new", threadId: "thread-1" }]) {
    expectCode(() => validateDomainServiceParams("cron.job.update", {
      ...update, patch,
    }), "INVALID_PARAMS");
  }
  for (const patch of [
    { threadPolicy: "new", threadId: null },
    { threadPolicy: "continue", threadId: null },
    { threadPolicy: "continue", threadId: "thread-1" },
    { threadPolicy: "new" },
    { threadPolicy: "continue" },
    { threadId: null },
    { threadId: "thread-1" },
  ]) {
    assert.deepEqual(validateDomainServiceParams("cron.job.update", {
      ...update, patch,
    }).patch, patch);
  }
});

test("嵌套 schedule 也必须是 data-only plain object，验证过程不执行 getter", () => {
  let reads = 0;
  const schedule = {};
  Object.defineProperties(schedule, {
    kind: { enumerable: true, value: "at" },
    at: { enumerable: true, get() { reads += 1; return 20_000; } },
  });
  expectCode(() => validateDomainServiceParams("cron.job.create", {
    ...VALID_PARAMS.get("cron.job.create"), schedule,
  }), "INVALID_PARAMS");
  assert.equal(reads, 0);
});

test("完整 request envelope exact 校验且 64KiB JSONL frame inclusive、+1 拒绝", () => {
  assert.deepEqual(
    validateDomainServiceRequest(request("kanban.board.get", { boardId: BOARD_ID })),
    request("kanban.board.get", { boardId: BOARD_ID }),
  );
  expectCode(() => validateDomainServiceRequest(request(
    "kanban.board.get", { boardId: BOARD_ID }, { extra: true },
  )), "INVALID_PARAMS");
  expectCode(() => validateDomainServiceRequest(request(
    "kanban.board.get", { boardId: BOARD_ID }, { token: undefined },
  )), "INVALID_PARAMS");

  const baseParams = { ...VALID_PARAMS.get("kanban.card.create"), body: "" };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(request("kanban.card.create", baseParams))}\n`);
  const fitting = { ...baseParams, body: "x".repeat(MAX_FRAME_BYTES - baseBytes) };
  assert.equal(Buffer.byteLength(`${JSON.stringify(request("kanban.card.create", fitting))}\n`), MAX_FRAME_BYTES);
  validateDomainServiceRequest(request("kanban.card.create", fitting));
  expectCode(() => validateDomainServiceRequest(request("kanban.card.create", {
    ...fitting, body: `${fitting.body}x`,
  })), "REQUEST_TOO_LARGE");
});

test("ContentMeta 由完整 UTF-8 内容生成，preview 不拆 code point 且不超过 512 bytes", () => {
  const text = `${"a".repeat(MAX_CONTENT_PREVIEW_BYTES - 1)}😀tail`;
  const meta = createContentMeta(text);
  assert.equal(meta.byteLength, Buffer.byteLength(text));
  assert.equal(meta.sha256, crypto.createHash("sha256").update(text).digest("hex"));
  assert.equal(Buffer.byteLength(meta.preview) <= MAX_CONTENT_PREVIEW_BYTES, true);
  assert.equal(meta.preview.isWellFormed(), true);
  assert.deepEqual(createContentMeta(""), {
    byteLength: 0, sha256: SHA_EMPTY, preview: "",
  });
});

test("Card/Comment/Cron Job DTO 只携带 content meta，raw content 与多余字段失败", () => {
  const valid = [
    ["kanban.card.get", { card: card() }],
    ["kanban.comment.list", { comments: [comment()], nextCursor: null, hasMore: false }],
    ["cron.job.get", { job: cronJob() }],
  ];
  for (const [method, result] of valid) validateDomainServiceResult(method, result);
  expectCode(() => validateDomainServiceResult("kanban.card.get", {
    card: { ...card(), body: "secret body" },
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.comment.list", {
    comments: [{ ...comment(), body: "secret comment" }], nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: { ...cronJob(), prompt: "secret prompt" },
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.get", {
    card: { ...card(), bodyMeta: contentMeta({ preview: "😀".repeat(129) }) },
  }), "DOMAIN_RESPONSE_INVALID");
});

test("Cron Job DTO 复核 enabled/nextRunAt 与 schedule(updatedAt) 真值", () => {
  validateDomainServiceResult("cron.job.get", {
    job: cronJob({ enabled: true, nextRunAt: 1_000 }),
  });
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: cronJob({ enabled: false, nextRunAt: 1_000 }),
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: cronJob({ enabled: true, nextRunAt: 61_000 }),
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: cronJob({
      enabled: true,
      schedule: { kind: "at", at: 50 },
      nextRunAt: null,
    }),
  }), "DOMAIN_RESPONSE_INVALID");
});

test("每个 method 接受 method-specific exact result DTO", () => {
  const run = workRun();
  const dispatch = { run, card: card({ status: "queued" }), link: cardRunLink() };
  const retryDispatch = {
    run: workRun({ retryOf: PRIOR_RUN_ID }),
    card: card({ status: "queued" }),
    link: cardRunLink({ retryOf: PRIOR_RUN_ID }),
  };
  const chunk = {
    text: "body", offsetBytes: 0, totalBytes: 4, sha256: SHA_BODY,
    nextCursor: null, hasMore: false,
  };
  const valid = new Map([
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
        status: "done",
        completion: { mode: "manual", runId: null, actorId: "user-1", at: 105, note: null },
        updatedAt: 105,
      }),
      audit: auditEvent(),
    }],
    ["kanban.comment.list", { comments: [comment()], nextCursor: null, hasMore: false }],
    ["kanban.comment.body.read", chunk],
    ["kanban.comment.add", { comment: comment() }],
    ["kanban.attachment.list", {
      attachments: [attachment()], nextCursor: null, hasMore: false,
    }],
    ["kanban.artifact.list", { artifacts: [artifact()], nextCursor: null, hasMore: false }],
    ["kanban.audit.list", { auditEvents: [auditEvent()], nextCursor: null, hasMore: false }],
    ["kanban.run.list", { runs: [run], nextCursor: null, hasMore: false }],
    ["kanban.run.dispatch", dispatch],
    ["kanban.run.retry", retryDispatch],
    ["cron.job.list", { jobs: [cronJob()], nextCursor: null, hasMore: false }],
    ["cron.job.get", { job: cronJob() }],
    ["cron.job.prompt.read", chunk],
    ["cron.job.create", { job: cronJob() }],
    ["cron.job.update", { job: cronJob({ updatedAt: 110 }) }],
    ["cron.job.delete", { jobId: JOB_ID, deleted: true }],
    ["cron.job.enabled.set", { job: cronJob({ updatedAt: 112 }) }],
    ["cron.run.list", {
      runs: [cronRunListItem({
        run: workRun({
          source: "cron", sourceId: JOB_ID, status: "failed",
          startedAt: 100, finishedAt: 200, errorCode: "FAILED",
        }),
      })],
      nextCursor: null, hasMore: false,
    }],
    ["cron.run.trigger", { run: workRun({ source: "cron", sourceId: JOB_ID }) }],
    ["cron.run.retry", {
      run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: PRIOR_RUN_ID }),
    }],
  ]);
  assert.deepEqual([...valid.keys()], [...DOMAIN_SERVICE_METHODS]);
  const contextual = new Set([
    "kanban.run.list", "kanban.run.dispatch", "kanban.run.retry",
    "cron.run.list", "cron.run.trigger", "cron.run.retry",
  ]);
  for (const [method, result] of valid) {
    const params = contextual.has(method) ? VALID_PARAMS.get(method) : undefined;
    assert.deepEqual(validateDomainServiceResult(method, result, params), result, method);
  }
});

test("cron.run.list 使用 exact run/kind/createdAt item 并锁定 retry lineage", () => {
  const params = { ...VALID_PARAMS.get("cron.run.list"), status: null };
  const result = {
    runs: [
      cronRunListItem(),
      cronRunListItem({ kind: "manual", createdAt: Number.MAX_SAFE_INTEGER }),
      cronRunListItem({
        kind: "retry",
        run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: PRIOR_RUN_ID }),
      }),
    ],
    nextCursor: null,
    hasMore: false,
  };
  assert.deepEqual(validateDomainServiceResult("cron.run.list", result, params), result);

  const invalidItems = [
    workRun({ source: "cron", sourceId: JOB_ID }),
    { ...cronRunListItem(), extra: true },
    { ...cronRunListItem(), kind: undefined },
    { ...cronRunListItem(), kind: "automatic" },
    { ...cronRunListItem(), createdAt: -1 },
    cronRunListItem({ run: workRun() }),
    cronRunListItem({
      run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: PRIOR_RUN_ID }),
    }),
    cronRunListItem({ kind: "retry" }),
  ];
  for (const item of invalidItems) {
    expectCode(() => validateDomainServiceResult("cron.run.list", {
      runs: [item], nextCursor: null, hasMore: false,
    }, params), "DOMAIN_RESPONSE_INVALID");
  }
});

test("run.list direct validator 与 paginator 都按 params 绑定实体和非空 status", () => {
  const cronParams = { ...VALID_PARAMS.get("cron.run.list"), status: null };
  const kanbanParams = VALID_PARAMS.get("kanban.run.list");
  const foreign = cronRunListItem({
    run: workRun({ source: "cron", sourceId: OTHER_JOB_ID }),
  });
  const codec = createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 12) });
  const actions = [
    () => validateDomainServiceResult("cron.run.list", {
      runs: [cronRunListItem()], nextCursor: null, hasMore: false,
    }),
    () => validateDomainServiceResult("cron.run.list", {
      runs: [foreign], nextCursor: null, hasMore: false,
    }, cronParams),
    () => validateDomainServiceResult("cron.run.list", {
      runs: [cronRunListItem()], nextCursor: null, hasMore: false,
    }, { ...cronParams, status: "failed" }),
    () => validateDomainServiceResult("kanban.run.list", {
      runs: [workRun()], nextCursor: null, hasMore: false,
    }),
    () => validateDomainServiceResult("kanban.run.list", {
      runs: [workRun({ sourceId: OTHER_CARD_ID })], nextCursor: null, hasMore: false,
    }, kanbanParams),
    () => validateDomainServiceResult("kanban.run.list", {
      runs: [workRun()], nextCursor: null, hasMore: false,
    }, { ...kanbanParams, status: "failed" }),
    () => paginateDomainServiceItems({
      method: "cron.run.list",
      params: cronParams,
      entries: [{ key: "0001", item: foreign }],
      cursorCodec: codec,
      responseId: "cron-list-response",
    }),
    () => paginateDomainServiceItems({
      method: "cron.run.list",
      params: { ...cronParams, status: "failed" },
      entries: [{ key: "0001", item: cronRunListItem() }],
      cursorCodec: codec,
      responseId: "cron-status-response",
    }),
    () => paginateDomainServiceItems({
      method: "kanban.run.list",
      params: kanbanParams,
      entries: [{ key: "0001", item: workRun({ sourceId: OTHER_CARD_ID }) }],
      cursorCodec: codec,
      responseId: "kanban-list-response",
    }),
    () => paginateDomainServiceItems({
      method: "kanban.run.list",
      params: { ...kanbanParams, status: "failed" },
      entries: [{ key: "0001", item: workRun() }],
      cursorCodec: codec,
      responseId: "kanban-status-response",
    }),
  ];
  const codes = actions.map((action) => {
    try {
      action();
      return null;
    } catch (error) {
      return error?.code;
    }
  });
  assert.deepEqual(codes, Array(actions.length).fill("DOMAIN_RESPONSE_INVALID"));
});

test("method-specific Run result 用已验证 params 锁定 sourceId 与 retry lineage", () => {
  const validDispatch = {
    run: workRun(), card: card({ status: "queued" }), link: cardRunLink(),
  };
  expectCode(() => validateDomainServiceResult(
    "kanban.run.dispatch", validDispatch,
  ), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.run.dispatch", {
    ...validDispatch,
    run: workRun({ retryOf: PRIOR_RUN_ID }),
    link: cardRunLink({ retryOf: PRIOR_RUN_ID }),
  }, VALID_PARAMS.get("kanban.run.dispatch")), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.run.retry", validDispatch,
    VALID_PARAMS.get("kanban.run.retry")), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.run.trigger", {
    run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: PRIOR_RUN_ID }),
  }, VALID_PARAMS.get("cron.run.trigger")), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.run.retry", {
    run: workRun({ source: "cron", sourceId: JOB_ID, retryOf: "wrong-prior" }),
  }, VALID_PARAMS.get("cron.run.retry")), "DOMAIN_RESPONSE_INVALID");
});

test("result DTO 拒绝 missing、undefined、unknown、非 plain 与非法 cross-field", () => {
  expectCode(() => validateDomainServiceResult("kanban.board.get", {}), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.board.get", { board: undefined }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.board.get", {
    board: { ...board(), storageKey: "internal" },
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.board.get", new (class Result {
    constructor() { this.board = board(); }
  })()), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.get", {
    card: card({ status: "done", completion: null }),
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("cron.job.get", {
    job: cronJob({ threadPolicy: "new", threadId: "thread-1" }),
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("unknown.method", {}), "DOMAIN_RESPONSE_INVALID");
});

test("Completion validator 在 descriptor/plain 检查前不读取 mode getter", () => {
  let reads = 0;
  const completion = {};
  Object.defineProperties(completion, {
    mode: { enumerable: true, get() { reads += 1; return "manual"; } },
    runId: { enumerable: true, value: null },
    actorId: { enumerable: true, value: "user-1" },
    at: { enumerable: true, value: 105 },
    note: { enumerable: true, value: null },
  });
  expectCode(() => validateDomainServiceResult("kanban.card.get", {
    card: card({ status: "done", completion }),
  }), "DOMAIN_RESPONSE_INVALID");
  assert.equal(reads, 0);
});

test("list result 拒绝 sparse array 与数组额外属性", () => {
  const sparse = new Array(1);
  expectCode(() => validateDomainServiceResult("kanban.board.list", {
    boards: sparse, nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
  const decorated = [board()];
  decorated.extra = true;
  expectCode(() => validateDomainServiceResult("kanban.board.list", {
    boards: decorated, nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
});

test("WorkRun DTO 复用 Product Store contract 且额外要求所有字段显式存在", () => {
  const params = VALID_PARAMS.get("kanban.run.list");
  const accepted = validateDomainServiceResult("kanban.run.list", {
    runs: [workRun({
      id: "r".repeat(128),
      idempotencyKey: "i".repeat(256),
      workspace: "w".repeat(4_096),
      codexThreadId: "t".repeat(256),
      codexTurnId: "u".repeat(256),
      resultSummary: "s".repeat(16 * 1_024),
      retryOf: "p".repeat(128),
    })],
    nextCursor: null,
    hasMore: false,
  }, params);
  assert.equal(accepted.runs[0].id.length, 128);
  const missingNullable = workRun();
  delete missingNullable.resultSummary;
  expectCode(() => validateDomainServiceResult("kanban.run.list", {
    runs: [missingNullable], nextCursor: null, hasMore: false,
  }, params), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.run.list", {
    runs: [workRun({ status: "failed", finishedAt: 200, errorCode: null })],
    nextCursor: null, hasMore: false,
  }, params), "DOMAIN_RESPONSE_INVALID");
  const invalidRuns = [
    workRun({ id: "run/id" }),
    workRun({ id: "r".repeat(129) }),
    workRun({ source: "kanban\0" }),
    workRun({ sourceId: "card-1" }),
    workRun({ idempotencyKey: "x".repeat(257) }),
    workRun({ idempotencyKey: "dispatch\0key" }),
    workRun({ profileId: "profile-1" }),
    workRun({ workspace: "w".repeat(4_097) }),
    workRun({ workspace: "\uD800" }),
    workRun({ codexThreadId: "t".repeat(257) }),
    workRun({ codexThreadId: "thread", codexTurnId: "u".repeat(257) }),
    workRun({
      status: "waiting_input", startedAt: 100, waitingRequestId: "q".repeat(129),
    }),
    workRun({ resultSummary: "s".repeat((16 * 1_024) + 1) }),
    workRun({
      status: "failed", startedAt: 100, finishedAt: 200,
      errorCode: "e".repeat(129),
    }),
    workRun({ retryOf: "p".repeat(129) }),
  ];
  for (const run of invalidRuns) {
    expectCode(() => validateDomainServiceResult("kanban.run.list", {
      runs: [run], nextCursor: null, hasMore: false,
    }, params), "DOMAIN_RESPONSE_INVALID");
  }

});

test("current WorkRun 投影可被 Domain Service 边界重复校验", () => {
  const current = workRun({
    source: "cron",
    sourceId: JOB_ID,
    contextSnapshotId: null,
    runtimeSessionRef: null,
    runtimeTurnRef: null,
  });
  delete current.codexThreadId;
  delete current.codexTurnId;
  const params = VALID_PARAMS.get("cron.run.trigger");
  const first = validateDomainServiceResult("cron.run.trigger", { run: current }, params);
  assert.deepEqual(
    validateDomainServiceResult("cron.run.trigger", first, params),
    first,
  );
});

test("ContentChunk 校验字节 offset、hash、cursor/hasMore 和 48KiB item 门禁", () => {
  assert.deepEqual(validateDomainServiceResult("kanban.card.body.read", {
    text: "😀", offsetBytes: 0, totalBytes: 4,
    sha256: crypto.createHash("sha256").update("😀").digest("hex"),
    nextCursor: null, hasMore: false,
  }).text, "😀");
  expectCode(() => validateDomainServiceResult("kanban.card.body.read", {
    text: "😀", offsetBytes: 0, totalBytes: 3, sha256: SHA_BODY,
    nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.body.read", {
    text: "x", offsetBytes: 0, totalBytes: 2, sha256: SHA_BODY,
    nextCursor: null, hasMore: true,
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.body.read", {
    text: "x".repeat(MAX_CONTENT_READ_BYTES + 1), offsetBytes: 0,
    totalBytes: MAX_CONTENT_READ_BYTES + 1, sha256: SHA_BODY,
    nextCursor: null, hasMore: false,
  }), "CONTENT_CHUNK_TOO_LARGE");
  expectCode(() => validateDomainServiceResult("kanban.card.body.read", {
    text: "complete", offsetBytes: 0, totalBytes: 8, sha256: SHA_BODY,
    nextCursor: null, hasMore: false,
  }), "DOMAIN_RESPONSE_INVALID");
  expectCode(() => validateDomainServiceResult("kanban.card.body.read", {
    text: "", offsetBytes: 0, totalBytes: 1, sha256: SHA_BODY,
    nextCursor: "next", hasMore: true,
  }), "DOMAIN_RESPONSE_INVALID");
});

test("48KiB ContentChunk JSONL item inclusive、+1 escaped byte 拒绝", () => {
  const rawLength = 24_500;
  const plain = "x".repeat(rawLength);
  const base = {
    text: plain,
    offsetBytes: 0,
    totalBytes: rawLength,
    sha256: crypto.createHash("sha256").update(plain).digest("hex"),
    nextCursor: null,
    hasMore: false,
  };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
  const escapedCount = MAX_ITEM_BYTES - baseBytes;
  assert.equal(escapedCount > 0 && escapedCount < rawLength, true);
  const exactText = `${"\\".repeat(escapedCount)}${"x".repeat(rawLength - escapedCount)}`;
  const exact = {
    ...base,
    text: exactText,
    sha256: crypto.createHash("sha256").update(exactText).digest("hex"),
  };
  assert.equal(Buffer.byteLength(`${JSON.stringify(exact)}\n`), MAX_ITEM_BYTES);
  validateDomainServiceResult("kanban.card.body.read", exact);

  const oversizedText = `${"\\".repeat(escapedCount + 1)}${
    "x".repeat(rawLength - escapedCount - 1)
  }`;
  const oversized = {
    ...exact,
    text: oversizedText,
    sha256: crypto.createHash("sha256").update(oversizedText).digest("hex"),
  };
  assert.equal(Buffer.byteLength(`${JSON.stringify(oversized)}\n`), MAX_ITEM_BYTES + 1);
  expectCode(() => validateDomainServiceResult(
    "kanban.card.body.read", oversized,
  ), "CONTENT_CHUNK_TOO_LARGE");
});

test("query cursor 为 query-bound HMAC，限制 512 bytes 并拒绝篡改与跨查询", () => {
  const codec = createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 7) });
  const query = { method: "kanban.board.list", params: { profileId: PROFILE_ID, limit: 2 } };
  const cursor = codec.encode({ query, position: "board-2" });
  assert.equal(Buffer.byteLength(cursor) <= MAX_CURSOR_BYTES, true);
  assert.deepEqual(codec.decode(cursor, query), { position: "board-2" });
  const tail = cursor.endsWith("A") ? "B" : "A";
  expectCode(() => codec.decode(`${cursor.slice(0, -1)}${tail}`, query), "INVALID_PARAMS");
  expectCode(() => codec.decode(cursor, {
    method: "kanban.board.list", params: { profileId: "profile-2", limit: 2 },
  }), "INVALID_PARAMS");
});

test("stable paginator 使用唯一 keyset 并使 list response frame 不超过 64KiB", () => {
  const codec = createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 8) });
  const params = { profileId: PROFILE_ID, cursor: null, limit: 100 };
  const entries = [1, 2, 3, 4, 5].map((index) => ({
    key: `000${index}`,
    item: board({
      id: indexedUuid(index),
      slug: `board-${index}`,
      description: String(index).repeat(15 * 1024),
    }),
  }));
  const first = paginateDomainServiceItems({
    method: "kanban.board.list", params, entries, cursorCodec: codec, responseId: "response-1",
  });
  assert.equal(first.boards.length > 0 && first.boards.length < entries.length, true);
  assert.equal(first.hasMore, true);
  assert.equal(Buffer.byteLength(`${JSON.stringify({ id: "response-1", ok: true, result: first })}\n`) <= MAX_FRAME_BYTES, true);
  const second = paginateDomainServiceItems({
    method: "kanban.board.list",
    params: { ...params, cursor: first.nextCursor },
    entries: [{ key: "0000", item: board({ id: indexedUuid(0), slug: "board-0" }) }, ...entries],
    cursorCodec: codec,
    responseId: "response-2",
  });
  assert.deepEqual(
    second.boards.map((item) => item.id),
    entries.slice(first.boards.length).map((entry) => entry.item.id),
  );
  expectCode(() => paginateDomainServiceItems({
    method: "kanban.board.list", params, entries: [entries[0], entries[0]],
    cursorCodec: codec, responseId: "response-3",
  }), "DOMAIN_RESPONSE_INVALID");
});

test("WorkRun IPC 字段界限先于通用 list item 容量门禁", () => {
  const hugeRun = workRun({ idempotencyKey: "x".repeat(MAX_ITEM_BYTES) });
  expectCode(() => validateDomainServiceResult("kanban.run.list", {
    runs: [hugeRun], nextCursor: null, hasMore: false,
  }, VALID_PARAMS.get("kanban.run.list")), "DOMAIN_RESPONSE_INVALID");
});

test("content chunk 使用 UTF-8 byte offset、query-bound cursor 与完整内容 hash", () => {
  const codec = createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 9) });
  const content = "A😀BC";
  const firstParams = { cardId: CARD_ID, cursor: null, maxBytes: 5 };
  const first = chunkDomainContent({
    method: "kanban.card.body.read", params: firstParams, content,
    cursorCodec: codec, responseId: "response-1",
  });
  assert.deepEqual(first, {
    text: "A😀",
    offsetBytes: 0,
    totalBytes: 7,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    nextCursor: first.nextCursor,
    hasMore: true,
  });
  assert.equal(typeof first.nextCursor, "string");
  const cursorState = codec.decode(first.nextCursor, {
    method: "kanban.card.body.read",
    params: { cardId: CARD_ID, maxBytes: 5 },
  }).position.split(":");
  assert.deepEqual(cursorState, ["5", "7", first.sha256]);
  const second = chunkDomainContent({
    method: "kanban.card.body.read",
    params: { ...firstParams, cursor: first.nextCursor },
    content,
    cursorCodec: codec,
    responseId: "response-2",
  });
  assert.deepEqual(second, {
    text: "BC", offsetBytes: 5, totalBytes: 7,
    sha256: first.sha256, nextCursor: null, hasMore: false,
  });
  expectCode(() => chunkDomainContent({
    method: "kanban.comment.body.read",
    params: { commentId: COMMENT_ID, cursor: first.nextCursor, maxBytes: 5 },
    content,
    cursorCodec: codec,
    responseId: "response-3",
  }), "CONTENT_CURSOR_INVALID");
  const tail = first.nextCursor.endsWith("A") ? "B" : "A";
  expectCode(() => chunkDomainContent({
    method: "kanban.card.body.read",
    params: { ...firstParams, cursor: `${first.nextCursor.slice(0, -1)}${tail}` },
    content,
    cursorCodec: codec,
    responseId: "response-tampered",
  }), "CONTENT_CURSOR_INVALID");
  expectCode(() => chunkDomainContent({
    method: "kanban.card.body.read",
    params: { ...firstParams, cursor: first.nextCursor },
    content: "A😀BD",
    cursorCodec: createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 9) }),
    responseId: "response-after-restart",
  }), "RESOURCE_CHANGED");
});

test("chunkDomainContent 按最终 escaped item/response frame 回退并逐页无损前进", () => {
  const codec = createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 11) });
  const content = "\\\"\n\t\r\b\f😀".repeat(4_000);
  const parts = [];
  const cursors = new Set();
  let cursor = null;
  let expectedOffset = 0;
  for (let page = 0; page < 20; page += 1) {
    const params = { cardId: CARD_ID, cursor, maxBytes: MAX_CONTENT_READ_BYTES };
    const result = chunkDomainContent({
      method: "kanban.card.body.read",
      params,
      content,
      cursorCodec: codec,
      responseId: `escaped-${page}`,
    });
    assert.equal(result.offsetBytes, expectedOffset);
    assert.equal(Buffer.byteLength(result.text) <= MAX_CONTENT_READ_BYTES, true);
    assert.equal(Buffer.byteLength(`${JSON.stringify(result)}\n`) <= MAX_ITEM_BYTES, true);
    assert.equal(Buffer.byteLength(`${JSON.stringify({
      id: `escaped-${page}`, ok: true, result,
    })}\n`) <= MAX_FRAME_BYTES, true);
    parts.push(result.text);
    expectedOffset += Buffer.byteLength(result.text);
    if (!result.hasMore) {
      cursor = null;
      break;
    }
    assert.equal(expectedOffset > result.offsetBytes, true);
    assert.equal(cursors.has(result.nextCursor), false);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  assert.equal(cursor, null, "pagination must terminate within the bounded loop");
  assert.equal(parts.length > 1, true, "escaped JSON bytes must force dynamic fallback");
  assert.equal(parts.join(""), content);
});

test("result 与 paginator responseId 也执行最终 JSONL frame 门禁", () => {
  const responseId = "r".repeat(MAX_FRAME_BYTES);
  expectCode(() => paginateDomainServiceItems({
    method: "kanban.board.list",
    params: { profileId: PROFILE_ID, cursor: null, limit: 1 },
    entries: [],
    cursorCodec: createDomainQueryCursorCodec({ secret: Buffer.alloc(32, 10) }),
    responseId,
  }), "RESPONSE_TOO_LARGE");
});

test("stable public error mapping 不泄露内部 message、stack 或字段名", () => {
  const cases = [
    ["KANBAN_OPERATION_ID_CONFLICT", "OPERATION_ID_CONFLICT"],
    ["CRON_OPERATION_EXPIRED", "INVALID_PARAMS"],
    ["KANBAN_BOARD_NOT_FOUND", "KANBAN_BOARD_NOT_FOUND"],
    ["CRON_JOB_NOT_FOUND", "CRON_JOB_NOT_FOUND"],
    ["KANBAN_STATUS_TRANSITION_INVALID", "STATE_CONFLICT"],
    ["WORK_RUN_NOT_FOUND", "WORK_RUN_NOT_FOUND"],
    ["KANBAN_COMMIT_UNCERTAIN", "KANBAN_COMMIT_UNCERTAIN"],
    ["CRON_COMMIT_UNCERTAIN", "CRON_COMMIT_UNCERTAIN"],
    ["RESOURCE_CHANGED", "RESOURCE_CHANGED"],
    ["KANBAN_UNAVAILABLE", "KANBAN_UNAVAILABLE"],
    ["CRON_UNAVAILABLE", "CRON_UNAVAILABLE"],
    ["CRON_RUN_CORRUPT", "CRON_UNAVAILABLE"],
    ["KANBAN_WRITE_FAILED", "SERVICE_UNAVAILABLE"],
    ["totally-internal", "INTERNAL_ERROR"],
  ];
  for (const [internalCode, publicCode] of cases) {
    const internal = new Error("private.path.actorId stack token");
    internal.code = internalCode;
    internal.stack = "private stack";
    const mapped = mapDomainServiceError(internal);
    assert.equal(mapped.code, publicCode);
    assert.equal(typeof mapped.message, "string");
    assert.equal(mapped.message.includes("private"), false);
    assert.equal(mapped.message.includes("actorId"), false);
    assert.equal(Object.isFrozen(mapped), true);
    assert.deepEqual(Object.keys(mapped), ["code", "message"]);
  }
  assert.equal(PUBLIC_MESSAGES.RESOURCE_CHANGED, "资源内容已变更，请重新读取");
  assert.equal(PUBLIC_MESSAGES.KANBAN_CAPACITY, "Kanban 容量已满");
  assert.equal(PUBLIC_MESSAGES.CRON_CAPACITY, "Cron 容量已满");
  assert.equal(PUBLIC_MESSAGES.KANBAN_UNAVAILABLE, "Kanban Service 暂时不可用");
  assert.equal(PUBLIC_MESSAGES.CRON_UNAVAILABLE, "Cron Service 暂时不可用");
});

test("领域错误按容量、输入、状态、unavailable 与 commit-uncertain 固定分类", () => {
  const cases = [
    ["KANBAN_CAPACITY", "KANBAN_CAPACITY", "kanban.card.create"],
    ["KANBAN_CARD_CAPACITY", "KANBAN_CAPACITY", "kanban.card.create"],
    ["CRON_CAPACITY", "CRON_CAPACITY", "cron.job.create"],
    ["CRON_RUN_CAPACITY", "CRON_CAPACITY", "cron.run.trigger"],
    ["KANBAN_TIMESTAMP_INVALID", "INVALID_PARAMS", "kanban.card.create"],
    ["KANBAN_RETRY_TIMESTAMP_INVALID", "INVALID_PARAMS", "kanban.run.retry"],
    ["CRON_TIMESTAMP_INVALID", "INVALID_PARAMS", "cron.job.create"],
    ["KANBAN_OPERATION_EXPIRED", "INVALID_PARAMS", "kanban.board.create"],
    ["CRON_OPERATION_EXPIRED", "INVALID_PARAMS", "cron.job.create"],
    ["KANBAN_CARD_INVALID", "INVALID_PARAMS", "kanban.card.create"],
    ["KANBAN_DISPATCH_INVALID", "INVALID_PARAMS", "kanban.run.dispatch"],
    ["CRON_JOB_INVALID", "INVALID_PARAMS", "cron.job.create"],
    ["CRON_MANUAL_TRIGGER_INVALID", "INVALID_PARAMS", "cron.run.trigger"],
    ["KANBAN_REFERENCE_INVALID", "STATE_CONFLICT", "kanban.card.create"],
    ["KANBAN_RETRY_REFERENCE_INVALID", "STATE_CONFLICT", "kanban.run.retry"],
    ["CRON_REFERENCE_INVALID", "STATE_CONFLICT", "cron.job.create"],
    ["KANBAN_RUN_BINDING_INVALID", "STATE_CONFLICT", "kanban.run.retry"],
    ["KANBAN_RUN_LINK_MISSING", "STATE_CONFLICT", "kanban.run.retry"],
    ["KANBAN_MUTATION_STALE", "STATE_CONFLICT", "kanban.card.update"],
    ["CRON_OVERLAP_QUEUE_FULL", "STATE_CONFLICT", "cron.run.trigger"],
    ["KANBAN_SERVICE_CLOSED", "KANBAN_UNAVAILABLE", "kanban.board.list"],
    ["KANBAN_STORE_CLOSED", "KANBAN_UNAVAILABLE", "kanban.board.list"],
    ["CRON_SCHEDULER_CLOSED", "CRON_UNAVAILABLE", "cron.run.trigger"],
    ["CRON_SCHEDULER_CLOSING", "CRON_UNAVAILABLE", "cron.run.trigger"],
    ["CRON_SCHEDULER_POISONED", "CRON_UNAVAILABLE", "cron.run.trigger"],
    ["CRON_STORE_CLOSED", "CRON_UNAVAILABLE", "cron.job.list"],
    ["CRON_RUN_CORRUPT", "CRON_UNAVAILABLE", "cron.run.trigger"],
    ["PENDING_COMMAND_COMMIT_UNCERTAIN", "KANBAN_COMMIT_UNCERTAIN", "kanban.run.dispatch"],
    ["STORE_COMMIT_UNCERTAIN", "CRON_COMMIT_UNCERTAIN", "cron.job.update"],
    ["SOME_UNKNOWN_DOMAIN_FAILURE", "INTERNAL_ERROR", "kanban.board.get"],
  ];
  for (const [internalCode, publicCode, method] of cases) {
    const error = new Error(`raw private ${internalCode}`);
    error.code = internalCode;
    const mapped = mapDomainServiceError(error, { method });
    assert.equal(mapped.code, publicCode, internalCode);
    assert.equal(JSON.stringify(mapped).includes("raw private"), false);
  }
});

test("error mapping 仅检查 own data descriptor，getter/Proxy 零读取且探测失败 fail closed", () => {
  let codeReads = 0;
  let committedReads = 0;
  const accessor = new Error("raw secret message");
  Object.defineProperties(accessor, {
    code: {
      configurable: true,
      get() { codeReads += 1; return "KANBAN_UNAVAILABLE"; },
    },
    committedUncertain: {
      configurable: true,
      get() { committedReads += 1; return true; },
    },
  });
  assert.deepEqual(mapDomainServiceError(accessor), {
    code: "INTERNAL_ERROR",
    message: "Service 内部请求处理失败",
  });
  assert.equal(codeReads, 0);
  assert.equal(committedReads, 0);

  let proxyReads = 0;
  const hostile = new Proxy({}, {
    get() { proxyReads += 1; throw new Error("raw proxy getter secret"); },
    getOwnPropertyDescriptor() { throw new Error("raw descriptor trap secret"); },
  });
  assert.deepEqual(mapDomainServiceError(hostile), {
    code: "INTERNAL_ERROR",
    message: "Service 内部请求处理失败",
  });
  assert.equal(proxyReads, 0);

  const commit = new Error("raw commit secret");
  commit.code = "STORE_COMMIT_UNCERTAIN";
  const hostileContext = new Proxy({}, {
    get() { proxyReads += 1; throw new Error("raw context getter secret"); },
    getOwnPropertyDescriptor() { throw new Error("raw context descriptor secret"); },
    getPrototypeOf() { throw new Error("raw context descriptor secret"); },
  });
  assert.deepEqual(mapDomainServiceError(commit, hostileContext), {
    code: "INTERNAL_ERROR",
    message: "Service 内部请求处理失败",
  });
  assert.equal(proxyReads, 0);
});

test("协议 error helper 不含直接 error.code/committedUncertain 读取", () => {
  const source = fs.readFileSync(path.join(
    ROOT, "app", "agent-service", "domain-service-protocol.js",
  ), "utf8");
  assert.equal(source.includes("error?.code"), false);
  assert.equal(source.includes("error.committedUncertain"), false);

  let codeReads = 0;
  const hostileError = new Error("raw paginator secret");
  Object.defineProperty(hostileError, "code", {
    get() { codeReads += 1; return "RESPONSE_TOO_LARGE"; },
  });
  const hostileCursor = new Proxy({}, {
    get() { throw hostileError; },
  });
  expectCode(() => paginateDomainServiceItems({
    method: "kanban.board.list",
    params: { profileId: PROFILE_ID, cursor: null, limit: 2 },
    entries: [
      { key: "0001", item: board() },
      { key: "0002", item: board({ id: OTHER_CARD_ID, slug: "other-board" }) },
    ],
    cursorCodec: { encode: () => hostileCursor, decode: () => ({ position: "0001" }) },
    responseId: "hostile-paginator",
  }), "DOMAIN_RESPONSE_INVALID");
  assert.equal(codeReads, 0);
});

test("generic STORE_COMMIT_UNCERTAIN 由 method domain 映射为不可盲重试的固定领域码", () => {
  const internal = new Error("private commit path");
  internal.code = "STORE_COMMIT_UNCERTAIN";
  assert.deepEqual(mapDomainServiceError(internal, { method: "kanban.run.dispatch" }), {
    code: "KANBAN_COMMIT_UNCERTAIN",
    message: "Kanban 提交结果不确定，请刷新后确认",
  });
  assert.deepEqual(mapDomainServiceError(internal, { method: "cron.job.update" }), {
    code: "CRON_COMMIT_UNCERTAIN",
    message: "Cron 提交结果不确定，请刷新后确认",
  });
  assert.equal(mapDomainServiceError(internal).code, "INTERNAL_ERROR");
});

test("返回对象安全保留 __proto__ own data property 且不污染原型", () => {
  const description = JSON.parse('{"__proto__":"safe"}').__proto__;
  const value = board({ description });
  const output = validateDomainServiceResult("kanban.board.get", { board: value });
  assert.equal(output.board.description, "safe");
  assert.equal({}.polluted, undefined);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok - ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    }
  }
  if (failed > 0) {
    process.stderr.write(`${failed}/${tests.length} tests failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${tests.length}/${tests.length} tests passed\n`);
  }
})();
