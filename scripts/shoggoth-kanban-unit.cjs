#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { atomicWritePrivateFile } = require(path.join(
  ROOT, "app", "agent-service", "private-file.js",
));

let NativeKanbanStore;
let validateContainer;
let moduleLoadError = null;
try {
  ({ NativeKanbanStore, validateContainer } = require(path.join(
    ROOT, "app", "agent-service", "native-kanban-store.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
const fixtureRoots = new Set();
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths(prefix = "shoggoth-native-kanban-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
}

function fixture(options = {}) {
  const paths = options.paths || fixturePaths();
  const profiles = options.profiles || new Set(["profile-a", "profile-b"]);
  const runs = options.runs || new Map();
  let now = options.now ?? 1_000;
  const store = new NativeKanbanStore({
    paths,
    now: () => now,
    profileExists: options.profileExists || ((id) => profiles.has(id)),
    getRun: options.getRun || ((id) => runs.get(id) || null),
    isSensitiveValue: options.isSensitiveValue,
    atomicWrite: options.atomicWrite,
    capacities: options.capacities,
    randomUUID: options.randomUUID,
  });
  return {
    paths,
    profiles,
    runs,
    store,
    setNow(value) { now = value; },
  };
}

function createBoard(store, overrides = {}) {
  return store.createBoard({
    operationId: "board-op-1",
    profileId: "profile-a",
    slug: "main",
    name: "Main",
    description: null,
    createdAt: 1_000,
    ...overrides,
  });
}

function createCard(store, board, overrides = {}) {
  return store.createCard({
    operationId: "card-op-1",
    boardId: board.id,
    profileId: "profile-a",
    title: "Implement native Kanban",
    body: null,
    status: "backlog",
    position: 0,
    createdAt: 1_000,
    ...overrides,
  });
}

function runFor(card, overrides = {}) {
  return {
    id: "run-1",
    source: "kanban",
    sourceId: card.id,
    profileId: card.profileId,
    status: "running",
    retryOf: null,
    ...overrides,
  };
}

test("NativeKanbanStore 模块与严格 schema validator 可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof NativeKanbanStore, "function");
  assert.equal(typeof validateContainer, "function");
});

test("新建 Native Kanban 容器使用 schema v4 且 operation 带完整性摘要", () => {
  const ctx = fixture();
  ctx.store.open();
  createBoard(ctx.store);
  ctx.store.close();
  const raw = JSON.parse(fs.readFileSync(
    path.join(ctx.paths.stateDir, "native-kanban.json"), "utf8",
  ));
  assert.equal(raw.version, 4);
  assert.match(raw.operations["board-op-1"].integrity, /^[a-f0-9]{64}$/u);
});

test("schema v2 显式迁移到 v4 并为历史 replay snapshot 建立完整性摘要", () => {
  const ctx = fixture({ now: 5_000 });
  ctx.store.open();
  const board = createBoard(ctx.store, { createdAt: 5_000 });
  ctx.store.close();
  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.version = 2;
  for (const operation of Object.values(raw.operations)) delete operation.integrity;
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const restarted = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 5_000,
  }).store;
  restarted.open();
  assert.equal(restarted.getBoard(board.id).id, board.id);
  restarted.close();
  const migrated = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  assert.equal(migrated.version, 4);
  assert.match(migrated.operations["board-op-1"].integrity, /^[a-f0-9]{64}$/u);
});

test("带持久高水位的过渡 v1 显式迁移到 v4 并保留门禁", () => {
  const ctx = fixture({ now: 5_000 });
  ctx.store.open();
  const board = createBoard(ctx.store, { createdAt: 5_000 });
  ctx.store.close();
  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.version = 1;
  for (const operation of Object.values(raw.operations)) delete operation.integrity;
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const restarted = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 1_000,
  }).store;
  restarted.open();
  assert.equal(restarted.getBoard(board.id).id, board.id);
  restarted.close();
  const migrated = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  assert.equal(migrated.version, 4);
  assert.equal(migrated.clockHighWaterMs, 5_000);
});

test("旧 v1 shape 用可信 open time 显式迁移且 operation replay 可恢复", () => {
  const ctx = fixture({ now: 1_000 });
  ctx.store.open();
  const board = createBoard(ctx.store);
  ctx.store.close();
  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.version = 1;
  for (const operation of Object.values(raw.operations)) delete operation.integrity;
  delete raw.clockHighWaterMs;
  delete raw.idempotencyFloorMs;
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const restarted = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 2_000,
  }).store;
  restarted.open();
  assert.deepEqual(restarted.createBoard({
    operationId: "board-op-1", profileId: "profile-a", slug: "main",
    name: "Main", description: null, createdAt: 1_000,
  }), board);
  restarted.close();
  const migrated = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  assert.equal(migrated.version, 4);
  assert.equal(migrated.clockHighWaterMs, 2_000);
  assert.equal(migrated.idempotencyFloorMs, 0);
});

test("current/v3/v2/带高水位 v1 均拒绝 floor 高于 clock high-water", () => {
  assert.throws(
    () => validateContainer({
      version: 4,
      revision: 0,
      clockHighWaterMs: 10,
      idempotencyFloorMs: 11,
      boards: {},
      cards: {},
      comments: {},
      attachments: {},
      artifacts: {},
      cardRunLinks: {},
      auditEvents: {},
      operations: {},
    }),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );

  for (const version of [3, 2, 1]) {
    const ctx = fixture({ now: 5_000 });
    ctx.store.open();
    createBoard(ctx.store, { createdAt: 5_000 });
    ctx.store.close();
    const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
    const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    raw.version = version;
    raw.idempotencyFloorMs = raw.clockHighWaterMs + 1;
    for (const operation of Object.values(raw.operations)) delete operation.integrity;
    fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    const reopened = fixture({
      paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 1_000,
    }).store;
    assert.throws(
      () => reopened.open(),
      (error) => error.code === "KANBAN_STORE_CORRUPT",
      `schema v${version}`,
    );
  }
});

test("Board/Card 使用 0600 原子私有文件、operationId 幂等并跨重启恢复", () => {
  const ctx = fixture();
  ctx.store.open();
  const boardInput = {
    operationId: "board-op-1", profileId: "profile-a", slug: "main",
    name: "Main", description: null, createdAt: 1_000,
  };
  const board = ctx.store.createBoard(boardInput);
  assert.deepEqual(ctx.store.createBoard(boardInput), board);
  assert.throws(
    () => ctx.store.createBoard({ ...boardInput, name: "Other" }),
    (error) => error.code === "KANBAN_OPERATION_ID_CONFLICT",
  );
  const card = createCard(ctx.store, board);
  assert.equal(card.boardId, board.id);
  assert.equal(card.profileId, board.profileId);
  assert.equal(card.status, "backlog");
  assert.equal(card.archivedAt, null);
  assert.equal(fs.statSync(path.join(ctx.paths.stateDir, "native-kanban.json")).mode & 0o777, 0o600);
  ctx.store.close();

  const restarted = fixture({ paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs }).store;
  restarted.open();
  assert.deepEqual(restarted.createBoard(boardInput), board, "operation replay 必须跨重启保留");
  assert.deepEqual(restarted.getBoard(board.id), board);
  assert.deepEqual(restarted.getCard(card.id), card);
  assert.deepEqual(restarted.listBoards(), [board]);
  assert.deepEqual(restarted.listCards({ boardId: board.id }), [card]);
  restarted.close();
});

test("Profile/Board/Card/Run 引用严格校验且 CardRun retryOf 保留旧链路", () => {
  const ctx = fixture();
  ctx.store.open();
  assert.throws(
    () => createBoard(ctx.store, { operationId: "missing-profile", profileId: "missing" }),
    (error) => error.code === "KANBAN_REFERENCE_INVALID",
  );
  const board = createBoard(ctx.store);
  assert.throws(
    () => createCard(ctx.store, board, { operationId: "wrong-profile", profileId: "profile-b" }),
    (error) => error.code === "KANBAN_REFERENCE_INVALID",
  );
  const card = createCard(ctx.store, board);

  ctx.runs.set("run-1", runFor(card));
  const first = ctx.store.linkCardRun({
    operationId: "link-run-1", cardId: card.id, runId: "run-1", retryOf: null, createdAt: 1_001,
  });
  ctx.runs.set("run-2", runFor(card, { id: "run-2", retryOf: "run-1" }));
  const retry = ctx.store.linkCardRun({
    operationId: "link-run-2", cardId: card.id, runId: "run-2", retryOf: "run-1", createdAt: 1_002,
  });
  assert.notEqual(retry.id, first.id);
  assert.deepEqual(ctx.store.listCardRunLinks(card.id).map((link) => link.runId), ["run-1", "run-2"]);
  assert.equal(ctx.store.getCardRunLinkByRunId("run-1").id, first.id);

  ctx.runs.set("bad-run", runFor(card, { id: "bad-run", profileId: "profile-b" }));
  assert.throws(
    () => ctx.store.linkCardRun({
      operationId: "bad-link", cardId: card.id, runId: "bad-run", retryOf: null, createdAt: 1_003,
    }),
    (error) => error.code === "KANBAN_REFERENCE_INVALID",
  );
  ctx.store.close();
});

test("Comment/Attachment/Artifact 均为独立实体且 Artifact 必须引用本卡已链接 Run", () => {
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  const card = createCard(ctx.store, board);
  ctx.runs.set("run-1", runFor(card));
  ctx.store.linkCardRun({
    operationId: "link-run-1", cardId: card.id, runId: "run-1", retryOf: null, createdAt: 1_001,
  });
  const comment = ctx.store.addComment({
    operationId: "comment-1", cardId: card.id, authorType: "human", authorId: "user-1",
    body: "Please verify restart recovery.", createdAt: 1_002,
  });
  const attachment = ctx.store.addAttachment({
    operationId: "attachment-1", cardId: card.id, name: "input.txt", mimeType: "text/plain",
    sizeBytes: 12, sha256: "a".repeat(64), storageKey: "attachments/input.txt", createdAt: 1_003,
  });
  const artifact = ctx.store.addArtifact({
    operationId: "artifact-1", cardId: card.id, runId: "run-1", name: "report.json",
    kind: "file", mimeType: "application/json", sizeBytes: 24, sha256: "b".repeat(64),
    storageKey: "artifacts/report.json", createdAt: 1_004,
  });
  assert.deepEqual(ctx.store.listComments(card.id), [comment]);
  const fetchedComment = ctx.store.getComment(comment.id);
  assert.deepEqual(fetchedComment, comment);
  fetchedComment.body = "mutated outside Store";
  assert.equal(ctx.store.getComment(comment.id).body, comment.body);
  assert.equal(ctx.store.getComment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), null);
  assert.throws(
    () => ctx.store.getComment("not-a-uuid"),
    (error) => error.code === "KANBAN_COMMENT_INVALID",
  );
  assert.deepEqual(ctx.store.listAttachments(card.id), [attachment]);
  assert.deepEqual(ctx.store.listArtifacts(card.id), [artifact]);
  assert.throws(
    () => ctx.store.addArtifact({
      operationId: "artifact-bad", cardId: card.id, runId: "run-unlinked", name: "bad",
      kind: "file", mimeType: null, sizeBytes: 0, sha256: "c".repeat(64),
      storageKey: "artifacts/bad", createdAt: 1_005,
    }),
    (error) => error.code === "KANBAN_REFERENCE_INVALID",
  );
  ctx.store.close();
  assert.throws(
    () => ctx.store.getComment(comment.id),
    (error) => error.code === "KANBAN_STORE_CLOSED",
  );
});

test("Agent 只能 request-complete；Product 需完成 Run，人工 done 留下标记和审计", () => {
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  const card = createCard(ctx.store, board);
  ctx.runs.set("run-1", runFor(card));
  ctx.store.linkCardRun({
    operationId: "link-run-1", cardId: card.id, runId: "run-1", retryOf: null, createdAt: 1_001,
  });
  ctx.store.setCardStatus({
    operationId: "queue-card", cardId: card.id, status: "queued",
    actor: "product", actorId: "dispatcher", createdAt: 1_002,
  });
  ctx.store.setCardStatus({
    operationId: "run-card", cardId: card.id, status: "running",
    actor: "product", actorId: "dispatcher", createdAt: 1_003,
  });
  assert.equal(ctx.store.completeCard, undefined, "Store 不暴露可伪造 actor 的通用 done 入口");
  assert.equal(typeof ctx.store.completeCardByProduct, "function");
  assert.equal(typeof ctx.store.completeCardManually, "function");
  const requested = ctx.store.requestCardCompletion({
    operationId: "request-done", cardId: card.id, runId: "run-1", createdAt: 1_004,
  });
  assert.equal(requested.completionRequest.runId, "run-1");
  assert.throws(
    () => ctx.store.completeCardByProduct({
      operationId: "product-too-early", cardId: card.id, actorId: "product-core",
      runId: "run-1", createdAt: 1_005,
    }),
    (error) => error.code === "KANBAN_RUN_NOT_COMPLETED",
  );
  ctx.runs.set("run-1", { ...ctx.runs.get("run-1"), status: "completed" });
  const done = ctx.store.completeCardByProduct({
    operationId: "product-done", cardId: card.id, actorId: "product-core",
    runId: "run-1", createdAt: 1_006,
  });
  assert.equal(done.status, "done");
  assert.deepEqual(done.completion, { mode: "run", runId: "run-1", actorId: "product-core", at: 1_006 });
  ctx.store.close();

  const manualCtx = fixture();
  manualCtx.store.open();
  const manualBoard = createBoard(manualCtx.store);
  const manualCard = createCard(manualCtx.store, manualBoard);
  const manualDone = manualCtx.store.completeCardManually({
    operationId: "human-done", cardId: manualCard.id, actorId: "user-1",
    note: "Accepted manually", createdAt: 1_010,
  });
  assert.equal(manualDone.status, "done");
  assert.deepEqual(manualDone.completion, {
    mode: "manual", runId: null, actorId: "user-1", at: 1_010, note: "Accepted manually",
  });
  const audits = manualCtx.store.listAuditEvents(manualCard.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].kind, "manual_completion");
  assert.equal(audits[0].runId, null);
  manualCtx.store.close();
});

test("manual completion 必须有且仅有一条字段完全匹配的审计反向证据", () => {
  const mutations = [
    (raw) => { raw.auditEvents = {}; },
    (raw) => {
      const [audit] = Object.values(raw.auditEvents);
      audit.actorId = "tampered-user";
    },
    (raw) => {
      const [audit] = Object.values(raw.auditEvents);
      const duplicateId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      raw.auditEvents[duplicateId] = { ...audit, id: duplicateId };
    },
  ];
  for (const mutate of mutations) {
    const ctx = fixture();
    ctx.store.open();
    const board = createBoard(ctx.store);
    const card = createCard(ctx.store, board);
    ctx.store.completeCardManually({
      operationId: "human-done",
      cardId: card.id,
      actorId: "user-1",
      note: "Accepted manually",
      createdAt: 1_010,
    });
    ctx.store.close();
    const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
    const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    mutate(raw);
    fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    const reopened = fixture({
      paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs,
    }).store;
    assert.throws(
      () => reopened.open(),
      (error) => error.code === "KANBAN_STORE_CORRUPT",
    );
  }
});

test("状态机拒绝非法跃迁，updateCard 不能绕过受管状态", () => {
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  const card = createCard(ctx.store, board);
  assert.throws(
    () => ctx.store.setCardStatus({
      operationId: "skip-to-running", cardId: card.id, status: "running",
      actor: "human", actorId: "user-1", createdAt: 1_001,
    }),
    (error) => error.code === "KANBAN_STATUS_TRANSITION_INVALID",
  );
  assert.throws(
    () => ctx.store.updateCard({
      operationId: "patch-status", cardId: card.id, patch: { status: "done" }, createdAt: 1_001,
    }),
    (error) => error.code === "KANBAN_CARD_INVALID",
  );
  const updated = ctx.store.updateCard({
    operationId: "patch-card", cardId: card.id,
    patch: { title: "Updated", body: "Body", position: 50 }, createdAt: 1_002,
  });
  assert.equal(updated.title, "Updated");
  assert.equal(updated.status, "backlog");
  const triage = ctx.store.setCardStatus({
    operationId: "move-to-triage", cardId: card.id, status: "triage",
    actor: "human", actorId: "user-1", createdAt: 1_003,
  });
  assert.equal(triage.status, "triage");
  assert.equal(ctx.store.setCardStatus({
    operationId: "promote-triage", cardId: card.id, status: "backlog",
    actor: "human", actorId: "user-1", createdAt: 1_004,
  }).status, "backlog");
  ctx.store.close();
});

test("建卡只能从 triage/backlog 开始，完成请求绑定当前活动 Run 且离开活动态后失效", () => {
  const generatedIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "00000000-0000-4000-8000-000000000001",
  ];
  const ctx = fixture({ randomUUID: () => generatedIds.shift() });
  ctx.store.open();
  const board = createBoard(ctx.store);
  assert.throws(
    () => createCard(ctx.store, board, { operationId: "create-running", status: "running" }),
    (error) => error.code === "KANBAN_CARD_INVALID",
  );
  const triage = createCard(ctx.store, board, {
    operationId: "create-triage", status: "triage", position: 1,
  });
  assert.equal(triage.status, "triage");
  const card = createCard(ctx.store, board);
  ctx.runs.set("run-1", runFor(card));
  ctx.store.linkCardRun({
    operationId: "link-run-1", cardId: card.id, runId: "run-1", retryOf: null, createdAt: 1_004,
  });
  ctx.store.setCardStatus({
    operationId: "queue-card", cardId: card.id, status: "queued",
    actor: "product", actorId: "dispatcher", createdAt: 1_002,
  });
  ctx.store.setCardStatus({
    operationId: "run-card", cardId: card.id, status: "running",
    actor: "product", actorId: "dispatcher", createdAt: 1_003,
  });
  ctx.runs.set("run-2", runFor(card, { id: "run-2", retryOf: "run-1" }));
  ctx.store.linkCardRun({
    operationId: "link-run-2", cardId: card.id, runId: "run-2", retryOf: "run-1", createdAt: 1_004,
  });
  assert.throws(
    () => ctx.store.requestCardCompletion({
      operationId: "request-stale-run", cardId: card.id, runId: "run-1", createdAt: 1_004,
    }),
    (error) => error.code === "KANBAN_REFERENCE_INVALID",
  );
  ctx.store.requestCardCompletion({
    operationId: "request-run-2", cardId: card.id, runId: "run-2", createdAt: 1_004,
  });
  ctx.store.setCardStatus({
    operationId: "fail-card", cardId: card.id, status: "failed",
    actor: "product", actorId: "dispatcher", createdAt: 1_005,
  });
  assert.equal(ctx.store.getCard(card.id).completionRequest, null);
  ctx.runs.set("run-2", { ...ctx.runs.get("run-2"), status: "completed" });
  assert.throws(
    () => ctx.store.completeCardByProduct({
      operationId: "stale-product-complete", cardId: card.id, actorId: "product-core",
      runId: "run-2", createdAt: 1_006,
    }),
    (error) => ["KANBAN_STATUS_TRANSITION_INVALID", "KANBAN_REFERENCE_INVALID"].includes(error.code),
  );
  ctx.store.close();
});

test("归档是独立可逆标志，不再把 canceled 当作 archived", () => {
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  const card = createCard(ctx.store, board);
  const archived = ctx.store.setCardArchived({
    operationId: "archive-card", cardId: card.id, archived: true,
    actor: "human", actorId: "user-1", createdAt: 1_001,
  });
  assert.equal(archived.status, "backlog");
  assert.equal(archived.archivedAt, 1_001);
  assert.equal(ctx.store.setCardArchived({
    operationId: "unarchive-card", cardId: card.id, archived: false,
    actor: "human", actorId: "user-1", createdAt: 1_002,
  }).archivedAt, null);
  const canceled = ctx.store.setCardStatus({
    operationId: "cancel-card", cardId: card.id, status: "canceled",
    actor: "human", actorId: "user-1", createdAt: 1_003,
  });
  assert.equal(canceled.archivedAt, null);
  ctx.store.close();
});

test("operationId replay 返回首次响应快照而不是实体后续状态", () => {
  const ctx = fixture({ now: 2_000 });
  ctx.store.open();
  const board = createBoard(ctx.store);
  const firstInput = {
    operationId: "rename-two", boardId: board.id, patch: { name: "Two" }, createdAt: 1_100,
  };
  const first = ctx.store.updateBoard(firstInput);
  assert.equal(first.name, "Two");
  ctx.store.updateBoard({
    operationId: "rename-three", boardId: board.id, patch: { name: "Three" }, createdAt: 1_200,
  });
  assert.equal(ctx.store.updateBoard(firstInput).name, "Two");
  ctx.store.close();

  const restarted = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 2_000,
  }).store;
  restarted.open();
  assert.equal(restarted.updateBoard(firstInput).name, "Two");
  assert.equal(restarted.getBoard(board.id).name, "Three");
  restarted.close();
});

test("operation replay 快照的不可变归属被篡改时 open fail-closed", () => {
  const ctx = fixture();
  ctx.store.open();
  createBoard(ctx.store);
  ctx.store.close();

  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.operations["board-op-1"].result.profileId = "profile-b";
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const tampered = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs,
  }).store;
  assert.throws(
    () => tampered.open(),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );
});

test("operation replay 历史响应的可变字段被篡改时 open fail-closed", () => {
  const ctx = fixture({ now: 2_000 });
  ctx.store.open();
  const board = createBoard(ctx.store);
  ctx.store.updateBoard({
    operationId: "rename-two", boardId: board.id, patch: { name: "Two" }, createdAt: 1_100,
  });
  ctx.store.updateBoard({
    operationId: "rename-three", boardId: board.id, patch: { name: "Three" }, createdAt: 1_200,
  });
  ctx.store.close();

  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.operations["rename-two"].result.name = "TAMPERED";
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const tampered = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 2_000,
  }).store;
  assert.throws(
    () => tampered.open(),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );
});

test("operation replay 的 resultId/result 整体替换时 open fail-closed", () => {
  const ctx = fixture();
  ctx.store.open();
  createBoard(ctx.store);
  const other = createBoard(ctx.store, {
    operationId: "board-op-2", profileId: "profile-b", slug: "other", name: "Other",
  });
  ctx.store.close();

  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.operations["board-op-1"].resultId = other.id;
  raw.operations["board-op-1"].result = structuredClone(raw.boards[other.id]);
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const tampered = fixture({
    paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs,
  }).store;
  assert.throws(
    () => tampered.open(),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );
});

test("大规模 Run/Artifact 引用验证保持线性有界", () => {
  const boardId = "10000000-0000-4000-8000-000000000001";
  const cardId = "20000000-0000-4000-8000-000000000001";
  const links = {};
  const artifacts = {};
  for (let index = 0; index < 4_000; index += 1) {
    const suffix = String(index + 1).padStart(12, "0");
    const linkId = `30000000-0000-4000-8000-${suffix}`;
    const artifactId = `40000000-0000-4000-8000-${suffix}`;
    const runId = `run-${index}`;
    links[linkId] = { id: linkId, cardId, runId, retryOf: null, createdAt: index + 1 };
    artifacts[artifactId] = {
      id: artifactId, cardId, runId, name: `artifact-${index}`, kind: "file",
      mimeType: null, sizeBytes: 0, sha256: "a".repeat(64),
      storageKey: `artifacts/${index}`, createdAt: index + 1,
    };
  }
  const startedAt = Date.now();
  validateContainer({
    version: 4, revision: 0, clockHighWaterMs: 0, idempotencyFloorMs: 0,
    boards: {
      [boardId]: {
        id: boardId, profileId: "profile-a", slug: "main", name: "Main",
        description: null, createdAt: 0, updatedAt: 0,
      },
    },
    cards: {
      [cardId]: {
        id: cardId, boardId, profileId: "profile-a", title: "Scale", body: null,
        status: "backlog", position: 0, archivedAt: null,
        completionRequest: null, completion: null,
        createdAt: 0, updatedAt: 0,
      },
    },
    comments: {}, attachments: {}, artifacts, cardRunLinks: links, auditEvents: {}, operations: {},
  });
  assert.ok(Date.now() - startedAt < 750, "4k links/artifacts validation must remain linear");
});

test("单写者 lease 阻止第二实例，并在 close 后允许重开", () => {
  const paths = fixturePaths();
  const first = fixture({ paths }).store;
  const second = fixture({ paths }).store;
  first.open();
  assert.throws(
    () => second.open(),
    (error) => String(error.code || "").startsWith("WRITER_LEASE_"),
  );
  first.close();
  second.open();
  second.close();
});

test("commit-uncertain 会 poison 当前实例，已确认提交则保留内存结果", () => {
  let mode = "uncertain";
  const ctx = fixture({
    atomicWrite: () => {
      const error = new Error("injected");
      if (mode === "uncertain") error.committedUncertain = true;
      else error.committed = true;
      throw error;
    },
  });
  ctx.store.open();
  assert.throws(
    () => createBoard(ctx.store),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN" && error.committedUncertain === true,
  );
  assert.throws(
    () => ctx.store.listBoards(),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN",
  );
  assert.throws(
    () => ctx.store.preflightCardRunLink(1_000),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN",
  );
  ctx.store.close();

  mode = "committed";
  const committed = fixture({ atomicWrite: ctx.store.atomicWrite }).store;
  committed.open();
  const board = createBoard(committed);
  assert.equal(committed.getBoard(board.id).id, board.id);
  committed.close();
});

test("recovery uncertain 优先于 persisted matcher/引用检查并保留可关闭 poison 证据", () => {
  const ctx = fixture();
  ctx.store.open();
  createBoard(ctx.store);
  ctx.store.close();
  const target = path.join(ctx.paths.stateDir, "native-kanban.json");
  const backup = `${target}.backup-${process.pid}-0123456789abcdef`;
  fs.copyFileSync(target, backup);
  fs.chmodSync(backup, 0o600);
  let matcherCalls = 0;
  let resolverCalls = 0;
  const poisoned = fixture({
    paths: ctx.paths,
    profiles: ctx.profiles,
    runs: ctx.runs,
    isSensitiveValue() {
      matcherCalls += 1;
      throw new Error("locked matcher must not run");
    },
    profileExists() {
      resolverCalls += 1;
      throw new Error("profile resolver must not run");
    },
  }).store;
  poisoned.open();
  assert.equal(poisoned.opened, true);
  assert.equal(matcherCalls, 0);
  assert.equal(resolverCalls, 0);
  assert.throws(
    () => poisoned.listBoards(),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN",
  );
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(backup), true);
  poisoned.close();
  assert.equal(poisoned.opened, false);
  const reacquired = fixture({ paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs }).store;
  reacquired.open();
  reacquired.close();
});

test("CardRunLink preflight 校验时间窗口/容量并提供持久高水位 repair timestamp", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const ctx = fixture({ now: 40 * DAY });
  ctx.store.open();
  createBoard(ctx.store, { createdAt: 40 * DAY });
  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const before = fs.readFileSync(rawPath, "utf8");
  assert.equal(ctx.store.preflightCardRunLink(40 * DAY), 40 * DAY);
  assert.throws(
    () => ctx.store.preflightCardRunLink(9 * DAY),
    (error) => error.code === "KANBAN_OPERATION_EXPIRED",
  );
  assert.throws(
    () => ctx.store.preflightCardRunLink(40 * DAY + 5 * 60 * 1_000 + 1),
    (error) => error.code === "KANBAN_TIMESTAMP_INVALID",
  );
  assert.equal(fs.readFileSync(rawPath, "utf8"), before, "同一可信时钟无需重复 reservation");
  ctx.setNow(1_000);
  assert.equal(ctx.store.trustedRepairTimestamp(), 40 * DAY);
  assert.equal(ctx.store.preflightDurableOperationTimestamp(9 * DAY), 40 * DAY);
  assert.throws(
    () => ctx.store.preflightDurableOperationTimestamp(40 * DAY + 5 * 60 * 1_000 + 1),
    (error) => error.code === "KANBAN_TIMESTAMP_INVALID",
  );
  ctx.store.close();

  const operationCapacity = fixture({ capacities: { operations: 2 } });
  operationCapacity.store.open();
  const board = createBoard(operationCapacity.store);
  createCard(operationCapacity.store, board);
  assert.throws(
    () => operationCapacity.store.preflightCardRunLink(1_000),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  operationCapacity.store.close();
});

test("CardRunLink preflight 原子持久可信时钟且已知失败不改内存/磁盘", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  let mode = "pass";
  const ctx = fixture({
    now: 1_000,
    atomicWrite(target, value, options) {
      if (mode === "known") throw new Error("known write failure");
      if (mode === "uncertain") {
        const error = new Error("uncertain write failure");
        error.committedUncertain = true;
        throw error;
      }
      return atomicWritePrivateFile(target, value, options);
    },
  });
  ctx.store.open();
  createBoard(ctx.store);
  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const before = fs.readFileSync(rawPath, "utf8");

  ctx.setNow(10 * DAY);
  mode = "known";
  assert.throws(
    () => ctx.store.preflightCardRunLink(10 * DAY),
    (error) => error.code === "KANBAN_WRITE_FAILED",
  );
  assert.equal(fs.readFileSync(rawPath, "utf8"), before);
  assert.equal(ctx.store.listBoards().length, 1, "已知失败后内存视图必须保持可用");

  mode = "uncertain";
  assert.throws(
    () => ctx.store.preflightCardRunLink(10 * DAY),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN" && error.committedUncertain === true,
  );
  assert.throws(
    () => ctx.store.listBoards(),
    (error) => error.code === "KANBAN_COMMIT_UNCERTAIN",
  );
  ctx.store.close();
});

test("持久 high-water reservation 遇 matcher 重入时保留已提交 mutation", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  let store;
  let armed = false;
  const ctx = fixture({
    now: 1_000,
    isSensitiveValue(value) {
      if (armed && value === "Main") {
        armed = false;
        store.updateBoard({
          operationId: "reservation-reentrant-update",
          boardId: store.listBoards()[0].id,
          patch: { name: "Reservation update survives" },
          createdAt: 10 * DAY,
        });
      }
      return false;
    },
  });
  store = ctx.store;
  store.open();
  const board = createBoard(store);
  ctx.setNow(10 * DAY);
  armed = true;

  assert.throws(
    () => store.preflightCardRunLink(10 * DAY),
    (error) => error.code === "KANBAN_MUTATION_STALE",
  );
  assert.equal(store.getBoard(board.id).name, "Reservation update survives");
  assert.equal(store.trustedRepairTimestamp(), 10 * DAY);
  const raw = JSON.parse(fs.readFileSync(
    path.join(ctx.paths.stateDir, "native-kanban.json"), "utf8",
  ));
  assert.equal(Object.hasOwn(raw.operations, "reservation-reentrant-update"), true);
  store.close();
});

test("CardRunLink exact preflight 在 Run 入队前固定最终 v4 operation 候选并一次性提交", () => {
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  const card = createCard(ctx.store, board);
  const linkInput = {
    operationId: "prepared-link-run-1",
    cardId: card.id,
    runId: "prepared-run-1",
    retryOf: null,
    createdAt: 1_000,
  };
  const proposedRun = {
    id: linkInput.runId,
    source: "kanban",
    sourceId: card.id,
    idempotencyKey: `shoggoth:kanban:v2:${"a".repeat(64)}:1000:${"b".repeat(64)}`,
    profileId: card.profileId,
    workspace: "/tmp/prepared-kanban",
    retryOf: null,
  };
  const prepared = ctx.store.preflightCardRunLink(linkInput, proposedRun);
  assert.equal(ctx.store.listCardRunLinks(card.id).length, 0);
  ctx.runs.set(proposedRun.id, { ...proposedRun, status: "queued" });
  const linked = ctx.store.linkCardRun(linkInput, prepared);
  assert.equal(linked.runId, proposedRun.id);
  assert.throws(
    () => ctx.store.linkCardRun(linkInput, prepared),
    (error) => error.code === "KANBAN_PREPARED_STALE",
  );
  ctx.store.close();
});

test("CardRunLink prepared commit 遇 resolver 同步重入时保留已提交 mutation 并使 token stale", () => {
  let store;
  let armed = false;
  const runs = new Map();
  const ctx = fixture({
    runs,
    getRun(id) {
      const run = runs.get(id) || null;
      if (run && armed) {
        armed = false;
        store.updateCard({
          operationId: "reentrant-card-update",
          cardId: run.sourceId,
          patch: { title: "Reentrant update survives" },
          createdAt: 1_000,
        });
      }
      return run;
    },
  });
  store = ctx.store;
  store.open();
  const board = createBoard(store);
  const card = createCard(store, board);
  const proposedRun = {
    id: "prepared-reentrant-run",
    source: "kanban",
    sourceId: card.id,
    idempotencyKey: `shoggoth:kanban:v2:${"a".repeat(64)}:1000:${"b".repeat(64)}`,
    profileId: card.profileId,
    workspace: null,
    retryOf: null,
  };
  const linkInput = {
    operationId: "prepared-reentrant-link",
    cardId: card.id,
    runId: proposedRun.id,
    retryOf: null,
    createdAt: 1_000,
  };
  const token = store.preflightCardRunLink(linkInput, proposedRun);
  runs.set(proposedRun.id, { ...proposedRun, status: "queued" });
  armed = true;

  assert.throws(
    () => store.linkCardRun(linkInput, token),
    (error) => error.code === "KANBAN_PREPARED_STALE",
  );
  assert.equal(store.getCard(card.id).title, "Reentrant update survives");
  assert.equal(store.listCardRunLinks(card.id).length, 0);
  const raw = JSON.parse(fs.readFileSync(
    path.join(ctx.paths.stateDir, "native-kanban.json"), "utf8",
  ));
  assert.equal(Object.hasOwn(raw.operations, "reentrant-card-update"), true);
  assert.equal(Object.hasOwn(raw.operations, linkInput.operationId), false);
  assert.throws(
    () => store.linkCardRun(linkInput, token),
    (error) => error.code === "KANBAN_PREPARED_STALE",
  );

  const recovered = store.linkCardRun(linkInput);
  assert.equal(recovered.runId, proposedRun.id);
  assert.equal(store.listCardRunLinks(card.id).length, 1);
  store.close();
});

test("普通 mutation 遇 secret matcher 同步重入时不覆盖已提交状态", () => {
  let store;
  let outerNameHits = 0;
  let armed = false;
  const ctx = fixture({
    isSensitiveValue(value) {
      if (armed && value === "Outer board") {
        outerNameHits += 1;
        if (outerNameHits === 2) {
          armed = false;
          store.updateBoard({
            operationId: "nested-board-update",
            boardId: store.listBoards()[0].id,
            patch: { name: "Nested update survives" },
            createdAt: 1_000,
          });
        }
      }
      return false;
    },
  });
  store = ctx.store;
  store.open();
  const original = createBoard(store);
  armed = true;

  assert.throws(
    () => store.createBoard({
      operationId: "outer-board-create",
      profileId: "profile-a",
      slug: "outer",
      name: "Outer board",
      description: null,
      createdAt: 1_000,
    }),
    (error) => error.code === "KANBAN_MUTATION_STALE",
  );
  assert.equal(store.getBoard(original.id).name, "Nested update survives");
  assert.equal(store.listBoards().some((board) => board.slug === "outer"), false);
  const raw = JSON.parse(fs.readFileSync(
    path.join(ctx.paths.stateDir, "native-kanban.json"), "utf8",
  ));
  assert.equal(Object.hasOwn(raw.operations, "nested-board-update"), true);
  assert.equal(Object.hasOwn(raw.operations, "outer-board-create"), false);
  store.close();
});

test("30 天 operationId 窗口拒绝过期/未来操作并清理旧 replay 记录", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const ctx = fixture({ now: 40 * DAY });
  ctx.store.open();
  assert.throws(
    () => createBoard(ctx.store, { operationId: "expired", createdAt: 9 * DAY }),
    (error) => error.code === "KANBAN_OPERATION_EXPIRED",
  );
  assert.throws(
    () => createBoard(ctx.store, { operationId: "future", createdAt: 40 * DAY + 5 * 60 * 1_000 + 1 }),
    (error) => error.code === "KANBAN_TIMESTAMP_INVALID",
  );
  const board = createBoard(ctx.store, { createdAt: 40 * DAY });
  ctx.store.close();

  const restarted = fixture({ paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs, now: 71 * DAY }).store;
  restarted.open();
  assert.equal(restarted.getBoard(board.id).id, board.id);
  assert.throws(
    () => createBoard(restarted, { createdAt: 40 * DAY }),
    (error) => error.code === "KANBAN_OPERATION_EXPIRED",
  );
  restarted.close();
});

test("容量失败零部分写，schema 损坏与悬空引用在 open 时 fail-closed", () => {
  const ctx = fixture({ capacities: { boards: 1 } });
  ctx.store.open();
  const board = createBoard(ctx.store);
  assert.throws(
    () => createBoard(ctx.store, { operationId: "board-op-2", slug: "other" }),
    (error) => error.code === "KANBAN_CAPACITY",
  );
  assert.deepEqual(ctx.store.listBoards(), [board]);
  ctx.store.close();

  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.version = 999;
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const corrupt = fixture({ paths: ctx.paths, profiles: ctx.profiles, runs: ctx.runs }).store;
  assert.throws(
    () => corrupt.open(),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );

  const danglingCtx = fixture();
  danglingCtx.store.open();
  const danglingBoard = createBoard(danglingCtx.store);
  createCard(danglingCtx.store, danglingBoard);
  danglingCtx.store.close();
  const danglingPath = path.join(danglingCtx.paths.stateDir, "native-kanban.json");
  const danglingRaw = JSON.parse(fs.readFileSync(danglingPath, "utf8"));
  const [cardId] = Object.keys(danglingRaw.cards);
  danglingRaw.cards[cardId].boardId = "00000000-0000-4000-8000-000000000000";
  fs.writeFileSync(danglingPath, `${JSON.stringify(danglingRaw)}\n`, { mode: 0o600 });
  const dangling = fixture({
    paths: danglingCtx.paths, profiles: danglingCtx.profiles, runs: danglingCtx.runs,
  }).store;
  assert.throws(
    () => dangling.open(),
    (error) => error.code === "KANBAN_STORE_CORRUPT",
  );
});

test("敏感字段和登记敏感值均拒绝落盘，返回对象为 defensive clone", () => {
  const secret = "sk-sensitive-value-123456";
  const ctx = fixture({ isSensitiveValue: (value) => value.includes(secret) });
  ctx.store.open();
  assert.throws(
    () => ctx.store.createBoard({
      operationId: "secret-field", profileId: "profile-a", slug: "secret",
      name: "Secret", description: null, createdAt: 1_000, apiToken: "nope",
    }),
    (error) => error.code === "KANBAN_SENSITIVE_FIELD",
  );
  let sensitiveKeyError;
  try {
    ctx.store.createBoard({
      operationId: "secret-key", profileId: "profile-a", slug: "secret-key",
      name: "Secret", description: null, createdAt: 1_000,
      [`apiToken-${secret}`]: "nope",
    });
  } catch (error) {
    sensitiveKeyError = error;
  }
  assert.equal(sensitiveKeyError?.code, "KANBAN_SENSITIVE_FIELD");
  assert.equal(String(sensitiveKeyError?.message).includes(secret), false);
  assert.throws(
    () => createBoard(ctx.store, { operationId: "secret-value", description: `leak ${secret}` }),
    (error) => error.code === "KANBAN_SENSITIVE_VALUE",
  );
  const board = createBoard(ctx.store);
  const returned = ctx.store.getBoard(board.id);
  returned.name = "mutated outside";
  assert.equal(ctx.store.getBoard(board.id).name, "Main");
  const serialized = fs.readFileSync(path.join(ctx.paths.stateDir, "native-kanban.json"), "utf8");
  assert.equal(serialized.includes(secret), false);
  ctx.store.close();
});

test("open 对完整持久容器重跑 registered secret 检查", () => {
  const secret = "persisted-registered-secret-value";
  const ctx = fixture();
  ctx.store.open();
  const board = createBoard(ctx.store);
  ctx.store.close();

  const rawPath = path.join(ctx.paths.stateDir, "native-kanban.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  raw.boards[board.id].description = secret;
  fs.writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const reopened = fixture({
    paths: ctx.paths,
    profiles: ctx.profiles,
    runs: ctx.runs,
    isSensitiveValue: (value) => value.includes(secret),
  }).store;
  assert.throws(
    () => reopened.open(),
    (error) => error.code === "KANBAN_SENSITIVE_VALUE",
  );
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
