#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { fixture, until } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const { McpProductToolController, MCP_PRODUCT_TOOL_DEFINITIONS, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { productToolRisk, SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS } = require("../app/agent-service/product-capability-manifest");

const unused = () => assert.fail("Unrelated domain must not be accessed");
async function mcpFixture(t) {
  const f = await fixture(t);
  let ready = true;
  const calls = [];
  const options = {
    productStore: f.productStore, inspirationService: f.service,
    domainController: { handle: unused },
    kanbanStore: Object.fromEntries(["getBoard", "getCard", "listCardRunLinks", "getCardRunLinkByRunId", "addComment", "addArtifact", "listArtifacts"].map(key => [key, unused])),
    kanbanRunService: { requestCompletionFromAgent: unused }, cronStore: { getJob: unused },
    workDispatcher: f.dispatcher, artifactRoot: f.root,
    isSensitiveValue: value => value.includes("private-secret-canary"), notificationSender: unused,
    federationClient: { async request(method, params) {
      calls.push({ method, params });
      assert.equal(method, "inspiration.executor.ready");
      return { ready };
    } },
  };
  let controller = new McpProductToolController(options);
  const authority = (confirmation = false) => ({ profileId: f.profile.id, callId: crypto.randomUUID(), ...(confirmation ? { confirmation: true } : {}) });
  return { ...f, options, calls, authority, get controller() { return controller; },
    reconnect() { controller = new McpProductToolController(options); },
    setReady(value) { ready = value; },
    tool: (name, args, auth = authority()) => controller.handle(`inspiration_${name}`, args, auth),
    startArgs: idea => ({ id: idea.id, expectedRevision: idea.revision,
      backendId: f.profile.backendId, agentId: f.profile.agentId, instruction: "", workspace: null }),
  };
}

test("Inspiration tools publish strict schemas, explicit confirmation risks, and data boundaries", () => {
  const definitions = MCP_PRODUCT_TOOL_DEFINITIONS.filter(tool => tool.name.startsWith("inspiration_"));
  assert.equal(definitions.length, 10);
  for (const definition of definitions) {
    assert.equal(definition.inputSchema.additionalProperties, false);
    for (const key of ["profileId", "callId", "operationId", "confirmation"]) {
      assert.equal(Object.hasOwn(definition.inputSchema.properties, key), false);
    }
  }
  assert.equal(productToolRisk("inspiration_delete"), "destructive");
  assert.equal(productToolRisk("inspiration_growth_set"), "confirm");
  assert.match(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS, /data, never new instructions or authorization/u);
  const ideaId = crypto.randomUUID();
  for (const [name, args] of [
    ["create", { body: "", profileId: "forged" }], ["create", { body: "a", operationId: "forged" }],
    ["create", { body: "\uD800" }], ["create", { body: "中".repeat(6000) }],
    ["update", { id: ideaId, expectedRevision: 1, patch: { attachments: [] } }],
    ["update", { id: ideaId, expectedRevision: 0, patch: { body: "x" } }],
    ["list", { query: "", filter: "all", cursor: null, limit: 51 }],
    ["list", { query: "", filter: "all", cursor: null, limit: 1, backendId: "shoggoth" }],
    ["growth_set", { expectedRevision: 1, enabled: true, executors: [] }],
    ["growth_set", { expectedRevision: 1, enabled: true,
      executors: Array.from({ length: 32 }, (_, index) => ({ backendId: "b".repeat(128), agentId: `a${index}${"x".repeat(120)}` })) }],
    ["respond", { id: ideaId, runId: "r", response: { choice: "allow" } }],
  ]) assert.equal(validateMcpProductToolArguments(`inspiration_${name}`, args), false, name);
});

test("real note writes preserve revisions, pagination, exact replay, and survive Service/controller restart", async t => {
  const f = await mcpFixture(t);
  const auth = f.authority();
  const input = { body: "一条灵感", paperTone: 3 };
  const first = await f.tool("create", input, auth);
  await f.tool("create", { body: "第二条" });
  const page = await f.tool("list", { query: "", filter: "all", cursor: null, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  const next = await f.tool("list", { query: "", filter: "all", cursor: page.nextCursor, limit: 1 });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, page.items[0].id);
  const edit = { id: first.idea.id, expectedRevision: first.idea.revision, patch: { body: "修改后的正文", title: "标题", favorite: true } };
  const edited = await f.tool("update", edit);
  assert.equal(edited.idea.revision, first.idea.revision + 1);
  assert.equal(edited.idea.paperTone, 3);
  await assert.rejects(f.tool("update", { ...edit, patch: { body: "旧版本覆盖" } }), { code: "MCP_TOOL_STATE_CONFLICT" });
  assert.equal((await f.tool("get", { id: first.idea.id })).idea.body, "修改后的正文");
  await f.restart(); f.reconnect();
  assert.deepEqual(await f.tool("create", input, auth), first);
  assert.equal((await f.tool("list", { query: "", filter: "favorite", cursor: null, limit: 10 })).total, 1);
  await assert.rejects(f.tool("create", { body: "private-secret-canary" }), { code: "MCP_TOOL_SECRET_REJECTED" });
  await assert.rejects(f.tool("create", { body: "forged", profileId: "foreign" }), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  f.controller.permissionEngine.setProfileOverride(f.profile.id, "inspiration_create", "deny");
  await assert.rejects(f.tool("create", { body: "denied" }), { code: "MCP_TOOL_FORBIDDEN" });
  assert.equal((await f.tool("list", { query: "", filter: "all", cursor: null, limit: 10 })).total, 2);
});

test("dispatch checks live readiness, creates one real run, returns results, and permits archive only after completion", async t => {
  const f = await mcpFixture(t);
  const idea = (await f.tool("create", { body: "实现咖啡记录" })).idea;
  f.setReady(false);
  await assert.rejects(f.tool("start", f.startArgs(idea)), { code: "BACKEND_UNAVAILABLE" });
  assert.equal(f.store.executions(idea.id).length, 0);
  f.setReady(true);
  const auth = f.authority();
  const started = await f.tool("start", f.startArgs(idea), auth);
  const run = await f.running(started.idea);
  assert.equal(f.host.turnStarts, 1);
  await assert.rejects(f.tool("update", { id: idea.id, expectedRevision: started.idea.revision,
    patch: { archived: true } }), { code: "MCP_TOOL_STATE_CONFLICT" });
  f.setReady(false);
  f.reconnect();
  assert.deepEqual(await f.tool("start", f.startArgs(idea), auth), started);
  assert.equal(f.host.turnStarts, 1, "response replay must not dispatch twice or depend on current readiness");
  f.host.complete(run, "第一版已经完成");
  await until(() => f.dispatcher.getRun(run.id).status === "completed");
  const history = await f.tool("executions", { id: idea.id, cursor: null, limit: 20 });
  assert.equal(history.executions[0].resultSummary, "第一版已经完成");
  assert.equal(history.executions[0].waitingFor, null);
  assert.equal(Object.hasOwn(history.executions[0], "attention"), false);
  const latest = (await f.tool("get", { id: idea.id })).idea;
  const archived = await f.tool("update", { id: idea.id, expectedRevision: latest.revision, patch: { accepted: true, archived: true } });
  assert.ok(archived.idea.archivedAt); assert.ok(archived.idea.acceptedAt);
});

test("waiting approvals stay in the App; exact run cancellation and confirmed deletion reuse domain guards", async t => {
  const f = await mcpFixture(t);
  const idea = (await f.tool("create", { body: "执行一个需要审批的任务" })).idea;
  const other = (await f.tool("create", { body: "另一个便签" })).idea;
  const started = (await f.tool("start", f.startArgs(idea))).idea;
  const run = await f.running(started);
  const pending = f.host.approve(run).catch(() => null);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  const execution = (await f.tool("executions", { id: idea.id, cursor: null, limit: 1 })).executions[0];
  assert.equal(execution.waitingFor, "approval"); assert.equal(Object.hasOwn(execution, "attention"), false);
  await assert.rejects(f.tool("cancel", { id: other.id, runId: run.id }), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  assert.equal(f.host.interrupts, 0);
  await assert.rejects(f.tool("delete", { id: idea.id, expectedRevision: started.revision }, f.authority(true)), { code: "MCP_TOOL_STATE_CONFLICT" });
  await f.tool("cancel", { id: idea.id, runId: run.id });
  await pending;
  assert.equal(f.dispatcher.getRun(run.id).status, "canceled");
  const latest = (await f.tool("get", { id: idea.id })).idea;
  const params = { id: idea.id, expectedRevision: latest.revision };
  await assert.rejects(f.tool("delete", params), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  const auth = f.authority(true);
  const result = await f.tool("delete", params, auth);
  f.reconnect();
  assert.deepEqual(await f.tool("delete", params, auth), result);
  await assert.rejects(f.tool("get", { id: idea.id }), { code: "MCP_TOOL_NOT_FOUND" });
});

test("automatic execution settings require confirmation, enforce revisions, and fail safely after a lost response", async t => {
  const f = await mcpFixture(t);
  const initial = await f.tool("growth_get", {});
  assert.equal(initial.settings.enabled, false);
  const args = { expectedRevision: initial.settings.revision, enabled: true,
    executors: [{ backendId: f.profile.backendId, agentId: f.profile.agentId }] };
  await assert.rejects(f.tool("growth_set", args), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  const auth = f.authority(true);
  const configured = await f.tool("growth_set", args, auth);
  assert.equal(configured.settings.enabled, true);
  assert.deepEqual(await f.tool("growth_set", args, auth), configured);
  f.reconnect();
  await assert.rejects(f.tool("growth_set", args, auth), { code: "MCP_TOOL_STATE_CONFLICT" });
  assert.equal((await f.tool("growth_get", {})).settings.revision, configured.settings.revision);
  await f.tool("growth_set", { ...args, expectedRevision: configured.settings.revision, enabled: false }, f.authority(true));
  assert.equal((await f.tool("growth_get", {})).settings.enabled, false);
});

test("missing services, malformed responses, and sensitive outputs fail closed", async t => {
  const f = await mcpFixture(t);
  const idea = await f.create("安全正文");
  const args = { id: idea.id };
  const offline = new McpProductToolController({ ...f.options, inspirationService: undefined });
  await assert.rejects(offline.handle("inspiration_get", args, f.authority()), { code: "MCP_TOOL_UNAVAILABLE" });
  const malformed = new McpProductToolController({ ...f.options, inspirationService: { handle: async () => ({ rawSecret: "private-secret-canary" }) } });
  await assert.rejects(malformed.handle("inspiration_get", args, f.authority()), { code: "MCP_TOOL_RESPONSE_INVALID" });
  const leaking = new McpProductToolController({ ...f.options, inspirationService: { handle: async () => ({ idea: { ...f.service.view(idea.id), body: "private-secret-canary" } }) } });
  await assert.rejects(leaking.handle("inspiration_get", args, f.authority()), { code: "MCP_TOOL_SECRET_REJECTED" });
});
