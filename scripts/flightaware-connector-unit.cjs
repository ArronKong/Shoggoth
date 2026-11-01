"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { PassThrough } = require("node:stream");
const { createFlightawareRuntime, commandFor, TOOLS, project } = require("../app/agent-service/flightaware-runtime");
const launch = require("../app/agent-service/flightaware-mcp-launch");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager, StdioMcpClient } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { validateConnectorParams, validateConnectorResult } = require("../app/core/connector-dto");
const { serve } = require("../app/agent-service/flightaware-mcp-bridge");
const { createFlightawareFixture } = require("./fixtures/flightaware-cli-fixture.cjs");
const preset = require("../app/agent-service/data/mcp-featured-presets.json").find(item => item.id === "flightaware");
const { KEY_FIELD, METERED_FIELD, METERED_ENABLED, METERED_DISABLED, METERED_MARKER, BRIDGE_ENTRY, CLI_ENTRY } = launch;
const KEY = "fixture-aeroapi-key";
const examples = {
  get_flight: { ident: "UAL123", date: "2026-11-01" }, get_flight_ident: { ident: "UAL123" }, get_position: { flight_id: "UAL123-1793232000-airline-0001" },
  get_track: { flight_id: "UAL123-1793232000-airline-0001", include_estimated_positions: false }, get_route: { flight_id: "UAL123-1793232000-airline-0001" }, get_map: { flight_id: "UAL123-1793232000-airline-0001" },
  search_flights: { query: "-origin KJFK -destination KLAX" }, get_schedules: { date_start: "2026-11-01", date_end: "2026-11-02", origin: "KJFK", destination: "KLAX" },
  get_airport: { airport: "KJFK" }, get_airport_flights: { airport: "KJFK", kind: "arrivals" }, get_airport_delays: { airport: "KJFK" }, get_airport_weather: { airport: "KJFK", kind: "observations" }, get_airport_counts: { airport: "KJFK" },
  get_operator: { operator: "UAL" }, get_operator_flights: { operator: "UAL", kind: "enroute" }, get_operator_counts: { operator: "UAL" },
  get_disruptions: { entity_type: "origin", id: "KJFK", time_period: "today" }, check_aircraft_blocked: { ident: "N123HQ" }, get_aircraft_owner: { ident: "N123HQ" }, get_usage: {},
};
async function withRuntime(work, { key = KEY, consent = false, ...options } = {}) {
  const fixture = createFlightawareFixture();
  const runtime = createFlightawareRuntime({ env: { ...fixture.env, [KEY_FIELD]: key, [METERED_FIELD]: consent ? METERED_ENABLED : METERED_DISABLED, UNRELATED_SECRET: "must-not-propagate" }, ...options });
  try { await work(runtime, fixture); } finally { await runtime.close(); fixture.close(); }
}
test("bundled runtime has a fixed private launch, own key field and read-only tool schemas", () => {
  assert.match(fs.readFileSync(CLI_ENTRY, "utf8"), /VERSION = "0\.2\.1"/u);
  assert.match(fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8"), /- app\/\*\*\/\*/u);
  const transport = launch.normalizeFlightawareTransport(preset.transport);
  assert.equal(transport.command, process.execPath); assert.deepEqual(transport.args, [BRIDGE_ENTRY]);
  assert.equal(preset.fields[0].name, KEY_FIELD); assert.equal(preset.fields[0].secret, true);
  assert.equal(TOOLS.length, 20); assert.ok(TOOLS.every(t => t.annotations.readOnlyHint && t.annotations.destructiveHint === false && t.inputSchema.additionalProperties === false));
  assert.throws(() => launch.normalizeFlightawareTransport({ ...preset.transport, args: ["--eval=bad"] }), { code: "MCP_SERVER_COMMAND_FORBIDDEN" });
  assert.equal(launch.matchFlightawareBridgeLaunch(process.execPath, [BRIDGE_ENTRY, "bad"]), false);
  for (const fields of [{ headers: { Authorization: KEY } }, { env: { HOME: "/tmp" } }, { env: { PATH: "/tmp" } }, { env: { [KEY_FIELD]: "bad\nkey" } }, { env: { [METERED_FIELD]: "true" } }]) assert.throws(() => launch.validateFlightawareBridgeCredentials(transport, fields), { code: "MCP_SECRET_INVALID" });
});
test("a connection check caches only one $0 usage query, and every metered tool is blocked by default", async () => withRuntime(async (runtime, fixture) => {
  assert.equal((await runtime.listTools()).length, 20); await runtime.listTools();
  assert.equal(fixture.calls().length, 1); assert.equal(fixture.calls()[0].path, "/aeroapi/account/usage");
  for (const [suffix, input] of Object.entries(examples)) if (suffix !== "get_usage") await assert.rejects(runtime.call(`flightaware_${suffix}`, input), { code: "FLIGHTAWARE_METERED_DISABLED" });
  assert.equal(fixture.calls().length, 1, "blocked calls must never spawn/query the provider");
  const usage = await runtime.call("flightaware_get_usage", {}); assert.equal(usage.total_cost, 0.01); assert.equal(JSON.stringify(usage).includes(KEY), false);
}));
test("every advertised tool executes the real bundled Python CLI through fixed GET endpoints", async () => withRuntime(async (runtime, fixture) => {
  for (const [suffix, input] of Object.entries(examples)) {
    const result = await runtime.call(`flightaware_${suffix}`, input);
    assert.equal(JSON.stringify(result).includes(KEY), false, suffix);
    if (suffix === "get_map") assert.equal(result.mimeType, "image/png");
    if (suffix === "get_flight") { assert.equal(result.flights[0].ident, "UAL123"); assert.equal(result.flights[0].cancelled, false); }
  }
  assert.equal(fixture.calls().length, 20); assert.ok(fixture.calls().every(c => c.method === "GET" && c.key_in_header && c.path.startsWith("/aeroapi/") && c.query.apikey === undefined));
  for (const call of fixture.calls()) if (call.query.max_pages) assert.deepEqual(call.query.max_pages, ["1"]);
  const flight = fixture.calls().find(c => c.path === "/aeroapi/flights/UAL123");
  assert.deepEqual(flight.query.start, ["2026-11-01T00:00:00Z"]); assert.deepEqual(flight.query.end, ["2026-11-02T00:00:00Z"]);
  const search = fixture.calls().find(c => c.path === "/aeroapi/flights/search"); assert.deepEqual(search.query.query, [examples.search_flights.query]);
  await runtime.call("flightaware_search_flights", { query: "{orig KJFK}", advanced: true }); assert.equal(fixture.calls().at(-1).path, "/aeroapi/flights/search/advanced");
}, { consent: true }));
test("model arguments cannot enable metered queries, inject CLI options, write files or choose an endpoint", async () => withRuntime(async (runtime, fixture) => {
  for (const input of [{ ...examples.get_flight, allow_metered: true }, { ...examples.get_flight, api_key: KEY }, { ...examples.get_flight, env: {} }, { ...examples.get_flight, url: "https://evil.invalid" }, { ident: "--allow-metered" }, { ident: "../../account" }, { ...examples.get_flight, max_pages: 2 }]) assert.throws(() => commandFor("flightaware_get_flight", input), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  assert.throws(() => commandFor("flightaware_get_map", { flight_id: "fixture", save: "/tmp/map.png" }), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  assert.throws(() => commandFor("flightaware_flight_intent", {}), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  const args = commandFor("flightaware_search_flights", { query: "--api-key=evil" }); assert.equal(args.at(-2), "--"); assert.equal(args.at(-1), "--api-key=evil");
  await assert.rejects(runtime.call("flightaware_get_flight", { ident: "UAL123", date: "invalid" }), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  await assert.rejects(runtime.call("flightaware_get_flight", { ident: "UAL123", date: "2026-11-01", start: "2026-11-01" }), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  await assert.rejects(runtime.call("flightaware_get_schedules", { date_start: "2026-11-03", date_end: "2026-11-02" }), { code: "FLIGHTAWARE_INVALID_ARGUMENT" });
  assert.equal(fixture.calls().length, 0);
}, { consent: true }));
test("missing key and interpreter fail locally without outbound requests", async () => {
  await withRuntime(async (runtime, fixture) => { await assert.rejects(runtime.listTools(), { code: "MCP_AUTH_REQUIRED" }); assert.equal(fixture.calls().length, 0); }, { key: "" });
  await withRuntime(async (runtime, fixture) => { await assert.rejects(runtime.listTools(), { code: "FLIGHTAWARE_PYTHON_REQUIRED" }); assert.equal(fixture.calls().length, 0); }, { resolvePython: () => { throw new Error("missing"); } });
});
test("auth, plan, rate, redirects, network and invalid responses are bounded, redacted and never retried", async () => {
  for (const [key, code] of [["fixture-unauthorized", "MCP_AUTH_REQUIRED"], ["fixture-forbidden", "FLIGHTAWARE_PLAN_REQUIRED"], ["fixture-rate-limit", "FLIGHTAWARE_RATE_LIMITED"], ["fixture-redirect", "MCP_SERVER_RESPONSE_INVALID"], ["fixture-network-error", "MCP_SERVER_CONNECTION_FAILED"], ["fixture-invalid-json", "MCP_SERVER_RESPONSE_INVALID"], ["fixture-wrong-shape", "MCP_SERVER_RESPONSE_INVALID"], ["fixture-oversized", "MCP_SERVER_RESPONSE_TOO_LARGE"]]) await withRuntime(async (runtime, fixture) => {
    await assert.rejects(runtime.listTools(), error => { assert.equal(error.code, code); assert.equal(error.message.includes(key), false); return true; });
    await assert.rejects(runtime.listTools(), { code }); assert.equal(fixture.calls().length, 1);
  }, { key });
});
test("track truncation is explicit and invalid maps cannot become file or image content", async () => {
  await withRuntime(async runtime => { const track = await runtime.call("flightaware_get_track", examples.get_track); assert.equal(track.positions.length, 1000); assert.equal(track.shoggoth_truncated, true); }, { key: "fixture-long-track", consent: true });
  await withRuntime(async runtime => { await assert.rejects(runtime.call("flightaware_get_map", examples.get_map), { code: "MCP_SERVER_RESPONSE_INVALID" }); }, { key: "fixture-invalid-map", consent: true });
  assert.throws(() => project("flightaware_get_flight", { wrong: true }), { code: "MCP_SERVER_RESPONSE_INVALID" });
});
test("cancellation and timeouts terminate real Python work without retrying", async () => {
  await withRuntime(async (runtime, fixture) => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 150);
    try { await assert.rejects(runtime.call("flightaware_get_flight", examples.get_flight, { signal: abort.signal }), { code: "FLIGHTAWARE_CANCELLED" }); } finally { clearTimeout(timer); }
    assert.ok(fixture.calls().length <= 1);
  }, { key: "fixture-slow", consent: true });
  await withRuntime(async (runtime, fixture) => { await assert.rejects(runtime.listTools(), { code: "MCP_SERVER_TIMEOUT" }); assert.ok(fixture.calls().length <= 1); }, { key: "fixture-slow", timeoutMs: 150 });
});
test("stdio produces native image content and exposes safe errors only", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", c => { text += c; });
  const server = serve({ input, output, runtime: { listTools: async () => TOOLS, call: async name => { if (name === "flightaware_get_map" || name === "other") return { map: "fixture-image", mimeType: "image/png" }; throw Object.assign(new Error(KEY), { code: "FLIGHTAWARE_METERED_DISABLED" }); }, close: async () => {} } });
  try {
    input.write('{bad}\n' + [ { jsonrpc: "2.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "flightaware_get_map" } }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "blocked" } }, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "other" } } ].map(x => JSON.stringify(x) + "\n").join(""));
    await new Promise(resolve => setImmediate(resolve)); const messages = text.trim().split("\n").map(x => JSON.parse(x));
    assert.equal(messages[0].error.code, -32700); assert.equal(messages.find(x => x.id === 1).result.serverInfo.name, "shoggoth-flightaware");
    assert.equal(messages.find(x => x.id === 2).result.content[0].type, "image"); assert.equal(messages.find(x => x.id === 3).result.isError, true); assert.equal(text.includes(KEY), false);
    assert.equal(messages.find(x => x.id === 4).result.content[0].type, "text", "only the map tool can produce an image");
  } finally { await server.close(); input.destroy(); output.destroy(); }
});

test("real controller persists key and consent separately, revokes consent, and restores agent exclusions", async () => {
  const fixture = createFlightawareFixture();
  const paths = resolveServicePaths({ homeDir: fixture.root, stateRoot: path.join(fixture.root, "state"), cacheRoot: path.join(fixture.root, "cache"), profileRoot: path.join(fixture.root, "profiles"), trustedRoot: fixture.root });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const encrypted = new Map(), secrets = new McpConnectorSecrets({ secretStore: { get: async k => encrypted.get(k) ?? null, put: async (k, v) => encrypted.set(k, v), delete: async k => encrypted.delete(k) } });
  let store = new NativeMcpStore({ paths }).open(), manager, controller;
  const start = () => {
    manager = new NativeMcpClientManager({ store, secrets, env: { ...fixture.env, [METERED_FIELD]: METERED_ENABLED } }).open();
    controller = new McpConnectorController({ store, secrets, manager, paths, registry: {}, oauth: { close: async () => {} }, packageLauncher: {}, getSubjects: async () => ({ items: ["allowed-agent", "excluded-agent"].map(id => ({ profileId: id, agentId: id, backendId: "shoggoth", label: id, enabled: true })), unavailableBackends: [] }) }).open();
  };
  const call = async (method, args) => validateConnectorResult(method, await controller.handle(method, validateConnectorParams(method, args)));
  try {
    start();
    let result = await call("connector.mcp.add", { source: { kind: "custom" }, name: preset.name, option: preset.transport, expectedRevision: store.revision });
    const id = result.server.id; assert.equal(result.server.status, "needsSetup"); assert.equal(result.server.recommendationId, "flightaware"); assert.equal(fixture.calls().length, 0);
    result = await call("connector.mcp.credentials.update", { id, fields: { env: { [KEY_FIELD]: "fixture-unauthorized" } }, expectedRevision: store.revision }); assert.equal(result.server.status, "signedOut");
    result = await call("connector.mcp.credentials.update", { id, fields: { env: { [KEY_FIELD]: KEY } }, expectedRevision: store.revision });
    assert.equal(result.server.status, "ready"); assert.equal(result.server.lastCheck.toolCount, 20); assert.ok(!result.server.setup.configuredFields.includes(METERED_MARKER));
    const blocked = await manager.callTool(id, "flightaware_get_flight", examples.get_flight); assert.equal(JSON.parse(blocked.content[0].text).error.code, "FLIGHTAWARE_METERED_DISABLED");
    assert.ok(fixture.calls().every(c => c.path === "/aeroapi/account/usage"), "parent env cannot enable metered calls");
    await call("connector.mcp.agents.set", { id, disabledProfileIds: ["excluded-agent"], expectedRevision: store.revision });
    controller.captureRun({ id: "fixture-run", profileId: "allowed-agent" }); assert.equal(controller.available("allowed-agent", "fixture-run").length, 1);
    result = await call("connector.mcp.credentials.update", { id, fields: { env: { [METERED_FIELD]: METERED_ENABLED } }, expectedRevision: store.revision });
    assert.ok(result.server.setup.configuredFields.includes(METERED_MARKER)); assert.equal(result.server.status, "ready");
    assert.equal(JSON.stringify(store.list()).includes(KEY), false); assert.equal(fs.readFileSync(paths.nativeMcpRegistryPath, "utf8").includes(KEY), false);
    assert.equal((await secrets.get(id)).env[KEY_FIELD], KEY, "permission-only updates preserve the encrypted key");
    const data = await manager.callTool(id, "flightaware_get_flight", examples.get_flight); const flight = JSON.parse(data.content[0].text).flights[0]; assert.equal(flight.ident, "UAL123"); assert.equal(flight.cancelled, false);
    assert.equal(JSON.stringify(data).includes(KEY), false); assert.equal(controller.available("excluded-agent").length, 0); assert.throws(() => controller.assertAvailable(id, "excluded-agent"), { code: "MCP_CONNECTOR_ACCESS_DENIED" });
    await assert.rejects(call("connector.mcp.credentials.update", { id, fields: { env: { [METERED_FIELD]: METERED_DISABLED } }, expectedRevision: 1 }), { code: "MCP_REGISTRY_REVISION_CONFLICT" });
    assert.equal((await secrets.get(id)).env[METERED_FIELD], METERED_ENABLED);
    await controller.close(); await manager.close(); store.close(); store = new NativeMcpStore({ paths }).open(); start();
    result = await call("connector.mcp.verify", { id }); assert.equal(result.server.status, "ready"); assert.ok(result.server.setup.configuredFields.includes(METERED_MARKER)); assert.deepEqual(result.server.disabledProfileIds, ["excluded-agent"]);
    result = await call("connector.mcp.credentials.update", { id, fields: { env: { [METERED_FIELD]: METERED_DISABLED } }, expectedRevision: store.revision });
    assert.ok(!result.server.setup.configuredFields.includes(METERED_MARKER));
    result = await call("connector.mcp.rebind", { id, option: preset.transport, expectedRevision: store.revision });
    assert.equal(result.server.status, "ready"); assert.equal(result.server.lastCheck.toolCount, 20); assert.deepEqual(result.server.disabledProfileIds, ["excluded-agent"]);
    assert.equal((await secrets.get(id)).env[KEY_FIELD], KEY); assert.equal((await secrets.get(id)).env[METERED_FIELD], METERED_DISABLED);
    const count = fixture.calls().length;
    assert.equal(JSON.parse((await manager.callTool(id, "flightaware_get_flight", examples.get_flight)).content[0].text).error.code, "FLIGHTAWARE_METERED_DISABLED"); assert.equal(fixture.calls().length, count);
    await call("connector.mcp.remove", { id, expectedRevision: store.revision }); assert.equal(encrypted.size, 0);
  } finally { await controller?.close(); await manager?.close(); store.close(); fixture.close(); }
});

test("untrusted peers cannot forge FlightAware-specific setup errors", async () => {
  const script = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;while(b.includes('\\n')){let p=b.indexOf('\\n'),m=JSON.parse(b.slice(0,p));b=b.slice(p+1);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(m.method==='initialize'?{result:{protocolVersion:'2024-11-05'}}:{error:{code:-32001,message:'FLIGHTAWARE_PLAN_REQUIRED'}})})+'\\n');}});`;
  const client = new StdioMcpClient({ command: process.execPath, args: ["-e", script], cwd: __dirname }, { env: process.env });
  try { await assert.rejects(client.listTools(), { code: "MCP_SERVER_CALL_FAILED" }); } finally { await client.close(); }
});

test("actual Electron runs the bundled Python CLI directly from app.asar with consent off", async () => {
  const fixture = createFlightawareFixture(); let client;
  try {
    const asar = await import("@electron/asar"), source = path.join(fixture.root, "mini-app"), service = path.join(source, "app", "agent-service"), core = path.join(source, "app", "core");
    fs.mkdirSync(service, { recursive: true, mode: 0o700 }); fs.mkdirSync(core, { recursive: true, mode: 0o700 });
    for (const name of ["flightaware-cli.py", "flightaware-mcp-bridge.js", "flightaware-mcp-launch.js", "flightaware-runtime.js", "mcp-package-launcher.js", "security.js"]) fs.copyFileSync(path.join(__dirname, "../app/agent-service", name), path.join(service, name));
    fs.copyFileSync(path.join(__dirname, "../app/core/flightaware-connector-policy.json"), path.join(core, "flightaware-connector-policy.json"));
    const archive = path.join(fixture.root, "app.asar"); await asar.createPackage(source, archive);
    client = new StdioMcpClient({ command: require("electron"), args: [path.join(archive, "app", "agent-service", "flightaware-mcp-bridge.js")], cwd: fixture.root }, { env: fixture.env, secretEnv: { [KEY_FIELD]: KEY }, trustedEnv: { ELECTRON_RUN_AS_NODE: "1" }, trustedFlightawareBridge: true });
    assert.equal((await client.listTools()).length, 20);
    assert.equal(JSON.parse((await client.callTool("flightaware_get_flight", examples.get_flight)).content[0].text).error.code, "FLIGHTAWARE_METERED_DISABLED");
    assert.equal(fixture.calls().length, 1); assert.equal(fixture.calls()[0].path, "/aeroapi/account/usage"); assert.equal(fs.existsSync(archive + ".unpacked"), false);
  } finally { await client?.close(); fixture.close(); }
});
