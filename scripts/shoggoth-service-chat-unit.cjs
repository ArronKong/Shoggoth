#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { createAgentService, PROTOCOL_VERSION } = require(
  path.join(ROOT, "app", "agent-service", "server.js"),
);
const { requestService, readClientToken } = require(
  path.join(ROOT, "app", "agent-service", "client.js"),
);
const { DEFAULT_AGENT_PROFILE_ID } = require(
  path.join(ROOT, "app", "agent-service", "product-store.js"),
);
const { ChatSessionStore } = require(
  path.join(ROOT, "app", "agent-service", "chat-session-store.js"),
);
const { PendingCommandInbox } = require(
  path.join(ROOT, "app", "agent-service", "pending-command-inbox.js"),
);
const { TokenUsageStore } = require(
  path.join(ROOT, "app", "agent-service", "token-usage-store.js"),
);
const {
  BUILTIN_CLI_AGENT_PROFILES,
  ensureBuiltinCliAgentProfiles,
} = require(path.join(ROOT, "app", "agent-service", "builtin-cli-profiles.js"));
const { WorkRunCoordinator } = require(
  path.join(ROOT, "app", "agent-service", "work-run-coordinator.js"),
);
const { CodexSchemaContract } = require(
  path.join(ROOT, "app", "agent-service", "codex-schema-contract.js"),
);
const {
  createChatServiceController,
} = require(path.join(ROOT, "app", "agent-service", "chat-service-controller.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const PROFILE_ID = "profile-1";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_KEY = "11111111-1111-4111-8111-111111111111";
const STREAM_ID = "22222222-2222-4222-8222-222222222222";
const CONTEXT_SNAPSHOT_ID = `ctx-${"a".repeat(64)}`;

function profile(overrides = {}) {
  return {
    id: PROFILE_ID,
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
    id: SESSION_ID,
    sessionKey: SESSION_KEY,
    profileId: PROFILE_ID,
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
    idempotencyKey: "shoggoth:chat-send:send-1",
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

function currentRun(overrides = {}) {
  const legacyRun = run({
    status: "running",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    startedAt: 101,
    eventSeq: 3,
    contextSnapshotId: CONTEXT_SNAPSHOT_ID,
    ...overrides,
  });
  const { codexThreadId, codexTurnId, ...current } = legacyRun;
  return {
    ...current,
    runtimeSessionRef: {
      runtime: "codex",
      runtimeProfileId: "shoggoth-profile-1",
      runtimeAccountId: "shoggoth-internal-codex-default-v1",
      sessionId: codexThreadId,
    },
    runtimeTurnRef: {
      runtime: "codex",
      runtimeProfileId: "shoggoth-profile-1",
      runtimeAccountId: "shoggoth-internal-codex-default-v1",
      sessionId: codexThreadId,
      turnId: codexTurnId,
    },
  };
}

function codexThreadReadFixture(items, overrides = {}) {
  return {
    thread: {
      cliVersion: "0.149.0",
      cwd: "/tmp/shoggoth-bound",
      ephemeral: false,
      id: "thread-bound",
      modelProvider: "openrouter",
      preview: "fixture",
      projectId: null,
      sessionId: "session-bound",
      source: "appServer",
      status: { type: "idle" },
      createdAt: 100,
      updatedAt: 200,
      turns: [{
        id: "turn-history",
        items,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 100,
        completedAt: 101,
        durationMs: 1000,
      }],
      ...overrides,
    },
  };
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-controller-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const profiles = overrides.profiles || [profile()];
  const sessions = overrides.sessions || [session()];
  const runs = overrides.runs || [run()];
  const calls = {
    create: [], send: [], steer: [], abort: [], approval: [], input: [],
    models: [], permissions: [], subscribe: 0, unsubscribe: 0,
  };
  const productStore = {
    listAgentProfiles: () => structuredClone(profiles),
    getAgentProfile: (id) => structuredClone(profiles.find((item) => item.id === id) || null),
  };
  const chatSessionStore = {
    listSessions: () => structuredClone(sessions),
    listPendingRemoteOperations: () => [],
    getSession(sessionKey) {
      return structuredClone(sessions.find((item) => item.sessionKey === sessionKey) || null);
    },
    createSession(input) {
      calls.create.push(structuredClone(input));
      const created = session({
        id: crypto.randomUUID(),
        sessionKey: crypto.randomUUID(),
        profileId: input.profileId,
        workspace: input.workspace,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      sessions.push(created);
      return structuredClone(created);
    },
    setModelOverride(sessionKey, model) {
      calls.models.push({ sessionKey, model });
      const index = sessions.findIndex((item) => item.sessionKey === sessionKey);
      if (index < 0) throw Object.assign(new Error("missing"), { code: "CHAT_SESSION_NOT_FOUND" });
      sessions[index] = { ...sessions[index], modelOverride: model, updatedAt: 101 };
      return structuredClone(sessions[index]);
    },
    setPermissionMode(sessionKey, mode) {
      calls.permissions.push({ sessionKey, mode });
      const index = sessions.findIndex((item) => item.sessionKey === sessionKey);
      if (index < 0) throw Object.assign(new Error("missing"), { code: "CHAT_SESSION_NOT_FOUND" });
      sessions[index] = { ...sessions[index], permissionMode: mode, updatedAt: 101 };
      return structuredClone(sessions[index]);
    },
  };
  const coordinator = {
    listRuns(query) {
      return structuredClone(runs.filter((item) => Object.entries(query)
        .every(([key, value]) => item[key] === value)));
    },
    getRun(id) { return structuredClone(runs.find((item) => item.id === id) || null); },
    async send(input) {
      calls.send.push(structuredClone(input));
      return { disposition: "queued", reason: "PROFILE_ACTIVE_LIMIT", run: structuredClone(runs[0]) };
    },
    async steer(input) {
      calls.steer.push(structuredClone(input));
      return { accepted: true, runId: "run-1", turnId: "turn-1" };
    },
    async abort(input) {
      calls.abort.push(structuredClone(input));
      return { ...run(), status: "canceled", finishedAt: 130 };
    },
    async respondApproval(input) {
      calls.approval.push(structuredClone(input));
      return {
        requestId: input.requestId, state: "responded",
        run: { ...run(), status: "running", startedAt: 110 },
      };
    },
    async respondInput(input) {
      calls.input.push(structuredClone(input));
      return {
        requestId: input.requestId, state: "responded",
        run: { ...run(), status: "running", startedAt: 110 },
      };
    },
    subscribeRun(runId, cursor, listener) {
      assert.equal(typeof listener, "function");
      calls.subscribe += 1;
      return {
        runId,
        streamId: STREAM_ID,
        events: [],
        gap: null,
        snapshot: null,
        baseSeq: 0,
        latestSeq: 0,
        nextSeq: 1,
        unsubscribe() { calls.unsubscribe += 1; },
      };
    },
  };
  const controller = createChatServiceController({
    paths,
    productStore,
    chatSessionStore,
    coordinator,
    ...(overrides.transcriptStore ? { transcriptStore: overrides.transcriptStore } : {}),
    cursorSecret: Buffer.alloc(32, 11),
    now: () => 1000,
    randomUUID: () => "44444444-4444-4444-8444-444444444444",
    listProfileModels: overrides.listProfileModels || (async ({ cursor }) => ({
      models: cursor === null ? [{
        id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", description: "", isDefault: false,
      }] : [],
      nextCursor: null,
      hasMore: false,
    })),
  });
  return { root, paths, profiles, sessions, runs, calls, coordinator, controller };
}

function boundControllerFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-bound-controller-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const chatSessionStore = new ChatSessionStore({
    paths, now: () => 1000,
    randomUUID: (() => {
      const values = [
        "88888888-8888-4888-8888-888888888888",
        "99999999-9999-4999-8999-999999999999",
      ];
      return () => values.shift() || crypto.randomUUID();
    })(),
  });
  chatSessionStore.open();
  const bound = chatSessionStore.createSession({
    operationId: "create-bound", profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-bound", createdAt: 900,
  });
  const binding = chatSessionStore.requestBinding(bound.sessionKey, "bind-bound", 901);
  chatSessionStore.completeBinding(bound.sessionKey, binding.operationId, "thread-bound");
  const profiles = [overrides.profile || profile()];
  const productStore = {
    listAgentProfiles: () => structuredClone(profiles),
    getAgentProfile: (id) => structuredClone(profiles.find((item) => item.id === id) || null),
  };
  const calls = { remote: [], runtime: [], runtimeOptions: [] };
  const host = overrides.host || {
    registeredSecrets: [],
    async threadSetName(params) { calls.remote.push(["rename", structuredClone(params)]); return {}; },
    async threadArchive(params) { calls.remote.push(["archive", structuredClone(params)]); return {}; },
    async threadDelete(params) { calls.remote.push(["delete", structuredClone(params)]); return {}; },
    async threadRead() { assert.fail("not used"); },
  };
  const runtimePool = {
    async get(bindingValue, acquireOptions) {
      calls.runtime.push(structuredClone(bindingValue));
      calls.runtimeOptions.push(structuredClone(acquireOptions));
      return host;
    },
  };
  const runs = overrides.runs || [];
  const coordinator = {
    listRuns(query = {}) {
      return structuredClone(runs.filter((item) => Object.entries(query)
        .every(([key, value]) => item[key] === value)));
    },
    getRun() { return null; },
    async send() { assert.fail("not used"); },
    subscribeRun() { assert.fail("not used"); },
  };
  const controller = createChatServiceController({
    paths, productStore, chatSessionStore, coordinator, runtimePool,
    ...(overrides.runtimeSessionOwnershipStore
      ? { runtimeSessionOwnershipStore: overrides.runtimeSessionOwnershipStore }
      : {}),
    schemaContract: new CodexSchemaContract({ repoRoot: ROOT }),
    cursorSecret: Buffer.alloc(32, 0x34), now: () => 1000,
    randomUUID: crypto.randomUUID,
  });
  return { root, paths, chatSessionStore, bound, productStore, calls, host, runtimePool,
    coordinator, controller };
}

function safeStorageFixture(state = { available: true }) {
  return {
    isEncryptionAvailable: () => state.available,
    encryptString(value) {
      if (!state.available) throw new Error("locked");
      return Buffer.from(value, "utf8");
    },
    decryptString(value) {
      if (!state.available) throw new Error("locked");
      return Buffer.from(value).toString("utf8");
    },
  };
}

function serviceFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-service-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const calls = {
    send: [], steer: [], abort: [], approval: [], input: [], remote: [], runtime: [],
    subscribe: 0, unsubscribe: 0, open: 0, close: 0,
  };
  const fakeCoordinator = {
    async open() { calls.open += 1; },
    async close() { calls.close += 1; },
    listRuns(query = {}) {
      return [this.getRun("run-1")].filter((item) => Object.entries(query)
        .every(([key, value]) => item[key] === value));
    },
    getRun(runId) {
      if (!["run-1", "terminal-run"].includes(runId)) return null;
      const base = run({
        id: runId,
        profileId: DEFAULT_AGENT_PROFILE_ID,
        sourceId: calls.sessionKey || SESSION_KEY,
      });
      return runId === "terminal-run"
        ? { ...base, status: "completed", finishedAt: 120 }
        : base;
    },
    async send(input) {
      calls.send.push(structuredClone(input));
      const base = run({
        profileId: DEFAULT_AGENT_PROFILE_ID,
        sourceId: input.sessionKey,
        idempotencyKey: `shoggoth:chat-send:${input.operationId}`,
      });
      if (input.operationId === "terminal-replay") {
        return {
          disposition: "completed", reason: null,
          run: { ...base, status: "completed", finishedAt: 120 },
        };
      }
      if (input.operationId === "started-send") {
        return {
          disposition: "started", reason: null,
          run: { ...base, status: "starting", startedAt: 110 },
        };
      }
      return { disposition: "queued", reason: "PROFILE_ACTIVE_LIMIT", run: base };
    },
    async steer(input) {
      calls.steer.push(structuredClone(input));
      return { accepted: true, runId: "run-1", turnId: "turn-socket" };
    },
    async abort(input) {
      calls.abort.push(structuredClone(input));
      return {
        ...this.getRun("run-1"), status: "canceled", finishedAt: Date.now(),
      };
    },
    async respondApproval(input) {
      calls.approval.push(structuredClone(input));
      return {
        requestId: input.requestId, state: "responded",
        run: { ...this.getRun(input.runId), status: "running", startedAt: Date.now() },
      };
    },
    async respondInput(input) {
      calls.input.push(structuredClone(input));
      return {
        requestId: input.requestId, state: "responded",
        run: { ...this.getRun(input.runId), status: "running", startedAt: Date.now() },
      };
    },
    subscribeRun(runId, cursor, listener) {
      assert.equal(typeof listener, "function");
      calls.subscribe += 1;
      if (runId === "terminal-run") {
        return {
          runId,
          streamId: STREAM_ID,
          events: [],
          gap: {
            code: "STREAM_RESET", requestedStreamId: null,
            currentStreamId: STREAM_ID, requestedAfterSeq: cursor.afterSeq,
            baseSeq: 0, latestSeq: 0,
          },
          snapshot: { run: this.getRun(runId) },
          baseSeq: 0,
          latestSeq: 0,
          nextSeq: 1,
          unsubscribe() { calls.unsubscribe += 1; },
        };
      }
      const reset = cursor.streamId !== null && cursor.streamId !== STREAM_ID;
      return {
        runId,
        streamId: STREAM_ID,
        events: [],
        gap: reset ? {
          code: "STREAM_RESET", requestedStreamId: cursor.streamId,
          currentStreamId: STREAM_ID, requestedAfterSeq: cursor.afterSeq,
          baseSeq: 0, latestSeq: 0,
        } : null,
        snapshot: reset ? { run: this.getRun(runId) } : null,
        baseSeq: 0,
        latestSeq: 0,
        nextSeq: 1,
        unsubscribe() { calls.unsubscribe += 1; },
      };
    },
  };
  const host = {
    registeredSecrets: [],
    async threadSetName(params) { calls.remote.push(["rename", structuredClone(params)]); return {}; },
    async threadArchive(params) { calls.remote.push(["archive", structuredClone(params)]); return {}; },
    async threadDelete(params) { calls.remote.push(["delete", structuredClone(params)]); return {}; },
    async threadRead(params) {
      calls.remote.push(["history", structuredClone(params)]);
      return codexThreadReadFixture([{
        type: "agentMessage", id: "socket-history", text: "socket history",
        phase: "final_answer", memoryCitation: null, delivery: null,
      }]);
    },
  };
  const runtimePool = {
    async get(bindingValue) {
      calls.runtime.push(structuredClone(bindingValue));
      return host;
    },
    async stopAll() {},
  };
  const service = createAgentService({
    paths,
    version: "chat-service-test",
    safeStorage: safeStorageFixture(),
    runtimePool,
    workRunCoordinator: fakeCoordinator,
    randomUUID: crypto.randomUUID,
    ...(options.chatCursorSecret ? { chatCursorSecret: options.chatCursorSecret } : {}),
  });
  return { root, paths, calls, fakeCoordinator, runtimePool, service };
}

async function ipc(paths, method, params, id = `ipc-${method}`) {
  return requestService(paths, {
    id,
    token: readClientToken(paths),
    version: PROTOCOL_VERSION,
    method,
    params,
  });
}

test("paths 暴露独立 managed workspace 根目录", () => {
  const { paths } = fixture();
  assert.equal(paths.defaultWorkspaceDir, path.join(paths.stateDir, "workspaces"));
});

test("history adapter 保留完整 Gateway DTO/fragment，并按唯一 Codex turn 绑定 Run 与稳定类型", () => {
  const { adaptCodexChatHistoryPage } = require(path.join(
    ROOT, "app", "agent-service", "chat-history-adapter.js",
  ));
  const normal = {
    id: "codex-message-1",
    timestamp: null,
    role: "user",
    content: [{ type: "text", text: "hello" }],
    isError: false,
    codex: { turnId: "turn-1", itemType: "userMessage" },
  };
  const reasoning = {
    id: "codex-message-2",
    timestamp: 120_000,
    role: "assistant",
    content: [{ type: "thinking", thinking: "reason" }],
    isError: false,
    codex: { turnId: "turn-2", itemType: "reasoning" },
  };
  const fragment = {
    kind: "fragment",
    id: "codex-message-3",
    role: "assistant",
    fragment: {
      messageId: "codex-message-3", index: 0, count: 2,
      encoding: "gateway-message-json-utf8", sha256: "a".repeat(64),
    },
    data: "{\"id\":\"codex-message-3\"",
  };
  const result = adaptCodexChatHistoryPage({
    threadId: "thread-1", revision: "b".repeat(64),
    messages: [normal, reasoning, fragment], nextCursor: "opaque.mapper.cursor", hasMore: true,
  }, { runs: [
    run({ id: "run-turn-1", codexTurnId: "turn-1" }),
    run({ id: "run-turn-2-a", codexTurnId: "turn-2" }),
    run({ id: "run-turn-2-b", codexTurnId: "turn-2" }),
  ] });
  assert.equal(result.nextCursor, "opaque.mapper.cursor");
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.messages[0], {
    id: "codex-message-1", runId: "run-turn-1", role: "user", type: "text",
    payload: { message: normal }, createdAt: 0, fragment: null,
  });
  assert.equal(result.messages[1].runId, null, "同 turn 多 Run 必须 fail closed 为 null");
  assert.equal(result.messages[1].type, "thinking");
  assert.deepEqual(result.messages[2], {
    id: "codex-message-3.fragment.0", runId: null, role: "assistant", type: "text",
    payload: {
      encoding: "gateway-message-json-utf8", sha256: "a".repeat(64),
      data: "{\"id\":\"codex-message-3\"",
    },
    createdAt: 0,
    fragment: { messageId: "codex-message-3", index: 0, count: 2 },
  });
  assert.equal(Buffer.byteLength(`${JSON.stringify(result.messages[2])}\n`) < 48 * 1024, true);
});

test("基础 list/get 方法稳定分页、按 query 过滤并拒绝篡改与跨 query cursor", async () => {
  const { controller } = fixture({
    profiles: [profile(), profile({ id: "profile-2", agentId: "shoggoth-profile-2",
      runtimeProfileId: "shoggoth-profile-2", isDefault: false, enabled: false }),
    profile({ id: "profile-codex", backendId: "codex", agentId: "codex-profile",
      runtimeProfileId: "codex-profile", isDefault: false })],
    sessions: [session(), session({
      id: "55555555-5555-4555-8555-555555555555",
      sessionKey: "66666666-6666-4666-8666-666666666666",
      status: "archived", codexThreadId: "thread-2",
    })],
  });
  await controller.open();
  const first = await controller.handle("profile.list", {
    backendId: "shoggoth", cursor: null, limit: 1, enabledOnly: false,
  }, "profiles-1");
  assert.equal(first.profiles.length, 1);
  assert.equal(first.hasMore, true);
  const second = await controller.handle("profile.list", {
    backendId: "shoggoth", cursor: first.nextCursor, limit: 1, enabledOnly: false,
  }, "profiles-2");
  assert.equal(second.profiles.length, 1);
  await assert.rejects(
    controller.handle("profile.list", {
      backendId: "shoggoth", cursor: `${first.nextCursor.slice(0, -1)}x`, limit: 1,
      enabledOnly: false,
    }, "profiles-tampered"),
    (error) => error.code === "INVALID_PARAMS",
  );
  await assert.rejects(
    controller.handle("profile.list", {
      backendId: "shoggoth", cursor: first.nextCursor, limit: 1, enabledOnly: true,
    }, "profiles-cross-query"),
    (error) => error.code === "INVALID_PARAMS",
  );
  await assert.rejects(
    controller.handle("profile.list", {
      backendId: "codex", cursor: first.nextCursor, limit: 1, enabledOnly: false,
    }, "profiles-cross-backend"),
    (error) => error.code === "INVALID_PARAMS",
  );
  const codexProfiles = await controller.handle("profile.list", {
    backendId: "codex", cursor: null, limit: 10, enabledOnly: true,
  }, "profiles-codex");
  assert.deepEqual(codexProfiles.profiles.map((item) => item.id), ["profile-codex"]);

  const listed = await controller.handle("chat.session.list", {
    profileId: PROFILE_ID, cursor: null, limit: 100, includeArchived: false,
  }, "sessions");
  assert.deepEqual(listed.sessions.map((item) => item.status), ["draft"]);
  const listedRuns = await controller.handle("run.list", {
    profileId: PROFILE_ID, sessionKey: SESSION_KEY, status: "queued", cursor: null, limit: 100,
  }, "runs");
  assert.deepEqual(listedRuns.runs.map((item) => item.id), ["run-1"]);
  assert.deepEqual(await controller.handle("run.get", { runId: "run-1" }, "run"), {
    run: run(),
  });
  await assert.rejects(
    controller.handle("run.get", { runId: "missing" }, "run-missing"),
    (error) => error.code === "WORK_RUN_NOT_FOUND",
  );
});

test("session.list 只读投影首条用户消息标题且不改写手动 title", async () => {
  const titleLookups = [];
  const transcriptStore = {
    ensureSession() {},
    listEvents() { return []; },
    importHistoryItems() {},
    getSessionDerivedTitle(profileId, sessionId) {
      titleLookups.push({ profileId, sessionId });
      return "第一条原生消息";
    },
  };
  const { controller } = fixture({
    sessions: [session({ title: "手动名称" })],
    transcriptStore,
  });
  await controller.open();
  const listed = await controller.handle("chat.session.list", {
    profileId: PROFILE_ID, cursor: null, limit: 100, includeArchived: false,
  }, "sessions-derived-title");
  assert.equal(listed.sessions[0].title, "手动名称");
  assert.equal(listed.sessions[0].derivedTitle, "第一条原生消息");
  assert.deepEqual(titleLookups, [{ profileId: PROFILE_ID, sessionId: SESSION_ID }]);
});

test("transcript tool result without summary stays empty instead of repeating completed status", async () => {
  const transcriptStore = {
    ensureSession() {},
    listEvents() {
      return [{
        seq: 1,
        id: "tool-call-event",
        runId: "run-tool-summary",
        kind: "tool_call",
        content: {
          transcriptType: "tool.start",
          tool: {
            kind: "search", name: "Web search:", status: "in_progress",
          },
        },
        contextExcluded: false,
        occurredAt: 100,
      }, {
        seq: 2,
        id: "tool-result-event",
        runId: "run-tool-summary",
        kind: "tool_result",
        content: {
          transcriptType: "tool.result",
          tool: {
            kind: "search", name: "Web search:", status: "completed", success: true,
            displayArgs: { query: "native agent trajectory" },
          },
        },
        contextExcluded: false,
        occurredAt: 101,
      }];
    },
    importHistoryItems() {},
    getSessionDerivedTitle() { return null; },
  };
  const { controller } = fixture({ transcriptStore });
  await controller.open();
  const history = await controller.handle("chat.history", {
    sessionKey: SESSION_KEY, cursor: null, limit: 10,
  }, "history-tool-summary");
  assert.deepEqual(history.messages[0].payload.message.content[0], {
    type: "toolCall", toolName: "Web search:",
  });
  assert.deepEqual(history.messages[1].payload.message.content[0], {
    type: "toolResult", name: "Web search:", content: "", is_error: false,
    arguments: { query: "native agent trajectory" },
  });
});

test("transcript history 只给 federation 用户输入附加 inter-session provenance", async () => {
  const transcriptStore = {
    ensureSession() {},
    listEvents() {
      return [{
        seq: 1,
        id: "direct-user-event",
        runId: "run-direct",
        kind: "user",
        content: { text: "human input", operationId: "direct-send-1" },
        contextExcluded: false,
        occurredAt: 100,
      }, {
        seq: 2,
        id: "federated-user-event",
        runId: "run-federated",
        kind: "user",
        content: { text: "agent input", operationId: "federation-message-tool-call-1" },
        contextExcluded: false,
        occurredAt: 101,
      }];
    },
    importHistoryItems() {},
    getSessionDerivedTitle() { return null; },
  };
  const { controller } = fixture({ transcriptStore });
  await controller.open();
  const history = await controller.handle("chat.history", {
    sessionKey: SESSION_KEY, cursor: null, limit: 10,
  }, "history-federation-provenance");
  const byId = new Map(history.messages.map((item) => [
    item.payload.message.id,
    item.payload.message,
  ]));
  assert.equal(Object.hasOwn(byId.get("direct-user-event"), "provenance"), false);
  assert.deepEqual(byId.get("federated-user-event").provenance, {
    kind: "inter_session",
    sourceTool: "federation_agent_message",
  });
});

test("当前 WorkRun context snapshot 贯通 chat.send/run.list/run.get", async () => {
  const liveRun = currentRun({ idempotencyKey: "shoggoth:chat-send:current-run" });
  const { controller, coordinator } = fixture({ runs: [liveRun] });
  coordinator.send = async () => ({
    disposition: "started",
    reason: null,
    run: structuredClone(liveRun),
  });
  await controller.open();

  const sent = await controller.handle("chat.send", {
    operationId: "current-run", sessionKey: SESSION_KEY, prompt: "hello", createdAt: 12,
  }, "send-current-run");
  const listed = await controller.handle("run.list", {
    profileId: PROFILE_ID, sessionKey: SESSION_KEY, status: "running", cursor: null, limit: 100,
  }, "list-current-run");
  const fetched = await controller.handle("run.get", {
    runId: liveRun.id,
  }, "get-current-run");

  for (const result of [sent.run, listed.runs[0], fetched.run]) {
    assert.equal(result.contextSnapshotId, CONTEXT_SNAPSHOT_ID);
    assert.equal(result.codexThreadId, "thread-1");
    assert.equal(result.codexTurnId, "turn-1");
    assert.equal("runtimeSessionRef" in result, false);
    assert.equal("runtimeTurnRef" in result, false);
  }
});

test("session.create 验证 enabled profile，null workspace 使用 defaultCwd 或私有 managed workspace", async () => {
  const managed = fixture();
  await managed.controller.open();
  const created = await managed.controller.handle("chat.session.create", {
    operationId: "create-1", profileId: PROFILE_ID, workspace: null, createdAt: 900,
  }, "create-managed");
  const expected = path.join(managed.paths.defaultWorkspaceDir, PROFILE_ID);
  assert.equal(created.session.workspace, expected);
  assert.equal(fs.statSync(fs.realpathSync(expected)).isDirectory(), true);
  assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
  assert.deepEqual(managed.calls.create[0], {
    operationId: "create-1", profileId: PROFILE_ID, workspace: expected, createdAt: 900,
  });

  const configured = fixture({ profiles: [profile({ defaultCwd: "/tmp/shoggoth-default" })] });
  await configured.controller.open();
  const configuredResult = await configured.controller.handle("chat.session.create", {
    operationId: "create-2", profileId: PROFILE_ID, workspace: null, createdAt: 901,
  }, "create-configured");
  assert.equal(configuredResult.session.workspace, "/tmp/shoggoth-default");

  const disabled = fixture({ profiles: [profile({ enabled: false })] });
  await disabled.controller.open();
  await assert.rejects(
    disabled.controller.handle("chat.session.create", {
      operationId: "create-3", profileId: PROFILE_ID, workspace: null, createdAt: 902,
    }, "create-disabled"),
    (error) => error.code === "AGENT_PROFILE_DISABLED",
  );

  const relative = fixture();
  await relative.controller.open();
  await assert.rejects(
    relative.controller.handle("chat.session.create", {
      operationId: "create-relative", profileId: PROFILE_ID,
      workspace: "relative/workspace", createdAt: 903,
    }, "create-relative"),
    (error) => error.code === "CHAT_SESSION_INVALID",
  );

  const symlinked = fixture();
  await symlinked.controller.open();
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), "sg-workspace-victim-"));
  fs.mkdirSync(symlinked.paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(victim, path.join(symlinked.paths.defaultWorkspaceDir, PROFILE_ID));
  await assert.rejects(
    symlinked.controller.handle("chat.session.create", {
      operationId: "create-symlink", profileId: PROFILE_ID,
      workspace: null, createdAt: 904,
    }, "create-symlink"),
    (error) => error.code === "UNSAFE_SYMLINK",
  );
  assert.deepEqual(fs.readdirSync(victim), []);
});

test("session model 仅在空闲时切换到账号授权目录中的模型", async () => {
  const pages = [];
  const available = fixture({
    runs: [],
    listProfileModels: async (params) => {
      pages.push(structuredClone(params));
      return params.cursor === null
        ? {
            models: [{ id: "gpt-5.6-sol", displayName: "Sol", description: "", isDefault: true }],
            nextCursor: "next", hasMore: true,
          }
        : {
            models: [{ id: "gpt-5.6-terra", displayName: "Terra", description: "", isDefault: false }],
            nextCursor: null, hasMore: false,
          };
    },
  });
  await available.controller.open();
  const result = await available.controller.handle("chat.session.model.set", {
    sessionKey: SESSION_KEY,
    model: "gpt-5.6-terra",
  }, "model-set");
  assert.equal(result.session.modelOverride, "gpt-5.6-terra");
  assert.deepEqual(available.calls.models, [{
    sessionKey: SESSION_KEY, model: "gpt-5.6-terra",
  }]);
  assert.deepEqual(pages.map((item) => item.cursor), [null, "next"]);

  const unavailable = fixture({ runs: [] });
  await unavailable.controller.open();
  await assert.rejects(
    unavailable.controller.handle("chat.session.model.set", {
      sessionKey: SESSION_KEY, model: "gpt-unavailable",
    }, "model-unavailable"),
    (error) => error.code === "CHAT_SESSION_MODEL_NOT_AVAILABLE",
  );
  assert.deepEqual(unavailable.calls.models, []);

  const busy = fixture({ runs: [run({ status: "running", startedAt: 101 })] });
  await busy.controller.open();
  await assert.rejects(
    busy.controller.handle("chat.session.model.set", {
      sessionKey: SESSION_KEY, model: "gpt-5.6-terra",
    }, "model-busy"),
    (error) => error.code === "THREAD_ACTIVE_TURN_CONFLICT",
  );
  assert.deepEqual(busy.calls.models, []);
});

test("session permission 只接受 Runtime 目录中的模式并在忙碌时拒绝", async () => {
  const available = fixture({ runs: [] });
  await available.controller.open();
  const result = await available.controller.handle("chat.session.permission.set", {
    sessionKey: SESSION_KEY,
    mode: "workspace-auto",
  }, "permission-set");
  assert.equal(result.session.permissionMode, "workspace-auto");
  assert.deepEqual(available.calls.permissions, [{ sessionKey: SESSION_KEY, mode: "workspace-auto" }]);
  await assert.rejects(
    available.controller.handle("chat.session.permission.set", {
      sessionKey: SESSION_KEY, mode: "not-a-mode",
    }, "permission-invalid"),
    (error) => error.code === "CHAT_SESSION_PERMISSION_INVALID",
  );

  const busy = fixture({ runs: [run({ status: "running", startedAt: 101 })] });
  await busy.controller.open();
  await assert.rejects(
    busy.controller.handle("chat.session.permission.set", {
      sessionKey: SESSION_KEY, mode: "ask",
    }, "permission-busy"),
    (error) => error.code === "THREAD_ACTIVE_TURN_CONFLICT",
  );
  assert.deepEqual(busy.calls.permissions, []);
});

test("ensureDefaultSessions 只为 enabled 且零 session 的 profile 创建一次", async () => {
  const oneExisting = fixture({
    profiles: [profile(), profile({ id: "profile-2", agentId: "shoggoth-profile-2",
      runtimeProfileId: "shoggoth-profile-2", isDefault: false })],
  });
  await oneExisting.controller.ensureDefaultSessions();
  await oneExisting.controller.ensureDefaultSessions();
  assert.equal(oneExisting.calls.create.length, 1);
  assert.equal(oneExisting.calls.create[0].profileId, "profile-2");
  assert.equal(oneExisting.calls.create[0].operationId,
    "default-session-44444444-4444-4444-8444-444444444444");
});

test("send 忽略协议 createdAt 并仅把稳定命令字段交给 Coordinator", async () => {
  const { controller, coordinator, calls } = fixture();
  await controller.open();
  const result = await controller.handle("chat.send", {
    operationId: "send-1", sessionKey: SESSION_KEY, prompt: "hello", createdAt: 12,
  }, "send");
  assert.equal(result.disposition, "queued");
  assert.deepEqual(calls.send, [{ operationId: "send-1", sessionKey: SESSION_KEY, prompt: "hello" }]);
  for (const [label, override] of [
    ["source", { source: "kanban" }],
    ["source-id", { sourceId: "other-session" }],
    ["idempotency", { idempotencyKey: "shoggoth:chat-send:other-operation" }],
    ["profile", { profileId: "profile-2" }],
  ]) {
    const operationId = `send-invalid-${label}`;
    coordinator.send = async () => ({
      disposition: "queued", reason: "PROFILE_ACTIVE_LIMIT",
      run: run({ idempotencyKey: `shoggoth:chat-send:${operationId}`, ...override }),
    });
    await assert.rejects(
      controller.handle("chat.send", {
        operationId, sessionKey: SESSION_KEY, prompt: "hello", createdAt: 12,
      }, operationId),
      (error) => error.code === "CHAT_RESPONSE_INVALID",
    );
  }
});

test("run.subscribe 每次轮询立即释放 raw subscription", async () => {
  const { controller, calls } = fixture();
  await controller.open();
  const result = await controller.handle("run.subscribe", {
    runId: "run-1", streamId: null, afterSeq: 0, limit: 100,
  }, "subscribe");
  assert.equal(result.streamId, STREAM_ID);
  assert.equal(calls.subscribe, 1);
  assert.equal(calls.unsubscribe, 1);
});

test("steer/abort/approval/input 只委托 Coordinator 精确字段并二次验证结果", async () => {
  const { controller, coordinator, calls } = fixture();
  await controller.open();
  assert.deepEqual(await controller.handle("chat.steer", {
    operationId: "steer-1", sessionKey: SESSION_KEY, runId: "run-1",
    message: "continue", createdAt: 12,
  }, "steer"), { accepted: true, runId: "run-1", turnId: "turn-1" });
  assert.deepEqual(calls.steer, [{
    operationId: "steer-1", sessionKey: SESSION_KEY, runId: "run-1", message: "continue",
  }]);

  const aborted = await controller.handle("chat.abort", {
    operationId: "abort-1", sessionKey: SESSION_KEY, runId: null, createdAt: 13,
  }, "abort");
  assert.equal(aborted.run.status, "canceled");
  assert.deepEqual(calls.abort, [{ operationId: "abort-1", sessionKey: SESSION_KEY, runId: null }]);

  const approved = await controller.handle("run.approval.respond", {
    operationId: "approval-1", createdAt: 14, runId: "run-1",
    requestId: "request-1", choice: "once",
  }, "approval");
  assert.equal(approved.state, "responded");
  assert.deepEqual(calls.approval, [{
    operationId: "approval-1", runId: "run-1", requestId: "request-1", choice: "once",
  }]);

  const answered = await controller.handle("run.input.respond", {
    operationId: "input-1", createdAt: 15, runId: "run-1",
    requestId: "request-2", action: "submit", answers: { question_1: "yes" },
  }, "input");
  assert.equal(answered.state, "responded");
  assert.deepEqual(calls.input, [{
    operationId: "input-1", runId: "run-1", requestId: "request-2",
    action: "submit", answers: { question_1: "yes" },
  }]);

  coordinator.steer = async () => ({ accepted: true, runId: "other-run", turnId: null });
  await assert.rejects(
    controller.handle("chat.steer", {
      operationId: "steer-invalid-result", sessionKey: SESSION_KEY, runId: "run-1",
      message: "continue", createdAt: 16,
    }, "steer-invalid-result"),
    (error) => error.code === "CHAT_RESPONSE_INVALID",
  );
});

test("rename/archive/delete 先持久化本地意图，按 Profile runtime 调 Host，确认后完成且可补偿重试", async () => {
  const value = boundControllerFixture();
  const { controller, chatSessionStore, bound, host, calls } = value;
  await controller.open();
  const renamed = await controller.handle("chat.session.rename", {
    operationId: "rename-1", sessionKey: bound.sessionKey, title: "Renamed", createdAt: 902,
  }, "rename");
  assert.equal(renamed.session.title, "Renamed");
  assert.equal(renamed.operation.state, "completed");
  assert.deepEqual(calls.remote[0], ["rename", { threadId: "thread-bound", name: "Renamed" }]);
  assert.deepEqual(calls.runtime, [{
    runtime: "codex",
    runtimeProfileId: "shoggoth-profile-1",
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
  }]);

  const cleared = await controller.handle("chat.session.rename", {
    operationId: "clear-title-1", sessionKey: bound.sessionKey, title: null, createdAt: 902,
  }, "clear-title");
  assert.equal(cleared.session.title, null);
  assert.equal(cleared.operation.title, null);
  assert.equal(cleared.operation.state, "completed");
  assert.equal(calls.remote.filter(([kind]) => kind === "rename").length, 1,
    "清空本地标题不得向 Codex thread/name/set 发送 null");

  let lost = true;
  host.threadArchive = async (params) => {
    calls.remote.push(["archive", structuredClone(params)]);
    if (lost) {
      lost = false;
      throw Object.assign(new Error("response lost secret"), { code: "RPC_CONNECTION_CLOSED" });
    }
    return {};
  };
  await assert.rejects(
    controller.handle("chat.session.archive", {
      operationId: "archive-1", sessionKey: bound.sessionKey, createdAt: 903,
    }, "archive-lost"),
    (error) => error.code === "RPC_CONNECTION_CLOSED",
  );
  assert.equal(chatSessionStore.getSession(bound.sessionKey).status, "archived");
  assert.deepEqual(chatSessionStore.listPendingRemoteOperations().map((item) => item.operationId),
    ["archive-1"]);
  const archived = await controller.handle("chat.session.archive", {
    operationId: "archive-1", sessionKey: bound.sessionKey, createdAt: 903,
  }, "archive-retry");
  assert.equal(archived.operation.state, "completed");
  assert.equal(calls.remote.filter(([kind]) => kind === "archive").length, 2);

  const deleted = await controller.handle("chat.session.delete", {
    operationId: "delete-1", sessionKey: bound.sessionKey, createdAt: 904,
  }, "delete");
  assert.equal(deleted.session, null);
  assert.equal(deleted.operation.state, "completed");
  assert.deepEqual(calls.remote.at(-1), ["delete", { threadId: "thread-bound" }]);
  chatSessionStore.close();
});

test("远端会话管理先校验 RuntimeAccount 归属，并在归档或删除后持久化状态", async () => {
  const ownershipCalls = { assert: [], mark: [] };
  const runtimeSessionOwnershipStore = {
    assertOwned(input) {
      ownershipCalls.assert.push(structuredClone(input));
      return { status: "active" };
    },
    mark(input) {
      ownershipCalls.mark.push(structuredClone(input));
      return { status: input.status };
    },
  };
  const value = boundControllerFixture({ runtimeSessionOwnershipStore });
  await value.controller.open();
  await value.controller.handle("chat.session.rename", {
    operationId: "owned-rename", sessionKey: value.bound.sessionKey,
    title: "Owned session", createdAt: 902,
  }, "owned-rename");
  await value.controller.handle("chat.session.archive", {
    operationId: "owned-archive", sessionKey: value.bound.sessionKey, createdAt: 903,
  }, "owned-archive");
  await value.controller.handle("chat.session.delete", {
    operationId: "owned-delete", sessionKey: value.bound.sessionKey, createdAt: 904,
  }, "owned-delete");
  const expectedOwnership = {
    binding: {
      runtime: "codex",
      runtimeProfileId: "shoggoth-profile-1",
      runtimeAccountId: "shoggoth-internal-codex-default-v1",
    },
    sessionId: "thread-bound",
    profileId: PROFILE_ID,
    workspace: "/tmp/shoggoth-bound",
  };
  assert.deepEqual(ownershipCalls.assert,
    Array.from({ length: 6 }, () => expectedOwnership));
  assert.deepEqual(ownershipCalls.mark, [
    { ...expectedOwnership, status: "archived" },
    { ...expectedOwnership, status: "deleted" },
  ]);
  value.chatSessionStore.close();
});

test("归属冲突在写入会话操作意图和调用 Runtime 前失败", async () => {
  const conflict = Object.assign(new Error("foreign session"), {
    code: "RUNTIME_SESSION_NOT_OWNED",
  });
  const value = boundControllerFixture({
    runtimeSessionOwnershipStore: {
      assertOwned() { throw conflict; },
      mark() { assert.fail("not used"); },
    },
  });
  await value.controller.open();
  await assert.rejects(
    value.controller.handle("chat.session.rename", {
      operationId: "foreign-rename", sessionKey: value.bound.sessionKey,
      title: "Must not persist", createdAt: 902,
    }, "foreign-rename"),
    (error) => error === conflict,
  );
  assert.deepEqual(value.calls.remote, []);
  assert.deepEqual(value.calls.runtime, []);
  assert.deepEqual(value.chatSessionStore.listPendingRemoteOperations(), []);
  assert.equal(value.chatSessionStore.getSession(value.bound.sessionKey).title, null);
  value.chatSessionStore.close();
});

test("非 Codex Profile 的会话管理只走通用 RuntimeHandle，不依赖 Codex schema/RPC", async () => {
  const calls = [];
  const value = boundControllerFixture({
    profile: profile({
      name: "Grok",
      runtime: "grok-build",
      runtimeProfileId: "shoggoth-grok",
      runtimeAccountId: "native-grok-build-default-v1",
      isDefault: false,
    }),
    host: {
      capabilities: { "session.delete": true },
      async sessionRename(input) { calls.push(["rename", structuredClone(input)]); return {}; },
      async sessionArchive(input) { calls.push(["archive", structuredClone(input)]); return {}; },
      async sessionDelete(input) { calls.push(["delete", structuredClone(input)]); return {}; },
    },
  });
  await value.controller.open();
  await value.controller.handle("chat.session.rename", {
    operationId: "grok-rename", sessionKey: value.bound.sessionKey,
    title: "Grok session", createdAt: 902,
  }, "grok-rename");
  await value.controller.handle("chat.session.archive", {
    operationId: "grok-archive", sessionKey: value.bound.sessionKey, createdAt: 903,
  }, "grok-archive");
  await value.controller.handle("chat.session.delete", {
    operationId: "grok-delete", sessionKey: value.bound.sessionKey, createdAt: 904,
  }, "grok-delete");
  assert.deepEqual(calls, [
    ["rename", { sessionId: "thread-bound", name: "Grok session" }],
    ["archive", { sessionId: "thread-bound" }],
    ["delete", { sessionId: "thread-bound" }],
  ]);
  assert.deepEqual(value.calls.runtime, Array.from({ length: 3 }, () => ({
    runtime: "grok-build",
    runtimeProfileId: "shoggoth-grok",
    runtimeAccountId: "native-grok-build-default-v1",
  })));
  assert.deepEqual(value.calls.runtimeOptions, Array.from({ length: 3 }, () => ({
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    workspace: "/tmp/shoggoth-bound",
  })));
  value.chatSessionStore.close();
});

test("原生命令目录与执行按当前 Session 的 Runtime binding、workspace 和远端 session 路由", async () => {
  const commandCalls = [];
  const value = boundControllerFixture({
    host: {
      capabilities: { "commands.list": true, "commands.execute": true },
      async commandsList(input) {
        commandCalls.push(["list", structuredClone(input)]);
        return {
          supported: true,
          reason: null,
          commands: [{
            name: "compact", description: "Compact context", args: null,
            category: "session", aliases: [],
          }],
        };
      },
      async commandExecute(input) {
        commandCalls.push(["exec", structuredClone(input)]);
        return { kind: "output", text: "Compaction started.", warning: null };
      },
    },
  });
  await value.controller.open();
  const catalog = await value.controller.handle("chat.command.list", {
    sessionKey: value.bound.sessionKey,
  }, "commands-list");
  const executed = await value.controller.handle("chat.command.exec", {
    sessionKey: value.bound.sessionKey, text: "/compact",
  }, "commands-exec");
  assert.deepEqual(catalog.commands.map((command) => command.name), ["compact"]);
  assert.deepEqual(executed, { kind: "output", text: "Compaction started.", warning: null });
  assert.deepEqual(commandCalls, [
    ["list", { sessionId: "thread-bound", cwd: "/tmp/shoggoth-bound" }],
    ["exec", {
      sessionId: "thread-bound", cwd: "/tmp/shoggoth-bound", text: "/compact",
    }],
  ]);
  assert.deepEqual(value.calls.runtime, Array.from({ length: 2 }, () => ({
    runtime: "codex",
    runtimeProfileId: "shoggoth-profile-1",
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
  })));
  await value.controller.close();
  value.chatSessionStore.close();
});

test("Runtime 明示不支持物理删除时拒绝且不写入 delete_pending", async () => {
  let deleteCalls = 0;
  const value = boundControllerFixture({
    profile: profile({
      name: "Grok",
      runtime: "grok-build",
      runtimeProfileId: "shoggoth-grok",
      runtimeAccountId: "native-grok-build-default-v1",
      isDefault: false,
    }),
    host: {
      capabilities: { "session.delete": false },
      async sessionDelete() { deleteCalls += 1; return {}; },
    },
  });
  await value.controller.open();
  await assert.rejects(
    value.controller.handle("chat.session.delete", {
      operationId: "grok-delete-unsupported",
      sessionKey: value.bound.sessionKey,
      createdAt: 904,
    }, "grok-delete-unsupported"),
    (error) => error.code === "RUNTIME_CAPABILITY_UNSUPPORTED",
  );
  assert.equal(deleteCalls, 0);
  assert.equal(value.chatSessionStore.getSession(value.bound.sessionKey).status, "ready");
  assert.deepEqual(value.chatSessionStore.listPendingRemoteOperations(), []);
  await value.controller.close();
  value.chatSessionStore.close();
});

test("同 operationId 的并发 remote operation singleflight，冲突参数仍按 Store 幂等规则拒绝", async () => {
  let release;
  let enteredResolve;
  let hostCalls = 0;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const value = boundControllerFixture({
    host: {
      registeredSecrets: [],
      async threadSetName() {
        hostCalls += 1;
        enteredResolve();
        await new Promise((resolve) => { release = resolve; });
        return {};
      },
      async threadArchive() { return {}; }, async threadDelete() { return {}; },
      async threadRead() { assert.fail("not used"); },
    },
  });
  await value.controller.open();
  const params = {
    operationId: "rename-singleflight", sessionKey: value.bound.sessionKey,
    title: "Singleflight", createdAt: 907,
  };
  const first = value.controller.handle("chat.session.rename", params, "rename-first");
  const second = value.controller.handle("chat.session.rename", params, "rename-second");
  await entered;
  await assert.rejects(
    value.controller.handle("chat.session.rename", {
      ...params, title: "Conflicting title",
    }, "rename-conflict"),
    (error) => error.code === "CHAT_OPERATION_ID_CONFLICT",
  );
  assert.equal(hostCalls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.operation.state, "completed");
  assert.equal(hostCalls, 1);
  await value.controller.close();
  value.chatSessionStore.close();
});

test("chat.history 只读取 ready/archived thread，用最终 mapper 分页并原样透传 HMAC cursor", async () => {
  const readResponse = codexThreadReadFixture(Array.from({ length: 3 }, (_, index) => ({
    type: "agentMessage",
    id: `agent-history-${index}`,
    text: index === 1 ? "SECRET-HISTORY" : `history-${index}`,
    phase: index === 2 ? "final_answer" : "commentary",
    memoryCitation: null,
    delivery: null,
  })));
  const host = {
    registeredSecrets: ["SECRET-HISTORY"],
    async threadRead(params) {
      assert.deepEqual(params, { threadId: "thread-bound", includeTurns: true });
      return structuredClone(readResponse);
    },
    async threadSetName() { return {}; }, async threadArchive() { return {}; },
    async threadDelete() { return {}; },
  };
  const value = boundControllerFixture({
    host,
    runs: [run({ id: "run-history", sourceId: "99999999-9999-4999-8999-999999999999",
      codexThreadId: "thread-bound", codexTurnId: "turn-history" })],
  });
  await value.controller.open();
  const first = await value.controller.handle("chat.history", {
    sessionKey: value.bound.sessionKey, cursor: null, limit: 2,
  }, "history-first");
  assert.equal(first.messages.length, 2);
  assert.deepEqual(first.messages.map((item) => item.payload.message.content[0].text),
    ["[REDACTED]", "history-2"]);
  assert.deepEqual(first.messages.map((item) => item.runId), ["run-history", "run-history"]);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.nextCursor.includes("."), true);
  const second = await value.controller.handle("chat.history", {
    sessionKey: value.bound.sessionKey, cursor: first.nextCursor, limit: 2,
  }, "history-second");
  assert.deepEqual(second.messages.map((item) => item.payload.message.content[0].text),
    ["history-0"]);
  assert.equal(second.nextCursor, null);
  assert.equal(Buffer.byteLength(`${JSON.stringify({
    id: "history-first", ok: true, result: first,
  })}\n`) <= 64 * 1024, true);
  value.chatSessionStore.close();

  const draft = fixture();
  await draft.controller.open();
  await assert.rejects(
    draft.controller.handle("chat.history", {
      sessionKey: SESSION_KEY, cursor: null, limit: 2,
    }, "history-draft"),
    (error) => error.code === "CHAT_SESSION_NOT_READY",
  );
});

test("chat.history 对从未获得远端 turn 的不可读新线程返回空历史，已有 turn 仍严格失败", async () => {
  const unreadableHost = {
    registeredSecrets: [],
    async threadRead() {
      const error = new Error("thread not readable before first turn");
      error.code = "RPC_REMOTE_ERROR";
      throw error;
    },
    async threadSetName() { return {}; }, async threadArchive() { return {}; },
    async threadDelete() { return {}; },
  };
  const neverStarted = boundControllerFixture({
    host: unreadableHost,
    runs: [run({
      id: "run-never-started", sourceId: "99999999-9999-4999-8999-999999999999",
      status: "failed", errorCode: "CODEX_START_FAILED", codexThreadId: null,
      codexTurnId: null, startedAt: 900, finishedAt: 901,
    })],
  });
  await neverStarted.controller.open();
  const empty = await neverStarted.controller.handle("chat.history", {
    sessionKey: neverStarted.bound.sessionKey, cursor: null, limit: 100,
  }, "history-never-started");
  assert.deepEqual(empty, { messages: [], nextCursor: null, hasMore: false });
  await neverStarted.controller.close();
  neverStarted.chatSessionStore.close();

  const acceptedTurn = boundControllerFixture({
    host: unreadableHost,
    runs: [run({
      id: "run-accepted-turn", sourceId: "99999999-9999-4999-8999-999999999999",
      status: "failed", errorCode: "CODEX_RUNTIME_FAILED", codexThreadId: "thread-bound",
      codexTurnId: "turn-accepted", startedAt: 900, finishedAt: 901,
    })],
  });
  await acceptedTurn.controller.open();
  await assert.rejects(
    acceptedTurn.controller.handle("chat.history", {
      sessionKey: acceptedTurn.bound.sessionKey, cursor: null, limit: 100,
    }, "history-accepted-turn"),
    (error) => error.code === "RPC_REMOTE_ERROR",
  );
  await acceptedTurn.controller.close();
  acceptedTurn.chatSessionStore.close();
});

test("Controller.open 在对外服务前补偿 pending remote op，close 封住新请求并等待在途调用", async () => {
  const recovery = boundControllerFixture();
  recovery.chatSessionStore.requestArchive(recovery.bound.sessionKey, "recover-archive", 905);
  await recovery.controller.open();
  assert.deepEqual(recovery.chatSessionStore.listPendingRemoteOperations(), []);
  assert.deepEqual(recovery.calls.remote, [["archive", { threadId: "thread-bound" }]]);
  await recovery.controller.close();
  await assert.rejects(
    recovery.controller.handle("run.get", { runId: "run-1" }, "closed"),
    (error) => error.code === "SERVICE_UNAVAILABLE",
  );
  recovery.chatSessionStore.close();

  const clearing = boundControllerFixture();
  clearing.chatSessionStore.requestRename(
    clearing.bound.sessionKey, null, "recover-clear-title", 905,
  );
  await clearing.controller.open();
  assert.deepEqual(clearing.chatSessionStore.listPendingRemoteOperations(), []);
  assert.equal(clearing.chatSessionStore.getSession(clearing.bound.sessionKey).title, null);
  assert.deepEqual(clearing.calls.remote, [], "重启补偿清空标题同样不得触发 Codex rename");
  await clearing.controller.close();
  clearing.chatSessionStore.close();

  const deleting = boundControllerFixture();
  deleting.chatSessionStore.requestDelete(deleting.bound.sessionKey, "recover-delete", 905);
  await deleting.controller.open();
  const replacement = deleting.chatSessionStore.listSessions();
  assert.equal(replacement.length, 1, "补偿删除后仍须创建可见的默认 draft Session");
  assert.notEqual(replacement[0].sessionKey, deleting.bound.sessionKey);
  assert.equal(replacement[0].status, "draft");
  await deleting.controller.close();
  deleting.chatSessionStore.close();

  let releaseRemote;
  let enteredRemote;
  const entered = new Promise((resolve) => { enteredRemote = resolve; });
  const blocked = boundControllerFixture({
    host: {
      registeredSecrets: [],
      async threadSetName() {
        enteredRemote();
        await new Promise((resolve) => { releaseRemote = resolve; });
        return {};
      },
      async threadArchive() { return {}; }, async threadDelete() { return {}; },
      async threadRead() { assert.fail("not used"); },
    },
  });
  await blocked.controller.open();
  const request = blocked.controller.handle("chat.session.rename", {
    operationId: "rename-close-fence", sessionKey: blocked.bound.sessionKey,
    title: "Closing", createdAt: 906,
  }, "rename-close-fence");
  await entered;
  let closed = false;
  const closing = blocked.controller.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "close 必须等待在途 Host 调用退出");
  releaseRemote();
  await assert.rejects(request, (error) => error.code === "CHAT_SESSION_COMMIT_UNCERTAIN");
  await closing;
  assert.deepEqual(blocked.chatSessionStore.listPendingRemoteOperations()
    .map((item) => item.operationId), ["rename-close-fence"]);
  blocked.chatSessionStore.close();
});

test("history 对未绑定 draft Session 固定拒绝，不得触发 Runtime", async () => {
  const { controller } = fixture();
  await controller.open();
  await assert.rejects(
    controller.handle("chat.history", { sessionKey: SESSION_KEY, cursor: null, limit: 10 }, "history"),
    (error) => error.code === "CHAT_SESSION_NOT_READY",
  );
});

test("createAgentService 默认构造并暴露 Chat stores/Dispatcher/Coordinator/Controller", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-defaults-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const service = createAgentService({ paths, safeStorage: safeStorageFixture() });
  assert.equal(service.chatSessionStore instanceof ChatSessionStore, true);
  assert.equal(service.pendingCommandInbox instanceof PendingCommandInbox, true);
  assert.equal(service.tokenUsageStore instanceof TokenUsageStore, true);
  assert.equal(typeof service.workDispatcher.enqueue, "function");
  assert.equal(service.workRunCoordinator instanceof WorkRunCoordinator, true);
  assert.equal(typeof service.chatServiceController.handle, "function");
});

test("真实 Socket 在 listen 前创建默认 Session，并接通完整十五个严格 Chat Service 方法", async () => {
  const fixtureValue = serviceFixture();
  const { service, paths, calls } = fixtureValue;
  await service.start();
  try {
    assert.equal(calls.open, 1);
    const profiles = await ipc(paths, "profile.list", {
      backendId: "shoggoth", cursor: null, limit: 100, enabledOnly: true,
    });
    assert.deepEqual(profiles.profiles.map((item) => [item.id, item.name]), [
      [DEFAULT_AGENT_PROFILE_ID, "Shoggoth"],
    ]);
    const listed = await ipc(paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 100, includeArchived: false,
    });
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].status, "draft");
    assert.equal(listed.sessions[0].workspace,
      path.join(paths.defaultWorkspaceDir, DEFAULT_AGENT_PROFILE_ID));
    calls.sessionKey = listed.sessions[0].sessionKey;

    const created = await ipc(paths, "chat.session.create", {
      operationId: "create-over-ipc", profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null, createdAt: Date.now(),
    });
    assert.equal(created.session.profileId, DEFAULT_AGENT_PROFILE_ID);

    for (const [operationId, expected] of [
      ["queued-send", "queued"], ["started-send", "started"], ["terminal-replay", "completed"],
      ["o".repeat(128), "queued"],
    ]) {
      const sent = await ipc(paths, "chat.send", {
        operationId, sessionKey: calls.sessionKey, prompt: "hello", createdAt: Date.now(),
      }, operationId);
      assert.equal(sent.disposition, expected);
    }
    assert.deepEqual(calls.send.map((item) => Object.keys(item)), [
      ["operationId", "sessionKey", "prompt"],
      ["operationId", "sessionKey", "prompt"],
      ["operationId", "sessionKey", "prompt"],
      ["operationId", "sessionKey", "prompt"],
    ]);

    const runs = await ipc(paths, "run.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, sessionKey: calls.sessionKey,
      status: "queued", cursor: null, limit: 100,
    });
    assert.deepEqual(runs.runs.map((item) => item.id), ["run-1"]);
    assert.equal((await ipc(paths, "run.get", { runId: "run-1" })).run.id, "run-1");
    const subscribed = await ipc(paths, "run.subscribe", {
      runId: "run-1", streamId: "77777777-7777-4777-8777-777777777777",
      afterSeq: 0, limit: 100,
    });
    assert.equal(subscribed.gap.code, "STREAM_RESET");
    assert.equal(calls.subscribe, 1);
    assert.equal(calls.unsubscribe, 1);
    const authoritativeTerminal = await ipc(paths, "run.subscribe", {
      runId: "terminal-run", streamId: null, afterSeq: 9, limit: 100,
    });
    assert.equal(authoritativeTerminal.gap.code, "STREAM_RESET");
    assert.equal(authoritativeTerminal.gap.requestedStreamId, null);
    assert.equal(authoritativeTerminal.snapshot.run.status, "completed");
    assert.equal(calls.subscribe, 2);
    assert.equal(calls.unsubscribe, 2);

    const binding = service.chatSessionStore.requestBinding(
      calls.sessionKey, "socket-bind", Date.now(),
    );
    service.chatSessionStore.completeBinding(calls.sessionKey, binding.operationId, "thread-bound");
    const boundSession = service.chatSessionStore.getSession(calls.sessionKey);
    const boundProfile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    service.runtimeSessionOwnershipStore.claim({
      runtime: boundProfile.runtime,
      runtimeProfileId: boundProfile.runtimeProfileId,
      runtimeAccountId: boundProfile.runtimeAccountId,
      sessionId: "thread-bound",
      profileId: boundProfile.id,
      workspace: boundSession.workspace,
      status: "active",
      createdAt: boundSession.createdAt,
      lastSeenAt: boundSession.updatedAt,
    });
    const steered = await ipc(paths, "chat.steer", {
      operationId: "socket-steer", sessionKey: calls.sessionKey, runId: "run-1",
      message: "continue", createdAt: Date.now(),
    });
    assert.equal(steered.runId, "run-1");
    assert.equal((await ipc(paths, "chat.abort", {
      operationId: "socket-abort", sessionKey: calls.sessionKey, runId: "run-1",
      createdAt: Date.now(),
    })).run.status, "canceled");
    assert.equal((await ipc(paths, "run.approval.respond", {
      operationId: "socket-approval", createdAt: Date.now(), runId: "run-1",
      requestId: "approval-request", choice: "once",
    })).state, "responded");
    assert.equal((await ipc(paths, "run.input.respond", {
      operationId: "socket-input", createdAt: Date.now(), runId: "run-1",
      requestId: "input-request", action: "submit", answers: { question: "answer" },
    })).state, "responded");
    assert.equal((await ipc(paths, "chat.session.rename", {
      operationId: "socket-rename", sessionKey: calls.sessionKey,
      title: "Socket renamed", createdAt: Date.now(),
    })).operation.state, "completed");
    const cleared = await ipc(paths, "chat.session.rename", {
      operationId: "socket-clear-title", sessionKey: calls.sessionKey,
      title: null, createdAt: Date.now(),
    });
    assert.equal(cleared.session.title, null);
    assert.equal(cleared.operation.title, null);
    assert.equal(calls.remote.filter(([kind]) => kind === "rename").length, 1);
    assert.equal(calls.remote.some(([kind, params]) => kind === "rename" && params.name === null), false);
    const history = await ipc(paths, "chat.history", {
      sessionKey: calls.sessionKey, cursor: null, limit: 10,
    });
    assert.deepEqual(history.messages.map((item) => item.payload.message.content[0].text),
      ["socket history"]);
    assert.equal((await ipc(paths, "chat.session.archive", {
      operationId: "socket-archive", sessionKey: calls.sessionKey, createdAt: Date.now(),
    })).session.status, "archived");
    const deleted = await ipc(paths, "chat.session.delete", {
      operationId: "socket-delete", sessionKey: calls.sessionKey, createdAt: Date.now(),
    });
    assert.equal(deleted.session, null);
    assert.equal(deleted.operation.state, "completed");
    await assert.rejects(
      ipc(paths, "chat.send", {
        operationId: "unknown-field", sessionKey: calls.sessionKey,
        prompt: "hello", createdAt: Date.now(), extra: true,
      }),
      (error) => error.code === "INVALID_PARAMS",
    );
    const token = readClientToken(paths);
    const emptyRequest = {
      id: "send-frame-budget", token, version: PROTOCOL_VERSION, method: "chat.send",
      params: {
        operationId: "frame-budget", sessionKey: calls.sessionKey, prompt: "", createdAt: 1,
      },
    };
    const emptyBytes = Buffer.byteLength(`${JSON.stringify(emptyRequest)}\n`, "utf8");
    await assert.rejects(
      requestService(paths, {
        ...emptyRequest,
        params: { ...emptyRequest.params, prompt: "x".repeat((64 * 1024) - emptyBytes + 1) },
      }),
      (error) => error.code === "CHAT_SEND_TOO_LARGE",
    );
  } finally {
    await service.stop({ notify: false });
  }
  assert.equal(calls.close, 1);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("真实 Socket 暴露严格 usage series/breakdown 且 Service 拥有其生命周期", async () => {
  const fixtureValue = serviceFixture();
  const { service, paths } = fixtureValue;
  await service.start();
  try {
    ensureBuiltinCliAgentProfiles(service.productStore);
    service.tokenUsageStore.record({
      profileId: DEFAULT_AGENT_PROFILE_ID,
      agentId: `shoggoth-${DEFAULT_AGENT_PROFILE_ID}`,
      agentName: "Shoggoth",
      source: "chat",
      sourceId: SESSION_KEY,
      threadId: "thread-usage-ipc",
      turnId: "turn-usage-ipc",
      responseId: "response-usage-ipc",
      model: "gpt-5.6-sol",
      provider: "chatgpt",
      usage: {
        totalTokens: 100,
        inputTokens: 70,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
      createdAt: Date.now(),
    });
    for (const [index, spec] of BUILTIN_CLI_AGENT_PROFILES.entries()) {
      service.tokenUsageStore.record({
        profileId: spec.id,
        agentId: spec.agentId,
        agentName: spec.name,
        source: "chat",
        sourceId: `session-usage-${index}`,
        threadId: `thread-usage-${index}`,
        turnId: `turn-usage-${index}`,
        responseId: `response-usage-${index}`,
        model: index === 0 ? "gpt-5.6-sol" : "grok-4.6",
        provider: index === 0 ? "chatgpt" : "grok-build",
        usage: {
          totalTokens: 200 + (index * 100),
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 100 + (index * 100),
          reasoningOutputTokens: 0,
        },
        createdAt: Date.now(),
      });
    }
    const series = await ipc(paths, "usage.series", { range: "today", backendId: "shoggoth" });
    assert.equal(series.totals.totalTokens, 100);
    assert.equal(series.totals.cacheReadTokens, 20);
    const breakdown = await ipc(paths, "usage.breakdown", {
      range: "today", backendId: "shoggoth",
    });
    assert.deepEqual(breakdown.bySource.map((row) => [row.label, row.totalTokens]), [
      ["Shoggoth", 100],
    ]);
    assert.equal(breakdown.bySource[0].backendId, "shoggoth");
    assert.equal(breakdown.byModel[0].model, "gpt-5.6-sol");
    assert.equal(breakdown.topSessions[0].sessionId, SESSION_KEY);
    const codex = await ipc(paths, "usage.breakdown", { range: "today", backendId: "codex" });
    assert.deepEqual(codex.bySource.map((row) => [row.backendId, row.label, row.totalTokens]), [
      ["codex", "Codex", 200],
    ]);
    assert.equal(codex.topSessions[0].key.startsWith("codex:"), true);
    const grok = await ipc(paths, "usage.series", { range: "today", backendId: "grok-build" });
    assert.equal(grok.totals.totalTokens, 300);
    await assert.rejects(
      ipc(paths, "usage.series", { range: "forever", backendId: "shoggoth" }),
      (error) => error.code === "INVALID_PARAMS",
    );
    await assert.rejects(
      ipc(paths, "usage.series", { range: "today" }),
      (error) => error.code === "INVALID_PARAMS",
    );
    await assert.rejects(
      ipc(paths, "usage.series", { range: "today", backendId: "Codex" }),
      (error) => error.code === "INVALID_PARAMS",
    );
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
  assert.throws(
    () => service.tokenUsageStore.list(),
    (error) => error.code === "TOKEN_USAGE_STORE_CLOSED",
  );
});

test("真实 Socket 严格分派 Agent Harness Definition/Memory/Transcript/Tools 管理面", async () => {
  const fixtureValue = serviceFixture();
  const { service, paths } = fixtureValue;
  await service.start();
  try {
    const meta = await ipc(paths, "harness.definition.meta", {
      profileId: DEFAULT_AGENT_PROFILE_ID,
    });
    assert.equal(meta.current.revision, 1);
    assert.equal(meta.files.find((file) => file.kind === "USER").readOnly, true);
    const soul = await ipc(paths, "harness.definition.read", {
      profileId: DEFAULT_AGENT_PROFILE_ID, kind: "SOUL", revision: null,
    });
    assert.equal(soul.revision, 1);
    const updated = await ipc(paths, "harness.definition.update", {
      profileId: DEFAULT_AGENT_PROFILE_ID, kind: "SOUL", content: "# Socket Soul\n",
      expectedRevision: 1, reason: "socket-unit",
    });
    assert.equal(updated.current.revision, 2);
    await assert.rejects(ipc(paths, "harness.definition.update", {
      profileId: DEFAULT_AGENT_PROFILE_ID, kind: "SOUL", content: "stale",
      expectedRevision: 1, reason: null,
    }), (error) => error.code === "DEFINITION_REVISION_CONFLICT");
    const memories = await ipc(paths, "harness.memory.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, status: null, scope: null, cursor: 0, limit: 50,
    });
    assert.equal(memories.revision, 0);
    const sessions = await ipc(paths, "harness.transcript.sessions", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: 0, limit: 50,
    });
    assert.equal(Array.isArray(sessions.items), true);
    const tools = await ipc(paths, "harness.tools.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID,
    });
    assert.equal(tools.tools.length > 0, true);
    assert.equal(tools.registryRevision, service.toolRegistry.revision);
    await assert.rejects(ipc(paths, "harness.tools.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, extra: true,
    }), (error) => error.code === "INVALID_PARAMS");
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("默认 cursor secret 每个 start generation 轮换，显式测试 secret 跨 generation 保持", async () => {
  const firstFixture = serviceFixture();
  await firstFixture.service.start();
  let cursor;
  try {
    const sessions = await ipc(firstFixture.paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 1, includeArchived: false,
    });
    await ipc(firstFixture.paths, "chat.session.create", {
      operationId: "cursor-second-session", profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null, createdAt: Date.now(),
    });
    const page = await ipc(firstFixture.paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 1, includeArchived: false,
    });
    assert.equal(sessions.sessions.length, 1);
    assert.equal(page.hasMore, true);
    cursor = page.nextCursor;
  } finally {
    await firstFixture.service.stop({ notify: false });
  }
  await firstFixture.service.start();
  try {
    await assert.rejects(
      ipc(firstFixture.paths, "chat.session.list", {
        profileId: DEFAULT_AGENT_PROFILE_ID, cursor, limit: 1, includeArchived: false,
      }),
      (error) => error.code === "INVALID_PARAMS",
    );
  } finally {
    await firstFixture.service.stop({ notify: false });
  }
  const restarted = createAgentService({
    paths: firstFixture.paths,
    safeStorage: safeStorageFixture(),
    runtimePool: firstFixture.runtimePool,
    workRunCoordinator: firstFixture.fakeCoordinator,
  });
  await restarted.start();
  try {
    await assert.rejects(
      ipc(firstFixture.paths, "chat.session.list", {
        profileId: DEFAULT_AGENT_PROFILE_ID, cursor, limit: 1, includeArchived: false,
      }),
      (error) => error.code === "INVALID_PARAMS",
    );
  } finally {
    await restarted.stop({ notify: false });
  }

  const fixedSecret = serviceFixture({ chatCursorSecret: Buffer.alloc(32, 0x7a) });
  await fixedSecret.service.start();
  let fixedCursor;
  try {
    await ipc(fixedSecret.paths, "chat.session.create", {
      operationId: "fixed-secret-second", profileId: DEFAULT_AGENT_PROFILE_ID,
      workspace: null, createdAt: Date.now(),
    });
    fixedCursor = (await ipc(fixedSecret.paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 1, includeArchived: false,
    })).nextCursor;
    assert.equal(typeof fixedCursor, "string");
  } finally {
    await fixedSecret.service.stop({ notify: false });
  }
  await fixedSecret.service.start();
  try {
    const continued = await ipc(fixedSecret.paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: fixedCursor,
      limit: 1, includeArchived: false,
    });
    assert.equal(continued.sessions.length, 1);
  } finally {
    await fixedSecret.service.stop({ notify: false });
  }
});

test("stop 严格先关 Coordinator 再停 Runtime，随后关 Inbox/Chat，最后 Product/Secret", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-stop-order-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const order = [];
  const coordinator = {
    async open() {},
    async close() { order.push("coordinator"); },
    listRuns() { return []; },
    getRun() { return null; },
    async send() { assert.fail("not used"); },
    subscribeRun() { assert.fail("not used"); },
  };
  const runtimePool = {
    get() { assert.fail("not used"); },
    async stopAll() { order.push("runtime"); },
  };
  const service = createAgentService({
    paths, safeStorage: safeStorageFixture(), runtimePool, workRunCoordinator: coordinator,
  });
  for (const [resource, name] of [
    [service.pendingCommandInbox, "inbox"],
    [service.chatSessionStore, "chat"],
    [service.productStore, "product"],
    [service.secretStore, "secret"],
  ]) {
    const original = resource.close.bind(resource);
    resource.close = async (...args) => {
      order.push(name);
      return original(...args);
    };
  }
  await service.start();
  await service.stop({ notify: false });
  await service.stop({ notify: false });
  const at = (name) => order.indexOf(name);
  assert.equal(at("coordinator") < at("runtime"), true, order.join(" > "));
  assert.equal(at("runtime") < at("inbox"), true, order.join(" > "));
  assert.equal(at("runtime") < at("chat"), true, order.join(" > "));
  assert.equal(at("inbox") < at("product"), true, order.join(" > "));
  assert.equal(at("chat") < at("product"), true, order.join(" > "));
  assert.equal(at("product") < at("secret"), true, order.join(" > "));
  assert.equal(order.filter((name) => name === "coordinator").length, 1);
});

test("stop 即使 Coordinator/Runtime/Inbox 失败仍 best-effort 聚合并清理 socket/lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-stop-aggregate-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const calls = [];
  const coordinator = {
    async open() {},
    async close() {
      calls.push("coordinator");
      throw Object.assign(new Error("coordinator close"), { code: "COORDINATOR_CLOSE_FAILED" });
    },
    listRuns() { return []; }, getRun() { return null; },
    async send() { assert.fail("not used"); }, subscribeRun() { assert.fail("not used"); },
  };
  const runtimePool = {
    get() { assert.fail("not used"); },
    async stopAll() {
      calls.push("runtime");
      throw Object.assign(new Error("runtime close"), { code: "RUNTIME_CLOSE_FAILED" });
    },
  };
  const service = createAgentService({
    paths, safeStorage: safeStorageFixture(), runtimePool, workRunCoordinator: coordinator,
  });
  const originalInboxClose = service.pendingCommandInbox.close.bind(service.pendingCommandInbox);
  service.pendingCommandInbox.close = () => {
    calls.push("inbox");
    originalInboxClose();
    throw Object.assign(new Error("inbox close"), { code: "INBOX_CLOSE_FAILED" });
  };
  const originalChatClose = service.chatSessionStore.close.bind(service.chatSessionStore);
  service.chatSessionStore.close = () => { calls.push("chat"); return originalChatClose(); };
  await service.start();
  let firstError;
  await assert.rejects(service.stop({ notify: false }), (error) => {
    firstError = error;
    assert.equal(error.code, "SERVICE_STOP_FAILED");
    assert.deepEqual(new Set(error.errors.map((entry) => entry.code)), new Set([
      "COORDINATOR_CLOSE_FAILED", "RUNTIME_CLOSE_FAILED", "INBOX_CLOSE_FAILED",
    ]));
    return true;
  });
  await assert.rejects(service.stop({ notify: false }), (error) => error === firstError);
  assert.deepEqual(calls, ["coordinator", "runtime", "inbox", "chat"]);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("Coordinator.open 失败走统一 startup cleanup，已打开的 Chat/Inbox/Product 与 owner 文件全部释放", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-start-cleanup-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const calls = [];
  const coordinator = {
    async open() {
      calls.push("coordinator.open");
      throw Object.assign(new Error("open failed"), { code: "COORDINATOR_OPEN_FAILED" });
    },
    async close() { calls.push("coordinator.close"); },
    listRuns() { return []; }, getRun() { return null; },
    async send() { assert.fail("not used"); }, subscribeRun() { assert.fail("not used"); },
  };
  const runtimePool = {
    get() { assert.fail("not used"); },
    async stopAll() { calls.push("runtime.stop"); },
  };
  const service = createAgentService({
    paths, safeStorage: safeStorageFixture(), runtimePool, workRunCoordinator: coordinator,
  });
  await assert.rejects(service.start(), (error) => error.code === "COORDINATOR_OPEN_FAILED");
  assert.deepEqual(calls, ["coordinator.open", "coordinator.close", "runtime.stop"]);
  assert.throws(() => service.chatSessionStore.listSessions(), /未打开|closed/i);
  assert.throws(() => service.pendingCommandInbox.list(), /未打开|closed/i);
  assert.throws(() => service.productStore.listAgentProfiles(), /未打开|closed/i);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.tokenPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("默认 Coordinator 用 open 期 SecretStore cache 同步有界扫描最终 JSON 与 summary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-secret-scan-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const state = { available: true };
  const service = createAgentService({ paths, safeStorage: safeStorageFixture(state) });
  await service.start();
  try {
    const secret = "dynamic-secret-canary-123456";
    await service.secretStore.put("scan-secret", secret, { kind: "openrouter" });
    const escapedSecret = "dynamic-\\\"secret-canary-escaped";
    await service.secretStore.put("scan-secret-escaped", escapedSecret, { kind: "openrouter" });
    assert.equal(service.workRunCoordinator.assertSecretSafe({ text: "ordinary" }), true);
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe({ nested: { text: secret } }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret),
    );
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe({ nested: { text: escapedSecret } }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
      "JSON 转义不得让动态 secret 绕过最终稳定值检查",
    );
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe({ [escapedSecret]: "value" }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
      "JSON object key 中的转义 secret 也必须拒绝",
    );
    const circular = {};
    circular.self = circular;
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe(circular),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
    );
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe({ text: "x".repeat(65 * 1024) }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
    );
    assert.equal(service.workRunCoordinator.sanitizeSummary("ordinary summary"), "ordinary summary");
    assert.equal(service.workRunCoordinator.sanitizeSummary(`prefix ${secret} suffix`), null);
    assert.equal(service.workRunCoordinator.sanitizeSummary("invalid\0summary"), null);
    assert.equal(service.workRunCoordinator.sanitizeSummary("x".repeat(17 * 1024)), null);
    state.available = false;
    assert.equal(
      service.workRunCoordinator.assertSecretSafe({ text: "ordinary" }),
      true,
    );
    assert.throws(
      () => service.workRunCoordinator.assertSecretSafe({ text: secret }),
      (error) => error.code === "RUN_EVENT_SECRET_REJECTED",
    );
    assert.equal(service.workRunCoordinator.sanitizeSummary("ordinary summary"), "ordinary summary");
  } finally {
    state.available = true;
    await service.stop({ notify: false });
  }
});

test("safeStorage 初始 locked 不阻止 Service 启动，但 chat.send 在写加密 Inbox 前明确失败", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-locked-send-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const state = { available: false };
  const runtimePool = {
    get() { assert.fail("Inbox 加密失败后不得触发 Codex runtime"); },
    async stopAll() {},
  };
  const service = createAgentService({
    paths, safeStorage: safeStorageFixture(state), runtimePool,
  });
  await service.start();
  try {
    const sessions = await ipc(paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10, includeArchived: false,
    });
    assert.equal(sessions.sessions.length, 1);
    await assert.rejects(
      ipc(paths, "chat.send", {
        operationId: "locked-send", sessionKey: sessions.sessions[0].sessionKey,
        prompt: "hello", createdAt: Date.now(),
      }),
      (error) => error.code === "SERVICE_UNAVAILABLE",
    );
    assert.deepEqual(service.productStore.listWorkRuns(), []);
  } finally {
    await service.stop({ notify: false });
  }
});

test("非空加密 Inbox 解密 locked 时 Service 只读启动且证据保留，解锁重启后恢复原 tombstone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-locked-restart-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const state = { available: true };
  const host = {
    registeredSecrets: [],
    async threadRead(params) {
      assert.deepEqual(params, { threadId: "thread-locked-restart", includeTurns: true });
      return codexThreadReadFixture([{
        type: "agentMessage", id: "locked-history", text: "history remains readable",
        phase: "final_answer", memoryCitation: null, delivery: null,
      }], { id: "thread-locked-restart" });
    },
  };
  const runtimePool = { async get() { return host; }, async stopAll() {} };
  const safeStorage = safeStorageFixture(state);
  const first = createAgentService({ paths, safeStorage, runtimePool });
  await first.start();
  const sessionValue = first.chatSessionStore.listSessions()[0];
  const binding = first.chatSessionStore.requestBinding(
    sessionValue.sessionKey, "bind-locked-restart", Date.now(),
  );
  first.chatSessionStore.completeBinding(
    sessionValue.sessionKey, binding.operationId, "thread-locked-restart",
  );
  const command = {
    operationId: "locked-restart-command",
    runId: "locked-restart-run",
    sessionKey: sessionValue.sessionKey,
    prompt: "encrypted-evidence-must-survive",
    createdAt: Date.now(),
  };
  await first.pendingCommandInbox.enqueue(command);
  await first.pendingCommandInbox.transition(command.operationId, "dispatching");
  await first.pendingCommandInbox.transition(command.operationId, "completed");
  await first.stop({ notify: false });
  const evidencePath = path.join(paths.stateDir, "pending-commands.json");
  const encryptedEvidence = fs.readFileSync(evidencePath);

  state.available = false;
  const locked = createAgentService({ paths, safeStorage, runtimePool });
  await locked.start();
  try {
    assert.equal(locked.pendingCommandInbox.isLocked(), true);
    assert.equal((await ipc(paths, "service.status", {})).healthy, true);
    const listed = await ipc(paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10, includeArchived: false,
    });
    assert.equal(listed.sessions[0].sessionKey, sessionValue.sessionKey);
    const history = await ipc(paths, "chat.history", {
      sessionKey: sessionValue.sessionKey, cursor: null, limit: 10,
    });
    assert.equal(history.messages.some(
      (message) => message.payload?.message?.content?.[0]?.text === "history remains readable",
    ), true);
    await assert.rejects(
      ipc(paths, "chat.send", {
        operationId: "locked-restart-new-send",
        sessionKey: sessionValue.sessionKey,
        prompt: "must fail without replacing evidence",
        createdAt: Date.now(),
      }),
      (error) => error.code === "SERVICE_UNAVAILABLE",
    );
    assert.equal(fs.readFileSync(evidencePath).equals(encryptedEvidence), true);
  } finally {
    await locked.stop({ notify: false });
  }

  state.available = true;
  const recovered = createAgentService({ paths, safeStorage, runtimePool });
  await recovered.start();
  try {
    assert.equal(recovered.pendingCommandInbox.isLocked(), false);
    assert.equal(recovered.pendingCommandInbox.get(command.operationId).state, "completed");
    assert.equal(recovered.pendingCommandInbox.list().filter(
      (entry) => entry.operationId === command.operationId,
    ).length, 1);
  } finally {
    await recovered.stop({ notify: false });
  }
});

test("ready 发布前按 crash cut 恢复：chat running/waiting 先 durable interrupted，starting 由 Coordinator 对账", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-chat-recovery-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const safeStorage = safeStorageFixture();
  const runtimePool = {
    get() { assert.fail("丢失 execution contract 的 starting 恢复不得启动 Codex runtime"); },
    async stopAll() {},
  };
  const first = createAgentService({ paths, safeStorage, runtimePool });
  const before = new Map();
  await first.start();
  try {
    const profile = first.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    first.productStore.putAgentProfile({
      ...profile,
      concurrency: { maxActive: 4, maxWorkspaceWrites: 4 },
    });
    const sessionValue = first.chatSessionStore.listSessions()[0];
    for (const status of ["starting", "running", "waiting_approval", "waiting_input"]) {
      const operationId = `recover-${status}`;
      const runId = `run-${status}`;
      const createdAt = Date.now();
      first.pendingCommandInbox.enqueue({
        operationId, runId, sessionKey: sessionValue.sessionKey,
        prompt: `prompt-${status}`, createdAt,
      });
      // starting + pending 是 send 已完成 durable admit、后台 drive 尚未开始时的合法 crash cut。
      if (status !== "starting") {
        first.pendingCommandInbox.transition(operationId, "dispatching");
      }
      first.workDispatcher.enqueue({
        id: runId,
        source: "chat",
        sourceId: sessionValue.sessionKey,
        idempotencyKey: `shoggoth:chat-send:${operationId}`,
        profileId: DEFAULT_AGENT_PROFILE_ID,
        workspace: sessionValue.workspace,
        retryOf: null,
      });
      first.workDispatcher.admit(runId, { writable: false });
      if (status !== "starting") {
        const { runtimeProfileId, runtimeAccountId } = first.productStore
          .getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
        first.workDispatcher.transition(runId, "running", {
          runtimeSessionRef: {
            runtime: "codex", runtimeProfileId, runtimeAccountId,
            sessionId: `thread-${status}`,
          },
          runtimeTurnRef: {
            runtime: "codex", runtimeProfileId, runtimeAccountId,
            sessionId: `thread-${status}`,
            turnId: `turn-${status}`,
          },
        });
      }
      if (["waiting_approval", "waiting_input"].includes(status)) {
        first.workDispatcher.transition(runId, status, { waitingRequestId: `request-${status}` });
      }
      before.set(runId, first.workDispatcher.getRun(runId));
    }
  } finally {
    await first.stop({ notify: false });
  }

  const delayedCryptoBroker = {
    open() {},
    close() {},
    loadOrCreateForService() { return Promise.reject(new Error("not-used")); },
    async encrypt(payload) { return Buffer.from(payload); },
    async decrypt(payload) {
      const owned = Buffer.from(payload);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return owned;
    },
  };
  const second = createAgentService({
    paths,
    cryptoBroker: delayedCryptoBroker,
    pendingCommandDecryptStartupBudgetMs: 10,
    runtimePool,
  });
  await second.start();
  try {
    const recoveryDeadline = Date.now() + 1_000;
    while (Date.now() < recoveryDeadline && [...before.keys()].some((runId) => (
      second.workDispatcher.getRun(runId).status !== "interrupted"
    ))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(second.pendingCommandInbox.isLocked(), false);
    for (const [runId, previous] of before) {
      const recovered = second.workDispatcher.getRun(runId);
      const tombstone = second.pendingCommandInbox.get(`recover-${runId.slice(4)}`);
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.eventSeq, previous.eventSeq + 1);
      assert.equal(
        recovered.errorCode,
        previous.status === "starting" ? "EXECUTION_CONTRACT_LOST" : "SERVICE_RESTARTED",
      );
      assert.equal(tombstone?.state, "completed");
      assert.equal(Object.prototype.hasOwnProperty.call(tombstone, "prompt"), false);
    }
    assert.equal(second.chatSessionStore.listSessions().length, 1, "重启不得重复默认 Session");
  } finally {
    await second.stop({ notify: false });
  }
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
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
  else console.log(`shoggoth service chat unit: ${tests.length} passed`);
})();
