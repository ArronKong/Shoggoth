#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
let history;
let schemaContract;
let mapper;
let moduleLoadError = null;
try {
  history = require(path.join(ROOT, "app", "agent-service", "codex-chat-history.js"));
  const { CodexSchemaContract } = require(path.join(
    ROOT, "app", "agent-service", "codex-schema-contract.js",
  ));
  schemaContract = new CodexSchemaContract({ repoRoot: ROOT });
  mapper = history.createCodexChatHistoryMapper({
    schemaContract,
    cursorSecret: Buffer.alloc(32, 0x5a),
  });
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fullThread(turns) {
  return {
    cliVersion: "0.149.0",
    cwd: "/workspace",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openrouter",
    preview: "fixture",
    projectId: null,
    sessionId: "session-1",
    source: "appServer",
    status: { type: "idle" },
    createdAt: 100,
    updatedAt: 200,
    turns,
  };
}

function turn(id, items, overrides = {}) {
  return {
    id,
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 100,
    completedAt: 101,
    durationMs: 1000,
    ...overrides,
  };
}

function validated(response) {
  return { value: mapper.validateCodexThreadRead(response) };
}

test("codex-chat-history 模块公开验证、分页与重组入口", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof history.createCodexChatHistoryMapper, "function");
  assert.equal(typeof mapper.validateCodexThreadRead, "function");
  assert.equal(typeof mapper.createCodexChatHistoryPage, "function");
  assert.equal(typeof history.reassembleCodexHistoryFragments, "function");
});

test("mapper 构造只接受 pinned 0.149 CodexSchemaContract 与至少 32B cursor secret", () => {
  const { CodexSchemaContract } = require(path.join(
    ROOT, "app", "agent-service", "codex-schema-contract.js",
  ));
  const contract = new CodexSchemaContract({ repoRoot: ROOT });
  assert.equal(typeof history.createCodexChatHistoryMapper, "function");
  assert.throws(
    () => history.createCodexChatHistoryMapper({
      schemaContract: { version: "0.149.0", validateResponse() {} },
      cursorSecret: Buffer.alloc(32, 1),
    }),
    (error) => error.code === "CODEX_HISTORY_VALIDATOR_REQUIRED",
  );
  const forgedContract = Object.assign(Object.create(CodexSchemaContract.prototype), contract);
  assert.throws(
    () => history.createCodexChatHistoryMapper({
      schemaContract: forgedContract,
      cursorSecret: Buffer.alloc(32, 1),
    }),
    (error) => error.code === "CODEX_HISTORY_VALIDATOR_REQUIRED",
  );
  const patchedContract = new CodexSchemaContract({ repoRoot: ROOT });
  Object.defineProperty(patchedContract, "validateResponse", {
    configurable: true,
    enumerable: true,
    value: () => {},
    writable: true,
  });
  assert.throws(
    () => history.createCodexChatHistoryMapper({
      schemaContract: patchedContract,
      cursorSecret: Buffer.alloc(32, 1),
    }),
    (error) => error.code === "CODEX_HISTORY_VALIDATOR_REQUIRED",
  );
  for (const mutate of [
    (value) => { value.operations = {}; },
    (value) => { value.serverRequests = {}; },
    (value) => { value.v2Schema.definitions.ThreadReadResponse = true; },
    (value) => {
      value.operations = Object.freeze({
        ...value.operations,
        threadRead: Object.freeze({
          ...value.operations.threadRead,
          responseRoot: { title: value.operations.threadRead.responseRoot.title },
        }),
      });
    },
    (value) => {
      const method = Object.keys(value.serverRequests)[0];
      value.serverRequests = Object.freeze({
        ...value.serverRequests,
        [method]: Object.freeze({
          ...value.serverRequests[method],
          root: { title: value.serverRequests[method].root.title },
        }),
      });
    },
  ]) {
    const tamperedContract = new CodexSchemaContract({ repoRoot: ROOT });
    mutate(tamperedContract);
    assert.throws(
      () => history.createCodexChatHistoryMapper({
        schemaContract: tamperedContract,
        cursorSecret: Buffer.alloc(32, 1),
      }),
      (error) => error.code === "CODEX_HISTORY_VALIDATOR_REQUIRED",
    );
  }
  assert.throws(
    () => history.createCodexChatHistoryMapper({
      schemaContract: contract,
      cursorSecret: Buffer.alloc(31, 1),
    }),
    (error) => error.code === "CODEX_HISTORY_CURSOR_SECRET_INVALID",
  );
  const mapper = history.createCodexChatHistoryMapper({
    schemaContract: contract,
    cursorSecret: Buffer.alloc(32, 1),
  });
  assert.equal(typeof mapper.validateCodexThreadRead, "function");
  assert.equal(typeof mapper.createCodexChatHistoryPage, "function");
  assert.equal(typeof mapper.reassembleCodexHistoryFragments, "function");
  assert.equal(history.validateCodexThreadRead, undefined);
  assert.equal(history.createCodexChatHistoryPage, undefined);

  const mutableOptions = {
    schemaContract: contract,
    cursorSecret: Buffer.alloc(32, 2),
  };
  const capturedMapper = history.createCodexChatHistoryMapper(mutableOptions);
  mutableOptions.schemaContract = { version: "0.149.0", validateResponse() {} };
  assert.throws(
    () => capturedMapper.validateCodexThreadRead({
      thread: { id: "invalid", modelProvider: "openai", turns: [] },
    }),
    (error) => error.code === "CODEX_SCHEMA_ERROR",
  );

  const postMutatedContract = new CodexSchemaContract({ repoRoot: ROOT });
  const postMutationMapper = history.createCodexChatHistoryMapper({
    schemaContract: postMutatedContract,
    cursorSecret: Buffer.alloc(32, 3),
  });
  assert.equal(Object.isFrozen(postMutatedContract), true);
  assert.equal(Object.isFrozen(postMutatedContract.v2Schema), true);
  assert.equal(Reflect.set(postMutatedContract, "validateResponse", () => {}), false);
  assert.equal(Reflect.set(postMutatedContract, "operations", {}), false);
  assert.throws(
    () => postMutationMapper.validateCodexThreadRead({
      thread: { id: "invalid", modelProvider: "openai", turns: [] },
    }),
    (error) => error.code === "CODEX_SCHEMA_ERROR",
  );
});

test("schema validator 原型在 factory 前与 mapper 创建后都不能被替换绕过", () => {
  const { CodexSchemaContract } = require(path.join(
    ROOT, "app", "agent-service", "codex-schema-contract.js",
  ));
  const invalidResponse = {
    thread: { id: "invalid", modelProvider: "openai", turns: [] },
  };
  let existingMapperAccepted = false;
  let factoryAccepted = false;

  const originalValidate = CodexSchemaContract.prototype._validate;
  const changedValidate = Reflect.set(CodexSchemaContract.prototype, "_validate", () => {});
  try {
    try {
      mapper.validateCodexThreadRead(invalidResponse);
      existingMapperAccepted = true;
    } catch (error) {
      assert.equal(error.code, "CODEX_SCHEMA_ERROR");
    }
  } finally {
    if (changedValidate) Reflect.set(CodexSchemaContract.prototype, "_validate", originalValidate);
  }

  const originalValidateResponse = CodexSchemaContract.prototype.validateResponse;
  const changedValidateResponse = Reflect.set(
    CodexSchemaContract.prototype,
    "validateResponse",
    () => {},
  );
  try {
    const preFactoryMapper = history.createCodexChatHistoryMapper({
      schemaContract: new CodexSchemaContract({ repoRoot: ROOT }),
      cursorSecret: Buffer.alloc(32, 4),
    });
    try {
      preFactoryMapper.validateCodexThreadRead(invalidResponse);
      factoryAccepted = true;
    } catch (error) {
      assert.equal(error.code, "CODEX_SCHEMA_ERROR");
    }
  } finally {
    if (changedValidateResponse) {
      Reflect.set(CodexSchemaContract.prototype, "validateResponse", originalValidateResponse);
    }
  }

  assert.deepEqual(
    { existingMapperAccepted, factoryAccepted },
    { existingMapperAccepted: false, factoryAccepted: false },
  );
  assert.equal(Object.isFrozen(CodexSchemaContract.prototype), true);
});

test("仅映射经过 ThreadRead schema contract 验证且 itemsView=full 的不可变快照", () => {
  const response = {
    thread: fullThread([turn("turn-1", [
      {
        type: "userMessage",
        id: "user-1",
        clientId: "client-1",
        content: [{ type: "text", text: "hello", text_elements: [] }],
      },
      {
        type: "agentMessage",
        id: "agent-1",
        text: "world",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
      },
    ])]),
  };
  assert.throws(
    () => mapper.createCodexChatHistoryPage(response, { cursor: null, limit: 10 }),
    (error) => error.code === "CODEX_HISTORY_THREAD_NOT_VALIDATED",
  );
  const accepted = validated(response);
  response.thread.turns[0].items[0].content[0].text = "mutated-after-validation";
  const page = mapper.createCodexChatHistoryPage(accepted.value, {
    cursor: null,
    limit: 10,
    model: "openai/gpt-5",
  });
  assert.equal(page.messages.length, 2);
  assert.deepEqual(page.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(page.messages[0].content[0].text, "hello");
  assert.equal(page.messages[1].content[0].text, "world");
  assert.equal(page.messages[1].timestamp, 101000);
  assert.equal(page.messages[1].model, "openai/gpt-5");
  assert.equal(page.messages[1].provider, "openrouter");
  assert.equal(page.messages[1].codex.turnId, "turn-1");
  assert.equal(page.messages[1].codex.status, "completed");
  assert.equal(page.messages[1].codex.startedAt, 100000);
  assert.equal(page.messages[1].codex.completedAt, 101000);
  assert.equal(page.messages[1].codex.durationMs, 1000);
  assert.equal(page.messages[1].usage, null);

  const incomplete = { thread: fullThread([turn("turn-x", [], { itemsView: "summary" })]) };
  assert.throws(
    () => mapper.validateCodexThreadRead(incomplete),
    (error) => error.code === "CODEX_HISTORY_INCOMPLETE",
  );
});

test("0.149 schema 默认 itemsView 缺省时按 full 接受", () => {
  const defaultedTurn = turn("turn-default-view", [{
    type: "agentMessage",
    id: "agent-default-view",
    text: "schema default",
  }]);
  delete defaultedTurn.itemsView;
  const handle = validated({ thread: fullThread([defaultedTurn]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 1 });
  assert.equal(page.messages[0].content[0].text, "schema default");
});

test("仅 federation operationId 映射为 inter-session provenance", () => {
  const handle = validated({ thread: fullThread([
    turn("turn-direct", [{
      type: "userMessage",
      id: "user-direct",
      clientId: "direct-send-1",
      content: [{ type: "text", text: "human input", text_elements: [] }],
    }]),
    turn("turn-federated", [{
      type: "userMessage",
      id: "user-federated",
      clientId: "federation-send-tool-call-1",
      content: [{ type: "text", text: "agent input", text_elements: [] }],
    }]),
  ]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 10 });
  assert.equal(Object.hasOwn(page.messages[0], "provenance"), false);
  assert.deepEqual(page.messages[1].provenance, {
    kind: "inter_session",
    sourceTool: "federation_agent_run",
  });
});

test("0.149 reasoning 缺省 summary/content 时归一为空数组", () => {
  const handle = validated({ thread: fullThread([turn("turn-reasoning-defaults", [{
    type: "reasoning",
    id: "reasoning-defaults",
  }])]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 1 });
  assert.deepEqual(page.messages[0].content, []);
});

test("0.149 tool 可选结果与 failure 缺省时使用稳定空值且不误报失败", () => {
  const items = [
    {
      type: "mcpToolCall",
      id: "mcp-defaults",
      server: "server",
      tool: "tool",
      status: "completed",
      arguments: {},
    },
    {
      type: "dynamicToolCall",
      id: "dynamic-defaults",
      tool: "dynamic",
      status: "completed",
      arguments: {},
    },
    { type: "webSearch", id: "web-defaults", query: "query" },
    {
      type: "imageGeneration",
      id: "image-defaults",
      status: "completed",
      result: "image-result",
    },
  ];
  const handle = validated({ thread: fullThread([turn("turn-tool-defaults", items)]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 10 });
  assert.deepEqual(page.messages.slice(0, 3).map((message) => ({
    content: message.content[1].content,
    isError: message.content[1].is_error,
  })), [
    { content: "", isError: false },
    { content: "", isError: false },
    { content: "", isError: false },
  ]);
  assert.equal(page.messages[3].content[1].content, "image-result");
  assert.equal(page.messages[3].content[1].is_error, false);
});

test("history 合同列出的缺省值与显式默认值生成相同消息和 content revision", () => {
  const omittedTurn = turn("turn-canonical-defaults", [
    { type: "reasoning", id: "reason-canonical" },
    {
      type: "mcpToolCall",
      id: "mcp-canonical",
      server: "server",
      tool: "tool",
      status: "completed",
      arguments: {},
    },
    {
      type: "dynamicToolCall",
      id: "dynamic-canonical",
      tool: "dynamic",
      status: "completed",
      arguments: {},
    },
    { type: "webSearch", id: "web-canonical", query: "query" },
    {
      type: "imageGeneration",
      id: "image-canonical",
      status: "completed",
      result: "image-result",
    },
    {
      type: "commandExecution",
      id: "command-canonical",
      command: "pwd",
      cwd: "/workspace",
      commandActions: [],
      status: "completed",
    },
  ]);
  delete omittedTurn.itemsView;
  const explicitTurn = structuredClone(omittedTurn);
  explicitTurn.itemsView = "full";
  explicitTurn.items[0].summary = [];
  explicitTurn.items[0].content = [];
  explicitTurn.items[1].error = null;
  explicitTurn.items[1].result = null;
  explicitTurn.items[2].contentItems = null;
  explicitTurn.items[3].results = null;
  explicitTurn.items[4].failure = null;
  explicitTurn.items[5].source = "agent";
  const omittedPage = mapper.createCodexChatHistoryPage(
    validated({ thread: fullThread([omittedTurn]) }).value,
    { cursor: null, limit: 20 },
  );
  const explicitPage = mapper.createCodexChatHistoryPage(
    validated({ thread: fullThread([explicitTurn]) }).value,
    { cursor: null, limit: 20 },
  );
  assert.equal(omittedPage.revision, explicitPage.revision);
  assert.deepEqual(omittedPage.messages, explicitPage.messages);
});

test("seek cursor 从最新页向旧页稳定分页并绑定 thread 与 content revision", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "agentMessage",
    id: `agent-${index + 1}`,
    text: `message-${index + 1}`,
    phase: index === 4 ? "final_answer" : "commentary",
    memoryCitation: null,
    delivery: null,
  }));
  const firstHandle = validated({ thread: fullThread([turn("turn-page", items)]) }).value;
  const latest = mapper.createCodexChatHistoryPage(firstHandle, { cursor: null, limit: 2 });
  const latestWithOmittedCursor = mapper.createCodexChatHistoryPage(firstHandle, { limit: 2 });
  const latestWithUndefinedCursor = mapper.createCodexChatHistoryPage(
    firstHandle,
    { cursor: undefined, limit: 2 },
  );
  assert.deepEqual(latestWithOmittedCursor, latest);
  assert.deepEqual(latestWithUndefinedCursor, latest);
  assert.deepEqual(
    latest.messages.map((message) => message.content[0].text),
    ["message-4", "message-5"],
  );
  assert.equal(latest.hasMore, true);
  assert.equal(typeof latest.nextCursor, "string");

  const middle = mapper.createCodexChatHistoryPage(firstHandle, {
    cursor: latest.nextCursor,
    limit: 2,
  });
  assert.deepEqual(
    middle.messages.map((message) => message.content[0].text),
    ["message-2", "message-3"],
  );
  const oldest = mapper.createCodexChatHistoryPage(firstHandle, {
    cursor: middle.nextCursor,
    limit: 2,
  });
  assert.deepEqual(oldest.messages.map((message) => message.content[0].text), ["message-1"]);
  assert.equal(oldest.hasMore, false);
  assert.equal(oldest.nextCursor, null);

  const changedItems = structuredClone(items);
  changedItems[0].text = "changed";
  const changed = validated({ thread: fullThread([turn("turn-page", changedItems)]) }).value;
  assert.throws(
    () => mapper.createCodexChatHistoryPage(changed, { cursor: latest.nextCursor, limit: 2 }),
    (error) => error.code === "CODEX_HISTORY_CURSOR_STALE",
  );
  const otherThread = fullThread([turn("turn-page", items)]);
  otherThread.id = "thread-2";
  const other = validated({ thread: otherThread }).value;
  assert.throws(
    () => mapper.createCodexChatHistoryPage(other, { cursor: latest.nextCursor, limit: 2 }),
    (error) => error.code === "CODEX_HISTORY_CURSOR_THREAD_MISMATCH",
  );
  for (const limit of [0, 101, 1.5]) {
    assert.throws(
      () => mapper.createCodexChatHistoryPage(firstHandle, { cursor: null, limit }),
      (error) => error.code === "CODEX_HISTORY_LIMIT_INVALID",
    );
  }
});

test("cursor 使用 HMAC 绑定 thread、revision、position 与 mapper secret", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    type: "agentMessage",
    id: `cursor-agent-${index}`,
    text: `cursor-message-${index}`,
  }));
  const response = { thread: fullThread([turn("turn-cursor-mac", items)]) };
  const handle = validated(response).value;
  const latest = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 2 });
  const parts = latest.nextCursor.split(".");
  const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  payload.b = 1;
  const tamperedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const tampered = parts.length === 2 ? `${tamperedPayload}.${parts[1]}` : tamperedPayload;
  assert.throws(
    () => mapper.createCodexChatHistoryPage(handle, { cursor: tampered, limit: 2 }),
    (error) => error.code === "CODEX_HISTORY_CURSOR_INVALID",
  );

  const otherMapper = history.createCodexChatHistoryMapper({
    schemaContract,
    cursorSecret: Buffer.alloc(32, 0x6b),
  });
  assert.throws(
    () => otherMapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 2 }),
    (error) => error.code === "CODEX_HISTORY_THREAD_NOT_VALIDATED",
  );
  const otherHandle = otherMapper.validateCodexThreadRead(response);
  assert.throws(
    () => otherMapper.createCodexChatHistoryPage(otherHandle, {
      cursor: latest.nextCursor,
      limit: 2,
    }),
    (error) => error.code === "CODEX_HISTORY_CURSOR_INVALID",
  );
});

test("revision 只取决于最终脱敏 DTO，不暴露 registered secret 候选值 oracle", () => {
  const candidateSecret = "HISTORY-ORACLE-CANDIDATE-12345";
  const thread = fullThread([turn("turn-revision-oracle", [{
    type: "agentMessage",
    id: "agent-revision-oracle",
    text: "public answer",
  }])]);
  // preview 不在 Gateway canonical DTO 中；注册正确或错误候选值不应改变 revision。
  thread.preview = candidateSecret;
  const handle = validated({ thread }).value;
  const matchingCandidate = mapper.createCodexChatHistoryPage(handle, {
    cursor: null,
    limit: 10,
    registeredSecrets: [candidateSecret],
  });
  const wrongCandidate = mapper.createCodexChatHistoryPage(handle, {
    cursor: null,
    limit: 10,
    registeredSecrets: ["HISTORY-ORACLE-WRONG-67890"],
  });
  assert.deepEqual(matchingCandidate.messages, wrongCandidate.messages);
  assert.equal(matchingCandidate.revision, wrongCandidate.revision);
});

test("所有 history page 分支都对完整 JSONL envelope 执行严格 64KiB 预算", () => {
  const oversized = fullThread([]);
  oversized.id = "t".repeat(70 * 1024);
  const handle = validated({ thread: oversized }).value;
  assert.throws(
    () => mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 1 }),
    (error) => error.code === "CODEX_HISTORY_PAGE_LIMIT",
  );

  const empty = validated({ thread: fullThread([]) }).value;
  const page = mapper.createCodexChatHistoryPage(empty, { cursor: null, limit: 1 });
  assert.equal(Buffer.byteLength(`${JSON.stringify(page)}\n`, "utf8") < 64 * 1024, true);
});

test("循环或超深 schema-valid opaque 输入在 clone/freeze 前受控拒绝", () => {
  const cyclicArguments = {};
  cyclicArguments.self = cyclicArguments;
  const cyclic = { thread: fullThread([turn("turn-cycle", [{
    type: "mcpToolCall",
    id: "mcp-cycle",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: cyclicArguments,
    result: null,
    error: null,
  }])]) };
  assert.doesNotThrow(() => schemaContract.validateResponse("threadRead", cyclic));
  assert.throws(
    () => mapper.validateCodexThreadRead(cyclic),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );

  let deepArguments = "leaf";
  for (let depth = 0; depth < 80; depth += 1) deepArguments = { child: deepArguments };
  const tooDeep = { thread: fullThread([turn("turn-deep", [{
    type: "mcpToolCall",
    id: "mcp-deep",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: deepArguments,
    result: null,
    error: null,
  }])]) };
  assert.doesNotThrow(() => schemaContract.validateResponse("threadRead", tooDeep));
  assert.throws(
    () => mapper.validateCodexThreadRead(tooDeep),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );
});

test("schema-valid MCP arguments 的 __proto__ 保留为冻结 own data property", () => {
  const argumentsWithProto = JSON.parse(
    '{"__proto__":{"polluted":"owned-value"},"safe":"value"}',
  );
  const handle = validated({ thread: fullThread([turn("turn-proto-key", [{
    type: "mcpToolCall",
    id: "mcp-proto-key",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: argumentsWithProto,
    result: null,
    error: null,
  }])]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 10 });
  const outputArguments = page.messages[0].content[0].arguments;
  const descriptor = Object.getOwnPropertyDescriptor(outputArguments, "__proto__");
  assert.equal(Object.hasOwn(outputArguments, "__proto__"), true);
  assert.equal("value" in descriptor, true);
  assert.deepEqual(descriptor.value, { polluted: "owned-value" });
  assert.equal(Object.isFrozen(outputArguments), true);
  assert.equal(Object.isFrozen(descriptor.value), true);
  assert.equal({}.polluted, undefined);
});

test("history 图预算允许共享 DAG 且对指数展开字节稳定 fail closed", () => {
  const sharedLeaf = { value: "ok" };
  assert.doesNotThrow(() => mapper.validateCodexThreadRead({
    thread: fullThread([turn("turn-small-dag", [{
      type: "mcpToolCall",
      id: "mcp-small-dag",
      server: "server",
      tool: "tool",
      status: "completed",
      arguments: { left: sharedLeaf, right: sharedLeaf },
      result: null,
      error: null,
    }])]),
  }));

  let expandingDag = { value: "12345678" };
  for (let depth = 0; depth < 18; depth += 1) {
    expandingDag = { left: expandingDag, right: expandingDag };
  }
  const oversized = { thread: fullThread([turn("turn-expanding-dag", [{
    type: "mcpToolCall",
    id: "mcp-expanding-dag",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: expandingDag,
    result: null,
    error: null,
  }])]) };
  assert.doesNotThrow(() => schemaContract.validateResponse("threadRead", oversized));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => mapper.validateCodexThreadRead(oversized),
      (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
    );
  }
});

test("history 图预算对单容器过宽稳定 fail closed", () => {
  const tooWide = Object.fromEntries(
    Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, index]),
  );
  const response = { thread: fullThread([turn("turn-wide", [{
    type: "mcpToolCall",
    id: "mcp-wide",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: tooWide,
    result: null,
    error: null,
  }])]) };
  assert.doesNotThrow(() => schemaContract.validateResponse("threadRead", response));
  assert.throws(
    () => mapper.validateCodexThreadRead(response),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );
});

test("history 图预算对全局节点过多稳定 fail closed", () => {
  const tooManyNodes = Array.from({ length: 2_000 }, (_, row) => Object.fromEntries(
    Array.from({ length: 30 }, (_, column) => [`key-${column}`, row * 30 + column]),
  ));
  const response = { thread: fullThread([turn("turn-many-nodes", [{
    type: "mcpToolCall",
    id: "mcp-many-nodes",
    server: "server",
    tool: "tool",
    status: "completed",
    arguments: tooManyNodes,
    result: null,
    error: null,
  }])]) };
  assert.doesNotThrow(() => schemaContract.validateResponse("threadRead", response));
  assert.throws(
    () => mapper.validateCodexThreadRead(response),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );
});

test("fragment reassemble 公开入口同样拒绝循环与超过 64 层输入", () => {
  const cyclicMessage = { id: "cyclic-message", role: "assistant" };
  cyclicMessage.self = cyclicMessage;
  assert.throws(
    () => history.reassembleCodexHistoryFragments([cyclicMessage]),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );

  let deepPayload = "leaf";
  for (let depth = 0; depth < 80; depth += 1) deepPayload = { child: deepPayload };
  assert.throws(
    () => history.reassembleCodexHistoryFragments([{
      id: "deep-message",
      role: "assistant",
      payload: deepPayload,
    }]),
    (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
  );
});

test("page options 与 usageByTurn 必须是有界 stable JSON", () => {
  const handle = validated({ thread: fullThread([]) }).value;
  const cyclicUsage = {};
  cyclicUsage.self = cyclicUsage;
  let deepUsage = "leaf";
  for (let depth = 0; depth < 80; depth += 1) deepUsage = { child: deepUsage };
  for (const options of [
    null,
    { cursor: undefined, limit: 1, usageByTurn: undefined },
    { limit: 1, usageByTurn: cyclicUsage },
    { limit: 1, usageByTurn: deepUsage },
  ]) {
    assert.throws(
      () => mapper.createCodexChatHistoryPage(handle, options),
      (error) => error.code === "CODEX_HISTORY_INPUT_INVALID",
    );
  }
});

test("秒级时间乘为毫秒后非 safe integer 时按相邻 nullable 语义返回 null", () => {
  const handle = validated({ thread: fullThread([turn("turn-time-overflow", [{
    type: "agentMessage",
    id: "agent-time-overflow",
    text: "time",
  }], {
    startedAt: Number.MAX_SAFE_INTEGER,
    completedAt: Number.MAX_SAFE_INTEGER,
  })]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 1 });
  assert.equal(page.messages[0].timestamp, null);
  assert.equal(page.messages[0].codex.startedAt, null);
  assert.equal(page.messages[0].codex.completedAt, null);
});

test("按 turn/item 顺序映射 reasoning、plan、tool、status、error、usage 与 model", () => {
  const items = [
    { type: "reasoning", id: "reason-1", summary: ["summary"], content: ["detail"] },
    { type: "plan", id: "plan-1", text: "1. inspect\n2. fix" },
    {
      type: "commandExecution",
      id: "command-1",
      command: "npm test",
      cwd: "/workspace",
      status: "failed",
      aggregatedOutput: "one test failed",
      exitCode: 1,
      durationMs: 40,
      source: "agent",
      commandActions: [],
      pluginId: null,
      scriptPath: null,
      processId: null,
    },
    {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "files",
      tool: "read",
      status: "completed",
      arguments: { path: "a.txt" },
      result: { content: [{ type: "text", text: "file body" }], structuredContent: null, _meta: null },
      error: null,
      durationMs: 5,
    },
    {
      type: "dynamicToolCall",
      id: "dynamic-1",
      namespace: "demo",
      tool: "lookup",
      arguments: { q: "needle" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "found" }],
      success: true,
      durationMs: 7,
    },
    {
      type: "fileChange",
      id: "file-1",
      changes: [{ path: "a.txt", kind: { type: "update", move_path: null }, diff: "-a\n+b" }],
      status: "completed",
    },
    { type: "contextCompaction", id: "compact-rich", rawSecretField: "must-not-copy" },
  ];
  const failedTurn = turn("turn-rich", items, {
    status: "failed",
    error: {
      message: "provider failed",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: "retry later",
    },
  });
  const handle = validated({ thread: fullThread([failedTurn]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, {
    cursor: null,
    limit: 20,
    model: "fallback-model",
    usageByTurn: {
      "turn-rich": {
        model: "actual-model",
        usage: { input: 11, output: 7, totalTokens: 18 },
      },
    },
  });
  assert.deepEqual(page.messages.map((message) => message.codex.itemType), [
    "reasoning", "plan", "commandExecution", "mcpToolCall",
    "dynamicToolCall", "fileChange", "contextCompaction",
  ]);
  assert.deepEqual(page.messages[0].content, [
    { type: "thinking", thinking: "summary", reasoningKind: "summary" },
    { type: "thinking", thinking: "detail", reasoningKind: "content" },
  ]);
  assert.deepEqual(page.messages[1].content, [
    { type: "text", text: "1. inspect\n2. fix", semanticType: "plan" },
  ]);
  assert.equal(page.messages[2].content[0].type, "toolCall");
  assert.equal(page.messages[2].content[0].toolName, "command");
  assert.equal(page.messages[2].content[1].type, "tool_result");
  assert.equal(page.messages[2].content[1].content, "one test failed");
  assert.equal(page.messages[2].content[1].is_error, true);
  assert.equal(page.messages[3].content[0].toolName, "files/read");
  assert.match(page.messages[3].content[1].content, /file body/);
  assert.equal(page.messages[4].content[0].toolName, "demo/lookup");
  assert.match(page.messages[4].content[1].content, /found/);
  assert.equal(page.messages[5].content[0].toolName, "fileChange");
  assert.match(page.messages[5].content[1].content, /a\.txt/);
  assert.equal(page.messages[6].unsupported, undefined);
  assert.equal(JSON.stringify(page.messages[6]).includes("must-not-copy"), false);
  for (const message of page.messages) {
    assert.equal(message.stopReason, "error");
    assert.equal(message.isError, true);
    assert.equal(message.errorMessage, "provider failed\nretry later");
    assert.equal(message.codex.errorCode, "serverOverloaded");
    assert.equal(message.model, "actual-model");
    assert.deepEqual(message.usage, { input: 11, output: 7, totalTokens: 18 });
  }

  const emptyFailure = validated({ thread: fullThread([
    turn("turn-empty-failure", [], {
      status: "failed",
      error: { message: "empty failure", codexErrorInfo: "other", additionalDetails: null },
    }),
  ]) }).value;
  const synthetic = mapper.createCodexChatHistoryPage(emptyFailure, { cursor: null, limit: 2 });
  assert.equal(synthetic.messages.length, 1);
  assert.equal(synthetic.messages[0].codex.itemType, "turnStatus");
  assert.equal(synthetic.messages[0].content[0].text, "empty failure");
});

test("registered secret 与原始错误在所有 history DTO 字段中统一脱敏", () => {
  const secret = "SECRET-CANARY-12345"; // gitleaks:allow -- synthetic test fixture; not a usable credential
  const secretThread = fullThread([
    turn(`turn-${secret}`, [
      {
        type: "userMessage",
        id: `user-${secret}`,
        clientId: null,
        content: [{ type: "text", text: `ask ${secret}`, text_elements: [] }],
      },
      {
        type: "commandExecution",
        id: "command-secret",
        command: `print ${secret}`,
        cwd: "/workspace",
        status: "failed",
        aggregatedOutput: `output ${secret} sk-proj-abcdefghijklmnop`,
        exitCode: 1,
        durationMs: 2,
        source: "agent",
        commandActions: [],
      },
      { type: "contextCompaction", id: `compact-${secret}`, raw: secret },
    ], {
      status: "failed",
      error: {
        message: `failure ${secret}`,
        codexErrorInfo: "other",
        additionalDetails: "authorization: abcdefghijklmnop",
      },
    }),
  ]);
  secretThread.id = `thread-${secret}`;
  secretThread.modelProvider = `provider-${secret}`;
  const handle = validated({ thread: secretThread }).value;
  const page = mapper.createCodexChatHistoryPage(handle, {
    cursor: null,
    limit: 10,
    model: `model-${secret}`,
    registeredSecrets: [secret],
  });
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("sk-proj-abcdefghijklmnop"), false);
  assert.equal(serialized.includes("abcdefghijklmnop"), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
  assert.equal(page.threadId, "thread-[REDACTED]");
  assert.equal(page.messages[0].content[0].text, "ask [REDACTED]");
  assert.equal(page.messages[1].content[1].is_error, true);
  assert.equal(page.messages[2].unsupported, undefined);
  assert.equal(page.messages[2].codex.itemId, "compact-[REDACTED]");
  assert.equal(JSON.stringify(page.messages[2]).includes('"raw"'), false);
});

test("超长 text/tool output 稳定分片、跨 seek 页无损重组且严格满足响应预算", () => {
  const longText = `开头🙂${"文".repeat(90_000)}结尾`;
  const longOutput = `stdout\n${"x\\\"\n".repeat(60_000)}done`;
  const response = { thread: fullThread([turn("turn-fragments", [
    {
      type: "userMessage",
      id: "user-long",
      clientId: null,
      content: [{ type: "text", text: longText, text_elements: [] }],
    },
    {
      type: "commandExecution",
      id: "command-long",
      command: "produce-output",
      cwd: "/workspace",
      status: "completed",
      aggregatedOutput: longOutput,
      exitCode: 0,
      durationMs: 99,
      source: "agent",
      commandActions: [],
    },
  ])]) };
  const handle = validated(response).value;
  const collected = [];
  const pages = [];
  let cursor = null;
  do {
    const page = mapper.createCodexChatHistoryPage(handle, { cursor, limit: 100 });
    pages.push(page);
    assert.equal(Buffer.byteLength(`${JSON.stringify(page)}\n`, "utf8") < 64 * 1024, true);
    assert.equal(page.messages.length >= 1 && page.messages.length <= 100, true);
    for (const entry of page.messages) {
      assert.equal(Buffer.byteLength(JSON.stringify(entry), "utf8") < 48 * 1024, true);
      if (entry.kind === "fragment") {
        assert.match(entry.fragment.messageId, /^codex-[a-f0-9]{32}$/);
        assert.match(entry.fragment.sha256, /^[a-f0-9]{64}$/);
        assert.equal(entry.fragment.encoding, "gateway-message-json-utf8");
        assert.equal(entry.fragment.index >= 0 && entry.fragment.index < entry.fragment.count, true);
      }
    }
    collected.unshift(...page.messages);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(pages.length > 2, true);
  const canonical = history.reassembleCodexHistoryFragments(collected);
  assert.equal(canonical.length, 2);
  assert.equal(canonical[0].content[0].text, longText);
  assert.equal(canonical[1].content[1].content, longOutput);
  assert.equal(Buffer.byteLength(JSON.stringify(canonical[0]), "utf8") > 48 * 1024, true);

  const latestAgain = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 100 });
  assert.deepEqual(latestAgain, pages[0]);
  const incomplete = collected.filter((entry) => (
    entry.kind !== "fragment" || entry.fragment.index !== 0
  ));
  assert.throws(
    () => history.reassembleCodexHistoryFragments(incomplete),
    (error) => error.code === "CODEX_HISTORY_FRAGMENT_INCOMPLETE",
  );
});

test("其余 0.149 ThreadItem 以 Gateway 可消费的文本或 tool lifecycle 安全降级", () => {
  const items = [
    {
      type: "hookPrompt",
      id: "hook-1",
      fragments: [
        { text: "hook one", hookRunId: "run-1" },
        { text: "hook two", hookRunId: "run-2" },
      ],
    },
    {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "sender",
      receiverThreadIds: ["receiver"],
      prompt: "delegate",
      model: null,
      reasoningEffort: null,
      agentsStates: { receiver: { status: "completed" } },
    },
    {
      type: "subAgentActivity",
      id: "subagent-1",
      kind: "started",
      agentThreadId: "agent-thread",
      agentPath: "worker",
    },
    {
      type: "webSearch",
      id: "web-1",
      query: "Codex",
      action: null,
      results: [{ title: "Result" }],
    },
    { type: "imageView", id: "image-view-1", path: "/tmp/image.png" },
    {
      type: "imageGeneration",
      id: "image-gen-1",
      status: "completed",
      revisedPrompt: "a shape",
      result: "image-result",
      failure: null,
    },
    { type: "sleep", id: "sleep-1", durationMs: 1000 },
    { type: "enteredReviewMode", id: "review-in", review: "review instructions" },
    { type: "exitedReviewMode", id: "review-out", review: "review result" },
    { type: "contextCompaction", id: "compact-1" },
  ];
  const handle = validated({ thread: fullThread([turn("turn-more", items)]) }).value;
  const page = mapper.createCodexChatHistoryPage(handle, { cursor: null, limit: 20 });
  assert.equal(page.messages.length, items.length);
  assert.equal(page.messages[0].role, "system");
  assert.equal(page.messages[0].content[0].text, "hook one\nhook two");
  for (const index of [1, 2, 3, 4, 5, 6]) {
    assert.equal(page.messages[index].content[0].type, "toolCall");
    assert.equal(page.messages[index].content[1].type, "tool_result");
    assert.equal(page.messages[index].unsupported, undefined);
  }
  assert.equal(page.messages[1].content[0].toolName, "collab/spawnAgent");
  assert.equal(page.messages[3].content[0].toolName, "webSearch");
  assert.match(page.messages[5].content[1].content, /image-result/);
  assert.deepEqual(page.messages.slice(7).map((message) => message.content[0].semanticType), [
    "reviewMode", "reviewMode", "contextCompaction",
  ]);
});

async function main() {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${passed}/${tests.length} tests passed\n`);
}

main();
