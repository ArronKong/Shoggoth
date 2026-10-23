#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const ownedArtifactRoots = new Set();
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  MCP_PRODUCT_TOOL_DEFINITIONS,
  MCP_PRODUCT_TOOL_NAMES,
  McpProductToolController,
  fingerprintMcpToolCall,
  validateMcpProductToolArguments,
} = require(path.join(ROOT, "app", "agent-service", "mcp-product-tool-controller.js"));
const {
  PRODUCT_CAPABILITIES,
  SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS,
  productToolDescription,
  shoggothProductDeveloperInstructions,
} = require(path.join(ROOT, "app", "agent-service", "product-capability-manifest.js"));
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { NativeKanbanStore } = require(path.join(
  ROOT, "app", "agent-service", "native-kanban-store.js",
));
const { resolveServicePaths } = require(path.join(
  ROOT, "app", "agent-service", "paths.js",
));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("异步及旧同步联邦报告在 MCP 和 Host 均以 30 分钟为上限", () => {
  const { validateFederationParams } = require("../app/federation-host-protocol");
  const args = { backendId: "hermes", agentId: "bull", prompt: "report", timeoutMs: 600_000 };
  for (const timeoutMs of [5000, 600_000, 1_800_000]) {
    assert.equal(validateMcpProductToolArguments("federation_agent_run", { ...args, timeoutMs }), true);
    assert.equal(validateMcpProductToolArguments("external_agent_run", { ...args, timeoutMs }), true);
    assert.equal(validateMcpProductToolArguments("federation_agent_message", { handle: "fixture", message: "report", timeoutMs }), true);
    assert.equal(validateFederationParams("federation.run", { ...args, timeoutMs, operationId: `mcp-v1-${"a".repeat(48)}` }), true);
    assert.equal(validateFederationParams("agent.run", { ...args, timeoutMs, operationId: `mcp-v1-${"a".repeat(48)}` }), true);
  }
  for (const timeoutMs of [4999, 1_800_001, Infinity]) {
    assert.equal(validateMcpProductToolArguments("federation_agent_run", { ...args, timeoutMs }), false);
    assert.equal(validateMcpProductToolArguments("external_agent_run", { ...args, timeoutMs }), false);
    assert.equal(validateFederationParams("federation.run", { ...args, timeoutMs, operationId: `mcp-v1-${"a".repeat(48)}` }), false);
    assert.equal(validateFederationParams("agent.run", { ...args, timeoutMs, operationId: `mcp-v1-${"a".repeat(48)}` }), false);
  }
  for (const tool of ["federation_agent_run", "federation_agent_message"]) {
    assert.equal(MCP_PRODUCT_TOOL_DEFINITIONS.find(definition => definition.name === tool).inputSchema.properties.timeoutMs.maximum, 1_800_000);
  }
  // The federation workflow travels with the tool the model uses to dispatch.
  const instructions = MCP_PRODUCT_TOOL_DEFINITIONS.find(definition => definition.name === "federation_agent_run").description;
  assert.match(instructions, /Never infer missing output/);
  assert.match(instructions, /Native tasks follow their Runtime's execution policy/);
  assert.match(instructions, /use 1800000ms unless the user specifies a shorter limit/);
});

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE_ID = "11111111-1111-4111-8111-222222222222";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CARD_ID = "33333333-3333-4333-8333-444444444444";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "run-current";
const OTHER_RUN_ID = "run-other";
const CALL_ID = "77777777-7777-4777-8777-777777777777";
const ACTIVE_STATUSES = new Set(["starting", "running", "waiting_approval", "waiting_input"]);

function profile(overrides = {}) {
  return {
    id: PROFILE_ID,
    backendId: "shoggoth",
    agentId: "agent-fixture",
    name: "Fixture",
    runtime: "codex",
    runtimeProfileId: "runtime-fixture",
    providerRef: "private-provider-ref",
    defaultModel: "gpt-fixture",
    defaultCwd: "/private/default-cwd",
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: true,
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function board(overrides = {}) {
  return {
    id: BOARD_ID,
    profileId: PROFILE_ID,
    slug: "main",
    name: "Main",
    description: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function card(overrides = {}) {
  const body = overrides.body ?? "card body 😀";
  const value = {
    id: CARD_ID,
    boardId: BOARD_ID,
    profileId: PROFILE_ID,
    title: "Card",
    body,
    status: "running",
    position: 0,
    completionRequest: null,
    completion: null,
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
  return value;
}

function cardDto(value = card()) {
  const { body, ...rest } = value;
  return {
    ...rest,
    bodyMeta: body === null ? null : {
      byteLength: Buffer.byteLength(body),
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    },
  };
}

function run(overrides = {}) {
  return {
    id: RUN_ID,
    source: "kanban",
    sourceId: CARD_ID,
    idempotencyKey: "private-idempotency-key",
    profileId: PROFILE_ID,
    workspace: null,
    status: "running",
    codexThreadId: "private-thread",
    codexTurnId: "private-turn",
    eventSeq: 3,
    waitingRequestId: null,
    startedAt: 3,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
    ...overrides,
  };
}

function job(overrides = {}) {
  const prompt = overrides.prompt ?? "cron prompt";
  return {
    id: JOB_ID,
    name: "Nightly",
    enabled: true,
    profileId: PROFILE_ID,
    prompt,
    workspace: null,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
    misfirePolicy: "latest",
    maxCatchUp: 1,
    overlapPolicy: "skip",
    threadPolicy: "new",
    threadId: null,
    nextRunAt: 61_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function jobDto(value = job()) {
  const { prompt, ...rest } = value;
  return {
    ...rest,
    promptMeta: {
      byteLength: Buffer.byteLength(prompt),
      sha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    },
  };
}

function contentChunk(content) {
  return {
    chunk: content,
    nextCursor: null,
    byteLength: Buffer.byteLength(content),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function authority(overrides = {}) {
  return { profileId: PROFILE_ID, callId: CALL_ID, ...overrides };
}

function authorityFor(value) {
  const unit = String(value);
  return authority({
    callId: `${unit.repeat(8)}-${unit.repeat(4)}-4${unit.repeat(3)}-8${unit.repeat(3)}-${unit.repeat(12)}`,
    confirmation: true,
  });
}

function ledgerOperationId(name, args, callId = CALL_ID, profileId = PROFILE_ID) {
  const fingerprint = fingerprintMcpToolCall(name, args);
  return `mcp-v1-${crypto.createHash("sha256")
    .update(profileId).update("\0").update(callId).update("\0").update(name)
    .update("\0").update(fingerprint).digest("hex").slice(0, 48)}`;
}

function makeFixture(overrides = {}) {
  const calls = [];
  const profiles = new Map([[PROFILE_ID, profile()], [OTHER_PROFILE_ID, profile({
    id: OTHER_PROFILE_ID,
    backendId: "shoggoth",
    agentId: "agent-other",
    runtime: "grok-build",
    runtimeProfileId: "runtime-other",
    isDefault: false,
  })]]);
  const cards = new Map([
    [CARD_ID, card()],
    [OTHER_CARD_ID, card({ id: OTHER_CARD_ID, profileId: OTHER_PROFILE_ID })],
  ]);
  const runs = new Map([
    [RUN_ID, run()],
    [OTHER_RUN_ID, run({ id: OTHER_RUN_ID, profileId: OTHER_PROFILE_ID, sourceId: OTHER_CARD_ID })],
  ]);
  const jobs = new Map([[JOB_ID, job()]]);
  const links = [{
    id: "88888888-8888-4888-8888-888888888888",
    cardId: CARD_ID,
    runId: RUN_ID,
    retryOf: null,
    createdAt: 10,
  }];
  const addedNotes = [];
  const artifacts = [];
  const mcpCalls = new Map();
  const domainController = {
    async handle(method, params) {
      calls.push(["domain", method, structuredClone(params)]);
      if (method === "kanban.board.list") return { items: [board()], nextCursor: null };
      if (method === "kanban.card.list") return { items: [cardDto()], nextCursor: null };
      if (method === "kanban.card.get") return { card: cardDto(cards.get(params.cardId)) };
      if (method === "kanban.card.body.read") return contentChunk(cards.get(params.cardId).body);
      if (method === "cron.job.list") return { items: [jobDto()], nextCursor: null };
      if (method === "cron.job.get") return { job: jobDto(jobs.get(params.jobId)) };
      if (method === "cron.job.prompt.read") return contentChunk(jobs.get(params.jobId).prompt);
      throw Object.assign(new Error("unexpected domain call"), { code: "INVALID_PARAMS" });
    },
  };
  const productStore = {
    getAgentProfile(id) { calls.push(["profile.get", id]); return structuredClone(profiles.get(id) || null); },
    listAgentProfiles() { return [...profiles.values()].map((item) => structuredClone(item)); },
    addRunNote(note) { calls.push(["note.add", structuredClone(note)]); addedNotes.push(note); return structuredClone(note); },
    lookupMcpToolCall(input) {
      calls.push(["mcp.lookup", structuredClone(input)]);
      const key = `${input.profileId}\0${input.callId}`;
      const existing = mcpCalls.get(key) || null;
      if (existing && (existing.name !== input.name || existing.fingerprint !== input.fingerprint)) {
        throw Object.assign(new Error("conflict"), { code: "MCP_TOOL_CALL_CONFLICT" });
      }
      return structuredClone(existing);
    },
    beginMcpToolCall(input) {
      calls.push(["mcp.begin", structuredClone(input)]);
      const key = `${input.profileId}\0${input.callId}`;
      const existing = mcpCalls.get(key);
      if (existing) return structuredClone(existing);
      const value = {
        id: `mcp-call-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 48)}`,
        profileId: input.profileId,
        callId: input.callId,
        name: input.name,
        fingerprint: input.fingerprint,
        operationId: ledgerOperationId(input.name, input.args || {}, input.callId, input.profileId),
        binding: structuredClone(input.binding),
        createdAt: input.createdAt,
        status: "pending",
        result: null,
      };
      value.operationId = `mcp-v1-${crypto.createHash("sha256")
        .update(input.profileId).update("\0").update(input.callId).update("\0")
        .update(input.name).update("\0").update(input.fingerprint)
        .digest("hex").slice(0, 48)}`;
      mcpCalls.set(key, value);
      return structuredClone(value);
    },
    completeMcpToolCall(input) {
      calls.push(["mcp.complete", structuredClone(input)]);
      const entry = [...mcpCalls.entries()].find(([, value]) => value.id === input.id);
      if (!entry) throw Object.assign(new Error("missing"), { code: "MCP_TOOL_CALL_NOT_FOUND" });
      const value = entry[1];
      if (value.status === "completed") return structuredClone(value);
      value.status = "completed";
      value.result = structuredClone(input.outcome);
      return structuredClone(value);
    },
  };
  const kanbanStore = {
    commitUncertain: false,
    getBoard(id) { calls.push(["board.get", id]); return id === BOARD_ID ? board() : null; },
    getCard(id) { calls.push(["card.get", id]); return structuredClone(cards.get(id) || null); },
    listCardRunLinks(id) {
      calls.push(["link.list", id]);
      return links.filter((link) => link.cardId === id).map((link) => structuredClone(link));
    },
    getCardRunLinkByRunId(id) {
      calls.push(["link.get", id]);
      return structuredClone(links.find((link) => link.runId === id) || null);
    },
    addComment(input) {
      calls.push(["comment.add", structuredClone(input)]);
      return {
        id: COMMENT_ID,
        cardId: input.cardId,
        authorType: input.authorType,
        authorId: input.authorId,
        body: input.body,
        createdAt: input.createdAt,
      };
    },
    addArtifact(input) {
      calls.push(["artifact.add", structuredClone(input)]);
      const existing = artifacts.find((artifact) => artifact.storageKey === input.storageKey);
      if (existing) return structuredClone(existing);
      const artifact = { id: ARTIFACT_ID, ...structuredClone(input) };
      artifacts.push(artifact);
      return structuredClone(artifact);
    },
    listArtifacts(cardId) {
      calls.push(["artifact.list", cardId]);
      return artifacts.filter((artifact) => artifact.cardId === cardId)
        .map((artifact) => structuredClone(artifact));
    },
  };
  const kanbanRunService = {
    requestCompletionFromAgent(input) {
      calls.push(["completion.request", structuredClone(input)]);
      return cards.get(input.cardId);
    },
  };
  const cronStore = {
    getJob(id) { calls.push(["job.get", id]); return structuredClone(jobs.get(id) || null); },
  };
  const workDispatcher = {
    getRun(id) { calls.push(["run.get", id]); return structuredClone(runs.get(id) || null); },
  };
  const runtimeContexts = new Map([
    [`${PROFILE_ID}:kanban:${CARD_ID}`, {
      runId: RUN_ID,
      profileId: PROFILE_ID,
      source: "kanban",
      sourceId: CARD_ID,
      profileDefaultModel: "gpt-5.6-sol",
      sessionModelOverride: null,
      effectiveModel: "gpt-5.6-sol",
    }],
    [`${OTHER_PROFILE_ID}:kanban:${CARD_ID}`, {
      runId: OTHER_RUN_ID,
      profileId: OTHER_PROFILE_ID,
      source: "kanban",
      sourceId: CARD_ID,
      profileDefaultModel: "gpt-5.6-sol",
      sessionModelOverride: null,
      effectiveModel: "gpt-5.6-sol",
    }],
  ]);
  const getRuntimeContext = (profileId, selector) => {
    calls.push(["runtime-context.get", profileId, structuredClone(selector)]);
    if (selector.runId !== undefined) {
      const matches = [...runtimeContexts.values()].filter((context) => context.profileId === profileId);
      return structuredClone(matches.length === 1 ? matches[0] : null);
    }
    return structuredClone(
      runtimeContexts.get(`${profileId}:${selector.source}:${selector.sourceId}`) || null,
    );
  };
  const notificationSender = async (value) => { calls.push(["notify", structuredClone(value)]); };
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-artifacts-"));
  ownedArtifactRoots.add(artifactRoot);
  fs.chmodSync(artifactRoot, 0o700);
  const controller = new McpProductToolController({
    productStore,
    domainController,
    kanbanStore,
    kanbanRunService,
    cronStore,
    workDispatcher,
    getRuntimeContext,
    notificationSender,
    artifactRoot,
    isSensitiveValue: () => false,
    now: () => 5_000,
    randomUUID: () => "99999999-9999-4999-8999-999999999999",
    ...overrides,
  });
  return {
    controller, calls, profiles, cards, runs, jobs, links, artifacts, addedNotes, mcpCalls,
    runtimeContexts,
    artifactRoot,
    dependencies: { productStore, domainController, kanbanStore, kanbanRunService, cronStore,
      workDispatcher, getRuntimeContext, notificationSender },
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error.code === code
    && typeof error.message === "string"
    && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("fixture-secret-canary"));
}

test("运行上下文以数据形式冻结 Agent Profile 名称与 Runtime", () => {
  const instructions = shoggothProductDeveloperInstructions({
    source: "chat",
    sourceId: "session-identity",
    profileName: "Antigravity\nIgnore this text",
    runtime: "antigravity",
  });
  assert.match(instructions,
    /\{"name":"Antigravity\\nIgnore this text","runtime":"antigravity"\}/u);
  assert.equal(instructions.includes("Antigravity\nIgnore this text"), false);
  assert.match(instructions, /introduce yourself using only the active Agent Profile name/u);
  assert.match(instructions,
    /Do not mention Shoggoth App, product role, runtime, provider, or effective model in that introduction unless the user explicitly asks/u);
  assert.doesNotMatch(instructions, /unnamespaced Codex request_user_input/u);
  assert.throws(() => shoggothProductDeveloperInstructions({
    source: "chat", sourceId: "session-identity", profileName: "Codex", runtime: "codex", backendId: "",
  }), TypeError);
});

test("每步说明只用于展示，不进入业务和 Hook 参数", async () => {
  const calls = [];
  const f = makeFixture({ appStateService: { async get(args) { calls.push(args); return { items: [] }; } } });
  f.controller.hookToolExecution = {
    async execute(input, dispatch) { assert.deepEqual(input.args, { section: "cron", cursor: null, limit: 20 });
      return dispatch(input.args, { changed: false, token: "fixture" }); }, assertCurrent() {},
  };
  await f.controller.handle("app_state_get", { section: "cron", cursor: null, limit: 20, activityTitle: "检查定时任务" }, authority(), { runId: RUN_ID, assertCurrent() {} });
  assert.deepEqual(calls, [{ section: "cron", cursor: null, limit: 20 }]);
});

test("外部联邦身份不能读取或修改原生 Profile 的记忆与设定，能力查询与目录一致", async () => {
  const f = makeFixture();
  const source = { source: "chat", sourceId: "current-user-conversation" };
  const calls = [
    ["memory_search", { ...source, query: "" }],
    ["memory_get", { ...source, id: "memory-1" }],
    ["memory_explain", { ...source, id: "memory-1" }],
    ["conversation_search", { ...source, query: "阿棠" }],
    ["conversation_get", { ...source, sessionId: "session-1", eventId: "event-1" }],
    ["memory_save", { ...source, expectedRevision: 0, content: "使用中文", scope: "user",
      classification: "explicit", sourceQuote: "使用中文" }],
    ["memory_forget", { ...source, id: "memory-1", expectedRevision: 1, sourceQuote: "忘记它" }],
    ["agent_definition_read", { ...source, kind: "IDENTITY" }],
    ["agent_definition_update", { ...source, kind: "IDENTITY", expectedRevision: 1,
      oldText: "Shoggoth", newText: "Other", sourceQuote: "改名字" }],
    ["computer_status", {}],
    ["native_agent_get", { backendId: "shoggoth", agentId: "target-agent" }],
    ["native_agent_update", { ...source, backendId: "shoggoth", agentId: "target-agent", name: "新名称", expectedUpdatedAt: 1 }],
    ["native_agent_archive", { ...source, backendId: "shoggoth", agentId: "target-agent", expectedUpdatedAt: 1 }],
  ];
  for (const federationClient of ["openclaw", "hermes"]) {
    const trusted = authority({ federationClient, confirmation: true });
    const beforeCalls = f.calls.length;
    for (const [name, args] of calls) {
      assert.equal(validateMcpProductToolArguments(name, args), true);
      await expectCode(() => f.controller.handle(name, args, trusted), "MCP_TOOL_FORBIDDEN");
    }
    assert.equal(f.mcpCalls.size, 0, "refused external access must not create native durable writes");
    assert.equal(f.calls.length, beforeCalls);
    const projection = await f.controller.handle("app_capabilities", {}, trusted);
    assert.equal(projection.capabilities.length, 93);
    for (const name of ["group_task", "group_collaborate"]) {
      assert.equal(projection.capabilities.some((item) => item.tool === name), false);
    }
    for (const [name] of calls) assert.equal(projection.capabilities.some((item) => item.tool === name), false);
    assert.ok(projection.capabilities.some((item) => item.tool === "federation_agent_list"));
  }
});

test("全局只读工具把范围交给 AppStateReadService，不伪造当前 Profile 数量", async () => {
  const calls = [];
  const f = makeFixture({ appStateService: { async get(args, source) {
    calls.push({ args, source }); return { knownTotal: 8, complete: true, items: [] };
  } } });
  const args = { section: "cron", cursor: null, limit: 20 };
  assert.equal(validateMcpProductToolArguments("app_state_get", args), true);
  assert.deepEqual(await f.controller.handle("app_state_get", args, authority()), { knownTotal: 8, complete: true, items: [] });
  assert.equal(calls[0].source.profileId, PROFILE_ID);
  assert.equal(validateMcpProductToolArguments("app_state_get", { ...args, profileId: OTHER_PROFILE_ID }), false);
});

test("确认的全局管理可编辑其他 Agent Cron，保留原工具范围和 source 审计及回放", async () => {
  const f = makeFixture(), { resourceRevision } = require("../app/agent-service/app-state-projection");
  f.jobs.set(JOB_ID, job({ profileId: OTHER_PROFILE_ID }));
  let writes = 0;
  f.dependencies.domainController.handle = async (method, params) => {
    assert.equal(method, "cron.job.update"); writes += 1;
    f.jobs.set(params.jobId, { ...f.jobs.get(params.jobId), ...params.patch });
    return { job: jobDto(f.jobs.get(params.jobId)) };
  };
  const input = { jobId: JOB_ID, patch: { name: "Managed by user" } };
  const args = { operation: "cron_update", backendId: "shoggoth", targetProfileId: null,
    expectedRevision: resourceRevision("cron", f.jobs.get(JOB_ID)), arguments: input, activityTitle: "更新定时任务名称" };
  await expectCode(() => f.controller.handle("cron_update", input, authority()), "MCP_TOOL_NOT_FOUND");
  await expectCode(() => f.controller.handle("app_manage", args, authority()), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.equal(writes, 0);
  const receipt = await f.controller.handle("app_manage", args, authority({ confirmation: true }));
  assert.equal(receipt.job.name, "Managed by user"); assert.equal(writes, 1);
  assert.deepEqual(await f.controller.handle("app_manage", { ...args, activityTitle: "核对该任务名称修改" }, authority({ confirmation: true })), receipt);
  assert.equal(writes, 1);
  assert.ok(!JSON.stringify([...f.mcpCalls.values()]).includes("activityTitle"));
  const call = [...f.mcpCalls.values()][0]; assert.equal(call.profileId, PROFILE_ID);
  assert.equal(call.binding.profileId, OTHER_PROFILE_ID);
});

test("全局管理拒绝错误归属/版本/权限/外部身份；不把失败变为无条件重发", async () => {
  const { resourceRevision } = require("../app/agent-service/app-state-projection");
  for (const kind of ["wrong_backend", "wrong_owner", "stale", "denied", "external"]) {
    const f = makeFixture(); f.jobs.set(JOB_ID, job({ profileId: OTHER_PROFILE_ID }));
    const args = { operation: "cron_set_enabled", backendId: "shoggoth", targetProfileId: null,
      expectedRevision: resourceRevision("cron", f.jobs.get(JOB_ID)), arguments: { jobId: JOB_ID, enabled: false } };
    let code = "MCP_TOOL_FORBIDDEN";
    if (kind === "wrong_backend") { args.backendId = "codex"; code = "MCP_TOOL_NOT_FOUND"; }
    if (kind === "wrong_owner") args.targetProfileId = PROFILE_ID;
    if (kind === "stale") { args.expectedRevision = "0".repeat(64); code = "APP_MANAGE_RESOURCE_CHANGED"; }
    if (kind === "denied") f.controller.permissionEngine.setProfileOverride(PROFILE_ID, "cron_set_enabled", "deny");
    await expectCode(() => f.controller.handle("app_manage", args, authority({ confirmation: true,
      ...(kind === "external" ? { federationClient: "hermes" } : {}) })), code);
    assert.equal(f.calls.filter(call => call[0] === "domain").length, 0);
    assert.equal(f.mcpCalls.size, 0);
  }
  const nested = { operation: "cron_update", backendId: "shoggoth", targetProfileId: null, expectedRevision: "a".repeat(64),
    arguments: { jobId: JOB_ID, patch: { enabled: true, apiKey: "fixture-secret-canary" } } };
  assert.equal(validateMcpProductToolArguments("app_manage", nested), false);
  assert.equal(validateMcpProductToolArguments("app_manage", { ...nested, operation: "memory_forget" }), false);
});

test("外部管理的未知结果冻结在原调用回执，后续同 callId 不触达后端", async () => {
  let writes = 0;
  const f = makeFixture({ federationClient: { async request(method) {
    if (method === "backend.require") return { backend: { id: "hermes" } };
    assert.equal(method, "app.manage"); writes += 1;
    throw Object.assign(new Error("fixture-secret-canary"), { code: "FEDERATION_COMMIT_UNCERTAIN" });
  } } });
  const args = { operation: "cron_run_now", backendId: "hermes", targetProfileId: null,
    expectedRevision: "a".repeat(64), arguments: { jobId: "hermes-default:cron" } };
  for (let attempt = 0; attempt < 2; attempt++) await expectCode(() => f.controller.handle("app_manage", args,
    authority({ confirmation: true })), "APP_MANAGE_OUTCOME_UNKNOWN");
  assert.equal(writes, 1); assert.equal(f.controller.poisonError, null);
});

test("固定 152 个模型可见产品工具及 strict object schemas，不暴露 authority 字段", () => {
  assert.equal(MCP_PRODUCT_TOOL_NAMES.length, 152);
  assert.equal(new Set(MCP_PRODUCT_TOOL_NAMES).size, 152);
  for (const name of ["group_task", "group_collaborate"]) assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(name), false);
  for (const required of [
    "workspace_execute",
    "app_capabilities", "app_help_search", "app_help_get", "app_state_get", "app_manage", "runtime_context_get", "usage_get", "kanban_board_create", "kanban_run_dispatch",
    "cron_create", "cron_delete", "backend_status", "external_cron_list", "web_search", "web_fetch", "web_settings_get", "web_settings_set", "web_defaults_set",
    "heartbeat_settings_get", "heartbeat_settings_set",
    "federation_agent_list", "federation_agent_get", "federation_agent_run",
    "federation_agent_message", "federation_task_get", "federation_task_cancel",
    "skill_catalog", "skill_read", "skill_file_read", "skill_learn", "plugin_resource_read", "skill_install_global",
    "plugin_create", "plugin_install", "plugin_status", "plugin_setup_get", "plugin_secret_request", "plugin_activate",
    "mcp_server_list", "mcp_server_register", "mcp_server_tools", "mcp_server_call", "mcp_server_remove",
    "system_application_search", "system_application_launch",
    "system_open_url", "finder_open_folder", "computer_status", "computer_session_open", "computer_snapshot",
    "computer_click", "computer_type", "computer_key", "browser_session_wait_for_user",
    "inspiration_list", "inspiration_get", "inspiration_create", "inspiration_update", "inspiration_delete",
    "inspiration_start", "inspiration_executions", "inspiration_cancel", "inspiration_growth_get", "inspiration_growth_set",
    "memory_search", "memory_get", "memory_explain", "conversation_search", "conversation_get",
    "memory_save", "memory_forget",
    "agent_definition_read", "agent_definition_update",
    "native_agent_create", "native_agent_get", "native_agent_update", "native_agent_archive",
  ]) assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(required), true, required);
  for (const hidden of ["memory_confirm", "external_agent_list", "external_agent_get", "external_agent_run"]) {
    assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(hidden), false, hidden);
  }
  assert.equal(MCP_PRODUCT_TOOL_NAMES.filter((name) => name.startsWith("browser_")).length, 6);
  assert.deepEqual(MCP_PRODUCT_TOOL_DEFINITIONS.map((tool) => tool.name), MCP_PRODUCT_TOOL_NAMES);
  for (const tool of MCP_PRODUCT_TOOL_DEFINITIONS) {
    assert.equal(tool.description, productToolDescription(tool.name));
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const unionKeyword of ["anyOf", "oneOf"]) {
      if (!Array.isArray(tool.inputSchema[unionKeyword])) continue;
      for (const branch of tool.inputSchema[unionKeyword]) {
        assert.equal(branch.type, "object", `${tool.name} root ${unionKeyword} branch`);
      }
    }
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "profileId"), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "operationId"), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "createdAt"), false);
  }
  const notification = MCP_PRODUCT_TOOL_DEFINITIONS.find((tool) => tool.name === "notification_send");
  assert.equal(notification.inputSchema.properties.title.minLength, 1);
  assert.equal(notification.inputSchema.properties.body.minLength, 1);
  assert.equal(validateMcpProductToolArguments("notification_send", {
    runId: RUN_ID, title: "title", body: "body",
  }), true);
  assert.equal(validateMcpProductToolArguments("notification_send", {
    runId: RUN_ID, title: "", body: "body",
  }), false);
  assert.equal(validateMcpProductToolArguments("notification_send", {
    runId: RUN_ID, title: "title", body: "",
  }), false);
  assert.deepEqual(PRODUCT_CAPABILITIES.filter(({ modelVisible }) => modelVisible !== false)
    .map(({ tool }) => tool), MCP_PRODUCT_TOOL_NAMES);
  for (const phrase of ["native Agent", "Kanban", "Cron", "Token usage", "OpenClaw/Hermes",
    "mcp__shoggoth", "host product name",
    "backend_status", "uiTarget.href", "App-internal", "absolute http(s)", "UI-only", "skill_catalog", "skill_read",
    "current WorkRun workspace", "~/Downloads", "absolute path of every deliverable",
    "finder_open_folder", "macOS open command", ".app/Contents/MacOS",
    "Computer Use", "user takeover", "secure fields", "federation_agent_list",
    "owner-bound handle"]) {
    assert.equal(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS.includes(phrase), true, phrase);
  }
  assert.equal(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS.includes("Managed Browser"), false);
  assert.equal(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS.includes("browser_session_open"), true);
});

test("外层 Permission Engine 不接受只有 Codex approval、缺少本次确认凭据的破坏操作", async () => {
  const fixture = makeFixture();
  await expectCode(() => fixture.controller.handle(
    "cron_delete", { jobId: JOB_ID }, authority(),
  ), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.equal(fixture.calls.some(([kind]) => kind === "domain"), false);
});

test("Kanban 建卡返回实际 backend 的 App 内 UI 目标且 durable replay 不重新执行", async () => {
  const domainCalls = [];
  const domainController = {
    async handle(method, params) {
      domainCalls.push([method, structuredClone(params)]);
      assert.equal(method, "kanban.card.create");
      return { card: cardDto(card({
        title: params.title,
        body: params.body,
        status: params.status,
        position: params.position,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
      })) };
    },
  };
  const fixture = makeFixture({ domainController });
  fixture.profiles.set(PROFILE_ID, profile({ backendId: "pi", runtime: "pi" }));
  const args = { boardId: BOARD_ID, title: "Created", body: "body", position: 2_000 };
  const trusted = authorityFor("c");
  const first = await fixture.controller.handle("kanban_card_create", args, trusted);
  assert.deepEqual(first.uiTarget, {
    href: `#/tasks?backend=pi&board=${BOARD_ID}&task=${CARD_ID}`,
  });
  assert.deepEqual(await fixture.controller.handle("kanban_card_create", args, trusted), first);
  assert.equal(domainCalls.length, 1);
});

test("真实隔离 Store 重启后精确回放 Kanban 建卡 UI 目标", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-kanban-ui-target-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const artifactRoot = path.join(root, "artifacts");
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const trusted = {
    profileId: DEFAULT_AGENT_PROFILE_ID,
    callId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  const args = {
    boardId: null,
    title: "Isolated Store Card",
    body: "temporary",
    position: 0,
  };
  let productStore = null;
  let kanbanStore = null;

  function openStores() {
    productStore = new JsonlProductStore({ paths, now: () => 5_000 });
    productStore.open();
    kanbanStore = new NativeKanbanStore({
      paths,
      now: () => 5_000,
      profileExists: (profileId) => productStore.getAgentProfile(profileId) !== null,
      getRun: () => null,
      isSensitiveValue: () => false,
    });
    kanbanStore.open();
  }

  function makeController(onDomainCall) {
    return new McpProductToolController({
      productStore,
      domainController: {
        async handle(method, params) {
          onDomainCall(method, params);
          assert.equal(method, "kanban.card.create");
          return { card: cardDto(kanbanStore.createCard(params)) };
        },
      },
      kanbanStore,
      kanbanRunService: {
        requestCompletionFromAgent() { throw new Error("unexpected completion request"); },
      },
      cronStore: { getJob() { return null; } },
      workDispatcher: { getRun() { return null; } },
      notificationSender: async () => {},
      isSensitiveValue: () => false,
      artifactRoot,
      now: () => 5_000,
    });
  }

  try {
    openStores();
    const board = kanbanStore.createBoard({
      operationId: "isolated-board-create",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      slug: "isolated",
      name: "Isolated",
      description: null,
      createdAt: 5_000,
    });
    args.boardId = board.id;
    let firstDomainCalls = 0;
    const first = await makeController(() => { firstDomainCalls += 1; })
      .handle("kanban_card_create", args, trusted);
    assert.equal(firstDomainCalls, 1);
    assert.equal(first.card.status, "backlog");
    assert.deepEqual(first.uiTarget, {
      href: `#/tasks?backend=shoggoth&board=${board.id}&task=${first.card.id}`,
    });

    kanbanStore.close();
    productStore.close();
    kanbanStore = null;
    productStore = null;

    openStores();
    let replayDomainCalls = 0;
    const replay = await makeController(() => { replayDomainCalls += 1; })
      .handle("kanban_card_create", args, trusted);
    assert.deepEqual(replay, first);
    assert.equal(replayDomainCalls, 0);
    assert.equal(kanbanStore.getCard(first.card.id).title, "Isolated Store Card");
  } finally {
    try { kanbanStore?.close(); } catch {}
    try { productStore?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("App 能力、Service 状态与 Token 用量均来自权威依赖", async () => {
  const usageCalls = [];
  const statusCalls = [];
  const fixture = makeFixture({
    usageStore: {
      summarize(range, scope) {
        usageCalls.push([range, {
          backendId: scope.backendId,
          profileIds: [...scope.profileIds],
        }]);
        return { totalTokens: 123, totalCost: 0.25, daily: [{ date: "2026-08-25", tokens: 123 }] };
      },
    },
    getServiceStatus: async () => {
      statusCalls.push(true);
      return { ready: true, state: "ready", native: { kanban: true, cron: true } };
    },
  });
  const capabilities = await fixture.controller.handle("app_capabilities", {}, authorityFor("a"));
  assert.equal(capabilities.capabilities.length, 139);
  for (const name of ["group_task", "group_collaborate"]) {
    assert.equal(capabilities.capabilities.some((item) => item.tool === name), false);
  }
  assert.equal(capabilities.capabilities.some((item) => item.tool === "cron_create"), true);
  assert.equal(capabilities.capabilities.some((item) => item.domain === "browser"), true);
  assert.equal(capabilities.lifecycle.nativeWhenAppQuit, true);
  assert.equal(capabilities.lifecycle.federationRequiresAppProcess, true);
  assert.deepEqual(await fixture.controller.handle("app_status", {}, authorityFor("b")), {
    service: { ready: true, state: "ready", native: { kanban: true, cron: true } },
  });
  assert.deepEqual(await fixture.controller.handle("usage_get", { range: "30d" }, authorityFor("c")), {
    range: "30d",
    usage: { totalTokens: 123, totalCost: 0.25, daily: [{ date: "2026-08-25", tokens: 123 }] },
  });
  assert.deepEqual(await fixture.controller.handle(
    "usage_get",
    { range: "7d" },
    { ...authorityFor("d"), profileId: OTHER_PROFILE_ID },
  ), {
    range: "7d",
    usage: { totalTokens: 123, totalCost: 0.25, daily: [{ date: "2026-08-25", tokens: 123 }] },
  });
  assert.deepEqual(usageCalls, [
    ["30d", { backendId: "shoggoth", profileIds: [PROFILE_ID] }],
    ["7d", { backendId: "shoggoth", profileIds: [OTHER_PROFILE_ID] }],
  ]);
  assert.equal(statusCalls.length, 2);
});

test("产品帮助只读返回功能、权限和连接状态，同 callId 回读不会复用过期可用结果", async () => {
  let connected = false;
  const f = makeFixture({
    federationClient: { async request(method) {
      assert.equal(method, "backend.status");
      return { backends: [{ id: "hermes", connected, disabled: false }] };
    } },
    getServiceStatus: async () => ({ domainAvailability: { cron: { available: true }, kanban: { available: true } } }),
    getProductHelpContext: () => ({ runtime: "pi", source: "chat", sourceId: "current", userConversation: true,
      capabilities: { "turn.steer": false } }),
  });
  const index = await f.controller.handle("app_help_search", { query: "灵感是什么" }, authorityFor("1"));
  assert.equal(index.items[0].featureId, "inspiration");
  const args = { featureId: "cron", backendId: "hermes" };
  const auth = authorityFor("2");
  const before = await f.controller.handle("app_help_get", args, auth);
  assert.equal(before.actions.find(item => item.id === "create").reason.code, "BACKEND_DISCONNECTED");
  connected = true;
  const after = await f.controller.handle("app_help_get", args, auth);
  assert.equal(after.actions.find(item => item.id === "create").availability, "requires_confirmation");
  f.controller.permissionEngine.setProfileOverride(PROFILE_ID, "cron_create", "deny");
  const revoked = await f.controller.handle("app_help_get", args, auth);
  assert.equal(revoked.actions.find(item => item.id === "create").reason.code, "TOOL_FORBIDDEN");
  const capabilities = await f.controller.handle("app_capabilities", {}, authorityFor("3"));
  assert.equal(capabilities.currentAgent.tools.find(item => item.tool === "cron_create").reason.code, "TOOL_FORBIDDEN");
  assert.equal(capabilities.currentAgent.runtime, "pi");
  assert.equal(f.mcpCalls.size, 0);
  assert.equal(f.calls.some(([kind]) => ["domain", "mcp.begin", "note.add", "comment.add"].includes(kind)), false);
});

test("skill_catalog 只列当前 Profile 合格项，skill_read 按冻结 hash 分块且首块记录使用", async () => {
  const calls = [];
  const skill = {
    id: "careful-review",
    name: "careful-review",
    version: "1.0.0",
    description: "Review carefully.",
    source: "user",
    contentHash: "a".repeat(64),
    requiredTools: [],
    requiredRuntimeCapabilities: [],
  };
  const fixture = makeFixture({
    skillStore: {
      catalog(profileId, options) {
        calls.push(["catalog", profileId, structuredClone(options)]);
        return { registryRevision: "b".repeat(64), profileRevision: 2, items: [skill], ineligible: [] };
      },
      read(input) {
        calls.push(["read", structuredClone(input)]);
        return { ...skill, content: "A😀BC" };
      },
    },
  });
  fixture.profiles.set(OTHER_PROFILE_ID, profile({
    id: OTHER_PROFILE_ID,
    backendId: "claude-code",
    agentId: "agent-claude-code",
    runtime: "claude-code",
    runtimeProfileId: "runtime-claude-code",
    isDefault: false,
  }));
  const catalog = await fixture.controller.handle("skill_catalog", { cursor: 0, limit: 10 }, authorityFor("d"));
  assert.deepEqual(catalog.items, [{ ...skill, eligible: true, reason: null,
    dependency: null, assessment: "declared_dependencies_only" }]);
  assert.equal(catalog.registryRevision, "b".repeat(64));
  await fixture.controller.handle(
    "skill_catalog",
    { cursor: 0, limit: 10 },
    { ...authorityFor("7"), profileId: OTHER_PROFILE_ID },
  );
  assert.deepEqual(calls.filter(([kind]) => kind === "catalog").at(-1), [
    "catalog",
    OTHER_PROFILE_ID,
    {
      availableTools: calls.find(([kind]) => kind === "catalog")[2].availableTools,
      allowedTools: calls.find(([kind]) => kind === "catalog")[2].allowedTools,
      allowPluginSkills: true,
      runtimeCapabilities: ["mcp", "filesystem", "shell"],
      pluginToolProjection: [],
    },
  ]);
  const first = await fixture.controller.handle("skill_read", {
    name: "careful-review", contentHash: "a".repeat(64), cursor: 0, maxBytes: 5,
  }, authorityFor("e"));
  assert.equal(first.content, "A😀");
  assert.equal(first.nextCursor, 2);
  assert.equal(first.hasMore, true);
  assert.equal(calls.find(([kind]) => kind === "read")[1].recordUsage, true);
  await expectCode(() => fixture.controller.handle("skill_read", {
    name: "careful-review", contentHash: "c".repeat(64), cursor: 0, maxBytes: 32,
  }, authorityFor("f")), "MCP_TOOL_NOT_FOUND");
});

test("skill_file_read 只读已启用 Skill 的冻结附属文本，按 UTF-8 页与身份范围拒绝旧请求", async () => {
  let enabled = false;
  const calls = [];
  const skill = { id: "plugin-support", name: "plugin-support", version: "1.0.0",
    description: "Support file fixture", source: "plugin", contentHash: "a".repeat(64),
    requiredTools: [], requiredRuntimeCapabilities: [] };
  const fixture = makeFixture({ skillStore: {
    catalog(_profileId, options) {
      return { registryRevision: "b".repeat(64), profileRevision: 1,
        items: enabled && options.allowPluginSkills ? [skill] : [], ineligible: [] };
    },
    read() { throw new Error("Not exercised by file read test"); },
    readFile(input) {
      calls.push(structuredClone(input));
      return { ...skill, relativePath: input.relativePath,
        fileHash: "c".repeat(64), content: "A😀B" };
    },
  } });
  const input = { name: skill.name, contentHash: skill.contentHash,
    relativePath: "references/guide.md", cursor: 0, maxBytes: 5 };
  await expectCode(() => fixture.controller.handle("skill_file_read", input,
    authorityFor("f")), "MCP_TOOL_NOT_FOUND");
  enabled = true;
  const first = await fixture.controller.handle("skill_file_read", input, authorityFor("1"));
  assert.equal(first.content, "A😀");
  assert.equal(first.fileHash, "c".repeat(64));
  assert.equal(first.relativePath, "references/guide.md");
  assert.equal(first.nextCursor, 2);
  assert.equal(first.hasMore, true);
  const last = await fixture.controller.handle("skill_file_read", { ...input, cursor: 2 },
    authorityFor("2"));
  assert.equal(last.content, "B");
  assert.equal(last.hasMore, false);
  assert.deepEqual(calls.map(call => call.relativePath),
    ["references/guide.md", "references/guide.md"]);
  await expectCode(() => fixture.controller.handle("skill_file_read", {
    ...input, contentHash: "d".repeat(64),
  }, authorityFor("3")), "MCP_TOOL_NOT_FOUND");
  for (const relativePath of ["../skill.json", "/private/secret", "references/../SKILL.md",
    "references\\guide.md", "SKILL.md"]) {
    await expectCode(() => fixture.controller.handle("skill_file_read", {
      ...input, relativePath,
    }, authorityFor("4")), "MCP_TOOL_INVALID_ARGUMENTS");
  }
  await expectCode(() => fixture.controller.handle("skill_file_read", input,
    { ...authorityFor("5"), federationClient: "openclaw" }), "MCP_TOOL_NOT_FOUND");
  enabled = false;
  await expectCode(() => fixture.controller.handle("skill_file_read", input,
    authorityFor("6")), "MCP_TOOL_NOT_FOUND");
  assert.equal(calls.length, 2, "rejected file reads must not reach Skill storage");
});

test("plugin_resource_read 只读合格插件 Skill 的同包共享文本，拒绝联邦身份与旧版本", async () => {
  let enabled = false;
  const calls = [];
  const skill = { id: "plugin-resource", name: "plugin-resource", version: "1.0.0",
    description: "Installed plugin resource", source: "plugin", contentHash: "a".repeat(64),
    requiredTools: [], requiredRuntimeCapabilities: [] };
  const fixture = makeFixture({ skillStore: {
    catalog(_profileId, options) {
      return { registryRevision: "b".repeat(64), profileRevision: 1,
        items: enabled && options.allowPluginSkills ? [skill] : [], ineligible: [] };
    },
    read() { throw new Error("Not exercised by package resource read test"); },
    readResource(input) {
      calls.push(structuredClone(input));
      return { ...skill, relativePath: input.relativePath,
        fileHash: "c".repeat(64), content: "共😀享" };
    },
  } });
  const input = { name: skill.name, contentHash: skill.contentHash,
    relativePath: "shared/workflow.md", cursor: 0, maxBytes: 7 };
  await expectCode(() => fixture.controller.handle("plugin_resource_read", input,
    authorityFor("0")), "MCP_TOOL_NOT_FOUND");
  enabled = true;
  const capabilities = await fixture.controller.handle("app_capabilities", {}, authorityFor("a"));
  assert.equal(capabilities.currentAgent.tools.find(item => item.tool === "plugin_resource_read").availability,
    "available", "resource availability must use the storage facade's actual readResource method");
  const first = await fixture.controller.handle("plugin_resource_read", input, authorityFor("1"));
  assert.equal(first.content, "共😀");
  assert.equal(first.nextCursor, 2);
  assert.equal(first.relativePath, "shared/workflow.md");
  assert.equal(first.fileHash, "c".repeat(64));
  await expectCode(() => fixture.controller.handle("plugin_resource_read", {
    ...input, contentHash: "d".repeat(64),
  }, authorityFor("2")), "MCP_TOOL_NOT_FOUND");
  await expectCode(() => fixture.controller.handle("plugin_resource_read", {
    ...input, relativePath: "../shared/workflow.md",
  }, authorityFor("3")), "MCP_TOOL_INVALID_ARGUMENTS");
  await expectCode(() => fixture.controller.handle("plugin_resource_read", input,
    { ...authorityFor("4"), federationClient: "openclaw" }), "MCP_TOOL_NOT_FOUND");
  enabled = false;
  await expectCode(() => fixture.controller.handle("plugin_resource_read", input,
    authorityFor("5")), "MCP_TOOL_NOT_FOUND");
  assert.equal(calls.length, 1);
});

test("大型 Skill 目录按查询返回末尾匹配项，默认五条且不暴露未安装项", async () => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    id: `installed-${index}`, name: `installed-skill-${index}`,
    version: "1", description: index === 4_999 ? "rare telescope calibration" : "generic task",
    source: "plugin", contentHash: "a".repeat(64), requiredTools: [],
    requiredRuntimeCapabilities: [],
  }));
  const fixture = makeFixture({ skillStore: {
    catalog() { return { registryRevision: "b".repeat(64), profileRevision: 1,
      items, ineligible: [] }; },
    read() { throw new Error("An unselected Skill must not be read"); },
  } });
  const selected = await fixture.controller.handle("skill_catalog", {
    cursor: 0, query: "telescope calibration",
  }, authorityFor("1"));
  assert.deepEqual(selected.items.map(item => item.name), ["installed-skill-4999"]);
  assert.equal(selected.hasMore, false);
  const first = await fixture.controller.handle("skill_catalog", { cursor: 0 },
    authorityFor("2"));
  assert.equal(first.items.length, 5);
  assert.equal(first.nextCursor, 5);
  const absent = await fixture.controller.handle("skill_catalog", {
    cursor: 0, query: "uninstalled-private-connector",
  }, authorityFor("3"));
  assert.deepEqual(absent.items, []);
  await expectCode(() => fixture.controller.handle("skill_catalog", {
    cursor: 0, query: "x".repeat(257),
  }, authorityFor("4")), "MCP_TOOL_INVALID_ARGUMENTS");
});

test("联邦 Skill 目录不继承默认原生 Profile 的插件绑定", async () => {
  const calls = [];
  const fixture = makeFixture({
    skillStore: {
      catalog(_profileId, options) {
        calls.push(options.allowPluginSkills);
        return { registryRevision: "b".repeat(64), profileRevision: 1,
          items: options.allowPluginSkills ? [{
            id: "plugin-fixture", name: "plugin-fixture", version: "1",
            description: "Plugin fixture", source: "plugin", contentHash: "a".repeat(64),
            requiredTools: [], requiredRuntimeCapabilities: [],
          }] : [], ineligible: [] };
      },
      read() { throw new Error("Federation client must not read plugin Skill"); },
    },
  });
  const external = authority({ federationClient: "openclaw" });
  const catalog = await fixture.controller.handle("skill_catalog", { cursor: 0, limit: 10 }, external);
  assert.deepEqual(catalog.items, []);
  assert.deepEqual(calls, [false]);
});

test("产品安装入口经真实 PluginSkillFacade 安装通用包，并返回可用于下一次安装的 registryVersion", async () => {
  const { NativeSkillStore } = require("../app/agent-service/native-skill-store");
  const { PluginSkillFacade } = require("../app/agent-service/plugin-skill-facade");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-portable-product-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  const native = new NativeSkillStore({ paths });
  try {
    native.open([PROFILE_ID, OTHER_PROFILE_ID]);
    const skillStore = new PluginSkillFacade({ nativeStore: native,
      resolver: { listEnabledSkillDescriptors: () => [], inspectSkill() {}, inspectSkillFile() {} } });
    assert.equal(typeof skillStore.installGlobalFromDirectory, "function");
    const fixture = makeFixture({ skillStore });
    for (const [index, name] of ["portable-first", "portable-second"].entries()) {
      const source = path.join(root, name);
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "SKILL.md"), `---\nname: ${name}\ndescription: Portable product workflow.\n---\n\nInstructions.\n`);
      const catalog = await fixture.controller.handle("skill_catalog", { cursor: 0, limit: 10 },
        authorityFor(String(index + 3)));
      assert.equal(catalog.registryVersion, native.revision);
      const installed = await fixture.controller.handle("skill_install_global", {
        sourcePath: source, expectedRevision: catalog.registryVersion,
      }, authorityFor(String(index + 1)));
      assert.equal(installed.complete, true);
      assert.deepEqual(installed.enabledProfiles.sort(), [PROFILE_ID, OTHER_PROFILE_ID].sort());
    }
    native.close();
    native.open([PROFILE_ID, OTHER_PROFILE_ID]);
    assert.equal(native.catalog(PROFILE_ID).items.length, 2);
  } finally { native.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("全局 Skill 与共享 MCP 工具经同一产品入口供原生和联邦 Agent 使用", async () => {
  const extensionCalls = [];
  const server = {
    id: "fetch", name: "Fetch", command: "/Users/fixture/work/fetch",
    args: ["-m", "mcp_server_fetch"], cwd: "/Users/fixture/work", enabled: true,
  };
  let listedServers = [];
  const nativeMcpStore = {
    prepare(value) { extensionCalls.push(["prepare", structuredClone(value)]); return { ...value }; },
    list() { return { revision: 1, servers: listedServers }; },
    get() { return null; },
    register(value) {
      extensionCalls.push(["register", structuredClone(value)]);
      return { revision: 2, server: { ...value.server, createdAt: 1, updatedAt: 1 }, replaced: false };
    },
    remove(value) { extensionCalls.push(["remove", structuredClone(value)]); return { revision: 3, removed: { ...server } }; },
  };
  const nativeMcpClientManager = {
    async probe(value) { extensionCalls.push(["probe", structuredClone(value)]); return [{ name: "fetch", description: "Fetch", inputSchema: { type: "object" } }]; },
    async listTools(id) { extensionCalls.push(["tools", id]); return [{ name: "fetch", description: "Fetch", inputSchema: { type: "object" } }]; },
    async callTool(id, name, args) { extensionCalls.push(["call", id, name, structuredClone(args)]); return { content: [{ type: "text", text: "ok" }] }; },
    async closeServer(id) { extensionCalls.push(["close", id]); },
  };
  const skillStore = {
    catalog() { return { registryRevision: "a".repeat(64), profileRevision: 1, items: [], ineligible: [] }; },
    read() { throw new Error("not used"); },
    installGlobalFromDirectory(value) {
      extensionCalls.push(["skill.install", structuredClone(value)]);
      return { revision: 2, package: { id: "shared", name: "shared", version: "1.0.0" },
        enabledProfiles: value.profileIds, failedProfiles: [], availableToFutureProfiles: true, complete: true };
    },
  };
  const fixture = makeFixture({ nativeMcpStore, nativeMcpClientManager, skillStore });
  fixture.profiles.get(OTHER_PROFILE_ID).enabled = false;

  const installed = await fixture.controller.handle("skill_install_global", {
    sourcePath: "/Users/fixture/work/shared-skill", expectedRevision: 1,
  }, authorityFor("1"));
  assert.equal(installed.complete, true);
  assert.deepEqual(installed.enabledProfiles.sort(), [OTHER_PROFILE_ID, PROFILE_ID].sort());

  const registered = await fixture.controller.handle("mcp_server_register", {
    expectedRevision: 1, ...server,
  }, authorityFor("2"));
  assert.equal(registered.toolCount, 1);
  assert.deepEqual(registered.toolNames, ["fetch"]);
  assert.deepEqual(await fixture.controller.handle("mcp_server_tools", {
    serverId: "fetch", cursor: 0, limit: 20,
  }, authorityFor("3")), {
    serverId: "fetch", items: [{ name: "fetch", description: "Fetch", inputSchema: { type: "object" } }],
    nextCursor: 1, hasMore: false,
  });
  assert.deepEqual(await fixture.controller.handle("mcp_server_call", {
    serverId: "fetch", toolName: "fetch", arguments: { url: "https://example.com" },
  }, authorityFor("4")), {
    serverId: "fetch", toolName: "fetch", result: { content: [{ type: "text", text: "ok" }] },
  });
  await fixture.controller.handle("mcp_server_remove", { id: "fetch", expectedRevision: 2 }, authorityFor("5"));
  assert.equal(extensionCalls.some(([kind]) => kind === "skill.install"), true);
  assert.equal(extensionCalls.some(([kind]) => kind === "probe"), true);
  assert.equal(extensionCalls.some(([kind]) => kind === "call"), true);

  const external = authorityFor("6");
  external.federationClient = "openclaw";
  assert.deepEqual(await fixture.controller.handle("mcp_server_list", {}, external), {
    revision: 1, servers: [],
  });

  const restored = { id: "restored", name: "Restored", enabled: false,
    command: "/Users/old-machine/private/fixture-mcp", args: ["--stale-private-arg"],
    cwd: "/Users/old-machine/private", createdAt: 10, updatedAt: 20 };
  listedServers = [server, restored];
  for (const caller of [authorityFor("8"), { ...authorityFor("9"), federationClient: "hermes" }]) {
    const visible = await fixture.controller.handle("mcp_server_list", {}, caller);
    assert.deepEqual(visible.servers[0], server,
      "an active server retains the existing model-facing tool contract");
    assert.deepEqual(visible.servers[1], { id: "restored", name: "Restored",
      enabled: false, createdAt: 10, updatedAt: 20 });
    assert.equal(JSON.stringify(visible).includes("old-machine"), false);
    assert.equal(JSON.stringify(visible).includes("stale-private-arg"), false,
      "a restored MCP argument must not enter native or federated model context");
  }

  let hostileRegistered = false;
  const hostile = makeFixture({
    nativeMcpStore: {
      prepare(value) { return { ...value }; },
      list() { return { revision: 1, servers: [] }; },
      get() { return null; },
      register() { hostileRegistered = true; return { revision: 2 }; },
      remove() { throw new Error("not used"); },
    },
    nativeMcpClientManager: {
      async probe() { return [{ name: "fetch", inputSchema: null }]; },
      async listTools() { return []; },
      async callTool() { throw new Error("not used"); },
      async closeServer() {},
    },
  });
  await expectCode(() => hostile.controller.handle("mcp_server_register", {
    expectedRevision: 1, ...server,
  }, authorityFor("7")), "MCP_TOOL_RESPONSE_INVALID");
  assert.equal(hostileRegistered, false);
});

test("System Host 工具走 Service Controller，写操作 durable replay 且拒绝伪造响应", async () => {
  const calls = [];
  const application = {
    name: "Safari",
    bundleId: "com.apple.Safari",
    path: "/System/Applications/Safari.app",
  };
  const fixture = makeFixture({
    systemHostController: {
      search(input) { calls.push(["search", structuredClone(input)]); return { applications: [application] }; },
      launch(input) { calls.push(["launch", structuredClone(input)]); return { application, launched: true }; },
      openUrl(input) { calls.push(["url", structuredClone(input)]); return { url: input.url, opened: true }; },
      openFolder(input) {
        calls.push(["folder", structuredClone(input)]);
        return { path: "/Users/test/Downloads", selected: null, opened: true };
      },
    },
  });
  assert.deepEqual(await fixture.controller.handle(
    "system_application_search", { query: "Safari" }, authorityFor("d"),
  ), { applications: [application] });
  const launchAuthority = authorityFor("e");
  const launched = await fixture.controller.handle(
    "system_application_launch", { bundleId: "com.apple.Safari" }, launchAuthority,
  );
  assert.deepEqual(await fixture.controller.handle(
    "system_application_launch", { bundleId: "com.apple.Safari" }, launchAuthority,
  ), launched);
  assert.equal(calls.filter(([kind]) => kind === "launch").length, 1);
  assert.deepEqual(await fixture.controller.handle(
    "system_open_url", { url: "https://example.com/" }, authorityFor("f"),
  ), { url: "https://example.com/", opened: true });
  assert.deepEqual(await fixture.controller.handle(
    "finder_open_folder", { path: "~/Downloads" }, authorityFor("1"),
  ), { path: "/Users/test/Downloads", selected: null, opened: true });
  assert.deepEqual(calls.find(([kind]) => kind === "folder")[1], {
    path: "~/Downloads", select: null,
  });

  await expectCode(() => fixture.controller.handle(
    "system_application_launch", { bundleId: "com.apple.Safari", applicationPath: application.path },
    authorityFor("2"),
  ), "MCP_TOOL_INVALID_ARGUMENTS");
  const hostile = makeFixture({
    systemHostController: {
      search() { return { applications: [{ ...application, path: "relative.app" }] }; },
      launch() { throw Object.assign(new Error("private Launch Services detail"), { code: "SYSTEM_HOST_FAILED" }); },
      openUrl() { return { url: "file:///etc/passwd", opened: true }; },
      openFolder() { return { path: "relative", selected: null, opened: true }; },
    },
  });
  await expectCode(() => hostile.controller.handle(
    "system_application_search", { query: "Safari", limit: 10 }, authorityFor("3"),
  ), "MCP_TOOL_RESPONSE_INVALID");
  await expectCode(() => hostile.controller.handle(
    "system_application_launch", { bundleId: "com.apple.Safari" }, authorityFor("4"),
  ), "MCP_TOOL_UNAVAILABLE");
});

test("Computer Use 绑定当前 WorkRun、确认边界与单次 snapshot revision", async () => {
  const calls = [];
  const session = {
    id: "89898989-8989-4989-8989-898989898989",
    profileId: PROFILE_ID,
    workRunId: RUN_ID,
    allowedApplications: ["com.apple.TextEdit"],
    status: "ready",
    createdAt: 5_000,
    updatedAt: 5_000,
    expiresAt: 65_000,
    pauseReason: null,
  };
  const computerUseController = {
    status(profileId) {
      calls.push(["status", profileId]);
      return { available: true, permissions: { accessibility: true, screenRecording: true }, sessions: [] };
    },
    create(input) { calls.push(["create", structuredClone(input)]); return { ...session }; },
    resume(input) { calls.push(["resume", structuredClone(input)]); return { ...session }; },
    closeSession(input) { calls.push(["close", structuredClone(input)]); return { sessionId: input.sessionId, closed: true }; },
    applicationList(input) { calls.push(["apps", structuredClone(input)]); return { sessionId: input.sessionId, applications: [] }; },
    windowList(input) { calls.push(["windows", structuredClone(input)]); return { sessionId: input.sessionId, windows: [] }; },
    snapshot(input) {
      calls.push(["snapshot", structuredClone(input)]);
      return { sessionId: input.sessionId, snapshotRevision: "revision-1", pid: input.pid, windowId: input.windowId, tree: "", elements: [], degraded: false, image: null };
    },
    focus(input) { calls.push(["focus", structuredClone(input)]); return { sessionId: input.sessionId, requiresFreshSnapshot: true }; },
    action(input) {
      calls.push(["action", structuredClone(input)]);
      if (input.snapshotRevision === "stale-revision") {
        throw Object.assign(new Error("private stale detail"), { code: "COMPUTER_SNAPSHOT_STALE" });
      }
      return { sessionId: input.sessionId, action: input.action, attempted: true, requiresFreshSnapshot: true };
    },
  };
  const fixture = makeFixture({ computerUseController });
  const source = { source: "kanban", sourceId: CARD_ID };
  assert.equal(validateMcpProductToolArguments("computer_session_open", { ...source,
    allowedApplications: ["com.apple.TextEdit"] }), true);
  assert.equal(validateMcpProductToolArguments("computer_session_open", { ...source,
    allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 900 }), false);
  assert.equal(validateMcpProductToolArguments("browser_session_open", source), true);
  assert.equal(validateMcpProductToolArguments("browser_session_open", { ...source, expiresInSeconds: 900 }), false);
  assert.equal((await fixture.controller.handle("computer_status", {}, authorityFor("1"))).available, true);
  await expectCode(() => fixture.controller.handle("computer_session_open", {
    ...source, allowedApplications: ["com.apple.TextEdit"],
  }, authority()), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.deepEqual(await fixture.controller.handle("computer_session_open", {
    ...source, allowedApplications: ["com.apple.TextEdit"],
  }, authorityFor("2")), session);
  assert.deepEqual(calls.find(([kind]) => kind === "create")[1], {
    profileId: PROFILE_ID,
    workRunId: RUN_ID,
    allowedApplications: ["com.apple.TextEdit"],
  });
  const snapshot = await fixture.controller.handle("computer_snapshot", {
    ...source, sessionId: session.id, pid: 42, windowId: 7,
  }, authorityFor("3"));
  assert.equal(snapshot.snapshotRevision, "revision-1");
  const clicked = await fixture.controller.handle("computer_click", {
    ...source, sessionId: session.id, snapshotRevision: "revision-1", pid: 42, windowId: 7,
    ref: "c1", x: null, y: null,
  }, authorityFor("4"));
  assert.equal(clicked.action, "click");
  assert.deepEqual(calls.find(([kind]) => kind === "action")[1], {
    sessionId: session.id,
    profileId: PROFILE_ID,
    workRunId: RUN_ID,
    snapshotRevision: "revision-1",
    pid: 42,
    windowId: 7,
    ref: "c1",
    x: null,
    y: null,
    action: "click",
  });
  await expectCode(() => fixture.controller.handle("computer_click", {
    ...source, sessionId: session.id, snapshotRevision: "stale-revision", pid: 42, windowId: 7,
    ref: "c1", x: null, y: null,
  }, authorityFor("5")), "COMPUTER_SNAPSHOT_STALE");
  assert.equal(validateMcpProductToolArguments("computer_type", {
    ...source, sessionId: session.id, snapshotRevision: "revision-1", pid: 42, windowId: 7,
    ref: "c2", text: "hello",
  }), true);
  assert.equal(validateMcpProductToolArguments("computer_click", {
    ...source, sessionId: session.id, snapshotRevision: "revision-1", pid: 42, windowId: 7,
    ref: "c1", x: 10, y: 10,
  }), false);
});

test("Computer snapshot 在 Service 边界先省略重复 tree 并保留图像与可操作 refs", async () => {
  const sessionId = "89898989-8989-4989-8989-898989898989";
  const thumbnail = Buffer.alloc(27 * 1024, 0x5a).toString("base64");
  const elements = Array.from({ length: 138 }, (_, index) => ({
    ref: `c${index + 1}`,
    role: "AXTextField",
    label: `control-${index}`,
    value: `value-${index}`,
    frame: { x: index, y: index, width: 100, height: 24 },
    secure: false,
  }));
  const rawSnapshot = {
    sessionId,
    snapshotRevision: "revision-large",
    pid: 42,
    windowId: 7,
    tree: "tree-line\n".repeat(1_200),
    elements,
    degraded: false,
    image: {
      mimeType: "image/png",
      thumbnailMimeType: "image/jpeg",
      thumbnail,
      artifact: {
        id: "69696969-6969-4969-8969-696969696969",
        storageKey: "abc/image.png",
        sizeBytes: 1_600_000,
        sha256: "b".repeat(64),
      },
    },
  };
  assert(Buffer.byteLength(JSON.stringify({
    id: "\0".repeat(256), ok: true, result: rawSnapshot,
  })) > 64 * 1024);
  const computerUseController = {
    status() { return { available: true, permissions: {}, sessions: [] }; },
    create() { throw new Error("unexpected create"); },
    resume() { throw new Error("unexpected resume"); },
    closeSession() { throw new Error("unexpected close"); },
    applicationList() { return { sessionId, applications: [] }; },
    windowList() { return { sessionId, windows: [] }; },
    snapshot() { return structuredClone(rawSnapshot); },
    focus() { throw new Error("unexpected focus"); },
    action() { throw new Error("unexpected action"); },
  };
  const fixture = makeFixture({ computerUseController });
  const result = await fixture.controller.handle("computer_snapshot", {
    source: "kanban", sourceId: CARD_ID, sessionId, pid: 42, windowId: 7,
  }, authorityFor("6"));
  assert(Buffer.byteLength(JSON.stringify({
    id: "\0".repeat(256), ok: true, result,
  })) <= 64 * 1024);
  assert.equal(result.tree, "");
  assert.equal(result.image.thumbnail, thumbnail);
  assert.equal(result.elements.length, elements.length);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.outputTruncated, {
    tree: true,
    inlineImage: false,
    originalElementCount: elements.length,
    returnedElementCount: elements.length,
  });
});

test("新增 Kanban/Cron 路由使用 Service 生成的 operation/time 并 exact replay", async () => {
  const domainCalls = [];
  const domainController = {
    async handle(method, params) {
      domainCalls.push([method, structuredClone(params)]);
      if (method === "kanban.card.create") {
        return {
          method,
          id: params.boardId,
          card: cardDto(card({
            boardId: params.boardId,
            profileId: params.profileId,
            title: params.title,
            body: params.body,
            status: params.status,
            position: params.position,
            createdAt: params.createdAt,
            updatedAt: params.createdAt,
          })),
        };
      }
      return { method, id: params.boardId || params.cardId || params.jobId || "created" };
    },
  };
  const fixture = makeFixture({ domainController });
  const cases = [
    ["kanban_board_create", { slug: "qa-board", name: "QA", description: null }, "kanban.board.create", "a"],
    ["kanban_board_update", { boardId: BOARD_ID, patch: { description: "updated" } }, "kanban.board.update", "b"],
    ["kanban_card_create", { boardId: BOARD_ID, title: "Card", body: null, position: 0 }, "kanban.card.create", "c"],
    ["kanban_card_update", { cardId: CARD_ID, patch: { title: "Updated" } }, "kanban.card.update", "d"],
    ["kanban_card_move", { cardId: CARD_ID, status: "queued" }, "kanban.card.status.set", "e"],
    ["kanban_run_dispatch", { cardId: CARD_ID, workspace: null }, "kanban.run.dispatch", "f"],
    ["kanban_run_retry", { cardId: CARD_ID, runId: RUN_ID, workspace: null }, "kanban.run.retry", "1"],
    ["cron_create", {
      name: "QA cron", prompt: "check", workspace: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 }, enabled: false,
      misfirePolicy: "latest", maxCatchUp: 1, overlapPolicy: "skip",
    }, "cron.job.create", "2"],
    ["cron_update", { jobId: JOB_ID, patch: { prompt: "updated" } }, "cron.job.update", "3"],
    ["cron_set_enabled", { jobId: JOB_ID, enabled: false }, "cron.job.enabled.set", "4"],
    ["cron_delete", { jobId: JOB_ID }, "cron.job.delete", "5"],
    ["cron_run_now", { jobId: JOB_ID }, "cron.run.trigger", "6"],
  ];
  for (const [name, args, expectedMethod, unit] of cases) {
    const trusted = authorityFor(unit);
    const first = await fixture.controller.handle(name, args, trusted);
    assert.equal(first.method, expectedMethod);
    assert.deepEqual(await fixture.controller.handle(name, args, trusted), first);
    const matching = domainCalls.filter(([method]) => method === expectedMethod);
    assert.equal(matching.length, 1, `${name} exact replay`);
    assert.match(matching[0][1].operationId, /^mcp-v1-[a-f0-9]{48}$/u);
    assert.equal(matching[0][1].createdAt, 5_000);
    assert.equal(Object.hasOwn(matching[0][1], "profileId") ? matching[0][1].profileId : PROFILE_ID,
      PROFILE_ID);
    if (name === "cron_create") {
      assert.equal(matching[0][1].threadPolicy, "continue");
      assert.equal(matching[0][1].threadId, null);
    }
  }

  const readCases = [
    ["kanban_board_get", { boardId: BOARD_ID }, "kanban.board.get", "7"],
    ["kanban_run_list", { cardId: CARD_ID, status: null, cursor: null, limit: 10 }, "kanban.run.list", "8"],
    ["cron_run_list", { jobId: JOB_ID, status: null, cursor: null, limit: 10 }, "cron.run.list", "9"],
  ];
  for (const [name, args, expectedMethod, unit] of readCases) {
    const result = await fixture.controller.handle(name, args, authorityFor(unit));
    assert.equal(result.method, expectedMethod);
  }

  fixture.runs.set(RUN_ID, run({ source: "cron", sourceId: JOB_ID, retryOf: "older-run" }));
  const retryArgs = { jobId: JOB_ID, runId: RUN_ID };
  const retried = await fixture.controller.handle("cron_run_retry", retryArgs, authorityFor("0"));
  assert.equal(retried.method, "cron.run.retry");
  assert.deepEqual(domainCalls.find(([method]) => method === "cron.run.retry")[1], {
    operationId: ledgerOperationId("cron_run_retry", retryArgs, authorityFor("0").callId),
    jobId: JOB_ID,
    retryOf: RUN_ID,
    createdAt: 5_000,
  });
});

test("联邦状态、Agent 管理与委派走固定方法，写入 preflight 且 exact replay", async () => {
  const federationCalls = [];
  const federationClient = {
    async request(method, params) {
      federationCalls.push([method, structuredClone(params)]);
      if (method === "backend.status") return { backends: [
        { id: "openclaw", connected: true, disabled: false },
        { id: "hermes", connected: false, disabled: true },
      ] };
      if (method === "backend.require") return { backend: { id: params.backendId, connected: true } };
      if (method === "agent.list") return { backendId: params.backendId, agents: [] };
      if (method === "cron.list") return {
        backendId: params.backendId,
        total: 1,
        jobs: [{ id: "cron-1", backendId: params.backendId, name: "Fixture cron" }],
      };
      if (method === "agent.get") return { agent: {
        id: params.agentId, backendId: params.backendId, name: "Fixture agent",
      } };
      if (method === "agent.create") return { agent: {
        id: "created-agent", backendId: params.backendId, name: params.spec.name,
      } };
      if (method === "agent.update") return { agent: {
        id: params.agentId, backendId: params.backendId, name: params.patch.name || "Fixture agent",
      } };
      if (method === "agent.delete") return {
        backendId: params.backendId, agentId: params.agentId, deleted: true,
      };
      if (method === "agent.file.list") return { files: [{ name: "AGENTS.md" }] };
      if (method === "agent.file.read" || method === "agent.file.write") return { file: {
        name: params.file, content: params.content ?? "existing", missing: false,
      } };
      if (method === "agent.channels") return { channels: [] };
      if (method === "agent.artifacts") return { artifacts: { supported: true, items: [] } };
      if (method === "agent.run") return {
        backendId: params.backendId, agentId: params.agentId,
        sessionKey: "session-1", text: "delegated",
      };
      throw new Error(`unexpected ${method}`);
    },
  };
  const fixture = makeFixture({ federationClient });
  assert.equal((await fixture.controller.handle("backend_status", {}, authorityFor("a")))
    .backends[1].disabled, true);
  assert.deepEqual(await fixture.controller.handle("external_agent_list", {
    backendId: "openclaw",
  }, authorityFor("b")), { backendId: "openclaw", agents: [] });
  assert.deepEqual(await fixture.controller.handle("external_cron_list", {
    backendId: "openclaw", enabled: null, limit: 10,
  }, authorityFor("0")), {
    backendId: "openclaw", total: 1,
    jobs: [{ id: "cron-1", backendId: "openclaw", name: "Fixture cron" }],
  });
  assert.equal(validateMcpProductToolArguments("external_cron_list", {
    backendId: "openclaw", enabled: null, limit: 10,
  }), true);
  assert.equal(validateMcpProductToolArguments("external_cron_list", {
    backendId: "openclaw", enabled: null, limit: 101,
  }), false);

  const cases = [
    ["external_agent_create", { backendId: "openclaw", spec: {
      name: "Created", workspace: "/tmp/created",
    } }, "agent.create", "c"],
    ["external_agent_update", {
      backendId: "openclaw", agentId: "agent-1", patch: { name: "Updated" },
    }, "agent.update", "d"],
    ["external_agent_delete", {
      backendId: "hermes", agentId: "agent-2",
    }, "agent.delete", "e"],
    ["external_agent_file_write", {
      backendId: "openclaw", agentId: "agent-1", file: "AGENTS.md", content: "new body",
    }, "agent.file.write", "f"],
    ["external_agent_run", {
      backendId: "openclaw", agentId: "agent-1", prompt: "do work", timeoutMs: 5_000,
    }, "agent.run", "1"],
  ];
  for (const [name, args, method, unit] of cases) {
    const trusted = authorityFor(unit);
    const first = await fixture.controller.handle(name, args, trusted);
    assert.deepEqual(await fixture.controller.handle(name, args, trusted), first);
    assert.equal(federationCalls.filter(([called]) => called === method).length, 1, `${name} replay`);
    const write = federationCalls.find(([called]) => called === method)[1];
    assert.match(write.operationId, /^mcp-v1-[a-f0-9]{48}$/u);
  }
  assert.equal(federationCalls.filter(([method]) => method === "backend.require").length, 1);
  assert.equal(federationCalls.filter(([method]) => method === "agent.get").length, 4);

  assert.equal(validateMcpProductToolArguments("external_agent_update", {
    backendId: "openclaw", agentId: "agent-1", patch: { cloneFromDefault: true },
  }), false);

  const secretFixture = makeFixture({
    federationClient: { async request() { return { backends: [{ token: "fixture-secret-canary" }] }; } },
    isSensitiveValue: (value) => String(value).includes("fixture-secret-canary"),
  });
  await expectCode(() => secretFixture.controller.handle("backend_status", {}, authorityFor("2")),
    "MCP_TOOL_SECRET_REJECTED");
});

test("统一联邦工具把目录、异步派活、查询、续聊与取消交给同一协调器", async () => {
  const coordinatorCalls = [];
  const task = (turn, status = "running") => ({
    agent: { backendId: "shoggoth", agentId: "agent-other", name: "Other", kind: "native",
      connected: true, model: null, provider: null },
    task: { taskId: `task-${turn}`, sessionKey: "session-federated", status, turn,
      waitingFor: null, result: null, errorCode: null },
    handle: `handle-${turn}`,
  });
  const federationCoordinator = {
    async list(args, trusted) {
      coordinatorCalls.push(["list", structuredClone(args), structuredClone(trusted)]);
      return { agents: [task(1).agent], unavailableBackends: [] };
    },
    async get(args, trusted) {
      coordinatorCalls.push(["get", structuredClone(args), structuredClone(trusted)]);
      return { agent: task(1).agent };
    },
    async run(args, trusted) {
      coordinatorCalls.push(["run", structuredClone(args), structuredClone(trusted)]);
      return task(1);
    },
    async message(args, trusted) {
      coordinatorCalls.push(["message", structuredClone(args), structuredClone(trusted)]);
      return task(2);
    },
    async taskGet(args, trusted) {
      coordinatorCalls.push(["taskGet", structuredClone(args), structuredClone(trusted)]);
      return task(2, "completed");
    },
    async cancel(args, trusted) {
      coordinatorCalls.push(["cancel", structuredClone(args), structuredClone(trusted)]);
      return task(2, "canceled");
    },
  };
  const fixture = makeFixture({ federationCoordinator });
  const externalAuthority = authorityFor("a");
  externalAuthority.federationClient = "openclaw";
  const listed = await fixture.controller.handle(
    "federation_agent_list", {}, externalAuthority,
  );
  assert.equal(listed.agents[0].agentId, "agent-other");
  assert.equal(coordinatorCalls[0][2].federationClient, "openclaw");
  assert.equal((await fixture.controller.handle("federation_agent_get", {
    backendId: "shoggoth", agentId: "agent-other",
  }, authorityFor("b"))).agent.kind, "native");

  const runArgs = {
    backendId: "shoggoth", agentId: "agent-other", prompt: "do work", timeoutMs: 5_000,
  };
  const started = await fixture.controller.handle("federation_agent_run", runArgs, authorityFor("c"));
  assert.deepEqual(await fixture.controller.handle(
    "federation_agent_run", runArgs, authorityFor("c"),
  ), started);
  assert.equal(coordinatorCalls.filter(([method]) => method === "run").length, 1);
  const runCall = coordinatorCalls.find(([method]) => method === "run")[1];
  assert.match(runCall.operationId, /^mcp-v1-[a-f0-9]{48}$/u);
  assert.equal(runCall.createdAt, 5_000);

  const continued = await fixture.controller.handle("federation_agent_message", {
    handle: started.handle, message: "continue", timeoutMs: 5_000,
  }, authorityFor("d"));
  assert.equal(continued.task.turn, 2);
  assert.equal((await fixture.controller.handle("federation_task_get", {
    handle: continued.handle,
  }, authorityFor("e"))).task.status, "completed");
  assert.equal((await fixture.controller.handle("federation_task_cancel", {
    handle: continued.handle,
  }, authorityFor("f"))).task.status, "canceled");
  assert.deepEqual(coordinatorCalls[0][1], { backendId: null });
  assert.equal(validateMcpProductToolArguments("federation_agent_list", {}), true);
  assert.equal(validateMcpProductToolArguments("federation_agent_list", { backendId: null }), true);
  assert.equal(validateMcpProductToolArguments("federation_agent_list", {
    backendId: "openclaw",
  }), true);
  assert.equal(validateMcpProductToolArguments("federation_agent_get", {
    backendId: "Bad", agentId: "agent-other",
  }), false);
});

test("联邦认证与模型失败穿过 MCP 边界且只保留静态说明，原操作不重放", async () => {
  for (const code of ["AGENT_AUTH_REQUIRED", "AGENT_MODEL_UNAVAILABLE", "AGENT_QUOTA_EXHAUSTED",
    "AGENT_CONTEXT_LIMIT", "AGENT_PERMISSION_DENIED", "AGENT_NETWORK_UNAVAILABLE"]) {
    let calls = 0;
    const fixture = makeFixture({ federationCoordinator: {
      list() {}, get() {}, message() {}, taskGet() {}, cancel() {}, async run() {
      calls++;
      throw Object.assign(new Error("fixture-secret-canary provider response"), { code });
    } } });
    const args = { backendId: "hermes", agentId: "hermes-bull", prompt: "do work", timeoutMs: 5000 };
    try {
      await expectCode(() => fixture.controller.handle("federation_agent_run", args, authorityFor("a")), code);
      await expectCode(() => fixture.controller.handle("federation_agent_run", args, authorityFor("a")), code);
      assert.equal(calls, 1, "the failed operation receipt prevents replay");
    } finally { fs.rmSync(fixture.artifactRoot, { recursive: true, force: true }); }
  }
});

test("所有不可信 args/authority 在零依赖触碰前 exact validation", async () => {
  const { controller, calls } = makeFixture();
  for (const [name, args, trusted] of [
    ["profile_get", { profileId: PROFILE_ID }, authority()],
    ["runtime_context_get", { source: "kanban", sourceId: CARD_ID, profileId: PROFILE_ID }, authority()],
    ["run_get", { runId: RUN_ID, operationId: "model" }, authority()],
    ["kanban_request_complete", { cardId: CARD_ID, runId: RUN_ID }, authority()],
    ["unknown", {}, authority()],
    ["profile_get", {}, { ...authority(), actor: "agent" }],
    ["profile_get", {}, { ...authority(), createdAt: 1 }],
    ["profile_get", {}, authority({ callId: "not-a-uuid" })],
  ]) await expectCode(() => controller.handle(name, args, trusted), "MCP_TOOL_INVALID_ARGUMENTS");
  assert.deepEqual(calls, []);
});

test("profile_get 仅返回当前授权 Profile 的公共 DTO", async () => {
  const { controller } = makeFixture();
  const result = await controller.handle("profile_get", {}, authority());
  assert.equal(result.id, PROFILE_ID);
  assert.equal(result.name, "Fixture");
  for (const hidden of ["backendId", "runtime", "providerRef", "createdAt", "updatedAt"]) {
    assert.equal(Object.hasOwn(result, hidden), false);
  }
});

test("runtime_context_get 只返回当前授权 WorkRun 冻结的有效模型", async () => {
  const fixture = makeFixture();
  assert.deepEqual(await fixture.controller.handle(
    "runtime_context_get", { source: "kanban", sourceId: CARD_ID }, authority(),
  ), {
    runId: RUN_ID,
    source: "kanban",
    profileDefaultModel: "gpt-5.6-sol",
    sessionModelOverride: null,
    effectiveModel: "gpt-5.6-sol",
    scope: "current-turn",
  });
  await expectCode(() => fixture.controller.handle(
    "runtime_context_get", { runId: "stale-cached-run" }, authorityFor("c"),
  ), "MCP_TOOL_INVALID_ARGUMENTS");
  fixture.runtimeContexts.set(`${PROFILE_ID}:cron:${JOB_ID}`, {
    runId: "run-concurrent",
    profileId: PROFILE_ID,
    source: "cron",
    sourceId: JOB_ID,
    profileDefaultModel: "gpt-5.6-sol",
    sessionModelOverride: null,
    effectiveModel: "gpt-5.6-sol",
  });
  await expectCode(() => fixture.controller.handle(
    "runtime_context_get", { runId: "stale-cached-run" }, authorityFor("d"),
  ), "MCP_TOOL_INVALID_ARGUMENTS");
  fixture.runtimeContexts.delete(`${PROFILE_ID}:cron:${JOB_ID}`);
  fixture.runtimeContexts.set(`${PROFILE_ID}:kanban:${OTHER_CARD_ID}`, {
    runId: OTHER_RUN_ID,
    profileId: OTHER_PROFILE_ID,
    source: "kanban",
    sourceId: OTHER_CARD_ID,
    profileDefaultModel: "gpt-5.6-sol",
    sessionModelOverride: null,
    effectiveModel: "gpt-5.6-sol",
  });
  await expectCode(() => fixture.controller.handle(
    "runtime_context_get", { source: "kanban", sourceId: OTHER_CARD_ID }, authorityFor("a"),
  ), "MCP_TOOL_NOT_FOUND");
  await expectCode(() => fixture.controller.handle(
    "runtime_context_get", { source: "cron", sourceId: "missing-job" }, authorityFor("b"),
  ), "MCP_TOOL_NOT_FOUND");
});

test("Kanban list/get 复用 DomainController、绑定 Board/Card Profile 且正文只分块返回", async () => {
  const { controller, calls, cards } = makeFixture();
  const boards = await controller.handle("kanban_list", {
    kind: "boards", boardId: null, status: null, cursor: null, limit: 10,
  }, authority());
  assert.equal(boards.kind, "boards");
  assert.equal(boards.items[0].id, BOARD_ID);
  const listed = await controller.handle("kanban_list", {
    kind: "cards", boardId: BOARD_ID, status: "running", cursor: null, limit: 10,
  }, authorityFor("a"));
  assert.equal(listed.kind, "cards");
  assert.equal(Object.hasOwn(listed.items[0], "body"), false);
  const fetched = await controller.handle("kanban_get", {
    cardId: CARD_ID, cursor: null, maxBytes: 1024,
  }, authorityFor("b"));
  assert.equal(fetched.body.chunk, "card body 😀");
  assert.equal(Object.hasOwn(fetched.card, "body"), false);
  assert(calls.some((entry) => entry[0] === "domain" && entry[1] === "kanban.card.list"
    && entry[2].boardId === BOARD_ID));
  cards.set(CARD_ID, card({ profileId: OTHER_PROFILE_ID }));
  const before = calls.length;
  await expectCode(() => controller.handle("kanban_get", {
    cardId: CARD_ID, cursor: null, maxBytes: 1024,
  }, authorityFor("c")), "MCP_TOOL_NOT_FOUND");
  assert.deepEqual(calls.slice(before).map((entry) => entry[0]), [
    "profile.get", "mcp.lookup", "card.get",
  ], "cross-profile 在 authority/call lookup 后只做一次 Card lookup，绝不进入 Domain");
});

test("comment/progress 使用 Service 绑定的 operation/time，progress 只追加 RunNote", async () => {
  const { controller, calls, addedNotes, cards, profiles } = makeFixture();
  const commentArgs = { cardId: CARD_ID, body: "agent comment" };
  const commentResult = await controller.handle("kanban_add_comment", commentArgs, authority());
  assert.equal(commentResult.comment.authorType, "agent");
  assert.equal(Object.hasOwn(commentResult.comment, "body"), false);
  const commentCall = calls.find((entry) => entry[0] === "comment.add")[1];
  assert.deepEqual(commentCall, {
    operationId: ledgerOperationId("kanban_add_comment", commentArgs),
    cardId: CARD_ID,
    authorType: "agent",
    authorId: PROFILE_ID,
    body: "agent comment",
    createdAt: 5_000,
  });

  const progress = await controller.handle("kanban_update_progress", {
    cardId: CARD_ID, runId: RUN_ID, message: "halfway", percent: 50,
  }, authority({ callId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  assert.equal(progress.note.kind, "progress");
  assert.equal(progress.note.percent, 50);
  assert.equal(addedNotes.length, 1);
  assert.equal(calls.some((entry) => entry[0] === "completion.request"), false);
  assert.equal(calls.some((entry) => entry[0] === "domain"
    && entry[1] === "kanban.card.status.set"), false);
  const commentWrites = calls.filter((entry) => entry[0] === "comment.add").length;
  cards.delete(CARD_ID);
  profiles.delete(PROFILE_ID);
  assert.deepEqual(await controller.handle("kanban_add_comment", commentArgs, authority()), commentResult,
    "completed replay 不受 Profile/Card 后续删除影响");
  assert.equal(calls.filter((entry) => entry[0] === "comment.add").length, commentWrites);
});

test("durable write 在 preflight 后的 known failure 冻结公开错误，pending 用首次时间恢复", async () => {
  const failed = makeFixture();
  let commentAttempts = 0;
  failed.dependencies.kanbanStore.addComment = () => {
    commentAttempts += 1;
    throw Object.assign(new Error("raw state changed"), { code: "KANBAN_STATUS_TRANSITION_INVALID" });
  };
  const args = { cardId: CARD_ID, body: "known failure" };
  await expectCode(() => failed.controller.handle("kanban_add_comment", args, authority()),
    "MCP_TOOL_STATE_CONFLICT");
  failed.cards.delete(CARD_ID);
  await expectCode(() => failed.controller.handle("kanban_add_comment", args, authority()),
    "MCP_TOOL_STATE_CONFLICT");
  assert.equal(commentAttempts, 1);
  assert.equal([...failed.mcpCalls.values()][0].result.publicCode, "MCP_TOOL_STATE_CONFLICT");

  const pending = makeFixture();
  const pendingArgs = { cardId: CARD_ID, body: "resume pending" };
  const fingerprint = fingerprintMcpToolCall("kanban_add_comment", pendingArgs);
  const record = pending.dependencies.productStore.beginMcpToolCall({
    profileId: PROFILE_ID,
    callId: CALL_ID,
    name: "kanban_add_comment",
    fingerprint,
    binding: null,
    createdAt: 321,
  });
  pending.profiles.delete(PROFILE_ID);
  const resumed = await pending.controller.handle("kanban_add_comment", pendingArgs, authority());
  assert.equal(resumed.comment.id, COMMENT_ID);
  const write = pending.calls.find((entry) => entry[0] === "comment.add")[1];
  assert.equal(write.createdAt, 321);
  assert.equal(write.operationId, record.operationId);
});

test("request_complete 不接受 runId，只选择最新且唯一 active authoritative link", async () => {
  const fixture = makeFixture();
  const result = await fixture.controller.handle("kanban_request_complete", { cardId: CARD_ID }, authority());
  assert.equal(result.card.id, CARD_ID);
  assert.deepEqual(fixture.calls.find((entry) => entry[0] === "completion.request")[1], {
    operationId: ledgerOperationId("kanban_request_complete", { cardId: CARD_ID }),
    cardId: CARD_ID, runId: RUN_ID, createdAt: 5_000,
  });

  fixture.links.push({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cardId: CARD_ID,
    runId: "run-second-active",
    retryOf: RUN_ID,
    createdAt: 11,
  });
  fixture.runs.set("run-second-active", run({ id: "run-second-active", retryOf: RUN_ID }));
  await expectCode(
    () => fixture.controller.handle("kanban_request_complete", { cardId: CARD_ID }, authority({
      callId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    })),
    "MCP_TOOL_STATE_CONFLICT",
  );
  assert.equal(fixture.calls.filter((entry) => entry[0] === "completion.request").length, 1);
});

test("Cron list/get 与 Run get 均绑定 Profile，Run DTO 移除 workspace/thread/idempotency", async () => {
  const { controller, jobs, runs } = makeFixture();
  const listed = await controller.handle("cron_list", {
    enabled: true, cursor: null, limit: 10,
  }, authority());
  assert.equal(listed.items[0].id, JOB_ID);
  assert.equal(Object.hasOwn(listed.items[0], "prompt"), false);
  const fetched = await controller.handle("cron_get", {
    jobId: JOB_ID, cursor: null, maxBytes: 1024,
  }, authorityFor("a"));
  assert.equal(fetched.prompt.chunk, "cron prompt");
  const runResult = await controller.handle("run_get", { runId: RUN_ID }, authorityFor("b"));
  for (const hidden of ["profileId", "workspace", "idempotencyKey", "codexThreadId", "codexTurnId",
    "waitingRequestId"]) assert.equal(Object.hasOwn(runResult.run, hidden), false);
  jobs.set(JOB_ID, job({ profileId: OTHER_PROFILE_ID }));
  await expectCode(() => controller.handle("cron_get", {
    jobId: JOB_ID, cursor: null, maxBytes: 1024,
  }, authorityFor("c")), "MCP_TOOL_NOT_FOUND");
  runs.set(RUN_ID, run({ profileId: OTHER_PROFILE_ID }));
  await expectCode(() => controller.handle("run_get", { runId: RUN_ID }, authorityFor("d")),
    "MCP_TOOL_NOT_FOUND");
});

test("run_add_note 使用 callId 派生稳定 ID，并由 ProductStore exact replay", async () => {
  const { controller, calls } = makeFixture();
  const first = await controller.handle("run_add_note", { runId: RUN_ID, body: "note body" }, authority());
  const second = await controller.handle("run_add_note", { runId: RUN_ID, body: "note body" }, authority());
  assert.deepEqual(second, first);
  assert.match(first.note.id, /^mcp-note-[a-f0-9]{48}$/u);
  assert.deepEqual(calls.filter((entry) => entry[0] === "note.add").map((entry) => entry[1]), [
    first.note,
  ]);
});

test("artifact_publish 从 authoritative workspace 安全复制、hash 后才写 Store 引用", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-"));
  const nested = path.join(workspace, "reports");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "result.txt"), "artifact 😀", { mode: 0o600 });
  const fixture = makeFixture();
  fixture.runs.set(RUN_ID, run({ workspace }));
  const result = await fixture.controller.handle("artifact_publish", {
    runId: RUN_ID,
    relativePath: "reports/result.txt",
    name: "result.txt",
    kind: "file",
    mimeType: "text/plain",
  }, authority());
  assert.equal(result.artifact.id, ARTIFACT_ID);
  assert.equal(result.artifact.sha256,
    crypto.createHash("sha256").update("artifact 😀").digest("hex"));
  const call = fixture.calls.find((entry) => entry[0] === "artifact.add")[1];
  const copied = path.join(path.dirname(fixture.artifactRoot), call.storageKey);
  assert.equal(fs.readFileSync(copied, "utf8"), "artifact 😀");
  assert.equal(fs.statSync(copied).mode & 0o077, 0);
  assert.equal(call.operationId, ledgerOperationId("artifact_publish", {
    runId: RUN_ID,
    relativePath: "reports/result.txt",
    name: "result.txt",
    kind: "file",
    mimeType: "text/plain",
  }));
});

test("artifact_publish 同代/重启 exact replay 不依赖源文件，同 callId 改参数固定冲突", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-replay-"));
  const source = path.join(workspace, "result.txt");
  fs.writeFileSync(source, "stable artifact", { mode: 0o600 });
  const fixture = makeFixture();
  fixture.runs.set(RUN_ID, run({ workspace }));
  const args = {
    runId: RUN_ID, relativePath: "result.txt", name: "result", kind: "file", mimeType: null,
  };
  const first = await fixture.controller.handle("artifact_publish", args, authority());
  const artifactCall = fixture.calls.find((entry) => entry[0] === "artifact.add")[1];
  const target = path.join(path.dirname(fixture.artifactRoot), artifactCall.storageKey);
  const identity = fs.statSync(target);
  const second = await fixture.controller.handle("artifact_publish", args, authority());
  assert.deepEqual(second, first);
  assert.equal(fs.statSync(target).ino, identity.ino, "exact replay 不替换已发布 inode");
  fs.unlinkSync(source);
  const restarted = new McpProductToolController({
    ...fixture.dependencies,
    artifactRoot: fixture.artifactRoot,
    isSensitiveValue: () => false,
    now: () => 5_000,
    randomUUID: () => "99999999-9999-4999-8999-999999999999",
  });
  assert.deepEqual(await restarted.handle("artifact_publish", args, authority()), first);
  await expectCode(() => restarted.handle("artifact_publish", { ...args, name: "changed" }, authority()),
    "MCP_TOOL_STATE_CONFLICT");
  assert.equal(fs.readFileSync(target, "utf8"), "stable artifact");
});

test("artifact_publish 拒绝 absolute/dotdot/symlink/hardlink/cross-profile，Store 零触碰", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-bad-"));
  const outside = path.join(path.dirname(workspace), `outside-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(outside, "outside", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "safe.txt"), "safe", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(workspace, "link.txt"));
  fs.linkSync(outside, path.join(workspace, "hard.txt"));
  for (const relativePath of [outside, "../outside.txt", "link.txt", "hard.txt"]) {
    const fixture = makeFixture();
    fixture.runs.set(RUN_ID, run({ workspace }));
    await expectCode(() => fixture.controller.handle("artifact_publish", {
      runId: RUN_ID, relativePath, name: "result.txt", kind: "file", mimeType: "text/plain",
    }, authority()), "MCP_TOOL_PATH_INVALID");
    assert.equal(fixture.calls.some((entry) => entry[0] === "artifact.add"), false);
  }
});

test("artifact copy fault 会清零传输 Buffer 且不产生文件或 Store 引用", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-zero-"));
  fs.writeFileSync(path.join(workspace, "result.txt"), "sensitive-buffer-evidence", { mode: 0o600 });
  let captured = null;
  const faultFs = Object.create(fs);
  faultFs.readSync = (fd, buffer, offset, length, position) => {
    captured = buffer;
    buffer.fill(0x73);
    throw Object.assign(new Error("read fault"), { code: "EIO" });
  };
  const fixture = makeFixture({ fs: faultFs });
  fixture.runs.set(RUN_ID, run({ workspace }));
  await expectCode(() => fixture.controller.handle("artifact_publish", {
    runId: RUN_ID, relativePath: "result.txt", name: "r", kind: "file", mimeType: null,
  }, authority()), "MCP_TOOL_UNAVAILABLE");
  assert(captured && captured.every((byte) => byte === 0));
  assert.equal(fixture.calls.some((entry) => entry[0] === "artifact.add"), false);
  assert.deepEqual(fs.readdirSync(fixture.artifactRoot), []);
});

test("artifact metadata 确定失败清理私有副本；commit-uncertain 保留证据并 once poison", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-commit-"));
  fs.writeFileSync(path.join(workspace, "result.txt"), "artifact", { mode: 0o600 });
  let fatalCalls = 0;
  const deterministic = makeFixture({
    kanbanStore: {
      ...makeFixture().dependencies.kanbanStore,
      commitUncertain: false,
      addArtifact() { throw Object.assign(new Error("raw"), { code: "KANBAN_CAPACITY" }); },
    },
  });
  deterministic.runs.set(RUN_ID, run({ workspace }));
  await expectCode(() => deterministic.controller.handle("artifact_publish", {
    runId: RUN_ID, relativePath: "result.txt", name: "r", kind: "file", mimeType: null,
  }, authority()), "MCP_TOOL_CAPACITY");
  assert.deepEqual(fs.readdirSync(deterministic.artifactRoot), []);

  const uncertainStore = { ...makeFixture().dependencies.kanbanStore, commitUncertain: false };
  uncertainStore.addArtifact = () => {
    uncertainStore.commitUncertain = true;
    throw Object.assign(new Error("fixture-secret-canary raw"), { code: "KANBAN_COMMIT_UNCERTAIN" });
  };
  const uncertain = makeFixture({
    kanbanStore: uncertainStore,
    onFatalError: () => { fatalCalls += 1; throw new Error("callback raw"); },
  });
  uncertain.runs.set(RUN_ID, run({ workspace }));
  const args = { runId: RUN_ID, relativePath: "result.txt", name: "r", kind: "file", mimeType: null };
  await expectCode(() => uncertain.controller.handle("artifact_publish", args, authority()),
    "MCP_TOOL_COMMIT_UNCERTAIN");
  assert.equal(fs.readdirSync(uncertain.artifactRoot).length, 1, "uncertain 时保留可能已引用的文件");
  await expectCode(() => uncertain.controller.handle("profile_get", {}, authority()),
    "MCP_TOOL_COMMIT_UNCERTAIN");
  assert.equal(fatalCalls, 1);
});

test("artifact pending 重启先用冻结 binding 对账孤儿 target，不依赖已删除源文件", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-recover-"));
  const source = path.join(workspace, "result.txt");
  const content = "recoverable artifact 😀";
  fs.writeFileSync(source, content, { mode: 0o600 });
  let fatalCalls = 0;
  const fixture = makeFixture({
    onFatalError: () => { fatalCalls += 1; },
  });
  fixture.runs.set(RUN_ID, run({ workspace }));
  const args = {
    runId: RUN_ID, relativePath: "result.txt", name: "recover", kind: "file", mimeType: null,
  };
  const store = fixture.dependencies.kanbanStore;
  const addArtifact = store.addArtifact;
  store.addArtifact = () => {
    store.commitUncertain = true;
    throw Object.assign(new Error("response lost"), { code: "KANBAN_COMMIT_UNCERTAIN" });
  };
  await expectCode(() => fixture.controller.handle("artifact_publish", args, authority()),
    "MCP_TOOL_COMMIT_UNCERTAIN");

  const pending = fixture.mcpCalls.get(`${PROFILE_ID}\0${CALL_ID}`);
  const target = path.join(fixture.artifactRoot, crypto.createHash("sha256")
    .update(PROFILE_ID).update("\0").update(CALL_ID).digest("hex"));
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.binding, {
    cardId: CARD_ID,
    runId: RUN_ID,
    storageKey: `${path.basename(fixture.artifactRoot)}/${path.basename(target)}`,
    name: args.name,
    kind: args.kind,
    mimeType: args.mimeType,
    sizeBytes: Buffer.byteLength(content),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  });
  const orphanIdentity = fs.statSync(target);
  fs.unlinkSync(source);
  store.commitUncertain = false;
  store.addArtifact = addArtifact;

  const restarted = new McpProductToolController({
    ...fixture.dependencies,
    artifactRoot: fixture.artifactRoot,
    isSensitiveValue: () => false,
    now: () => 6_000,
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const recovered = await restarted.handle("artifact_publish", args, authority());
  assert.equal(recovered.artifact.sha256, pending.binding.sha256);
  assert.equal(fs.statSync(target).ino, orphanIdentity.ino, "对账不替换已安装 inode");
  assert.equal(fixture.mcpCalls.get(`${PROFILE_ID}\0${CALL_ID}`).status, "completed");
  assert.equal(fixture.calls.filter((entry) => entry[0] === "artifact.add").length, 1);
  assert.equal(fatalCalls, 1);
});

test("artifact pending 的 target 与冻结 binding 不一致时保持 pending 并 fail-closed", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-mismatch-"));
  const source = path.join(workspace, "result.txt");
  fs.writeFileSync(source, "original artifact", { mode: 0o600 });
  const fixture = makeFixture({ onFatalError: () => {} });
  fixture.runs.set(RUN_ID, run({ workspace }));
  const args = {
    runId: RUN_ID, relativePath: "result.txt", name: "recover", kind: "file", mimeType: null,
  };
  const store = fixture.dependencies.kanbanStore;
  const addArtifact = store.addArtifact;
  store.addArtifact = () => {
    store.commitUncertain = true;
    throw Object.assign(new Error("response lost"), { code: "KANBAN_COMMIT_UNCERTAIN" });
  };
  await expectCode(() => fixture.controller.handle("artifact_publish", args, authority()),
    "MCP_TOOL_COMMIT_UNCERTAIN");
  const target = path.join(fixture.artifactRoot, crypto.createHash("sha256")
    .update(PROFILE_ID).update("\0").update(CALL_ID).digest("hex"));
  fs.writeFileSync(target, "attacker replacement", { mode: 0o600 });
  fs.unlinkSync(source);
  store.commitUncertain = false;
  store.addArtifact = addArtifact;
  let recoveryFatalCalls = 0;
  const restarted = new McpProductToolController({
    ...fixture.dependencies,
    artifactRoot: fixture.artifactRoot,
    isSensitiveValue: () => false,
    onFatalError: () => { recoveryFatalCalls += 1; },
    now: () => 6_000,
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  await expectCode(() => restarted.handle("artifact_publish", args, authority()),
    "MCP_TOOL_COMMIT_UNCERTAIN");
  assert.equal(fixture.mcpCalls.get(`${PROFILE_ID}\0${CALL_ID}`).status, "pending");
  assert.equal(recoveryFatalCalls, 1);
});

test("artifact temp path 在 close 后被替换时不得安装或写 Store 引用", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-workspace-temp-race-"));
  fs.writeFileSync(path.join(workspace, "result.txt"), "trusted artifact", { mode: 0o600 });
  const hostileFs = Object.create(fs);
  let replaced = false;
  hostileFs.lstatSync = (target) => {
    if (!replaced && typeof target === "string" && target.endsWith(".tmp")) {
      replaced = true;
      fs.unlinkSync(target);
      fs.writeFileSync(target, "attacker replacement", { mode: 0o600 });
    }
    return fs.lstatSync(target);
  };
  let fatalCalls = 0;
  const fixture = makeFixture({
    fs: hostileFs,
    onFatalError: () => { fatalCalls += 1; },
  });
  fixture.runs.set(RUN_ID, run({ workspace }));
  await expectCode(() => fixture.controller.handle("artifact_publish", {
    runId: RUN_ID, relativePath: "result.txt", name: "race", kind: "file", mimeType: null,
  }, authority()), "MCP_TOOL_COMMIT_UNCERTAIN");
  assert.equal(replaced, true);
  assert.equal(fixture.calls.some((entry) => entry[0] === "artifact.add"), false);
  assert.equal(fixture.artifacts.length, 0);
  assert.equal(fixture.mcpCalls.get(`${PROFILE_ID}\0${CALL_ID}`).status, "pending");
  assert.equal(fatalCalls, 1);
});

test("notification 绑定 Run/Profile、动态 secret 拒绝并执行 3/60s 与 20/hour 限频", async () => {
  const fixture = makeFixture({
    isSensitiveValue: (value) => typeof value === "string" && value.includes("fixture-secret-canary"),
  });
  await expectCode(() => fixture.controller.handle("notification_send", {
    runId: RUN_ID, title: "safe", body: "fixture-secret-canary",
  }, authority()), "MCP_TOOL_SECRET_REJECTED");
  assert.equal(fixture.calls.some((entry) => entry[0] === "notify"), false);
  const firstAuthority = authority({ callId: "11111111-1111-4111-8111-111111111111" });
  const [first, replay] = await Promise.all([
    fixture.controller.handle("notification_send", {
      runId: RUN_ID, title: "title 0", body: "body",
    }, firstAuthority),
    fixture.controller.handle("notification_send", {
      runId: RUN_ID, title: "title 0", body: "body",
    }, firstAuthority),
  ]);
  assert.deepEqual(first, { delivered: true });
  assert.deepEqual(replay, first);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "notify").length, 1);
  await expectCode(() => fixture.controller.handle("notification_send", {
    runId: RUN_ID, title: "changed", body: "body",
  }, firstAuthority), "MCP_TOOL_STATE_CONFLICT");
  for (let index = 1; index < 3; index += 1) {
    const sent = await fixture.controller.handle("notification_send", {
      runId: RUN_ID, title: `title ${index}`, body: "body",
    }, authority({ callId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}` }));
    assert.deepEqual(sent, { delivered: true });
  }
  await expectCode(() => fixture.controller.handle("notification_send", {
    runId: RUN_ID, title: "fourth", body: "body",
  }, authority({ callId: "44444444-4444-4444-8444-444444444444" })),
  "MCP_TOOL_RATE_LIMITED");
  assert.equal(fixture.calls.filter((entry) => entry[0] === "notify").length, 3);
});

test("hostile Error code accessor 不执行并固定 fail-closed；最终结果严格小于 64KiB", async () => {
  const forgedPublic = makeFixture({
    productStore: {
      ...makeFixture().dependencies.productStore,
      getAgentProfile() {
        throw Object.assign(new Error("fixture-secret-canary raw public message"), {
          code: "MCP_TOOL_NOT_FOUND",
        });
      },
    },
  });
  await expectCode(() => forgedPublic.controller.handle("profile_get", {}, authority()),
    "MCP_TOOL_NOT_FOUND");

  let getterCalls = 0;
  const raw = {};
  Object.defineProperty(raw, "code", { get() { getterCalls += 1; throw new Error("getter raw"); } });
  const fixture = makeFixture({
    productStore: {
      getAgentProfile() { throw raw; },
      addRunNote() { throw raw; },
      lookupMcpToolCall() { throw raw; },
      beginMcpToolCall() { throw raw; },
      completeMcpToolCall() { throw raw; },
    },
  });
  await expectCode(() => fixture.controller.handle("profile_get", {}, authority()),
    "MCP_TOOL_UNAVAILABLE");
  assert.equal(getterCalls, 0);

  const hostileArray = [];
  Object.defineProperty(hostileArray, "0", {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return { id: BOARD_ID }; },
  });
  hostileArray.length = 1;
  const hostileArrayResult = makeFixture({
    domainController: {
      async handle() { return { items: hostileArray, nextCursor: null }; },
    },
  });
  await expectCode(() => hostileArrayResult.controller.handle("kanban_list", {
    kind: "boards", boardId: null, status: null, cursor: null, limit: 10,
  }, authorityFor("d")), "MCP_TOOL_RESPONSE_INVALID");
  assert.equal(getterCalls, 0);

  const protoPayload = {};
  Object.defineProperty(protoPayload, "__proto__", {
    value: { polluted: true }, enumerable: true, configurable: true, writable: true,
  });
  const hostileResult = makeFixture({
    domainController: {
      async handle() { return { items: [protoPayload], nextCursor: null }; },
    },
  });
  const cloned = await hostileResult.controller.handle("kanban_list", {
    kind: "boards", boardId: null, status: null, cursor: null, limit: 10,
  }, authority());
  assert.equal(Object.getPrototypeOf(cloned.items[0]), Object.prototype);
  assert.equal(Object.hasOwn(cloned.items[0], "__proto__"), true);
  assert.equal({}.polluted, undefined);

  const normal = makeFixture();
  let callIndex = 0;
  for (const [name, args] of [
    ["profile_get", {}],
    ["kanban_list", { kind: "boards", boardId: null, status: null, cursor: null, limit: 100 }],
    ["kanban_get", { cardId: CARD_ID, cursor: null, maxBytes: 32 * 1024 }],
    ["cron_list", { enabled: null, cursor: null, limit: 100 }],
    ["cron_get", { jobId: JOB_ID, cursor: null, maxBytes: 32 * 1024 }],
    ["run_get", { runId: RUN_ID }],
  ]) {
    callIndex += 1;
    const result = await normal.controller.handle(name, args, authorityFor(callIndex));
    assert(Buffer.byteLength(JSON.stringify({ id: "\0".repeat(256), ok: true, result })) <= 64 * 1024,
      `${name} response must fit worst-case frame`);
  }
});

test("本地 Agent 管理拒绝空更新、越界目标、额外字段和非数据输入", () => {
  const create = { backendId: "shoggoth", name: "测试", workspace: null, source: "chat", sourceId: "session-a",
    identity: "辅助助理，协助完成任务。" };
  assert.equal(validateMcpProductToolArguments("native_agent_create", create), true);
  for (const args of [{ ...create, name: " " }, { ...create, identity: " " }, { ...create, identity: "x".repeat(8193) },
    { ...create, runtimeAccountId: "secret-account" }, { ...create, workspace: "../escape" },
    { ...create, backendId: "hermes" }, { ...create, backendId: "codex" },
    { ...create, get identity() { assert.fail("must not invoke getter"); } }]) {
    assert.equal(validateMcpProductToolArguments("native_agent_create", args), false);
  }
  const base = { backendId: "shoggoth", agentId: "target-agent", source: "chat", sourceId: "session-a", expectedUpdatedAt: 1 };
  for (const args of [null, [], {}, base, { ...base, name: " " }, { ...base, workspace: "relative" },
    { ...base, name: "Valid", providerRef: "unexpected" }, { ...base, name: "Valid", agentId: "a".repeat(129) },
    { ...base, workspace: null, backendId: "hermes" }, { ...base, get name() { assert.fail("must not invoke getter"); } }]) {
    assert.equal(validateMcpProductToolArguments("native_agent_update", args), false);
  }
  assert.equal(validateMcpProductToolArguments("native_agent_update", { ...base, workspace: null }), true);
});

test("本地 Agent 通过 MCP 读取、修改和归档，保留确认与版本边界", async () => {
  let fixture;
  const lifecycleCalls = [];
  fixture = makeFixture({ agentLifecycleService: { async handle(method, params) {
    lifecycleCalls.push([method, structuredClone(params)]);
    const target = fixture.profiles.get(OTHER_PROFILE_ID);
    if (method === "agent.lifecycle.list") return { agents: [...fixture.profiles.values()].map(profile => ({
      profile: structuredClone(profile), state: profile.enabled ? "active" : "archived", pendingOperationId: null,
    })) };
    assert.equal(params.profileId, OTHER_PROFILE_ID);
    assert.equal(params.expectedUpdatedAt, target.updatedAt);
    assert.match(params.operationId, /^mcp-v1-/u);
    if (method === "agent.update") Object.assign(target, { name: params.name, defaultCwd: params.defaultCwd });
    else { assert.equal(method, "agent.archive"); target.enabled = false; }
    target.updatedAt += 1;
    return { profile: structuredClone(target) };
  } } });
  const selector = { backendId: "shoggoth", agentId: "agent-other" };
  const context = { source: "kanban", sourceId: CARD_ID };
  const read = await fixture.controller.handle("native_agent_get", selector, authorityFor("1"));
  assert.equal(read.agent.updatedAt, 2);
  assert.doesNotMatch(JSON.stringify(read), /private-provider|runtimeProfileId|permissionPolicy/u);
  fixture.profiles.get(OTHER_PROFILE_ID).isDefault = true;
  await expectCode(() => fixture.controller.handle("native_agent_archive", { ...selector, ...context,
    expectedUpdatedAt: 2 }, authorityFor("5")), "AGENT_PROTECTED");
  fixture.profiles.get(OTHER_PROFILE_ID).isDefault = false;
  const caller = fixture.profiles.get(PROFILE_ID);
  caller.isDefault = false;
  await expectCode(() => fixture.controller.handle("native_agent_archive", { ...context,
    backendId: caller.backendId, agentId: caller.agentId, expectedUpdatedAt: caller.updatedAt }, authorityFor("6")), "AGENT_ACTIVE_RUNS");
  const update = { ...selector, ...context, expectedUpdatedAt: 2, name: "星帆" };
  await expectCode(() => fixture.controller.handle("native_agent_update", update, authority()), "MCP_TOOL_CONFIRMATION_REQUIRED");
  const changed = await fixture.controller.handle("native_agent_update", update, authorityFor("2"));
  assert.equal(changed.agent.name, "星帆");
  assert.equal(changed.agent.workspace, "/private/default-cwd");
  const archive = { ...selector, ...context, expectedUpdatedAt: 3 };
  await expectCode(() => fixture.controller.handle("native_agent_archive", archive, authority({ federationClient: "hermes" })), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => fixture.controller.handle("native_agent_archive", { ...archive, expectedUpdatedAt: 2 }, authorityFor("3")), "AGENT_PROFILE_CONFLICT");
  const archived = await fixture.controller.handle("native_agent_archive", archive, authorityFor("4"));
  assert.equal(archived.agent.state, "archived");
  assert.equal(archived.recoverable, true);
  assert.equal(archived.dataDeleted, false);
  assert.deepEqual(await fixture.controller.handle("native_agent_archive", archive, authorityFor("4")), archived);
  assert.equal(lifecycleCalls.filter(([method]) => method === "agent.archive").length, 1);
});

test("Computer Use 的权限、驱动和读取错误保留安全的具体错误码", async () => {
  // Pause, takeover, target and action errors keep their own code and next step
  // instead of collapsing into MCP_TOOL_STATE_CONFLICT or MCP_TOOL_UNAVAILABLE.
  for (const code of ["COMPUTER_PERMISSION_REQUIRED", "COMPUTER_DRIVER_UNAVAILABLE", "COMPUTER_PERMISSION_STATUS_FAILED",
    "COMPUTER_SESSION_PAUSED", "COMPUTER_USER_TAKEOVER", "COMPUTER_SCREEN_LOCKED", "COMPUTER_SESSION_STATE_INVALID",
    "COMPUTER_ARGUMENTS_INVALID", "COMPUTER_TARGET_FORBIDDEN", "COMPUTER_SECURE_INPUT_FORBIDDEN", "COMPUTER_ACTION_FAILED"]) {
    const stub = Object.fromEntries(["status", "create", "resume", "closeSession", "applicationList", "windowList", "snapshot", "focus", "action"]
      .map(name => [name, () => { throw Object.assign(new Error("private diagnostic canary"), { code }); }]));
    const fixture = makeFixture({ computerUseController: stub });
    await assert.rejects(() => fixture.controller.handle("computer_status", {}, authority()), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /canary/u);
      return true;
    });
  }
});

test("Browser Use uses confirmed current WorkRun identity and exact downstream arguments", async () => {
  const dispatched = [];
  const browser = Object.fromEntries(["status", "create", "closeSession", "listTools", "callTool"].map(method => [method, async input => {
    dispatched.push([method, structuredClone(input)]);
    return method === "status" ? { available: true, reason: null, browser: "chrome", engineVersion: "0.0.82", sessions: [] }
      : method === "create" ? { id: "browser-fixture" } : { sessionId: "browser-fixture", content: [], isError: false };
  }]));
  const f = makeFixture({ browserUseController: browser });
  const source = { source: "kanban", sourceId: CARD_ID };
  await expectCode(() => f.controller.handle("browser_session_open", { ...source }, authority()), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.equal(dispatched.length, 0);
  const session = await f.controller.handle("browser_session_open", { ...source }, authorityFor("1"));
  assert.equal(session.sessionId, "browser-fixture");
  assert.deepEqual(dispatched[0], ["create", { profileId: PROFILE_ID, workRunId: RUN_ID,
    workspace: f.runs.get(RUN_ID).workspace }]);
  const args = { ...source, sessionId: "browser-fixture", toolName: "browser_snapshot", arguments: {} };
  await f.controller.handle("browser_tool_call", args, authorityFor("2"));
  assert.deepEqual(dispatched[1], ["callTool", { profileId: PROFILE_ID, workRunId: RUN_ID,
    sessionId: "browser-fixture", toolName: "browser_snapshot", arguments: {} }]);
  assert.equal(validateMcpProductToolArguments("browser_tool_call", { ...args, profileId: OTHER_PROFILE_ID }), false);
  await expectCode(() => f.controller.handle("browser_status", {}, authority({ federationClient: "hermes" })), "MCP_TOOL_FORBIDDEN");
  f.runs.get(RUN_ID).status = "completed";
  await expectCode(() => f.controller.handle("browser_tool_call", args, authorityFor("3")), "MCP_TOOL_STATE_CONFLICT");
  assert.equal(dispatched.length, 2);
});

test("Browser handoff requires the current native execution scope and executes the input callback once", async () => {
  const dispatched = [], inputs = [];
  const browser = Object.fromEntries(["status", "create", "closeSession", "listTools", "callTool"].map(name => [name, async () => ({})]));
  browser.waitForUser = async (input, ask) => {
    dispatched.push(structuredClone(input));
    return { sessionId: input.sessionId, canceled: !await ask(new AbortController().signal) };
  };
  const f = makeFixture({ browserUseController: browser, requestBrowserUserInput: async input => {
    inputs.push(input); return true;
  } });
  const args = { source: "kanban", sourceId: CARD_ID, sessionId: "browser-fixture", instructions: "完成本地测试操作" };
  await expectCode(() => f.controller.handle("browser_session_wait_for_user", args, authorityFor("1")), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => f.controller.handle("browser_session_wait_for_user", args,
    authority({ federationClient: "hermes" })), "MCP_TOOL_FORBIDDEN");
  const scope = { runId: RUN_ID, signal: new AbortController().signal, assertCurrent() {} };
  const result = await f.controller.handle("browser_session_wait_for_user", args, authorityFor("2"), scope);
  assert.equal(result.canceled, false);
  assert.deepEqual(dispatched, [{ profileId: PROFILE_ID, workRunId: RUN_ID, sessionId: "browser-fixture" }]);
  assert.equal(inputs[0].run.id, RUN_ID);
  assert.equal(inputs[0].scope, scope);
  assert.equal(inputs[0].instructions, args.instructions);
  assert.ok(inputs[0].signal instanceof AbortSignal);
  assert.deepEqual(await f.controller.handle("browser_session_wait_for_user", args, authorityFor("2"), scope), result);
  assert.equal(inputs.length, 1, "a duplicate call ID never creates another prompt or action");
  await expectCode(() => f.controller.handle("browser_session_wait_for_user", args, authorityFor("3"),
    { ...scope, runId: OTHER_RUN_ID }), "MCP_TOOL_FORBIDDEN");
  assert.equal(inputs.length, 1);
});

test("Every native Runtime receives the browser handoff tool and lifecycle instructions", () => {
  const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
  for (const runtime of Object.keys(DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME)) {
    const instructions = shoggothProductDeveloperInstructions({ runtime, profileName: "fixture", source: "chat", sourceId: "fixture-chat" });
    assert.match(instructions, /call browser_session_wait_for_user/u, runtime);
    assert.match(instructions, /final answer completes the WorkRun and closes its browser/u, runtime);
  }
  const definition = MCP_PRODUCT_TOOL_DEFINITIONS.find(tool => tool.name === "browser_session_wait_for_user");
  // The detailed handoff workflow travels with the tool itself.
  assert.match(definition.description, /same Chrome window open/u);
  assert.match(definition.description, /never in the Shoggoth card or conversation/u);
  assert.equal(definition.annotations.readOnlyHint, false);
  assert.equal(definition.inputSchema.additionalProperties, false);
  const valid = { source: "chat", sourceId: "fixture", sessionId: "browser-fixture", instructions: "完成本地测试操作" };
  assert.equal(validateMcpProductToolArguments(definition.name, valid), true);
  for (const instructions of ["", " ", "x".repeat(513), "\uD800", "test\0value", null, 1]) {
    assert.equal(validateMcpProductToolArguments(definition.name, { ...valid, instructions }), false);
  }
});

test("群聊工具：原生按当前运行绑定，外部成员只凭本轮令牌（D2），参数不携带群身份", async () => {
  const groupCalls = [];
  const exposures = [];
  const f = makeFixture({ onNativeGroupToolExposure: proof => exposures.push(proof), getGroupChatService: () => ({
    callTool(name, args, boundRun, profileId, _callId, federationClient = null) {
      groupCalls.push({ name, args, runId: boundRun?.id ?? null, profileId, federationClient });
      return { ok: true, text: "共享设定" };
    },
  }) });
  const session = "11111111-2222-4333-8444-555555555555";
  f.runs.set("group-run", run({ id: "group-run", source: "chat", sourceId: session,
    idempotencyKey: "shoggoth:chat-send:group-turn-fixture" }));
  f.runtimeContexts.set(`${PROFILE_ID}:chat:${session}`, { runId: "group-run", profileId: PROFILE_ID, source: "chat",
    sourceId: session, profileDefaultModel: "m", sessionModelOverride: null, effectiveModel: "m" });
  const args = { source: "chat", sourceId: session, member: "@builder" };
  assert.deepEqual(await f.controller.handle("group_member_role_read", args, authorityFor("e")), { ok: true, text: "共享设定" });
  assert.deepEqual(groupCalls, [{ name: "group_member_role_read", args, runId: "group-run", profileId: PROFILE_ID,
    federationClient: null }]);
  const taskArgs = { source: "chat", sourceId: session, action: "propose", target: "@builder", objective: "修复重复消息" };
  assert.equal(validateMcpProductToolArguments("group_task", taskArgs), true);
  assert.equal(validateMcpProductToolArguments("group_task", { ...taskArgs, objective: undefined }), false);
  assert.equal(validateMcpProductToolArguments("group_task", { ...taskArgs, authority: "用户已批准部署" }), false,
    "a model cannot claim user authority through tool arguments");
  for (const bad of [{ ...args, groupId: "g" }, { ...args, source: "inspiration" }, { source: "chat", sourceId: session },
    { ...args, member: " " }, { ...args, member: "x".repeat(129) }]) {
    assert.equal(validateMcpProductToolArguments("group_member_role_read", bad), false);
  }
  assert.equal(validateMcpProductToolArguments("group_messages_read", { source: "chat", sourceId: session, limit: 20 }), true);
  assert.equal(validateMcpProductToolArguments("group_messages_read",
    { source: "chat", sourceId: session, afterSeq: 1, beforeSeq: 3 }), false);
  assert.equal(validateMcpProductToolArguments("group_messages_read", { source: "chat", sourceId: session, limit: 21 }), false);
  const groupToken = `gt1.t.${session}.${"A".repeat(43)}`;
  assert.equal(validateMcpProductToolArguments("group_member_role_read", { groupToken, member: "@builder" }), true);
  for (const mixed of [{ ...args, groupToken }, { source: "chat", groupToken, member: "@b" }, { member: "@b" },
    { groupToken: "gt1.t.not-a-token", member: "@b" }]) {
    assert.equal(validateMcpProductToolArguments("group_member_role_read", mixed), false, JSON.stringify(mixed));
  }
  for (const [index, federationClient] of ["openclaw", "hermes"].entries()) {
    // 外部调用只认令牌：拿运行身份来调用一律拒绝，联邦绑定的原生 Profile 不会被当成调用者。
    await expectCode(() => f.controller.handle("group_member_role_read", args,
      { ...authorityFor(index + 1), federationClient }), "MCP_TOOL_FORBIDDEN");
    assert.deepEqual(await f.controller.handle("group_member_role_read", { groupToken, member: "@builder" },
      { ...authorityFor(index + 3), federationClient }), { ok: true, text: "共享设定" });
  }
  // 原生运行不能借用外部成员的令牌。
  await expectCode(() => f.controller.handle("group_member_role_read", { groupToken, member: "@builder" }, authorityFor("f")),
    "MCP_TOOL_FORBIDDEN");
  assert.deepEqual(groupCalls.slice(1).map(({ runId, profileId, federationClient }) => ({ runId, profileId, federationClient })),
    [{ runId: null, profileId: null, federationClient: "openclaw" }, { runId: null, profileId: null, federationClient: "hermes" }]);
  const collaboration = { source: "chat", sourceId: session, action: "plan", clientActionId: "plan-1", scopeKey: "research",
    target: "@builder", objective: "Verify source", stopCondition: "Deliver evidence" };
  assert.equal(validateMcpProductToolArguments("group_collaborate", collaboration), true);
  assert.deepEqual(await f.controller.handle("group_collaborate", collaboration, authorityFor("c")), { ok: true, text: "共享设定" });
  assert.equal(groupCalls.at(-1).name, "group_collaborate");
  assert.equal(groupCalls.at(-1).runId, "group-run");
  assert.equal(groupCalls.at(-1).profileId, PROFILE_ID);
  assert.deepEqual(exposures, [{ profileId: PROFILE_ID, runId: "group-run", name: "group_collaborate" }]);
  assert.equal(validateMcpProductToolArguments("group_collaborate", { ...collaboration, coordinatorEpoch: 999 }), false);
  const externalCollaboration = { groupToken, action: "pass", clientActionId: "pass-1", reason: "Already covered" };
  await expectCode(() => f.controller.handle("group_collaborate", externalCollaboration, authorityFor("a")), "MCP_TOOL_FORBIDDEN");
  assert.deepEqual(await f.controller.handle("group_collaborate", externalCollaboration,
    { ...authorityFor("b"), federationClient: "hermes" }), { ok: true, text: "共享设定" });
  assert.equal(groupCalls.at(-1).runId, null);
  assert.equal(groupCalls.at(-1).federationClient, "hermes");
  assert.equal(exposures.length, 1, "external tokens cannot create native exposure proof");
});


test("联网工具保持原生和外部 MCP 契约，停止后的结果不能返回", async () => {
  const sent = [], abort = new AbortController(); let current = true;
  const f = makeFixture({ webService: { async call(name, args, { signal, profileId }) {
    sent.push({ name, args, signal, profileId }); if (args.query === "stop") current = false;
    return { text: "Public result", sources: [{ title: "Source", url: "https://example.com" }], untrusted: true };
  } } });
  const authority = { profileId: PROFILE_ID, callId: CALL_ID };
  const scope = { runId: RUN_ID, signal: abort.signal, assertCurrent() {
    if (!current) throw Object.assign(new Error("stale"), { code: "MCP_TOOL_STATE_CONFLICT" });
  } };
  assert.equal((await f.controller.handle("web_search", { query: "docs" }, authority, scope)).untrusted, true);
  assert.equal(sent[0].signal, abort.signal);
  assert.equal(sent[0].profileId, PROFILE_ID);
  await expectCode(() => f.controller.handle("web_search", { query: "stop" },
    { ...authority, callId: crypto.randomUUID() }, scope), "MCP_TOOL_STATE_CONFLICT");
  assert.equal(sent.length, 2);
  current = true;
  assert.equal((await f.controller.handle("web_fetch", { url: "https://example.com" },
    { ...authority, callId: crypto.randomUUID(), federationClient: "hermes" })).text, "Public result");
  assert.equal(sent.at(-1).profileId, null, "external bridge calls must not inherit a native Agent override");
});
test("联网错误经过公开错误映射，搜索失败没有成功结果", async () => {
  const f = makeFixture({ webService: { async call() { throw Object.assign(new Error("fixture-secret-canary"), { code: "WEB_RATE_LIMITED" }); } } });
  await expectCode(() => f.controller.handle("web_search", { query: "docs" },
    { profileId: PROFILE_ID, callId: CALL_ID }), "WEB_RATE_LIMITED");
});

test("skill_learn only signals its active native owner and replays no second write", async () => {
  const calls = [], f = makeFixture({ learningService: { request(profileId, runId) {
    calls.push({ profileId, runId }); return { queued: true, runId, jobId: null, state: "awaiting_completion" };
  } } });
  const scope = { runId: RUN_ID, assertCurrent() {} }, auth = authority({ callId: crypto.randomUUID() });
  await expectCode(() => f.controller.handle("skill_learn", {}, authority()), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => f.controller.handle("skill_learn", {}, authority({ federationClient: "hermes" }), scope), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => f.controller.handle("skill_learn", { profileId: OTHER_PROFILE_ID }, auth, scope), "MCP_TOOL_INVALID_ARGUMENTS");
  assert.equal((await f.controller.handle("skill_learn", {}, auth, scope)).queued, true);
  await f.controller.handle("skill_learn", {}, auth, scope); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { profileId: PROFILE_ID, runId: RUN_ID });
  f.runs.set(RUN_ID, run({ status: "completed" }));
  await expectCode(() => f.controller.handle("skill_learn", {}, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
});
test("心跳设置仅当前活跃原生 Run 可改，受限心跳、外部会话和撤权不能改", async () => {
  const calls = [], f = makeFixture({ proactiveService: { async handleSettingsTool(name, profileId, args, context) {
    context.assertCurrent(); calls.push({ name, profileId, args, operationId: context.operationId }); return { revision: calls.length };
  } } });
  const scope = { runId: RUN_ID, assertCurrent() {} }, args = { expectedRevision: 1, config: { intervalMinutes: 15 } };
  await expectCode(() => f.controller.handle("heartbeat_settings_get", {}, authority()), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => f.controller.handle("heartbeat_settings_get", {}, authority({ profileId: OTHER_PROFILE_ID }), scope), "MCP_TOOL_NOT_FOUND");
  for (const name of ["heartbeat_settings_get", "heartbeat_settings_set"]) await expectCode(() => f.controller.handle(name,
    name.endsWith("get") ? {} : args, authority({ federationClient: "hermes", callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  const readAuth = authority({ callId: crypto.randomUUID() });
  assert.equal((await f.controller.handle("heartbeat_settings_get", {}, readAuth, scope)).revision, 1);
  assert.equal((await f.controller.handle("heartbeat_settings_get", {}, readAuth, scope)).revision, 2, "reads refresh the current settings");
  await f.controller.handle("heartbeat_settings_set", args, authority({ callId: crypto.randomUUID() }), scope);
  assert.equal(calls.at(-1).profileId, PROFILE_ID);
  assert.match(calls.at(-1).operationId, /^heartbeat-mcp-[a-f0-9]{64}$/u);
  f.runs.set(RUN_ID, run({ source: "proactive" }));
  await expectCode(() => f.controller.handle("heartbeat_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  f.runs.set(RUN_ID, run({ status: "completed" }));
  await expectCode(() => f.controller.handle("heartbeat_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  f.runs.set(RUN_ID, run());
  f.controller.permissionEngine.setProfileOverride(PROFILE_ID, "heartbeat_settings_set", "deny");
  await expectCode(() => f.controller.handle("heartbeat_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  assert.equal(calls.length, 3);
});
test("原生联网偏好绑定当前 Run 和 Agent，外部会话不能读写", async () => {
  const calls = [], f = makeFixture({ webSettings: { async handleTool(name, profileId, args, { assertCurrent }) {
    assertCurrent(); calls.push({ name, profileId, args }); return { saved: true };
  } } });
  const scope = { runId: RUN_ID, assertCurrent() {} }, auth = authority();
  const args = { expectedRevision: 0, config: { searchProvider: "brave" } };
  await expectCode(() => f.controller.handle("web_settings_get", {}, auth), "MCP_TOOL_FORBIDDEN");
  for (const name of ["web_settings_get", "web_settings_set", "web_defaults_set"]) {
    await expectCode(() => f.controller.handle(name, name === "web_settings_get" ? {} : args,
      authority({ callId: crypto.randomUUID(), federationClient: "hermes", confirmation: true }), scope), "MCP_TOOL_FORBIDDEN");
  }
  await expectCode(() => f.controller.handle("web_settings_get", {}, authority({ profileId: OTHER_PROFILE_ID }), scope), "MCP_TOOL_NOT_FOUND");
  assert.deepEqual(await f.controller.handle("web_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), { saved: true });
  assert.equal(calls[0].profileId, PROFILE_ID);
  f.runs.set(RUN_ID, run({ status: "completed" }));
  await expectCode(() => f.controller.handle("web_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  assert.equal(calls.length, 1);
});
test("统一联网默认要求单次确认，偏好读取重放读取现值，撤权仍生效", async () => {
  let revision = 0;
  const f = makeFixture({ webSettings: { async handleTool(name, _profileId, _args, { assertCurrent }) {
    assertCurrent(); if (name !== "web_settings_get") revision++; return { revision };
  } } });
  const scope = { runId: RUN_ID, assertCurrent() {} }, auth = authority(), args = { expectedRevision: 0, config: { fetchProvider: "tavily" } };
  await expectCode(() => f.controller.handle("web_defaults_set", args, auth, scope), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.equal(revision, 0);
  assert.equal((await f.controller.handle("web_settings_get", {}, auth, scope)).revision, 0);
  assert.equal((await f.controller.handle("web_defaults_set", args, authority({ callId: crypto.randomUUID(), confirmation: true }), scope)).revision, 1);
  assert.equal((await f.controller.handle("web_settings_get", {}, auth, scope)).revision, 1, "same-call read must be live after defaults changed");
  f.controller.permissionEngine.setProfileOverride(PROFILE_ID, "web_settings_set", "deny");
  await expectCode(() => f.controller.handle("web_settings_set", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  assert.equal(revision, 1);
});

test("workspace execution uses only the four runtimes' frozen auto contract and current lease", async () => {
  let contract = null, executions = 0;
  const f = makeFixture({ workspaceExecutionService: { async execute(input) {
    input.scope.assertCurrent(); executions++; return { exitCode: 0, stdout: "done", stderr: "" };
  } }, getExecutionContract: () => contract });
  const current = f.runs.get(RUN_ID);
  current.source = "chat"; current.workspace = f.artifactRoot;
  const scope = { runId: RUN_ID, assertCurrent() {} };
  const args = { command: "node -e 'workspace task'" };
  for (const runtime of ["antigravity", "pi", "opencode", "deepseek-harness"]) {
    contract = { ...current, runId: RUN_ID, runtime, permissionMode: "auto-review", workspaceExecutionVersion: 1,
      permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" } };
    const result = await f.controller.handle("workspace_execute", args, authority({ callId: crypto.randomUUID() }), scope);
    assert.equal(result.exitCode, 0);
  }
  const original = contract;
  for (const change of [{ permissionMode: "full-access" }, { permissionMode: "request-approval" },
    { workspaceExecutionVersion: undefined }, { runtime: "codex" }, { source: "proactive" },
    { permissionPolicy: { sandbox: "read-only" } }, { workspace: "/foreign" }, { profileId: OTHER_PROFILE_ID }]) {
    contract = { ...original, ...change };
    await expectCode(() => f.controller.handle("workspace_execute", args, authority({ callId: crypto.randomUUID() }), scope), "MCP_TOOL_FORBIDDEN");
  }
  contract = original;
  await expectCode(() => f.controller.handle("workspace_execute", args, authority({ federationClient: "hermes" }), scope), "MCP_TOOL_FORBIDDEN");
  await expectCode(() => f.controller.handle("workspace_execute", args, authority()), "MCP_TOOL_FORBIDDEN");
  f.controller.permissionEngine.setProfileOverride(PROFILE_ID, "workspace_execute", "deny");
  await expectCode(() => f.controller.handle("workspace_execute", args, authority(), scope), "MCP_TOOL_FORBIDDEN");
  assert.equal(executions, 4);
});

test("workspace commands share concurrent calls and never replay a pending command after restart", async () => {
  let contract, release, executions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = { async execute(input) { input.scope.assertCurrent(); executions++; await gate; return { exitCode: 0, stdout: "once", stderr: "" }; } };
  const f = makeFixture({ workspaceExecutionService: service, getExecutionContract: () => contract });
  const current = f.runs.get(RUN_ID); current.workspace = f.artifactRoot;
  contract = { ...current, runId: RUN_ID, runtime: "pi", permissionMode: "auto-review", workspaceExecutionVersion: 1,
    permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" } };
  const scope = { runId: RUN_ID, assertCurrent() {} }, args = { command: "one operation" };
  const first = f.controller.handle("workspace_execute", args, authority(), scope);
  const duplicate = f.controller.handle("workspace_execute", args, authority(), scope);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(executions, 1);
  release(); assert.deepEqual(await first, await duplicate);
  assert.deepEqual(await f.controller.handle("workspace_execute", args, authority(), scope), await first);
  assert.equal(executions, 1); assert.equal(f.controller.workspaceExecutionCalls.size, 0);
  const callId = crypto.randomUUID();
  f.dependencies.productStore.beginMcpToolCall({ profileId: PROFILE_ID, callId, name: "workspace_execute",
    fingerprint: fingerprintMcpToolCall("workspace_execute", args), createdAt: 1,
    binding: { runId: RUN_ID, profileId: PROFILE_ID, workspace: f.artifactRoot } });
  const restarted = new McpProductToolController({ ...f.dependencies, workspaceExecutionService: service,
    getExecutionContract: () => contract, artifactRoot: f.artifactRoot, isSensitiveValue: () => false });
  await expectCode(() => restarted.handle("workspace_execute", args, authority({ callId }), scope), "MCP_TOOL_STATE_CONFLICT");
  assert.equal(executions, 1);
  contract = { ...contract, runId: OTHER_RUN_ID };
  f.runs.set(OTHER_RUN_ID, { ...current, id: OTHER_RUN_ID });
  await expectCode(() => restarted.handle("workspace_execute", args, authority(), { ...scope, runId: OTHER_RUN_ID }), "MCP_TOOL_FORBIDDEN");
});

(async () => {
  let failed = 0;
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
  for (const root of ownedArtifactRoots) fs.rmSync(root, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS mcp product tool controller unit (${tests.length})`);
})();
