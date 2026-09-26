"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginMcpConnectionPool } = require("../app/agent-service/plugin-mcp-connection-pool");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { buildPluginToolCatalog, pluginToolContractDigest } = require("../app/agent-service/plugin-tool-contract");

const MIME = "text/html;profile=mcp-app";
const URI = "ui://fixture/dashboard";
const HTML = "<!doctype html><html><body>fixture UI</body></html>";
const TOOL = { name: "dashboard", inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: URI, visibility: ["model", "app"] } } };
const HASH = "a".repeat(64);

function responseFor(message, state) {
  const complete = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  const capabilities = { tools: {}, ...(state.noResources ? {} : { resources: {} }) };
  const freshness = state.version === "2026-07-28"
    ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {};
  if (message.method === "server/discover" && state.version === "2026-07-28") {
    return complete({ supportedVersions: [state.version], capabilities,
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "app-fixture", version: "1" } } });
  }
  if (message.method === "initialize") {
    state.capabilities = message.params.capabilities;
    return complete({ protocolVersion: "2025-11-25", serverInfo: { name: "app-fixture", version: "1" },
      capabilities });
  }
  if (message.method === "tools/list") return complete({ ...freshness, tools: [state.tool || TOOL] });
  if (message.method === "tools/call") return complete({ content: [{ type: "text", text: "Text fallback remains available" }] });
  if (message.method === "resources/read") {
    state.reads = (state.reads || 0) + 1;
    if (state.mode === "secret-error") return { jsonrpc: "2.0", id: message.id,
      error: { code: -32603, message: "server reflected fixture-private-bearer" } };
    const content = { uri: state.mode === "wrong-uri" ? "ui://fixture/other" : URI,
      mimeType: state.mode === "wrong-mime" ? "text/html" : MIME,
      text: state.mode === "big-html" ? `<!doctype html><html>${"x".repeat(200 * 1024)}</html>`
        : state.mode === "big-frame" ? "x".repeat(300 * 1024) : HTML,
      _meta: { ui: { prefersBorder: true }, privateDiagnostic: "must not reach app" } };
    if (state.mode === "blob") { content.blob = Buffer.from(HTML).toString("base64"); delete content.text; }
    if (state.mode === "bad-blob") { content.blob = "8A=="; delete content.text; }
    return complete({ ...freshness, contents: [content] });
  }
  return undefined;
}

if (process.argv.includes("--stdio")) {
  const state = {};
  const input = readline.createInterface({ input: process.stdin });
  process.stdout.on("error", () => process.exit(0));
  input.on("line", (line) => {
    const response = responseFor(JSON.parse(line), state);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
} else {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const catalogArgs = { installationId: "installation-a", componentId: HASH,
    connectionId: "connection-a", tools: [TOOL] };
  const catalog = buildPluginToolCatalog(catalogArgs);
  assert.deepEqual(catalog.entries[0].ui, { resourceUri: URI, visibility: ["model", "app"] });
  assert.equal(Object.isFrozen(catalog.entries[0].ui.visibility), true);
  const changedTool = { ...TOOL, _meta: { ui: { resourceUri: "ui://fixture/new", visibility: ["app"] } } };
  const changed = buildPluginToolCatalog({ ...catalogArgs, tools: [changedTool] });
  assert.notEqual(changed.entries[0].contractDigest, catalog.entries[0].contractDigest);
  assert.notEqual(changed.generationDigest, catalog.generationDigest);
  assert.equal(changed.entries[0].toolIdentity, catalog.entries[0].toolIdentity);
  const malformed = { ...TOOL, _meta: { ui: { resourceUri: "file:///secret", visibility: ["app"] } } };
  assert.equal(buildPluginToolCatalog({ ...catalogArgs, tools: [malformed] }).entries[0].appUnsupported, true);

  const state = { reads: 0 };
  let allowed = true;
  let currentAccount = "fixture-account";
  let switchDuringToken = false;
  let holdRead = null;
  let releaseRead = null;
  const fetchImpl = async (_url, options) => {
    if (options.method !== "POST") return new Response(null, { status: 405 });
    assert.equal(options.headers.get("authorization"), "Bearer fixture-private-bearer");
    const request = JSON.parse(options.body);
    const result = responseFor(request, state);
    if (request.method === "resources/read" && holdRead) {
      holdRead();
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return result ? new Response(JSON.stringify(result), { status: 200,
      headers: { "content-type": "application/json" } }) : new Response(null, { status: 202 });
  };
  const credentialProvider = async () => {
    if (switchDuringToken) currentAccount = "other-account";
    return { accessToken: "fixture-private-bearer", principalIdentity: "fixture-account", authRevision: 1 };
  };
  credentialProvider.assertCurrent = () => {
    if (currentAccount !== "fixture-account") throw Object.assign(new Error("changed account"), { code: "CONNECTION_IDENTITY_CHANGED" });
  };
  const connection = await PluginMcpClient.connectHttp({ url: "https://fixture.invalid/mcp", fetchImpl,
    connectionId: "connection-a", principalIdentity: "fixture-account", authRevision: 1,
    credentialProvider, authorizeEgress: () => true, versionMode: "legacy", appSupport: true, timeoutMs: 1500 });
  const read = () => connection.readAppResource({ toolName: TOOL.name,
    contractDigest: pluginToolContractDigest(TOOL), resourceUri: URI, assertCurrent: () => allowed });
  try {
    assert.deepEqual(state.capabilities.extensions["io.modelcontextprotocol/ui"], { mimeTypes: [MIME] });
    await assert.rejects(read(), { code: "MCP_APP_RESOURCE_FORBIDDEN" });
    await connection.listTools();
    const result = await read();
    assert.equal(result.text, HTML);
    assert.equal(result.mimeType, MIME);
    assert.deepEqual(result._meta, { ui: { prefersBorder: true } });
    assert.equal(JSON.stringify(result).includes("fixture-private-bearer"), false);
    assert.equal(state.reads, 1);
    await assert.rejects(connection.readAppResource({ toolName: TOOL.name,
      contractDigest: pluginToolContractDigest(TOOL), resourceUri: "ui://fixture/other", assertCurrent: () => true }),
    { code: "MCP_APP_RESOURCE_FORBIDDEN" });
    await assert.rejects(connection.readAppResource({ toolName: TOOL.name,
      contractDigest: HASH, resourceUri: URI, assertCurrent: () => true }), { code: "MCP_APP_RESOURCE_FORBIDDEN" });
    assert.equal(state.reads, 1, "wrong URI/contract must not emit resources/read");
    for (const [mode, code] of [["wrong-uri", "MCP_APP_RESOURCE_INVALID"], ["wrong-mime", "MCP_APP_RESOURCE_INVALID"],
      ["big-html", "MCP_SERVER_RESPONSE_TOO_LARGE"], ["big-frame", "MCP_SERVER_RESPONSE_TOO_LARGE"],
      ["bad-blob", "MCP_APP_RESOURCE_INVALID"], ["secret-error", "MCP_APP_RESOURCE_UNAVAILABLE"]]) {
      state.mode = mode;
      await assert.rejects(read(), (error) => {
        assert.equal(error.message.includes("fixture-private-bearer"), false);
        return error.code === code;
      });
    }
    state.mode = "blob";
    assert.equal((await read()).text, HTML);
    state.mode = undefined;
    let sent;
    const sentPromise = new Promise((resolve) => { sent = resolve; });
    holdRead = sent;
    const revoking = read();
    await sentPromise;
    allowed = false;
    releaseRead();
    await assert.rejects(revoking, { code: "CAPABILITY_FORBIDDEN" });
    holdRead = null;
    allowed = true;
    const beforeAccountSwitch = state.reads;
    switchDuringToken = true;
    await assert.rejects(read(), { code: "CONNECTION_IDENTITY_CHANGED" });
    assert.equal(state.reads, beforeAccountSwitch, "account switch during async auth cannot reach HTTP send");
    switchDuringToken = false;
    currentAccount = "fixture-account";
    state.tool = malformed;
    await connection.listTools();
    await assert.rejects(read(), { code: "MCP_APP_RESOURCE_FORBIDDEN" });
    const fallback = await connection.callTool(TOOL.name, {}, { fixture: true });
    assert.equal(fallback.content[0].text, "Text fallback remains available");
  } finally { await connection.close(); }

  const noResourcesState = { noResources: true };
  const unsupported = await PluginMcpClient.connectHttp({ url: "https://fixture.invalid/mcp", versionMode: "legacy",
    appSupport: true, connectionId: "unsupported", principalIdentity: "fixture-account", authorizeEgress: () => true,
    fetchImpl: async (_url, options) => {
      if (options.method !== "POST") return new Response(null, { status: 405 });
      const result = responseFor(JSON.parse(options.body), noResourcesState);
      return result ? new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } })
        : new Response(null, { status: 202 });
    } });
  try {
    await unsupported.listTools();
    await assert.rejects(unsupported.readAppResource({ toolName: TOOL.name, contractDigest: pluginToolContractDigest(TOOL),
      resourceUri: URI, assertCurrent: () => true }), { code: "MCP_APP_UNSUPPORTED" });
  } finally { await unsupported.close(); }

  for (const appSupport of [false, true]) {
    const modernState = { version: "2026-07-28", reads: 0 };
    const modern = await PluginMcpClient.connectHttp({ url: "https://fixture.invalid/mcp",
      appSupport, connectionId: `modern-${appSupport}`, principalIdentity: "fixture-account", authorizeEgress: () => true,
      fetchImpl: async (_url, options) => {
        if (options.method !== "POST") return new Response(null, { status: 405 });
        const result = responseFor(JSON.parse(options.body), modernState);
        return result ? new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } })
          : new Response(null, { status: 202 });
      } });
    try {
      assert.equal(modern.getProtocol().version, "2026-07-28");
      await modern.listTools();
      const input = { toolName: TOOL.name, contractDigest: pluginToolContractDigest(TOOL), resourceUri: URI,
        assertCurrent: () => true };
      if (appSupport) assert.equal((await modern.readAppResource(input)).text, HTML);
      else {
        await assert.rejects(modern.readAppResource(input), { code: "MCP_APP_UNSUPPORTED" });
        assert.equal(modernState.reads, 0);
      }
    } finally { await modern.close(); }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-app-resource-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  const pool = new PluginMcpConnectionPool({ leaseManager: new PluginDataScopeLeaseManager({ paths }), authorizeEgress: () => true });
  let handle;
  try {
    handle = await pool.acquireStdio({ command: process.execPath, args: [__filename, "--stdio"], cwd: __dirname,
      env: { PATH: process.env.PATH }, connectionId: "stdio-app", principalIdentity: "fixture-account", authRevision: 1,
      installationId: "installation-a", componentId: HASH, releaseDigest: HASH, scopeId: HASH,
      executionScope: "fixture", timeoutMs: 1500, appSupport: true });
    await handle.listTools();
    const input = { toolName: TOOL.name, contractDigest: pluginToolContractDigest(TOOL), resourceUri: URI,
      assertCurrent: () => true };
    assert.equal((await handle.readAppResource(input)).text, HTML);
    let drained = false;
    await assert.rejects(handle.readAppResource({ ...input, assertCurrent() {
      if (!drained) { drained = true; void pool.drainInstallation("installation-a").catch(() => {}); }
      return true;
    } }), { code: "MCP_APP_RESOURCE_UNAVAILABLE" });
    await handle.release(); handle = null;
    await pool.drainInstallation("installation-a");
  } finally {
    await handle?.release();
    await pool.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("plugin MCP App resource transport/metadata fixture: PASS");
}
