"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { PassThrough } = require("node:stream");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager, StdioMcpClient } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { validateConnectorParams, validateConnectorResult } = require("../app/core/connector-dto");
const { createTicketmasterRuntime, commandFor, TOOLS } = require("../app/agent-service/ticketmaster-runtime");
const { COMMAND, BRIDGE_ENTRY, CLI_ENTRY, KEY_FIELD, matchTicketmasterBridgeLaunch, validateTicketmasterBridgeCredentials, normalizeTicketmasterTransport } = require("../app/agent-service/ticketmaster-mcp-launch");
const { serve } = require("../app/agent-service/ticketmaster-mcp-bridge");
const { createTicketmasterFixture } = require("./fixtures/ticketmaster-cli-fixture.cjs");
const preset = require("../app/agent-service/data/mcp-featured-presets.json").find(item => item.id === "ticketmaster");
const KEY = "fixture-consumer-key";

async function withRuntime(work, key = KEY, options = {}) {
  const fixture = createTicketmasterFixture();
  const runtime = createTicketmasterRuntime({ env: { ...fixture.env, [KEY_FIELD]: key, UNRELATED_SECRET: "must-not-propagate" }, ...options });
  try { await work(runtime, fixture); } finally { await runtime.close(); fixture.close(); }
}

test("bundled CLI is independent of the installed global binary and packaged by the app glob", () => {
  assert.ok(fs.existsSync(CLI_ENTRY));
  assert.match(fs.readFileSync(CLI_ENTRY, "utf8"), /VERSION = "0\.2\.1"/u);
  assert.match(fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8"), /- app\/\*\*\/\*/u);
  assert.equal(preset.setup, "api-key"); assert.equal(preset.transport.command, COMMAND);
  assert.equal(preset.fields[0].name, KEY_FIELD); assert.equal(preset.fields[0].secret, true);
  assert.equal(TOOLS.length, 5); assert.ok(TOOLS.every(tool => tool.annotations.readOnlyHint && tool.annotations.destructiveHint === false));
});

test("trusted runtime admission accepts only the exact bundled entry and Consumer Key field", () => {
  const launch = normalizeTicketmasterTransport({ ...preset.transport, cwd: "/tmp" });
  assert.equal(launch.command, process.execPath); assert.deepEqual(launch.args, [BRIDGE_ENTRY]);
  assert.ok(matchTicketmasterBridgeLaunch(launch.command, launch.args));
  assert.equal(matchTicketmasterBridgeLaunch(launch.command, [BRIDGE_ENTRY, "--eval", "bad"]), false);
  assert.equal(matchTicketmasterBridgeLaunch("/untrusted/node", launch.args), false);
  assert.throws(() => normalizeTicketmasterTransport({ ...preset.transport, args: ["--eval=bad"] }), { code: "MCP_SERVER_COMMAND_FORBIDDEN" });
  for (const fields of [{ env: { HOME: "/tmp", [KEY_FIELD]: KEY } }, { env: { PYTHONPATH: "/tmp" } }, { headers: { Authorization: KEY } }, { env: { [KEY_FIELD]: "bad\nkey" } }, { env: { [KEY_FIELD]: " " } }]) {
    assert.throws(() => validateTicketmasterBridgeCredentials(launch, fields), { code: "MCP_SECRET_INVALID" });
  }
  validateTicketmasterBridgeCredentials(launch, { env: { [KEY_FIELD]: ` ${KEY} ` } });
});

test("tool inputs cannot select a command, endpoint, environment, key or unsupported write", () => {
  for (const [name, args] of [["ticketmaster_search_events", { url: "https://evil.test" }], ["ticketmaster_search_events", { api_key: KEY }], ["ticketmaster_search_events", { env: {} }], ["ticketmaster_search_events", { size: 21 }], ["ticketmaster_search_events", { page: 100, size: 10 }], ["ticketmaster_search_events", { keyword: "\n" }], ["ticketmaster_search_events", { sort: "invalid" }], ["ticketmaster_get_event_details", {}], ["offers", {}], ["purchase", {}]]) {
    assert.throws(() => commandFor(name, args), { code: "TICKETMASTER_INVALID_ARGUMENT" });
  }
  assert.ok(commandFor("ticketmaster_search_events", { keyword: "--api-key=not-an-option", classification_name: "Music" }).includes("--keyword=--api-key=not-an-option"));
});

test("real bundled Python CLI browses upcoming concerts without a required keyword, preserving images and prices", async () => withRuntime(async (runtime, fixture) => {
  const tools = await runtime.listTools(); await runtime.listTools();
  assert.equal(tools.length, 5); assert.equal(fixture.calls().length, 1, "one credential probe is cached");
  const result = await runtime.call("ticketmaster_search_events", { classification_name: "Music", country_code: "gb", city: "London", start_date: "2026-10-29", end_date: "2026-11-27", sort: "date,asc", size: 5 });
  const event = result._embedded.events[0];
  assert.equal(event.name, "Fixture Concert"); assert.equal(event.images[0].width, 1024); assert.equal(event.images[0].fallback, false);
  assert.equal(event.priceRanges[0].currency, "USD"); assert.equal(event._embedded.venues[0].name, "Fixture Hall");
  assert.ok(event.seatmap.staticUrl); assert.equal(JSON.stringify(result).includes(KEY), false);
  const request = fixture.calls().at(-1);
  assert.equal(request.path, "/discovery/v2/events.json"); assert.equal(request.method, "GET"); assert.equal(request.key_in_environment, true);
  assert.deepEqual(request.query.countryCode, ["GB"]); assert.equal(request.query.keyword, undefined);
  assert.deepEqual(request.query.startDateTime, ["2026-10-29T00:00:00Z"]); assert.deepEqual(request.query.sort, ["date,asc"]);
}));

test("all five advertised tools run through the real bundled Python CLI with fixed Discovery GET paths", async () => withRuntime(async (runtime, fixture) => {
  const detail = await runtime.call("ticketmaster_get_event_details", { event_id: "fixture-event" });
  assert.equal(detail.id, "fixture-event"); assert.equal(detail.images[0].ratio, "16_9");
  const photos = await runtime.call("ticketmaster_get_event_images", { event_id: "fixture-event" });
  assert.deepEqual(Object.keys(photos).sort(), ["id", "images", "name"]);
  const venues = await runtime.call("ticketmaster_search_venues", { city: "Fixture City", country_code: "US" });
  assert.equal(venues._embedded.venues[0].id, "fixture-venue");
  const artists = await runtime.call("ticketmaster_search_attractions", { keyword: "Fixture Singer" });
  assert.equal(artists._embedded.attractions[0].id, "fixture-artist");
  await runtime.call("ticketmaster_search_events", { keyword: "Fixture Concert" });
  assert.equal(fixture.calls().length, 5); assert.ok(fixture.calls().every(call => call.method === "GET" && call.path.startsWith("/discovery/v2/")));
}));

test("invalid dates and bounds are rejected before any network request", async () => withRuntime(async (runtime, fixture) => {
  await assert.rejects(runtime.call("ticketmaster_search_events", { start_date: "not-a-date" }), { code: "TICKETMASTER_INVALID_ARGUMENT" });
  await assert.rejects(runtime.call("ticketmaster_search_events", { start_date: "2026-11-20", end_date: "2026-11-01" }), { code: "TICKETMASTER_INVALID_ARGUMENT" });
  await assert.rejects(runtime.call("ticketmaster_search_events", { size: 0 }), { code: "TICKETMASTER_INVALID_ARGUMENT" });
  assert.equal(fixture.calls().length, 0);
}));

test("missing key and Python are actionable setup failures without external requests", async () => {
  await withRuntime(async (runtime, fixture) => { await assert.rejects(runtime.listTools(), { code: "MCP_AUTH_REQUIRED" }); assert.equal(fixture.calls().length, 0); }, "");
  await withRuntime(async (runtime, fixture) => { await assert.rejects(runtime.listTools(), { code: "TICKETMASTER_PYTHON_REQUIRED" }); assert.equal(fixture.calls().length, 0); }, KEY, { resolvePython: () => { throw new Error("fixture"); } });
});

test("401, 403, 429, network and malformed data remain redacted and are never retried", async () => {
  for (const [key, code] of [["fixture-unauthorized", "MCP_AUTH_REQUIRED"], ["fixture-forbidden", "MCP_AUTH_REQUIRED"], ["fixture-rate-limit", "TICKETMASTER_RATE_LIMITED"], ["fixture-network-error", "MCP_SERVER_CONNECTION_FAILED"], ["fixture-invalid-json", "MCP_SERVER_RESPONSE_INVALID"], ["fixture-wrong-shape", "MCP_SERVER_RESPONSE_INVALID"]]) {
    await withRuntime(async (runtime, fixture) => {
      await assert.rejects(runtime.listTools(), error => { assert.equal(error.code, code); assert.equal(error.message.includes(key), false); return true; });
      await assert.rejects(runtime.listTools(), { code }); assert.equal(fixture.calls().length, 1);
    }, key);
  }
});

test("cancellation stops a real child operation and leaves no automatic retry", async () => withRuntime(async (runtime, fixture) => {
  const abort = new AbortController();
  const call = runtime.call("ticketmaster_search_events", { keyword: "Fixture" }, { signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 150);
  try { await assert.rejects(call, { code: "TICKETMASTER_CANCELLED" }); } finally { clearTimeout(timer); }
  assert.ok(fixture.calls().length <= 1);
}, "fixture-slow"));

test("stdio handles valid requests, rejects invalid input and returns safe tool errors", async () => {
  const input = new PassThrough(), output = new PassThrough(); let buffer = "";
  output.on("data", chunk => { buffer += chunk.toString(); });
  const server = serve({ input, output, runtime: { listTools: async () => TOOLS, call: async () => { throw Object.assign(new Error(KEY), { code: "MCP_AUTH_REQUIRED", status: 401 }); }, close: async () => {} } });
  try {
    input.write('{bad}\nnull\n' + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ticketmaster_search_events", arguments: {} } }) + "\n");
    await new Promise(resolve => setImmediate(resolve));
    const messages = buffer.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(messages[0].error.code, -32700); assert.equal(messages[1].error.code, -32600);
    assert.equal(messages.find(item => item.id === 1).result.serverInfo.name, "shoggoth-ticketmaster");
    assert.equal(messages.find(item => item.id === 2).result.isError, true); assert.equal(buffer.includes(KEY), false);
  } finally { await server.close(); input.destroy(); output.destroy(); }
});

test("real controller/store/manager persist private credentials, survive restart, preserve exclusions and remove cleanly", async () => {
  const fixture = createTicketmasterFixture();
  const paths = resolveServicePaths({ homeDir: fixture.root, stateRoot: path.join(fixture.root, "state"), cacheRoot: path.join(fixture.root, "cache"), profileRoot: path.join(fixture.root, "profiles"), trustedRoot: fixture.root });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const encrypted = new Map();
  const secrets = new McpConnectorSecrets({ secretStore: { get: async key => encrypted.get(key) ?? null, put: async (key, value) => encrypted.set(key, value), delete: async key => encrypted.delete(key) } });
  let store = new NativeMcpStore({ paths }).open(), manager, controller;
  const start = () => {
    manager = new NativeMcpClientManager({ store, secrets, env: fixture.env }).open();
    controller = new McpConnectorController({ store, secrets, manager, paths, registry: {}, oauth: { close: async () => {} }, packageLauncher: {}, getSubjects: async () => ({ items: ["allowed-agent", "excluded-agent"].map(id => ({ profileId: id, agentId: id, backendId: "shoggoth", label: id, enabled: true })), unavailableBackends: [] }) }).open();
  };
  const call = async (method, args) => validateConnectorResult(method, await controller.handle(method, validateConnectorParams(method, args)));
  try {
    start();
    const added = await call("connector.mcp.add", { source: { kind: "custom" }, name: preset.name, option: preset.transport, expectedRevision: store.revision });
    const id = added.server.id; assert.equal(added.server.status, "needsSetup"); assert.equal(added.server.recommendationId, "ticketmaster");
    await call("connector.mcp.agents.set", { id, disabledProfileIds: ["excluded-agent"], expectedRevision: store.revision });
    let result = await call("connector.mcp.credentials.update", { id, fields: { env: { [KEY_FIELD]: "fixture-unauthorized" } }, expectedRevision: store.revision });
    assert.equal(result.server.status, "signedOut"); assert.equal(result.server.lastCheck.errorCode, "MCP_AUTH_REQUIRED");
    result = await call("connector.mcp.credentials.update", { id, fields: { env: { [KEY_FIELD]: KEY } }, expectedRevision: store.revision });
    assert.equal(result.server.status, "ready"); assert.equal(result.server.lastCheck.toolCount, 5);
    assert.equal(JSON.stringify(store.list()).includes(KEY), false); assert.equal(JSON.stringify(store.list()).includes(BRIDGE_ENTRY), false);
    assert.equal(fs.readFileSync(paths.nativeMcpRegistryPath, "utf8").includes(KEY), false);
    controller.captureRun({ id: "fixture-run", profileId: "allowed-agent" });
    assert.equal(controller.available("allowed-agent", "fixture-run").length, 1); assert.equal(controller.available("excluded-agent").length, 0);
    assert.throws(() => controller.assertAvailable(id, "excluded-agent"), { code: "MCP_CONNECTOR_ACCESS_DENIED" });
    const toolResult = await manager.callTool(id, "ticketmaster_get_event_images", { event_id: "fixture-event" });
    assert.equal(JSON.parse(toolResult.content[0].text).images.length, 1); assert.equal(JSON.stringify(toolResult).includes(KEY), false);
    await assert.rejects(call("connector.mcp.credentials.update", { id, fields: { env: { [KEY_FIELD]: KEY } }, expectedRevision: 1 }), { code: "MCP_REGISTRY_REVISION_CONFLICT" });
    await controller.close(); await manager.close(); store.close();
    store = new NativeMcpStore({ paths }).open(); start();
    result = await call("connector.mcp.verify", { id }); assert.equal(result.server.status, "ready"); assert.deepEqual(result.server.disabledProfileIds, ["excluded-agent"]);
    await call("connector.mcp.remove", { id, expectedRevision: store.revision }); assert.equal(store.list().servers.length, 0); assert.equal(encrypted.size, 0);
  } finally { await controller?.close(); await manager?.close(); store.close(); fixture.close(); }
});

test("an unrelated stdio peer cannot forge trusted Ticketmaster setup errors", async () => {
  const script = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;while(b.includes('\\n')){let p=b.indexOf('\\n'),m=JSON.parse(b.slice(0,p));b=b.slice(p+1);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(m.method==='initialize'?{result:{protocolVersion:'2024-11-05'}}:{error:{code:-32001,message:'MCP_AUTH_REQUIRED'}})})+'\\n');}});`;
  const client = new StdioMcpClient({ command: process.execPath, args: ["-e", script], cwd: __dirname }, { env: process.env });
  try { await assert.rejects(client.listTools(), { code: "MCP_SERVER_CALL_FAILED" }); } finally { await client.close(); }
});

test("the actual Electron runtime executes the bundled CLI from app.asar without an unpacked Python file", async () => {
  const fixture = createTicketmasterFixture(); let client;
  try {
    const asar = await import("@electron/asar");
    const source = path.join(fixture.root, "mini-app"), service = path.join(source, "app", "agent-service");
    fs.mkdirSync(service, { recursive: true, mode: 0o700 });
    for (const name of ["ticketmaster-cli.py", "ticketmaster-mcp-bridge.js", "ticketmaster-mcp-launch.js", "ticketmaster-runtime.js", "mcp-package-launcher.js", "security.js"]) {
      fs.copyFileSync(path.join(__dirname, "../app/agent-service", name), path.join(service, name));
    }
    const archive = path.join(fixture.root, "app.asar"); await asar.createPackage(source, archive);
    client = new StdioMcpClient({ command: require("electron"), args: [path.join(archive, "app", "agent-service", "ticketmaster-mcp-bridge.js")], cwd: fixture.root },
      { env: fixture.env, secretEnv: { [KEY_FIELD]: KEY }, trustedEnv: { ELECTRON_RUN_AS_NODE: "1" }, trustedTicketmasterBridge: true });
    assert.equal((await client.listTools()).length, 5);
    const result = await client.callTool("ticketmaster_get_event_images", { event_id: "fixture-event" });
    assert.equal(JSON.parse(result.content[0].text).images[0].width, 1024); assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(fixture.calls().length, 2); assert.equal(fs.existsSync(archive + ".unpacked"), false);
  } finally { await client?.close(); fixture.close(); }
});
