#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Readable } = require("node:stream");
const {
  MCP_CLIENT_REQUEST_TIMEOUT_MS,
  MCP_MAX_FRAME_BYTES,
  MCP_SERVICE_PROTOCOL_VERSION,
  MCP_STDIO_PROTOCOL_VERSION,
  createMcpStdioHandler: createRawMcpStdioHandler,
  runMcpStdioSession,
  startShoggothMcpHelper,
} = require("../app/shoggoth-mcp-helper");
const {
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
} = require("../app/agent-service/interactive-timeouts");
const { MCP_PRODUCT_TOOL_NAMES } = require("../app/agent-service/mcp-product-tool-controller");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("MCP helper 人工确认等待覆盖完整 server-request 窗口", () => {
  assert.equal(MCP_CLIENT_REQUEST_TIMEOUT_MS, DEFAULT_SERVER_REQUEST_TIMEOUT_MS);
  assert.ok(MCP_CLIENT_REQUEST_TIMEOUT_MS > 5 * 60_000);
});

function token(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function createMcpStdioHandler(options = {}) {
  return createRawMcpStdioHandler({
    runtimeAccountId: "runtime-a-account",
    ...options,
  });
}

async function listAllTools(handler, id) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const response = await handler({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} });
    assert.equal(response.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < MCP_MAX_FRAME_BYTES);
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (cursor) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
  } while (cursor);
  return tools;
}

function session(byte, expiresAt) {
  return {
    token: token(byte),
    protocolVersion: MCP_SERVICE_PROTOCOL_VERSION,
    runtimeProfileId: "runtime-a",
    runtimeAccountId: "runtime-a-account",
    profileId: "profile-a",
    expiresAt,
  };
}

function profile() {
  return {
    id: "profile-a",
    agentId: "shoggoth-profile-a",
    name: "Shoggoth",
    runtimeProfileId: "runtime-a",
    runtimeAccountId: "runtime-a-account",
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: true,
    enabled: true,
  };
}

function initialize(id = 1, overrides = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1.0.0" },
      ...overrides,
    },
  };
}

function capturingBufferOutput() {
  const output = new EventEmitter();
  const messages = [];
  const waiters = [];
  output.frames = [];
  output.write = (frame, callback) => {
    output.frames.push(frame);
    const message = JSON.parse(Buffer.from(frame).toString("utf8"));
    if (waiters.length > 0) waiters.shift()(message);
    else messages.push(message);
    callback?.();
    return true;
  };
  output.nextMessage = () => messages.length > 0
    ? Promise.resolve(messages.shift())
    : new Promise((resolve) => waiters.push(resolve));
  return output;
}

function rawJsonLine(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function assertBuffersWiped(buffers) {
  for (const buffer of buffers) {
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer.every((byte) => byte === 0), true);
  }
}

async function initializedHandler(options = {}) {
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x11),
    requestService: async () => profile(),
    ...options,
  });
  const response = await handler(initialize());
  assert.equal(response.error, undefined);
  return handler;
}

async function callProfile(handler, id = 2) {
  return handler({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "profile_get", arguments: {} },
  });
}

test("initialize 必须完整声明 protocolVersion、capabilities 与 clientInfo", async () => {
  const cases = [
    { protocolVersion: MCP_STDIO_PROTOCOL_VERSION },
    { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {} },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture" },
    },
  ];
  for (const [index, params] of cases.entries()) {
    const handler = createMcpStdioHandler({
      runtimeProfileId: "runtime-a",
      sessionToken: token(0x12 + index),
      requestService: async () => profile(),
    });
    const response = await handler({ jsonrpc: "2.0", id: index + 1, method: "initialize", params });
    assert.equal(response.error.code, -32602);
    handler.close();
  }
});

test("initialize 拒绝越界或额外字段并返回当前受支持协议", async () => {
  const invalidParams = [
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "x".repeat(129), version: "1" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { experimental: { fixture: { value: "x".repeat(8 * 1024) } } },
      clientInfo: { name: "fixture", version: "1" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1", secret: "forbidden" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
      token: "forbidden",
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { roots: "not-an-object" },
      clientInfo: { name: "fixture", version: "1" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { unknownCapability: 17 },
      clientInfo: { name: "fixture", version: "1" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: "yes" } },
      clientInfo: { name: "fixture", version: "1" },
    },
    {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { experimental: { invalid: "not-an-object" } },
      clientInfo: { name: "fixture", version: "1" },
    },
  ];
  for (const [index, params] of invalidParams.entries()) {
    const handler = createMcpStdioHandler({
      runtimeProfileId: "runtime-a",
      sessionToken: token(0x20 + index),
      requestService: async () => profile(),
    });
    const response = await handler({ jsonrpc: "2.0", id: index + 1, method: "initialize", params });
    assert.equal(response.error.code, -32602);
    handler.close();
  }

  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x25),
    requestService: async () => profile(),
  });
  const negotiated = await handler(initialize(9, { protocolVersion: "2024-11-05" }));
  assert.equal(negotiated.result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
  handler.close();

  for (const capabilities of [
    { vendorExtension: { version: 1 } },
    { experimental: { "io.modelcontextprotocol/fixture": { enabled: true } } },
    { sampling: { vendorSetting: true }, elicitation: { vendorSetting: true } },
    { roots: { listChanged: false } },
  ]) {
    const extensionHandler = createMcpStdioHandler({
      runtimeProfileId: "runtime-a",
      sessionToken: token(0x2f),
      requestService: async () => profile(),
    });
    const response = await extensionHandler(initialize(10, { capabilities }));
    assert.equal(response.error, undefined, JSON.stringify(capabilities));
    extensionHandler.close();
  }
});

test("request_user_input 只接受严格 questions 输入并通过 MCP elicitation/create 映射结果", async () => {
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x30),
    requestService: async () => profile(),
  });
  const initialized = await handler(initialize(1, {
    capabilities: { elicitation: {} },
  }));
  assert.equal(initialized.error, undefined);
  const listed = await listAllTools(handler, 2);
  assert.deepEqual(listed.map((tool) => tool.name), MCP_PRODUCT_TOOL_NAMES);
  const toolsByName = new Map(listed.map((tool) => [tool.name, tool]));
  assert.deepEqual(toolsByName.get("backend_status").annotations, {
    title: "Shoggoth federation/status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(toolsByName.get("cron_create").annotations.destructiveHint, false);
  assert.equal(toolsByName.get("cron_delete").annotations.destructiveHint, true);
  assert.deepEqual(toolsByName.get("external_cron_list").annotations, {
    title: "Shoggoth federation/cron-list",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  for (const hidden of ["external_agent_list", "external_agent_get", "external_agent_run"]) {
    assert.equal(toolsByName.has(hidden), false);
  }
  assert.equal(toolsByName.get("external_agent_file_write").annotations.openWorldHint, true);
  const argumentsValue = {
    questions: [{
      header: "Choice",
      id: "choice",
      question: "Choose one option",
      options: [
        { label: "Alpha", description: "Use alpha" },
        { label: "Beta", description: "Use beta" },
      ],
    }],
  };
  const outbound = [];
  const response = await handler({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "request_user_input", arguments: argumentsValue },
  }, {
    async requestClient(method, params) {
      outbound.push({ method, params: structuredClone(params) });
      return { action: "accept", content: { choice: "Beta" } };
    },
  });
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].method, "elicitation/create");
  assert.equal(outbound[0].params.requestedSchema.type, "object");
  assert.deepEqual(outbound[0].params.requestedSchema.required, ["choice"]);
  assert.deepEqual(outbound[0].params.requestedSchema.properties.choice.enum, ["Alpha", "Beta"]);
  assert.deepEqual(response.result.structuredContent, {
    answers: { choice: { answers: ["Beta"] } },
  });
  assert.equal(response.result.isError, false);

  const injectedRun = await handler({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "request_user_input",
      arguments: { ...argumentsValue, runId: "attacker-selected-run" },
    },
  }, { requestClient: async () => assert.fail("非法输入不得发起 elicitation") });
  assert.equal(injectedRun.error.code, -32602);

  const cancelled = await handler({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "request_user_input", arguments: argumentsValue },
  }, { requestClient: async () => ({ action: "cancel" }) });
  assert.deepEqual(cancelled.result.structuredContent, { answers: {} });
  handler.close();
});

test("零参数工具兼容 MCP 省略 arguments，有参数工具仍严格拒绝", async () => {
  const serviceCalls = [];
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x33),
    randomUUID: () => "88888888-8888-4888-8888-888888888888",
    requestService: async (_paths, request) => {
      serviceCalls.push(structuredClone(request));
      return profile();
    },
  });
  await handler(initialize(1));
  const omitted = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "profile_get", _meta: { progressToken: "progress-2" } },
  });
  assert.equal(omitted.result.isError, false);
  assert.deepEqual(serviceCalls[0].params.arguments, {});
  assert.equal(Object.hasOwn(serviceCalls[0].params, "_meta"), false);

  const required = await handler({
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "usage_get" },
  });
  assert.equal(required.error.code, -32602);
  assert.equal(serviceCalls.length, 1);

  const unknownTopLevel = await handler({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "profile_get", arguments: {}, authority: "attacker" },
  });
  assert.equal(unknownTopLevel.error.code, -32602);
  assert.equal(serviceCalls.length, 1);
  handler.close();
});

test("computer_snapshot 以 MCP image 返回缩略图且原图只保留私有 Artifact 引用", async () => {
  const thumbnail = Buffer.from("computer-thumbnail").toString("base64");
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x36),
    randomUUID: () => "89898989-8989-4989-8989-898989898989",
    requestService: async () => ({
      sessionId: "79797979-7979-4979-8979-797979797979",
      snapshotRevision: "revision-1",
      pid: 42,
      windowId: 7,
      tree: "",
      elements: [],
      degraded: false,
      image: {
        mimeType: "image/png",
        thumbnailMimeType: "image/jpeg",
        thumbnail,
        artifact: {
          id: "69696969-6969-4969-8969-696969696969",
          storageKey: "abc/image.png",
          sizeBytes: 100,
          sha256: "b".repeat(64),
        },
      },
    }),
  });
  await handler(initialize(1));
  const response = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "computer_snapshot", arguments: {
      source: "chat", sourceId: "session-a",
      sessionId: "79797979-7979-4979-8979-797979797979", pid: 42, windowId: 7,
    } },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.content[0], { type: "image", data: thumbnail, mimeType: "image/jpeg" });
  assert.equal(Object.hasOwn(response.result.structuredContent.image, "thumbnail"), false);
  assert.equal(response.result.structuredContent.image.artifact.storageKey, "abc/image.png");
  handler.close();
});

test("computer_snapshot 超过 64 KiB 时先省略重复 tree 并保留图像与全部可操作 refs", async () => {
  const thumbnail = Buffer.alloc(27 * 1024, 0x5a).toString("base64");
  const elements = Array.from({ length: 138 }, (_, index) => ({
    ref: `c${index + 1}`,
    role: "AXTextField",
    label: `control-${index}`,
    value: `value-${index}`,
    frame: { x: index, y: index, width: 100, height: 24 },
    secure: false,
  }));
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x37),
    randomUUID: () => "90909090-9090-4090-8090-909090909090",
    requestService: async () => ({
      sessionId: "79797979-7979-4979-8979-797979797979",
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
    }),
  });
  await handler(initialize(1));
  const response = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "computer_snapshot", arguments: {
      source: "chat", sourceId: "session-a",
      sessionId: "79797979-7979-4979-8979-797979797979", pid: 42, windowId: 7,
    } },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= 64 * 1024);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].type, "image");
  assert.equal(response.result.structuredContent.tree, "");
  assert.equal(response.result.structuredContent.elements.length, elements.length);
  assert.deepEqual(response.result.structuredContent.outputTruncated, {
    tree: true,
    inlineImage: false,
    originalElementCount: elements.length,
    returnedElementCount: elements.length,
  });
  assert.equal(response.result.structuredContent.degraded, true);
  handler.close();
});

test("工具失败只公开允许的稳定错误码且不泄露私有消息", async () => {
  const invoke = async (code, secret) => {
    const handler = createMcpStdioHandler({
      runtimeProfileId: "runtime-a",
      sessionToken: token(0x38),
      randomUUID: () => "91919191-9191-4191-8191-919191919191",
      requestService: async () => { throw Object.assign(new Error(secret), { code }); },
    });
    await handler(initialize(1));
    const response = await handler({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "computer_status", arguments: {} },
    });
    handler.close();
    return response;
  };
  const stable = await invoke("COMPUTER_ACTION_FAILED", "private-path-secret");
  assert.equal(stable.result.structuredContent.error.code, "COMPUTER_ACTION_FAILED");
  assert.match(stable.result.content[0].text, /COMPUTER_ACTION_FAILED/u);
  assert.doesNotMatch(JSON.stringify(stable), /private-path-secret/u);

  const privateCode = await invoke("PRIVATE_SECRET_CANARY", "another-private-secret");
  assert.equal(privateCode.result.structuredContent.error.code, "SERVICE_REQUEST_FAILED");
  assert.doesNotMatch(JSON.stringify(privateCode), /PRIVATE_SECRET_CANARY|another-private-secret/u);
});

test("破坏性/覆盖类工具必须真实 elicitation，取消与不支持时 Service 零调用", async () => {
  const jobId = "66666666-6666-4666-8666-666666666666";
  let serviceCalls = 0;
  const makeHandler = () => createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x34),
    randomUUID: () => "77777777-7777-4777-8777-777777777777",
    requestService: async (_paths, request) => {
      serviceCalls += 1;
      assert.equal(request.params.name, "cron_delete");
      assert.deepEqual(request.params.arguments, { jobId });
      assert.equal(request.params.confirmation, true);
      return { deleted: true, jobId };
    },
  });

  const unsupported = makeHandler();
  await unsupported(initialize(1));
  const noClientConfirmation = await unsupported({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "cron_delete", arguments: { jobId } },
  });
  assert.equal(noClientConfirmation.result.isError, true);
  assert.equal(serviceCalls, 0);
  unsupported.close();

  const cancelled = makeHandler();
  await cancelled(initialize(3, { capabilities: { elicitation: {} } }));
  let cancelPrompts = 0;
  const cancelResult = await cancelled({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "cron_delete", arguments: { jobId } },
  }, {
    async requestClient(method, params) {
      cancelPrompts += 1;
      assert.equal(method, "elicitation/create");
      assert.equal(params.message.includes(jobId), true);
      return { action: "decline" };
    },
  });
  assert.equal(cancelPrompts, 1);
  assert.equal(cancelResult.result.isError, false);
  assert.deepEqual(cancelResult.result.structuredContent, { canceled: true });
  assert.equal(serviceCalls, 0);
  cancelled.close();

  const accepted = makeHandler();
  await accepted(initialize(5, { capabilities: { elicitation: {} } }));
  const acceptResult = await accepted({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "cron_delete", arguments: { jobId } },
  }, {
    requestClient: async () => ({
      action: "accept", content: { confirm_product_action: "确认执行" },
    }),
  });
  assert.equal(acceptResult.result.isError, false);
  assert.deepEqual(acceptResult.result.structuredContent, { deleted: true, jobId });
  assert.equal(serviceCalls, 1);
  accepted.close();

  const invalidUpdate = makeHandler();
  await invalidUpdate(initialize(7, { capabilities: { elicitation: {} } }));
  const rejected = await invalidUpdate({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: {
      name: "external_agent_update",
      arguments: {
        backendId: "openclaw", agentId: "agent-1", patch: { cloneFromDefault: true },
      },
    },
  }, { requestClient: async () => assert.fail("非法更新不得发起确认") });
  assert.equal(rejected.error.code, -32602);
  assert.equal(serviceCalls, 1);
  invalidUpdate.close();
});

test("灵感删除和自动执行设置通过真实 MCP elicitation 确认，拒绝/不支持时零写入", async () => {
  for (const [name, args, expectedText] of [
    ["inspiration_delete", { id: "11111111-1111-4111-8111-111111111111", expectedRevision: 4 }, "版本 4"],
    ["inspiration_growth_set", { expectedRevision: 2, enabled: true,
      executors: [{ backendId: "deepseek-harness", agentId: "agent-a" }] }, "自动分派已保存的便签"],
    ["inspiration_growth_set", { expectedRevision: 3, enabled: false, executors: [] }, "正在执行的任务会继续"],
  ]) {
    let writes = 0;
    const make = () => createMcpStdioHandler({ runtimeProfileId: "runtime-a", sessionToken: token(0x34),
      requestService: async (_paths, request) => {
        writes += 1;
        assert.equal(request.params.name, name);
        assert.deepEqual(request.params.arguments, args);
        assert.equal(request.params.confirmation, true);
        return { success: true };
      } });
    const message = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
    const unsupported = make();
    await unsupported(initialize(1));
    assert.equal((await unsupported(message)).result.isError, true);
    unsupported.close();
    assert.equal(writes, 0);
    for (const action of ["decline", "accept"]) {
      const handler = make();
      await handler(initialize(1, { capabilities: { elicitation: {} } }));
      const result = await handler(message, { requestClient: async (method, params) => {
        assert.equal(method, "elicitation/create");
        assert.ok(params.message.includes(expectedText));
        return { action, ...(action === "accept" ? { content: { confirm_product_action: "确认执行" } } : {}) };
      } });
      assert.equal(result.result.isError, false);
      assert.equal(writes, action === "accept" ? 1 : 0);
      handler.close();
    }
  }
});

test("Computer Use 只在开/恢复会话确认，已授权会话内输入不重复确认", async () => {
  const calls = [];
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x37),
    randomUUID: () => "90909090-9090-4090-8090-909090909090",
    requestService: async (_paths, request) => {
      calls.push(request);
      if (request.params.name === "computer_status") return {
        available: true, permissions: { accessibility: true, screenRecording: true }, sessions: [],
      };
      return { ok: true };
    },
  });
  await handler(initialize(1, { capabilities: { elicitation: {} } }));
  const open = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "computer_session_open", arguments: {
      source: "chat", sourceId: "session-a",
      allowedApplications: ["com.apple.TextEdit"], expiresInSeconds: 120,
    } },
  }, {
    requestClient: async (_method, params) => {
      assert.equal(params.message.includes("com.apple.TextEdit"), true);
      return { action: "accept", content: { confirm_product_action: "确认执行" } };
    },
  });
  assert.equal(open.result.isError, false);
  const secretText = "fixture-private-input";
  const typed = await handler({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "computer_type", arguments: {
      source: "chat", sourceId: "session-a", sessionId: "computer-session-1",
      snapshotRevision: "revision-1", pid: 42, windowId: 7, ref: "c1", text: secretText,
    } },
  }, {
    requestClient: async () => assert.fail("已确认会话内输入不得重复发起 elicitation"),
  });
  assert.equal(typed.result.isError, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].params.name, "computer_status");
  assert.equal(calls[1].params.confirmation, true);
  assert.equal(Object.hasOwn(calls[2].params, "confirmation"), false);
  assert.equal(calls[2].params.arguments.text, secretText);
  handler.close();
});

test("stdio accept/cancel 全路径清零原始输入 chunk 与 owned 输出 frame", async () => {
  const input = new PassThrough();
  const output = capturingBufferOutput();
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x31),
    requestService: async () => profile(),
  });
  const session = runMcpStdioSession({ input, output, handler, clientRequestTimeoutMs: 500 });
  const rawInputs = [];
  const send = (message) => {
    const raw = rawJsonLine(message);
    rawInputs.push(raw);
    input.write(raw);
  };
  const argumentsValue = {
    questions: [{
      header: "Choice", id: "choice", question: "Choose one option",
      options: [
        { label: "Alpha", description: "Use alpha" },
        { label: "Beta", description: "Use beta" },
      ],
    }],
  };
  try {
    send(initialize(1, { capabilities: { elicitation: {} } }));
    assert.equal((await output.nextMessage()).id, 1);

    send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "request_user_input", arguments: argumentsValue },
    });
    const acceptedRequest = await output.nextMessage();
    assert.equal(acceptedRequest.method, "elicitation/create");
    send({
      jsonrpc: "2.0", id: acceptedRequest.id,
      result: { action: "accept", content: { choice: "Beta" } },
    });
    const accepted = await output.nextMessage();
    assert.deepEqual(accepted.result.structuredContent, {
      answers: { choice: { answers: ["Beta"] } },
    });

    send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "request_user_input", arguments: argumentsValue },
    });
    const cancelledRequest = await output.nextMessage();
    assert.equal(cancelledRequest.method, "elicitation/create");
    send({ jsonrpc: "2.0", id: cancelledRequest.id, result: { action: "cancel" } });
    const cancelled = await output.nextMessage();
    assert.deepEqual(cancelled.result.structuredContent, { answers: {} });
    input.end();
    await session;
    assertBuffersWiped(rawInputs);
    assertBuffersWiped(output.frames);
  } finally {
    input.destroy();
    handler.close();
  }
});

test("stdio parse error、oversize 与 EOF 均清零原始输入 chunk", async () => {
  const runCase = async (raw, options = {}) => {
    const output = capturingBufferOutput();
    const handler = createMcpStdioHandler({
      runtimeProfileId: "runtime-a",
      sessionToken: token(0x32),
      requestService: async () => profile(),
    });
    const input = Readable.from([raw]);
    try {
      const running = runMcpStdioSession({ input, output, handler, ...options });
      if (options.maxFrameBytes) {
        await assert.rejects(
          running,
          (error) => error.code === "MCP_HELPER_FRAME_TOO_LARGE",
        );
      } else {
        await running;
      }
      assertBuffersWiped([raw]);
      assertBuffersWiped(output.frames);
    } finally {
      handler.close();
    }
  };

  await runCase(Buffer.from("{malformed}\n", "utf8"));
  await runCase(Buffer.alloc(1025, 0x78), { maxFrameBytes: 1024 });
  await runCase(Buffer.from('{"jsonrpc":"2.0"', "utf8"));
});

test("parse error 写回同时 EPIPE 仍清零 owned parsed frame", async () => {
  const originalFrom = Buffer.from;
  const parsedFrames = [];
  let writtenFrame = null;
  Buffer.from = function capturingFrom(...args) {
    const created = originalFrom.apply(Buffer, args);
    if (created.toString("utf8") === "{malformed}") parsedFrames.push(created);
    return created;
  };
  const raw = originalFrom("{malformed}\n", "utf8");
  const input = Readable.from([raw]);
  const output = new EventEmitter();
  output.write = (frame) => {
    writtenFrame = frame;
    setImmediate(() => output.emit("error", new Error("parse-epipe-canary")));
    return true;
  };
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x33),
    requestService: async () => profile(),
  });
  try {
    await assert.rejects(
      runMcpStdioSession({ input, output, handler, outputTimeoutMs: 100 }),
      (error) => error.code === "MCP_HELPER_OUTPUT_FAILED"
        && !error.message.includes("parse-epipe-canary"),
    );
  } finally {
    Buffer.from = originalFrom;
    handler.close();
  }
  assert.ok(parsedFrames.length >= 1);
  assertBuffersWiped(parsedFrames);
  assertBuffersWiped([raw, writtenFrame]);
});

test("session 到期前透明刷新并且响应不泄露新旧 token", async () => {
  let now = 9_500;
  let refreshCalls = 0;
  const seenTokens = [];
  const handler = await initializedHandler({
    sessionExpiresAt: 10_000,
    sessionRefreshSkewMs: 1_000,
    now: () => now,
    refreshSession: async () => {
      refreshCalls += 1;
      return session(0x32, 20_000);
    },
    requestService: async (_paths, request) => {
      seenTokens.push(request.params.sessionToken);
      return profile();
    },
  });
  const response = await callProfile(handler);
  assert.equal(response.result.isError, false);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(seenTokens, [token(0x32)]);
  assert.equal(JSON.stringify(response).includes(token(0x11)), false);
  assert.equal(JSON.stringify(response).includes(token(0x32)), false);
  handler.close();
});

test("Service 返回 MCP_SESSION_INVALID 后只刷新并重试一次", async () => {
  let profileCalls = 0;
  let refreshCalls = 0;
  const seenTokens = [];
  const handler = await initializedHandler({
    sessionExpiresAt: 20_000,
    now: () => 1_000,
    refreshSession: async () => {
      refreshCalls += 1;
      return session(0x42, 30_000);
    },
    requestService: async (_paths, request) => {
      profileCalls += 1;
      seenTokens.push(request.params.sessionToken);
      if (profileCalls === 1) {
        const error = new Error("must-not-leak");
        error.code = "MCP_SESSION_INVALID";
        throw error;
      }
      return profile();
    },
  });
  const response = await callProfile(handler);
  assert.equal(response.result.isError, false);
  assert.equal(profileCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(seenTokens, [token(0x11), token(0x42)]);
  assert.equal(JSON.stringify(response).includes("must-not-leak"), false);
  handler.close();
});

test("重试仍无效时停止，且并发到期请求共享一次刷新", async () => {
  let releaseRefresh;
  let refreshCalls = 0;
  const seenTokens = [];
  const handler = await initializedHandler({
    sessionExpiresAt: 10_000,
    sessionRefreshSkewMs: 1_000,
    now: () => 9_500,
    refreshSession: async () => {
      refreshCalls += 1;
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return session(0x52, 30_000);
    },
    requestService: async (_paths, request) => {
      seenTokens.push(request.params.sessionToken);
      throw Object.assign(new Error("rotated-again"), { code: "MCP_SESSION_INVALID" });
    },
  });
  const first = callProfile(handler, 2);
  const second = callProfile(handler, 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  releaseRefresh();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.result.isError), [true, true]);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(seenTokens, [token(0x52), token(0x52)]);
  assert.equal(JSON.stringify(responses).includes("rotated-again"), false);
  handler.close();
});

test("refreshSession 超时有界失败并保持脱敏", async () => {
  const handler = await initializedHandler({
    sessionExpiresAt: 10_000,
    now: () => 10_001,
    refreshTimeoutMs: 10,
    refreshSession: async () => new Promise(() => {}),
  });
  const startedAt = Date.now();
  const response = await callProfile(handler);
  assert.equal(response.result.isError, true);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(JSON.stringify(response).includes("token"), false);
  handler.close();
});

test("helper 入口把 expiresAt 与重新认证接入 stdio handler", async () => {
  let authCalls = 0;
  const profileTokens = [];
  const output = new EventEmitter();
  const input = new PassThrough();
  let written = "";
  output.write = (frame) => {
    written += frame;
    const message = JSON.parse(String(frame));
    if (message.method === "elicitation/create") {
      assert.equal(message.params.message, "Shoggoth internal Runtime call binding v1");
      assert.equal(message.params._meta["shoggoth/runtime-call-binding"].name, "profile_get");
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: {} } })}\n`);
    } else if (message.id === 2) input.end();
    return true;
  };
  const running = startShoggothMcpHelper({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: "runtime-a-account",
    serviceVersion: "0.0.test",
    now: () => 9_500,
    sessionRefreshSkewMs: 1_000,
    authenticateSession: async () => {
      authCalls += 1;
      return session(authCalls === 1 ? 0x61 : 0x62, authCalls === 1 ? 10_000 : 20_000);
    },
    requestService: async (_paths, request) => {
      assert.equal(request.method, "mcp.tool.call");
      assert.equal(request.params.name, "profile_get");
      assert.deepEqual(request.params.arguments, {});
      assert.match(request.params.callId, /^[0-9a-f-]{36}$/u);
      profileTokens.push(request.params.sessionToken);
      return profile();
    },
    safeStorage: {},
    electronApp: { whenReady: async () => {}, quit: () => {} },
    input,
    output,
  });
  input.write(`${JSON.stringify(initialize(1, { capabilities: { elicitation: {} } }))}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "profile_get", arguments: {} } })}\n`);
  await running;
  const responses = written.trim().split("\n").map((line) => JSON.parse(line)).filter(value => !value.method);
  assert.equal(responses[1].result.isError, false);
  assert.equal(authCalls, 2);
  assert.deepEqual(profileTokens, [token(0x62)]);
  assert.equal(written.includes(token(0x61)), false);
  assert.equal(written.includes(token(0x62)), false);
});

function backpressuredOutput() {
  const output = new EventEmitter();
  output.frames = [];
  output.write = (frame) => {
    output.frames.push(frame);
    return false;
  };
  return output;
}

async function runInitializeWithOutput(output, outputTimeoutMs) {
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    sessionToken: token(0x70),
    requestService: async () => profile(),
  });
  try {
    return await runMcpStdioSession({
      input: Readable.from([`${JSON.stringify(initialize())}\n`]),
      output,
      handler,
      outputTimeoutMs,
    });
  } finally {
    handler.close();
  }
}

test("output.write(false) 在 drain 后继续", async () => {
  const output = backpressuredOutput();
  setImmediate(() => output.emit("drain"));
  await runInitializeWithOutput(output, 100);
  assert.equal(output.frames.length, 1);
  assert.equal(Buffer.isBuffer(output.frames[0]), true);
  assert.equal(output.frames[0].every((byte) => byte === 0), true);
});

test("背压等待期间 output close 返回固定脱敏错误", async () => {
  const output = backpressuredOutput();
  setImmediate(() => output.emit("close"));
  const rescue = setTimeout(() => output.emit("drain"), 50);
  try {
    await assert.rejects(
      runInitializeWithOutput(output, 1_000),
      (error) => error.code === "MCP_HELPER_OUTPUT_CLOSED"
        && error.message === "mcp_helper_output_closed",
    );
    assert.equal(Buffer.isBuffer(output.frames[0]), true);
    assert.equal(output.frames[0].every((byte) => byte === 0), true);
  } finally {
    clearTimeout(rescue);
  }
});

test("背压等待超时返回固定脱敏错误", async () => {
  const output = backpressuredOutput();
  const rescue = setTimeout(() => output.emit("drain"), 100);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runInitializeWithOutput(output, 10),
      (error) => error.code === "MCP_HELPER_OUTPUT_TIMEOUT"
        && error.message === "mcp_helper_output_timeout",
    );
    assert.ok(Date.now() - startedAt < 80);
    assert.equal(Buffer.isBuffer(output.frames[0]), true);
    assert.equal(output.frames[0].every((byte) => byte === 0), true);
  } finally {
    clearTimeout(rescue);
  }
});

test("output.write(true) 后的异步 error 也被有界捕获", async () => {
  const output = new EventEmitter();
  let writtenFrame = null;
  output.write = (frame) => {
    writtenFrame = frame;
    setImmediate(() => output.emit("error", new Error("fast-epipe-canary")));
    return true;
  };
  await assert.rejects(
    runInitializeWithOutput(output, 100),
    (error) => error.code === "MCP_HELPER_OUTPUT_FAILED"
      && error.message === "mcp_helper_output_failed"
      && !error.message.includes("fast-epipe-canary"),
  );
  assert.equal(Buffer.isBuffer(writtenFrame), true);
  assert.equal(writtenFrame.every((byte) => byte === 0), true);
});

test("工具目录分页覆盖全部工具，拒绝无效游标且最坏 request ID 不超帧", async () => {
  const handler = createMcpStdioHandler({ runtimeProfileId: "runtime-a", sessionToken: token(0x37),
    requestService: async () => assert.fail("工具目录不应调用 Service"),
  });
  await handler(initialize());
  const id = "\0".repeat(256);
  const first = await handler({ jsonrpc: "2.0", id, method: "tools/list" });
  assert.equal(typeof first.result.nextCursor, "string");
  assert.deepEqual((await listAllTools(handler, id)).map(tool => tool.name), MCP_PRODUCT_TOOL_NAMES);
  for (const params of [{ cursor: "" }, { cursor: 1 }, { cursor: "invalid" }, { cursor: first.result.nextCursor + "x" },
    { injected: true }, null]) {
    const result = await handler({ jsonrpc: "2.0", id: 3, method: "tools/list", params });
    assert.equal(result.error.code, -32602);
  }
  const repeated = await handler({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: {} } });
  assert.deepEqual(repeated, first);
  handler.close();
});

test("电脑操作缺少权限时在确认前失败，并提供具体处理方式", async () => {
  const calls = [];
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a", sessionToken: token(0x37),
    requestService: async (_paths, request) => {
      calls.push(request.params.name);
      return { available: true, permissions: { accessibility: false, screenRecording: true }, sessions: [] };
    },
  });
  await handler(initialize(1, { capabilities: { elicitation: {} } }));
  const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "computer_session_open", arguments: { source: "chat", sourceId: "session-a",
      allowedApplications: ["ai.shoggoth.desktop"], expiresInSeconds: 120 },
  } }, { requestClient: async () => assert.fail("未就绪时不得要求确认") });
  assert.deepEqual(calls, ["computer_status"]);
  assert.equal(result.result.structuredContent.error.code, "COMPUTER_PERMISSION_REQUIRED");
  assert.match(result.result.content[0].text, /辅助功能/u);
  handler.close();
});

test("本地助理修改和归档确认展示已核对目标，拒绝时不写入", async () => {
  for (const tool of ["native_agent_update", "native_agent_archive"]) {
    for (const accept of [true, false]) {
      const calls = [];
      const handler = createMcpStdioHandler({ runtimeProfileId: "runtime-a", sessionToken: token(0x37),
        requestService: async (_paths, request) => {
          calls.push(request);
          if (request.params.name === "native_agent_get") return { agent: {
            backendId: "shoggoth", agentId: "target-agent", name: "星帆", updatedAt: 2,
            state: "active", isDefault: false,
          } };
          assert.equal(request.params.name, tool);
          assert.equal(request.params.confirmation, true);
          return { saved: true };
        },
      });
      await handler(initialize(1, { capabilities: { elicitation: {} } }));
      let prompts = 0;
      const response = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: tool, arguments: { backendId: "shoggoth", agentId: "target-agent", source: "chat", sourceId: "s",
          expectedUpdatedAt: 2, ...(tool === "native_agent_update" ? { name: "新名字", workspace: null } : {}) },
      } }, { requestClient: async (_method, params) => {
        prompts += 1;
        assert.match(params.message, /星帆/u);
        assert.doesNotMatch(params.message, /Computer Use|永久删除/u);
        assert.match(params.message, tool === "native_agent_archive" ? /保留 7 天.*自动删除.*工作区文件和共享账号保留/u : /新名字.*工作目录/u);
        return accept ? { action: "accept", content: { confirm_product_action: "确认执行" } } : { action: "cancel" };
      } });
      assert.equal(prompts, 1);
      assert.equal(response.result.isError, false, JSON.stringify(response.result));
      assert.deepEqual(calls.map(call => call.params.name), accept ? ["native_agent_get", tool] : ["native_agent_get"]);
      handler.close();
    }
  }
});

test("确认期间权限丢失仍被服务拒绝，驱动与读取故障不会弹确认", async () => {
  for (const reason of ["COMPUTER_DRIVER_UNAVAILABLE", "COMPUTER_PERMISSION_STATUS_FAILED", null]) {
    let prompts = 0;
    const handler = createMcpStdioHandler({ runtimeProfileId: "runtime-a", sessionToken: token(0x37),
      requestService: async (_paths, request) => {
        if (request.params.name === "computer_status") return reason
          ? { available: false, reason, permissions: { accessibility: null, screenRecording: null } }
          : { available: true, permissions: { accessibility: true, screenRecording: true } };
        throw Object.assign(new Error("private-path-canary"), { code: "COMPUTER_PERMISSION_REQUIRED" });
      },
    });
    await handler(initialize(1, { capabilities: { elicitation: {} } }));
    const response = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "computer_session_resume", arguments: { source: "chat", sourceId: "s", sessionId: "session-a" },
    } }, { requestClient: async () => {
      prompts += 1; return { action: "accept", content: { confirm_product_action: "确认执行" } };
    } });
    assert.equal(prompts, reason ? 0 : 1);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error.code, reason || "COMPUTER_PERMISSION_REQUIRED");
    assert.doesNotMatch(JSON.stringify(response), /private-path-canary/u);
    handler.close();
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
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
})();
