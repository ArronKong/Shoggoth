"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const STREAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STREAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function profile(patch = {}) {
  return {
    id: "profile-default",
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
    ...patch,
  };
}

function session(id = SESSION_A, patch = {}) {
  return {
    id,
    sessionKey: id,
    profileId: "profile-default",
    codexThreadId: null,
    workspace: "/tmp/shoggoth-managed",
    title: "A real chat",
    modelOverride: null,
    permissionMode: null,
    status: "draft",
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

function run(status = "running", patch = {}) {
  const terminal = ["completed", "failed", "canceled", "interrupted", "skipped"].includes(status);
  const queued = status === "queued";
  return {
    id: "run-1",
    source: "chat",
    sourceId: SESSION_A,
    idempotencyKey: "idem-1",
    profileId: "profile-default",
    workspace: "/tmp/shoggoth-managed",
    status,
    codexThreadId: queued ? null : "thread-1",
    codexTurnId: queued ? null : "turn-1",
    eventSeq: 1,
    waitingRequestId: status === "waiting_approval" || status === "waiting_input" ? "request-1" : null,
    startedAt: queued ? null : 100,
    finishedAt: terminal ? 200 : null,
    resultSummary: status === "completed" ? "done" : null,
    errorCode: status === "failed" || status === "interrupted" ? "MODEL_FAILED" : null,
    retryOf: null,
    ...patch,
  };
}

function page(field, values, nextCursor = null) {
  return { [field]: values, nextCursor, hasMore: nextCursor !== null };
}

function serviceEventPage(events, options = {}) {
  const afterSeq = options.afterSeq ?? 0;
  const cursor = options.cursor ?? events.at(-1)?.seq ?? afterSeq;
  return {
    streamId: options.streamId ?? STREAM_A,
    events,
    cursor,
    nextCursor: cursor,
    hasMore: options.hasMore ?? false,
    oldestSeq: events[0]?.seq ?? cursor + 1,
    baseSeq: options.baseSeq ?? 0,
    latestSeq: options.latestSeq ?? cursor,
    gap: options.gap ?? null,
    snapshot: options.snapshot ?? null,
  };
}

function readyStatus(ready = true) {
  return {
    healthy: true,
    pendingCommandsLocked: !ready,
    mcpCredentialsLocked: !ready,
  };
}

async function waitForCondition(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition timeout");
}

function historyItem(message, patch = {}) {
  return {
    id: "history-1",
    runId: "run-1",
    role: message.role || "assistant",
    type: "text",
    payload: { message },
    createdAt: 100,
    fragment: null,
    ...patch,
  };
}

function event(seq, type, payload) {
  return { runId: "run-1", streamId: STREAM_A, seq, type, payload };
}

function subscription(events, options = {}) {
  const cursor = options.cursor ?? 0;
  const latest = options.latestSeq ?? (events.at(-1)?.seq || cursor);
  return {
    runId: "run-1",
    streamId: STREAM_A,
    events,
    cursor,
    nextCursor: options.nextCursor ?? (events.at(-1)?.seq || cursor),
    hasMore: options.hasMore ?? false,
    baseSeq: options.baseSeq ?? (latest > 0 ? 1 : 0),
    latestSeq: latest,
    gap: options.gap ?? null,
    snapshot: options.snapshot ?? null,
  };
}

function cursorGapSnapshot(snapshotRun) {
  const snapshot = { run: snapshotRun };
  if (snapshotRun.waitingRequestId) {
    const approval = snapshotRun.status === "waiting_approval";
    snapshot.interaction = {
      type: approval ? "approval" : "prompt",
      payload: approval ? {
        requestId: snapshotRun.waitingRequestId,
        kind: "command",
        command: "pwd",
        reason: "Need permission",
      } : {
        requestId: snapshotRun.waitingRequestId,
        method: "mcpServer/elicitation/request",
        kind: "mcp_elicitation",
        serverName: "fixture",
        mode: "form",
        message: "Need input",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string", title: "Answer" } },
          required: ["answer"],
        },
      },
    };
  }
  return {
    runId: "run-1", streamId: STREAM_A, events: [], cursor: 3, nextCursor: 3,
    hasMore: false, baseSeq: 3, latestSeq: 3,
    gap: { code: "CURSOR_GAP", requestedAfterSeq: 0, baseSeq: 3 },
    snapshot,
  };
}

function nonterminalStreamReset(snapshotRun) {
  const authoritative = cursorGapSnapshot(snapshotRun).snapshot;
  return {
    runId: "run-1", streamId: STREAM_B, events: [], cursor: 2, nextCursor: 2,
    hasMore: false, baseSeq: 1, latestSeq: 2,
    gap: {
      code: "STREAM_RESET", requestedStreamId: STREAM_A, currentStreamId: STREAM_B,
      requestedAfterSeq: 0, baseSeq: 1, latestSeq: 2,
    },
    snapshot: authoritative,
  };
}

function federationInteractionReset(request, snapshotRun, interactionPayload, streamId = STREAM_B) {
  return {
    runId: snapshotRun.id,
    streamId,
    events: [],
    cursor: snapshotRun.eventSeq,
    nextCursor: snapshotRun.eventSeq,
    hasMore: false,
    baseSeq: snapshotRun.eventSeq > 0 ? 1 : 0,
    latestSeq: snapshotRun.eventSeq,
    gap: {
      code: "STREAM_RESET",
      requestedStreamId: request.params.streamId,
      currentStreamId: streamId,
      requestedAfterSeq: 0,
      baseSeq: snapshotRun.eventSeq > 0 ? 1 : 0,
      latestSeq: snapshotRun.eventSeq,
    },
    snapshot: {
      run: snapshotRun,
      interaction: {
        type: snapshotRun.status === "waiting_approval" ? "approval" : "prompt",
        payload: interactionPayload,
      },
    },
  };
}

function fakeBackend(handler, options = {}) {
  const calls = [];
  let tokenReads = 0;
  let uuidCounter = 0;
  let serviceStatusCalls = 0;
  const backend = new ShoggothBackend({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.connectionMode === undefined ? {} : { connectionMode: options.connectionMode }),
    ...(options.claimsAgentId === undefined ? {} : { claimsAgentId: options.claimsAgentId }),
    paths: options.paths || { tokenPath: "/private/client.token" },
    readToken(paths) {
      assert.equal(paths.tokenPath, "/private/client.token");
      tokenReads += 1;
      return `fresh-token-${tokenReads}`;
    },
    requestService: async (paths, request, requestOptions) => {
      calls.push(structuredClone({ paths, request, requestOptions }));
      if (request.method === "service.status") {
        const callNumber = serviceStatusCalls;
        serviceStatusCalls += 1;
        return options.serviceStatus
          ? options.serviceStatus(callNumber, requestOptions)
          : readyStatus(true);
      }
      return handler(request, calls.length);
    },
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    now: () => 1234,
    version: options.version,
    delay: options.delay || (() => Promise.resolve()),
    pollIntervalMs: 1,
    maxPollErrors: options.maxPollErrors || 3,
    maxPages: options.maxPages || 8,
    readinessNow: options.readinessNow,
    readinessTimeoutMs: options.readinessTimeoutMs,
    readinessIntervalMs: options.readinessIntervalMs,
    serviceStatusTimeoutMs: options.serviceStatusTimeoutMs,
    readinessMaxAttempts: options.readinessMaxAttempts,
    serviceEventPollMs: options.serviceEventPollMs,
    runtimeCliAuth: options.runtimeCliAuth,
  });
  backend._serviceEventStreamId = Object.prototype.hasOwnProperty.call(
    options,
    "initialServiceEventStreamId",
  ) ? options.initialServiceEventStreamId : STREAM_A;
  return { backend, calls, tokenReads: () => tokenReads };
}

async function readyBackend(handler, options = {}) {
  const value = fakeBackend((request, callNumber) => {
    if (request.method === "profile.list") {
      return page("profiles", options.profiles || [profile()]);
    }
    if (request.method === "chat.session.list") {
      return page("sessions", options.sessions || [session()]);
    }
    return handler(request, callNumber);
  }, options);
  assert.equal(await value.backend.start(), true);
  value.calls.length = 0;
  return value;
}

test("identity, namespace and capability contract", () => {
  const { backend } = fakeBackend(() => { throw new Error("unused"); });
  assert.equal(backend instanceof AgentBackend, true);
  assert.equal(backend.id, "shoggoth");
  assert.equal(backend.name, "Shoggoth");
  assert.equal(backend.claimsAgentId("shoggoth-anything"), true);
  assert.equal(backend.claimsAgentId("hermes-default"), false);
  assert.deepEqual(backend.getChatCapabilities("shoggoth-default"), {
    attachments: {}, slash: false, notReady: true,
  });
});

test("peer native facade loads and stamps only its backendId profile partition", async () => {
  const codexProfile = profile({
    id: "profile-codex",
    backendId: "codex",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtimeProfileId: "runtime-codex",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  const codexSession = session(SESSION_A, {
    profileId: codexProfile.id,
    derivedTitle: "第一条 Codex 消息",
  });
  const emptyParts = {
    totalTokens: 0, totalCost: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  };
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") {
      assert.equal(request.params.backendId, "codex");
      return page("profiles", [codexProfile]);
    }
    if (request.method === "chat.session.list") return page("sessions", [codexSession]);
    if (request.method === "usage.series") {
      assert.deepEqual(request.params, { range: "today", backendId: "codex" });
      return { daily: [], totals: { ...emptyParts, missingCostEntries: 0 } };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    id: "codex",
    name: "Codex",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex",
  });
  assert.equal(await value.backend.start(), true);
  assert.deepEqual(value.backend.getAgents(), [{
    id: "shoggoth-codex", name: "Codex", model: undefined,
    provider: "codex", runtime: "codex",
    runtimeAccountId: "fixture-runtime-account",
    environmentKind: "native-user", sharedAgentCount: 1,
    backendId: "codex",
  }]);
  assert.equal(value.backend.getSessionRows()[0].backendId, "codex");
  assert.equal(value.backend.getSessionRows()[0].agentId, "shoggoth-codex");
  assert.equal(value.backend.getSessionRows()[0].derivedTitle, "第一条 Codex 消息");
  assert.equal(value.backend.claimsAgentId("shoggoth-codex"), true);
  assert.equal(value.backend.claimsAgentId("shoggoth-default"), false);
  assert.equal(value.backend.getBackendDescriptor().connectionMode, "native-runtime");
  assert.deepEqual(await value.backend.getUsageSeries("today"), {
    daily: [], totals: { ...emptyParts, missingCostEntries: 0 },
  });

  const foreign = fakeBackend((request) => {
    if (request.method === "profile.list") {
      return page("profiles", [{ ...codexProfile, backendId: "grok-build" }]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    id: "codex", name: "Codex", connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex",
  });
  assert.equal(await foreign.backend.start(), false);
  assert.deepEqual(foreign.backend.getAgents(), []);
});

test("status and read-only model catalog reflect the loaded lifecycle", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { backend } = fakeBackend(async (request) => {
    if (request.method === "profile.list") {
      await gate;
      return page("profiles", [
        profile(),
        profile({ id: "profile-2", agentId: "shoggoth-two", name: "Two" }),
        profile({ id: "profile-3", agentId: "shoggoth-three", name: "Three", defaultModel: null }),
      ]);
    }
    if (request.method === "profile.models.list") {
      return request.params.cursor === null
        ? page("models", [{
            id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "", isDefault: true,
          }], "models-next")
        : page("models", [{
            id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", description: "", isDefault: false,
          }]);
    }
    return page("sessions", request.params.profileId === "profile-default" ? [session()] : []);
  });
  assert.deepEqual(await backend.getStatus(), {
    id: "shoggoth", name: "Shoggoth", connected: false,
    info: { connectionMode: "builtin-service", state: "stopped", readyAgentIds: [] },
  });
  const starting = backend.start();
  assert.deepEqual(await backend.getStatus(), {
    id: "shoggoth", name: "Shoggoth", connected: false,
    info: {
      connectionMode: "builtin-service", state: "starting", starting: true, readyAgentIds: [],
    },
  });
  release();
  assert.equal(await starting, true);
  assert.deepEqual(await backend.getStatus(), {
    id: "shoggoth", name: "Shoggoth", connected: true,
    info: {
      connectionMode: "builtin-service", state: "started", agents: 3, sessions: 1,
      readyAgentIds: ["shoggoth-default", "shoggoth-two", "shoggoth-three"],
    },
  });
  const expected = [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openrouter", backendId: "shoggoth",
      modelScopes: ["profile-2", "profile-3", "profile-default"],
      defaultModelScopes: ["profile-2", "profile-3", "profile-default"] },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openrouter", backendId: "shoggoth",
      modelScopes: ["profile-2", "profile-3", "profile-default"] },
  ];
  assert.deepEqual(await backend.getModels(), expected);
  assert.deepEqual(await backend.getModelCatalogSources(), {
    models: expected, config: [], runtime: expected,
  });
});

test("native model catalog cold reads have a runtime budget and retain inherited defaults", async () => {
  for (const runtime of ["codex", "grok-build", "antigravity", "pi", "claude-code", "deepseek-harness"]) {
    const bound = profile({ backendId: runtime, runtime, providerRef: null, defaultModel: null });
    const { backend, calls } = fakeBackend((request) => {
      if (request.method === "profile.list") return page("profiles", [bound]);
      if (request.method === "chat.session.list") return page("sessions", []);
      if (request.method === "profile.models.list") {
        // Real Codex discovery took 27.7 seconds while ordinary Service reads took milliseconds.
        if (calls.at(-1).requestOptions.timeoutMs < 30_000) {
          throw Object.assign(new Error("cold discovery timeout"), { code: "REQUEST_TIMEOUT" });
        }
        return page("models", [{ id: "native-default", displayName: "Native default", description: "", isDefault: true }]);
      }
    }, { id: runtime });
    assert.equal(await backend.start(), true);
    const catalog = await backend.getModelCatalogSources();
    assert.equal(catalog.models[0]?.id, "native-default", runtime);
    assert.deepEqual(catalog.models[0].defaultModelScopes, [bound.id]);
    assert.ok(calls.filter(({ request }) => request.method === "profile.models.list")
      .every(({ requestOptions }) => requestOptions.timeoutMs <= 60_000));
    assert.equal(calls.find(({ request }) => request.method === "profile.list").requestOptions.timeoutMs, 5_000);
    await backend.stop();
  }
});

test("fresh model catalog waits for discovery instead of certifying a stale cache", async () => {
  let modelId = "before";
  const { backend } = await readyBackend((request) => {
    if (request.method === "profile.models.list") return page("models", [
      { id: modelId, displayName: modelId, description: "", isDefault: true },
    ]);
  });
  assert.equal((await backend.getModelCatalogSources()).models[0].id, "before");
  modelId = "after";
  assert.equal((await backend.getModelCatalogSources({ fresh: true })).models[0].id, "after");
  await backend.stop();
});

test("a backend with no visible profiles has a valid empty model catalog", async () => {
  const { backend, calls } = await readyBackend(() => undefined, { profiles: [], sessions: [] });
  assert.deepEqual((await backend.getModelCatalogSources()).models, []);
  assert.equal(calls.some(({ request }) => request.method === "profile.models.list"), false);
  await backend.stop();
});

test("failed or partial model discovery never publishes an empty or incomplete verified catalog", async () => {
  for (const failedProfiles of [["profile-default"], ["profile-other"], ["profile-default", "profile-other"]]) {
    let fail = true;
    const { backend } = await readyBackend((request) => {
      if (request.method !== "profile.models.list") return;
      if (fail && failedProfiles.includes(request.params.profileId)) {
        throw Object.assign(new Error("runtime unavailable"), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
      }
      return page("models", [{ id: request.params.profileId, displayName: "Model", description: "", isDefault: true }]);
    }, { profiles: [profile(), profile({ id: "profile-other", agentId: "shoggoth-other" })] });
    await assert.rejects(backend.getModelCatalogSources(), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
    fail = false;
    const verified = await backend.getModelCatalogSources();
    assert.equal(verified.models.length, 2);
    fail = true;
    await assert.rejects(backend.getModelCatalogSources(), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
    assert.deepEqual(await backend.getModels(), verified.models, "failed refresh must preserve the last known catalog");
    await backend.stop();
  }
});

test("model discovery from an earlier backend generation cannot win after reconnect", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let old = true;
  const { backend } = await readyBackend(async (request) => {
    if (request.method !== "profile.models.list") return;
    const id = old ? "old" : "new";
    if (old) await gate;
    return page("models", [{ id, displayName: id, description: "", isDefault: true }]);
  });
  const stale = backend.getModelCatalogSources();
  const rejected = assert.rejects(stale, { code: "SERVICE_UNAVAILABLE" });
  await backend.stop();
  old = false;
  assert.equal(await backend.start(), true);
  const fresh = backend.getModelCatalogSources();
  release();
  await rejected;
  assert.equal((await fresh).models[0].id, "new");
  await backend.stop();
});

test("runtime catalog/provider stays bound to each visible Agent", async () => {
  const codex = profile({ providerRef: null, defaultModel: null });
  const codexOther = profile({
    id: "profile-codex-other",
    agentId: "shoggoth-codex-other",
    name: "Codex Other",
    runtimeProfileId: "runtime-codex-other",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  const grok = profile({
    id: "profile-grok",
    agentId: "shoggoth-grok",
    name: "Grok",
    runtime: "grok-build",
    runtimeProfileId: "runtime-grok",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [codex, codexOther, grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.models.list") {
      return page("models", request.params.profileId === grok.id
        ? [
            { id: "grok-4.6", displayName: "Grok 4.6", description: "", isDefault: true },
            { id: "shared", displayName: "Shared via Grok", description: "", isDefault: false },
          ]
        : request.params.profileId === codexOther.id ? [
            { id: "codex-other", displayName: "Codex Other", description: "", isDefault: true },
            { id: "shared", displayName: "Shared via Other", description: "", isDefault: false },
          ] : [
            { id: "gpt-5.6", displayName: "GPT-5.6", description: "", isDefault: true },
            { id: "shared", displayName: "Shared via Codex", description: "", isDefault: false },
          ]);
    }
    if (request.method === "chat.session.create") {
      return { session: session(SESSION_A, { profileId: grok.id }) };
    }
    if (request.method === "chat.session.model.set") {
      return { session: session(SESSION_A, {
        profileId: grok.id,
        modelOverride: request.params.model,
        updatedAt: 1234,
      }) };
    }
    if (request.method === "chat.command.list") {
      assert.deepEqual(request.params, { sessionKey: SESSION_A });
      return {
        supported: true, reason: null,
        commands: [{
          name: "memory", description: "Manage memory", args: "[action]",
          category: "tools", aliases: [],
        }],
      };
    }
    if (request.method === "chat.command.exec") {
      assert.deepEqual(request.params, { sessionKey: SESSION_A, text: "/memory list" });
      return { kind: "send", text: "/memory list", warning: null };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await backend.start(), true);
  const catalog = await backend.getModels();
  assert.deepEqual(catalog, [
    { id: "codex-other", name: "Codex Other", provider: "codex", backendId: "shoggoth",
      modelScopes: [codexOther.id], defaultModelScopes: [codexOther.id] },
    { id: "gpt-5.6", name: "GPT-5.6", provider: "codex", backendId: "shoggoth",
      modelScopes: [codex.id], defaultModelScopes: [codex.id] },
    { id: "grok-4.6", name: "Grok 4.6", provider: "grok-build", backendId: "shoggoth",
      modelScopes: [grok.id], defaultModelScopes: [grok.id] },
    { id: "shared", name: "Shared via Codex", provider: "codex", backendId: "shoggoth",
      modelScopes: [codexOther.id, codex.id] },
    { id: "shared", name: "Shared via Grok", provider: "grok-build", backendId: "shoggoth",
      modelScopes: [grok.id] },
  ]);
  assert.deepEqual((await backend.listAgents()).map(({ id, provider }) => ({ id, provider })), [
    { id: "shoggoth-default", provider: "codex" },
    { id: "shoggoth-codex-other", provider: "codex" },
    { id: "shoggoth-grok", provider: "grok-build" },
  ]);
  const codexCaps = backend.getChatCapabilities(codex.agentId);
  assert.deepEqual({ ...codexCaps, permissions: undefined }, {
    attachments: { image: { maxBytes: 10485760 }, pdf: { maxBytes: 52428800 }, file: { maxBytes: 52428800 } },
    maxPromptBytes: 61440, maxAttachmentBytes: 52428800, maxAttachments: 8, slash: true, modelProvider: "codex", modelScope: codex.id, permissions: undefined,
  });
  const codexOtherCaps = backend.getChatCapabilities(codexOther.agentId);
  assert.deepEqual({ ...codexOtherCaps, permissions: undefined }, {
    attachments: { image: { maxBytes: 10485760 }, pdf: { maxBytes: 52428800 }, file: { maxBytes: 52428800 } },
    maxPromptBytes: 61440, maxAttachmentBytes: 52428800, maxAttachments: 8, slash: true, modelProvider: "codex", modelScope: codexOther.id, permissions: undefined,
  });
  const grokCaps = backend.getChatCapabilities(grok.agentId);
  assert.deepEqual({ ...grokCaps, permissions: undefined }, {
    attachments: { image: { maxBytes: 10485760 }, pdf: { maxBytes: 52428800 }, file: { maxBytes: 52428800 } },
    maxPromptBytes: 61440, maxAttachmentBytes: 52428800, maxAttachments: 8, slash: true, modelProvider: "grok-build", modelScope: grok.id, permissions: undefined,
  });
  assert.deepEqual(codexCaps.permissions.options.map((option) => option.id), ["read-only", "ask", "workspace-auto", "full"]);
  assert.deepEqual(grokCaps.permissions.options.map((option) => option.id), ["ask", "auto", "always-approve"]);
  const visibleModels = (agentId) => {
    const scope = backend.getChatCapabilities(agentId).modelScope;
    return catalog.filter((model) => model.modelScopes.includes(scope)).map((model) => model.id);
  };
  assert.deepEqual(visibleModels(codex.agentId), ["gpt-5.6", "shared"]);
  assert.deepEqual(visibleModels(codexOther.agentId), ["codex-other", "shared"]);
  assert.deepEqual(visibleModels(grok.agentId), ["grok-4.6", "shared"]);
  const key = await backend.createSession(grok.agentId);
  assert.deepEqual((await backend.listSlashCommands(grok.agentId, key)).commands.map(
    (command) => command.name,
  ), ["memory"]);
  assert.deepEqual(await backend.execSlash(grok.agentId, key, "/memory list"), {
    kind: "send", text: "/memory list", warning: null,
  });
  assert.deepEqual(await backend.setSessionModel(key, {
    model: "grok-4.6", provider: "grok-build",
  }), { model: "grok-4.6", scope: "session" });
  await assert.rejects(
    backend.setSessionModel(key, { model: "grok-4.6", provider: "codex" }),
    (error) => error?.code === "INVALID_PARAMS",
  );
  assert.equal(calls.filter(({ request }) => request.method === "chat.session.model.set").length, 1);
  assert.deepEqual(calls.filter(({ request }) => request.method.startsWith("chat.command."))
    .map(({ requestOptions }) => requestOptions.timeoutMs), [45_000, 45_000]);
  assert.equal(backend.getSessionRows()[0].provider, "grok-build");
});

test("all native facades and Shoggoth's bound runtimes route scoped command catalogs", async () => {
  for (const runtime of ["codex", "claude-code", "grok-build", "pi", "antigravity", "deepseek-harness"]) {
    for (const backendId of new Set([runtime, "shoggoth"])) {
      const bound = profile({ backendId, runtime, providerRef: null });
      const { backend, calls } = fakeBackend((request) => {
        if (request.method === "profile.list") return page("profiles", [bound]);
        if (request.method === "chat.session.list") return page("sessions", [session()]);
        if (request.method === "chat.command.list") return {
          supported: true, reason: null,
          commands: [{ name: "native-check", description: runtime, args: null, category: "tools", aliases: [], source: runtime, execution: "runtime" }],
        };
        throw new Error(`unexpected ${request.method}`);
      }, { id: backendId });
      assert.equal(await backend.start(), true);
      assert.equal(backend.getChatCapabilities(bound.agentId).slash, true, `${backendId}/${runtime}`);
      const key = backend.getSessionRows()[0].key;
      const catalog = await backend.listSlashCommands(bound.agentId, key);
      assert.equal(catalog.commands[0].source, runtime);
      assert.deepEqual(calls.find(({ request }) => request.method === "chat.command.list").request.params,
        { sessionKey: SESSION_A });
    }
  }
});

test("managed CLI auth catalog binds fixed commands and credential state to each Agent profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-"));
  const codexRoot = path.join(root, "codex");
  const grokRoot = path.join(root, "grok-build");
  fs.mkdirSync(path.join(codexRoot, "runtime-codex"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(grokRoot, "runtime-grok"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexRoot, "runtime-codex", "auth.json"),
    '{"token":"test-only"}\n', { mode: 0o600 });
  const codex = profile({
    id: "profile-codex", agentId: "shoggoth-codex", name: "Codex",
    runtimeProfileId: "runtime-codex", runtimeAccountId: "account-codex",
    providerRef: null, defaultModel: null, isDefault: false,
  });
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", runtimeAccountId: "account-grok",
    providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [codex, grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") {
      assert.equal(request.params.profileId, codex.id);
      return { status: "authenticated" };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    paths: { tokenPath: "/private/client.token" },
    runtimeCliAuth: [
      {
        runtime: "codex", name: "Codex", binaryPath: "/opt/shoggoth/codex",
        runtimeAccountId: "account-codex",
        accountHome: path.join(codexRoot, "runtime-codex"), processHome: root,
        homeEnv: "CODEX_HOME", accountKind: "native-user", credentialFile: "auth.json",
        loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
        docsUrl: "https://example.test/codex",
      },
      {
        runtime: "grok-build", name: "Grok", binaryPath: "/opt/shoggoth/grok",
        runtimeAccountId: "account-grok",
        accountHome: path.join(grokRoot, "runtime-grok"), processHome: root,
        homeEnv: "GROK_HOME", accountKind: "native-user", credentialFile: "auth.json",
        loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
        docsUrl: "https://example.test/grok",
      },
    ],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const snapshot = await value.backend.listOAuthProviders();
    assert.deepEqual(snapshot.providers.map((provider) => ({
      id: provider.id,
      loggedIn: provider.status.loggedIn,
      flow: provider.flow,
      disconnectable: provider.disconnectable,
    })), [
      { id: "account-codex", loggedIn: true, flow: "external", disconnectable: false },
      { id: "account-grok", loggedIn: false, flow: "external", disconnectable: false },
    ]);
    assert.equal(snapshot.providers[0].cliCommand,
      `/usr/bin/env HOME='${root}' CODEX_HOME='${path.join(codexRoot, "runtime-codex")}' '/opt/shoggoth/codex' 'login' '--device-auth'`);
    assert.equal(snapshot.providers[1].disconnectCommand,
      `/usr/bin/env HOME='${root}' GROK_HOME='${path.join(grokRoot, "runtime-grok")}' '/opt/shoggoth/grok' 'logout'`);
    assert.equal(value.calls.filter(({ request }) => request.method === "profile.auth.read").length, 1);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one RuntimeAccount produces one auth entry for every Agent that shares it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-account-auth-catalog-"));
  const accountHome = path.join(root, "native-grok");
  fs.mkdirSync(accountHome, { mode: 0o755 });
  fs.writeFileSync(path.join(accountHome, "auth.json"),
    '{"token":"test-only"}\n', { mode: 0o600 });
  const profiles = [
    profile({
      id: "profile-grok-a", agentId: "grok-a", name: "Grok A", runtime: "grok-build",
      runtimeProfileId: "runtime-grok-a", runtimeAccountId: "shared-grok-account",
      providerRef: null, defaultModel: null, isDefault: false,
    }),
    profile({
      id: "profile-grok-b", agentId: "grok-b", name: "Grok B", runtime: "grok-build",
      runtimeProfileId: "runtime-grok-b", runtimeAccountId: "shared-grok-account",
      providerRef: null, defaultModel: null, isDefault: false,
    }),
  ];
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", profiles);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") {
      assert.equal(request.params.profileId, "profile-grok-a");
      return { status: "authenticated" };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    runtimeCliAuth: [{
      runtime: "grok-build",
      runtimeAccountId: "shared-grok-account",
      name: "Grok",
      binaryPath: "/opt/shoggoth/grok",
      accountHome,
      processHome: root,
      homeEnv: "GROK_HOME",
      accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"],
      logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const snapshot = await value.backend.listOAuthProviders();
    assert.equal(snapshot.providers.length, 1);
    assert.deepEqual(snapshot.providers[0].connectedProfiles, ["Grok A", "Grok B"]);
    assert.equal(snapshot.providers[0].id, "shared-grok-account");
    assert.equal(value.calls.filter(({ request }) => request.method === "profile.auth.read").length, 1);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-probed CLI auth supports isolated HOME without a guessed credential file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-probe-"));
  const accountHome = path.join(root, "antigravity", "account-home");
  const antigravity = profile({
    id: "profile-antigravity",
    agentId: "shoggoth-antigravity",
    name: "Antigravity",
    runtime: "antigravity",
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId: "account-antigravity",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [antigravity]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") {
      assert.equal(request.params.profileId, antigravity.id);
      return { status: "authenticated" };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    paths: { tokenPath: "/private/client.token" },
    runtimeCliAuth: [{
      runtime: "antigravity",
      runtimeAccountId: "account-antigravity",
      name: "Antigravity",
      binaryPath: "/opt/shoggoth/agy",
      accountHome,
      processHome: accountHome,
      homeEnv: null,
      accountKind: "native-user",
      credentialFile: null,
      credentialProbe: "runtime",
      loginArgs: [],
      logoutArgs: [],
      docsUrl: "https://example.test/antigravity",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const snapshot = await value.backend.listOAuthProviders();
    assert.equal(snapshot.providers[0].status.loggedIn, true);
    assert.equal(snapshot.providers[0].cliCommand,
      `/usr/bin/env HOME='${accountHome}' '/opt/shoggoth/agy'`);
    assert.equal(snapshot.providers[0].disconnectCommand, null);
    assert.equal(value.calls.filter(({ request }) => request.method === "profile.auth.read").length, 1);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty managed credential storage remains logged out without a Runtime auth probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-proof-"));
  const homeRoot = path.join(root, "codex");
  const runtimeHome = path.join(homeRoot, "runtime-codex");
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeHome, "auth.json"), "{}\n", { mode: 0o600 });
  const codex = profile({
    id: "profile-codex", agentId: "shoggoth-codex", name: "Codex",
    runtimeProfileId: "runtime-codex", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [codex]);
    if (request.method === "chat.session.list") return page("sessions", []);
    throw new Error(`unexpected ${request.method}`);
  }, {
    paths: { tokenPath: "/private/client.token" },
    runtimeCliAuth: [{
      runtime: "codex", name: "Codex", binaryPath: "/opt/shoggoth/codex",
      runtimeAccountId: "fixture-runtime-account", accountHome: runtimeHome,
      processHome: root, homeEnv: "CODEX_HOME", accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/codex",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const [provider] = (await value.backend.listOAuthProviders()).providers;
    assert.equal(provider.status.loggedIn, false);
    assert.equal(provider.status.error, null);
    assert.equal(Object.hasOwn(provider.status, "verification"), false);
    assert.equal(value.calls.filter(({ request }) => request.method === "profile.auth.read").length, 0);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed credential file alone never claims a successful Runtime login", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-proof-"));
  const homeRoot = path.join(root, "codex");
  const runtimeHome = path.join(homeRoot, "runtime-codex");
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeHome, "auth.json"), '{"token":"test-only"}\n', { mode: 0o600 });
  const codex = profile({
    id: "profile-codex", agentId: "shoggoth-codex", name: "Codex",
    runtimeProfileId: "runtime-codex", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [codex]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") return { status: "unverified" };
    throw new Error(`unexpected ${request.method}`);
  }, {
    paths: { tokenPath: "/private/client.token" },
    runtimeCliAuth: [{
      runtime: "codex", name: "Codex", binaryPath: "/opt/shoggoth/codex",
      runtimeAccountId: "fixture-runtime-account", accountHome: runtimeHome,
      processHome: root, homeEnv: "CODEX_HOME", accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/codex",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const [provider] = (await value.backend.listOAuthProviders()).providers;
    assert.equal(provider.status.loggedIn, false);
    assert.equal(provider.status.error, null);
    assert.equal(provider.status.verification, "unverified");
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed credential stays unverified when Runtime auth proof is temporarily unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-unavailable-"));
  const homeRoot = path.join(root, "grok-build");
  const runtimeHome = path.join(homeRoot, "runtime-grok");
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeHome, "auth.json"),
    '{"token":"test-only"}\n', { mode: 0o600 });
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", providerRef: null, defaultModel: null, isDefault: false,
  });
  const transientCodes = [
    "SERVICE_UNAVAILABLE",
    "REQUEST_TIMEOUT",
    "SERVICE_DISCONNECTED",
    "PROFILE_AUTH_STATUS_UNAVAILABLE",
    "PROFILE_SERVICE_CLOSED",
  ];
  let authErrorCode = transientCodes[0];
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") {
      const error = new Error("temporary Service timeout");
      error.code = authErrorCode;
      throw error;
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    paths: { tokenPath: "/private/client.token" },
    runtimeCliAuth: [{
      runtime: "grok-build", name: "Grok", binaryPath: "/opt/shoggoth/grok",
      runtimeAccountId: "fixture-runtime-account", accountHome: runtimeHome,
      processHome: root, homeEnv: "GROK_HOME", accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    for (const code of transientCodes) {
      authErrorCode = code;
      const [provider] = (await value.backend.listOAuthProviders()).providers;
      assert.deepEqual(provider.status, {
        loggedIn: false,
        source: null,
        sourceLabel: null,
        tokenPreview: null,
        expiresAt: null,
        hasRefreshToken: false,
        error: null,
        verification: "unverified",
      });
    }
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed auth integrity failures remain a fixed visible error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-integrity-"));
  const homeRoot = path.join(root, "grok-build");
  const runtimeHome = path.join(homeRoot, "runtime-grok");
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeHome, "auth.json"),
    '{"token":"test-only"}\n', { mode: 0o600 });
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "profile.auth.read") {
      const error = new Error("sensitive symlink path");
      error.code = "UNSAFE_SYMLINK";
      throw error;
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    runtimeCliAuth: [{
      runtime: "grok-build", name: "Grok", binaryPath: "/opt/shoggoth/grok",
      runtimeAccountId: "fixture-runtime-account", accountHome: runtimeHome,
      processHome: root, homeEnv: "GROK_HOME", accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const [provider] = (await value.backend.listOAuthProviders()).providers;
    assert.equal(provider.status.loggedIn, false);
    assert.equal(provider.status.error, "Unable to verify managed CLI authentication");
    assert.equal(Object.hasOwn(provider.status, "verification"), false);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe managed credential permissions remain a visible local error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-unsafe-"));
  const homeRoot = path.join(root, "grok-build");
  const runtimeHome = path.join(homeRoot, "runtime-grok");
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const credentialPath = path.join(runtimeHome, "auth.json");
  fs.writeFileSync(credentialPath, "{}\n", { mode: 0o600 });
  fs.chmodSync(credentialPath, 0o644);
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    throw new Error(`unexpected ${request.method}`);
  }, {
    runtimeCliAuth: [{
      runtime: "grok-build", name: "Grok", binaryPath: "/opt/shoggoth/grok",
      runtimeAccountId: "fixture-runtime-account", accountHome: runtimeHome,
      processHome: root, homeEnv: "GROK_HOME", accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const [provider] = (await value.backend.listOAuthProviders()).providers;
    assert.equal(provider.status.loggedIn, false);
    assert.equal(provider.status.error, "Managed CLI credential permissions are unsafe");
    assert.equal(Object.hasOwn(provider.status, "verification"), false);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid managed credential path remains a visible local error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-auth-path-"));
  const homeRoot = path.join(root, "grok-build");
  fs.mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(homeRoot, "runtime-grok"), "not a directory\n", { mode: 0o600 });
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    throw new Error(`unexpected ${request.method}`);
  }, {
    runtimeCliAuth: [{
      runtime: "grok-build", name: "Grok", binaryPath: "/opt/shoggoth/grok",
      runtimeAccountId: "fixture-runtime-account",
      accountHome: path.join(homeRoot, "runtime-grok"), processHome: root,
      homeEnv: "GROK_HOME", accountKind: "native-user", credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"], logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok",
    }],
  });
  try {
    assert.equal(await value.backend.start(), true);
    const [provider] = (await value.backend.listOAuthProviders()).providers;
    assert.equal(provider.status.loggedIn, false);
    assert.equal(provider.status.error, "Managed CLI credential path cannot be inspected");
    assert.equal(Object.hasOwn(provider.status, "verification"), false);
  } finally {
    await value.backend.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing managed CLI remains discoverable with docs and no runnable command", async () => {
  const grok = profile({
    id: "profile-grok", agentId: "shoggoth-grok", name: "Grok", runtime: "grok-build",
    runtimeProfileId: "runtime-grok", providerRef: null, defaultModel: null, isDefault: false,
  });
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [grok]);
    if (request.method === "chat.session.list") return page("sessions", []);
    throw new Error(`unexpected ${request.method}`);
  }, {
    runtimeCliAuth: [{
      runtime: "grok-build",
      runtimeAccountId: "fixture-runtime-account",
      name: "Grok",
      binaryPath: null,
      unavailableReason: "Grok CLI is not installed",
      accountHome: "/private/shoggoth/grok-build",
      processHome: "/private/shoggoth",
      homeEnv: "GROK_HOME",
      accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: ["login", "--device-auth"],
      logoutArgs: ["logout"],
      docsUrl: "https://example.test/grok-install",
    }],
  });
  assert.equal(await value.backend.start(), true);
  const [provider] = (await value.backend.listOAuthProviders()).providers;
  assert.deepEqual({
    id: provider.id,
    cliCommand: provider.cliCommand,
    cliRunnable: provider.cliRunnable,
    disconnectCommand: provider.disconnectCommand,
    error: provider.status.error,
    docsUrl: provider.docsUrl,
  }, {
    id: "fixture-runtime-account",
    cliCommand: "",
    cliRunnable: false,
    disconnectCommand: null,
    error: "Grok CLI is not installed",
    docsUrl: "https://example.test/grok-install",
  });
  await value.backend.stop();
});

test("management agent list and detail expose enabled Shoggoth profiles", async () => {
  const { backend } = await readyBackend((request) => {
    assert.equal(request.method, "harness.definition.meta");
    return {
      current: {
        revision: 3, actor: "user", reason: "unit", updatedAt: 100,
        documents: {
          IDENTITY: { kind: "IDENTITY", contentHash: "a".repeat(64), byteLength: 10, revision: 3 },
          SOUL: { kind: "SOUL", contentHash: "b".repeat(64), byteLength: 20, revision: 3 },
          USER: { kind: "USER", contentHash: "c".repeat(64), byteLength: 30, revision: 3 },
          AGENTS: { kind: "AGENTS", contentHash: "d".repeat(64), byteLength: 40, revision: 3 },
        },
      },
      history: [],
      historyHasMore: false,
      files: [
        { kind: "IDENTITY", name: "IDENTITY.md", readOnly: false },
        { kind: "USER", name: "USER.md", readOnly: true },
      ],
    };
  });
  assert.deepEqual(await backend.listAgents(), [{
    id: "shoggoth-default",
    name: "Shoggoth",
    model: "openai/gpt-5",
    provider: "openrouter",
    runtime: "codex",
    runtimeAccountId: "fixture-runtime-account",
    environmentKind: "shoggoth-managed",
    sharedAgentCount: 1,
    isDefault: true,
    backendId: "shoggoth",
  }]);
  assert.deepEqual(await backend.getAgent("shoggoth-default"), {
    id: "shoggoth-default",
    name: "Shoggoth",
    model: "openai/gpt-5",
    provider: "openrouter",
    runtime: "codex",
    runtimeAccountId: "fixture-runtime-account",
    environmentKind: "shoggoth-managed",
    sharedAgentCount: 1,
    profile: "profile-default",
    isDefault: true,
    protected: true,
    archived: false,
    lifecycleState: "active",
    updatedAt: 100,
    files: [
      { name: "IDENTITY.md", size: 10, readOnly: false },
      { name: "USER.md", size: 30, readOnly: true },
    ],
    definitionRevision: 3,
    backendId: "shoggoth",
  });
  await assert.rejects(
    () => backend.getAgent("shoggoth-missing"),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
});

test("native facade creates, updates, archives and restores a long-lived Agent", async () => {
  const profiles = [profile({
    id: "profile-codex",
    backendId: "codex",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtimeProfileId: "shoggoth-codex-cli-v1",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  })];
  const created = profile({
    id: "33333333-3333-8333-8333-333333333333",
    backendId: "codex",
    agentId: "codex-33333333-3333-8333-8333-333333333333",
    name: "Reviewer",
    runtimeProfileId: "codex-33333333-3333-8333-8333-333333333333-runtime-v1",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
    createdAt: 1234,
    updatedAt: 1234,
  });
  let pendingRestoreOperationId = null;
  let restoreAttempts = 0;
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") {
      return page("profiles", profiles.filter((item) => item.enabled));
    }
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "agent.lifecycle.list") {
      return {
        agents: profiles.map((item) => ({
          profile: item,
          state: item.id === created.id && pendingRestoreOperationId
            ? "restoring" : item.enabled ? "active" : "archived",
          pendingOperationId: item.id === created.id ? pendingRestoreOperationId : null,
        })),
      };
    }
    if (request.method === "agent.create") {
      profiles.push(created);
      return { profile: created };
    }
    const index = profiles.findIndex((item) => item.id === request.params.profileId);
    assert.notEqual(index, -1);
    if (request.method === "agent.update") {
      profiles[index] = {
        ...profiles[index],
        name: request.params.name,
        defaultCwd: request.params.defaultCwd,
        updatedAt: profiles[index].updatedAt + 1,
      };
    } else if (request.method === "agent.archive") {
      profiles[index] = { ...profiles[index], enabled: false, updatedAt: profiles[index].updatedAt + 1 };
    } else if (request.method === "agent.restore") {
      restoreAttempts += 1;
      if (restoreAttempts === 1) {
        profiles[index] = { ...profiles[index], enabled: true, updatedAt: profiles[index].updatedAt + 1 };
        pendingRestoreOperationId = request.params.operationId;
        const error = new Error("injected post-publish interruption");
        error.code = "AGENT_INITIALIZATION_FAILED";
        throw error;
      }
      assert.equal(request.params.operationId, pendingRestoreOperationId);
      pendingRestoreOperationId = null;
    } else {
      throw new Error(`unexpected ${request.method}`);
    }
    return { profile: profiles[index] };
  }, {
    id: "codex",
    name: "Codex",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex" || agentId.startsWith("codex-"),
  });
  assert.equal(await value.backend.start(), true);
  assert.equal(value.backend.getBackendDescriptor().agentLifecycle.restore, true);
  const added = await value.backend.createAgent({ name: "Reviewer" });
  assert.equal(added.id, created.agentId);
  assert.equal(value.backend.ownsAgentId(created.agentId), true);
  await value.backend.updateAgent(created.agentId, { name: "Reviewer 2" });
  assert.equal((await value.backend.listAgents()).find((item) => item.id === created.agentId).name, "Reviewer 2");
  await value.backend.deleteAgent(created.agentId);
  assert.equal(value.backend.ownsAgentId(created.agentId), false);
  const archived = (await value.backend.listAgents({ lifecycle: "archived" }))[0];
  assert.equal(archived.archived, true);
  const restoreOptions = {
    operationId: "restore-retry-fixed",
    expectedUpdatedAt: archived.updatedAt,
    createdAt: 1234,
  };
  await assert.rejects(
    () => value.backend.restoreAgent(created.agentId, restoreOptions),
    (error) => error.code === "AGENT_INITIALIZATION_FAILED",
  );
  await value.backend.restoreAgent(created.agentId, restoreOptions);
  assert.equal(value.backend.ownsAgentId(created.agentId), true);
});

test("native Skills stay profile-scoped and preserve optimistic revisions through the backend", async () => {
  let profileRevision = 4;
  let registryVersion = 7;
  const skill = (patch = {}) => ({
    id: "careful-review",
    name: "careful-review",
    version: "1.0.0",
    description: "Review a change carefully",
    source: "user",
    contentHash: "a".repeat(64),
    requiredTools: [],
    requiredRuntimeCapabilities: ["filesystem"],
    sourceCompatibility: ["shoggoth", "codex"],
    enabled: true,
    eligible: true,
    ineligibleReason: null,
    ...patch,
  });
  const { backend, calls } = await readyBackend((request) => {
    if (request.method === "harness.skills.list") {
      return {
        registryRevision: "b".repeat(64),
        registryVersion,
        profileRevision,
        items: [skill()],
        nextCursor: 1,
        hasMore: false,
      };
    }
    if (request.method === "harness.skills.enable") {
      profileRevision += 1;
      return { profileRevision, skill: skill({ enabled: request.params.enabled }) };
    }
    if (request.method === "harness.skills.install") {
      registryVersion += 1;
      return { registryRevision: registryVersion, skill: skill() };
    }
    if (request.method === "harness.skills.preview") {
      return { skill: skill(), content: "# Careful review\n", nextCursor: 17, hasMore: false };
    }
    if (request.method === "harness.skills.uninstall") {
      registryVersion += 1;
      return { registryRevision: registryVersion, skill: skill() };
    }
    if (request.method === "harness.skills.usage") {
      return { supported: true, skills: { "careful-review": { "profile-default": 3 } } };
    }
    throw new Error(`unexpected ${request.method}`);
  });

  assert.deepEqual(await backend.getSkills({ agentId: "shoggoth-default" }), [{
    name: "careful-review",
    description: "Review a change carefully",
    enabled: true,
    backendId: "shoggoth",
    category: "Shoggoth native",
    emoji: "🧩",
    id: "careful-review",
    version: "1.0.0",
    source: "user",
    contentHash: "a".repeat(64),
    requiredTools: [],
    requiredRuntimeCapabilities: ["filesystem"],
    sourceCompatibility: ["shoggoth", "codex"],
    eligible: true,
    ineligibleReason: null,
    profileId: "profile-default",
    agentId: "shoggoth-default",
    registryRevision: "b".repeat(64),
    registryVersion: 7,
    profileRevision: 4,
  }]);
  const disabled = await backend.updateSkill("careful-review", { enabled: false }, {
    agentId: "shoggoth-default",
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.profileRevision, 5);
  await backend.installSkill("/trusted/package", { agentId: "shoggoth-default" });
  assert.match((await backend.previewSkill("careful-review", {
    agentId: "shoggoth-default",
  })).content, /Careful review/u);
  await backend.uninstallSkill("careful-review", { agentId: "shoggoth-default" });
  assert.deepEqual(await backend.getSkillUsage(), {
    supported: true,
    skills: { "careful-review": { "shoggoth-default": 3 } },
  });

  const enableCall = calls.find(({ request }) => request.method === "harness.skills.enable").request;
  assert.deepEqual(enableCall.params, {
    profileId: "profile-default",
    skillId: "careful-review",
    source: "user",
    version: "1.0.0",
    enabled: false,
    expectedRevision: 4,
  });
  const installCall = calls.find(({ request }) => request.method === "harness.skills.install").request;
  assert.equal(installCall.params.sourcePath, "/trusted/package");
  assert.equal(installCall.params.expectedRevision, 7);
});

test("native Skill operations resolve exact package identity and reject ambiguous names", async () => {
  const packages = [
    { id: "review", version: "1.0.0" },
    { id: "review", version: "1.0.1" },
    { id: "other-review", version: "1.0.1" },
  ].map((identity) => ({
    ...identity, name: "review", description: "Review", source: "user",
    contentHash: "a".repeat(64), requiredTools: [], requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth"], enabled: false, eligible: true, ineligibleReason: null,
  }));
  const { backend, calls } = await readyBackend((request) => {
    if (request.method === "harness.skills.list") return {
      registryRevision: "b".repeat(64), registryVersion: 3, profileRevision: 4,
      items: packages, nextCursor: 3, hasMore: false,
    };
    const selected = packages.find((item) => item.id === request.params.skillId
      && item.version === request.params.version);
    assert.ok(selected, "IPC must carry an exact package identity");
    if (request.method === "harness.skills.enable") return {
      profileRevision: 5, skill: { ...selected, enabled: request.params.enabled },
    };
    if (request.method === "harness.skills.preview") return {
      skill: selected, content: selected.version, nextCursor: 5, hasMore: false,
    };
    if (request.method === "harness.skills.uninstall") return { registryRevision: 4, skill: selected };
    throw new Error(`unexpected ${request.method}`);
  });
  const options = { agentId: "shoggoth-default", id: "review", source: "user", version: "1.0.1" };
  assert.equal((await backend.previewSkill("review", options)).content, "1.0.1");
  await backend.updateSkill("review", { ...options, enabled: true }, options);
  await backend.uninstallSkill("review", options);
  const targeted = calls.filter(({ request }) => /^harness.skills.(enable|preview|uninstall)$/u.test(request.method));
  assert.equal(targeted.length, 3);
  for (const { request } of targeted) {
    assert.equal(request.params.skillId, "review");
    assert.equal(request.params.version, "1.0.1");
  }
  for (const invoke of [
    () => backend.previewSkill("review", { agentId: options.agentId }),
    () => backend.uninstallSkill("review", { agentId: options.agentId, version: "1.0.1" }),
    () => backend.updateSkill("review", { enabled: true }, { agentId: options.agentId }),
  ]) await assert.rejects(invoke, { code: "SKILL_IDENTITY_AMBIGUOUS" });
  assert.equal(calls.filter(({ request }) => /^harness.skills.(enable|preview|uninstall)$/u.test(request.method)).length, 3);
});

test("native Skills reject profile-less access and never fall back across shared agents", async () => {
  const secondary = profile({
    id: "profile-reviewer",
    agentId: "shoggoth-reviewer",
    name: "Reviewer",
    runtimeProfileId: "runtime-reviewer",
    isDefault: false,
  });
  const skill = {
    id: "careful-review",
    name: "careful-review",
    version: "1.0.0",
    description: "Review carefully",
    source: "user",
    contentHash: "a".repeat(64),
    requiredTools: [],
    requiredRuntimeCapabilities: [],
    sourceCompatibility: ["shoggoth", "codex"],
    enabled: true,
    eligible: true,
    ineligibleReason: null,
  };
  const { backend, calls } = await readyBackend((request) => {
    if (request.method === "harness.skills.list") {
      return {
        registryRevision: "b".repeat(64),
        registryVersion: 7,
        profileRevision: 4,
        items: [skill],
        nextCursor: 1,
        hasMore: false,
      };
    }
    if (request.method === "harness.skills.enable") {
      return { profileRevision: 5, skill: { ...skill, enabled: request.params.enabled } };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { profiles: [profile(), secondary] });

  const profileLessOperations = [
    () => backend.getSkills(),
    () => backend.updateSkill("careful-review", { enabled: false }),
    () => backend.installSkill("/trusted/package"),
    () => backend.uninstallSkill("careful-review"),
    () => backend.previewSkill("careful-review"),
  ];
  for (const operation of profileLessOperations) {
    await assert.rejects(operation, (error) => error.code === "INVALID_PARAMS");
  }
  assert.equal(calls.length, 0);

  await backend.updateSkill("careful-review", { enabled: false }, {
    agentId: secondary.agentId,
  });
  assert.deepEqual(calls.map(({ request }) => [request.method, request.params.profileId]), [
    ["harness.skills.list", secondary.id],
    ["harness.skills.enable", secondary.id],
  ]);
});

test("Computer Use status remains profile-scoped through backend contract", async () => {
  const state = {
    available: true,
    driverVersion: "0.22.0",
    contractVersion: "0.7.0",
    permissions: { accessibility: true, screenRecording: false },
    sessions: [{
      id: "computer-session-1", profileId: "profile-default", workRunId: "run-1",
      allowedApplications: ["com.apple.TextEdit"], status: "paused", createdAt: 100,
      updatedAt: 101, expiresAt: 700, pauseReason: "user_takeover",
    }],
  };
  const { backend, calls } = await readyBackend((request) => {
    if (request.method === "harness.computer.status") return state;
    throw new Error(`unexpected ${request.method}`);
  });
  assert.deepEqual(await backend.getAgentComputerState("shoggoth-default"), {
    supported: true, ...state,
  });
  assert.deepEqual(calls.find(({ request }) => request.method === "harness.computer.status")
    .request.params, { profileId: "profile-default" });
});

test("management usage exposes Shoggoth Agent/model/date/session aggregates", async () => {
  const parts = {
    totalTokens: 90,
    totalCost: 0,
    inputTokens: 40,
    outputTokens: 20,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
  };
  const series = {
    daily: [{ date: "2026-08-25", ...parts }],
    totals: { ...parts, missingCostEntries: 1 },
  };
  const breakdown = {
    byModel: [{ model: "openai/gpt-5", provider: "openrouter", count: 1, ...parts }],
    byAgent: [{ agentId: "shoggoth-default", ...parts }],
    bySource: [{
      id: "shoggoth-default",
      label: "Shoggoth",
      kind: "agent",
      backendId: "shoggoth",
      profile: "profile-default",
      model: "openai/gpt-5",
      provider: "openrouter",
      ...parts,
    }],
    totals: { ...parts, missingCostEntries: 1 },
    modelDaily: [{
      date: "2026-08-25", model: "openai/gpt-5", provider: "openrouter", tokens: 90, cost: 0,
    }],
    topSessions: [{
      key: `shoggoth:chat:${SESSION_A}`,
      label: "Shoggoth · Chat",
      sessionId: SESSION_A,
      agentId: "shoggoth-default",
      model: "openai/gpt-5",
      models: [{ model: "openai/gpt-5", tokens: 90 }],
      totalTokens: 90,
      totalCost: 0,
      updatedAt: 1234,
    }],
    sourceKind: "agent",
  };
  const value = await readyBackend((request) => {
    if (request.method === "usage.series") return series;
    if (request.method === "usage.breakdown") return breakdown;
    throw new Error(`unexpected ${request.method}`);
  });
  assert.deepEqual(await value.backend.getUsageSeries("30d"), series);
  assert.deepEqual(await value.backend.getUsageBreakdown("30d"), breakdown);
  assert.deepEqual(value.calls.map(({ request }) => [request.method, request.params]), [
    ["usage.series", { range: "30d", backendId: "shoggoth" }],
    ["usage.breakdown", { range: "30d", backendId: "shoggoth" }],
  ]);

  const invalid = await readyBackend((request) => {
    if (request.method === "usage.series") return { daily: [], totals: { totalTokens: -1 } };
    throw new Error(`unexpected ${request.method}`);
  });
  await assert.rejects(
    () => invalid.backend.getUsageSeries("today"),
    (error) => error.code === "USAGE_RESPONSE_INVALID",
  );
});

test("status retries a failed startup after the background Service becomes available", async () => {
  let available = false;
  const { backend, calls } = fakeBackend((request) => {
    if (!available) throw new Error("service unavailable");
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await backend.start(), false);
  available = true;
  assert.deepEqual(await backend.getStatus(), {
    id: "shoggoth", name: "Shoggoth", connected: false,
    info: {
      connectionMode: "builtin-service", state: "starting", starting: true, readyAgentIds: [],
    },
  });
  await waitForCondition(() => backend.getAgents().length === 1);
  assert.deepEqual(await backend.getStatus(), {
    id: "shoggoth", name: "Shoggoth", connected: true,
    info: {
      connectionMode: "builtin-service", state: "started", agents: 1, sessions: 1,
      readyAgentIds: ["shoggoth-default"],
    },
  });
  assert.equal(calls.filter(({ request }) => request.method === "profile.list").length, 2);
});

test("任一持久 lock 都阻止 profiles、connected 与 readyAgentIds", async () => {
  for (const lockedField of ["pendingCommandsLocked", "mcpCredentialsLocked"]) {
    const { backend, calls } = fakeBackend(() => {
      throw new Error("unexpected profile read");
    }, {
      readinessTimeoutMs: 20,
      serviceStatusTimeoutMs: 5,
      readinessIntervalMs: 1,
      serviceStatus: () => ({
        healthy: true,
        pendingCommandsLocked: lockedField === "pendingCommandsLocked",
        mcpCredentialsLocked: lockedField === "mcpCredentialsLocked",
      }),
    });
    assert.equal(await backend.start(), false);
    assert.equal(calls.some(({ request }) => request.method === "profile.list"), false);
    assert.deepEqual(backend.getAgents(), []);
    const recovering = await backend.getStatus();
    assert.equal(recovering.connected, false);
    assert.deepEqual(recovering.info.readyAgentIds, []);
    await backend.stop();
  }
});

test("同一 single-flight 在解锁后发布快照并通知 registry 一次", async () => {
  let statusCalls = 0;
  const readyEvents = [];
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  }, {
    readinessIntervalMs: 1,
    serviceStatus: () => readyStatus(++statusCalls >= 3),
  });
  const notify = (event) => {
    readyEvents.push(event);
    throw new Error("registry listener failure must be isolated");
  };
  const first = backend.start({ onPartialReady: notify });
  const second = backend.start({ onPartialReady: notify });
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(statusCalls, 3);
  assert.equal(readyEvents.length, 1);
  const status = await backend.getStatus();
  assert.equal(status.connected, true);
  assert.deepEqual(status.info.readyAgentIds, ["shoggoth-default"]);
});

test("ready notifier 重入 start 仍返回同一个 single-flight Promise", async () => {
  let statusCalls = 0;
  let profileCalls = 0;
  let sessionCalls = 0;
  let notifierCalls = 0;
  let reentrantStart = null;
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") {
      profileCalls += 1;
      return page("profiles", [profile()]);
    }
    if (request.method === "chat.session.list") {
      sessionCalls += 1;
      return page("sessions", [session()]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(true);
    },
  });
  const first = backend.start({
    onPartialReady: () => {
      notifierCalls += 1;
      reentrantStart = backend.start();
    },
  });
  assert.equal(await first, true);
  assert.equal(reentrantStart, first);
  assert.equal(statusCalls, 1);
  assert.equal(profileCalls, 1);
  assert.equal(sessionCalls, 1);
  assert.equal(notifierCalls, 1);
});

test("达到预算后下一次权威状态采样可以恢复且不叠加轮询", async () => {
  let ready = false;
  let activeStatusCalls = 0;
  let maxActiveStatusCalls = 0;
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  }, {
    readinessTimeoutMs: 20,
    readinessIntervalMs: 1,
    serviceStatus: async () => {
      activeStatusCalls += 1;
      maxActiveStatusCalls = Math.max(maxActiveStatusCalls, activeStatusCalls);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeStatusCalls -= 1;
      return readyStatus(ready);
    },
  });
  assert.equal(await backend.start(), false);
  ready = true;
  const statuses = await Promise.all([backend.getStatus(), backend.getStatus(), backend.getStatus()]);
  assert.ok(statuses.every((value) => value.connected === false));
  await waitForCondition(() => backend.getAgents().length === 1);
  assert.equal(maxActiveStatusCalls, 1);
});

test("started backend 发现 Service 重启上锁后立即撤销 ready 并自动恢复", async () => {
  const statuses = [readyStatus(true), readyStatus(false), readyStatus(false), readyStatus(true)];
  const readyEvents = [];
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  }, {
    readinessIntervalMs: 1,
    serviceStatus: () => statuses.shift() || readyStatus(true),
  });
  assert.equal(await backend.start({ onPartialReady: (event) => readyEvents.push(event) }), true);
  const recovering = await backend.getStatus();
  assert.equal(recovering.connected, false);
  assert.deepEqual(recovering.info.readyAgentIds, []);
  assert.deepEqual(backend.getAgents(), []);
  await waitForCondition(async () => (await backend.getStatus()).connected === true);
  assert.equal(readyEvents.length, 2, "initial ready + recovered ready exactly once each");
});

test("挂起的 service.status 也受 wall-clock 总预算约束", async () => {
  const seenTimeouts = [];
  const { backend } = fakeBackend(() => {
    throw new Error("profile read forbidden");
  }, {
    readinessTimeoutMs: 40,
    serviceStatusTimeoutMs: 10,
    readinessIntervalMs: 1,
    serviceStatus: (_callNumber, requestOptions) => {
      seenTimeouts.push(requestOptions.timeoutMs);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), requestOptions.timeoutMs);
      });
    },
  });
  const startedAt = Date.now();
  assert.equal(await backend.start(), false);
  assert.ok(Date.now() - startedAt < 200);
  assert.ok(seenTimeouts.length > 0 && seenTimeouts.every((value) => value <= 10));
});

test("readiness 采样次数独立受 max-attempts 硬上限约束", async () => {
  let statusCalls = 0;
  const { backend } = fakeBackend(() => {
    throw new Error("profile read forbidden");
  }, {
    readinessTimeoutMs: 1_000,
    readinessMaxAttempts: 3,
    readinessIntervalMs: 0,
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(false);
    },
  });
  assert.equal(await backend.start(), false);
  assert.equal(statusCalls, 3);
});

test("stopped retryOnStatus 的 getStatus 只触发恢复且不等待完整 readiness 周期", async () => {
  let statusCalls = 0;
  let releaseRecovery;
  let recoveryEntered;
  const entered = new Promise((resolve) => { recoveryEntered = resolve; });
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  }, {
    readinessMaxAttempts: 1,
    readinessTimeoutMs: 100,
    serviceStatusTimeoutMs: 50,
    readinessIntervalMs: 0,
    serviceStatus: () => {
      statusCalls += 1;
      if (statusCalls === 1) return readyStatus(false);
      recoveryEntered();
      return new Promise((resolve) => { releaseRecovery = resolve; });
    },
  });
  assert.equal(await backend.start(), false);
  const startedAt = Date.now();
  const status = await backend.getStatus();
  assert.ok(Date.now() - startedAt < 30, "status refresh must not inherit the recovery budget");
  assert.equal(status.connected, false);
  assert.deepEqual(status.info.readyAgentIds, []);
  await entered;
  releaseRecovery(readyStatus(true));
  await waitForCondition(() => backend.getAgents().length === 1);
});

test("stop fences a late authoritative status sample and never revives recovery", async () => {
  let statusCalls = 0;
  let profileCalls = 0;
  let releaseStatus;
  let statusEntered;
  const entered = new Promise((resolve) => { statusEntered = resolve; });
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") {
      profileCalls += 1;
      return page("profiles", [profile()]);
    }
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  }, {
    readinessIntervalMs: 0,
    serviceStatus: () => {
      statusCalls += 1;
      if (statusCalls === 1) return readyStatus(true);
      statusEntered();
      return new Promise((resolve) => { releaseStatus = resolve; });
    },
  });
  assert.equal(await backend.start(), true);
  const pendingStatus = backend.getStatus();
  const didEnter = await Promise.race([
    entered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(didEnter, true, "started status must sample service.status authoritatively");
  const stopping = backend.stop();
  releaseStatus(readyStatus(false));
  await stopping;
  const lateStatus = await pendingStatus;
  assert.equal(lateStatus.connected, false);
  assert.deepEqual(lateStatus.info.readyAgentIds, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend._state, "stopped");
  assert.equal(backend._retryOnStatus, false);
  assert.equal(statusCalls, 2);
  assert.equal(profileCalls, 1);
});

test("service.status schema and readiness constructor injections fail closed", async () => {
  const inherited = Object.assign(Object.create({}), readyStatus(true));
  const getterStatus = { ...readyStatus(true) };
  Object.defineProperty(getterStatus, "healthy", { enumerable: true, get: () => true });
  const invalidStatuses = [
    inherited,
    getterStatus,
    { ...readyStatus(true), healthy: false },
    { ...readyStatus(true), healthy: 1 },
    { ...readyStatus(true), pendingCommandsLocked: 0 },
    { ...readyStatus(true), mcpCredentialsLocked: null },
  ];
  for (const value of invalidStatuses) {
    const { backend, calls } = fakeBackend(() => {
      throw new Error("profile read forbidden");
    }, {
      readinessMaxAttempts: 1,
      readinessIntervalMs: 0,
      serviceStatus: () => value,
    });
    assert.equal(await backend.start(), false);
    assert.equal(calls.some(({ request }) => request.method === "profile.list"), false);
  }

  const invalidOptions = [
    { readinessNow: 1 },
    { readinessTimeoutMs: 70_001 },
    { readinessTimeoutMs: 0 },
    { readinessIntervalMs: 501 },
    { readinessIntervalMs: -1 },
    { serviceStatusTimeoutMs: 1_001 },
    { serviceStatusTimeoutMs: 0 },
    { readinessMaxAttempts: 141 },
    { readinessMaxAttempts: 0 },
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => fakeBackend(() => {}, options),
      /readiness|serviceStatus/u,
    );
  }
  assert.doesNotThrow(() => fakeBackend(() => {}, { readinessIntervalMs: 0 }));
});

test("version info reports the packaged desktop version without claiming an official comparison", async () => {
  const { backend } = fakeBackend(() => { throw new Error("unused"); }, { version: "0.8.41" });
  assert.deepEqual(await backend.getVersionInfo(), {
    id: "shoggoth",
    name: "Shoggoth",
    current: "0.8.41",
    currentSource: "desktop",
    comparisonSupported: false,
  });
});

test("start paginates profiles and sessions, uses a fresh token per request, then atomically publishes", async () => {
  const p1 = profile();
  const p2 = profile({
    id: "profile-disabled", agentId: "shoggoth-disabled", name: "Disabled", enabled: false,
  });
  const { backend, calls, tokenReads } = fakeBackend((request) => {
    assert.equal(request.version, SERVICE_PROTOCOL_VERSION);
    if (request.method === "profile.list" && request.params.cursor === null) {
      return page("profiles", [p1], "profiles-next");
    }
    if (request.method === "profile.list") return page("profiles", [p2]);
    if (request.method === "chat.session.list") return page("sessions", [session()]);
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await backend.start(), true);
  assert.equal(tokenReads(), 4);
  assert.deepEqual(calls.map((entry) => entry.request.method), [
    "service.status", "profile.list", "profile.list", "chat.session.list",
  ]);
  assert.deepEqual(calls.map((entry) => entry.request.token), [
    "fresh-token-1", "fresh-token-2", "fresh-token-3", "fresh-token-4",
  ]);
  assert.equal(calls[0].requestOptions.timeoutMs, 1_000);
  assert.ok(calls.slice(1).every((entry) => entry.requestOptions.timeoutMs === 5_000));
  assert.deepEqual(backend.getAgents(), [{
    id: "shoggoth-default", name: "Shoggoth", model: "openai/gpt-5", provider: "openrouter",
    runtime: "codex", runtimeAccountId: "fixture-runtime-account",
    environmentKind: "shoggoth-managed", sharedAgentCount: 1,
    backendId: "shoggoth",
  }]);
  assert.equal(backend.ownsAgentId("shoggoth-default"), true);
  assert.equal(backend.ownsAgentId("shoggoth-disabled"), false);
  assert.deepEqual(backend.getSessionRowsSnapshot(), {
    complete: true,
    rows: [{
      key: `agent:shoggoth-default:${SESSION_A}`,
      kind: "direct",
      label: "A real chat",
      displayName: "A real chat",
      subject: undefined,
      updatedAt: 100,
      sessionId: SESSION_A,
      agentId: "shoggoth-default",
      agentName: "Shoggoth",
      model: "openai/gpt-5",
      permissionMode: "ask",
      provider: "openrouter",
      backendId: "shoggoth",
    }],
  });
});

test("native federation terminal becomes a target-session activity in the live registry snapshot", async () => {
  let sessionsVisible = false;
  let eventPages = 0;
  const completedAt = Date.now();
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", sessionsVisible ? [session(SESSION_B, {
        title: null,
        derivedTitle: "来自 Maya 的联邦消息",
        updatedAt: completedAt,
      })] : []);
    }
    if (request.method === "events.subscribe") {
      eventPages += 1;
      if (eventPages === 1) {
        sessionsVisible = true;
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.terminal",
          payload: {
            runId: "run-federation-1",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            status: "completed",
            result: "你 111好啊 你再干嘛",
            errorCode: null,
            finishedAt: completedAt,
          },
        }]);
      }
      return serviceEventPage([], { afterSeq: request.params.afterSeq, latestSeq: 1 });
    }
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.length > 0, 1_000);
    const activity = activityEvents[0].activity;
    assert.deepEqual(activity, {
      kind: "federation.chat.terminal",
      runId: "run-federation-1",
      sessionKey: `agent:shoggoth-default:${SESSION_B}`,
      status: "completed",
      result: "你 111好啊 你再干嘛",
      errorCode: null,
      finishedAt: completedAt,
    });
    assert.deepEqual(backend.getSessionRows().map((row) => row.key), [
      `agent:shoggoth-default:${SESSION_B}`,
    ]);
  } finally {
    await registry.stop();
  }
});

test("native federation interaction becomes an actionable prompt on the target session", async () => {
  let sessionsVisible = false;
  let requestedPublished = false;
  let releaseResolved = false;
  const requestId = "request-federation-approval";
  const requestPayload = {
    requestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "shoggoth__notification_send",
    reason: "发送测试通知",
    sessionApprovalAvailable: true,
    expiresAt: null,
  };
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", sessionsVisible ? [session(SESSION_B, {
        title: null,
        derivedTitle: "来自 Antigravity 的联邦任务",
        updatedAt: 2345,
      })] : []);
    }
    if (request.method === "events.subscribe") {
      if (!requestedPublished) {
        requestedPublished = true;
        sessionsVisible = true;
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-federation-approval",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId,
              payload: requestPayload,
            },
          },
        }]);
      }
      if (releaseResolved && request.params.afterSeq === 1) {
        return serviceEventPage([{
          seq: 2,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-federation-approval",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "resolved",
              eventType: "approval",
              requestId,
              payload: null,
            },
          },
        }], { afterSeq: 1 });
      }
      return serviceEventPage([], {
        afterSeq: request.params.afterSeq,
        latestSeq: releaseResolved ? 2 : 1,
      });
    }
    if (request.method === "run.approval.respond") {
      const { operationId, ...params } = request.params;
      assert.match(operationId, /^approval-00000000-0000-4000-8000-\d{12}$/u);
      assert.deepEqual(params, {
        createdAt: 1234,
        runId: "run-federation-approval",
        requestId,
        choice: "once",
      });
      return {
        requestId,
        state: "responded",
        run: run("running", {
          id: "run-federation-approval",
          sourceId: SESSION_B,
          waitingRequestId: null,
        }),
      };
    }
    if (request.method === "run.get") {
      return {
        run: run("waiting_approval", {
          id: "run-federation-approval",
          sourceId: SESSION_B,
          waitingRequestId: requestId,
        }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.length === 1, 1_000);
    assert.deepEqual(activityEvents[0].activity, {
      kind: "federation.chat.interaction",
      runId: "run-federation-approval",
      sessionKey: `agent:shoggoth-default:${SESSION_B}`,
      interaction: {
        phase: "requested",
        eventType: "approval",
        requestId,
        payload: requestPayload,
      },
    });
    assert.deepEqual(backend.getSessionRows().map((row) => row.key), [
      `agent:shoggoth-default:${SESSION_B}`,
    ]);

    const response = await backend.respondChatPrompt(
      `agent:shoggoth-default:${SESSION_B}`,
      { requestId, choice: "once" },
    );
    assert.equal(response.state, "responded");
    releaseResolved = true;
    await waitForCondition(() => activityEvents.length === 2, 1_000);
    assert.deepEqual(activityEvents[1].activity, {
      kind: "federation.chat.interaction",
      runId: "run-federation-approval",
      sessionKey: `agent:shoggoth-default:${SESSION_B}`,
      interaction: {
        phase: "resolved",
        eventType: "approval",
        requestId,
        payload: null,
      },
    });
    await waitForCondition(() => calls.some(({ request }) => request.method === "events.subscribe"
      && request.params.afterSeq === 2), 1_000);
  } finally {
    await registry.stop();
  }
});

test("orphan, redacted and stale federation events do not block or revive later activity", async () => {
  let sessionsVisible = false;
  let eventPages = 0;
  const completedAt = Date.now();
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", sessionsVisible ? [session(SESSION_B, {
        title: null,
        derivedTitle: "来自 Antigravity 的联邦任务",
        updatedAt: completedAt,
      })] : []);
    }
    if (request.method === "events.subscribe") {
      eventPages += 1;
      if (eventPages === 1) {
        sessionsVisible = true;
        return serviceEventPage([
          {
            seq: 1,
            type: "federation.chat.terminal",
            payload: {
              runId: "run-federation-orphan",
              profileId: "profile-default",
              sessionKey: SESSION_A,
              status: "completed",
              result: "已删除会话的历史终态",
              errorCode: null,
              finishedAt: completedAt - 1,
            },
          },
          {
            seq: 2,
            type: "federation.chat.interaction",
            payload: {
              runId: "run-federation-redacted",
              profileId: "profile-default",
              sessionKey: SESSION_B,
              interaction: {
                phase: "requested",
                eventType: "prompt",
                requestId: "request-federation-redacted",
                payload: {
                  requestId: "request-federation-redacted",
                  method: "mcpServer/elicitation/request",
                  kind: "mcp_elicitation",
                  redacted: true,
                },
              },
            },
          },
          {
            seq: 3,
            type: "federation.chat.interaction",
            payload: {
              runId: "run-federation-stale",
              profileId: "profile-default",
              sessionKey: SESSION_B,
              interaction: {
                phase: "requested",
                eventType: "approval",
                requestId: "request-federation-stale",
                payload: {
                  requestId: "request-federation-stale",
                  method: "item/commandExecution/requestApproval",
                  kind: "command",
                  command: "shoggoth__notification_send",
                  reason: "已经处理过的历史审批",
                  sessionApprovalAvailable: true,
                  expiresAt: null,
                },
              },
            },
          },
          {
            seq: 4,
            type: "federation.chat.interaction",
            payload: {
              runId: "run-federation-stale",
              profileId: "profile-default",
              sessionKey: SESSION_B,
              interaction: {
                phase: "resolved",
                eventType: "approval",
                requestId: "request-federation-stale",
                payload: null,
              },
            },
          },
          {
            seq: 5,
            type: "federation.chat.terminal",
            payload: {
              runId: "run-federation-stale",
              profileId: "profile-default",
              sessionKey: SESSION_B,
              status: "completed",
              result: "后续终态仍可见",
              errorCode: null,
              finishedAt: completedAt,
            },
          },
        ]);
      }
      return serviceEventPage([], { afterSeq: request.params.afterSeq, latestSeq: 5 });
    }
    if (request.method === "run.get") {
      return {
        run: run("completed", {
          id: "run-federation-stale",
          sourceId: SESSION_B,
        }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.kind === "federation.chat.terminal"
    )), 1_000);
    assert.deepEqual(activityEvents[0].activity, {
      kind: "federation.chat.interaction.clear",
      runId: "run-federation-orphan",
      sessionKey: `agent:shoggoth-default:${SESSION_A}`,
    });
    assert.deepEqual(activityEvents[1].activity, {
      kind: "federation.chat.interaction",
      runId: "run-federation-stale",
      sessionKey: `agent:shoggoth-default:${SESSION_B}`,
      interaction: {
        phase: "resolved",
        eventType: "approval",
        requestId: "request-federation-stale",
        payload: null,
      },
    });
    assert.deepEqual(activityEvents[2].activity, {
      kind: "federation.chat.terminal",
      runId: "run-federation-stale",
      sessionKey: `agent:shoggoth-default:${SESSION_B}`,
      status: "completed",
      result: "后续终态仍可见",
      errorCode: null,
      finishedAt: completedAt,
    });
    assert.equal(
      activityEvents.some((event) => event.activity.interaction?.phase === "requested"),
      false,
    );
    await waitForCondition(() => calls.some(({ request }) => request.method === "events.subscribe"
      && request.params.afterSeq === 5), 1_000);
  } finally {
    await registry.stop();
  }
});

test("Service event epoch change reconciles stale approvals before replaying equal-seq terminals", async () => {
  const requestId = "request-before-service-restart";
  const requestPayload = {
    requestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "shoggoth__notification_send",
    reason: "重启前等待审批",
    sessionApprovalAvailable: true,
    expiresAt: null,
  };
  let switched = false;
  let observedOldRequest = false;
  let restartProbeSeen = false;
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", [session(SESSION_B)]);
    }
    if (request.method === "events.subscribe") {
      if (!switched) {
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-before-service-restart",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId,
              payload: requestPayload,
            },
          },
        }], { streamId: STREAM_A });
      }
      if (request.params.afterSeq === 1 && !restartProbeSeen) {
        restartProbeSeen = true;
        return serviceEventPage([], {
          afterSeq: 1,
          latestSeq: 1,
          streamId: STREAM_B,
        });
      }
      if (request.params.afterSeq === 0) {
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.terminal",
          payload: {
            runId: "run-before-service-restart",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            status: "interrupted",
            result: null,
            errorCode: "SERVICE_RESTARTED",
            finishedAt: 3456,
          },
        }], { streamId: STREAM_B });
      }
      return serviceEventPage([], {
        afterSeq: request.params.afterSeq,
        latestSeq: 1,
        streamId: STREAM_B,
      });
    }
    if (request.method === "run.get") {
      observedOldRequest = true;
      switched = true;
      return {
        run: run("waiting_approval", {
          id: "run-before-service-restart",
          sourceId: SESSION_B,
          idempotencyKey: "shoggoth:chat-send:federation-send-restart",
          waitingRequestId: requestId,
        }),
      };
    }
    if (request.method === "run.list") return page("runs", []);
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.kind === "federation.chat.terminal"
    )), 1_000);
    assert.equal(observedOldRequest, true);
    assert.deepEqual(activityEvents.map((event) => event.activity.kind), [
      "federation.chat.interaction",
      "federation.chat.interaction.reset",
      "federation.chat.terminal",
    ]);
    assert.equal(activityEvents[2].activity.errorCode, "SERVICE_RESTARTED");
    assert.deepEqual(
      calls.filter(({ request }) => request.method === "events.subscribe")
        .slice(0, 3).map(({ request }) => request.params.afterSeq),
      [0, 1, 0],
      "新 epoch 即使 latestSeq 等于旧 cursor，也必须从 0 重读终态",
    );
    await assert.rejects(
      backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_B}`, {
        requestId,
        choice: "once",
      }),
      (error) => error.code === "RUN_REQUEST_NOT_FOUND",
    );
  } finally {
    await registry.stop();
  }
});

test("Service cursor gap atomically replaces lost resolutions with authoritative pending prompts", async () => {
  const staleRequestId = "request-lost-resolution";
  const currentRequestId = "request-current-after-gap";
  const stalePayload = {
    requestId: staleRequestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "stale",
    reason: "已经处理",
    sessionApprovalAvailable: false,
    expiresAt: null,
  };
  const currentPayload = {
    requestId: currentRequestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "current",
    reason: "仍在等待",
    sessionApprovalAvailable: true,
    expiresAt: null,
  };
  const currentRun = run("waiting_approval", {
    id: "run-current-after-gap",
    sourceId: SESSION_B,
    idempotencyKey: "shoggoth:chat-send:federation-message-current",
    waitingRequestId: currentRequestId,
    eventSeq: 3,
  });
  let gapMode = false;
  let failReconciliationOnce = true;
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", [session(SESSION_A), session(SESSION_B)]);
    }
    if (request.method === "events.subscribe") {
      if (!gapMode) {
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-lost-resolution",
            profileId: "profile-default",
            sessionKey: SESSION_A,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId: staleRequestId,
              payload: stalePayload,
            },
          },
        }]);
      }
      if (request.params.afterSeq === 1) {
        return serviceEventPage([], {
          afterSeq: 1,
          cursor: 5,
          baseSeq: 5,
          latestSeq: 6,
          gap: {
            code: "CURSOR_GAP",
            requestedAfterSeq: 1,
            baseSeq: 5,
            oldestSeq: 6,
          },
          snapshot: { kind: "cursor-reset", baseSeq: 5, latestSeq: 6 },
        });
      }
      if (request.params.afterSeq === 5) {
        return serviceEventPage([{
          seq: 6,
          type: "fixture.noop",
          payload: {},
        }], { afterSeq: 5, baseSeq: 5, latestSeq: 6 });
      }
      return serviceEventPage([], {
        afterSeq: request.params.afterSeq,
        baseSeq: 5,
        latestSeq: 6,
      });
    }
    if (request.method === "run.get") {
      gapMode = true;
      return {
        run: run("waiting_approval", {
          id: "run-lost-resolution",
          sourceId: SESSION_A,
          idempotencyKey: "shoggoth:chat-send:federation-send-stale",
          waitingRequestId: staleRequestId,
        }),
      };
    }
    if (request.method === "run.list") {
      if (request.params.status === "waiting_approval" && failReconciliationOnce) {
        failReconciliationOnce = false;
        throw Object.assign(new Error("temporary list failure"), {
          code: "SERVICE_DISCONNECTED",
        });
      }
      return page("runs", request.params.status === "waiting_approval" ? [currentRun] : []);
    }
    if (request.method === "run.subscribe") {
      return federationInteractionReset(request, currentRun, currentPayload);
    }
    if (request.method === "run.approval.respond") {
      assert.equal(request.params.runId, currentRun.id);
      assert.equal(request.params.requestId, currentRequestId);
      return {
        requestId: currentRequestId,
        state: "responded",
        run: { ...currentRun, status: "running", waitingRequestId: null },
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.kind === "federation.chat.interaction"
        && event.activity.interaction?.requestId === currentRequestId
    )), 1_000);
    assert.deepEqual(activityEvents.map((event) => (
      event.activity.kind === "federation.chat.interaction"
        ? `${event.activity.kind}:${event.activity.interaction.requestId}`
        : event.activity.kind
    )), [
      `federation.chat.interaction:${staleRequestId}`,
      "federation.chat.interaction.reset",
      `federation.chat.interaction:${currentRequestId}`,
    ]);
    assert.equal(
      calls.filter(({ request }) => request.method === "events.subscribe"
        && request.params.afterSeq === 1).length >= 2,
      true,
      "对账失败时不得推进 gap cursor，下一轮必须重试同一页",
    );
    await assert.rejects(
      backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_A}`, {
        requestId: staleRequestId,
        choice: "once",
      }),
      (error) => error.code === "RUN_REQUEST_NOT_FOUND",
    );
    const response = await backend.respondChatPrompt(
      `agent:shoggoth-default:${SESSION_B}`,
      { requestId: currentRequestId, choice: "once" },
    );
    assert.equal(response.state, "responded");
  } finally {
    await registry.stop();
  }
});

test("oversized authoritative approval reconciliation remains deny-only", async () => {
  const requestId = "request-oversized-reconciled";
  const unprojectableRequestId = "request-wire-oversized-reconciled";
  const unprojectableRun = run("waiting_approval", {
    id: "run-wire-oversized-reconciled",
    sourceId: SESSION_A,
    idempotencyKey: "shoggoth:chat-send:federation-send-wire-oversized",
    waitingRequestId: unprojectableRequestId,
    eventSeq: 2,
  });
  const pendingRun = run("waiting_approval", {
    id: "run-oversized-reconciled",
    sourceId: SESSION_B,
    idempotencyKey: "shoggoth:chat-send:federation-send-oversized-reconciled",
    waitingRequestId: requestId,
    eventSeq: 3,
  });
  const payload = {
    requestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "fixture",
    reason: "x".repeat(40 * 1024),
    sessionApprovalAvailable: true,
    expiresAt: null,
  };
  const decisions = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "run.list") {
      return page("runs", request.params.status === "waiting_approval"
        ? [unprojectableRun, pendingRun] : []);
    }
    if (request.method === "run.subscribe") {
      if (request.params.runId === unprojectableRun.id) {
        throw Object.assign(new Error("wire snapshot overflow"), {
          code: "RUN_EVENT_SNAPSHOT_TOO_LARGE",
        });
      }
      return federationInteractionReset(request, pendingRun, payload);
    }
    if (request.method === "run.approval.respond") {
      decisions.push(request.params.choice);
      const selectedRun = request.params.runId === unprojectableRun.id
        ? unprojectableRun : pendingRun;
      return {
        requestId: request.params.requestId,
        state: "responded",
        run: { ...selectedRun, status: "running", waitingRequestId: null },
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { sessions: [session(SESSION_A), session(SESSION_B)] });

  assert.equal(await backend._reconcileFederationInteractions(backend._generation), true);
  assert.deepEqual(
    backend._promptByRequest.get(unprojectableRequestId)?.request?.approvalChoices,
    ["deny", "cancel"],
  );
  assert.deepEqual(
    backend._promptByRequest.get(requestId)?.request?.approvalChoices,
    ["deny", "cancel"],
  );
  await assert.rejects(
    backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_B}`, {
      requestId,
      choice: "once",
    }),
    (error) => error.code === "RUN_APPROVAL_DECISION_INVALID",
  );
  const unprojectableResponse = await backend.respondChatPrompt(
    `agent:shoggoth-default:${SESSION_A}`,
    { requestId: unprojectableRequestId, choice: "deny" },
  );
  assert.equal(unprojectableResponse.state, "responded");
  const response = await backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_B}`, {
    requestId,
    choice: "deny",
  });
  assert.equal(response.state, "responded");
  assert.deepEqual(decisions, ["deny", "deny"]);
});

test("archived sessions and disabled profiles expire their exact bridged approvals", async () => {
  const firstRequestId = "request-archived-target";
  const secondRequestId = "request-disabled-profile";
  let sessionVisible = true;
  let profileEnabled = true;
  let releaseResolved = false;
  let releaseSecond = false;
  const approvalPayload = (requestId, reason) => ({
    requestId,
    method: "item/commandExecution/requestApproval",
    kind: "command",
    command: "fixture",
    reason,
    sessionApprovalAvailable: false,
    expiresAt: null,
  });
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "agent.lifecycle.list") {
      return {
        agents: [{
          profile: profile({ enabled: profileEnabled }),
          state: profileEnabled ? "active" : "archived",
          pendingOperationId: null,
        }],
      };
    }
    if (request.method === "chat.session.list") {
      return page("sessions", sessionVisible ? [session(SESSION_B)] : []);
    }
    if (request.method === "events.subscribe") {
      if (request.params.afterSeq === 0) {
        return serviceEventPage([{
          seq: 1,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-archived-target",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId: firstRequestId,
              payload: approvalPayload(firstRequestId, "会话归档前"),
            },
          },
        }]);
      }
      if (request.params.afterSeq === 1 && releaseResolved) {
        return serviceEventPage([{
          seq: 2,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-archived-target",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "resolved",
              eventType: "approval",
              requestId: firstRequestId,
              payload: null,
            },
          },
        }], { afterSeq: 1 });
      }
      if (request.params.afterSeq === 2 && releaseSecond) {
        return serviceEventPage([{
          seq: 3,
          type: "federation.chat.interaction",
          payload: {
            runId: "run-disabled-profile",
            profileId: "profile-default",
            sessionKey: SESSION_B,
            interaction: {
              phase: "requested",
              eventType: "approval",
              requestId: secondRequestId,
              payload: approvalPayload(secondRequestId, "Agent 停用前"),
            },
          },
        }], { afterSeq: 2 });
      }
      return serviceEventPage([], {
        afterSeq: request.params.afterSeq,
        latestSeq: releaseSecond ? 3 : releaseResolved ? 2 : 1,
      });
    }
    if (request.method === "run.get") {
      const second = request.params.runId === "run-disabled-profile";
      return {
        run: run("waiting_approval", {
          id: request.params.runId,
          sourceId: SESSION_B,
          idempotencyKey: `shoggoth:chat-send:federation-send-${second ? "disabled" : "archived"}`,
          waitingRequestId: second ? secondRequestId : firstRequestId,
        }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { serviceEventPollMs: 1 });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("shoggoth"), true);
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.interaction?.requestId === firstRequestId
        && event.activity.interaction.phase === "requested"
    )), 1_000);
    sessionVisible = false;
    releaseResolved = true;
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.interaction?.requestId === firstRequestId
        && event.activity.interaction.phase === "resolved"
    )), 1_000);
    assert.equal(
      activityEvents.find((event) => (
        event.activity.interaction?.requestId === firstRequestId
          && event.activity.interaction.phase === "resolved"
      )).activity.sessionKey,
      `agent:shoggoth-default:${SESSION_B}`,
      "归档会话仍须使用不可变目标身份清理卡片",
    );

    sessionVisible = true;
    releaseSecond = true;
    await waitForCondition(() => activityEvents.some((event) => (
      event.activity.interaction?.requestId === secondRequestId
        && event.activity.interaction.phase === "requested"
    )), 1_000);
    const bridgedRecord = backend._promptByRequest.get(secondRequestId);
    backend._rememberPrompt(
      SESSION_B,
      "run-disabled-profile",
      approvalPayload(secondRequestId, "Agent 停用前"),
      "approval",
      bridgedRecord.request,
    );
    assert.equal(
      backend._promptByRequest.get(secondRequestId).federation,
      true,
      "同一交互被直接 watcher 重放时必须保留 bridge ownership",
    );
    profileEnabled = false;
    assert.equal(await backend._refreshManagedProfiles(), true);
    const disabledCleanup = activityEvents.find((event) => (
      event.activity.interaction?.requestId === secondRequestId
        && event.activity.interaction.phase === "resolved"
    ));
    assert.equal(disabledCleanup.activity.sessionKey, `agent:shoggoth-default:${SESSION_B}`);
    assert.deepEqual(backend.getAgents(), []);
  } finally {
    await registry.stop();
  }
});

test("peer native facade skips another profile terminal and advances to its own activity", async () => {
  const codexProfile = profile({
    id: "profile-codex",
    backendId: "codex",
    agentId: "shoggoth-codex",
    name: "Codex",
    runtimeProfileId: "runtime-codex",
    providerRef: null,
    defaultModel: null,
    isDefault: false,
  });
  let sessionsVisible = false;
  let eventPages = 0;
  const completedAt = Date.now();
  const { backend, calls } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [codexProfile]);
    if (request.method === "agent.lifecycle.list") {
      return {
        agents: [{ profile: codexProfile, state: "active", pendingOperationId: null }],
      };
    }
    if (request.method === "chat.session.list") {
      return page("sessions", sessionsVisible ? [session(SESSION_B, {
        profileId: codexProfile.id,
        title: null,
        derivedTitle: "来自 Shoggoth 的联邦消息",
        updatedAt: completedAt,
      })] : []);
    }
    if (request.method === "events.subscribe") {
      eventPages += 1;
      if (eventPages === 1) {
        sessionsVisible = true;
        return serviceEventPage([
          {
            seq: 1,
            type: "federation.chat.terminal",
            payload: {
              runId: "run-for-another-facade",
              profileId: "profile-default",
              sessionKey: SESSION_A,
              status: "completed",
              result: "belongs elsewhere",
              errorCode: null,
              finishedAt: completedAt - 1,
            },
          },
          {
            seq: 2,
            type: "federation.chat.terminal",
            payload: {
              runId: "run-for-codex-facade",
              profileId: codexProfile.id,
              sessionKey: SESSION_B,
              status: "completed",
              result: "NATIVE-FED-569021",
              errorCode: null,
              finishedAt: completedAt,
            },
          },
        ]);
      }
      return serviceEventPage([], { afterSeq: request.params.afterSeq, latestSeq: 2 });
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    id: "codex",
    name: "Codex",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-codex",
    serviceEventPollMs: 1,
  });
  const registry = new BackendRegistry();
  const activityEvents = [];
  registry.register(backend);
  registry.on("backend.sessionActivity", (event) => activityEvents.push(structuredClone(event)));
  try {
    const started = await registry.start();
    assert.equal(started.get("codex"), true);
    await waitForCondition(() => activityEvents.length > 0, 1_000);
    assert.equal(activityEvents.length, 1);
    assert.deepEqual(activityEvents[0].activity, {
      kind: "federation.chat.terminal",
      runId: "run-for-codex-facade",
      sessionKey: `agent:shoggoth-codex:${SESSION_B}`,
      status: "completed",
      result: "NATIVE-FED-569021",
      errorCode: null,
      finishedAt: completedAt,
    });
    await waitForCondition(() => calls.some(({ request }) => request.method === "events.subscribe"
      && request.params.afterSeq === 2), 1_000);
  } finally {
    await registry.stop();
  }
});

test("Agent Service publishes only native federation chat lifecycle events to the App event bridge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-terminal-"));
  const appended = [];
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const service = createAgentService({
    paths,
    eventBuffer: {
      append(type, payload) {
        appended.push({ type, payload: structuredClone(payload) });
        return { seq: appended.length, type, payload };
      },
      page() { return serviceEventPage([]); },
    },
  });
  try {
    const requestId = "request-federation-1";
    const requested = {
      phase: "requested",
      eventType: "approval",
      requestId,
      payload: {
        requestId,
        method: "item/commandExecution/requestApproval",
        kind: "command",
        command: "shoggoth__notification_send",
        reason: "发送测试通知",
        sessionApprovalAvailable: true,
        expiresAt: null,
      },
    };
    const federationRun = run("waiting_approval", {
      id: "run-federation-1",
      sourceId: SESSION_B,
      idempotencyKey: "shoggoth:chat-send:federation-send-mcp-v1-fixture",
      waitingRequestId: requestId,
    });
    const directRun = run("waiting_approval", {
      id: "run-direct-1",
      idempotencyKey: "shoggoth:chat-send:direct-ui-send",
      waitingRequestId: requestId,
    });
    service.workRunCoordinator.onRunInteraction(federationRun, requested);
    service.workRunCoordinator.onRunInteraction(directRun, requested);
    service.workRunCoordinator.onRunInteraction({
      ...federationRun,
      status: "running",
      waitingRequestId: null,
    }, {
      phase: "resolved",
      eventType: "approval",
      requestId,
      payload: null,
    });
    service.workRunCoordinator.onRunInteraction({
      ...directRun,
      status: "running",
      waitingRequestId: null,
    }, {
      phase: "resolved",
      eventType: "approval",
      requestId,
      payload: null,
    });
    const terminal = {
      status: "completed",
      resultSummary: "来自 Shoggoth 的目标会话回复",
      errorCode: null,
    };
    service.workRunCoordinator.onRunTerminal(run("completed", {
      id: "run-federation-1",
      sourceId: SESSION_B,
      idempotencyKey: "shoggoth:chat-send:federation-send-mcp-v1-fixture",
      finishedAt: 4321,
    }), terminal);
    service.workRunCoordinator.onRunTerminal(run("completed", {
      id: "run-direct-1",
      idempotencyKey: "shoggoth:chat-send:direct-ui-send",
      finishedAt: 4322,
    }), terminal);
    assert.deepEqual(appended, [
      {
        type: "federation.chat.interaction",
        payload: {
          runId: "run-federation-1",
          profileId: "profile-default",
          sessionKey: SESSION_B,
          interaction: requested,
        },
      },
      {
        type: "federation.chat.interaction",
        payload: {
          runId: "run-federation-1",
          profileId: "profile-default",
          sessionKey: SESSION_B,
          interaction: {
            phase: "resolved",
            eventType: "approval",
            requestId,
            payload: null,
          },
        },
      },
      {
        type: "federation.chat.terminal",
        payload: {
          runId: "run-federation-1",
          profileId: "profile-default",
          sessionKey: SESSION_B,
          status: "completed",
          result: "来自 Shoggoth 的目标会话回复",
          errorCode: null,
          finishedAt: 4321,
        },
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("oversized federation approval bridge falls back to a bounded deny-only card", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-approval-fallback-"));
  const appended = [];
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const service = createAgentService({
    paths,
    eventBuffer: {
      append(type, payload) {
        if (payload.interaction?.payload?.reason?.length > 1_000) {
          throw Object.assign(new Error("fixture event envelope overflow"), {
            code: "EVENT_TOO_LARGE",
          });
        }
        appended.push({ type, payload: structuredClone(payload) });
        return { seq: appended.length, type, payload };
      },
      page() { return serviceEventPage([]); },
    },
  });
  try {
    const requestId = "request-oversized-federation-approval";
    service.workRunCoordinator.onRunInteraction(run("waiting_approval", {
      id: "run-oversized-federation-approval",
      sourceId: SESSION_B,
      idempotencyKey: "shoggoth:chat-send:federation-send-oversized",
      waitingRequestId: requestId,
    }), {
      phase: "requested",
      eventType: "approval",
      requestId,
      payload: {
        requestId,
        method: "item/commandExecution/requestApproval",
        kind: "command",
        command: "fixture",
        reason: "x".repeat(49 * 1024),
        sessionApprovalAvailable: true,
        expiresAt: null,
      },
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, "federation.chat.interaction");
    assert.deepEqual(appended[0].payload.interaction.payload, {
      requestId,
      method: "redacted",
      kind: "permissions",
      reason: "审批详情无法安全完整显示，只能拒绝或取消",
      sessionApprovalAvailable: false,
      expiresAt: null,
      redacted: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a partial refresh never replaces an authoritative cache", async () => {
  let fail = false;
  const { backend } = fakeBackend((request) => {
    if (fail && request.method === "chat.session.list") throw Object.assign(new Error("token=secret"), { code: "SERVICE_DISCONNECTED" });
    if (request.method === "profile.list") return page("profiles", [profile()]);
    return page("sessions", [session()]);
  });
  assert.equal(await backend.start(), true);
  const stable = backend.getSessionRowsSnapshot().rows;
  await backend.stop();
  fail = true;
  assert.equal(await backend.start(), false);
  assert.deepEqual(backend.getSessionRowsSnapshot(), { rows: stable, complete: false });
});

test("disconnecting a native facade leaves peers and the shared Service running", async () => {
  const registry = new BackendRegistry();
  const fixtures = ["shoggoth", "codex", "grok-build"].map((id) => fakeBackend(
    () => page("profiles", []), { id, name: id, connectionMode: id === "shoggoth" ? "builtin-service" : "native-runtime" },
  ));
  let disabled = [];
  registry.setDisabledBackendsProvider(() => disabled);
  for (const { backend } of fixtures) registry.register(backend);
  try {
    await registry.start();
    for (const { backend, calls } of fixtures) {
      disabled = [backend.id];
      calls.length = 0;
      await backend.stop();
      assert.equal((await backend.getStatus()).connected, false);
      assert.equal(calls.length, 0, "disconnect must not send Service stop or other commands");
      const statuses = await registry.getStatus();
      assert.equal(statuses.find(({ id }) => id === backend.id).disabled, true);
      assert.ok(statuses.filter(({ id }) => id !== backend.id).every(({ connected }) => connected));
      assert.equal(calls.length, 0, "disabled status must not restart or probe the facade");
      disabled = [];
      assert.equal(await backend.start(), true);
      assert.equal((await backend.getStatus()).connected, true);
    }
  } finally { await registry.stop(); }
});

test("a native connection disabled at boot gets live event hooks when reconnected", async () => {
  const registry = new BackendRegistry();
  const shoggoth = fakeBackend(() => page("profiles", []));
  const codex = fakeBackend(() => page("profiles", []), { id: "codex", connectionMode: "native-runtime" });
  let disabled = ["codex"];
  const ready = [], activity = [];
  registry.register(shoggoth.backend);
  registry.register(codex.backend);
  registry.setDisabledBackendsProvider(() => disabled);
  registry.on("backend.ready", event => ready.push(event.backendId));
  registry.on("backend.sessionActivity", event => activity.push(event));
  try {
    await registry.start();
    assert.equal(codex.calls.length, 0);
    assert.equal((await registry.start("codex")).size, 0, "disabled connections cannot be started indirectly");
    disabled = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      ready.length = 0;
      shoggoth.calls.length = 0;
      const started = await registry.start("codex");
      assert.deepEqual([...started], [["codex", true]]);
      assert.deepEqual(ready, ["codex"], "reconnect publishes exactly one readiness event");
      assert.equal(shoggoth.calls.length, 0, "reconnect must not restart peers");
      codex.backend._sessionActivityNotifier({ kind: "fixture-session-update" });
      assert.equal(activity.at(-1).backendId, "codex");
      assert.equal(activity.at(-1).activity.kind, "fixture-session-update");
      await codex.backend.stop();
    }
  } finally { await registry.stop(); }
});

test("start is single-flight and a start racing stop waits for the stopped generation", async () => {
  let profileCalls = 0;
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") {
      profileCalls += 1;
      return page("profiles", [profile()]);
    }
    return page("sessions", [session()]);
  });
  const first = backend.start();
  assert.equal(first, backend.start());
  assert.equal(await first, true);
  assert.equal(profileCalls, 1);
  const stopping = backend.stop();
  const restarting = backend.start();
  await stopping;
  assert.equal(await restarting, true);
  assert.equal(profileCalls, 2);
});

test("pending start must fully quiesce before stop permits a fresh generation", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let profileCalls = 0;
  const { backend } = fakeBackend(async (request) => {
    if (request.method === "profile.list") {
      profileCalls += 1;
      if (profileCalls === 1) await gate;
      return page("profiles", [profile()]);
    }
    return page("sessions", [session()]);
  });
  const staleStart = backend.start();
  await waitForCondition(() => profileCalls === 1);
  const stopping = backend.stop();
  const freshStart = backend.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profileCalls, 1, "fresh generation must not overlap stale start I/O");
  release();
  assert.equal(await staleStart, false);
  await stopping;
  assert.equal(await freshStart, true);
  assert.equal(profileCalls, 2);
});

test("malformed Service DTO is rejected instead of trusted", async () => {
  const { backend } = fakeBackend((request) => request.method === "profile.list"
    ? { profiles: [{ id: "forged" }], nextCursor: null, hasMore: false }
    : page("sessions", []));
  assert.equal(await backend.start(), false);
  assert.deepEqual(backend.getAgents(), []);
});

test("dashboard cannot bypass deny-only approval choices", async () => {
  const requestId = "request-dashboard-redacted";
  const pendingRun = run("waiting_approval", { waitingRequestId: requestId });
  const approvalEvent = event(1, "approval", {
    requestId,
    method: "redacted",
    kind: "permissions",
    reason: "审批详情无法安全完整显示，只能拒绝或取消",
    sessionApprovalAvailable: true,
    expiresAt: null,
    redacted: true,
  });

  const attempt = async (choice) => {
    const forwarded = [];
    const { backend } = await readyBackend((request) => {
      if (request.method === "run.get") return { run: pendingRun };
      if (request.method === "run.subscribe") {
        return subscription([approvalEvent], { latestSeq: 1 });
      }
      if (request.method === "run.approval.respond") {
        forwarded.push(request.params.choice);
        return {
          requestId,
          state: "responded",
          run: { ...pendingRun, status: "running", waitingRequestId: null },
        };
      }
      throw new Error(`unexpected ${request.method}`);
    });
    const response = backend.respondDashboardPrompt({
      runId: pendingRun.id,
      requestId,
      kind: "approval",
      choice,
    });
    if (["once", "session"].includes(choice)) {
      await assert.rejects(
        response,
        (error) => error.code === "RUN_APPROVAL_DECISION_INVALID",
      );
      assert.deepEqual(forwarded, []);
    } else {
      assert.equal((await response).state, "responded");
      assert.deepEqual(forwarded, [choice]);
    }
  };

  for (const choice of ["once", "session", "deny", "cancel"]) {
    await attempt(choice);
  }
});

test("dashboard preserves native approval scopes and only forwards offered choices", async () => {
  const requestId = "request-dashboard-native";
  const pendingRun = run("waiting_approval", { waitingRequestId: requestId });
  const approvalOptions = [
    { choice: "once", label: "Allow once", kind: "allow_once" },
    { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
    { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
    { choice: "deny", label: "Reject", kind: "reject_once" },
  ];
  const approvalEvent = event(1, "approval", { requestId, kind: "command",
    command: "shoggoth__kanban_card_create", sessionApprovalAvailable: false, approvalOptions });
  const forwarded = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "run.get") return { run: pendingRun };
    if (request.method === "run.subscribe") return subscription([approvalEvent], { latestSeq: 1 });
    if (request.method === "run.approval.respond") {
      forwarded.push(request.params.choice);
      return { requestId, state: "responded", run: { ...pendingRun, status: "running", waitingRequestId: null } };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const details = backend._dashboardPromptDetails(pendingRun, [approvalEvent]);
  assert.deepEqual(details.interactiveRequest.approvalOptions, approvalOptions);
  for (const choice of ["session", "runtime:31"]) {
    await assert.rejects(backend.respondDashboardPrompt({ runId: pendingRun.id, requestId, kind: "approval", choice }),
      { code: "RUN_APPROVAL_DECISION_INVALID" });
  }
  assert.deepEqual(forwarded, []);
  await backend.respondDashboardPrompt({ runId: pendingRun.id, requestId, kind: "approval", choice: "runtime:2" });
  assert.deepEqual(forwarded, ["runtime:2"]);
});

test("session create/rename/delete translate gateway keys and maintain snapshot", async () => {
  const calls = [];
  const activityEvents = [];
  const { backend } = fakeBackend((request) => {
    calls.push(request);
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", []);
    if (request.method === "chat.session.create") return { session: session() };
    if (request.method === "chat.session.model.set") return {
      session: session(SESSION_A, { modelOverride: request.params.model, updatedAt: 1234 }),
    };
    if (request.method === "chat.session.permission.set") return {
      session: session(SESSION_A, { permissionMode: request.params.mode, updatedAt: 1235 }),
    };
    if (request.method === "chat.session.rename") return {
      session: session(SESSION_A, { title: request.params.title, status: "ready", codexThreadId: "thread-1" }),
      operation: {
        operationId: request.params.operationId, sessionKey: SESSION_A, kind: "rename",
        title: request.params.title, state: "completed", createdAt: 1234, updatedAt: 1234, finishedAt: 1234,
      },
    };
    if (request.method === "chat.session.delete") return {
      session: session(SESSION_A, { status: "delete_pending", codexThreadId: "thread-1" }),
      operation: {
        operationId: request.params.operationId, sessionKey: SESSION_A, kind: "delete",
        title: null, state: "completed", createdAt: 1234, updatedAt: 1234, finishedAt: 1234,
      },
    };
    throw new Error(`unexpected ${request.method}`);
  });
  await backend.start({
    onSessionActivity: (activity) => activityEvents.push(structuredClone(activity)),
  });
  const key = await backend.createSession("shoggoth-default", {
    workspace: "/tmp/shoggoth-project",
  });
  assert.equal(key, `agent:shoggoth-default:${SESSION_A}`);
  assert.equal(
    calls.find((call) => call.method === "chat.session.create").params.workspace,
    "/tmp/shoggoth-project",
  );
  assert.deepEqual(await backend.setSessionModel(key, { model: "gpt-5.6-terra" }), {
    model: "gpt-5.6-terra", scope: "session",
  });
  assert.deepEqual(calls.find((call) => call.method === "chat.session.model.set").params, {
    sessionKey: SESSION_A, model: "gpt-5.6-terra",
  });
  assert.equal(backend.getSessionRows()[0].model, "gpt-5.6-terra");
  assert.deepEqual(await backend.setSessionPermission(key, { mode: "workspace-auto" }), {
    mode: "workspace-auto", scope: "session",
  });
  assert.deepEqual(calls.find((call) => call.method === "chat.session.permission.set").params, {
    sessionKey: SESSION_A, mode: "workspace-auto",
  });
  assert.equal(backend.getSessionRows()[0].permissionMode, "workspace-auto");
  await backend.renameSession(key, "Renamed");
  assert.equal(backend.getSessionRows()[0].label, "Renamed");
  backend._activeBySession.set(SESSION_A, {
    runId: "run-delete-approval",
    requestId: "request-delete-approval",
    status: "waiting_approval",
  });
  backend._promptByRequest.set("request-delete-approval", {
    sessionKey: SESSION_A,
    runId: "run-delete-approval",
    kind: "approval",
    federation: true,
    federationProfileId: "profile-default",
  });
  await backend.deleteSession(key);
  assert.deepEqual(backend.getSessionRows(), []);
  assert.deepEqual(activityEvents, [{
    kind: "federation.chat.interaction.clear",
    runId: "run-delete-approval",
    sessionKey: key,
  }]);
  assert.equal(backend._activeBySession.size, 0);
  assert.equal(backend._promptByRequest.size, 0);
});

test("session create inherits its parent workspace unless explicitly overridden", async () => {
  const calls = [];
  const parent = session(SESSION_A, { workspace: "/tmp/current-project" });
  const { backend } = fakeBackend((request) => {
    calls.push(request);
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") return page("sessions", [parent]);
    if (request.method === "chat.session.create") {
      return {
        session: session(SESSION_B, {
          workspace: request.params.workspace,
          createdAt: 1234,
          updatedAt: 1234,
        }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await backend.start();

  const inheritedKey = await backend.createSession("shoggoth-default", {
    parentSessionKey: `agent:shoggoth-default:${SESSION_A}`,
  });
  assert.equal(inheritedKey, `agent:shoggoth-default:${SESSION_B}`);
  assert.equal(
    calls.find((call) => call.method === "chat.session.create").params.workspace,
    "/tmp/current-project",
  );

  await backend.createSession("shoggoth-default", {
    parentSessionKey: `agent:shoggoth-default:${SESSION_A}`,
    workspace: "/tmp/explicit-project",
  });
  assert.equal(
    calls.filter((call) => call.method === "chat.session.create").at(-1).params.workspace,
    "/tmp/explicit-project",
  );
});

test("failed session deletion preserves a pending federation approval", async () => {
  const requestId = "request-delete-busy";
  const runId = "run-delete-busy";
  const decisions = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.session.delete") {
      throw Object.assign(new Error("session is busy"), { code: "RUNTIME_SESSION_BUSY" });
    }
    if (request.method === "run.approval.respond") {
      decisions.push(request.params.choice);
      return {
        requestId,
        state: "responded",
        run: run("running", { id: runId, waitingRequestId: null }),
      };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const payload = {
    requestId,
    reason: "删除失败后仍需响应",
    sessionApprovalAvailable: false,
  };
  const record = backend._rememberPrompt(
    SESSION_A,
    runId,
    payload,
    "approval",
    normalizeInteractiveRequestV1({
      runId,
      eventType: "approval",
      payload,
    }),
  );
  record.federation = true;
  record.federationProfileId = "profile-default";

  const key = `agent:shoggoth-default:${SESSION_A}`;
  await assert.rejects(backend.deleteSession(key));
  assert.equal(backend._promptByRequest.has(requestId), true);
  assert.equal(backend._activeBySession.get(SESSION_A)?.requestId, requestId);
  const response = await backend.respondChatPrompt(key, { requestId, choice: "deny" });
  assert.equal(response.state, "responded");
  assert.deepEqual(decisions, ["deny"]);
});

test("session mutations preserve the listed derived title beneath manual rename", async () => {
  const derivedTitle = "第一条原生消息";
  const { backend } = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", [session(SESSION_A, { title: null, derivedTitle })]);
    }
    if (request.method === "chat.session.model.set") return {
      session: session(SESSION_A, { title: null, modelOverride: request.params.model }),
    };
    if (request.method === "chat.session.permission.set") return {
      session: session(SESSION_A, { title: null, permissionMode: request.params.mode }),
    };
    if (request.method === "chat.session.rename") return {
      session: session(SESSION_A, { title: request.params.title, status: "ready", codexThreadId: "thread-1" }),
      operation: {
        operationId: request.params.operationId, sessionKey: SESSION_A, kind: "rename",
        title: request.params.title, state: "completed", createdAt: 1234, updatedAt: 1234,
        finishedAt: 1234,
      },
    };
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await backend.start(), true);
  const key = `agent:shoggoth-default:${SESSION_A}`;
  assert.equal(backend.getSessionRows()[0].derivedTitle, derivedTitle);
  await backend.setSessionModel(key, { model: "gpt-5.6-terra" });
  await backend.setSessionPermission(key, { mode: "workspace-auto" });
  await backend.renameSession(key, "手动名称");
  assert.equal(backend.getSessionRows()[0].label, "手动名称");
  assert.equal(backend.getSessionRows()[0].derivedTitle, derivedTitle);
  await backend.renameSession(key, null);
  assert.equal(backend.getSessionRows()[0].label, undefined);
  assert.equal(backend.getSessionRows()[0].derivedTitle, derivedTitle);
});

test("history paginates and unwraps only canonical message payloads", async () => {
  const first = { id: "msg-1", role: "user", content: [{ type: "text", text: "hello" }] };
  const second = { id: "msg-2", role: "assistant", content: [{ type: "text", text: "world" }] };
  const { backend } = await readyBackend((request) => {
    // Codex history cursor starts at the latest page and walks backwards.
    if (request.params.cursor === null) return page("messages", [historyItem(second, { id: "h-2", createdAt: 200 })], "next");
    return page("messages", [historyItem(first, { id: "h-1", role: "user" })]);
  });
  assert.deepEqual(await backend.getHistory(`agent:shoggoth-default:${SESSION_A}`), {
    messages: [first, second],
  });
});

test("durable runtime errors remain readable after history reload without rewriting quoted codes", async () => {
  const code = "RUNTIME_AUTH_REQUIRED";
  const messages = [
    { id: "error", role: "system", content: [{ type: "text", text: code }], timestamp: 100 },
    { id: "user-quote", role: "user", content: [{ type: "text", text: code }] },
    { id: "assistant-quote", role: "assistant", content: [{ type: "text", text: code }] },
    { id: "system-note", role: "system", content: [{ type: "text", text: code }] },
    { id: "provider-detail", role: "system", content: [{ type: "text", text: "OAuth refresh failed: User account is blocked" }] },
    { id: "unknown-error", role: "system", content: [{ type: "text", text: "NEW_PROVIDER_ERROR" }] },
  ];
  const items = messages.map((message, index) => historyItem(message, {
    id: `h-${index}`, type: [0, 4, 5].includes(index) ? "error" : "text",
  }));
  const original = structuredClone(items);
  const { backend } = await readyBackend(() => page("messages", items));
  const read = await backend.getHistory(`agent:shoggoth-default:${SESSION_A}`);
  assert.equal(read.messages[0].content[0].text,
    "错误：当前 Agent 登录验证失败，请前往「设置」检查账号状态或重新登录后重试");
  assert.equal(read.messages[0].id, "error");
  assert.equal(read.messages[0].timestamp, 100);
  assert.deepEqual(read.messages.slice(1), messages.slice(1));
  assert.deepEqual(items, original, "display conversion must not mutate durable transcript data");
});

test("fragmented runtime errors use the same history display after integrity validation", async () => {
  const message = { id: "error-fragment", role: "system", content: [{ type: "text", text: "RUNTIME_AUTH_REQUIRED" }] };
  const serialized = JSON.stringify(message), split = Math.floor(serialized.length / 2);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");
  const items = [serialized.slice(0, split), serialized.slice(split)].map((data, index) => ({
    id: `f-${index}`, runId: "run-1", role: "system", type: "error", createdAt: 100,
    payload: { encoding: "gateway-message-json-utf8", sha256: hash, data },
    fragment: { messageId: message.id, index, count: 2 },
  }));
  const { backend } = await readyBackend(request => request.params.cursor === null
    ? page("messages", [items[1]], "older") : page("messages", [items[0]]));
  const read = await backend.getHistory(`agent:shoggoth-default:${SESSION_A}`);
  assert.equal(read.messages[0].content[0].text,
    "错误：当前 Agent 登录验证失败，请前往「设置」检查账号状态或重新登录后重试");
});

test("draft session 尚未绑定 Codex thread 时显示空历史而不是首用错误", async () => {
  let historyCalls = 0;
  const { backend } = await readyBackend((request) => {
    if (request.method !== "chat.history") throw new Error(`unexpected ${request.method}`);
    historyCalls += 1;
    throw Object.assign(new Error("draft session has no thread"), {
      code: "CHAT_SESSION_NOT_READY",
    });
  });
  assert.deepEqual(
    await backend.getHistory(`agent:shoggoth-default:${SESSION_A}`),
    { messages: [] },
  );
  assert.equal(historyCalls, 1);
});

test("history reassembles strict UTF-8 fragments across page boundaries", async () => {
  const message = { id: "large-message", role: "assistant", content: [{ type: "text", text: "你好🌋".repeat(4000) }] };
  const json = JSON.stringify(message);
  const split = Math.floor(json.length / 2);
  const pieces = [json.slice(0, split), json.slice(split)];
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  const items = pieces.map((data, index) => ({
    id: `fragment-${index}`,
    runId: "run-1",
    role: "assistant",
    type: "text",
    payload: { encoding: "gateway-message-json-utf8", sha256: hash, data },
    createdAt: 100,
    fragment: { messageId: "large-message", index, count: 2 },
  }));
  const { backend } = await readyBackend((request) => request.params.cursor === null
    ? page("messages", [items[1]], "next") : page("messages", [items[0]]));
  assert.deepEqual((await backend.getHistory(`agent:shoggoth-default:${SESSION_A}`)).messages, [message]);
});

test("history rejects duplicate, corrupt, non-contiguous and non-advancing pages", async () => {
  const message = { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }] };
  const json = JSON.stringify(message);
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  const fragment = (index, data = json.slice(index ? 1 : 0, index ? undefined : 1)) => ({
    id: `f-${index}`, runId: null, role: "assistant", type: "text",
    payload: { encoding: "gateway-message-json-utf8", sha256: hash, data },
    createdAt: 100, fragment: { messageId: "m", index, count: 2 },
  });
  for (const values of [[fragment(0), fragment(0)], [fragment(0), fragment(1, "tampered")]]) {
    const { backend } = await readyBackend(() => page("messages", values));
    await assert.rejects(() => backend.getHistory(`agent:shoggoth-default:${SESSION_A}`), /Shoggoth/);
  }
  const { backend } = await readyBackend(() => page("messages", [], "same"));
  await assert.rejects(() => backend.getHistory(`agent:shoggoth-default:${SESSION_A}`), /Shoggoth/);
});

test("history enforces its total budget while pages are accumulated", async () => {
  let historyCalls = 0;
  const largeText = "x".repeat(40 * 1024);
  const { backend } = await readyBackend((request) => {
    historyCalls += 1;
    const id = `large-${historyCalls}`;
    return page("messages", [historyItem({
      id, role: "assistant", content: [{ type: "text", text: largeText }],
    }, { id: `history-${historyCalls}` })], `cursor-${historyCalls}`);
  }, { maxPages: 1000 });
  await assert.rejects(
    () => backend.getHistory(`agent:shoggoth-default:${SESSION_A}`),
    (error) => error.code === "CHAT_HISTORY_TOO_LARGE",
  );
  assert.equal(historyCalls < 240, true, "must fail near 8MiB rather than retaining every page");
});

test("send streams cumulative hooks, preserves cursor over a transient failure, and terminates exactly once", async () => {
  let subscribeCalls = 0;
  const delays = [];
  const { backend, calls } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) return subscription([
        event(1, "text.delta", { delta: "Hel" }),
        event(2, "reasoning.delta", { delta: "why" }),
      ], { nextCursor: 2, latestSeq: 4, hasMore: true });
      if (subscribeCalls === 2) throw Object.assign(new Error("socket token=private"), { code: "SERVICE_DISCONNECTED" });
      return subscription([
        event(3, "text.delta", { delta: "lo" }),
        event(4, "terminal", { status: "completed", resultSummary: "Hello", errorCode: null }),
      ], { cursor: 2, nextCursor: 4, latestSeq: 4 });
    }
    throw new Error(`unexpected ${request.method}`);
  }, { delay: async (ms) => { delays.push(ms); } });
  const seen = { delta: [], thinking: [], final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", undefined, {
    delta: (value) => seen.delta.push(value),
    thinking: (value) => seen.thinking.push(value),
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  assert.deepEqual(seen, {
    delta: ["Hel", "Hello"],
    thinking: ["why"],
    final: [["Hello", false, { runId: "run-1" }]],
    error: [],
  });
  assert.equal(backend.getSessionRows()[0].derivedTitle, "hi");
  assert.equal(delays.length >= 1, true);
  assert.equal(
    calls.find((entry) => entry.request.method === "chat.send").requestOptions.timeoutMs,
    15_000,
    "chat.send 必须比 8 秒外置加密预算更长，避免首次持久化尚未收敛就由 UI 报超时",
  );
  const cursors = calls.filter((entry) => entry.request.method === "run.subscribe")
    .map((entry) => entry.request.params.afterSeq);
  assert.deepEqual(cursors, [0, 2, 2]);
});

test("a transient status probe cannot cancel an active send before its terminal event", async () => {
  let subscribeCalls = 0;
  let statusCalls = 0;
  let releaseTerminal;
  let markTerminalSubscriptionStarted;
  const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
  const terminalSubscriptionStarted = new Promise((resolve) => {
    markTerminalSubscriptionStarted = resolve;
  });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "text.delta", { delta: "partial" }),
        ], { nextCursor: 1, latestSeq: 2 });
      }
      markTerminalSubscriptionStarted();
      await terminalGate;
      return subscription([
        event(2, "terminal", {
          status: "completed", resultSummary: "partial", errorCode: null,
        }),
      ], { cursor: 1, nextCursor: 2, latestSeq: 2 });
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      if (statusCalls === 2) {
        throw Object.assign(new Error("transient status timeout"), { code: "REQUEST_TIMEOUT" });
      }
      return readyStatus(true);
    },
  });
  const generation = backend._generation;
  const seen = { delta: [], final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    delta: (value) => seen.delta.push(value),
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await terminalSubscriptionStarted;
  const status = await backend.getStatus();
  releaseTerminal();
  await sending;

  assert.equal(status.connected, true);
  assert.equal(backend._generation, generation);
  assert.deepEqual(seen, {
    delta: ["partial"],
    final: [["partial", false, { runId: "run-1" }]],
    error: [],
  });
});

test("an accepted run reconnects after backend generation recovery instead of reporting unavailable", async () => {
  let statusCalls = 0;
  let subscribeCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const { backend, calls } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        markSubscriptionStarted();
        await subscriptionGate;
        return subscription([
          event(1, "text.delta", { delta: "stale partial" }),
        ], { nextCursor: 1, latestSeq: 1 });
      }
      return subscription([
        event(1, "text.delta", { delta: "Recovered answer" }),
        event(2, "terminal", {
          status: "completed", resultSummary: "Recovered answer", errorCode: null,
        }),
      ], { nextCursor: 2, latestSeq: 2 });
    }
    if (request.method === "run.get") return { run: run("running") };
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { delta: [], final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    delta: (value) => seen.delta.push(value),
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await subscriptionStarted;
  const status = await backend.getStatus();
  releaseSubscription();
  await sending;

  assert.equal(status.connected, false);
  assert.equal(subscribeCalls, 2);
  assert.equal(calls.some((entry) => entry.request.method === "run.get"), true);
  assert.deepEqual(seen, {
    delta: ["Recovered answer"],
    final: [["Recovered answer", false, { runId: "run-1" }]],
    error: [],
  });
});

test("an accepted run can finish while backend write readiness is still recovering", async () => {
  let statusCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      markSubscriptionStarted();
      await subscriptionGate;
      return subscription([], { latestSeq: 0 });
    }
    if (request.method === "run.get") {
      return { run: run("completed", { resultSummary: "Completed while recovering" }) };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls === 1);
    },
    readinessMaxAttempts: 1,
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await subscriptionStarted;
  const status = await backend.getStatus();
  releaseSubscription();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, [["Completed while recovering", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("transient subscribe loss reconciles the accepted run before resuming its stream", async () => {
  let subscribeCalls = 0;
  let runGets = 0;
  const cursors = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      cursors.push(request.params.afterSeq);
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "text.delta", { delta: "Durable " }),
        ], { nextCursor: 1, latestSeq: 2 });
      }
      if (subscribeCalls === 2) {
        throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
      }
      return subscription([
        event(2, "text.delta", { delta: "answer" }),
        event(3, "terminal", {
          status: "completed", resultSummary: "Durable answer", errorCode: null,
        }),
      ], { cursor: 1, nextCursor: 3, latestSeq: 3 });
    }
    if (request.method === "run.get") {
      runGets += 1;
      return { run: run("running") };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.equal(runGets, 1);
  assert.equal(subscribeCalls, 3);
  assert.deepEqual(cursors, [0, 1, 1]);
  assert.deepEqual(seen.final, [["Durable answer", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("persistent subscribe failures back off across successful run reconciliations", async () => {
  let subscribeCalls = 0;
  let runGets = 0;
  const delays = [];
  const controller = new AbortController();
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 4) controller.abort();
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      runGets += 1;
      return { run: run("running") };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    maxPollErrors: 1,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {}, {
    signal: controller.signal,
  });

  assert.equal(subscribeCalls, 4);
  assert.equal(runGets, 3);
  assert.deepEqual(delays, [25, 50, 100]);
});

test("a terminal run found during observer reconciliation keeps its real failure", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      return { run: run("failed", { errorCode: "MODEL_FAILED" }) };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.deepEqual(seen.final, []);
  assert.deepEqual(seen.error, ["Shoggoth 任务未完成 (MODEL_FAILED)"]);
});

test("a completed run found during reconciliation replaces partial text with durable history", async () => {
  let subscribeCalls = 0;
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "text.delta", { delta: "Partial" }),
        ], { nextCursor: 1, latestSeq: 2 });
      }
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      return { run: run("completed", { resultSummary: "durable summary" }) };
    }
    if (request.method === "chat.history") {
      return page("messages", [historyItem({
        id: "assistant-history", role: "assistant",
        content: [{ type: "text", text: "Complete durable answer" }],
      })]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.deepEqual(seen.final, [["Complete durable answer", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("a stream reset forces completed text to come from durable run history", async () => {
  let subscribeCalls = 0;
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "text.delta", { delta: "prefix" }),
        ], { nextCursor: 1, latestSeq: 1 });
      }
      if (subscribeCalls === 2) {
        return {
          runId: "run-1", streamId: STREAM_B, events: [], cursor: 2, nextCursor: 2,
          hasMore: false, baseSeq: 1, latestSeq: 2,
          gap: {
            code: "STREAM_RESET", requestedStreamId: STREAM_A, currentStreamId: STREAM_B,
            requestedAfterSeq: 1, baseSeq: 1, latestSeq: 2,
          },
          snapshot: { run: run("running", { eventSeq: 2 }) },
        };
      }
      return {
        runId: "run-1", streamId: STREAM_B,
        events: [{
          ...event(3, "terminal", {
            status: "completed", resultSummary: "prefix + lost suffix", errorCode: null,
          }),
          streamId: STREAM_B,
        }],
        cursor: 2, nextCursor: 3, hasMore: false, baseSeq: 1, latestSeq: 3,
        gap: null, snapshot: null,
      };
    }
    if (request.method === "chat.history") {
      return page("messages", [historyItem({
        id: "assistant-run-1", role: "assistant",
        content: [{ type: "text", text: "prefix + lost suffix" }],
      })]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.deepEqual(seen.final, [["prefix + lost suffix", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("terminal reconciliation selects durable history from the exact completed run", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      return { run: run("completed", { resultSummary: "old run summary" }) };
    }
    if (request.method === "chat.history") {
      return page("messages", [
        historyItem({
          id: "assistant-old", role: "assistant",
          content: [{ type: "text", text: "old run answer" }],
        }),
        historyItem({
          id: "assistant-new", role: "assistant",
          content: [{ type: "text", text: "new run answer" }],
        }, { id: "history-2", runId: "run-2", createdAt: 200 }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.deepEqual(seen.final, [["old run answer", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("consumer abort during accepted-run reconciliation stays silent", async () => {
  let releaseRunGet;
  let markRunGetStarted;
  const runGetGate = new Promise((resolve) => { releaseRunGet = resolve; });
  const runGetStarted = new Promise((resolve) => { markRunGetStarted = resolve; });
  const controller = new AbortController();
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      markRunGetStarted();
      await runGetGate;
      return { run: run("running") };
    }
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  }, { signal: controller.signal });
  await runGetStarted;
  controller.abort();
  releaseRunGet();
  await sending;

  assert.deepEqual(seen, { final: [], error: [] });
});

test("consumer abort does not wait for the shared backend recovery cycle", async () => {
  let statusCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  let releaseRecovery;
  let markRecoveryStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const recoveryStarted = new Promise((resolve) => { markRecoveryStarted = resolve; });
  const controller = new AbortController();
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      markSubscriptionStarted();
      await subscriptionGate;
      throw Object.assign(new Error("observer disconnected"), { code: "SERVICE_DISCONNECTED" });
    }
    if (request.method === "run.get") {
      throw Object.assign(new Error("run lookup unavailable"), { code: "SERVICE_UNAVAILABLE" });
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    maxPollErrors: 1,
    serviceStatus: async () => {
      statusCalls += 1;
      if (statusCalls === 1) return readyStatus(true);
      if (statusCalls === 2) return readyStatus(false);
      markRecoveryStarted();
      await recoveryGate;
      return readyStatus(true);
    },
  });
  const seen = { final: [], error: [] };
  let settled = false;
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  }, { signal: controller.signal }).finally(() => { settled = true; });
  await subscriptionStarted;
  await backend.getStatus();
  await recoveryStarted;
  releaseSubscription();
  await waitForCondition(() => backend._state === "recovering");
  controller.abort();
  await waitForCondition(() => settled);

  assert.deepEqual(seen, { final: [], error: [] });
  releaseRecovery();
  await sending;
  assert.equal(await backend.start(), true);
});

test("generation recovery preserves an already delivered approval response", async () => {
  let statusCalls = 0;
  let subscribeCalls = 0;
  let releaseSecond;
  let markSecondStarted;
  let releaseThird;
  let markThirdStarted;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const thirdGate = new Promise((resolve) => { releaseThird = resolve; });
  const thirdStarted = new Promise((resolve) => { markThirdStarted = resolve; });
  const controller = new AbortController();
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "approval", {
            requestId: "request-1", kind: "command", reason: "Approve recovery",
          }),
        ], { nextCursor: 1, latestSeq: 1 });
      }
      if (subscribeCalls === 2) {
        markSecondStarted();
        await secondGate;
        return subscription([], { cursor: 1, nextCursor: 1, latestSeq: 1 });
      }
      markThirdStarted();
      await thirdGate;
      return subscription([], { cursor: 1, nextCursor: 1, latestSeq: 1 });
    }
    if (request.method === "run.get") {
      return { run: run("waiting_approval", { waitingRequestId: "request-1" }) };
    }
    if (request.method === "run.approval.respond") {
      return { requestId: "request-1", state: "responded", run: run("running") };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const prompts = [];
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    prompt: (value) => prompts.push(value),
  }, { signal: controller.signal });
  await waitForCondition(() => prompts.length === 1);
  await secondStarted;
  await backend.getStatus();
  releaseSecond();
  await thirdStarted;

  assert.equal(backend._promptByRequest.size, 1);
  await backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_A}`, {
    requestId: "request-1", choice: "once",
  });
  controller.abort();
  releaseThird();
  await sending;
});

test("generation recovery expires a prompt already resolved by another client", async () => {
  let statusCalls = 0;
  let subscribeCalls = 0;
  let releaseSecond;
  let markSecondStarted;
  let releaseThird;
  let markThirdStarted;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const thirdGate = new Promise((resolve) => { releaseThird = resolve; });
  const thirdStarted = new Promise((resolve) => { markThirdStarted = resolve; });
  const controller = new AbortController();
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      subscribeCalls += 1;
      if (subscribeCalls === 1) {
        return subscription([
          event(1, "approval", {
            requestId: "request-1", kind: "command", reason: "Approve recovery",
          }),
        ], { nextCursor: 1, latestSeq: 1 });
      }
      if (subscribeCalls === 2) {
        markSecondStarted();
        await secondGate;
        return subscription([], { cursor: 1, nextCursor: 1, latestSeq: 1 });
      }
      markThirdStarted();
      await thirdGate;
      return subscription([], { cursor: 1, nextCursor: 1, latestSeq: 1 });
    }
    if (request.method === "run.get") return { run: run("running") };
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const prompts = [];
  const expired = [];
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    prompt: (value) => prompts.push(value),
    promptExpire: (value) => expired.push(value),
  }, { signal: controller.signal });
  await waitForCondition(() => prompts.length === 1);
  await secondStarted;
  await backend.getStatus();
  releaseSecond();
  await thirdStarted;

  assert.deepEqual(expired, [{ requestId: "request-1" }]);
  assert.equal(backend._promptByRequest.size, 0);
  controller.abort();
  releaseThird();
  await sending;
});

test("a resumed status expires the exact prompt resolved by another observer", async () => {
  const { backend } = await readyBackend(() => { throw new Error("unexpected request"); });
  const expired = [];
  const context = {
    sessionKey: SESSION_A,
    run: run("waiting_approval"),
    hooks: { promptExpire: (value) => expired.push(value) },
  };
  const state = { text: "", reasoning: "", settled: false, lastStatus: "waiting_approval" };
  await backend._consumeEvent(context, state, event(1, "approval", {
    requestId: "request-1", kind: "command", reason: "Approve",
  }));
  await backend._consumeEvent(context, state, event(2, "status", {
    status: "running", requestId: "request-1",
  }));

  assert.deepEqual(expired, [{ requestId: "request-1" }]);
  assert.equal(backend._promptByRequest.size, 0);
});

test("an authoritative not-ready status still settles a returned completed terminal exactly once", async () => {
  let statusCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const { backend, calls } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      markSubscriptionStarted();
      await subscriptionGate;
      return subscription([
        event(1, "text.delta", { delta: "from returned page" }),
        event(2, "terminal", { status: "completed", resultSummary: "summary", errorCode: null }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await subscriptionStarted;
  const status = await backend.getStatus();
  releaseSubscription();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, [["from returned page", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
  assert.equal(calls.some((entry) => entry.request.method === "chat.history"), false);
});

test("a completed terminal remains final when generation changes during history fallback", async () => {
  let statusCalls = 0;
  let releaseHistory;
  let markHistoryStarted;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const historyStarted = new Promise((resolve) => { markHistoryStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      return subscription([
        event(1, "terminal", {
          status: "completed", resultSummary: "durable summary", errorCode: null,
        }),
      ]);
    }
    if (request.method === "chat.history") {
      markHistoryStarted();
      await historyGate;
      return page("messages", [historyItem({
        id: "assistant-history", role: "assistant",
        content: [{ type: "text", text: "stale history text" }],
      })]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await historyStarted;
  const status = await backend.getStatus();
  releaseHistory();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, [["durable summary", false, { runId: "run-1" }]]);
  assert.deepEqual(seen.error, []);
});

test("consumer abort stays silent when it arrives during completed-terminal history fallback", async () => {
  let releaseHistory;
  let markHistoryStarted;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const historyStarted = new Promise((resolve) => { markHistoryStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      return subscription([
        event(1, "terminal", {
          status: "completed", resultSummary: "durable summary", errorCode: null,
        }),
      ]);
    }
    if (request.method === "chat.history") {
      markHistoryStarted();
      await historyGate;
      return page("messages", [historyItem({
        id: "assistant-history", role: "assistant",
        content: [{ type: "text", text: "history text" }],
      })]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const controller = new AbortController();
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  }, { signal: controller.signal });
  await historyStarted;
  controller.abort();
  releaseHistory();
  await sending;

  assert.deepEqual(seen, { final: [], error: [] });
});

test("an authoritative not-ready status still settles a returned failed terminal exactly once", async () => {
  let statusCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      markSubscriptionStarted();
      await subscriptionGate;
      return subscription([
        event(1, "terminal", {
          status: "failed", resultSummary: null, errorCode: "MODEL_FAILED",
        }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await subscriptionStarted;
  const status = await backend.getStatus();
  releaseSubscription();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, []);
  assert.deepEqual(seen.error, ["Shoggoth 任务未完成 (MODEL_FAILED)"]);
});

test("a generation change rejects a returned terminal bound to another run", async () => {
  let statusCalls = 0;
  let releaseSubscription;
  let markSubscriptionStarted;
  const subscriptionGate = new Promise((resolve) => { releaseSubscription = resolve; });
  const subscriptionStarted = new Promise((resolve) => { markSubscriptionStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      markSubscriptionStarted();
      await subscriptionGate;
      const foreignTerminal = event(1, "terminal", {
        status: "completed", resultSummary: "foreign", errorCode: null,
      });
      foreignTerminal.runId = "run-foreign";
      return { ...subscription([foreignTerminal]), runId: "run-foreign" };
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await subscriptionStarted;
  const status = await backend.getStatus();
  releaseSubscription();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, []);
  assert.equal(seen.error.length, 1);
  assert.match(seen.error[0], /CHAT_RESPONSE_INVALID/u);
});

test("an authoritative not-ready status settles a send that is still awaiting chat.send", async () => {
  let statusCalls = 0;
  let releaseSend;
  let markSendStarted;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  const { backend } = await readyBackend(async (request) => {
    if (request.method === "chat.send") {
      markSendStarted();
      await sendGate;
      throw Object.assign(new Error("late send failure"), { code: "SERVICE_UNAVAILABLE" });
    }
    throw new Error(`unexpected ${request.method}`);
  }, {
    serviceStatus: () => {
      statusCalls += 1;
      return readyStatus(statusCalls !== 2);
    },
  });
  const seen = { final: [], error: [] };
  const sending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });
  await sendStarted;
  const status = await backend.getStatus();
  releaseSend();
  await sending;

  assert.equal(status.connected, false);
  assert.deepEqual(seen.final, []);
  assert.equal(seen.error.length, 1);
  assert.match(seen.error[0], /SERVICE_UNAVAILABLE/u);
});

test("send exposes at most one terminal hook when a malformed interaction precedes terminal", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") {
      return { disposition: "started", reason: null, run: run() };
    }
    if (request.method === "run.subscribe") {
      return subscription([
        event(1, "approval", { requestId: "" }),
        event(2, "terminal", {
          status: "completed", resultSummary: "done", errorCode: null,
        }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const seen = { final: [], error: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  });

  assert.deepEqual(seen.final, []);
  assert.deepEqual(seen.error, ["交互请求格式不兼容，请重新发起"]);
});

test("only one consecutive status timeout preserves a started snapshot", async () => {
  let statusCalls = 0;
  const { backend } = await readyBackend(() => { throw new Error("unexpected request"); }, {
    readinessMaxAttempts: 1,
    serviceStatus: () => {
      statusCalls += 1;
      if (statusCalls === 1 || statusCalls === 3) return readyStatus(true);
      throw Object.assign(new Error("status timeout"), { code: "REQUEST_TIMEOUT" });
    },
  });
  const generation = backend._generation;

  assert.equal((await backend.getStatus()).connected, true);
  assert.equal((await backend.getStatus()).connected, true);
  assert.equal((await backend.getStatus()).connected, true);
  assert.equal(backend._generation, generation);
  assert.equal((await backend.getStatus()).connected, false);
  assert.ok(backend._generation > generation);
  await backend.stop();
});

test("send derives a session-bound stable Service operationId from the client idempotency key", async () => {
  const value = fakeBackend((request) => {
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", [session(SESSION_A), session(SESSION_B)]);
    }
    if (request.method === "chat.send") {
      return {
        disposition: "started",
        reason: null,
        run: run("running", {
          sourceId: request.params.sessionKey,
          idempotencyKey: request.params.operationId,
        }),
      };
    }
    if (request.method === "run.subscribe") {
      return subscription([
        event(1, "terminal", { status: "completed", resultSummary: "done", errorCode: null }),
      ]);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await value.backend.start(), true);
  value.calls.length = 0;
  const { backend, calls } = value;
  const clientKey = "client-send-idempotency-0001";
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "same", clientKey, {});
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "same", clientKey, {});
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_B}`, "same", clientKey, {});
  const operationIds = calls.filter((entry) => entry.request.method === "chat.send")
    .map((entry) => entry.request.params.operationId);
  assert.equal(operationIds.length, 3);
  assert.equal(operationIds[0], operationIds[1]);
  assert.notEqual(operationIds[0], operationIds[2]);
  assert.match(operationIds[0], /^send-[0-9a-f]{64}$/u);
  assert.equal(operationIds[0].includes(clientKey), false, "client key 不应原样扩散到日志/状态");
});

test("completed text does not duplicate a delta and commentary seals before the final segment", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") return subscription([
      event(1, "text.delta", { delta: "note" }),
      event(2, "text", { text: "note", phase: "commentary" }),
      event(3, "text.delta", { delta: "answer" }),
      event(4, "text", { text: "answer", phase: "final_answer" }),
      event(5, "terminal", { status: "completed", resultSummary: "answer", errorCode: null }),
    ], { nextCursor: 5, latestSeq: 5 });
    throw new Error(`unexpected ${request.method}`);
  });
  const seen = { delta: [], interim: [], final: [] };
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    delta: (value) => seen.delta.push(value),
    interim: (value) => seen.interim.push(value),
    final: (value) => seen.final.push(value),
  });
  assert.deepEqual(seen, { delta: ["note", "answer"], interim: ["note"], final: ["answer"] });
});

test("hook exceptions are isolated and a throwing final never turns into a second error", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") return subscription([
      event(1, "text.delta", { delta: "answer" }),
      event(2, "terminal", { status: "completed", resultSummary: "answer", errorCode: null }),
    ], { nextCursor: 2, latestSeq: 2 });
    throw new Error(`unexpected ${request.method}`);
  });
  let errors = 0;
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    delta: () => { throw new Error("consumer delta failed"); },
    final: () => { throw new Error("consumer final failed"); },
    error: () => { errors += 1; },
  });
  assert.equal(errors, 0);
});

test("tool prefers its explicit name/safe display fields and incremental plan text remains visible", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") return subscription([
      event(1, "tool.start", {
        itemId: "tool-1", toolCallId: "tool-1",
        tool: { kind: "mcpToolCall", name: "linear.create", displayArgs: { title: "T" }, status: "inProgress" },
      }),
      event(2, "tool.result", {
        itemId: "tool-1", toolCallId: "tool-1",
        tool: {
          kind: "mcpToolCall", name: "linear.create", status: "completed",
          resultSummary: "Issue created", durationMs: 420,
        },
      }),
      event(3, "plan", {
        plan: [{ step: "Inspect repository", status: "inProgress" }],
        delta: "Apply fix",
      }),
      event(4, "terminal", { status: "completed", resultSummary: "done", errorCode: null }),
    ], { nextCursor: 4, latestSeq: 4 });
    if (request.method === "chat.history") return page("messages", []);
    throw new Error(`unexpected ${request.method}`);
  });
  const tools = [];
  const plans = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    tool: (value) => tools.push(value),
    plan: (value) => plans.push(value),
    final: () => {},
  });
  assert.equal(tools[0].name, "linear.create");
  assert.deepEqual(tools[0].args, { title: "T" });
  assert.equal(tools[1].result, "Issue created");
  assert.equal(tools[1].durationS, 0.42);
  assert.deepEqual(plans, [[
    { content: "Inspect repository", status: "in_progress" },
    { content: "Apply fix", status: "in_progress" },
  ]]);
});

test("tool result without a useful summary does not repeat terminal status as gray detail", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") return subscription([
      event(1, "tool.start", {
        itemId: "tool-blank", toolCallId: "tool-blank",
        tool: { kind: "search", name: "Web search:", displayArgs: { query: "agent trajectory" }, status: "in_progress" },
      }),
      event(2, "tool.result", {
        itemId: "tool-blank", toolCallId: "tool-blank",
        tool: { kind: "search", name: "Web search:", status: "completed", success: true },
      }),
      event(3, "terminal", { status: "completed", resultSummary: "done", errorCode: null }),
    ], { nextCursor: 3, latestSeq: 3 });
    if (request.method === "chat.history") return page("messages", []);
    throw new Error(`unexpected ${request.method}`);
  });
  const tools = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    tool: (value) => tools.push(value),
    final: () => {},
  });
  assert.deepEqual(tools[0].args, { query: "agent trajectory" });
  assert.equal(tools[1].result, undefined);
});

test("native lifecycle noise is hidden while real context compaction remains visible", async () => {
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") return subscription([
      event(1, "status", { status: "running" }),
      event(2, "status", { status: "inProgress" }),
      event(3, "status", { status: "compacting" }),
      event(4, "status", { status: "compacted" }),
      event(5, "terminal", { status: "completed", resultSummary: "done", errorCode: null }),
    ], { nextCursor: 5, latestSeq: 5 });
    if (request.method === "chat.history") return page("messages", []);
    throw new Error(`unexpected ${request.method}`);
  });
  const statuses = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    status: (value) => statuses.push(value),
    final: () => {},
  });
  assert.deepEqual(statuses, [
    { kind: "compacting", text: "compacting" },
    { kind: "compacted", text: "compacted" },
  ]);
});

test("STREAM_RESET consumes its snapshot without duplicating live events and terminal history can fill missing text", async () => {
  const terminal = run("completed", { resultSummary: null, eventSeq: 9 });
  const finalMessage = { id: "answer", role: "assistant", content: [{ type: "text", text: "Recovered answer" }] };
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "completed", reason: null, run: terminal };
    if (request.method === "run.subscribe") return {
      runId: "run-1", streamId: STREAM_A, events: [], cursor: 0, nextCursor: 0,
      hasMore: false, baseSeq: 0, latestSeq: 0,
      gap: {
        code: "STREAM_RESET", requestedStreamId: null, currentStreamId: STREAM_A,
        requestedAfterSeq: 0, baseSeq: 0, latestSeq: 0,
      },
      snapshot: { run: terminal },
    };
    if (request.method === "chat.history") return page("messages", [historyItem(finalMessage)]);
    throw new Error(`unexpected ${request.method}`);
  });
  const finals = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => finals.push(args),
  });
  assert.deepEqual(finals, [["Recovered answer", false, { runId: "run-1" }]]);
});

test("approval and MCP input responses use active run/request and value only for one question", async () => {
  const requests = [];
  const { backend } = await readyBackend((request) => {
    requests.push(request);
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run("waiting_input") };
    if (request.method === "run.subscribe") return subscription([
      event(1, "prompt", {
        requestId: "request-1", kind: "mcp_elicitation", message: "Choose",
        requestedSchema: { type: "object", properties: { answer: { type: "string", title: "Answer" } }, required: ["answer"] },
      }),
    ], { nextCursor: 1, latestSeq: 1 });
    if (request.method === "run.input.respond") return {
      requestId: "request-1", state: "responded", run: run("running", { eventSeq: 2 }),
    };
    throw Object.assign(new Error("stop polling"), { code: "SERVICE_UNAVAILABLE" });
  }, { maxPollErrors: 1 });
  const controller = new AbortController();
  const pending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    prompt: () => controller.abort(),
  }, { signal: controller.signal });
  await pending;
  await backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_A}`, {
    requestId: "request-1", action: "submit", answers: { answer: "yes" },
  });
  assert.deepEqual(requests.find((request) => request.method === "run.input.respond").params.answers, { answer: "yes" });
});

test("MCP prompt questions preserve schema id/type/options/title/description/required metadata", async () => {
  const controller = new AbortController();
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run("waiting_input") };
    if (request.method === "run.subscribe") return subscription([
      event(1, "prompt", {
        requestId: "schema-request", kind: "mcp_elicitation", message: "Configure",
        requestedSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              title: "Project",
              description: "Choose a project\nAlpha: First project\nBeta: Second project",
              enum: ["alpha", "beta"],
              enumNames: ["Alpha", "Beta"],
            },
            note: { type: "string", title: "Note", description: "Optional note" },
          },
          required: ["project"],
        },
      }),
    ], { nextCursor: 1, latestSeq: 1 });
    throw new Error(`unexpected ${request.method}`);
  });
  const prompts = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    prompt: (value) => { prompts.push(value); controller.abort(); },
  }, { signal: controller.signal });
  assert.deepEqual(prompts[0].fields, [
    {
      id: "project",
      type: "choice",
      label: "Project",
      description: "Choose a project",
      required: true,
      secret: false,
      options: [
        { value: "alpha", label: "Alpha", description: "First project" },
        { value: "beta", label: "Beta", description: "Second project" },
      ],
    },
    {
      id: "note",
      type: "text",
      label: "Note",
      description: "Optional note",
      required: false,
      secret: false,
      options: [],
    },
  ]);
});

test("empty-schema MCP tool permission fallback is exact and per-request only", async () => {
  const requests = [];
  const value = fakeBackend((request) => {
    requests.push(request);
    if (request.method === "profile.list") return page("profiles", [profile()]);
    if (request.method === "chat.session.list") {
      return page("sessions", [session(), session(SESSION_B)]);
    }
    if (request.method === "run.input.respond") return {
      requestId: request.params.requestId,
      state: "responded",
      run: run("running", { id: request.params.runId, sourceId: SESSION_A, eventSeq: 2 }),
    };
    throw new Error(`unexpected ${request.method}`);
  });
  assert.equal(await value.backend.start(), true);
  value.calls.length = 0;
  const keyA = `agent:shoggoth-default:${SESSION_A}`;
  const prompts = [];
  const context = (sessionKey, runId) => ({
    key: `agent:shoggoth-default:${sessionKey}`,
    sessionKey,
    run: run("waiting_input", { id: runId, sourceId: sessionKey }),
    hooks: { prompt: (promptValue) => prompts.push(promptValue) },
  });
  const state = () => ({ text: "", reasoning: "", settled: false, lastStatus: null });
  const permission = (requestId, toolName = "external_agent_run", message = null) => ({
    runId: "ignored", streamId: STREAM_A, seq: 1, type: "prompt",
    payload: {
      requestId,
      method: "mcpServer/elicitation/request",
      kind: "mcp_elicitation",
      serverName: "shoggoth",
      mode: "form",
      message: message || `Allow the shoggoth MCP server to run tool "${toolName}"?`,
      requestedSchema: { type: "object", properties: {}, required: [] },
    },
  });

  await value.backend._consumeEvent(context(SESSION_A, "run-a1"), state(), permission("permission-a1"));
  assert.deepEqual(prompts[0], {
    version: 1,
    requestId: "permission-a1",
    runId: "run-a1",
    kind: "mcp_permission",
    title: "工具授权",
    message: "允许 shoggoth MCP 运行工具“external_agent_run”？",
    fields: [],
    approvalChoices: ["once", "deny"],
    approvalDetails: { serverName: "shoggoth", toolName: "external_agent_run" },
    expiresAt: null,
  });
  await value.backend.respondChatPrompt(keyA, {
    requestId: "permission-a1", choice: "once",
  });
  const firstResponse = requests.find((request) => request.method === "run.input.respond");
  assert.deepEqual({ action: firstResponse.params.action, answers: firstResponse.params.answers }, {
    action: "submit", answers: {},
  });

  await value.backend._consumeEvent(context(SESSION_A, "run-a2"), state(), permission("permission-a2"));
  assert.equal(prompts.length, 2, "同一工具的新请求必须再次显式审核");
  assert.equal(requests.filter((request) => request.method === "run.input.respond").length, 1);

  await value.backend._consumeEvent(context(SESSION_A, "run-a3"), state(),
    permission("permission-other", "external_agent_file_write"));
  assert.deepEqual(prompts[2].approvalChoices, ["once", "deny"]);
  await assert.rejects(
    value.backend.respondChatPrompt(keyA, {
      requestId: "permission-other", choice: "session",
    }),
    (error) => error?.code === "RUN_INPUT_RESPONSE_INVALID",
  );
  await value.backend._consumeEvent(context(SESSION_B, "run-b1"), state(), permission("permission-b1"));
  assert.equal(prompts.length, 4, "工具变化或会话变化后必须重新审核");

  await value.backend._consumeEvent(context(SESSION_A, "run-malformed"), state(),
    permission("permission-malformed", "external_agent_run", "Allow everything"));
  assert.equal(prompts.length, 4, "非严格 permission message 不得生成可提交的伪交互");
  assert.equal(requests.filter((request) => request.method === "run.input.respond").length, 1);

  await value.backend.stop();
});

test("prompt timeout expires the exact card and reports an actionable error", async () => {
  const { backend } = await readyBackend(() => { throw new Error("unexpected request"); });
  const expired = [];
  const errors = [];
  backend._activeBySession.set(SESSION_A, {
    runId: "run-timeout", requestId: "permission-timeout", status: "waiting_input",
  });
  await backend._settleTerminal({
    key: `agent:shoggoth-default:${SESSION_A}`,
    sessionKey: SESSION_A,
    run: run("waiting_input", { id: "run-timeout" }),
    hooks: {
      promptExpire: (value) => expired.push(value),
      error: (value) => errors.push(value),
    },
    poll: { cancelled: false },
    generation: backend._generation,
  }, {
    text: "", reasoning: "", settled: false, lastStatus: "waiting_input",
  }, run("interrupted", {
    id: "run-timeout", waitingRequestId: null, errorCode: "CODEX_PROMPT_TIMEOUT",
  }));
  assert.deepEqual(expired, [{ requestId: "permission-timeout" }]);
  assert.deepEqual(errors, [
    "等待补充信息已超时（5 分钟）。任务已中断，请重新发送并及时完成输入",
  ]);
  assert.equal(backend._promptByRequest.size, 0);
});

test("Service 重启导致的任务中断显示明确重试提示", async () => {
  const { backend } = await readyBackend(() => { throw new Error("unexpected request"); });
  const errors = [];
  await backend._settleTerminal({
    key: `agent:shoggoth-default:${SESSION_A}`,
    sessionKey: SESSION_A,
    run: run("running", { id: "run-service-restarted" }),
    hooks: { error: (value) => errors.push(value) },
    poll: { cancelled: false },
    generation: backend._generation,
  }, {
    text: "", reasoning: "", settled: false, lastStatus: "running",
  }, run("interrupted", {
    id: "run-service-restarted", errorCode: "SERVICE_RESTARTED",
  }));
  assert.deepEqual(errors, ["Agent Service 已重启，本次任务已中断，请重试"]);
});

test("chat request failures distinguish archived inspiration and missing login without exposing raw errors", async () => {
  for (const [code, expected] of [
    ["INSPIRATION_ARCHIVED", "此会话关联的灵感已归档，请先在「灵感便签」中恢复它，或切换到普通聊天会话"],
    ["INSPIRATION_NOT_FOUND", "此会话关联的灵感已删除或不存在，历史记录仍可查看；请切换到普通聊天会话继续"],
    ["RUNTIME_AUTH_REQUIRED", "当前 Agent 尚未登录或登录已失效，请前往「设置」登录后重试"],
  ]) {
    let calls = 0;
    const { backend } = await readyBackend(request => {
      assert.equal(request.method, "chat.send");
      calls += 1;
      throw Object.assign(new Error("private raw diagnostic"), { code });
    });
    const errors = [];
    await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hello", "request-error", {
      error: message => errors.push(message),
    });
    assert.deepEqual(errors, [expected]);
    assert.equal(calls, 1);
  }
});

test("Runtime 启动阶段错误显示可操作信息而不是通用失败", async () => {
  const { backend } = await readyBackend(() => { throw new Error("unexpected request"); });
  const expected = new Map([
    ["RUNTIME_AUTH_REQUIRED", "当前 Agent 登录验证失败，请前往「设置」检查账号状态或重新登录后重试"],
    ["RUNTIME_PERMISSION_REQUIRED", "当前权限不允许 Agent 执行所需操作，请检查会话的工作区和权限设置后重试"],
    ["RUNTIME_APPROVAL_UNAVAILABLE", "Antigravity 的非交互模式无法弹出原生工具授权，本次操作已被拒绝；请检查权限设置，调整后可在当前会话重新发送"],
    ["RUNTIME_QUOTA_EXHAUSTED", "模型服务商返回额度不足，请核对当前登录账号、订阅和额度；确认可用后可在当前会话重试"],
    ["RUNTIME_ACCOUNT_BLOCKED", "模型服务商返回账号受限（account blocked），请前往服务商检查账号状态；解除限制或更换可用账号后重试"],
    ["RUNTIME_UPSTREAM_UNAVAILABLE", "Agent 上游服务暂时不可用，请稍后重试"],
    ["CODEX_SYSTEM_BINARY_NOT_FOUND", "未找到可执行的本机 Codex CLI，请先安装 Codex 并检查 PATH"],
    ["CODEX_RUNTIME_VERSION_MISMATCH", "Codex CLI 版本与当前 App 不兼容，请检查 CLI 与 App 版本"],
    ["CODEX_RUNTIME_VERSION_PROBE_FAILED", "无法读取 Codex CLI 版本，请检查本机安装与执行权限"],
    ["CODEX_SCHEMA_ERROR", "Codex 协议校验失败，请检查 CLI 与 App 的版本兼容性"],
    ["RUNTIME_TURN_FAILED", "Agent 本次任务执行失败，请重试；若持续失败，请在「设置」中检查登录状态"],
    ["RUNTIME_START_FAILED", "启动 Agent Runtime 失败，请重试；若持续失败，请检查 CLI 安装与登录状态"],
    ["RUNTIME_START_RUNTIME_ACQUIRE_FAILED", "获取 Agent Runtime 失败，请重试"],
    ["RUNTIME_START_PROCESS_SPAWN_FAILED", "启动 Agent Runtime 进程失败，请重试或检查 CLI 安装"],
    ["RUNTIME_START_BOOTSTRAP_ROLE_FAILED", "启动 Shoggoth Helper 失败，请重试或重启 App"],
    ["RUNTIME_START_RPC_INITIALIZE_FAILED", "初始化 Agent Runtime 通信失败，请重试"],
    ["RUNTIME_START_MCP_INITIALIZE_FAILED", "初始化 Shoggoth 工具失败，请重试或重启 App"],
    ["RUNTIME_START_SESSION_START_OR_RESUME_FAILED", "创建或恢复 Agent 会话失败，请重试"],
    ["RUNTIME_START_TURN_START_FAILED", "发送本次任务失败；为避免重复执行，未自动重放"],
    ["CODEX_START_FAILED", "启动 Codex Runtime 失败，请重试"],
    ["CODEX_TURN_FAILED", "Codex 本次任务执行失败，请重试；若持续失败，请在「设置」中检查登录状态"],
    ["CODEX_START_RUNTIME_ACQUIRE_FAILED", "获取 Agent Runtime 失败，请重试"],
    ["CODEX_START_PROCESS_SPAWN_FAILED", "启动 Codex 进程失败，请重试或检查安装完整性"],
    ["CODEX_START_BOOTSTRAP_ROLE_FAILED", "启动 Shoggoth Helper 失败，请重试或重启 App"],
    ["CODEX_START_RPC_INITIALIZE_FAILED", "初始化 Codex 通信失败，请重试"],
    ["CODEX_START_MCP_INITIALIZE_FAILED", "初始化 Shoggoth 工具失败，请重试或重启 App"],
    ["CODEX_START_SESSION_START_OR_RESUME_FAILED", "创建或恢复 Agent 会话失败，请重试"],
    ["CODEX_START_TURN_START_FAILED", "发送本次任务失败；为避免重复执行，未自动重放"],
  ]);
  for (const [errorCode, message] of expected) {
    const errors = [];
    await backend._settleTerminal({
      key: `agent:shoggoth-default:${SESSION_A}`,
      sessionKey: SESSION_A,
      run: run("starting", { id: `run-${errorCode}` }),
      hooks: { error: (value) => errors.push(value) },
      poll: { cancelled: false },
      generation: backend._generation,
    }, {
      text: "", reasoning: "", settled: false, lastStatus: "starting",
    }, run("failed", { id: `run-${errorCode}`, errorCode }));
    assert.deepEqual(errors, [message], errorCode);
  }
});

test("CURSOR_GAP and nonterminal STREAM_RESET restore waiting interaction state from snapshots", async () => {
  for (const kind of ["approval", "input"]) {
    let subscribeCalls = 0;
    const controller = new AbortController();
    const requests = [];
    const { backend } = await readyBackend((request) => {
      requests.push(request);
      if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
      if (request.method === "run.subscribe") {
        subscribeCalls += 1;
        if (kind === "input" && subscribeCalls === 1) return subscription([]);
        const recoveryCall = kind === "approval" ? 2 : 3;
        if (subscribeCalls === recoveryCall) {
          return subscription([kind === "approval"
            ? event(1, "approval", {
              requestId: "snapshot-request", kind: "command", reason: "Approve recovery",
            })
            : event(1, "prompt", {
              requestId: "snapshot-request",
              kind: "mcp_elicitation",
              message: "Recover answer",
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string", title: "Answer" } },
                required: ["answer"],
              },
            })], { nextCursor: 1, latestSeq: 1 });
        }
        const waiting = run(kind === "approval" ? "waiting_approval" : "waiting_input", {
          waitingRequestId: "snapshot-request", eventSeq: 3,
        });
        return kind === "approval" ? cursorGapSnapshot(waiting) : nonterminalStreamReset(waiting);
      }
      if (request.method === "run.approval.respond") return {
        requestId: "snapshot-request", state: "responded", run: run("running", { eventSeq: 4 }),
      };
      if (request.method === "run.input.respond") return {
        requestId: "snapshot-request", state: "responded", run: run("running", { eventSeq: 4 }),
      };
      throw new Error(`unexpected ${request.method}`);
    });
    const prompts = [];
    await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
      prompt: (value) => { prompts.push(value); controller.abort(); },
    }, { signal: controller.signal });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].requestId, "snapshot-request");
    if (kind === "approval") {
      await backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_A}`, {
        requestId: "snapshot-request", choice: "once",
      });
    } else {
      await backend.respondChatPrompt(`agent:shoggoth-default:${SESSION_A}`, {
        requestId: "snapshot-request", action: "submit", answers: { answer: "yes" },
      });
    }
    assert.equal(requests.some((request) => request.method === `run.${kind === "approval" ? "approval" : "input"}.respond`), true);
  }
});

test("transport failure, abort, delete and stop clear active/prompt runtime maps", async () => {
  const seen = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") throw Object.assign(new Error("offline"), { code: "SERVICE_DISCONNECTED" });
    if (request.method === "run.get") throw Object.assign(new Error("still offline"), { code: "SERVICE_DISCONNECTED" });
    throw new Error(`unexpected ${request.method}`);
  }, { maxPollErrors: 1 });
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    error: (value) => seen.push(value),
  });
  assert.deepEqual(seen, ["Shoggoth 请求失败 (SERVICE_DISCONNECTED)"]);
  assert.equal(backend._activeBySession.size, 0);
  assert.equal(backend._promptByRequest.size, 0);

  backend._activeBySession.set(SESSION_A, { runId: "run-1", status: "running" });
  backend._promptByRequest.set("request-1", { sessionKey: SESSION_A, runId: "run-1" });
  await backend.stop();
  assert.equal(backend._activeBySession.size, 0);
  assert.equal(backend._promptByRequest.size, 0);
});

test("all session operations fail closed when gateway agent and Service session ownership differ", async () => {
  const p2 = profile({ id: "profile-2", agentId: "shoggoth-two", name: "Two" });
  const calls = [];
  const { backend } = fakeBackend((request) => {
    calls.push(request.method);
    if (request.method === "profile.list") return page("profiles", [profile(), p2]);
    if (request.method === "chat.session.list") return page("sessions", request.params.profileId === p2.id
      ? [session(SESSION_B, { profileId: p2.id })] : [session()]);
    throw new Error("session operation must not reach Service");
  });
  await backend.start();
  const mismatched = `agent:shoggoth-default:${SESSION_B}`;
  const before = calls.length;
  for (const operation of [
    () => backend.getHistory(mismatched),
    () => backend.sendMessage(mismatched, "hi", null, {}),
    () => backend.renameSession(mismatched, "x"),
    () => backend.deleteSession(mismatched),
    () => backend.abortChat(mismatched),
    () => backend.steerChat(mismatched, "x"),
    () => backend.respondChatPrompt(mismatched, { kind: "approval", requestId: "r", choice: "once" }),
  ]) await assert.rejects(operation, /Shoggoth/);
  assert.equal(calls.length, before);
});

test("watchSession reconnects to an active run and local cancellation never aborts it", async () => {
  const methods = [];
  const controller = new AbortController();
  const active = run("waiting_approval", { waitingRequestId: "watch-request", eventSeq: 3 });
  const { backend } = await readyBackend((request) => {
    methods.push(request.method);
    if (request.method === "run.list") return page("runs", [active]);
    if (request.method === "run.subscribe") return cursorGapSnapshot(active);
    throw new Error(`unexpected ${request.method}`);
  });
  const prompts = [];
  await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
    prompt: (value) => { prompts.push(value); controller.abort(); },
  }, { signal: controller.signal });
  assert.equal(prompts[0].requestId, "watch-request");
  assert.equal(methods.includes("chat.abort"), false);
});

test("a new watcher replays an already-cached prompt card from an authoritative gap", async () => {
  let subscriptions = 0;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const waiting = run("waiting_approval", { waitingRequestId: "replay-request", eventSeq: 3 });
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.list") return page("runs", [waiting]);
    if (request.method === "run.subscribe") {
      subscriptions += 1;
      if (subscriptions === 1) return subscription([
        event(1, "approval", {
          requestId: "replay-request", kind: "command", command: "pwd", reason: "Need permission",
        }),
      ], { nextCursor: 1, latestSeq: 1 });
      return cursorGapSnapshot(waiting);
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const firstPrompts = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    prompt: (value) => { firstPrompts.push(value); firstController.abort(); },
  }, { signal: firstController.signal });
  assert.equal(firstPrompts.length, 1);
  assert.equal(backend._promptByRequest.size, 1);

  const replayed = [];
  await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
    prompt: (value) => { replayed.push(value); secondController.abort(); },
  }, { signal: secondController.signal });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].requestId, "replay-request");
  assert.equal(replayed[0].message, "Need permission");
  assert.equal(backend._promptByRequest.size, 1, "replay must not duplicate prompt cache");
});

test("watchSession emits immediate inFlight status even when the active stream is empty", async () => {
  const controller = new AbortController();
  let subscriptions = 0;
  const { backend } = await readyBackend((request) => {
    if (request.method === "run.list") return page("runs", [run("running")]);
    if (request.method === "run.subscribe") {
      subscriptions += 1;
      return subscription([]);
    }
    throw new Error(`unexpected ${request.method}`);
  }, { delay: async () => { controller.abort(); } });
  const statuses = [];
  await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
    status: (value) => statuses.push(value),
  }, { signal: controller.signal });
  assert.deepEqual(statuses, [{ kind: "running", text: "running" }]);
  assert.equal(subscriptions, 1);
});

test("a running CURSOR_GAP snapshot restores inFlight status for send observers", async () => {
  const controller = new AbortController();
  const { backend } = await readyBackend((request) => {
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run("running") };
    if (request.method === "run.subscribe") return cursorGapSnapshot(run("running", { eventSeq: 3 }));
    throw new Error(`unexpected ${request.method}`);
  }, { delay: async () => { controller.abort(); } });
  const statuses = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    status: (value) => statuses.push(value),
  }, { signal: controller.signal });
  assert.deepEqual(statuses, [{ kind: "running", text: "running" }]);
});

test("watchSession treats queued as controllable and keeps polling until its terminal event", async () => {
  const queued = run("queued", { resultSummary: null, eventSeq: 1 });
  let subscriptions = 0;
  const { backend } = await readyBackend((request) => {
    if (request.method === "run.list") return page("runs", [queued]);
    if (request.method === "run.subscribe") {
      subscriptions += 1;
      if (subscriptions === 1) return subscription([]);
      return subscription([
        event(1, "text.delta", { delta: "queued finished" }),
        event(2, "terminal", { status: "completed", resultSummary: "queued finished", errorCode: null }),
      ], { nextCursor: 2, latestSeq: 2 });
    }
    throw new Error(`unexpected ${request.method}`);
  });
  const finals = [];
  const statuses = [];
  await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
    final: (text) => finals.push(text),
    status: (value) => statuses.push(value),
  });
  assert.equal(subscriptions, 2);
  assert.deepEqual(statuses, [{ kind: "queued", text: "queued" }]);
  assert.deepEqual(finals, ["queued finished"]);
});

test("reopening a waiting session reads its current approval before a long historical event stream", async () => {
  for (const collide of [false, true]) {
    const controller = new AbortController();
    const active = run("waiting_approval", { waitingRequestId: "current-request", eventSeq: 300 });
    const subscriptions = [];
    const { backend } = await readyBackend(request => {
      if (request.method === "run.list") return page("runs", [active]);
      if (request.method === "run.subscribe") {
        subscriptions.push(request.params.streamId);
        if (request.params.streamId === null || (collide && subscriptions.length === 1)) {
          const streamId = request.params.streamId || STREAM_A;
          return { ...subscription([{ ...event(1, "approval", {
            requestId: "old-request", kind: "command", command: "old command",
          }), streamId }], { hasMore: true, latestSeq: 300 }), streamId };
        }
        return federationInteractionReset(request, active, {
          requestId: "current-request", kind: "command", command: "current command",
        }, collide ? subscriptions[0] : STREAM_A);
      }
      assert.fail(`Reopening must not invoke ${request.method}`);
    });
    const prompts = [];
    const errors = [];
    await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
      prompt: value => { prompts.push(value); controller.abort(); },
      error: message => errors.push(message),
    }, { signal: controller.signal });
    assert.deepEqual(errors, [], JSON.stringify(subscriptions));
    assert.deepEqual(prompts.map(value => value.requestId), ["current-request"]);
    assert.equal(subscriptions.length, collide ? 2 : 1);
  }
});

test("reopening does not revive an active run cached before the Service stopped", async () => {
  let subscriptions = 0;
  const { backend } = await readyBackend(request => {
    if (request.method === "run.list") return page("runs", []);
    if (request.method === "run.subscribe") subscriptions++;
    assert.fail(`Unexpected ${request.method}`);
  });
  backend._activeBySession.set(SESSION_A, { runId: "run-1", status: "waiting_approval",
    run: run("waiting_approval", { waitingRequestId: "old-request" }) });
  await backend.watchSession(`agent:shoggoth-default:${SESSION_A}`, {
    prompt: () => assert.fail("An expired approval must not return"),
    error: () => assert.fail("A historical terminal belongs to history"),
  });
  assert.equal(subscriptions, 0);
  assert.equal(backend._activeBySession.has(SESSION_A), false);
});

test("abortChat finds a queued run and sends its exact id to chat.abort", async () => {
  const queued = run("queued", { id: "run-queued", idempotencyKey: "idem-queued" });
  const aborts = [];
  const { backend } = await readyBackend((request) => {
    if (request.method === "run.list") return page("runs", [queued]);
    if (request.method === "chat.abort") {
      aborts.push(structuredClone(request.params));
      return { run: run("canceled", {
        id: "run-queued", idempotencyKey: "idem-queued",
        codexThreadId: null, codexTurnId: null, startedAt: null,
      }) };
    }
    throw new Error(`unexpected ${request.method}`);
  });
  await backend.abortChat(`agent:shoggoth-default:${SESSION_A}`);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].runId, "run-queued");
  assert.equal(aborts[0].sessionKey, SESSION_A);
});

test("abort is best-effort, while local cancellation and stop never call chat.abort", async () => {
  const methods = [];
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { backend } = await readyBackend(async (request) => {
    methods.push(request.method);
    if (request.method === "chat.send") return { disposition: "started", reason: null, run: run() };
    if (request.method === "run.subscribe") {
      await wait;
      return subscription([
        event(1, "terminal", { status: "completed", resultSummary: "done", errorCode: null }),
      ]);
    }
    if (request.method === "chat.abort") return { run: run("canceled") };
    if (request.method === "run.list") return page("runs", []);
    throw new Error(`unexpected ${request.method}`);
  });
  const controller = new AbortController();
  const seen = { final: [], error: [] };
  const pending = backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null, {
    final: (...args) => seen.final.push(args),
    error: (value) => seen.error.push(value),
  }, { signal: controller.signal });
  controller.abort();
  release();
  await pending;
  assert.deepEqual(seen, { final: [], error: [] });
  assert.equal(methods.includes("chat.abort"), false);
  await backend.abortChat(`agent:shoggoth-default:${SESSION_A}`);
  assert.equal(methods.includes("chat.abort"), true);
  await backend.stop();
});

test("malformed attachments cannot reach chat.send", async () => {
  const { backend, calls } = await readyBackend(() => { throw new Error("must not call"); });
  const before = calls.length;
  const errors = [];
  await backend.sendMessage(`agent:shoggoth-default:${SESSION_A}`, "hi", null,
    { error: message => errors.push(message) }, { attachments: [{ type: "image" }] });
  assert.match(errors[0], /附件无效/);
  assert.equal(calls.length, before);
  await backend.stop();
});
