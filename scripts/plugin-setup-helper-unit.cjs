#!/usr/bin/env node
"use strict";

// The MCP helper builds plugin_install / plugin_activate confirmations from the
// Service's own preflight (never model text), and keeps plugin_secret_request
// open for the whole user-input window. Before this, plugin_install had no
// confirmation entry and every Agent install failed MCP_TOOL_CONFIRMATION_REQUIRED.
const assert = require("node:assert/strict");
const { createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { DEFAULT_SERVER_REQUEST_TIMEOUT_MS } = require("../app/agent-service/interactive-timeouts");

const token = byte => Buffer.alloc(32, byte).toString("base64url");
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "fixture", version: "1.0.0" } } };
const draftId = "a".repeat(64);
const previewDigest = "b".repeat(64);
const releaseDigest = "c".repeat(64);

async function run(name, args, responses, answer = "确认执行") {
  const calls = [];
  const asked = [];
  const handler = createMcpStdioHandler({ runtimeProfileId: "runtime-a", runtimeAccountId: "runtime-a-account",
    sessionToken: token(0x21),
    requestService: async (_paths, request, options) => {
      calls.push({ name: request.params.name, confirmation: request.params.confirmation === true,
        timeoutMs: options.timeoutMs, arguments: request.params.arguments });
      return responses[request.params.name];
    } });
  try {
    await handler(initialize);
    const context = { requestClient: async (method, params) => {
      assert.equal(method, "elicitation/create");
      asked.push(params);
      return { action: "accept", content: { confirm_product_action: answer } };
    } };
    const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, context);
    return { calls, asked, result: result.result };
  } finally { handler.close(); }
}

(async () => {
  const draft = { draftId, format: "codex-plugin", sourcePath: "/tmp/draft", name: "luckin-coffee-mcp", declaredVersion: "0.3.0",
    installable: true, previewDigest, expectedRevision: 0, diagnostics: [],
    previewComponents: { skills: [{ name: "luckin-coffee" }], mcpServers: [{ name: "my-coffee", type: "streamable-http" }] },
    installation: null, components: [], uiTarget: { href: "#/plugins" }, nextSteps: ["confirm_install"] };
  const install = await run("plugin_install", { draftId, previewDigest, expectedRevision: 0, enable: true },
    { plugin_status: draft, plugin_install: { ...draft, nextSteps: ["activate"] } });
  assert.deepEqual(install.calls.map(call => [call.name, call.confirmation]),
    [["plugin_status", false], ["plugin_install", true]]);
  assert.equal(install.asked.length, 1);
  assert.match(install.asked[0].message, /安装插件 "luckin-coffee-mcp"（版本 0\.3\.0）：1 个技能（"luckin-coffee"）、1 个 MCP 服务（"my-coffee"）/u);
  assert.match(install.asked[0].message, /立即为所有助理启用其技能/u);
  assert.equal(install.result.isError, false, JSON.stringify(install.result));

  // Recreating an installed plugin is an update: the question names both
  // versions and says the enabled old version is drained first.
  const update = await run("plugin_install", { draftId, previewDigest, expectedRevision: 3, enable: true },
    { plugin_status: { ...draft, expectedRevision: 3, installation: { installationId: "inst-1", releaseDigest,
      declaredVersion: "0.2.0", desiredState: "enabled", revision: 3 } }, plugin_install: draft });
  assert.match(update.asked[0].message, /将把插件 "luckin-coffee-mcp" 从版本 0\.2\.0 更新为 0\.3\.0/u);
  assert.match(update.asked[0].message, /更新前会先停用旧版本，并等待进行中的调用结束/u);
  assert.match(update.asked[0].message, /MCP 服务的连接与工具授权需要重新确认/u);
  assert.equal(update.result.isError, false, JSON.stringify(update.result));

  // A digest the user did not preview is refused before any confirmation.
  const stale = await run("plugin_install", { draftId, previewDigest: "d".repeat(64), expectedRevision: 0, enable: true },
    { plugin_status: draft });
  assert.equal(stale.asked.length, 0);
  assert.deepEqual(stale.calls.map(call => call.name), ["plugin_status"]);
  assert.equal(stale.result.isError, true);

  const setup = { installationId: "inst-1", packageName: "luckin-coffee-mcp", declaredVersion: "0.3.0", releaseDigest,
    desiredState: "enabled", revision: 2, skills: 1, nextSteps: ["activate"], components: [
      { componentId: "e".repeat(64), name: "my-coffee", transport: "streamable-http", target: "https://gwmcp.lkcoffee.com/order/user/mcp",
        interpreter: null, interpreterReady: null, secrets: [{ name: "LUCKIN_MCP_TOKEN", configured: true }],
        state: "activation_required", reason: null, tools: null, granted: 0 },
      { componentId: "f".repeat(64), name: "local-helper", transport: "stdio", target: "node ./scripts/helper.mjs",
        interpreter: "node", interpreterReady: false, secrets: [], state: "activation_required", reason: null, tools: null, granted: 0 },
      { componentId: "1".repeat(64), name: "oauth-only", transport: "streamable-http", target: "https://vendor.example/mcp",
        interpreter: null, interpreterReady: null, secrets: [], state: "unsupported", reason: "CONNECTION_AUTH_REQUIRED", tools: null, granted: 0 },
    ] };
  const activate = await run("plugin_activate", { installationId: "inst-1", releaseDigest },
    { plugin_setup_get: setup, plugin_activate: { ...setup, nextSteps: ["ready_next_turn"] } });
  assert.deepEqual(activate.calls.map(call => [call.name, call.confirmation]),
    [["plugin_setup_get", false], ["plugin_activate", true]]);
  const question = activate.asked[0].message;
  assert.match(question, /启用插件 "luckin-coffee-mcp"/u);
  assert.match(question, /"my-coffee"（连接 https:\/\/gwmcp\.lkcoffee\.com）/u);
  assert.match(question, /"local-helper"（运行 "node \.\/scripts\/helper\.mjs"，使用本机已安装的 Node\.js）/u);
  assert.match(question, /标注为破坏性的工具每次调用前仍会询问你/u);
  assert.match(question, /"oauth-only" 尚需凭据或在插件页连接账号/u);

  const canceled = await run("plugin_activate", { installationId: "inst-1", releaseDigest },
    { plugin_setup_get: setup }, "取消");
  assert.deepEqual(canceled.calls.map(call => call.name), ["plugin_setup_get"], "cancel never reaches the Service tool");
  assert.equal(canceled.result.structuredContent.canceled, true);

  const moved = await run("plugin_activate", { installationId: "inst-1", releaseDigest: "9".repeat(64) },
    { plugin_setup_get: setup });
  assert.equal(moved.asked.length, 0);
  assert.equal(moved.result.isError, true);

  const secret = await run("plugin_secret_request", { installationId: "inst-1", name: "LUCKIN_MCP_TOKEN",
    reason: "在 open.lkcoffee.com/mcp 登录后复制" }, { plugin_secret_request: { status: "stored", installationId: "inst-1",
    name: "LUCKIN_MCP_TOKEN", configured: true, components: [], nextSteps: ["activate"] } });
  assert.equal(secret.asked.length, 0, "the Service, not the helper, raises the credential card");
  assert.equal(secret.calls[0].timeoutMs > 5 * 60_000, true);
  assert.equal(secret.calls[0].timeoutMs > DEFAULT_SERVER_REQUEST_TIMEOUT_MS, true);
  console.log("plugin setup helper unit: ok");
})().catch(error => { console.error(error); process.exitCode = 1; });
