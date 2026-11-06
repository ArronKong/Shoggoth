"use strict";

// Actual Codex binary, real config files and two local Responses routes. All
// Homes, credentials, requests and persistent threads belong to this fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID: NATIVE,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID: HARNESS } = require("../app/agent-service/runtime-account");
const { ProviderRuntimeBridge } = require("../app/agent-service/provider-runtime-bridge");
const { CodexRuntimeConfigWriter } = require("../app/agent-service/codex-runtime-config");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CODEX_APP_SERVER_ARGS, resolveCodexRuntimeLayout } = require("../app/agent-service/codex-runtime-paths");
const { codexModelProvider } = require("../app/agent-service/codex-session-provider");

test("native and Harness execute on their own model/provider; changing either never rewrites the other Home", { timeout: 90_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-isolation-native-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const store = new JsonlProductStore({ paths }).open(), hosts = [];
  const homes = { [NATIVE]: path.join(root, "native-home"), [HARNESS]: path.join(root, "harness-home") };
  const workspace = path.join(root, "workspace"), seen = [], hostedSearch = [];
  for (const dir of [...Object.values(homes), workspace]) fs.mkdirSync(dir, { mode: 0o700 });
  const searchMcp = path.join(root, "search-mcp.cjs");
  fs.writeFileSync(searchMcp, `"use strict";
const input = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "fixture-search", version: "1" } });
  if (request.method === "tools/list") return reply(request.id, { tools: [{ name: "web_search",
    description: "Synthetic local search fixture", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] });
  if (request.method === "tools/call") return reply(request.id, { content: [{ type: "text", text: "fixture search result" }], isError: false });
});
`, { mode: 0o600 });
  let failure;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        assert.equal(req.method, "POST");
        assert.ok(["/native/v1/responses", "/harness/v1/responses"].includes(req.url));
        const body = JSON.parse(Buffer.concat(chunks));
        seen.push({ route: req.url, model: body.model, auth: req.headers.authorization });
        hostedSearch.push({ route: req.url, enabled: (body.tools || []).some(tool => /^web_search(?:_|$)/u.test(tool.type)) });
        const id = `response-${seen.length}`;
        const item = { id: `message-${seen.length}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "fixture answer", annotations: [] }] };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id, status: "completed", output: [item],
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }]) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
      } catch (error) { failure = error; res.writeHead(500); res.end("fixture rejected request"); }
    });
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cliConfig = `web_search = "cached"
model = "cli-own-model"
model_provider = "native_fixture"
[features]
enable_request_compression = false
responses_websockets = false
responses_websockets_v2 = false
[model_providers.native_fixture]
name = "Native fixture"
base_url = "${base}/native/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "fixture-native-key"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;
  const cliPath = path.join(homes[NATIVE], "config.toml");
  fs.writeFileSync(cliPath, cliConfig, { mode: 0o600 });
  fs.writeFileSync(path.join(homes[HARNESS], "config.toml"), 'web_search="cached"\n[features]\nenable_request_compression=false\nresponses_websockets=false\nresponses_websockets_v2=false\n', { mode: 0o600 });
  store.putModelProvider({ id: "harness-endpoint", kind: "custom-responses", name: "Harness endpoint",
    baseUrl: `${base}/harness/v1`, model: "harness-only", models: ["harness-only"],
    credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
  const profile = store.putAgentProfile({ ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    providerRef: "harness-endpoint", defaultModel: "harness-only" });
  const native = store.addAgentRuntimeBinding(profile.id, { runtime: "codex", runtimeAccountId: NATIVE }, { operationId: "native" }).binding;
  const bundled = store.getAgentRuntimeBinding(profile.id, profile.defaultBindingId);
  const noSecret = () => { throw new Error("fixture has no credentials to decrypt"); };
  const bridge = new ProviderRuntimeBridge({ productStore: store, secretStore: { listMetadata: () => [], get: noSecret },
    configWriter: new CodexRuntimeConfigWriter({ paths }) });
  const repoRoot = path.resolve(__dirname, ".."), binary = resolveCodexRuntimeLayout({ repoRoot }).runtimePath;
  async function start(binding, nativeAccount) {
    binding = { runtime: binding.runtime, runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId };
    const accountId = binding.runtimeAccountId, home = homes[accountId];
    const host = new CodexRuntimeHost({ paths, repoRoot, runtimeBinding: binding,
      runtimeEnvironment: Object.freeze({ runtime: "codex", runtimeAccountId: accountId,
        kind: nativeAccount ? "native-user" : "shoggoth-managed", installationKind: nativeAccount ? "system" : "bundled",
        homeKind: nativeAccount ? "system-default" : "managed-shared", strategy: nativeAccount ? "native" : "managed-shared",
        home, nativeHome: nativeAccount ? home : null, integrationRoot: null,
        binaryPath: binary, launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
        spawnEnv: Object.freeze({ HOME: root, CODEX_HOME: home }), configurationMode: "overlay" }),
      cwd: workspace, parentEnv: { HOME: root, PATH: process.env.PATH, TMPDIR: root,
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" },
      prepareRuntime: async input => { const prepared = await bridge.prepareRuntime(input);
        return { ...prepared, configArgs: [...prepared.configArgs, "-c", "mcp_servers.shoggoth.enabled=false",
          ...(!nativeAccount ? ["-c", `mcp_servers.fixture_search.command=${JSON.stringify(process.execPath)}`,
            "-c", `mcp_servers.fixture_search.args=${JSON.stringify([searchMcp])}`] : [])] }; },
      packageVersion: "cli-isolation-fixture" });
    hosts.push(host);
    await host.initialize();
    const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host },
      secretGateway: { bind: async () => { throw new Error("native/custom routes must not be replaced by the OpenAI gateway"); } } });
    const handle = await adapter.acquire(binding);
    return { host, handle };
  }
  async function turn(handle, sessionId, operationId, rawHost = null) {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("native fixture turn timed out")); }, 20_000);
      const unsubscribe = handle.subscribe(event => {
        if (event.type === "complete" && event.sessionId === sessionId) {
          clearTimeout(timer); unsubscribe(); resolve(event.status);
        }
      });
    });
    if (rawHost) await rawHost.turnStart({ threadId: sessionId,
      input: [{ type: "text", text: "legacy fixture request", text_elements: [] }] });
    else await handle.turnStart({ sessionId, operationId, prompt: "fixture request", context: "", cwd: workspace,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    assert.equal(await done, "completed");
    if (failure) throw failure;
  }
  async function search(host, threadId) {
    const result = await host.mcpServerToolCall({ server: "fixture_search", threadId,
      tool: "web_search", arguments: { query: "synthetic fixture" } });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "fixture search result", "MCP search remains usable with hosted search disabled");
  }
  try {
    const cli = await start(native, true);
    await assert.rejects(() => cli.handle.sessionStart({ source: "cli-isolation", cwd: workspace,
      modelProvider: codexModelProvider(store, "harness-endpoint") }), { code: "RUNTIME_PROTOCOL_INVALID" });
    assert.equal((await cli.host.configRead({ includeLayers: false })).config.model_provider, "native_fixture");
    const models = await cli.handle.modelsList({ cursor: null, limit: 100, includeHidden: false });
    assert.ok(models.data.length > 0);
    assert.equal(models.data.some(m => m.model === "harness-only"), false);
    const cliSession = await cli.handle.sessionStart({ source: "cli-isolation", cwd: workspace,
      modelSecretScope: { profileId: profile.id, sessionId: "fixture-native" },
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    await turn(cli.handle, cliSession.session.id, "native-first");
    let harness = await start(bundled, false);
    // Recreate a thread started by the old adapter, with cached hosted search
    // inherited from its Home. Resuming it must apply the compatibility fix.
    const oldHarnessThread = await harness.host.threadStart({ cwd: workspace, model: "harness-only",
      config: { model_provider: codexModelProvider(store, "harness-endpoint").configId, web_search: "cached" },
      approvalPolicy: "never", sandbox: "read-only" });
    // Codex persists a thread only after its first accepted turn.
    await turn(harness.handle, oldHarnessThread.thread.id, "legacy-fixture", harness.host);
    assert.equal(hostedSearch.at(-1).enabled, true, "the legacy fixture reproduces the unwanted hosted tool");
    // A loaded Codex thread retains its active config. An upgraded Service
    // starts a new Runtime process, which applies resume overrides from disk.
    await harness.host.stop();
    harness = await start(bundled, false);
    const harnessSession = await harness.handle.sessionResume({ sessionId: oldHarnessThread.thread.id,
      cwd: workspace, model: "harness-only",
      modelProvider: codexModelProvider(store, "harness-endpoint"),
      modelSecretScope: { profileId: profile.id, sessionId: "fixture-harness" },
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    await turn(harness.handle, harnessSession.session.id, "harness-first");
    assert.equal(hostedSearch.at(-1).enabled, false, "third-party requests must omit the provider-hosted web_search tool");
    await search(harness.host, harnessSession.session.id);
    store.putModelProvider({ ...store.getModelProvider("harness-endpoint"), model: "harness-new", models: ["harness-new"] });
    store.putAgentProfile({ ...store.getAgentProfile(profile.id), defaultModel: "harness-new" });
    await cli.handle.sessionResume({ sessionId: cliSession.session.id, cwd: workspace,
      modelSecretScope: { profileId: profile.id, sessionId: "fixture-native" } });
    await turn(cli.handle, cliSession.session.id, "native-resumed");
    await harness.host.stop();
    const updatedHarness = await start(bundled, false);
    const updatedHarnessSession = await updatedHarness.handle.sessionStart({ source: "cli-isolation", cwd: workspace,
      model: "harness-new", modelProvider: codexModelProvider(store, "harness-endpoint"),
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    await turn(updatedHarness.handle, updatedHarnessSession.session.id, "harness-updated");
    const updatedCliConfig = cliConfig.replace('model = "cli-own-model"', 'model = "cli-new-model"');
    assert.equal(fs.readFileSync(cliPath, "utf8"), cliConfig, "a Harness edit never rewrites CLI config");
    fs.writeFileSync(cliPath, updatedCliConfig, { mode: 0o600 });
    await cli.host.stop();
    const updatedCli = await start(native, true);
    const updatedCliSession = await updatedCli.handle.sessionStart({ source: "cli-isolation", cwd: workspace,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    await turn(updatedCli.handle, updatedCliSession.session.id, "native-updated");
    await updatedHarness.handle.sessionResume({ sessionId: updatedHarnessSession.session.id, cwd: workspace,
      modelProvider: codexModelProvider(store, "harness-endpoint") });
    await turn(updatedHarness.handle, updatedHarnessSession.session.id, "harness-resumed");
    await search(updatedHarness.host, updatedHarnessSession.session.id);
    assert.deepEqual(hostedSearch.filter(entry => entry.route === "/harness/v1/responses").map(entry => entry.enabled),
      [true, false, false, false], "only the legacy seed request carries hosted search; new and resumed chats omit it");
    assert.deepEqual(hostedSearch.filter(entry => entry.route === "/native/v1/responses").map(entry => entry.enabled),
      [true, true, true], "native Codex retains the search setting from its own Home");
    assert.deepEqual(seen, [
      { route: "/native/v1/responses", model: "cli-own-model", auth: "Bearer fixture-native-key" },
      { route: "/harness/v1/responses", model: "harness-only", auth: undefined },
      { route: "/harness/v1/responses", model: "harness-only", auth: undefined },
      { route: "/native/v1/responses", model: "cli-own-model", auth: "Bearer fixture-native-key" },
      { route: "/harness/v1/responses", model: "harness-new", auth: undefined },
      { route: "/native/v1/responses", model: "cli-new-model", auth: "Bearer fixture-native-key" },
      { route: "/harness/v1/responses", model: "harness-new", auth: undefined },
    ]);
    assert.equal(fs.readFileSync(cliPath, "utf8"), updatedCliConfig, "neither route rewrites the native config");
    assert.equal(store.getAgentProfile(profile.id).providerRef, "harness-endpoint");
  } finally {
    try { await Promise.all(hosts.map(host => host.stop())); }
    finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      store.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
