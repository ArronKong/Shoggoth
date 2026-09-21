#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
    backendId: "grok-build",
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

test("外部联邦身份不能读取或修改原生 Profile 的记忆与设定，能力查询与目录一致", async () => {
  const f = makeFixture();
  const source = { source: "chat", sourceId: "current-user-conversation" };
  const calls = [
    ["memory_search", { ...source, query: "" }],
    ["memory_save", { ...source, expectedRevision: 0, content: "使用中文", scope: "user",
      classification: "explicit", sourceQuote: "使用中文" }],
    ["memory_forget", { ...source, id: "memory-1", expectedRevision: 1, sourceQuote: "忘记它" }],
    ["agent_definition_read", { ...source, kind: "IDENTITY" }],
    ["agent_definition_update", { ...source, kind: "IDENTITY", expectedRevision: 1,
      oldText: "Shoggoth", newText: "Other", sourceQuote: "改名字" }],
    ["computer_status", {}],
    ["native_agent_get", { backendId: "codex", agentId: "target-agent" }],
    ["native_agent_update", { ...source, backendId: "codex", agentId: "target-agent", name: "新名称", expectedUpdatedAt: 1 }],
    ["native_agent_archive", { ...source, backendId: "codex", agentId: "target-agent", expectedUpdatedAt: 1 }],
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
    assert.equal(projection.capabilities.length, 71);
    for (const [name] of calls) assert.equal(projection.capabilities.some((item) => item.tool === name), false);
    assert.ok(projection.capabilities.some((item) => item.tool === "federation_agent_list"));
  }
});

test("固定 95 个模型可见产品工具及 strict object schemas，不暴露 authority 字段", () => {
  assert.equal(MCP_PRODUCT_TOOL_NAMES.length, 95);
  assert.equal(new Set(MCP_PRODUCT_TOOL_NAMES).size, 95);
  for (const required of [
    "app_capabilities", "runtime_context_get", "usage_get", "kanban_board_create", "kanban_run_dispatch",
    "cron_create", "cron_delete", "backend_status", "external_cron_list",
    "federation_agent_list", "federation_agent_get", "federation_agent_run",
    "federation_agent_message", "federation_task_get", "federation_task_cancel",
    "skill_catalog", "skill_read", "skill_install_global",
    "mcp_server_list", "mcp_server_register", "mcp_server_tools", "mcp_server_call", "mcp_server_remove",
    "system_application_search", "system_application_launch",
    "system_open_url", "finder_open_folder", "computer_status", "computer_session_open", "computer_snapshot",
    "computer_click", "computer_type", "computer_key",
    "inspiration_list", "inspiration_get", "inspiration_create", "inspiration_update", "inspiration_delete",
    "inspiration_start", "inspiration_executions", "inspiration_cancel", "inspiration_growth_get", "inspiration_growth_set",
    "memory_search", "memory_save", "memory_forget",
    "agent_definition_read", "agent_definition_update",
    "native_agent_create", "native_agent_get", "native_agent_update", "native_agent_archive",
  ]) assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(required), true, required);
  for (const hidden of ["memory_confirm", "external_agent_list", "external_agent_get", "external_agent_run"]) {
    assert.equal(MCP_PRODUCT_TOOL_NAMES.includes(hidden), false, hidden);
  }
  assert.equal(MCP_PRODUCT_TOOL_NAMES.some((name) => name.startsWith("browser_")), false);
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
  assert.equal(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS.includes("browser_session_open"), false);
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
  assert.equal(capabilities.capabilities.length, 95);
  assert.equal(capabilities.capabilities.some((item) => item.tool === "cron_create"), true);
  assert.equal(capabilities.capabilities.some((item) => item.domain === "browser"), false);
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
    ["7d", { backendId: "grok-build", profileIds: [OTHER_PROFILE_ID] }],
  ]);
  assert.equal(statusCalls.length, 1);
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
  assert.deepEqual(catalog.items, [skill]);
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
      runtimeCapabilities: ["mcp", "filesystem", "shell"],
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

test("全局 Skill 与共享 MCP 工具经同一产品入口供原生和联邦 Agent 使用", async () => {
  const extensionCalls = [];
  const server = {
    id: "fetch", name: "Fetch", command: "/Users/fixture/work/fetch",
    args: ["-m", "mcp_server_fetch"], cwd: "/Users/fixture/work", enabled: true,
  };
  const nativeMcpStore = {
    prepare(value) { extensionCalls.push(["prepare", structuredClone(value)]); return { ...value }; },
    list() { return { revision: 1, servers: [] }; },
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
  assert.equal((await fixture.controller.handle("computer_status", {}, authorityFor("1"))).available, true);
  await expectCode(() => fixture.controller.handle("computer_session_open", {
    ...source, allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 120,
  }, authority()), "MCP_TOOL_CONFIRMATION_REQUIRED");
  assert.deepEqual(await fixture.controller.handle("computer_session_open", {
    ...source, allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 120,
  }, authorityFor("2")), session);
  assert.deepEqual(calls.find(([kind]) => kind === "create")[1], {
    profileId: PROFILE_ID,
    workRunId: RUN_ID,
    allowedApplications: ["com.apple.TextEdit"],
    expiresInSeconds: 120,
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
  }, authorityFor("5")), "MCP_TOOL_STATE_CONFLICT");
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
      threadPolicy: "new", threadId: null,
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
    agent: { backendId: "codex", agentId: "agent-other", name: "Other", kind: "native",
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
    backendId: "codex", agentId: "agent-other",
  }, authorityFor("b"))).agent.kind, "native");

  const runArgs = {
    backendId: "codex", agentId: "agent-other", prompt: "do work", timeoutMs: 5_000,
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
  assert.equal((await fixture.controller.handle(
    "runtime_context_get", { runId: "stale-cached-run" }, authorityFor("c"),
  )).effectiveModel, "gpt-5.6-sol", "旧线程缓存的 runId schema 应安全解析唯一 active Run");
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
  ), "MCP_TOOL_NOT_FOUND");
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
    { ...create, backendId: "hermes" }, { ...create, get identity() { assert.fail("must not invoke getter"); } }]) {
    assert.equal(validateMcpProductToolArguments("native_agent_create", args), false);
  }
  const base = { backendId: "codex", agentId: "target-agent", source: "chat", sourceId: "session-a", expectedUpdatedAt: 1 };
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
  const selector = { backendId: "grok-build", agentId: "agent-other" };
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
  for (const code of ["COMPUTER_PERMISSION_REQUIRED", "COMPUTER_DRIVER_UNAVAILABLE", "COMPUTER_PERMISSION_STATUS_FAILED"]) {
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
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS mcp product tool controller unit (${tests.length})`);
})();
