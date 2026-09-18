#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  CHAT_SERVICE_METHODS,
  MAX_CURSOR_BYTES,
  MAX_FRAME_BYTES,
  MAX_ITEM_BYTES,
  createQueryCursorCodec,
  mapChatServiceError,
  paginateChatServiceItems,
  paginateRunSubscription,
  validateChatServiceParams,
  validateChatServiceRequest,
  validateChatServiceResult,
} = require(path.join(ROOT, "app", "agent-service", "chat-service-protocol.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function expectCode(action, code) {
  assert.throws(action, (error) => error?.code === code, `expected ${code}`);
}

const SESSION_KEY = "11111111-1111-4111-8111-111111111111";
const STREAM_ID = "22222222-2222-4222-8222-222222222222";
const OLD_STREAM_ID = "33333333-3333-4333-8333-333333333333";
const CONTEXT_SNAPSHOT_ID = `ctx-${"a".repeat(64)}`;

function profile(overrides = {}) {
  return {
    id: "profile-1",
    backendId: "shoggoth",
    agentId: "shoggoth-profile-1",
    name: "Shoggoth",
    runtime: "codex",
    runtimeProfileId: "shoggoth-profile-1",
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
    providerRef: null,
    defaultModel: null,
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

function session(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    sessionKey: SESSION_KEY,
    profileId: "profile-1",
    codexThreadId: null,
    workspace: null,
    title: null,
    modelOverride: null,
    permissionMode: null,
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: "run-1",
    source: "chat",
    sourceId: SESSION_KEY,
    idempotencyKey: "send-1",
    profileId: "profile-1",
    workspace: null,
    status: "running",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    eventSeq: 3,
    waitingRequestId: null,
    startedAt: 101,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
    ...overrides,
  };
}

function currentRun(overrides = {}) {
  const legacy = run();
  const { codexThreadId, codexTurnId, ...base } = legacy;
  return {
    ...base,
    contextSnapshotId: CONTEXT_SNAPSHOT_ID,
    runtimeSessionRef: codexThreadId === null ? null : {
      runtime: "codex",
      runtimeProfileId: "shoggoth-profile-1",
      runtimeAccountId: "shoggoth-internal-codex-default-v1",
      sessionId: codexThreadId,
    },
    runtimeTurnRef: codexTurnId === null ? null : {
      runtime: "codex",
      runtimeProfileId: "shoggoth-profile-1",
      runtimeAccountId: "shoggoth-internal-codex-default-v1",
      sessionId: codexThreadId,
      turnId: codexTurnId,
    },
    ...overrides,
  };
}

function remoteOperation(kind = "rename", overrides = {}) {
  return {
    operationId: `${kind}-1`,
    sessionKey: SESSION_KEY,
    kind,
    title: kind === "rename" ? "New title" : null,
    state: "pending",
    createdAt: 101,
    updatedAt: 101,
    finishedAt: null,
    ...overrides,
  };
}

function historyItem(index, text = `message-${index}`) {
  return {
    id: `message-${index}`,
    runId: "run-1",
    role: index % 2 ? "assistant" : "user",
    type: "text",
    payload: { text },
    createdAt: 100 + index,
    fragment: null,
  };
}

function event(seq, payload = { text: `event-${seq}` }) {
  return { runId: "run-1", streamId: STREAM_ID, seq, type: "assistant.delta", payload };
}

function request(method, params) {
  return { id: "request-1", token: "t".repeat(64), version: 1, method, params };
}

test("注册完整 Chat Service 方法集", () => {
  assert.deepEqual([...CHAT_SERVICE_METHODS], [
    "profile.list",
    "chat.session.list", "chat.session.create", "chat.session.model.set", "chat.session.settings.set", "chat.session.permission.set", "chat.session.rename",
    "chat.session.archive", "chat.session.delete", "chat.history", "chat.search",
    "chat.command.list", "chat.command.exec", "chat.send",
    "chat.steer", "chat.abort", "run.list", "run.get", "run.subscribe",
    "run.approval.respond", "run.input.respond",
  ]);
});

test("params validator 接受 exact DTO 并拒绝未知字段、非法 limit/cursor 与 attachments", () => {
  const valid = new Map([
    ["profile.list", { backendId: "shoggoth", cursor: null, limit: 25, enabledOnly: true }],
    ["chat.session.list", {
      profileId: "profile-1", cursor: null, limit: 25, includeArchived: false,
    }],
    ["chat.session.create", {
      operationId: "create-1", profileId: "profile-1", workspace: null, createdAt: 100,
    }],
    ["chat.session.model.set", { sessionKey: SESSION_KEY, model: "gpt-5.6-terra" }],
    ["chat.session.permission.set", { sessionKey: SESSION_KEY, mode: "ask" }],
    ["chat.session.rename", {
      operationId: "rename-1", sessionKey: SESSION_KEY, title: null, createdAt: 101,
    }],
    ["chat.session.archive", {
      operationId: "archive-1", sessionKey: SESSION_KEY, createdAt: 101,
    }],
    ["chat.session.delete", {
      operationId: "delete-1", sessionKey: SESSION_KEY, createdAt: 101,
    }],
    ["chat.history", { sessionKey: SESSION_KEY, cursor: null, limit: 100 }],
    ["chat.command.list", { sessionKey: SESSION_KEY }],
    ["chat.command.exec", { sessionKey: SESSION_KEY, text: "/compact" }],
    ["chat.send", {
      operationId: "send-1", sessionKey: SESSION_KEY, prompt: "hello", createdAt: 102,
    }],
    ["chat.steer", {
      operationId: "steer-1", sessionKey: SESSION_KEY, runId: "run-1",
      message: "more context", createdAt: 103,
    }],
    ["chat.abort", {
      operationId: "abort-1", sessionKey: SESSION_KEY, runId: null, createdAt: 104,
    }],
    ["run.list", {
      profileId: "profile-1", sessionKey: SESSION_KEY, status: "running",
      cursor: null, limit: 25,
    }],
    ["run.get", { runId: "run-1" }],
    ["run.subscribe", { runId: "run-1", streamId: null, afterSeq: 0, limit: 100 }],
    ["run.approval.respond", {
      operationId: "approval-1", createdAt: 105, runId: "run-1",
      requestId: "request-approval-1", choice: "session",
    }],
    ["run.input.respond", {
      operationId: "input-1", createdAt: 106, runId: "run-1",
      requestId: "request-input-1", action: "submit", answers: { question: "answer" },
    }],
  ]);
  for (const [method, params] of valid) assert.deepEqual(validateChatServiceParams(method, params), params);

  for (const choice of ["once", "session", "deny", "cancel", "runtime:0", "runtime:31"]) {
    const params = { ...valid.get("run.approval.respond"), choice };
    assert.deepEqual(validateChatServiceParams("run.approval.respond", params), params);
  }
  for (const choice of ["runtime:32", "runtime:01", "runtime:-1", "runtime:tool", "always"]) {
    expectCode(() => validateChatServiceParams("run.approval.respond",
      { ...valid.get("run.approval.respond"), choice }), "INVALID_PARAMS");
  }

  expectCode(() => validateChatServiceParams("profile.list", {
    backendId: "shoggoth", cursor: null, limit: 0, enabledOnly: true,
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("profile.list", {
    backendId: "shoggoth", cursor: "x".repeat(MAX_CURSOR_BYTES + 1), limit: 1,
    enabledOnly: true,
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("profile.list", {
    backendId: "Grok_Build", cursor: null, limit: 1, enabledOnly: true,
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("profile.list", {
    backendId: "codex", cursor: null, limit: 1, enabledOnly: true,
    runtimeAccountId: "native-codex-default-v1",
  }), "INVALID_PARAMS");
  assert.deepEqual(validateChatServiceParams("chat.send", {
    ...valid.get("chat.send"), attachments: [],
  }), { ...valid.get("chat.send"), attachments: [] });
  expectCode(() => validateChatServiceParams("chat.command.exec", {
    sessionKey: SESSION_KEY, text: "compact",
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("run.subscribe", {
    ...valid.get("run.subscribe"), streamId: "not-a-uuid",
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("run.input.respond", {
    ...valid.get("run.input.respond"), answers: { question: { nested: true } },
  }), "INVALID_PARAMS");
  expectCode(() => validateChatServiceParams("unknown.method", {}), "INVALID_PARAMS");
});

test("chat.send 按完整请求 JSONL frame 预算提前拒绝，附件仅接受持久化描述", () => {
  const baseParams = {
    operationId: "send-frame", sessionKey: SESSION_KEY, prompt: "", createdAt: 110,
  };
  const emptyFrameBytes = Buffer.byteLength(`${JSON.stringify(request("chat.send", baseParams))}\n`);
  const fitting = {
    ...baseParams,
    prompt: "a".repeat(MAX_FRAME_BYTES - emptyFrameBytes),
  };
  assert.equal(Buffer.byteLength(`${JSON.stringify(request("chat.send", fitting))}\n`), MAX_FRAME_BYTES);
  assert.deepEqual(validateChatServiceRequest(request("chat.send", fitting)).params, fitting);

  const oversized = { ...fitting, prompt: `${fitting.prompt}a` };
  expectCode(() => validateChatServiceRequest(request("chat.send", oversized)), "CHAT_SEND_TOO_LARGE");
  expectCode(() => validateChatServiceRequest(request("chat.send", {
    ...baseParams, prompt: "hello", attachments: [{ name: "secret.bin" }],
  })), "INVALID_PARAMS");
  const attachment = { id: SESSION_KEY, name: "中文 图片.png", mimeType: "image/png", size: 1024 };
  const onlyFile = { ...baseParams, attachments: [attachment] };
  assert.deepEqual(validateChatServiceRequest(request("chat.send", onlyFile)).params, onlyFile);
  for (const changed of [{ ...attachment, path: "/etc/passwd" }, { ...attachment, content: "eA==" },
    { ...attachment, size: 0 }, { ...attachment, id: "../outside" }]) {
    expectCode(() => validateChatServiceParams("chat.send", { ...onlyFile, attachments: [changed] }), "INVALID_PARAMS");
  }
});

test("query cursor 使用 query-bound HMAC、限制 512B 并拒绝篡改或跨查询复用", () => {
  const codec = createQueryCursorCodec({ secret: Buffer.alloc(32, 7) });
  const query = {
    method: "profile.list",
    params: { backendId: "codex", limit: 2, enabledOnly: true },
  };
  const cursor = codec.encode({ query, position: "profile-2" });
  assert.equal(Buffer.byteLength(cursor) <= MAX_CURSOR_BYTES, true);
  assert.deepEqual(codec.decode(cursor, query), { position: "profile-2" });
  assert.deepEqual(codec.decode(cursor, {
    params: { enabledOnly: true, limit: 2, backendId: "codex" }, method: "profile.list",
  }), { position: "profile-2" }, "query key order must not affect binding");
  const tail = cursor.endsWith("A") ? "B" : "A";
  expectCode(() => codec.decode(`${cursor.slice(0, -1)}${tail}`, query), "INVALID_PARAMS");
  expectCode(() => codec.decode(cursor, {
    method: "profile.list", params: { backendId: "codex", limit: 3, enabledOnly: true },
  }), "INVALID_PARAMS");
  expectCode(() => codec.decode(cursor, {
    method: "profile.list", params: { backendId: "grok-build", limit: 2, enabledOnly: true },
  }), "INVALID_PARAMS");
  expectCode(() => codec.decode("x".repeat(MAX_CURSOR_BYTES + 1), query), "INVALID_PARAMS");
});

test("stable paginator 使用唯一 keyset、限制 limit 1..100 且完整响应不超过 64KiB", () => {
  const codec = createQueryCursorCodec({ secret: Buffer.alloc(32, 9) });
  const params = { sessionKey: SESSION_KEY, cursor: null, limit: 100 };
  const entries = [1, 2, 3, 4].map((index) => ({
    key: `000${index}`,
    item: historyItem(index, String(index).repeat(20 * 1024)),
  }));
  const first = paginateChatServiceItems({
    method: "chat.history", params, entries, cursorCodec: codec, responseId: "response-1",
  });
  assert.equal(first.messages.length > 0 && first.messages.length < entries.length, true);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(Buffer.byteLength(`${JSON.stringify({ id: "response-1", ok: true, result: first })}\n`) <= MAX_FRAME_BYTES, true);

  const secondParams = { ...params, cursor: first.nextCursor };
  const withEarlierInsertion = [{ key: "0000", item: historyItem(0) }, ...entries];
  const second = paginateChatServiceItems({
    method: "chat.history", params: secondParams, entries: withEarlierInsertion,
    cursorCodec: codec, responseId: "response-2",
  });
  assert.deepEqual(
    second.messages.map((item) => item.id),
    entries.slice(first.messages.length).map((entry) => entry.item.id),
    "cursor must continue after the last stable key rather than an offset",
  );
  expectCode(() => paginateChatServiceItems({
    method: "chat.history", params, entries: [entries[0], entries[0]],
    cursorCodec: codec, responseId: "response-3",
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => paginateChatServiceItems({
    method: "chat.history", params: { ...params, cursor: "tampered" }, entries,
    cursorCodec: codec, responseId: "response-4",
  }), "CHAT_HISTORY_CURSOR_INVALID");
});

test("history item 与 run event 各自硬限制 48KiB", () => {
  expectCode(() => validateChatServiceResult("chat.history", {
    messages: [historyItem(1, "h".repeat(MAX_ITEM_BYTES))], nextCursor: null, hasMore: false,
  }), "CHAT_HISTORY_ITEM_TOO_LARGE");
  expectCode(() => validateChatServiceResult("run.subscribe", {
    runId: "run-1", streamId: STREAM_ID,
    events: [event(1, { text: "e".repeat(MAX_ITEM_BYTES) })],
    cursor: 0, nextCursor: 1, hasMore: false,
    baseSeq: 0, latestSeq: 1, gap: null, snapshot: null,
  }), "RUN_EVENT_TOO_LARGE");
  expectCode(() => validateChatServiceResult("run.subscribe", {
    runId: "run-1", streamId: STREAM_ID, events: [],
    cursor: 1, nextCursor: 1, hasMore: false, baseSeq: 1, latestSeq: 1,
    gap: { code: "CURSOR_GAP", requestedAfterSeq: 0, baseSeq: 1 },
    snapshot: { text: "s".repeat(MAX_ITEM_BYTES) },
  }), "RUN_EVENT_SNAPSHOT_TOO_LARGE");
});

test("history/run payload 二次校验安全保留 __proto__ own data property", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}');
  const history = validateChatServiceResult("chat.history", {
    messages: [{ ...historyItem(1), payload }], nextCursor: null, hasMore: false,
  }).messages[0];
  const runPayload = validateChatServiceResult("run.subscribe", {
    runId: "run-1", streamId: STREAM_ID,
    events: [event(1, payload)], cursor: 0, nextCursor: 1,
    hasMore: false, baseSeq: 0, latestSeq: 1, gap: null, snapshot: null,
  }).events[0];
  for (const cloned of [history.payload, runPayload.payload]) {
    assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(cloned, "__proto__"), true);
    assert.deepEqual(Object.getOwnPropertyDescriptor(cloned, "__proto__"), {
      value: { polluted: true }, writable: true, enumerable: true, configurable: true,
    });
    assert.equal(cloned.safe, "yes");
  }
  assert.equal({}.polluted, undefined);
});

test("run.subscribe 正常分页保留数字游标，断流 reset/gap 返回权威 snapshot", () => {
  const normal = paginateRunSubscription({
    params: { runId: "run-1", streamId: null, afterSeq: 0, limit: 2 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [event(1), event(2), event(3)],
      gap: null, snapshot: null, baseSeq: 0, latestSeq: 3, nextSeq: 4,
      unsubscribe() {},
    },
    responseId: "subscribe-normal",
  });
  assert.deepEqual(normal.events.map((item) => item.seq), [1, 2]);
  assert.equal(normal.cursor, 0);
  assert.equal(normal.nextCursor, 2);
  assert.equal(normal.hasMore, true);

  const resetGap = {
    code: "STREAM_RESET", requestedStreamId: OLD_STREAM_ID, currentStreamId: STREAM_ID,
    requestedAfterSeq: 7, baseSeq: 4, latestSeq: 9,
  };
  const reset = paginateRunSubscription({
    params: { runId: "run-1", streamId: OLD_STREAM_ID, afterSeq: 7, limit: 100 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [], gap: resetGap,
      snapshot: { run: run({ eventSeq: 9 }) }, baseSeq: 4, latestSeq: 9, nextSeq: 10,
    },
    responseId: "subscribe-reset",
  });
  assert.deepEqual(reset.gap, resetGap);
  assert.deepEqual(reset.events, []);
  assert.equal(reset.cursor, 9);
  assert.equal(reset.nextCursor, 9);
  assert.equal(reset.hasMore, false);
  assert.equal(reset.streamId, STREAM_ID);

  const cursorGap = {
    code: "CURSOR_GAP", requestedAfterSeq: 1, baseSeq: 4,
  };
  const gap = paginateRunSubscription({
    params: { runId: "run-1", streamId: STREAM_ID, afterSeq: 1, limit: 100 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [], gap: cursorGap,
      snapshot: { run: run({ eventSeq: 9 }) }, baseSeq: 4, latestSeq: 9, nextSeq: 10,
    },
    responseId: "subscribe-gap",
  });
  assert.deepEqual(gap.gap, cursorGap);
  assert.equal(gap.nextCursor, 9);

  const authoritativeNullGap = {
    code: "STREAM_RESET", requestedStreamId: null, currentStreamId: STREAM_ID,
    requestedAfterSeq: 7, baseSeq: 0, latestSeq: 0,
  };
  const authoritativeNullReset = paginateRunSubscription({
    params: { runId: "run-1", streamId: null, afterSeq: 7, limit: 100 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [], gap: authoritativeNullGap,
      snapshot: { run: run({ status: "completed", finishedAt: 120 }) },
      baseSeq: 0, latestSeq: 0, nextSeq: 1,
      unsubscribe() {},
    },
    responseId: "subscribe-authoritative-null-reset",
  });
  assert.deepEqual(authoritativeNullReset.gap, authoritativeNullGap);
  assert.equal(authoritativeNullReset.cursor, 0);
  assert.equal(authoritativeNullReset.nextCursor, 0);
  assert.equal(authoritativeNullReset.snapshot.run.status, "completed");
  assert.deepEqual(
    validateChatServiceResult("run.subscribe", authoritativeNullReset),
    authoritativeNullReset,
    "同一协议管线必须能再次校验内部认证的 authoritative null reset",
  );
  expectCode(() => validateChatServiceResult(
    "run.subscribe",
    structuredClone(authoritativeNullReset),
  ), "CHAT_RESPONSE_INVALID");
  expectCode(() => paginateRunSubscription({
    params: { runId: "run-1", streamId: null, afterSeq: 7, limit: 100 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [], gap: authoritativeNullGap,
      snapshot: { run: run({ status: "running" }) },
      baseSeq: 0, latestSeq: 0, nextSeq: 1,
    },
    responseId: "subscribe-forged-null-reset",
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => paginateRunSubscription({
    params: { runId: "run-1", streamId: null, afterSeq: 7, limit: 100 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [],
      gap: { ...authoritativeNullGap, latestSeq: 1 },
      snapshot: { run: run({ status: "completed", finishedAt: 120 }) },
      baseSeq: 0, latestSeq: 0, nextSeq: 1,
    },
    responseId: "subscribe-inconsistent-null-reset",
  }), "CHAT_RESPONSE_INVALID");

  expectCode(() => paginateRunSubscription({
    params: { runId: "run-1", streamId: STREAM_ID, afterSeq: 10, limit: 10 },
    subscription: {
      runId: "run-1", streamId: STREAM_ID, events: [], gap: null,
      snapshot: null, baseSeq: 0, latestSeq: 9, nextSeq: 10,
    },
    responseId: "subscribe-future",
  }), "RUN_EVENT_CURSOR_INVALID");
});

test("result validator 覆盖 profile/session/history/run 与预注册的 steer/abort/approval/input DTO", () => {
  const readySession = session({
    codexThreadId: "thread-1", status: "ready", title: "New title", updatedAt: 101,
  });
  const results = new Map([
    ["profile.list", { profiles: [profile()], nextCursor: null, hasMore: false }],
    ["chat.session.list", {
      sessions: [{ ...session(), derivedTitle: "第一条问题" }], nextCursor: null, hasMore: false,
    }],
    ["chat.session.create", { session: session() }],
    ["chat.session.model.set", { session: session({ modelOverride: "gpt-5.6-terra" }) }],
    ["chat.session.permission.set", { session: session({ permissionMode: "ask" }) }],
    ["chat.session.rename", { session: readySession, operation: remoteOperation() }],
    ["chat.session.archive", {
      session: { ...readySession, status: "archived" }, operation: remoteOperation("archive"),
    }],
    ["chat.session.delete", {
      session: { ...readySession, status: "delete_pending" }, operation: remoteOperation("delete"),
    }],
    ["chat.history", { messages: [historyItem(1)], nextCursor: null, hasMore: false }],
    ["chat.command.list", {
      supported: true,
      reason: "CLI-only entries are explicitly marked",
      commands: [{
        name: "compact", description: "Compact context", args: null,
        category: "session", aliases: [], source: "Codex runtime", execution: "runtime",
      }, {
        name: "__remote-workflow", description: "SDK skill", args: "<input>",
        category: "tools", aliases: [], source: "Claude Code runtime", execution: "runtime",
      }],
    }],
    ["chat.command.exec", { kind: "output", text: "Compaction started.", warning: null }],
    ["chat.send", { disposition: "started", reason: null, run: run({ status: "starting" }) }],
    ["chat.steer", { accepted: true, runId: "run-1", turnId: "turn-1" }],
    ["chat.abort", { run: run({ status: "canceled", finishedAt: 120 }) }],
    ["run.list", { runs: [run()], nextCursor: null, hasMore: false }],
    ["run.get", { run: run() }],
    ["run.subscribe", {
      runId: "run-1", streamId: STREAM_ID, events: [event(1)], cursor: 0,
      nextCursor: 1, hasMore: false, baseSeq: 0, latestSeq: 1, gap: null, snapshot: null,
    }],
    ["run.approval.respond", { requestId: "request-1", state: "responded", run: run() }],
    ["run.input.respond", { requestId: "request-1", state: "responded", run: run() }],
  ]);
  for (const [method, result] of results) assert.deepEqual(validateChatServiceResult(method, result), result);

  assert.deepEqual(validateChatServiceResult("chat.session.list", {
    sessions: [session()], nextCursor: null, hasMore: false,
  }), {
    sessions: [{ ...session(), derivedTitle: null }], nextCursor: null, hasMore: false,
  }, "升级期间兼容尚未返回 derivedTitle 的旧 Service");
  expectCode(() => validateChatServiceResult("chat.session.list", {
    sessions: [{ ...session(), derivedTitle: "" }], nextCursor: null, hasMore: false,
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.command.list", {
    supported: true, reason: null,
    commands: [{
      name: "Compact", description: "bad case", args: null,
      category: "session", aliases: [],
    }],
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.command.list", {
    supported: true,
    reason: null,
    commands: [
      {
        name: "compact", description: "Compact", args: null,
        category: "session", aliases: ["shrink"],
      },
      {
        name: "shrink", description: "Ambiguous alias", args: null,
        category: "session", aliases: [],
      },
    ],
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.command.exec", {
    kind: "send", text: "", warning: null,
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.session.list", {
    sessions: [{ ...session(), derivedTitle: "第一条问题", unexpected: true }],
    nextCursor: null,
    hasMore: false,
  }), "CHAT_RESPONSE_INVALID");

  const terminalReplay = {
    disposition: "completed",
    reason: null,
    run: run({ status: "completed", finishedAt: 120, errorCode: null }),
  };
  assert.deepEqual(
    validateChatServiceResult("chat.send", terminalReplay),
    terminalReplay,
    "相同 operationId 的 terminal replay 必须能返回既有 terminal run",
  );
  expectCode(() => validateChatServiceResult("chat.send", {
    disposition: "completed", reason: "TERMINAL", run: terminalReplay.run,
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.send", {
    disposition: "completed", reason: null, run: run({ status: "running" }),
  }), "CHAT_RESPONSE_INVALID");
  const maxOperationId = "o".repeat(128);
  const maxOperationResult = {
    disposition: "queued",
    reason: "PROFILE_ACTIVE_LIMIT",
    run: run({
      idempotencyKey: `shoggoth:chat-send:${maxOperationId}`,
      status: "queued", codexThreadId: null, codexTurnId: null, startedAt: null,
    }),
  };
  assert.deepEqual(
    validateChatServiceResult("chat.send", maxOperationResult),
    maxOperationResult,
    "协议接受的 128B operationId 生成的 Coordinator idempotencyKey 也必须可返回",
  );
  expectCode(() => validateChatServiceResult("run.get", {
    run: run({ idempotencyKey: `x${"o".repeat(256)}` }),
  }), "CHAT_RESPONSE_INVALID");

  expectCode(() => validateChatServiceResult("chat.session.create", {
    session: { ...session(), codexThreadId: "thread-should-not-exist" },
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("run.get", {
    run: { ...run(), secret: "secret-canary" },
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("run.get", {
    run: run({ codexThreadId: null, codexTurnId: "turn-without-thread" }),
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("run.get", {
    run: run({ status: "failed", finishedAt: 120, errorCode: null }),
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("run.get", {
    run: run({ status: "completed", finishedAt: 100, errorCode: null }),
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("chat.send", {
    disposition: "queued", reason: "PROFILE_ACTIVE_LIMIT", run: run(),
  }), "CHAT_RESPONSE_INVALID");
  assert.deepEqual(validateChatServiceResult("profile.list", {
    profiles: [profile({ concurrency: { maxActive: 1, maxWorkspaceWrites: 2 } })],
    nextCursor: null,
    hasMore: false,
  }).profiles[0].concurrency, { maxActive: 1, maxWorkspaceWrites: 2 },
  "协议不得收窄 ProductStore 已接受的独立并发上限");
  assert.equal(validateChatServiceResult("profile.list", {
    profiles: [profile({ backendId: "grok-build" })],
    nextCursor: null,
    hasMore: false,
  }).profiles[0].backendId, "grok-build");
  expectCode(() => validateChatServiceResult("profile.list", {
    profiles: [profile({ backendId: "Grok_Build" })],
    nextCursor: null,
    hasMore: false,
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("profile.list", {
    profiles: [profile({ runtimeAccountId: `a${"b".repeat(128)}` })],
    nextCursor: null,
    hasMore: false,
  }), "CHAT_RESPONSE_INVALID");
  const missingRuntimeAccount = profile();
  delete missingRuntimeAccount.runtimeAccountId;
  expectCode(() => validateChatServiceResult("profile.list", {
    profiles: [missingRuntimeAccount], nextCursor: null, hasMore: false,
  }), "CHAT_RESPONSE_INVALID");
});

test("当前 WorkRun DTO 保留 contextSnapshotId 且兼容旧 IPC 投影", () => {
  const expected = { ...run(), contextSnapshotId: CONTEXT_SNAPSHOT_ID };
  for (const [method, result] of [
    ["chat.send", { disposition: "started", reason: null, run: currentRun() }],
    ["run.get", { run: currentRun() }],
    ["run.list", { runs: [currentRun()], nextCursor: null, hasMore: false }],
  ]) {
    const validated = validateChatServiceResult(method, result);
    if (method === "run.list") assert.deepEqual(validated.runs[0], expected);
    else assert.deepEqual(validated.run, expected);
  }
  assert.deepEqual(
    validateChatServiceResult("run.get", { run: run() }),
    { run: run() },
    "升级期间仍接受不含 contextSnapshotId 的旧 IPC DTO",
  );
  expectCode(() => validateChatServiceResult("run.get", {
    run: currentRun({ contextSnapshotId: "ctx-invalid" }),
  }), "CHAT_RESPONSE_INVALID");
  const missingRuntimeAccount = currentRun();
  delete missingRuntimeAccount.runtimeSessionRef.runtimeAccountId;
  expectCode(() => validateChatServiceResult("run.get", {
    run: missingRuntimeAccount,
  }), "CHAT_RESPONSE_INVALID");
  expectCode(() => validateChatServiceResult("run.get", {
    run: currentRun({
      runtimeTurnRef: {
        ...currentRun().runtimeTurnRef,
        runtimeAccountId: "other-runtime-account",
      },
    }),
  }), "CHAT_RESPONSE_INVALID");
});

test("内部 Pending/lease/path/Codex 错误映射到固定公共码和文案且不泄露", () => {
  const cases = [
    ["PENDING_COMMAND_IDEMPOTENCY_CONFLICT", "CHAT_OPERATION_ID_CONFLICT"],
    ["PENDING_COMMAND_TIMESTAMP_INVALID", "INVALID_PARAMS"],
    ["PENDING_COMMAND_CAPACITY", "CHAT_SESSION_CAPACITY"],
    ["PENDING_COMMAND_COMMIT_UNCERTAIN", "CHAT_SESSION_COMMIT_UNCERTAIN"],
    ["WRITER_LEASE_HELD", "SERVICE_UNAVAILABLE"],
    ["PRIVATE_FILE_RECOVERY_UNSAFE", "SERVICE_UNAVAILABLE"],
    ["UNSAFE_PATH", "SERVICE_UNAVAILABLE"],
    ["CODEX_PROTOCOL_FAILED", "BACKEND_NOT_READY"],
    ["CODEX_SCHEMA_PATH_INVALID", "BACKEND_NOT_READY"],
    ["RPC_REMOTE_ERROR", "BACKEND_NOT_READY"],
    ["CODEX_HISTORY_CURSOR_INVALID", "CHAT_HISTORY_CURSOR_INVALID"],
    ["CODEX_HISTORY_CURSOR_STALE", "CHAT_HISTORY_CURSOR_INVALID"],
    ["CODEX_HISTORY_CURSOR_THREAD_MISMATCH", "CHAT_HISTORY_CURSOR_INVALID"],
    ["WORK_RUN_OPERATION_CONFLICT", "CHAT_OPERATION_ID_CONFLICT"],
    ["WORK_RUN_CONTROL_STALE", "RUN_REQUEST_STATE_CONFLICT"],
    ["WORK_RUN_REQUEST_MISMATCH", "RUN_REQUEST_NOT_FOUND"],
    ["WORK_RUN_REQUEST_BUSY", "RUN_REQUEST_STATE_CONFLICT"],
    ["WORK_RUN_APPROVAL_RESPONSE_INVALID", "RUN_APPROVAL_DECISION_INVALID"],
    ["WORK_RUN_INPUT_RESPONSE_INVALID", "RUN_INPUT_RESPONSE_INVALID"],
    ["WORK_RUN_COORDINATOR_CLOSING", "SERVICE_UNAVAILABLE"],
    ["RUNTIME_CAPABILITY_UNSUPPORTED", "RUNTIME_CAPABILITY_UNSUPPORTED"],
    ["AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED"],
    ["RUNTIME_AUTH_REQUIRED", "RUNTIME_AUTH_REQUIRED"],
    ["INSPIRATION_ARCHIVED", "INSPIRATION_ARCHIVED"],
    ["INSPIRATION_NOT_FOUND", "INSPIRATION_NOT_FOUND"],
    ["INSPIRATION_BUSY", "INSPIRATION_BUSY"],
    ["RUNTIME_COMMAND_NOT_FOUND", "CHAT_COMMAND_NOT_FOUND"],
    ["RUNTIME_COMMAND_SESSION_REQUIRED", "CHAT_COMMAND_SESSION_REQUIRED"],
    ["RUNTIME_COMMAND_CATALOG_UNAVAILABLE", "CHAT_COMMAND_UNAVAILABLE"],
    ["SOMETHING_UNKNOWN", "INTERNAL_ERROR"],
  ];
  for (const [internalCode, publicCode] of cases) {
    const error = new Error(`secret-canary:${internalCode}`);
    error.code = internalCode;
    error.stack = `stack secret-canary ${internalCode}`;
    const mapped = mapChatServiceError(error);
    assert.equal(mapped.code, publicCode);
    assert.equal(JSON.stringify(mapped).includes("secret-canary"), false);
    assert.deepEqual(Object.keys(mapped), ["code", "message"]);
  }
  const publicError = new Error("secret-canary");
  publicError.code = "WORK_RUN_NOT_FOUND";
  assert.deepEqual(mapChatServiceError(publicError), {
    code: "WORK_RUN_NOT_FOUND", message: "Run 不存在",
  });
  const expired = new Error("secret-canary");
  expired.code = "OPERATION_EXPIRED";
  assert.deepEqual(mapChatServiceError(expired), {
    code: "OPERATION_EXPIRED", message: "操作已超过幂等窗口",
  });
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`shoggoth chat service protocol unit: ${tests.length} passed`);
})();
