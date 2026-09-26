#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const {
  MAX_CONTENT_READ_BYTES,
  createContentMeta,
} = require("../app/agent-service/domain-service-protocol");

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE_ID = "11111111-1111-4111-8111-222222222222";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_BOARD_ID = "22222222-2222-4222-8222-333333333333";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CARD_ID = "33333333-3333-4333-8333-444444444444";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";
const AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const LINK_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ID = "99999999-9999-4999-8999-999999999999";

function chatProfile(overrides = {}) {
  return {
    id: PROFILE_ID,
    backendId: "shoggoth",
    agentId: "shoggoth-default",
    name: "Shoggoth",
    runtime: "codex",
    runtimeProfileId: "runtime-default",
    runtimeAccountId: "fixture-runtime-account",
    providerRef: "openrouter",
    defaultModel: "openai/gpt-5",
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: true,
    enabled: true,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function chatSession(profileId, index) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`;
  return {
    id,
    sessionKey: id,
    profileId,
    codexThreadId: null,
    workspace: null,
    title: `Session ${index + 1}`,
    modelOverride: null,
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
  };
}

function page(field, values, nextCursor = null) {
  return { [field]: values, nextCursor, hasMore: nextCursor !== null };
}

function board(overrides = {}) {
  return {
    id: BOARD_ID,
    profileId: PROFILE_ID,
    slug: "main-board",
    name: "Product Roadmap",
    description: "Native board",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function card(overrides = {}) {
  const body = Object.prototype.hasOwnProperty.call(overrides, "body")
    ? overrides.body : "Implement the native adapter";
  const { body: _body, ...rest } = overrides;
  return {
    id: CARD_ID,
    boardId: BOARD_ID,
    profileId: PROFILE_ID,
    title: "Ship adapter",
    bodyMeta: body === null ? null : createContentMeta(body),
    status: "backlog",
    position: 0,
    archivedAt: null,
    completionRequest: null,
    completion: null,
    createdAt: 101,
    updatedAt: 101,
    ...rest,
  };
}

function comment(overrides = {}) {
  const body = Object.prototype.hasOwnProperty.call(overrides, "body")
    ? overrides.body : "Looks good";
  const { body: _body, ...rest } = overrides;
  return {
    id: COMMENT_ID,
    cardId: CARD_ID,
    authorType: "human",
    authorId: "shoggoth-local-user",
    bodyMeta: createContentMeta(body),
    createdAt: 102,
    ...rest,
  };
}

function attachment(overrides = {}) {
  return {
    id: ATTACHMENT_ID,
    cardId: CARD_ID,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: crypto.createHash("sha256").update("body").digest("hex"),
    storageKey: "attachments/private/notes.txt",
    createdAt: 103,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    cardId: CARD_ID,
    runId: "run-current",
    name: "result.txt",
    kind: "file",
    mimeType: "text/plain",
    sizeBytes: 4,
    sha256: crypto.createHash("sha256").update("body").digest("hex"),
    storageKey: "artifacts/private/result.txt",
    createdAt: 104,
    ...overrides,
  };
}

function workRun(overrides = {}) {
  const status = overrides.status || "queued";
  const terminal = ["completed", "failed", "canceled", "interrupted", "skipped"].includes(status);
  const active = !terminal && status !== "queued";
  return {
    id: "run-current",
    source: "kanban",
    sourceId: CARD_ID,
    idempotencyKey: "private-operation-key",
    profileId: PROFILE_ID,
    workspace: null,
    status,
    codexThreadId: active || terminal ? "thread-private" : null,
    codexTurnId: active || terminal ? "turn-private" : null,
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: active || terminal ? 110 : null,
    finishedAt: terminal ? 120 : null,
    resultSummary: status === "completed" ? "Completed summary" : null,
    errorCode: ["failed", "interrupted"].includes(status) ? "RUN_FAILED" : null,
    retryOf: null,
    ...overrides,
  };
}

function cronJob(overrides = {}) {
  const prompt = Object.prototype.hasOwnProperty.call(overrides, "prompt")
    ? overrides.prompt : "Run nightly checks";
  const { prompt: _prompt, ...rest } = overrides;
  return {
    id: JOB_ID,
    name: "Nightly checks",
    enabled: true,
    profileId: PROFILE_ID,
    promptMeta: createContentMeta(prompt),
    workspace: "/tmp/shoggoth-workspace",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: 61_000,
    createdAt: 100,
    updatedAt: 1_000,
    ...rest,
  };
}

function fakeBackend(handler, options = {}) {
  const calls = [];
  let uuidCounter = 0;
  const profiles = options.profiles || [chatProfile()];
  const backend = new ShoggothBackend({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.connectionMode === undefined ? {} : { connectionMode: options.connectionMode }),
    ...(options.claimsAgentId === undefined ? {} : { claimsAgentId: options.claimsAgentId }),
    paths: { tokenPath: "/private/client.token" },
    readToken: () => "fresh-private-token",
    requestService: async (_paths, request) => {
      calls.push(structuredClone(request));
      if (request.method === "service.status") {
        return {
          healthy: true,
          pendingCommandsLocked: false,
          mcpCredentialsLocked: false,
        };
      }
      if (request.method === "profile.list") return page("profiles", profiles);
      if (request.method === "chat.session.list") {
        return options.sessionHandler
          ? options.sessionHandler(request)
          : page("sessions", []);
      }
      return handler(request, calls.length);
    },
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    now: typeof options.now === "function" ? options.now : () => options.now ?? 10_000,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    timeZone: options.timeZone || "UTC",
  });
  return { backend, calls };
}

async function readyBackend(handler, options = {}) {
  const fixture = fakeBackend(handler, options);
  assert.equal(await fixture.backend.start(), true);
  fixture.calls.length = 0;
  return fixture;
}

function contentReply(content, cursor, splitAt = 2, overrides = {}) {
  const points = [...content];
  const head = points.slice(0, splitAt).join("");
  const tail = points.slice(splitAt).join("");
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const headBytes = Buffer.byteLength(head, "utf8");
  const base = cursor === null
    ? {
        text: head,
        offsetBytes: 0,
        totalBytes: Buffer.byteLength(content, "utf8"),
        sha256,
        nextCursor: tail ? "content-next" : null,
        hasMore: !!tail,
      }
    : {
        text: tail,
        offsetBytes: headBytes,
        totalBytes: Buffer.byteLength(content, "utf8"),
        sha256,
        nextCursor: null,
        hasMore: false,
      };
  return { ...base, ...overrides };
}

test("domain _call validates result bindings and returns only stable safe errors", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") {
      return page("boards", [{ ...board(), leaked: "raw-secret" }]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.getBoards(),
    (error) => error.code === "DOMAIN_RESPONSE_INVALID"
      && error.message === "Shoggoth 请求失败 (DOMAIN_RESPONSE_INVALID)"
      && !error.message.includes("raw-secret"),
  );
  assert.equal(fixture.calls.at(-1).params.profileId, PROFILE_ID);
});

test("domain pagination rejects a cursor loop before publishing partial boards", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") {
      return page("boards", [board()], "same-cursor");
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.getBoards(),
    (error) => error.code === "CURSOR_NOT_ADVANCING",
  );
  assert.equal(fixture.calls.filter((call) => call.method === "kanban.board.list").length, 2);
});

test("domain pagination enforces the aggregate item budget inside one page", async () => {
  const values = [0, 1, 2].map((index) => board({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    slug: `board-${index + 1}`,
  }));
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", values);
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend._page(
      "kanban.board.list", { profileId: PROFILE_ID }, "boards", { maxItems: 2 },
    ),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
});

test("domain pagination accepts the full 8,192-item budget across more than 64 pages", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") {
      const offset = request.params.cursor === null ? 0 : Number(request.params.cursor);
      const end = Math.min(8_192, offset + 100);
      const values = Array.from({ length: end - offset }, (_value, index) => board({
        id: `22222222-2222-4222-8222-${String(offset + index + 1).padStart(12, "0")}`,
        slug: `board-${offset + index + 1}`,
      }));
      return page("boards", values, end < 8_192 ? String(end) : null);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const values = await fixture.backend._domainPage(
    "kanban.board.list", { profileId: PROFILE_ID }, "boards",
  );
  assert.equal(values.length, 8_192);
});

test("content pagination accepts the full 1 MiB budget even when JSON escaping needs 150 pages", async () => {
  const content = "\u0001".repeat(1024 * 1024);
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const chunkChars = 7_000;
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.card.body.read") {
      const offset = request.params.cursor === null ? 0 : Number(request.params.cursor);
      const end = Math.min(content.length, offset + chunkChars);
      return {
        text: content.slice(offset, end),
        offsetBytes: offset,
        totalBytes: content.length,
        sha256,
        nextCursor: end < content.length ? String(end) : null,
        hasMore: end < content.length,
      };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(
    await fixture.backend._readDomainContent("kanban.card.body.read", { cardId: CARD_ID }),
    content,
  );
  assert.equal(
    fixture.calls.filter((call) => call.method === "kanban.card.body.read").length,
    150,
  );
});

test("hostile Service errors collapse to a fixed safe fallback", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") {
      const hostile = {};
      Object.defineProperty(hostile, "code", {
        get() { throw new Error("token=private-leak"); },
      });
      throw hostile;
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.getBoards(),
    (error) => error.code === "SERVICE_UNAVAILABLE"
      && error.message === "Shoggoth 请求失败 (SERVICE_UNAVAILABLE)"
      && !error.message.includes("private-leak"),
  );
});

test("Service error codes are limited to the public allowlist even through a Proxy descriptor", async () => {
  const injected = new Proxy({}, {
    getOwnPropertyDescriptor(_target, key) {
      if (key === "code") {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: "PRIVATE_TOKEN_ABC",
        };
      }
      return undefined;
    },
  });
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") throw injected;
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.getBoards(),
    (error) => error.code === "SERVICE_UNAVAILABLE"
      && error.message === "Shoggoth 请求失败 (SERVICE_UNAVAILABLE)"
      && !JSON.stringify(error).includes("PRIVATE_TOKEN_ABC")
      && !error.message.includes("PRIVATE_TOKEN_ABC"),
  );
});

test("start bounds profile session concurrency and rejects an oversized cross-profile snapshot atomically", async () => {
  const profiles = Array.from({ length: 20 }, (_value, index) => chatProfile({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    agentId: `shoggoth-profile-${index + 1}`,
    name: `Profile ${index + 1}`,
    isDefault: index === 0,
  }));
  let active = 0;
  let peak = 0;
  const bounded = fakeBackend(() => {
    throw new Error("unexpected domain call");
  }, {
    profiles,
    sessionHandler: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return page("sessions", []);
    },
  });
  assert.equal(await bounded.backend.start(), true);
  assert.equal(peak <= 4, true, `peak session.list concurrency was ${peak}`);

  const largeProfiles = Array.from({ length: 83 }, (_value, index) => chatProfile({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    agentId: `shoggoth-large-${index + 1}`,
    name: `Large ${index + 1}`,
    isDefault: index === 0,
  }));
  let sessionIndex = 0;
  const oversized = fakeBackend(() => {
    throw new Error("unexpected domain call");
  }, {
    profiles: largeProfiles,
    sessionHandler: async (request) => page(
      "sessions",
      Array.from({ length: 100 }, () => chatSession(request.params.profileId, sessionIndex++)),
    ),
  });
  assert.equal(await oversized.backend.start(), false);
  assert.deepEqual(oversized.backend.getAgents(), []);
  assert.deepEqual(oversized.backend.getSessionRowsSnapshot(), { rows: [], complete: false });
});

test("Kanban get and mutation responses stay bound to the complete request", async () => {
  const reboundBoard = await readyBackend((request) => {
    if (request.method === "kanban.board.get") {
      return { board: board({ id: OTHER_BOARD_ID }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => reboundBoard.backend.getTaskBoard({ boardId: BOARD_ID }),
    (error) => error.code === "KANBAN_BOARD_MISMATCH",
  );
  assert.equal(
    reboundBoard.calls.some((call) => call.method === "kanban.card.list"), false,
  );

  const reboundCard = await readyBackend((request) => {
    if (request.method === "kanban.card.get") {
      return { card: card({ id: OTHER_CARD_ID }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => reboundCard.backend.getTask(CARD_ID),
    (error) => error.code === "KANBAN_CARD_MISMATCH",
  );
  assert.equal(
    reboundCard.calls.some((call) => call.method === "kanban.board.get"), false,
  );

  const alteredCreate = await readyBackend((request) => {
    if (request.method === "kanban.board.create") {
      return { board: board({
        slug: request.params.slug,
        name: `${request.params.name}-altered`,
        description: request.params.description,
      }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => alteredCreate.backend.createBoard({
      profileId: PROFILE_ID,
      slug: "bound-board",
      name: "Bound board",
      description: "Exact",
    }),
    (error) => error.code === "KANBAN_MUTATION_BINDING_INVALID",
  );
});

test("mutations fail closed on missing or explicitly empty profile and board selectors", async () => {
  const profiles = [
    chatProfile(),
    chatProfile({
      id: OTHER_PROFILE_ID,
      agentId: "shoggoth-other",
      name: "Other",
      isDefault: false,
    }),
  ];
  const ambiguousProfile = await readyBackend((request) => {
    if (request.method === "kanban.board.create") {
      return { board: board({
        profileId: request.params.profileId,
        slug: request.params.slug,
        name: request.params.name,
        description: request.params.description,
      }) };
    }
    if (request.method === "cron.job.create") {
      return { job: cronJob({
        profileId: request.params.profileId,
        name: request.params.name,
        prompt: request.params.prompt,
        enabled: request.params.enabled,
        workspace: request.params.workspace,
        schedule: request.params.schedule,
        misfirePolicy: request.params.misfirePolicy,
        maxCatchUp: request.params.maxCatchUp,
        overlapPolicy: request.params.overlapPolicy,
        threadPolicy: request.params.threadPolicy,
        threadId: request.params.threadId,
        nextRunAt: request.params.createdAt + request.params.schedule.everyMs,
        createdAt: request.params.createdAt,
        updatedAt: request.params.createdAt,
      }) };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { profiles });
  await assert.rejects(
    () => ambiguousProfile.backend.createBoard({ slug: "missing-profile", name: "Missing" }),
    (error) => error.code === "PROFILE_REQUIRED",
  );
  await assert.rejects(
    () => ambiguousProfile.backend.createCronJob({
      name: "Missing",
      prompt: "Private",
      schedule: { kind: "every", everyMs: 60_000 },
    }),
    (error) => error.code === "PROFILE_REQUIRED",
  );
  await assert.rejects(
    () => ambiguousProfile.backend.createBoard({
      profileId: "", slug: "empty-profile", name: "Empty",
    }),
    (error) => error.code === "PROFILE_SELECTOR_INVALID",
  );
  assert.equal(
    ambiguousProfile.calls.some((call) => ["kanban.board.create", "cron.job.create"]
      .includes(call.method)),
    false,
  );

  const emptyBoard = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", [board()]);
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => emptyBoard.backend.createTask({ board: "", title: "Must not infer" }),
    (error) => error.code === "KANBAN_BOARD_SELECTOR_INVALID",
  );
  assert.equal(
    emptyBoard.calls.some((call) => call.method === "kanban.board.list"), false,
  );
});

test("Native Kanban maps nine raw states, exact profile ownership and fail-closed capabilities", async () => {
  const statuses = [
    "triage", "backlog", "queued", "running", "review", "waiting", "done", "failed", "canceled",
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", [board()]);
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.card.list") {
      return page("cards", statuses.map((status, index) => card({
        id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
        title: `${status} task`, status, position: index,
        completion: status === "done"
          ? { mode: "manual", runId: null, actorId: "shoggoth-local-user", at: 200, note: null }
          : null,
      })));
    }
    throw new Error(`unexpected ${request.method}`);
  });
  assert.deepEqual(await fixture.backend.getBoards(), [{
    id: BOARD_ID,
    slug: "main-board",
    projectKey: "default",
    name: "Product Roadmap",
    description: "Native board",
    total: 9,
    current: true,
    profileId: PROFILE_ID,
    agentId: "shoggoth-default",
    profileName: "Shoggoth",
    backendId: "shoggoth",
  }]);
  const result = await fixture.backend.getTaskBoard({
    board: "main-board",
    profileId: PROFILE_ID,
  });
  assert.deepEqual(result.columns.map((column) => column.id), statuses);
  assert.deepEqual(result.columns.map((column) => column.tasks.length), statuses.map(() => 1));
  assert.equal(result.columns[0].tasks[0].title, "triage task");
  assert.equal(result.columns[0].tasks[0].title.includes(BOARD_ID), false);
  assert.deepEqual(result.capabilities.moveTargets, statuses);
  assert.equal(result.capabilities.kind, "native");
  assert.equal(result.capabilities.drag, true);
  assert.equal(result.capabilities.comments, true);
  assert.equal(result.capabilities.run, true);
  assert.equal(result.capabilities.retry, true);
  assert.equal(result.capabilities.manualComplete, true);
  assert.equal(result.capabilities.archive, true);
  assert.equal(result.capabilities.archived, true);
  for (const disabled of [
    "hardDelete", "sessionHandoff", "orchestration", "attachments",
    "modelOverride", "dispatch", "bulkDelete",
  ]) assert.equal(result.capabilities[disabled], false, `${disabled} must fail closed`);
});

test("Native Kanban maps each profile's first physical board to the logical default project", async () => {
  const customBoard = board({
    id: "22222222-2222-4222-8222-333333333333",
    slug: "research",
    name: "Research",
    createdAt: 2,
    updatedAt: 2,
  });
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", [board(), customBoard]);
    if (request.method === "kanban.card.list") return page("cards", []);
    throw new Error(`unexpected ${request.method}`);
  });
  const boards = await fixture.backend.getBoards();
  assert.deepEqual(boards.map(({ id, slug, projectKey }) => ({ id, slug, projectKey })), [
    { id: BOARD_ID, slug: "main-board", projectKey: "default" },
    { id: customBoard.id, slug: "research", projectKey: "research" },
  ]);
});

test("getTask reassembles Unicode content and strips protocol/storage/run metadata", async () => {
  const body = "你🌋\\n\"escaped\"";
  const note = "评审✅";
  const completed = workRun({ status: "completed" });
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.card.get") return { card: card({ body }) };
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.card.body.read") {
      assert.equal(request.params.maxBytes, MAX_CONTENT_READ_BYTES);
      return contentReply(body, request.params.cursor);
    }
    if (request.method === "kanban.comment.list") return page("comments", [comment({ body: note })]);
    if (request.method === "kanban.comment.body.read") return contentReply(note, request.params.cursor, 1);
    if (request.method === "kanban.attachment.list") return page("attachments", [attachment()]);
    if (request.method === "kanban.artifact.list") return page("artifacts", [artifact()]);
    if (request.method === "kanban.run.list") return page("runs", [completed]);
    throw new Error(`unexpected ${request.method}`);
  });
  const detail = await fixture.backend.getTask(CARD_ID);
  assert.equal(detail.body, body);
  assert.deepEqual(detail.comments, [{
    id: COMMENT_ID, author: "You", body: note, createdAt: 102,
  }]);
  assert.deepEqual(detail.attachments, [{
    id: ATTACHMENT_ID, filename: "notes.txt", contentType: "text/plain", size: 4, createdAt: 103,
  }]);
  assert.deepEqual(detail.artifacts, [{
    id: ARTIFACT_ID, label: "result.txt", mimeType: "text/plain", createdAt: 104,
  }]);
  assert.deepEqual(detail.runs, [{
    id: "run-current", status: "completed", startedAt: 110, finishedAt: 120,
    summary: "Completed summary", profile: "Shoggoth",
  }]);
  const serialized = JSON.stringify(detail);
  for (const secret of [
    "private-operation-key", "thread-private", "turn-private",
    "attachments/private", "artifacts/private", "bodyMeta", "sha256",
  ]) assert.equal(serialized.includes(secret), false, `${secret} leaked`);
});

test("content read rejects changed hashes, bad offsets and non-advancing cursors", async () => {
  for (const corruption of ["hash", "offset", "cursor"]) {
    const body = "A🌋B";
    const fixture = await readyBackend((request) => {
      if (request.method === "kanban.card.get") return { card: card({ body }) };
      if (request.method === "kanban.board.get") return { board: board() };
      if (request.method === "kanban.card.body.read") {
        const first = request.params.cursor === null;
        if (first) {
          return contentReply(body, null, 1, corruption === "cursor"
            ? { nextCursor: "same" } : {});
        }
        if (corruption === "hash") {
          return contentReply(body, request.params.cursor, 1, { sha256: "0".repeat(64) });
        }
        if (corruption === "offset") {
          return contentReply(body, request.params.cursor, 1, { text: "B", offsetBytes: 5 });
        }
        return contentReply(body, request.params.cursor, 1, {
          nextCursor: "same", hasMore: true, text: "🌋", offsetBytes: 1,
        });
      }
      if (request.method.endsWith(".list")) {
        const fields = {
          "kanban.comment.list": "comments",
          "kanban.attachment.list": "attachments",
          "kanban.artifact.list": "artifacts",
          "kanban.run.list": "runs",
        };
        return page(fields[request.method], []);
      }
      throw new Error(`unexpected ${request.method}`);
    });
    await assert.rejects(
      () => fixture.backend.getTask(CARD_ID),
      (error) => ["RESOURCE_CHANGED", "CONTENT_CURSOR_INVALID", "CURSOR_NOT_ADVANCING"].includes(error.code),
      corruption,
    );
  }
});

test("content read rejects an aggregate body larger than the adapter budget", async () => {
  const tooLarge = (1024 * 1024) + 1;
  const sha256 = "a".repeat(64);
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.card.get") {
      return {
        card: card({
          body: null,
          bodyMeta: { byteLength: tooLarge, sha256, preview: "" },
        }),
      };
    }
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.card.body.read") {
      return {
        text: "a",
        offsetBytes: 0,
        totalBytes: tooLarge,
        sha256,
        nextCursor: "oversize-next",
        hasMore: true,
      };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.getTask(CARD_ID),
    (error) => error.code === "CONTENT_TOO_LARGE",
  );
  assert.equal(
    fixture.calls.filter((call) => call.method === "kanban.card.body.read").length,
    1,
  );
});

test("Kanban mutations use fresh operations, manual completion and authoritative dispatch/retry", async () => {
  let currentCard = card();
  const failed = workRun({ id: "run-failed", status: "failed", finishedAt: 900, errorCode: "FAILED" });
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", [board()]);
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.card.get") return { card: currentCard };
    if (request.method === "kanban.card.create") {
      currentCard = card({
        title: request.params.title,
        body: request.params.body,
        createdAt: request.params.createdAt,
        updatedAt: request.params.createdAt,
      });
      return { card: currentCard };
    }
    if (request.method === "kanban.card.update") {
      const currentWithoutBodyMeta = { ...currentCard };
      if (Object.prototype.hasOwnProperty.call(request.params.patch, "body")) {
        delete currentWithoutBodyMeta.bodyMeta;
      }
      currentCard = card({
        ...currentWithoutBodyMeta,
        ...request.params.patch,
        ...(Object.prototype.hasOwnProperty.call(request.params.patch, "body")
          ? { body: request.params.patch.body } : {}),
      });
      return { card: currentCard };
    }
    if (request.method === "kanban.card.status.set") {
      currentCard = card({ ...currentCard, status: request.params.status });
      return { card: currentCard };
    }
    if (request.method === "kanban.card.archived.set") {
      currentCard = card({
        ...currentCard,
        archivedAt: request.params.archived ? request.params.createdAt : null,
      });
      return { card: currentCard };
    }
    if (request.method === "kanban.card.complete.manual") {
      currentCard = card({
        ...currentCard,
        status: "done",
        completion: {
          mode: "manual", runId: null, actorId: "shoggoth-local-user",
          at: request.params.createdAt, note: request.params.note,
        },
      });
      return {
        card: currentCard,
        audit: {
          id: AUDIT_ID, cardId: CARD_ID, kind: "manual_completion",
          actorId: "shoggoth-local-user", runId: null,
          note: request.params.note, createdAt: request.params.createdAt,
        },
      };
    }
    if (request.method === "kanban.comment.add") {
      return { comment: comment({ body: request.params.body, createdAt: request.params.createdAt }) };
    }
    if (request.method === "kanban.run.list") return page("runs", [failed]);
    if (["kanban.run.dispatch", "kanban.run.retry"].includes(request.method)) {
      const retryOf = request.method.endsWith("retry") ? failed.id : null;
      const run = workRun({
        id: retryOf ? "run-retry" : "run-new",
        retryOf,
        // Service resolves an omitted workspace to the Agent profile's
        // canonical default before it persists the WorkRun.
        workspace: request.params.workspace || "/tmp/shoggoth-managed-workspace",
      });
      currentCard = card({ ...currentCard, status: "queued" });
      return {
        run,
        card: currentCard,
        link: {
          id: LINK_ID, cardId: CARD_ID, runId: run.id, retryOf,
          createdAt: request.params.createdAt,
        },
      };
    }
    throw new Error(`unexpected ${request.method}`);
  });

  await fixture.backend.createTask({ boardId: BOARD_ID, title: "New", body: "Body", column: "backlog" });
  await fixture.backend.updateTask(CARD_ID, { title: "Renamed", body: "Changed" });
  currentCard = card({ ...currentCard, status: "running", body: "Changed" });
  await fixture.backend.moveTask(CARD_ID, "done", 0, { summary: "Manual close" });
  assert.equal(fixture.calls.some((call) => call.method === "kanban.card.complete.manual"), true);
  assert.equal(fixture.calls.some((call) => call.method === "kanban.card.status.set" && call.params.status === "done"), false);
  const added = await fixture.backend.addTaskComment(CARD_ID, "A comment");
  assert.equal(added.body, "A comment");
  const archived = await fixture.backend.archiveTask(CARD_ID, true);
  assert.equal(archived.archivedAt, 10_000);
  const restored = await fixture.backend.archiveTask(CARD_ID, false);
  assert.equal(restored.archivedAt, undefined);

  currentCard = card({ status: "backlog" });
  const dispatched = await fixture.backend.runTaskCard(CARD_ID, { mode: "autonomous" });
  assert.deepEqual(dispatched, { runId: "run-new", runStarted: true, status: "queued" });
  assert.equal(
    fixture.calls.find((call) => call.method === "kanban.run.dispatch").params.workspace,
    null,
  );
  currentCard = card({ status: "failed" });
  const retried = await fixture.backend.runTaskCard(CARD_ID, { mode: "retry", retryOf: "run-failed" });
  assert.deepEqual(retried, {
    runId: "run-retry", retryOf: "run-failed", runStarted: true, status: "queued",
  });

  const mutations = fixture.calls.filter((call) => call.params?.operationId);
  assert.equal(new Set(mutations.map((call) => call.params.operationId)).size, mutations.length);
  assert.equal(mutations.every((call) => call.params.createdAt === 10_000), true);
  assert.equal(fixture.calls.find((call) => call.method === "kanban.run.retry").params.retryOf, "run-failed");
});

test("Kanban rejects ambiguous boards, illegal moves, stale retries and cross-profile entities", async () => {
  const profiles = [
    chatProfile(),
    chatProfile({
      id: OTHER_PROFILE_ID, agentId: "shoggoth-other", name: "Other", isDefault: false,
    }),
  ];
  const boards = [board(), board({ id: OTHER_BOARD_ID, profileId: OTHER_PROFILE_ID })];
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") {
      return page("boards", boards.filter((value) => value.profileId === request.params.profileId));
    }
    if (request.method === "kanban.card.get") return { card: card({ profileId: OTHER_PROFILE_ID }) };
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.run.list") {
      return page("runs", [
        workRun({ id: "run-old", status: "failed", finishedAt: 800, errorCode: "FAILED" }),
        workRun({ id: "run-latest", status: "failed", finishedAt: 900, errorCode: "FAILED" }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, { profiles });
  await assert.rejects(() => fixture.backend.getTaskBoard({ board: "main-board" }), /AMBIGUOUS/u);
  await assert.rejects(() => fixture.backend.getTask(CARD_ID), /Shoggoth/u);
  await assert.rejects(() => fixture.backend.moveTask(CARD_ID, "running", 0), /Shoggoth/u);
  await assert.rejects(
    () => fixture.backend.runTaskCard(CARD_ID, { mode: "retry", retryOf: "run-old" }),
    /Shoggoth/u,
  );
  assert.equal(fixture.calls.some((call) => call.method === "kanban.run.retry"), false);
});

test("Kanban retry locks the latest terminal run before issuing a mutation", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.card.get") return { card: card({ status: "failed" }) };
    if (request.method === "kanban.board.get") return { board: board() };
    if (request.method === "kanban.run.list") {
      return page("runs", [
        workRun({ id: "run-old", status: "failed", finishedAt: 800, errorCode: "FAILED" }),
        workRun({ id: "run-latest", status: "failed", finishedAt: 900, errorCode: "FAILED" }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.runTaskCard(CARD_ID, { mode: "retry", retryOf: "run-old" }),
    (error) => error.code === "KANBAN_RETRY_REFERENCE_STALE",
  );
  assert.equal(fixture.calls.some((call) => call.method === "kanban.run.retry"), false);
});

test("board creation rejects undeclared capabilities before contacting Service", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.create") {
      return { board: board({ slug: request.params.slug, name: request.params.name }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.createBoard({
      profileId: PROFILE_ID,
      slug: "hidden-delete",
      name: "Hidden delete",
      delete: true,
    }),
    (error) => error.code === "KANBAN_BOARD_CREATE_UNSUPPORTED",
  );
  assert.equal(fixture.calls.some((call) => call.method === "kanban.board.create"), false);
});

test("peer native facade stamps canonical Cron ids and probes legacy resource ownership by profile", async () => {
  const codexProfile = chatProfile({
    backendId: "codex",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtimeProfileId: "runtime-codex",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  let foreign = false;
  const fixture = await readyBackend((request) => {
    const profileId = foreign ? OTHER_PROFILE_ID : PROFILE_ID;
    if (request.method === "cron.job.list") return page("jobs", [cronJob({ profileId })]);
    if (request.method === "cron.job.get") return { job: cronJob({ profileId }) };
    if (request.method === "cron.run.list") return page("runs", []);
    if (request.method === "kanban.card.get") return { card: card({ profileId }) };
    if (request.method === "run.get") return { run: workRun({ profileId }) };
    throw new Error(`unexpected ${request.method}`);
  }, {
    id: "codex",
    name: "Codex",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex",
    profiles: [codexProfile],
  });
  const [job] = await fixture.backend.getCronJobs();
  assert.equal(job.id, `codex:${JOB_ID}`);
  assert.equal(job.backendId, "codex");
  assert.equal((await fixture.backend.getCronJob(`shoggoth:${JOB_ID}`)).id, `codex:${JOB_ID}`);
  assert.equal(await fixture.backend.ownsResourceId("cron", `shoggoth:${JOB_ID}`), true);
  assert.equal(await fixture.backend.ownsResourceId("kanban", CARD_ID), true);
  assert.equal(await fixture.backend.ownsResourceId("dashboard-run", "run-current"), true);
  foreign = true;
  assert.equal(await fixture.backend.ownsResourceId("cron", `shoggoth:${JOB_ID}`), false);
  assert.equal(await fixture.backend.ownsResourceId("kanban", CARD_ID), false);
  assert.equal(await fixture.backend.ownsResourceId("dashboard-run", "run-current"), false);
});

test("Cron list hides prompt, maps at to ISO and preserves native controls only in details", async () => {
  const prompt = "secret prompt body";
  const at = 1_900_000_000_000;
  const job = cronJob({
    prompt,
    schedule: { kind: "at", at },
    nextRunAt: at,
    workspace: "/tmp/private-workspace",
    misfirePolicy: "all-bounded",
    maxCatchUp: 3,
    overlapPolicy: "queue",
    threadPolicy: "continue",
    threadId: "thread-secret-id",
  });
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.list") return page("jobs", [job]);
    if (request.method === "cron.job.get") return { job };
    if (request.method === "cron.run.list") return page("runs", []);
    if (request.method === "cron.job.prompt.read") return contentReply(prompt, request.params.cursor, 3);
    throw new Error(`unexpected ${request.method}`);
  });
  const jobs = await fixture.backend.getCronJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, `shoggoth:${JOB_ID}`);
  assert.equal(jobs[0].backendId, "shoggoth");
  assert.equal(jobs[0].agentId, "shoggoth-default");
  assert.deepEqual(jobs[0].schedule, { kind: "at", at: new Date(at).toISOString() });
  assert.equal(Object.prototype.hasOwnProperty.call(jobs[0], "prompt"), false);
  assert.equal(JSON.stringify(jobs[0]).includes(prompt), false);
  assert.deepEqual(jobs[0].backendDetails.raw, {
    workspace: "/tmp/private-workspace",
    misfirePolicy: "all-bounded",
    maxCatchUp: 3,
    overlapPolicy: "queue",
    threadPolicy: "continue",
    threadId: "thread-secret-id",
  });
  assert.equal(jobs[0].rawCapabilities.includes("native"), true);
  const detail = await fixture.backend.getCronJob(`shoggoth:${JOB_ID}`, { includePrompt: true });
  assert.equal(detail.prompt, prompt);
});

test("Cron list and detail derive last execution fields from authoritative run items", async () => {
  const prompt = "private cron prompt";
  const job = cronJob({ prompt });
  const runs = [
    {
      run: workRun({
        id: "cron-older",
        source: "cron",
        sourceId: JOB_ID,
        status: "completed",
        startedAt: 2_000,
        finishedAt: 2_500,
        resultSummary: "ok",
      }),
      kind: "schedule",
      createdAt: 1_900,
    },
    {
      run: workRun({
        id: "cron-latest",
        source: "cron",
        sourceId: JOB_ID,
        status: "failed",
        startedAt: 4_000,
        finishedAt: 4_500,
        resultSummary: null,
        errorCode: "MODEL_FAILED",
      }),
      kind: "schedule",
      createdAt: 3_900,
    },
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.list") return page("jobs", [job]);
    if (request.method === "cron.job.get") return { job };
    if (request.method === "cron.run.list") return page("runs", runs);
    if (request.method === "cron.job.prompt.read") {
      return contentReply(prompt, request.params.cursor, 3);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const [listed] = await fixture.backend.getCronJobs();
  assert.equal(listed.lastRunAt, 4_000);
  assert.equal(listed.lastStatus, "error");
  assert.equal(listed.lastError, "MODEL_FAILED");
  assert.equal(Object.prototype.hasOwnProperty.call(listed, "prompt"), false);
  assert.equal(JSON.stringify(listed).includes(prompt), false);

  const detail = await fixture.backend.getCronJob(
    `shoggoth:${JOB_ID}`, { includePrompt: true },
  );
  assert.equal(detail.prompt, prompt);
  assert.equal(detail.lastRunAt, 4_000);
  assert.equal(detail.lastStatus, "error");
  assert.equal(detail.lastError, "MODEL_FAILED");
});

test("Cron detail expansion keeps the aggregate prompt response bounded", async () => {
  const jobs = Array.from({ length: 9 }, (_value, index) => cronJob({
    id: `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`,
    name: `Large prompt ${index + 1}`,
  }));
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.list") return page("jobs", jobs);
    if (request.method === "cron.run.list") return page("runs", []);
    throw new Error(`unexpected ${request.method}`);
  });
  fixture.backend._readDomainContent = async () => "p".repeat(1024 * 1024);
  await assert.rejects(
    () => fixture.backend.getCronJobs({ includePrompt: true }),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
});

test("Cron mutations preserve exact profile identity and reverse ISO at schedules", async () => {
  let stored = cronJob();
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.get") return { job: stored };
    if (request.method === "cron.job.create") {
      stored = cronJob({
        name: request.params.name,
        prompt: request.params.prompt,
        profileId: request.params.profileId,
        schedule: request.params.schedule,
        enabled: request.params.enabled,
        workspace: request.params.workspace,
        misfirePolicy: request.params.misfirePolicy,
        maxCatchUp: request.params.maxCatchUp,
        overlapPolicy: request.params.overlapPolicy,
        threadPolicy: request.params.threadPolicy,
        threadId: request.params.threadId,
        nextRunAt: request.params.enabled
          ? request.params.schedule.kind === "at"
            ? request.params.schedule.at
            : request.params.createdAt + request.params.schedule.everyMs
          : null,
        createdAt: request.params.createdAt,
        updatedAt: request.params.createdAt,
      });
      return { job: stored };
    }
    if (request.method === "cron.job.update") {
      stored = cronJob({ ...stored, ...request.params.patch, prompt: request.params.patch.prompt ?? "Run nightly checks" });
      return { job: stored };
    }
    if (request.method === "cron.job.enabled.set") {
      stored = cronJob({ ...stored, enabled: request.params.enabled, nextRunAt: null });
      return { job: stored };
    }
    if (request.method === "cron.job.delete") return { jobId: JOB_ID, deleted: true };
    throw new Error(`unexpected ${request.method}`);
  });
  const iso = "2030-01-02T03:04:05.000Z";
  const created = await fixture.backend.createCronJob({
    agentId: "shoggoth-default",
    name: "Once",
    prompt: "Do it",
    enabled: true,
    schedule: { kind: "at", at: iso },
  });
  assert.equal(created.schedule.at, iso);
  const createCall = fixture.calls.find((call) => call.method === "cron.job.create");
  assert.equal(createCall.params.profileId, PROFILE_ID);
  assert.deepEqual(createCall.params.schedule, { kind: "at", at: Date.parse(iso) });
  assert.equal(createCall.params.threadPolicy, "new");
  assert.equal(createCall.params.threadId, null);

  await fixture.backend.createCronJob({
    agentId: "shoggoth-default",
    name: "Continue automatically",
    prompt: "Keep the job context",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    threadPolicy: "continue",
  });
  const continueCreate = fixture.calls.filter((call) => call.method === "cron.job.create").at(-1);
  assert.equal(continueCreate.params.threadPolicy, "continue");
  assert.equal(continueCreate.params.threadId, null);

  stored = cronJob({ threadPolicy: "new", threadId: null });
  await fixture.backend.updateCronJob(`shoggoth:${JOB_ID}`, { threadPolicy: "continue" });
  const continueUpdate = fixture.calls.filter((call) => call.method === "cron.job.update").at(-1);
  assert.deepEqual(continueUpdate.params.patch, { threadPolicy: "continue", threadId: null });

  await fixture.backend.updateCronJob(`shoggoth:${JOB_ID}`, { enabled: false });
  assert.equal(fixture.calls.at(-1).method, "cron.job.enabled.set");
  await assert.rejects(
    () => fixture.backend.updateCronJob(`shoggoth:${JOB_ID}`, { enabled: true, name: "mixed" }),
    (error) => error.code === "CRON_PATCH_MIXED_UNSUPPORTED",
  );
  await fixture.backend.deleteCronJob(`shoggoth:${JOB_ID}`);
  assert.equal(fixture.calls.at(-1).method, "cron.job.delete");
  assert.equal(fixture.calls.at(-1).params.jobId, JOB_ID);
});

test("Cron mutations reject a Service response rebound to another profile", async () => {
  const profiles = [
    chatProfile(),
    chatProfile({
      id: OTHER_PROFILE_ID, agentId: "shoggoth-other", name: "Other", isDefault: false,
    }),
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.get") return { job: cronJob() };
    if (request.method === "cron.job.enabled.set") {
      return {
        job: cronJob({
          profileId: OTHER_PROFILE_ID,
          enabled: request.params.enabled,
          nextRunAt: null,
        }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { profiles });
  await assert.rejects(
    () => fixture.backend.updateCronJob(`shoggoth:${JOB_ID}`, { enabled: false }),
    (error) => error.code === "CRON_PROFILE_MISMATCH",
  );
});

test("Cron mutations reject authoritative responses that alter requested business fields", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.create") {
      return { job: cronJob({
        name: request.params.name,
        prompt: request.params.prompt,
        enabled: request.params.enabled,
        profileId: request.params.profileId,
        workspace: "/tmp/altered-workspace",
        schedule: request.params.schedule,
        misfirePolicy: request.params.misfirePolicy,
        maxCatchUp: request.params.maxCatchUp,
        overlapPolicy: request.params.overlapPolicy,
        threadPolicy: request.params.threadPolicy,
        threadId: request.params.threadId,
        nextRunAt: request.params.createdAt + request.params.schedule.everyMs,
        createdAt: request.params.createdAt,
        updatedAt: request.params.createdAt,
      }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.createCronJob({
      profileId: PROFILE_ID,
      name: "Bound cron",
      prompt: "Private",
      workspace: "/tmp/requested-workspace",
      schedule: { kind: "every", everyMs: 60_000 },
    }),
    (error) => error.code === "CRON_MUTATION_BINDING_INVALID",
  );
});

test("Cron update uses one timestamp for every-schedule anchoring and mutation creation", async () => {
  let tick = 20_000;
  let stored = cronJob({
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    nextRunAt: 3_600_000,
  });
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.get") return { job: stored };
    if (request.method === "cron.job.update") {
      stored = cronJob({
        ...stored,
        ...request.params.patch,
        updatedAt: request.params.createdAt,
        nextRunAt: request.params.patch.schedule.anchorMs
          + request.params.patch.schedule.everyMs,
      });
      return { job: stored };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { now: () => ++tick });
  await fixture.backend.updateCronJob(
    `shoggoth:${JOB_ID}`,
    { schedule: { kind: "every", everyMs: 60_000 } },
  );
  const call = fixture.calls.find((request) => request.method === "cron.job.update");
  assert.equal(call.params.patch.schedule.anchorMs, call.params.createdAt);
});

test("Cron force run, histories, recent feed, summary delivery and trajectory stay capability-safe", async () => {
  const job = cronJob();
  const cronRuns = [
    {
      run: workRun({
        id: "cron-old", source: "cron", sourceId: JOB_ID,
        status: "completed", startedAt: 2_000, finishedAt: 2_500,
        resultSummary: "old result",
      }),
      kind: "schedule",
      createdAt: 2_000,
    },
    {
      run: workRun({
        id: "cron-new", source: "cron", sourceId: JOB_ID,
        status: "failed", startedAt: 4_000, finishedAt: 4_500,
        resultSummary: null, errorCode: "MODEL_FAILED",
      }),
      kind: "manual",
      createdAt: 4_000,
    },
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.get") return { job };
    if (request.method === "cron.job.list") return page("jobs", [job]);
    if (request.method === "cron.run.list") return page("runs", cronRuns);
    if (request.method === "run.list") return page("runs", cronRuns.map(row => row.run));
    if (request.method === "cron.run.trigger") {
      return { run: workRun({
        id: "cron-triggered", source: "cron", sourceId: JOB_ID,
        idempotencyKey: "trigger-private",
      }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => fixture.backend.runCronJob(`shoggoth:${JOB_ID}`, "due"),
    (error) => error.code === "CRON_RUN_MODE_UNSUPPORTED",
  );
  assert.equal(fixture.calls.some((call) => call.method === "cron.run.trigger"), false);
  assert.deepEqual(await fixture.backend.runCronJob(`shoggoth:${JOB_ID}`, "force"), {
    runId: "cron-triggered", runStarted: true, status: "running",
  });
  const history = await fixture.backend.getCronRuns(`shoggoth:${JOB_ID}`);
  assert.deepEqual(history.runs.map((run) => run.status), ["error", "ok"]);
  assert.equal(JSON.stringify(history).includes("thread-private"), false);
  const recent = await fixture.backend.getRecentCronRuns({ sinceMs: 1_000, limit: 10 });
  assert.deepEqual(recent.runs.map((run) => run.jobId), [
    `shoggoth:${JOB_ID}`, `shoggoth:${JOB_ID}`,
  ]);
  assert.deepEqual(await fixture.backend.getCronLatestDelivery(`shoggoth:${JOB_ID}`, 2_000), {
    status: "ok",
    startedAt: 2_000,
    finishedAt: 2_500,
    durationMs: 500,
    summary: "old result",
    fullText: null,
    source: "summary",
    runId: "cron-old",
  });
  assert.deepEqual(await fixture.backend.getCronRunTrajectory(`shoggoth:${JOB_ID}`), {
    supported: false, reason: "unsupported", parts: [],
  });
});

test("Cron delivery selects the exact scheduled occurrence and ignores manual or retry runs", async () => {
  const job = cronJob();
  const runs = [
    {
      run: workRun({
        id: "cron-scheduled",
        source: "cron",
        sourceId: JOB_ID,
        status: "completed",
        startedAt: 5_000,
        finishedAt: 5_500,
        resultSummary: "scheduled result",
      }),
      kind: "schedule",
      createdAt: 2_000,
    },
    {
      run: workRun({
        id: "cron-manual",
        source: "cron",
        sourceId: JOB_ID,
        status: "completed",
        startedAt: 2_050,
        finishedAt: 2_100,
        resultSummary: "manual result",
      }),
      kind: "manual",
      createdAt: 2_050,
    },
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "cron.job.get") return { job };
    if (request.method === "cron.run.list") return page("runs", runs);
    throw new Error(`unexpected ${request.method}`);
  });
  const delivery = await fixture.backend.getCronLatestDelivery(
    `shoggoth:${JOB_ID}`, 2_000,
  );
  assert.equal(delivery.summary, "scheduled result");
  assert.equal(delivery.startedAt, 5_000);
  assert.deepEqual(
    await fixture.backend.getCronLatestDelivery(`shoggoth:${JOB_ID}`, 2_001),
    { source: "none" },
  );
});

test("dashboard running work includes active Cron, Kanban and Inspiration, excluding Chat and finished work", async () => {
  const chatRunId = "10101010-1010-4010-8010-101010101010";
  const cronRunId = "20202020-2020-4020-8020-202020202020";
  const kanbanRunId = "30303030-3030-4030-8030-303030303030";
  const finishedRunId = "40404040-4040-4040-8040-404040404040";
  const inspirationRunId = "50505050-5050-4050-8050-505050505050";
  const runs = [
    workRun({ id: chatRunId, source: "chat", sourceId: chatSession(PROFILE_ID, 0).sessionKey, status: "running", startedAt: 4_000 }),
    workRun({ id: cronRunId, source: "cron", sourceId: JOB_ID, status: "running", startedAt: 3_000 }),
    workRun({ id: kanbanRunId, source: "kanban", sourceId: CARD_ID, status: "running", startedAt: 2_000 }),
    workRun({ id: inspirationRunId, source: "inspiration", sourceId: CARD_ID, status: "waiting_approval", startedAt: 1_000, waitingRequestId: "inspiration-request" }),
    workRun({ id: finishedRunId, source: "cron", sourceId: JOB_ID, status: "completed" }),
  ];
  const fixture = await readyBackend((request) => {
    if (request.method === "run.list") return page("runs", runs);
    throw new Error(`unexpected ${request.method}`);
  });

  const result = await fixture.backend.getRunningWork();
  assert.deepEqual(result.items.map(({ id, title, kind }) => ({ id, title, kind })), [
    { id: `shoggoth:${cronRunId}`, title: "Cron", kind: "cron" },
    { id: `shoggoth:${kanbanRunId}`, title: "Kanban", kind: "kanban" },
    { id: `shoggoth:${inspirationRunId}`, title: "Inspiration", kind: "inspiration" },
  ]);
  assert.equal(result.items[2].status, "waiting_approval");
  assert.equal(result.items[2].waitingRequestId, "inspiration-request");
});

test("stop disconnects only the adapter and all domain methods fail closed afterward", async () => {
  const fixture = await readyBackend((request) => {
    if (request.method === "kanban.board.list") return page("boards", [board()]);
    throw new Error(`unexpected ${request.method}`);
  });
  await fixture.backend.stop();
  const count = fixture.calls.length;
  await assert.rejects(
    () => fixture.backend.getBoards(),
    (error) => error.code === "BACKEND_NOT_READY",
  );
  await assert.rejects(
    () => fixture.backend.getCronJob(`shoggoth:${JOB_ID}`),
    (error) => error.code === "BACKEND_NOT_READY",
  );
  await assert.rejects(
    () => fixture.backend.getCronRunTrajectory(`shoggoth:${JOB_ID}`),
    (error) => error.code === "BACKEND_NOT_READY",
  );
  assert.equal(fixture.calls.length, count);
  assert.equal(fixture.calls.some((call) => /stop|shutdown|terminate/u.test(call.method)), false);
});


test("Dashboard history includes archived Agents and tasks finishing after midnight", async () => {
  const profiles = [chatProfile(), chatProfile({ id: "archived-profile", agentId: "archived-agent", enabled: false, isDefault: false })];
  const fixture = await readyBackend(request => {
    if (request.method === "cron.job.list") return page("jobs", []);
    if (request.method === "run.list") return page("runs", [workRun({ id: `cron-${request.params.profileId}`,
      profileId: request.params.profileId, source: "cron", sourceId: JOB_ID, status: "completed", startedAt: 100, finishedAt: 300 })]);
    throw new Error(`unexpected ${request.method}`);
  }, { profiles });
  assert.equal(fixture.backend._profilesById.size, 1);
  const recent = await fixture.backend.getRecentCronRuns({ sinceMs: 200 });
  assert.equal(recent.runs.length, 2);
  assert.deepEqual(new Set(recent.runs.map(row => row.agentId)), new Set(["shoggoth-default", "archived-agent"]));
  assert.equal(fixture.calls.find(call => call.method === "profile.list").params.enabledOnly, false);
});
