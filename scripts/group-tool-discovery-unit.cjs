"use strict";
// Actual helper tools/list/call and pure validation. No Service, Runtime or model starts.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { GROUP_MCP_TOOL_DEFINITIONS, GROUP_TOOL_DESCRIPTIONS, GROUP_ACTION_REQUIRED,
  validateGroupMcpArguments, explainGroupMcpArguments } = require("../app/agent-service/group-mcp-tools");
const { DEFAULT_TOOL_REGISTRY, explainMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS, SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS,
  publicProductCapabilities } = require("../app/agent-service/product-capability-manifest");
const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { createGroupRuntimeMcpHandler } = require("../app/group-runtime-mcp-helper");
const byRun = { source: "chat", sourceId: "owned-synthetic-session" }, byGrant = { groupToken: `gt1.t.11111111-2222-4333-8444-555555555555.${"A".repeat(43)}` };
const ref = { itemId: "item", revision: 1, messageId: "message", seq: 1, digest: "a".repeat(64) };
const finish = { action: "finish", clientActionId: "fixed-finish", resultRefs: [ref] };
const retiredTools = new Set(["group_task", "group_collaborate"]);
test("canonical descriptions, action tables and frozen external schemas remain identical", () => {
  const schemas = Object.fromEntries(GROUP_MCP_TOOL_DEFINITIONS.map(({ name, inputSchema }) => [name, inputSchema]));
  for (const [relative, prefixes] of [["../resources/external-plugin-adapters/openclaw/index.mjs", ["const GROUP_SCHEMAS = ", "const GROUP_DESCRIPTIONS = ", "const GROUP_ACTION_REQUIRED = "]],
    ["../resources/external-plugin-adapters/hermes/__init__.py", ["GROUP_SCHEMAS = json.loads(", "GROUP_DESCRIPTIONS = json.loads(", "GROUP_ACTION_REQUIRED = json.loads("]]]) {
    const lines = fs.readFileSync(require.resolve(relative), "utf8").split("\n");
    for (let index = 0; index < prefixes.length; index++) {
      const raw = lines.find(line => line.startsWith(prefixes[index])).slice(prefixes[index].length, -1);
      const value = relative.endsWith(".py") ? JSON.parse(JSON.parse(raw)) : JSON.parse(raw);
      assert.deepEqual(value, [schemas, GROUP_TOOL_DESCRIPTIONS, GROUP_ACTION_REQUIRED][index]);
    }
  }
  for (const tool of GROUP_MCP_TOOL_DEFINITIONS) {
    assert.equal(tool.description, GROUP_TOOL_DESCRIPTIONS[tool.name]);
    const visible = DEFAULT_TOOL_REGISTRY.mcpDefinitions().find(entry => entry.name === tool.name);
    if (retiredTools.has(tool.name)) assert.equal(visible, undefined);
    else assert.equal(visible.description, tool.description);
  }
});
test("retired group tools are absent from all model-facing product surfaces", () => {
  for (const name of retiredTools) {
    assert.equal(DEFAULT_TOOL_REGISTRY.get(name).modelVisible, false, "legacy dispatch schema remains internal");
    assert.equal(DEFAULT_TOOL_REGISTRY.publicProjection().capabilities.some(tool => tool.tool === name), false);
    assert.equal(publicProductCapabilities().capabilities.some(tool => tool.tool === name), false);
    for (const text of [DEFAULT_TOOL_REGISTRY.toolsMarkdown(), DEFAULT_TOOL_REGISTRY.developerSummary(),
      SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS, SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS]) {
      assert.equal(text.includes(name), false, name);
    }
  }
  for (const name of ["group_member_role_read", "group_messages_read"]) {
    assert.doesNotMatch(GROUP_TOOL_DESCRIPTIONS[name], /group task|turn_brief|groupToken/u);
  }
});
test("task action missing fields have safe diagnostics under both identity forms", () => {
  const values = { target: "@peer", objective: "owned objective", taskId: "owned-task", reason: "owned reason", note: "owned note", summary: "owned summary",
    verdict: "passed", dependsOn: [], expectedTaskVersion: 1, expectedRecordRevision: 1, userMessageSeq: 1, decision: "clarification" };
  for (const [action, keys] of Object.entries(GROUP_ACTION_REQUIRED.group_task)) for (const binding of [byRun, byGrant]) {
    const valid = { ...binding, action, ...Object.fromEntries(keys.map(key => [key, values[key]])) };
    assert.equal(validateGroupMcpArguments("group_task", valid), true, action);
    for (const key of keys) {
      const missing = { ...valid }; delete missing[key];
      assert.equal(validateGroupMcpArguments("group_task", missing), false);
      assert.ok(explainGroupMcpArguments("group_task", missing).problems.includes(`缺少 ${key}`), `${action}/${key}`);
      assert.deepEqual(explainMcpProductToolArguments("group_task", missing), explainGroupMcpArguments("group_task", missing));
    }
  }
});
test("finish retains summary and admits only one fixed result form with bounded exact references", () => {
  for (const binding of [byRun, byGrant]) {
    assert.equal(validateGroupMcpArguments("group_collaborate", { ...binding, action: "finish", clientActionId: "old", summary: "legacy result", itemId: "scope" }), true);
    assert.equal(validateGroupMcpArguments("group_collaborate", { ...binding, ...finish }), true);
    assert.equal(validateGroupMcpArguments("group_collaborate", { ...binding, ...finish, resultRefs: Array.from({ length: 64 }, (_, index) => ({ ...ref, itemId: `item-${index}` })) }), true);
    const cases = [{ ...finish, summary: "also" }, { action: "finish", clientActionId: "missing" }, { ...finish, itemId: "ambiguous" }, { ...finish, sourceSeq: 1 }, { ...finish, resultDigest: "a".repeat(64) },
      { ...finish, resultRefs: [] }, { ...finish, resultRefs: Array.from({ length: 65 }, (_, index) => ({ ...ref, itemId: `i-${index}` })) },
      { ...finish, resultRefs: [ref, { ...ref, revision: 2 }] }, { ...finish, resultRefs: [{ ...ref, extra: "PRIVATE_VALUE" }] },
      ...["itemId", "revision", "messageId", "seq", "digest"].map(key => ({ ...finish, resultRefs: [{ ...ref, [key]: key === "revision" || key === "seq" ? true : "" }] })),
      { ...finish, action: "report", itemId: "item", summary: "invalid added refs" }];
    for (const invalid of cases) {
      assert.equal(validateGroupMcpArguments("group_collaborate", { ...binding, ...invalid }), false, JSON.stringify(invalid));
      assert.ok(explainGroupMcpArguments("group_collaborate", { ...binding, ...invalid }).problems.length);
    }
  }
});
test("nested references reject getters, prototypes, sparse arrays and extra keys without reading values", () => {
  let touched = 0;
  const getter = { ...ref }; Object.defineProperty(getter, "digest", { enumerable: true, get() { touched++; return "a".repeat(64); } });
  const nestedArray = [ref]; Object.defineProperty(nestedArray, "0", { enumerable: true, get() { touched++; return ref; } });
  const hidden = { ...ref }; Object.defineProperty(hidden, "digest", { value: ref.digest, enumerable: false });
  const action = { toString() { touched++; return "finish"; } };
  const privateKey = "PRIVATE_FIELD_NAME", privateValue = "PRIVATE_VALUE", extra = { ...ref, [privateKey]: privateValue };
  for (const resultRefs of [[getter], nestedArray, [hidden], [Object.assign(Object.create({ inherited: true }), ref)], [Object.assign(Object.create(null), ref)], Array(1), Object.assign([ref], { extra: true }), [extra]]) {
    const input = { ...byRun, ...finish, resultRefs };
    assert.equal(validateGroupMcpArguments("group_collaborate", input), false);
    const diagnosis = JSON.stringify(explainGroupMcpArguments("group_collaborate", input));
    assert.ok(!diagnosis.includes(privateKey) && !diagnosis.includes(privateValue));
  }
  assert.equal(validateGroupMcpArguments("group_collaborate", { ...byRun, ...finish, action }), false);
  explainGroupMcpArguments("group_collaborate", { ...byRun, ...finish, action });
  assert.equal(touched, 0);
  const large = { ...byRun, action: "propose", target: "@peer", objective: "owned", summary: "s".repeat(20000), inputs: Array(10).fill("i".repeat(2000)), deliverables: Array(10).fill("d".repeat(2000)) };
  assert.equal(validateGroupMcpArguments("group_task", large), false, "48KiB aggregate bound retained");
});
test("native actual tools/list exposes room reads and refuses retired tools before Service", async () => {
  const calls = [], handler = createMcpStdioHandler({ runtimeProfileId: "owned-runtime", runtimeAccountId: "owned-runtime-account", sessionToken: Buffer.alloc(32, 1).toString("base64url"),
    requestService: async (_paths, request) => { calls.push(request); return { ok: true, task: { id: "owned-task" } }; } });
  try {
    await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "owned-fixture", version: "1" } } });
    const tools = []; let cursor;
    do {
      const catalog = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
      tools.push(...catalog.result.tools); cursor = catalog.result.nextCursor;
    } while (cursor);
    for (const tool of GROUP_MCP_TOOL_DEFINITIONS) {
      const visible = tools.find(entry => entry.name === tool.name);
      if (retiredTools.has(tool.name)) assert.equal(visible, undefined);
      else assert.equal(visible.description, tool.description);
    }
    for (const [name, args] of [["group_task", { ...byRun, action: "get", taskId: "owned-task" }],
      ["group_collaborate", { ...byRun, action: "pass", clientActionId: "pass-1", reason: "no reply" }]]) {
      const refused = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
      assert.equal(refused.error.code, -32602); assert.equal(calls.length, 0);
    }
    const invalid = await handler({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "group_member_role_read", arguments: byRun } });
    assert.equal(invalid.result.isError, true); assert.equal(calls.length, 0);
    const corrected = await handler({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "group_member_role_read", arguments: { ...byRun, member: "@peer" } } });
    assert.equal(corrected.result.isError, false); assert.equal(calls.length, 1); assert.equal(calls[0].params.arguments.member, "@peer");
  } finally { handler.close(); }
});
test("runtime actual tools/list and recoverable invalid result retain exact corrected call", async () => {
  const calls = [], handler = createGroupRuntimeMcpHandler({ connection: { agentId: "owned", hostId: "host" }, request: async (_connection, request) => {
    calls.push(request); return request.register ? { hostId: "host", registered: true, protocolVersion: 2, tools: GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name) } : { ok: true }; } });
  try {
    await handler.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const catalog = await handler.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    for (const tool of GROUP_MCP_TOOL_DEFINITIONS) assert.equal(catalog.result.tools.find(entry => entry.name === tool.name).description, tool.description);
    const invalid = await handler.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "group_task", arguments: { ...byGrant, action: "get" } } });
    assert.equal(invalid.result.isError, true); assert.ok(invalid.result.structuredContent.error.problems.includes("缺少 taskId")); assert.equal(calls.length, 1, "only registration, no tool dispatch");
    const corrected = { ...byGrant, action: "get", taskId: "owned-task" };
    await handler.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "group_task", arguments: corrected } });
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].arguments, corrected);
    const badFinish = await handler.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "group_collaborate", arguments: { ...byGrant, ...finish, summary: "both" } } });
    assert.equal(badFinish.result.isError, true); assert.match(badFinish.result.content[0].text, /summary.*resultRefs/u); assert.equal(calls.length, 2);
  } finally { await handler.close(); }
});
