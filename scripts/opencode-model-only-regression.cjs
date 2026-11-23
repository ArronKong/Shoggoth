"use strict";

// Installed CLI + loopback model. Every HOME, XDG store and source config is
// disposable; this test reads no user credential or installed App data.
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { test } = require("node:test");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { OpenCodeRuntimeAdapter } = require("../app/agent-service/opencode-runtime-adapter");
const { OpenCodeRuntimePool } = require("../app/agent-service/opencode-runtime-pool");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { ModelSecretProjection } = require("../app/agent-service/model-secret-projection");
const { ModelSecretGateway } = require("../app/agent-service/model-secret-gateway");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { assertOpenCodeModelConfiguration, isolateOpenCodeModelEnvironment,
  resolveOpenCodeModelSettings } = require("../app/agent-service/opencode-model-only");

function writeLargeProviderCatalog(file) {
  const providers = {};
  for (let n = 0; n < 128; n++) {
    const id = `offline-provider-${n}`, models = {};
    for (let m = 0; m < 128; m++) {
      const model = `fixture-model-${m}`;
      models[model] = { id: model, name: `Offline catalog model ${m} for ${id}`, family: "fixture",
        attachment: true, reasoning: true, tool_call: true, temperature: true, open_weights: false,
        release_date: "2026-01-01", last_updated: "2026-01-01",
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 1, output: 2 }, limit: { context: 64000, output: 2048 } };
    }
    providers[id] = { id, name: id, npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:1",
      env: ["OFFLINE_FIXTURE_KEY"], models };
  }
  fs.writeFileSync(file, JSON.stringify(providers));
}

async function readColdOpenCodeMenu(host) {
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
  const { ShoggothBackend } = require("../app/core/shoggoth-backend");
  const { AUTH_SPECS } = require("../app/runtime-cli-auth");
  const native = new OpenCodeRuntimeAdapter({ runtimePool: { get: async () => host, stop() {}, stopAll() {} } });
  const f = await openHandoffFixture({ builtinCliProfiles: true, catalogs: { codex: ["fixture-model"] },
    prepareManager(manager) {
      const acquire = manager.acquire.bind(manager);
      manager.acquire = (binding, options) => binding.runtime === "opencode" ? native.acquire(binding, options) : acquire(binding, options);
    } });
  try {
    const spec = AUTH_SPECS.find(item => item.runtimeAccountId === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID);
    const backend = new ShoggothBackend({ paths: f.paths, runtimeCliAuth: [{ ...spec, runtime: "opencode",
      accountKind: "native-user", binaryPath: host.runtimeEnvironment.binaryPath, processHome: f.root, accountHome: f.root }] });
    backend._state = "started";
    const profile = f.service.productStore.listAgentProfiles().find(row => row.agentId === "shoggoth-opencode");
    const session = f.service.chatSessionStore.createSession({ operationId: "cold-opencode-menu",
      profileId: profile.id, workspace: f.workspace, createdAt: Date.now() });
    await backend._refreshManagedProfiles();
    return await backend.getSessionRuntimeModels(profile.agentId, `agent:${profile.agentId}:${session.sessionKey}`);
  } finally { await f.close(); }
}

test("memory settings use the selected native model's available variants and reject unavailable controls", () => {
  const model = { capabilities: { reasoning: true }, variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } } };
  assert.deepEqual(resolveOpenCodeModelSettings({ thinking: "low", fastMode: false }, model), { variant: "low" });
  assert.deepEqual(resolveOpenCodeModelSettings({ thinking: "off" }, model), { variant: "low" });
  assert.deepEqual(resolveOpenCodeModelSettings({ thinking: "low" }, { capabilities: { reasoning: false } }), {});
  for (const unavailable of [{}, { capabilities: { reasoning: true } }, { variants: { private: {} } }]) {
    assert.throws(() => resolveOpenCodeModelSettings({ thinking: "low" }, unavailable), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  }
  assert.throws(() => resolveOpenCodeModelSettings({ thinking: "low", fastMode: true }, model), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  assert.throws(() => resolveOpenCodeModelSettings({ thinking: "invalid" }, model), { code: "MODEL_ONLY_SETTINGS_INVALID" });
});

test("model worker denies all tools and refuses effective config contamination", () => {
  const env = {}; isolateOpenCodeModelEnvironment(env, "/private/tmp/fixture");
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT); assertOpenCodeModelConfiguration(config);
  for (const changed of [{ ...config, mcp: { unmanaged: {} } }, { ...config, plugin: ["untrusted"] },
    { ...config, permission: { "*": "deny", read: "allow" } }, { ...config, instructions: ["private.md"] }]) {
    assert.throws(() => assertOpenCodeModelConfiguration(changed), { code: "MODEL_ONLY_TOOLS_FORBIDDEN" });
  }
  const trusted = "file:///trusted/shoggoth-secret-projection.mjs";
  assertOpenCodeModelConfiguration({ ...config, plugin: [trusted] }, trusted);
  for (const plugin of [[], ["untrusted"], [trusted, "untrusted"], [trusted, trusted]]) {
    assert.throws(() => assertOpenCodeModelConfiguration({ ...config, plugin }, trusted), { code: "MODEL_ONLY_TOOLS_FORBIDDEN" });
  }
  const adapter = new OpenCodeRuntimeAdapter({ runtimePool: { get() {}, stop() {}, stopAll() {} } });
  assert.equal(adapter.modelOnly, true);
});

for (const scenario of ["chat", "model-only", "protected"]) test(scenario === "chat"
  ? "actual OpenCode CLI loads the cold session menu and sends a greeting with a large public catalog"
  : `actual OpenCode CLI${scenario === "protected" ? " protected model" : ""}: no tools, original account config preserved, errors and cancellation settle`, { timeout: 120_000 }, async t => {
  const protectedModel = scenario === "protected";
  const root = fs.mkdtempSync("/private/tmp/sg-opencode-model-only-");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  for (const name of ["home", "data", "state", "workspace", "config", "config/opencode"]) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  const requests = [], workers = [], sockets = new Set();
  let host, mode = "success", admitted, secrets, gateway, revokeScope = false;
  const protectionPlugin = require("node:url").pathToFileURL(path.resolve(__dirname,
    "../resources/opencode/shoggoth-secret-projection.mjs")).href;
  const marker = path.join(root, "forbidden-tool-write");
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body); admitted?.();
    if (mode === "hang") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return; }
    if (mode === "limited") {
      res.writeHead(429, { "Content-Type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached for fixture-model", type: "rate_limit_error" } })); return;
    }
    if (mode === "free-quota") {
      res.writeHead(429, { "Content-Type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ error: { message: "Free usage limit reached", code: "FreeUsageLimitError" } })); return;
    }
    if (mode === "error") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR_BODY", type: "invalid_request_error" } })); return;
    }
    const attemptedTool = mode === "tool";
    if (attemptedTool) mode = "success";
    const delta = attemptedTool ? { role: "assistant", tool_calls: [{ index: 0, id: "forbidden-call",
      type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `touch ${marker}` }) } }] }
      : { role: "assistant", content: "MODEL_ONLY_OK" };
    const chunk = (value, finish) => ({ id: "fixture-message", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk({}, attemptedTool ? "tool_calls" : "stop"),
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const model = "model-fixture/fixture-model", configFile = path.join(root, "config/opencode/opencode.json");
  try {
    if (protectedModel) {
      secrets = await new TemporarySecretStore({ paths, cryptoBroker: {
        encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse(),
      } }).open();
      const projection = new ModelSecretProjection({ secrets });
      gateway = new ModelSecretGateway({ projection: { async project(...args) {
        const result = await projection.project(...args);
        if (revokeScope) for (const worker of host.modelWorkers) worker.modelSecretScopes.clear();
        return result;
      } } });
    }
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const catalogFile = path.join(root, "public-models.json");
    if (scenario === "chat") writeLargeProviderCatalog(catalogFile);
    const config = JSON.stringify({ model, small_model: model, ...(scenario === "chat" ? {} : { enabled_providers: ["model-fixture"] }),
      provider: { "model-fixture": { npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "synthetic-model-key", baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: { "fixture-model": { name: "Fixture", reasoning: true,
          variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" },
            ...(scenario === "chat" ? { medium: { disabled: true } } : {}) },
          limit: { context: 32000, output: 2048 } } } } } });
    fs.writeFileSync(configFile, config, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "home/AGENTS.md"), "PRIVATE_HOME_RULE_CANARY");
    fs.writeFileSync(path.join(root, "workspace/AGENTS.md"), "PRIVATE_WORKSPACE_RULE_CANARY");
    const binding = { runtime: "opencode", runtimeProfileId: "model-only-fixture", runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
    const parentEnv = { PATH: process.env.PATH, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root };
    const resolver = new RuntimeAccountResolver({ paths, parentEnv, homedir: path.join(root, "home") });
    const environment = resolver.resolve(binding, DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === binding.runtimeAccountId));
    host = new OpenCodeRuntimeHost({ paths, runtimeBinding: binding, runtimeEnvironment: environment,
      parentEnv, secretGateway: gateway, workspace: path.join(root, "workspace"), permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
      spawnProcess(binary, args, options) {
        if (scenario === "chat" && args[0] === "serve") {
          options.env.OPENCODE_MODELS_PATH = catalogFile;
          options.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
        }
        if (args[0] === "serve" && options.cwd !== path.join(root, "workspace") && options.env.HOME !== environment.spawnEnv.HOME) {
          const effective = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
          assertOpenCodeModelConfiguration(effective, protectedModel ? protectionPlugin : null);
          assert.equal(options.env.XDG_DATA_HOME, environment.spawnEnv.XDG_DATA_HOME, "native account refresh store retained");
          const child = require("node:child_process").spawn(binary, args, options); workers.push({ child, cwd: options.cwd }); return child;
        }
        return require("node:child_process").spawn(binary, args, options);
      } });
    await host.initialize();
    if (scenario === "chat") {
      const full = (await host.client.request("GET", "/provider")).data;
      const bytes = Buffer.byteLength(JSON.stringify(full));
      assert.ok(bytes > 8 * 1024 * 1024, `full native provider catalog: ${bytes} bytes`);
      t.diagnostic(`Global OpenCode provider catalog contained ${bytes} bytes`);
      assert.ok((await host.providerLoginOptions()).providers.some(p => p.id === "offline-provider-0" && !p.connected));
      const routes = [];
      const request = host.client.request.bind(host.client);
      host.client.request = (method, route, ...rest) => { routes.push(route); return request(method, route, ...rest); };
      assert.equal((await host.authenticationState()).authenticated, true);
      const menu = await readColdOpenCodeMenu(host);
      const group = menu.runtimes.find(row => row.runtime === "opencode");
      assert.equal(group?.available, true, "the first menu read marks OpenCode available");
      assert.equal(group.unavailableSource, undefined);
      assert.ok(menu.models.some(row => row.runtime === "opencode" && row.id === model));
      const catalog = await host.modelsList();
      assert.deepEqual(catalog.data.find(row => row.model === model).capabilities.thinkingOptions, ["low", "high"]);
      assert.equal(catalog.data.some(row => row.model.startsWith("offline-provider-")), false);
      const { session } = await host.sessionStart({ source: "thinking-chat-fixture",
        model, cwd: path.join(root, "workspace"), permissionPolicy: host.permissionPolicy });
      await host.sessionResume({ sessionId: session.id, model, cwd: path.join(root, "workspace"), permissionPolicy: host.permissionPolicy });
      const finished = new Promise(resolve => {
        const unsubscribe = host.subscribe(event => {
          if (event.type === "complete" && event.sessionId === session.id) { unsubscribe(); resolve(event); }
        });
      });
      const prompt = "你好";
      await host.turnStart({ sessionId: session.id, operationId: "chat-effort", prompt,
        model, thinkingLevel: "high", cwd: path.join(root, "workspace"), permissionPolicy: host.permissionPolicy });
      assert.equal((await finished).status, "completed");
      const history = (await host.sessionRead({ sessionId: session.id, includeTurns: true })).session;
      assert.deepEqual(history.turns.flatMap(turn => turn.items).filter(item => item.type === "agentMessage")
        .map(item => item.text), ["MODEL_ONLY_OK"]);
      const chatRequests = requests.filter(body => body.messages?.some(message =>
        message.role === "user" && JSON.stringify(message.content).includes(prompt)));
      assert.deepEqual(chatRequests.filter(body => body.reasoning_effort === "high").map(body => body.model), ["fixture-model"],
        "the provider receives the greeting once with the selected model and variant");
      assert.equal(routes.includes("/provider"), false, "menu, authentication and chat only read configured providers");
      assert.equal(routes.filter(route => route.endsWith("/prompt_async")).length, 1, "the greeting is submitted once");
      await host.sessionDelete({ sessionId: session.id });
      return;
    }
    // Settings discovered after the ordinary host started must not leak into
    // the model worker or launch any native MCP/plugin before its deny rule.
    const contaminated = JSON.stringify({ ...JSON.parse(config),
      mcp: { forbidden: { type: "local", command: ["/usr/bin/touch", marker] } },
      plugin: ["file:///nonexistent/forbidden-model-plugin.mjs"],
      instructions: [path.join(root, "workspace/AGENTS.md")], permission: { "*": "allow" } });
    fs.writeFileSync(configFile, contaminated, { mode: 0o600 });
    const adapter = new OpenCodeRuntimeAdapter({ runtimePool: { async get() { return host; }, stop() { return host.stop(); }, stopAll() { return host.stop(); } } });
    const handle = await adapter.acquire(binding);
    assert.equal(handle.capabilities["model.generate.toolFree"], true);
    assert.equal(handle.capabilities["model.generate.settings"], true);
    const streamed = [];
    const scope = { profileId: "model-fixture", sessionId: "model-session-a" };
    const input = { prompt: protectedModel ? "password: 123456. Return MODEL_ONLY_OK" : "Return MODEL_ONLY_OK",
      model, operationId: "model-only-fixture", ...(protectedModel ? { modelSecretScope: scope } : {}) };
    const result = await handle.generateModelOnly({ ...input, onText: text => streamed.push(text) });
    assert.equal(result.text, "MODEL_ONLY_OK"); assert.equal(result.model, model); assert.equal(result.provider, "model-fixture");
    assert.deepEqual(streamed, ["MODEL_ONLY_OK"]); assert.equal(result.usage.totalTokens, 13);
    assert.equal(requests.length, 1, "no title, summary or hidden model call");
    if (protectedModel) assert.doesNotMatch(JSON.stringify(requests[0]), /123456/, "model worker must project the final native body");
    assert.deepEqual(requests[0].tools || [], []);
    assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE_HOME_RULE_CANARY|PRIVATE_WORKSPACE_RULE_CANARY/);
    assert.equal(host.modelWorkers.size, 0); assert.equal(host.ledger.snapshot().sessions.length, 0);
    assert.deepEqual((await host.client.request("GET", "/session")).data, [], "temporary native session deleted");
    const configured = await handle.generateModelOnly({ ...input, operationId: "model-settings",
      execution: { thinking: "low", fastMode: false } });
    assert.equal(configured.text, "MODEL_ONLY_OK");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].reasoning_effort, "low", "the real CLI sends the selected variant to the Provider");
    if (protectedModel) {
      const beforeFailure = requests.length;
      for (const modelSecretScope of [undefined, {}, { profileId: "model-fixture" }]) {
        await assert.rejects(handle.generateModelOnly({ ...input, modelSecretScope }), { code: "SECRET_MODEL_IDENTITY_UNAVAILABLE" });
      }
      assert.equal(requests.length, beforeFailure, "missing scope fails before the provider");
      revokeScope = true;
      await assert.rejects(handle.generateModelOnly({ ...input, operationId: "scope-revoked" }));
      revokeScope = false;
      assert.equal(requests.length, beforeFailure, "a revoked native scope fails before the provider");
      await handle.generateModelOnly({ ...input, prompt: "session-b-public: 123456", operationId: "separate-scope",
        modelSecretScope: { ...scope, sessionId: "model-session-b" } });
      assert.match(JSON.stringify(requests.at(-1)), /session-b-public: 123456/, "other sessions keep public matching text");
      assert.equal(gateway.routes.size, 1, "only the parent route remains after model workers exit");
    }
    const beforeUnsupported = requests.length;
    await assert.rejects(handle.generateModelOnly({ ...input, operationId: "model-fast-unavailable",
      execution: { thinking: "low", fastMode: true } }), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
    assert.equal(requests.length, beforeUnsupported, "unsupported settings fail before a model request");
    mode = "error";
    await assert.rejects(handle.generateModelOnly({ ...input, operationId: "model-error" }), cause => {
      assert.equal(cause.code, "OPENCODE_TURN_FAILED"); assert.doesNotMatch(cause.message, /PRIVATE_PROVIDER_ERROR_BODY/); return true;
    });
    mode = "tool";
    await assert.rejects(handle.generateModelOnly({ ...input, operationId: "model-forbidden-tool" }), { code: "MODEL_ONLY_TOOLS_FORBIDDEN" });
    assert.equal(fs.existsSync(marker), false, "a fabricated tool call cannot write through the native CLI");
    // A provider limit leaves OpenCode retrying without a reply until its
    // retry-after. The model task stops on the same rule as a chat turn.
    mode = "limited";
    const limitedAt = Date.now();
    await assert.rejects(handle.generateModelOnly({ ...input, operationId: "model-limited", timeoutMs: 60_000 }), cause => {
      assert.match(cause.code, /^RUNTIME_(?:RATE_LIMITED|QUOTA_EXHAUSTED|UPSTREAM_UNAVAILABLE)$/u, cause.code); return true;
    });
    assert.ok(Date.now() - limitedAt < 20_000, "a far-away provider retry is not held until a transport timeout");
    assert.equal(host.modelWorkers.size, 0);
    if (scenario === "model-only") {
      mode = "free-quota";
      await assert.rejects(handle.generateModelOnly({ ...input, operationId: "summary-free-quota", timeoutMs: 60_000 }), cause => {
        assert.equal(require("../app/agent-service/product-context-protocol").compactionErrorCode(cause),
          "PRODUCT_COMPACTION_QUOTA_EXHAUSTED", cause.code);
        return true;
      });
    }
    mode = "hang";
    const controller = new AbortController(), started = new Promise(resolve => { admitted = resolve; });
    const pending = handle.generateModelOnly({ ...input, operationId: "model-cancel", signal: controller.signal });
    await started; controller.abort(); await assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" }); admitted = null;
    assert.equal(host.modelWorkers.size, 0);
    assert.ok(workers.every(({ child }) => child.exitCode !== null || child.signalCode !== null), "every dedicated process has exited");
    assert.ok(workers.every(({ cwd }) => !fs.existsSync(cwd)), "private configuration and scratch directories removed");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(configFile, "utf8"), contaminated);
    assert.deepEqual((await host.client.request("GET", "/session")).data, []);
    const pool = new OpenCodeRuntimePool({ paths, runtimeAccountResolver: resolver,
      runtimeAccountLookup: () => DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === binding.runtimeAccountId), parentEnv, secretGateway: gateway,
      mcpGateIssuer: { reserveMcpServer() { throw new Error("Model-only acquisition must never start a managed MCP server"); } } });
    try {
      const developerInstructions = "MODEL_TASK_PROTOCOL_CANARY: Return exactly the JSON response requested by the host.";
      const modelOptions = { workspace: path.join(root, "workspace"), modelOnly: true,
        permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
        executionContract: { runId: "model-pool-fixture", developerInstructions } };
      for (const invalid of [42, "\0", "\ud800", "x".repeat(1024 * 1024 + 1)]) {
        await assert.rejects(pool.get(binding, { ...modelOptions,
          executionContract: { ...modelOptions.executionContract, developerInstructions: invalid } }),
        { code: "RUNTIME_EXECUTION_CONTRACT_INVALID" });
      }
      assert.equal(pool.entries.size, 0, "invalid instructions cannot start a native host");
      const isolated = await pool.get(binding, modelOptions);
      await assert.rejects(pool.get(binding, { ...modelOptions,
        executionContract: { ...modelOptions.executionContract, developerInstructions: "DIFFERENT_PROTOCOL" } }),
      { code: "RUNTIME_PERMISSION_POLICY_CONFLICT" });
      assert.equal(isolated.modelOnlyInstance, true); assert.equal(isolated.ledger, null);
      mode = "success";
      assert.equal((await isolated.generateModelOnly({ ...input, operationId: "model-pool-fixture" })).text, "MODEL_ONLY_OK");
      assert(requests.at(-1).messages.some(message => message.role === "system"
        && message.content.includes(developerInstructions)), "the actual Provider must receive the model task's host protocol as system instructions");
      assert(!requests.at(-1).messages.some(message => message.role === "user"
        && message.content.includes(developerInstructions)), "host instructions must not be demoted to task data");
      assert.equal(fs.existsSync(marker), false);
    } finally { await pool.stopAll(); }
    assert.ok(requests.every(request => !request.tools?.length));
    if (protectedModel) {
      assert(requests.every(request => !JSON.stringify(request).includes("123456")
        || JSON.stringify(request).includes("session-b-public: 123456")));
      await host.stop(); assert.equal(gateway.routes.size, 0);
    }
  } finally {
    await host?.stop(); await gateway?.close(); await secrets?.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
