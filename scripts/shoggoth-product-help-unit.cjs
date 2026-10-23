#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PRODUCT_HELP_CATALOG, searchProductHelp, productHelpRevision } = require("../app/agent-service/product-help-catalog");
const { ProductHelpService } = require("../app/agent-service/product-help-service");
const { DEFAULT_TOOL_REGISTRY, isNativeOnlyMcpTool, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");

function fixture(overrides = {}) {
  const permissions = new PermissionEngine({ toolRegistry: DEFAULT_TOOL_REGISTRY });
  let statuses = [{ id: "shoggoth", connected: true, disabled: false },
    { id: "hermes", connected: false, disabled: false }];
  let context = { runtime: "pi", source: "chat", sourceId: "current-chat", userConversation: true,
    capabilities: { "turn.steer": false, "context.compact.native": false } };
  const service = new ProductHelpService({ toolRegistry: DEFAULT_TOOL_REGISTRY, permissionEngine: permissions,
    isNativeOnlyTool: isNativeOnlyMcpTool, toolAvailable: () => true,
    getBackendStatuses: async () => statuses,
    getRuntimeContext: () => context, now: () => 1234, ...overrides });
  return { service, permissions, authority: { profileId: "profile-1" },
    setStatuses(value) { statuses = value; }, setContext(value) { context = value; } };
}
function action(result, id) { return result.actions.find(item => item.id === id); }

test("目录的操作引用真实工具，搜索覆盖中英文别名、自然问法和空目录入口", () => {
  assert.match(productHelpRevision, /^[a-f0-9]{64}$/u);
  for (const feature of PRODUCT_HELP_CATALOG) {
    assert.ok(feature.content["zh-CN"].summary && feature.content.en.summary);
    for (const item of feature.actions) for (const tool of [item.tool, item.externalTool].filter(Boolean)) {
      assert.ok(DEFAULT_TOOL_REGISTRY.get(tool), `${feature.id}: ${tool}`);
    }
  }
  for (const [query, id] of [["灵感是什么", "inspiration"], ["定时执行", "cron"],
    ["scheduled tasks", "cron"], ["Kanban", "kanban"], ["API Key", "models"], ["长期记忆", "memory"],
    ["你能做什么？", "overview"], ["你现在能帮我操作什么？", "overview"]]) {
    assert.equal(searchProductHelp({ query, limit: 20 }).items[0].featureId, id, query);
  }
  assert.equal(searchProductHelp({ query: "" }).items.length, PRODUCT_HELP_CATALOG.length);
  assert.equal(searchProductHelp({ query: "missing-feature" }).items.length, 0);
  const bounded = searchProductHelp({ query: "", limit: 2 });
  assert.equal(bounded.items.length, 2); assert.equal(bounded.truncated, true);
  assert.match(searchProductHelp({ query: "Cron", locale: "en" }).items[0].title, /Scheduled/);
});

test("SparkNotes 正式名称、中英文简称、大小写和常用变体命中同一功能", () => {
  const queries = ["便签", "灵感", "灵感便签", "SparkNotes", "Spark Notes", "sparknotes",
    "Notes", "notes", "NOTE", "Sticky note", "sticky notes", "sticky-note",
    "Memo note", "memo notes", "Memo", "memos", "mEmO", "Ｎｏｔｅｓ",
    "灵感便签怎么使用？", "What are Notes?", "What is a Sticky note?", "How do Memo notes work?",
    "这个Memo是什么？", "Inspiration", "ideas"];
  for (const locale of ["zh-CN", "en"]) for (const query of queries) {
    const result = searchProductHelp({ query, locale });
    assert.deepEqual(result.items.map(item => item.featureId), ["inspiration"], `${locale}: ${query}`);
    assert.equal(result.items[0].title, locale === "en" ? "SparkNotes" : "灵感便签");
  }
});

test("英文别名按完整词匹配，Memo 不与 Memory 或其他词内片段混淆", () => {
  for (const query of ["Memory", "memory", "What is Memory?", "What do you remember?"]) {
    const result = searchProductHelp({ query });
    assert.equal(result.items[0].featureId, "memory", query);
    assert.equal(result.items.some(item => item.featureId === "inspiration"), false, query);
  }
  for (const query of ["memoization", "commemorate", "noteworthy", "notebooks"]) {
    assert.equal(searchProductHelp({ query }).items.some(item => item.featureId === "inspiration"), false, query);
  }
  for (const query of ["gent", "hog"]) {
    assert.deepEqual(searchProductHelp({ query }).items, [], "mixed-language titles must also preserve English word boundaries");
  }
});

test("帮助工具严格拒绝伪造身份、额外字段、超限搜索和非法语言", () => {
  assert.equal(validateMcpProductToolArguments("app_help_search", { query: "", limit: 20, locale: "en" }), true);
  assert.equal(validateMcpProductToolArguments("app_help_get", { featureId: "cron", backendId: "hermes" }), true);
  for (const args of [{ query: "x", profileId: "other" }, { query: "x", limit: 21 },
    { query: "x".repeat(513) }, { query: "x", locale: "unknown" }, { query: "\u0000" }]) {
    assert.equal(validateMcpProductToolArguments("app_help_search", args), false);
  }
  assert.equal(validateMcpProductToolArguments("app_help_get", { featureId: "cron", runId: "forged" }), false);
});

test("权限禁用不隐藏功能说明，确认级操作和 UI-only 边界由真实清单决定", async () => {
  const f = fixture();
  f.permissions.setProfileOverride("profile-1", "cron_create", "deny");
  const result = await f.service.get({ featureId: "cron" }, f.authority);
  assert.match(result.summary, /定时/);
  assert.equal(action(result, "create").availability, "unavailable");
  assert.equal(action(result, "create").reason.code, "TOOL_FORBIDDEN");
  assert.equal(action(result, "delete").availability, "requires_confirmation");
  assert.equal(result.permissionRevision, f.permissions.revision);
  const models = await f.service.get({ featureId: "models" }, f.authority);
  assert.equal(action(models, "credentials").availability, "ui_only");
  assert.equal(action(models, "credentials").tool, null);
  assert.equal(result.sampledAt, 1234);
});

test("外部身份读取同一说明，但不能继承原生记忆、设定或跨 Profile 管理", async () => {
  const f = fixture();
  const external = { ...f.authority, federationClient: "hermes" };
  const memory = await f.service.get({ featureId: "memory" }, external);
  assert.match(memory.summary, /记忆/);
  assert.equal(action(memory, "search").availability, "unavailable");
  assert.equal(action(memory, "search").reason.code, "NATIVE_ONLY");
  const cron = await f.service.get({ featureId: "cron", backendId: "hermes" }, external);
  assert.equal(action(cron, "create").reason.code, "NATIVE_ONLY");
  assert.equal(cron.runtime, null, "外部身份不冒用绑定原生 Profile 的 Runtime");
});

test("外部后端离线或状态未知时准确降级，本地定时任务不依赖 App Host", async () => {
  const f = fixture();
  const offline = await f.service.get({ featureId: "cron", backendId: "hermes" }, f.authority);
  assert.equal(action(offline, "create").tool, "app_manage");
  assert.equal(action(offline, "create").reason.code, "BACKEND_DISCONNECTED");
  f.setStatuses(null);
  const unknown = await f.service.get({ featureId: "cron", backendId: "hermes" }, f.authority);
  assert.equal(action(unknown, "create").availability, "unknown");
  const native = await f.service.get({ featureId: "cron" }, f.authority);
  assert.equal(action(native, "create").availability, "available");
  f.setStatuses([{ id: "hermes", connected: true, disabled: false }]);
  assert.equal(action(await f.service.get({ featureId: "cron", backendId: "hermes" }, f.authority), "create").availability,
    "requires_confirmation");
  f.permissions.setProfileOverride("profile-1", "cron_create", "deny");
  assert.equal(action(await f.service.get({ featureId: "cron", backendId: "hermes" }, f.authority), "create").reason.code,
    "TOOL_FORBIDDEN", "app_manage 同时保留具体操作的权限");
});

test("当前执行身份提供 Runtime 能力，后台任务不能声称拥有当前用户记忆权限", async () => {
  const f = fixture();
  const chat = await f.service.get({ featureId: "chat" }, f.authority);
  assert.equal(chat.runtime, "pi"); assert.equal(chat.runtimeCapabilities["turn.steer"], false);
  assert.equal(action(chat, "steer").reason.code, "RUNTIME_UNSUPPORTED");
  assert.equal(action(chat, "compact").reason.code, "RUNTIME_UNSUPPORTED");
  f.setContext({ runtime: "codex", source: "chat", userConversation: true,
    capabilities: { "context.compact.native": true } });
  assert.equal(action(await f.service.get({ featureId: "chat" }, f.authority), "compact").availability, "ui_only");
  f.setContext({ runtime: "codex", source: "cron", userConversation: false, capabilities: {} });
  const memory = await f.service.get({ featureId: "memory" }, f.authority);
  assert.equal(action(memory, "save").reason.code, "USER_CONVERSATION_REQUIRED");
  f.setContext(null);
  assert.equal(action(await f.service.get({ featureId: "memory" }, f.authority), "search").availability, "unknown");
});

test("Registry 撤销工具后帮助说明仍可读，操作立即不可用", async () => {
  const f = fixture({ toolRegistry: { revision: "current-tools", get: name => name === "cron_create"
    ? null : DEFAULT_TOOL_REGISTRY.get(name) } });
  const result = await f.service.get({ featureId: "cron" }, f.authority);
  assert.equal(action(result, "create").reason.code, "TOOL_UNAVAILABLE");
  assert.equal(result.toolRegistryRevision, "current-tools");
  assert.match(result.guide, /时区/);
});

test("原生服务域不可用或查询失败时保留说明和准确原因", async () => {
  const down = fixture({ getServiceStatus: async () => ({ domainAvailability: { cron: { available: false } } }) });
  assert.equal(action(await down.service.get({ featureId: "cron" }, down.authority), "create").reason.code, "TOOL_UNAVAILABLE");
  const unknown = fixture({ getServiceStatus: async () => { throw new Error("private-secret-canary"); } });
  const result = await unknown.service.get({ featureId: "cron" }, unknown.authority);
  assert.equal(action(result, "create").availability, "unknown");
  assert.equal(JSON.stringify(result).includes("private-secret-canary"), false);
});

test("查询等待期间撤权、依赖缺失和后台来源失败不会被解释为可操作", async () => {
  let resolve;
  const f = fixture({ getBackendStatuses: () => new Promise(done => { resolve = done; }) });
  const pending = f.service.get({ featureId: "cron", backendId: "hermes" }, f.authority);
  await Promise.resolve();
  f.permissions.setProfileOverride("profile-1", "cron_create", "deny");
  resolve([{ id: "hermes", connected: true, disabled: false }]);
  assert.equal(action(await pending, "create").reason.code, "TOOL_FORBIDDEN");
  const missing = fixture({ toolAvailable: name => name !== "inspiration_create" });
  assert.equal(action(await missing.service.get({ featureId: "inspiration" }, missing.authority), "create").reason.code,
    "TOOL_UNAVAILABLE");
  await assert.rejects(() => missing.service.get({ featureId: "invented" }, missing.authority),
    error => error.code === "MCP_TOOL_NOT_FOUND");
});
