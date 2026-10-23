"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { splitActivityArguments, NATIVE_ACTIVITY_INSTRUCTION } = require("../app/agent-service/tool-activity");
const { MCP_PRODUCT_TOOL_DEFINITIONS, validateMcpProductToolArguments } = require("../app/agent-service/mcp-product-tool-controller");
const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { bindingElicitation } = require("../app/agent-service/runtime-mcp-call-binding");
const { shoggothProductDeveloperInstructions } = require("../app/agent-service/product-capability-manifest");

test("every product schema supports bounded optional progress without weakening business validation", () => {
  for (const tool of MCP_PRODUCT_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.properties.activityTitle.maxLength, 120, tool.name);
    assert.ok(!tool.inputSchema.required?.includes("activityTitle"), "old clients remain valid");
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.equal(validateMcpProductToolArguments("web_search", { query: "Oracle limits", activityTitle: "核对 Oracle 免费内存上限" }), true);
  for (const activityTitle of ["", "  ", 1, {}, "x".repeat(121), "step\nnext", "\ud800"]) {
    assert.equal(validateMcpProductToolArguments("web_search", { query: "Oracle limits", activityTitle }), false);
  }
  assert.equal(validateMcpProductToolArguments("web_search", { activityTitle: "Search" }), false);
  assert.equal(validateMcpProductToolArguments("web_search", { query: "x", activityTitle: "Search", extra: true }), false);
  let accessed = false;
  const getter = { query: "x", get activityTitle() { accessed = true; return "Search"; } };
  assert.equal(splitActivityArguments(getter).valid, false); assert.equal(accessed, false);
  const args = Object.freeze({ query: "x", activityTitle: "Search" });
  assert.deepEqual(splitActivityArguments(args).arguments, { query: "x" });
  assert.equal(args.activityTitle, "Search", "do not mutate the Runtime's original call");
  for (const runtime of ["codex", "claude-code", "pi", "grok-build", "opencode", "antigravity", "deepseek-harness"]) {
    assert.ok(shoggothProductDeveloperInstructions({ source: "chat", sourceId: "fixture", profileName: "Fixture", runtime }).includes(NATIVE_ACTIVITY_INSTRUCTION), runtime);
  }
});

test("helper strips labels before dispatch and binding, also covering discovery and result pages when available", async () => {
  const calls = [], proofs = [];
  let largeResult = false;
  const sessionToken = Buffer.alloc(32, 5).toString("base64url");
  const handler = createMcpStdioHandler({ runtimeProfileId: "runtime-a", runtimeAccountId: "account-a",
    sessionToken, toolExposure: "resident", bindRuntimeCalls: true,
    requestService: async (_paths, request) => { calls.push(request.params); return { body: largeResult ? "fixture ".repeat(10000) : "fixture" }; } });
  const context = { requestClient: async (method, params) => {
    assert.equal(method, "elicitation/create"); proofs.push(params); return { action: "accept", content: {} };
  } };
  const call = (name, args) => handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, context);
  try {
    await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { elicitation: {} }, clientInfo: { name: "fixture", version: "1" } } });
    const list = await handler({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.properties.activityTitle.maxLength, 120, tool.name);
    const first = await call("app_help_get", { featureId: "inspiration", activityTitle: "读取灵感功能说明" });
    assert.equal(first.result.isError, false, JSON.stringify(first).slice(0, 200));
    assert.deepEqual(calls[0].arguments, { featureId: "inspiration" });
    const proof = proofs[0]._meta["shoggoth/runtime-call-binding"];
    assert.equal(proof.fingerprint, bindingElicitation({ callId: calls[0].callId, name: "app_help_get",
      arguments: calls[0].arguments, sessionToken })._meta["shoggoth/runtime-call-binding"].fingerprint);
    assert.equal((await call("app_help_get", { featureId: "inspiration", activityTitle: "x".repeat(121) })).error.code, -32602);
    assert.equal(calls.length, 1, "invalid titles never dispatch");
    // The optional resident catalogue and pagination are a separate feature.
    // Exercise their display metadata too when that catalogue is installed.
    if (list.result.tools.some(tool => tool.name === "product_tool_search")) {
      const found = await call("product_tool_search", { query: "app_help_get", activityTitle: "查找产品帮助工具" });
      assert.equal(found.result.isError, false);
      largeResult = true;
      const nested = await call("product_tool_call", { name: "app_help_get", activityTitle: "核对功能说明",
        arguments: { featureId: "inspiration", activityTitle: "读取灵感功能说明" } });
      assert.equal(nested.result.isError, false);
      assert.deepEqual(calls[1].arguments, { featureId: "inspiration" });
      const preview = nested.result.structuredContent;
      assert.equal(preview.truncated, true);
      const page = await call("product_result_read", { resultRef: preview.resultRef, offset: preview.nextOffset, activityTitle: "继续读取功能说明" });
      assert.equal(page.result.isError, false); assert.equal(calls.length, 2);
    }
  } finally { handler.close(); }
});
