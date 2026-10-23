"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { GROUP_MCP_TOOL_DEFINITIONS, validateGroupMcpArguments } = require("../app/agent-service/group-mcp-tools");
const { validateParams, validateResult } = require("../app/agent-service/group-chat-protocol");
const { GroupAdapterChannel } = require("../app/agent-service/group-adapter-channel");
const { createGroupRuntimeMcpHandler } = require("../app/group-runtime-mcp-helper");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { AgentBackend } = require("../app/core/agent-backend");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const token = `gt1.t.11111111-2222-4333-8444-555555555555.${"A".repeat(43)}`;
const byRun = { source: "chat", sourceId: "session-1" };
const plan = { action: "plan", clientActionId: "plan-1", scopeKey: "research", target: "@reader", objective: "Read evidence", stopCondition: "Cite source", dependsOn: [], finalDelivery: false };
const examples = [plan, { action: "get", itemId: "i", revision: 1, offset: 1, digest: "a".repeat(64) },
  { action: "ask", clientActionId: "a", itemId: "i", target: "@r", objective: "Read", stopCondition: "Cite" },
  { action: "review", clientActionId: "r", itemId: "i", target: "@r", objective: "Verify", stopCondition: "Verdict", sourceSeq: 1, resultDigest: "a".repeat(64) },
  { action: "challenge", clientActionId: "c", itemId: "i", target: "@r", objective: "Resolve", stopCondition: "Correct", sourceSeq: 2 },
  { action: "report", clientActionId: "r", itemId: "i", itemIds: ["j", "k"], summary: "Result" },
  { action: "wait", clientActionId: "w", itemId: "i", dependsOn: ["j"], reason: "Need evidence" },
  { action: "pass", clientActionId: "p", reason: "Outside my scope" },
  { action: "finish", clientActionId: "f", summary: "Delivery" },
];
test("legacy actions retain strict adapter schemas without model-facing Registry exposure", () => {
  for (const action of examples) for (const binding of [byRun, { groupToken: token }]) assert.equal(validateGroupMcpArguments("group_collaborate", { ...binding, ...action }), true, action.action);
  assert.equal(DEFAULT_TOOL_REGISTRY.mcpDefinitions().some(tool => tool.name === "group_collaborate"), false);
  assert.equal(DEFAULT_TOOL_REGISTRY.toolsMarkdown().includes("group_collaborate"), false);
  const schemas = Object.fromEntries(GROUP_MCP_TOOL_DEFINITIONS.map(({ name, inputSchema }) => [name, inputSchema]));
  const oc = fs.readFileSync(require.resolve("../resources/external-plugin-adapters/openclaw/index.mjs"), "utf8").split("\n").find(line => line.startsWith("const GROUP_SCHEMAS = "));
  assert.deepEqual(JSON.parse(oc.slice("const GROUP_SCHEMAS = ".length, -1)), schemas);
  const hm = fs.readFileSync(require.resolve("../resources/external-plugin-adapters/hermes/__init__.py"), "utf8").split("\n").find(line => line.startsWith("GROUP_SCHEMAS = json.loads("));
  assert.deepEqual(JSON.parse(JSON.parse(hm.slice("GROUP_SCHEMAS = json.loads(".length, -1))), schemas);
});
test("authority spoofing, action confusion and unsafe values are rejected before binding", () => {
  const good = { ...byRun, ...plan };
  for (const bad of [{ ...good, groupId: "g" }, { ...good, callerMemberId: "m" }, { ...good, coordinatorEpoch: 99 }, { ...good, groupToken: token }, { ...good, source: "inspiration" }, { ...plan }, { ...good, clientActionId: undefined }, { ...good, clientActionId: "../x" }, { ...good, target: "x".repeat(129) }, { ...good, objective: "x".repeat(2001) }, { ...good, stopCondition: " " }, { ...good, summary: "wrong action" }, { ...good, dependsOn: ["i", "i"] }, { ...good, dependsOn: Array.from({ length: 13 }, (_, i) => `i${i}`) }, { ...good, finalDelivery: "true" }, { ...good, scopeKey: "has space" }, { ...good, expectedRevision: 0 }, { ...byRun, action: "get", itemId: "i", offset: 1 }, { ...byRun, action: "get", itemId: "i", clientActionId: "not-a-write" }, { ...byRun, ...examples[3], sourceSeq: undefined }, { ...byRun, ...examples[6], dependsOn: [] }, { ...byRun, ...examples[5], summary: "x".repeat(20001) }, { ...byRun, ...examples[3], resultDigest: "f".repeat(63) }]) assert.equal(validateGroupMcpArguments("group_collaborate", bad), false);
  for (const itemIds of [[], ["j", "j"], Array.from({ length: 13 }, (_, i) => `i${i}`), ["../j"]]) {
    assert.equal(validateGroupMcpArguments("group_collaborate", { ...byRun, ...examples[5], itemIds }), false);
  }
  assert.equal(validateGroupMcpArguments("group_collaborate", { ...byRun, ...plan, itemIds: ["j"] }), false);
  let touched = false; const getter = { ...good }; Object.defineProperty(getter, "action", { get() { touched = true; return "plan"; }, enumerable: true });
  assert.equal(validateGroupMcpArguments("group_collaborate", getter), false); assert.equal(touched, false);
});
test("lookup and send preserve exact service fields and reject replay payloads", () => {
  const q = { groupId: "g", clientMessageId: "s", ownerScope: "owner:abc", payloadDigest: "a".repeat(64) };
  assert.deepEqual(validateParams("group.send.lookup", q), q);
  for (const bad of [{ ...q, body: "never replay" }, { ...q, payloadDigest: "wrong" }, { ...q, ownerScope: "" }]) assert.throws(() => validateParams("group.send.lookup", bad), { code: "GROUP_CHAT_INVALID" });
  const input = { groupId: "g", clientMessageId: "s", body: "Input", mentions: [], replyTo: null, attachments: [], ownerScope: "owner:abc", expectedPolicyVersion: 1 };
  assert.deepEqual(validateParams("group.send", input), input);
  assert.throws(() => validateParams("group.send", { ...input, expectedPolicyVersion: 0 }), { code: "GROUP_CHAT_INVALID" });
});
test("adapter inventory gates new actions, legacy availability, expiration and revocation", async () => {
  let now = 1; const calls = [];
  const channel = new GroupAdapterChannel({ paths: {}, now: () => now, authorize: () => true, service: { callBoundExternalTool(...args) { calls.push(args); return { ok: true }; } } });
  const reg = { backendId: "hermes", credentialToken: "test", agentId: "hermes-default", instanceId: "instance-1" };
  await channel.handle("group.adapter.register", reg);
  assert.deepEqual(channel.capability(reg), { groupTools: true, protocolVersion: 1, collaborationActions: false });
  const call = { backendId: reg.backendId, credentialToken: "test", agentId: reg.agentId, callId: "call-1", name: "group_collaborate", arguments: { groupToken: token, ...plan } };
  await assert.rejects(channel.handle("group.adapter.call", call), { code: "GROUP_HOST_TOOL_UNSUPPORTED" }); assert.equal(calls.length, 0);
  await channel.handle("group.adapter.register", { ...reg, protocolVersion: 2, tools: GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name) });
  assert.equal(channel.capability(reg).collaborationActions, true); await channel.handle("group.adapter.call", call);
  assert.deepEqual(calls[0], ["group_collaborate", call.arguments, "call-1", { backendId: "hermes", agentId: "hermes-default" }]);
  await assert.rejects(channel.handle("group.adapter.register", { ...reg, protocolVersion: 2, tools: ["group_collaborate", "group_collaborate"] }), { code: "GROUP_HOST_REQUEST_INVALID" });
  now += 150001; assert.equal(channel.capability(reg).groupTools, false);
  await assert.rejects(channel.handle("group.adapter.call", call), { code: "GROUP_HOST_TOOL_UNSUPPORTED" });
  await channel.handle("group.adapter.unregister", reg); await assert.rejects(channel.handle("group.adapter.register", reg), { code: "GROUP_HOST_GRANT_REVOKED" });
});
test("MCP helper negotiates tool inventory and forwards bound collaboration", async () => {
  const calls = [], connection = { agentId: "reader", hostId: "host-1" };
  const handler = createGroupRuntimeMcpHandler({ connection, request: async (_, input) => { calls.push(input); return input.register ? { registered: true, hostId: "host-1", protocolVersion: 2, tools: GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name) } : { ok: true }; } });
  await handler.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }); assert.equal(calls[0].protocolVersion, 2);
  const list = await handler.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }); assert.ok(list.result.tools.some(tool => tool.name === "group_collaborate"));
  await handler.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "group_collaborate", arguments: { groupToken: token, ...plan } } });
  assert.equal(calls.at(-1).name, "group_collaborate"); assert.equal(calls.at(-1).agentId, "reader"); assert.match(calls.at(-1).callId, /:3$/u); await handler.close();
});
test("legacy helper fallback only registers; unsupported actions never dispatch", async () => {
  const calls = [], connection = { agentId: "reader", hostId: "host-1" };
  const handler = createGroupRuntimeMcpHandler({ connection, request: async (_, input) => { calls.push(input); if (input.protocolVersion) throw Object.assign(new Error("legacy"), { code: "GROUP_HOST_REQUEST_INVALID" }); return { registered: true, hostId: "host-1" }; } });
  await handler.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }); assert.equal(calls.length, 2);
  const list = await handler.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }); assert.equal(list.result.tools.some(tool => tool.name === "group_collaborate"), false);
  const rejected = await handler.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "group_collaborate", arguments: { groupToken: token, ...plan } } });
  assert.equal(rejected.error.message, "GROUP_HOST_TOOL_UNSUPPORTED"); assert.equal(calls.length, 2); await handler.close();
});
function backendFixture() {
  const backend = new ShoggothBackend({}); const calls = [];
  backend._call = async (method, params) => { calls.push({ method, params }); return method === "service.status" ? { instanceNonce: backend._serviceInstanceNonce ?? "a".repeat(48) } : { status: "not_found", groupId: params.groupId, clientMessageId: params.clientMessageId, ownerScope: "owner:abc", payloadMatches: null, message: null, discussionId: null }; }; return { backend, calls };
}
test("Backend and Registry lookup retains identity and never submits work", async () => {
  const f = backendFixture(), registry = new BackendRegistry(); registry.setInspirationOwner(f.backend);
  const q = { clientMessageId: "s", payloadDigest: "a".repeat(64), ownerScope: "owner:abc" }; assert.equal((await registry.lookupGroupChatSend("g", q)).status, "not_found");
  assert.deepEqual(f.calls, [{ method: "group.send.lookup", params: { groupId: "g", ...q } }]);
  await assert.rejects(new (class extends AgentBackend { get id() { return "unsupported"; } })().lookupGroupChatSend("g", q), { code: "GROUP_CHAT_UNAVAILABLE" });
});
test("lookup rejects mismatched authority, operation and digest replies", () => {
  const params = { groupId: "g", clientMessageId: "s", ownerScope: "owner:abc", payloadDigest: "a".repeat(64) };
  const found = { ...params, status: "found", payloadMatches: true, discussionId: "d", message: { id: "m", groupId: "g", seq: 1, author: { kind: "user" } } };
  assert.deepEqual(validateResult("group.send.lookup", found, params), found);
  for (const bad of [{ ...found, groupId: "other" }, { ...found, clientMessageId: "other" }, { ...found, ownerScope: "owner:other" }, { ...found, payloadDigest: "b".repeat(64) }, { ...found, message: null }, { ...found, status: "unknown" }, { ...found, message: { ...found.message, author: { kind: "member" } } }]) assert.throws(() => validateResult("group.send.lookup", bad, params), { code: "GROUP_CHAT_UNAVAILABLE" });
  assert.equal(validateResult("group.send.lookup", { ...found, status: "unknown", ownerScope: "owner:other", message: null, payloadMatches: null }, params).status, "unknown");
});

test("production GET REST lookup reaches Registry and Backend with frozen query", async () => {
  const { startStaticServer } = require("../app/static-server");
  const root = fs.mkdtempSync("/private/tmp/group-contracts-lookup-rest-"); const f = backendFixture();
  const registry = new BackendRegistry(); registry.setInspirationOwner(f.backend);
  let server;
  try {
    server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: root });
    const query = new URLSearchParams({ id: "g", clientMessageId: "send-1", payloadDigest: "a".repeat(64), ownerScope: "owner:abc" });
    const response = await fetch(`${server.url}/__api/group-chats/messages/lookup?${query}`);
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.status, "not_found");
    assert.deepEqual(f.calls, [{ method: "group.send.lookup", params: { groupId: "g", clientMessageId: "send-1", payloadDigest: "a".repeat(64), ownerScope: "owner:abc" } }]);
    const rejected = await fetch(`${server.url}/__api/group-chats/messages/lookup?id=g&clientMessageId=send-1&payloadDigest=invalid`);
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).code, "GROUP_CHAT_INVALID"); assert.equal(f.calls.length, 1);
  } finally { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("send verification never calls a mutation", async () => {
  const f = backendFixture();
  assert.equal((await f.backend.lookupGroupChatSend("g", { clientMessageId: "s" })).status, "not_found");
  assert.deepEqual(f.calls.map(call => call.method), ["group.send.lookup"]);
});

test("generated capability document remains bounded without trimming actual MCP contracts", () => {
  const { ToolRegistry, MAX_TOOLS_MARKDOWN_BYTES } = require("../app/agent-service/tool-registry");
  const markdown = DEFAULT_TOOL_REGISTRY.toolsMarkdown();
  assert.ok(Buffer.byteLength(markdown) <= MAX_TOOLS_MARKDOWN_BYTES);
  for (const tool of DEFAULT_TOOL_REGISTRY.mcpDefinitions()) assert.ok(markdown.includes(`| \`${tool.name}\` |`));
  const description = "Full policy and exact parameters remain in the MCP definition. " + "详情🙂".repeat(20000);
  const registry = new ToolRegistry({ capabilities: [{ tool: "large", domain: "group", risk: "write", description }],
    definitions: [{ name: "large", description, inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }] });
  const bounded = registry.toolsMarkdown();
  assert.ok(Buffer.byteLength(bounded) <= MAX_TOOLS_MARKDOWN_BYTES); assert.equal(bounded.isWellFormed(), true);
  assert.ok(bounded.includes("Descriptions may be excerpts"));
  assert.equal(registry.mcpDefinitions()[0].description, description);
});

test("full message read GET traverses Registry and Backend without submitting a run", async () => {
  const { startStaticServer } = require("../app/static-server");
  const { resultPage } = require("../app/group-result-content");
  const root = fs.mkdtempSync("/private/tmp/group-read-rest-");
  const f = backendFixture();
  f.backend._call = async (method, params) => { f.calls.push({ method, params }); return { page: resultPage("完整回答正文。") }; };
  const registry = new BackendRegistry(); registry.setInspirationOwner(f.backend);
  let server;
  try {
    server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: root });
    const response = await fetch(`${server.url}/__api/group-chats/messages/read?id=g&seq=3`);
    assert.equal(response.status, 200); assert.equal((await response.json()).page.text, "完整回答正文。");
    assert.deepEqual(f.calls, [{ method: "group.message.read", params: { groupId: "g", seq: 3, offset: 0, digest: null } }]);
  } finally { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
