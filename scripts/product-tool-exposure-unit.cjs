"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const exposure = require("../app/agent-service/product-tool-exposure");
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../app/agent-service/mcp-product-tool-controller");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");

test("resident exposure lists core tools plus the two entry tools and much less schema text", () => {
  const names = new Set(MCP_PRODUCT_TOOL_DEFINITIONS.map(tool => tool.name));
  for (const name of exposure.RESIDENT_PRODUCT_TOOLS) assert.equal(names.has(name), true, `${name} is a product tool`);
  const resident = exposure.residentToolDefinitions(MCP_PRODUCT_TOOL_DEFINITIONS);
  assert.deepEqual(resident.slice(-2).map(tool => tool.name), ["product_tool_search", "product_tool_call"]);
  assert.equal(resident.length, exposure.RESIDENT_PRODUCT_TOOLS.size + 2);
  for (const name of ["group_member_role_read", "group_messages_read", "request_user_input", "workspace_execute"]) {
    assert.equal(exposure.RESIDENT_PRODUCT_TOOLS.has(name), true, `${name} must not need a search first`);
  }
  const size = tools => estimateContextTokens(JSON.stringify(tools.map(({ name, description, inputSchema }) =>
    ({ name, description, inputSchema }))));
  assert.ok(size(resident) * 2 < size(MCP_PRODUCT_TOOL_DEFINITIONS), "resident definitions are well under half the full list");
});

test("only Runtimes that load every definition up front use resident exposure", () => {
  for (const runtime of ["pi", "deepseek-harness", "opencode"]) assert.equal(exposure.toolExposureFor(runtime), "resident");
  for (const runtime of ["codex", "grok-build", "claude-code", "antigravity", "future"]) {
    assert.equal(exposure.toolExposureFor(runtime), "all", runtime);
  }
});

test("search ranks names, then domains, then descriptions, and an empty query lists names by domain", () => {
  const search = query => exposure.searchProductTools(MCP_PRODUCT_TOOL_DEFINITIONS, { query, limit: 3 }).tools.map(tool => tool.name);
  assert.equal(search("kanban card")[0], "kanban_card_create");
  assert.equal(search("heartbeat interval")[0], "heartbeat_settings_set");
  assert.equal(search("federation agent run")[0], "federation_agent_run");
  assert.equal(search("memory save").some(name => exposure.RESIDENT_PRODUCT_TOOLS.has(name)), false,
    "resident tools are already listed, so they are not search results");
  assert.deepEqual(search("zz"), []);
  const index = exposure.searchProductTools(MCP_PRODUCT_TOOL_DEFINITIONS, { query: "" }).index;
  assert.equal(index.cron.includes("cron_create"), true);
  assert.equal(Object.values(index).flat().includes("memory_save"), false);
  const match = exposure.searchProductTools(MCP_PRODUCT_TOOL_DEFINITIONS, { query: "plugin", limit: 1 }).tools[0];
  assert.match(match.description, /plugin_create|plugin/u);
  assert.equal(typeof match.inputSchema, "object");
});

test("entry tool arguments are strict and the call target can never be an entry tool", () => {
  assert.equal(exposure.validSearchArguments({ query: "cron" }), true);
  assert.equal(exposure.validSearchArguments({ query: "cron", limit: 10 }), true);
  for (const bad of [null, [], {}, { query: 1 }, { query: "x".repeat(201) }, { query: "x", limit: 0 },
    { query: "x", limit: 11 }, { query: "x", extra: true }]) assert.equal(exposure.validSearchArguments(bad), false, JSON.stringify(bad));
  assert.equal(exposure.validCallArguments({ name: "cron_list", arguments: {} }), true);
  for (const bad of [{ name: "cron_list" }, { name: "", arguments: {} }, { name: "cron_list", arguments: [] },
    { name: "product_tool_call", arguments: {} }, { name: "product_tool_search", arguments: {} },
    { name: "cron_list", arguments: {}, extra: 1 }]) assert.equal(exposure.validCallArguments(bad), false, JSON.stringify(bad));
});

test("the runtime MCP gate adds the resident flag only when asked and rejects unknown exposures", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-exposure-")));
  fs.chmodSync(root, 0o700);
  try {
    const paths = resolveServicePaths({ homeDir: root });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { mode: 0o700 });
    const helper = path.join(bin, "Shoggoth");
    fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
    const bootstrap = path.join(root, "app.asar", "app", "bootstrap.js");
    fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
    fs.writeFileSync(bootstrap, "bootstrap\n", { mode: 0o600 });
    const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: helper, argsPrefix: [] },
      bootstrapPath: bootstrap, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }).open();
    const input = { runtimeProfileId: "pi-main", runtimeAccountId: "pi-account", parentExecutable: helper };
    const flag = "--shoggoth-tool-exposure=resident";
    assert.equal(issuer.reserveMcpServer(input).args.includes(flag), false);
    assert.equal(issuer.reserveMcpServer({ ...input, toolExposure: "all" }).args.includes(flag), false);
    assert.equal(issuer.reserveMcpServer({ ...input, toolExposure: "resident" }).args.includes(flag), true);
    assert.throws(() => issuer.reserveMcpServer({ ...input, toolExposure: "everything" }), { code: "RUNTIME_MCP_GATE_INPUT_INVALID" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
