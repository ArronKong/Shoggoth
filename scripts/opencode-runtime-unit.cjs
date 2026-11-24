#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { OpenCodeHttpClient } = require("../app/agent-service/opencode-http-client");
const { OpenCodeRuntimeLedger } = require("../app/agent-service/opencode-runtime-ledger");
const { OpenCodeRuntimeHost, answersShoggothToolPrompts, commandEnvironment, modelRef,
  usageFromTokens, nativePermissionRules, preparePrivateOpenCodeConfig,
  discoverOpenCodeProviderModels } = require("../app/agent-service/opencode-runtime-host");
const { parseOpenCodeVersion, normalizeOpenCodeWorkspace } = require("../app/agent-service/opencode-runtime-paths");
const { attachmentPrompt } = require("../app/agent-service/chat-attachments");

test("OpenCode versions are diagnostic metadata and workspace identity stays strict", () => {
  assert.deepEqual(parseOpenCodeVersion("1.18.31"), [1, 18, 31]);
  assert.deepEqual(parseOpenCodeVersion("2.0.0"), [2, 0, 0]);
  assert.equal(parseOpenCodeVersion("nightly"), null);
  assert.throws(() => normalizeOpenCodeWorkspace("/not-a-shoggoth-workspace"),
    { code: "OPENCODE_WORKSPACE_INVALID" });
  assert.equal(normalizeOpenCodeWorkspace(fs.realpathSync(os.tmpdir())), fs.realpathSync(os.tmpdir()));
});

test("private command environment keeps credentials out and enforces ask", () => {
  const runtimeEnvironment = { spawnEnv: { HOME: "/tmp/home", XDG_DATA_HOME: "/tmp/data" } };
  const env = commandEnvironment({ PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "private-key",
    OPENCODE_SERVER_PASSWORD: "untrusted-password" }, runtimeEnvironment, "/tmp/config",
  "a".repeat(64), { approvalPolicy: "on-request", sandbox: "danger-full-access" }, null);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENCODE_SERVER_PASSWORD, "a".repeat(64));
  assert.equal(env.XDG_DATA_HOME, "/tmp/data");
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/config/config");
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission, { "*": "ask" });
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).autoupdate, false);
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, "1", "the user's ~/.claude/CLAUDE.md is not Agent context");
});

test("model and usage preserve provider identity and native token totals", () => {
  assert.deepEqual(modelRef("opencode/mimo-v2.6-flash-free"),
    { providerID: "opencode", id: "mimo-v2.6-flash-free" });
  assert.throws(() => modelRef("mimo-v2.6-flash-free"), { code: "RUNTIME_MODEL_UNAVAILABLE" });
  assert.deepEqual(usageFromTokens({ input: 10, output: 5, reasoning: 2, total: 15,
    cache: { read: 3, write: 1 } }), { inputTokens: 10, outputTokens: 5,
    reasoningOutputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 1,
    totalTokens: 15 });
});

test("HTTP client refuses route escape and sends credentials only to fixed loopback", async () => {
  const password = crypto.randomBytes(32).toString("hex");
  let calls = 0;
  const client = new OpenCodeHttpClient({ url: "http://127.0.0.1:41234", password,
    fetch: async (target, options) => {
      calls += 1;
      assert.equal(target.origin, "http://127.0.0.1:41234");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization,
        `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200,
        headers: { "Content-Type": "application/json" } });
    } });
  await assert.rejects(client.request("GET", "//example.com/steal"),
    { code: "OPENCODE_HTTP_ROUTE_INVALID" });
  assert.equal(calls, 0);
  assert.deepEqual((await client.request("GET", "/global/health")).data, { ok: true });
  assert.equal(calls, 1);
});

test("OpenCode provider metadata has its own bounded HTTP budget; chat still stops at 8 MiB", async () => {
  const mib = 1024 * 1024;
  let bytes = 9 * mib, status = 200;
  const padding = Buffer.alloc(mib, 0x20);
  const client = new OpenCodeHttpClient({ url: "http://127.0.0.1:41234", password: "x".repeat(32),
    fetch: async () => {
      let remaining = bytes;
      return new Response(new ReadableStream({ pull(controller) {
        if (remaining === 0) { controller.enqueue(Buffer.from("{}")); controller.close(); return; }
        const size = Math.min(remaining, padding.length);
        controller.enqueue(padding.subarray(0, size)); remaining -= size;
      } }), { status });
    } });
  for (const route of ["/config/providers", "/provider"]) assert.deepEqual((await client.request("GET", route)).data, {});
  await assert.rejects(client.request("GET", "/session/ses_fixture/message"), { code: "OPENCODE_HTTP_RESPONSE_TOO_LARGE" });
  status = 500;
  await assert.rejects(client.request("GET", "/provider"), { code: "OPENCODE_HTTP_RESPONSE_TOO_LARGE" });
  status = 200;
  bytes = 33 * mib;
  await assert.rejects(client.request("GET", "/config/providers"), { code: "RUNTIME_MODEL_CATALOG_TOO_LARGE" });
});

test("corrupt or foreign operation ledger fails closed instead of resetting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-ledger-"));
  try {
    const options = { runtimeProfileId: "profile-a", runtimeAccountId: "account-a",
      workspaceShardId: "a".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
      trustedRoot: root };
    const first = new OpenCodeRuntimeLedger(options).open();
    assert.equal(first.snapshot().sessions.length, 0);
    const file = first.file;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.runtimeAccountId = "account-b";
    fs.writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    assert.throws(() => new OpenCodeRuntimeLedger(options).open(), { code: "OPENCODE_LEDGER_INVALID" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "danger-full-access" });

test("OpenCode old/future/nonstandard labels use the actual private protocol and effective permissions", async t => {
  for (const [version, scenario, failure] of [["1.18.31", "valid"], ["2.0.0", "valid"], ["nightly", "valid"], ["2.0.0", "no-compact"],
    ["1.18.32", "missing-route", "OPENCODE_PROTOCOL_UNSUPPORTED"],
    ["1.18.32", "no-auth", "OPENCODE_HANDSHAKE_FAILED"],
    ["1.18.32", "unsafe-permission", "OPENCODE_PERMISSION_UNSAFE"],
    ["nightly", "missing-projection", "SECRET_MODEL_PROJECTION_UNAVAILABLE"],
    ["nightly", "missing-plugin", "SECRET_MODEL_PROJECTION_UNAVAILABLE"]]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-opencode-contract-")));
    const account = "native-opencode-default-v1";
    const host = new OpenCodeRuntimeHost({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
      runtimeBinding: { runtime: "opencode", runtimeProfileId: "contract", runtimeAccountId: account },
      runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account, home: root,
        binaryPath: process.execPath, configurationMode: "native", configSourceHome: root,
        launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
      workspace: root, controlInstance: false, permissionPolicy: POLICY,
      secretGateway: { bindLocalSessions: async () => ({ baseUrl: `http://127.0.0.1:9/${"a".repeat(64)}`,
        ready: () => scenario !== "missing-projection", close() {} }) },
      spawnProcess(_binary, args, options) { return require("node:child_process").spawn(process.execPath,
        [path.join(__dirname, "fixtures/opencode-compatibility-server.cjs"), scenario, version, ...args], options); },
    });
    try {
      if (failure) await assert.rejects(host.initialize(), { code: failure });
      else {
        await host.initialize(); assert.equal(host.state, "ready"); assert.equal(host.effectivePermissionsVerified, true);
        assert.equal(host.protocolFeatures.nativeCompact, scenario !== "no-compact");
        assert.equal((await host.commandsList()).commands.length, scenario === "no-compact" ? 0 : 1);
      }
    } finally { await host.stop(); fs.rmSync(root, { force: true, recursive: true }); }
  }
});

function openCodeFixture(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const account = "native-opencode-default-v1", profile = `${prefix.replace(/[^a-z]/gu, "")}profile`;
  const ledgerOptions = { runtimeProfileId: profile, runtimeAccountId: account,
    workspaceShardId: "c".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
    trustedRoot: root };
  const host = (ledger, request, now) => {
    const instance = new OpenCodeRuntimeHost({ paths: { stateDir: path.join(root, "state"), trustedRoot: root },
      runtimeBinding: { runtime: "opencode", runtimeProfileId: profile, runtimeAccountId: account },
      runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account,
        home: root, binaryPath: "/bin/true", configurationMode: "native",
        configSourceHome: root, launchArgs: Object.freeze([]),
        spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
      workspace, permissionPolicy: POLICY, ...(now ? { now } : {}) });
    instance.ledger = ledger;
    instance.state = "ready";
    instance.client = { request };
    return instance;
  };
  return { root, workspace, ledgerOptions, host,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function completion(host, timeoutMs = 5000) {
  const events = [];
  let timer;
  const settled = new Promise((resolve, reject) => {
    host.subscribe(event => { events.push(event); if (event.type === "complete") resolve(event); });
    timer = setTimeout(() => reject(new Error("OpenCode turn did not settle")), timeoutMs);
  }).finally(() => clearTimeout(timer));
  return { events, settled };
}

test("OpenCode chat advertises the exact model's variants and sends the selected one once", async () => {
  const f = openCodeFixture("shoggoth-opencode-variants-");
  const sessionId = "ses_reasoningfixture12345", model = "fixture/nested/model";
  const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "fixture", cwd: f.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const payloads = [];
  const variants = { none: { reasoningEffort: "none" }, max: { reasoningEffort: "max" },
    high: { disabled: true, reasoningEffort: "high" }, default: {}, concise: { temperature: 0.2 },
    custom_think: { modelParams: { thinkingConfig: { thinkingBudget: 2048 } } } };
  const host = f.host(ledger, async (method, route, body) => {
    if (route === "/provider") return { data: { connected: ["fixture"], all: [{ id: "fixture",
      models: { "nested/model": { name: "Fixture", variants }, fixed: { name: "Fixed", capabilities: { reasoning: true } } } }] } };
    if (route === "/config") return { data: { model } };
    if (route.endsWith("/prompt_async")) { payloads.push(body); return { status: 204 }; }
    if (route.startsWith(`/session/${sessionId}/message?`)) {
      const message = payloads.at(-1);
      return { data: [
        { info: { id: message.messageID, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_fixture12345", sessionID: sessionId, role: "assistant", parentID: message.messageID,
          time: { completed: Date.now() }, finish: "stop" }, parts: [] },
      ] };
    }
    if (route === "/session/status") return { data: {} };
    if (route === "/permission" || route === "/question") return { data: [] };
    throw new Error(`Unexpected ${method} ${route}`);
  });
  try {
    const catalog = (await host.modelsList()).data;
    assert.deepEqual(catalog.map(row => row.capabilities.thinkingOptions), [["none", "max", "custom_think"], []]);
    const input = { sessionId, operationId: "select-variant", prompt: "fixture", cwd: f.workspace, permissionPolicy: POLICY };
    for (const thinkingLevel of ["high", "concise"]) {
      await assert.rejects(host.turnStart({ ...input, model, thinkingLevel }), { code: "RUNTIME_MODEL_SETTINGS_INVALID" });
    }
    assert.equal(payloads.length, 0, "disabled variant is rejected before native submission");
    const applied = completion(host);
    const selected = { ...input, thinkingLevel: "max" };
    await host.turnStart(selected);
    assert.equal((await applied.settled).status, "completed");
    assert.equal(payloads[0].variant, "max");
    assert.deepEqual(payloads[0].model, { providerID: "fixture", modelID: "nested/model" });
    await host.turnStart(selected);
    await assert.rejects(host.turnStart({ ...selected, thinkingLevel: "none" }), { code: "RUNTIME_OPERATION_CONFLICT" });
    assert.equal(payloads.length, 1, "a completed operation cannot replay at another effort");
    const inherited = completion(host);
    await host.turnStart({ ...input, model, operationId: "inherit-variant", thinkingLevel: null });
    assert.equal((await inherited.settled).status, "completed");
    assert.equal(Object.hasOwn(payloads[1], "variant"), false);
  } finally { host.state = "stopped"; f.cleanup(); }
});

test("managed OpenCode resumes history with verified tool rules and restores the next selected mode", async () => {
  const f = openCodeFixture("shoggoth-opencode-managed-");
  const sessionId = "ses_managedfixture12345";
  const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "managed-test", cwd: f.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let permission = nativePermissionRules(POLICY), busy = false, patches = 0;
  const native = async (method, route, body) => {
    if (method === "GET" && route === "/session/status") return { data: busy ? { [sessionId]: { type: "busy" } } : {} };
    if (route === `/session/${sessionId}`) {
      if (method === "PATCH") { permission = body.permission; patches++; }
      return { data: { id: sessionId, directory: f.workspace, permission } };
    }
    throw new Error(`Unexpected route ${method} ${route}`);
  };
  const host = f.host(ledger, native);
  try {
    host.workspaceExecutionVersion = 1;
    busy = true;
    await assert.rejects(host.sessionResume({ sessionId, cwd: f.workspace }), { code: "RUNTIME_SESSION_BUSY" });
    assert.equal(patches, 0, "running sessions keep their frozen permissions");
    busy = false;
    await host.sessionResume({ sessionId, cwd: f.workspace });
    assert.deepEqual(permission, nativePermissionRules(POLICY, 1));
    assert.equal(patches, 1);
    host.workspaceExecutionVersion = null;
    await host.sessionResume({ sessionId, cwd: f.workspace });
    assert.deepEqual(permission, nativePermissionRules(POLICY));
    assert.equal(patches, 2);
    host.workspaceExecutionVersion = 1;
    permission = [{ permission: "*", pattern: "*", action: "allow" }];
    await assert.rejects(host.sessionResume({ sessionId, cwd: f.workspace }), { code: "OPENCODE_SESSION_IDENTITY_MISMATCH" });
    assert.equal(patches, 2, "unknown native permissions remain a fail-closed identity error");
  } finally { host.state = "stopped"; f.cleanup(); }
});

test("OpenCode status distinguishes signed out, protocol incompatibility and transport failure", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-auth-contract-");
  try {
    const read = response => fixture.host(null, async () => ({ data: response })).authenticationState();
    assert.deepEqual(await read({ connected: [] }), { authenticated: false, credentialPresent: false });
    assert.deepEqual(await read({ connected: ["fixture"] }), { authenticated: true, credentialPresent: true });
    await assert.rejects(read({}), { code: "OPENCODE_PROTOCOL_UNSUPPORTED" });
    const disconnected = fixture.host(null, async () => { throw Object.assign(new Error("private"), { code: "RUNTIME_CONNECTION_LOST" }); });
    await assert.rejects(disconnected.authenticationState(), { code: "RUNTIME_CONNECTION_LOST" });
  } finally { fixture.cleanup(); }
});

test("configured providers alone supply sign-in, menu defaults and available models on modern OpenCode", async t => {
  const f = openCodeFixture("opencode-configured-providers-");
  t.after(() => f.cleanup());
  let providers = [];
  const model = "fixture/nested/model";
  const host = f.host(null, async (method, route) => {
    assert.equal(method, "GET");
    if (route === "/config/providers") return { data: { providers, default: { fixture: "nested/model" } } };
    if (route === "/config") return { data: {} };
    assert.fail(`ordinary chat requested the global catalog: ${route}`);
  });
  host.protocolFeatures = { configuredProviders: true };
  assert.deepEqual(await host.authenticationState(), { authenticated: false, credentialPresent: false });
  providers = [{ id: "fixture", name: "Fixture", models: { "nested/model": { name: "Selected model" } } }];
  assert.deepEqual(await host.authenticationState(), { authenticated: true, credentialPresent: true });
  const catalog = await host.modelsList();
  assert.deepEqual(catalog.data.map(row => [row.model, row.isDefault]), [[model, true]]);
  providers.push({ id: "x".repeat(129), models: { hidden: {} } });
  assert.deepEqual((await host.modelsList()).data.map(row => row.model), [model],
    "an unrepresentable provider ID must not hide other connected models");
  providers = [{}];
  await assert.rejects(host.authenticationState(), { code: "RUNTIME_MODEL_CATALOG_INVALID" });
});

test("custom OpenCode providers without static models discover models without loading plugins", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-discover-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const privateStandard = path.join(root, "private-standard");
  const privateManaged = path.join(root, "private-managed");
  fs.mkdirSync(path.join(source, "opencode"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataHome, "opencode"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataHome, "opencode/auth.json"),
    JSON.stringify({ openaiCompat: { type: "api", key: "auth-file-key" } }), { mode: 0o600 });
  const originalConfig = `{
    // Dynamic gateway configured without static models
    "model": "magpie/workbuddy/hy4flash-free",
    "disabled_providers": ["disabledGw"],
    "plugin": ["should-not-survive-managed"],
    "provider": {
      "magpie": {
        "name": "magpie",
        "npm": "@ai-sdk/openai-compatible",
        "options": { "apiKey": "magpie-key", "baseURL": "http://127.0.0.1:3425/v1/" }
      },
      "openaiCompat": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://127.0.0.1:8080/v1" }
      },
      "envPlaceholder": {
        "options": { "apiKey": "{env:SECRET_KEY}", "baseURL": "http://127.0.0.1:9090/v1" }
      },
      "staticOnly": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://127.0.0.1:7070/v1" },
        "models": { "pinned": { "name": "Pinned" } }
      },
      "disabledGw": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://127.0.0.1:6060/v1" }
      },
      "nonCompat": {
        "npm": "@ai-sdk/anthropic",
        "options": { "baseURL": "http://127.0.0.1:5050/v1" }
      },
      "offlineGw": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://127.0.0.1:4040/v1" }
      },
    }
  }`;
  const configFile = path.join(source, "opencode/opencode.jsonc");
  fs.writeFileSync(configFile, originalConfig, { mode: 0o600 });

  const requested = [];
  const discovered = await discoverOpenCodeProviderModels(fs, source, dataHome, {
    fetch: async (url, init) => {
      requested.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect });
      if (url === "http://127.0.0.1:3425/v1/models?format=opencode") {
        return new Response(JSON.stringify({
          models: [{
            id: "workbuddy/hy4flash-free",
            entry: {
              name: "Hy4 flash",
              limit: { context: 960000, output: 64000 },
              variants: { high: { reasoningEffort: "high" } },
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://127.0.0.1:8080/v1/models?format=opencode") {
        return new Response("unknown query param", { status: 400 });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        return new Response(JSON.stringify({
          data: [{ id: "local-qwen", context_length: 131072 }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://127.0.0.1:9090/v1/models?format=opencode") {
        return new Response(JSON.stringify({ data: [{ id: "open-model" }] }), { status: 200 });
      }
      throw new Error("connection refused");
    },
  });

  assert.deepEqual(requested.map(r => r.url).sort(), [
    "http://127.0.0.1:3425/v1/models?format=opencode",
    "http://127.0.0.1:4040/v1/models?format=opencode",
    "http://127.0.0.1:8080/v1/models",
    "http://127.0.0.1:8080/v1/models?format=opencode",
    "http://127.0.0.1:9090/v1/models?format=opencode",
  ], "static, disabled and non-openai-compatible providers must not be queried");
  assert.ok(requested.every(r => r.redirect === "error"));
  assert.equal(requested.find(r => r.url.includes(":3425")).auth, "Bearer magpie-key");
  assert.equal(requested.find(r => r.url.includes(":8080/v1/models?")).auth, "Bearer auth-file-key");
  assert.equal(requested.find(r => r.url.includes(":9090")).auth, null, "placeholder apiKey must not be sent literally");
  assert.deepEqual([...discovered.keys()].sort(), ["envPlaceholder", "magpie", "openaiCompat"]);
  assert.deepEqual(discovered.get("magpie")["workbuddy/hy4flash-free"].limit, { context: 960000, output: 64000 });
  assert.deepEqual(discovered.get("openaiCompat")["local-qwen"], { name: "local-qwen", limit: { context: 131072 } });

  preparePrivateOpenCodeConfig(fs, source, privateStandard, root, null, discovered);
  preparePrivateOpenCodeConfig(fs, source, privateManaged, root, 1, discovered);
  assert.equal(fs.readFileSync(configFile, "utf8"), originalConfig, "native config is never modified");

  const standardCopy = JSON.parse(fs.readFileSync(path.join(privateStandard, "config/opencode/opencode.jsonc"), "utf8"));
  assert.equal(standardCopy.provider.magpie.models["workbuddy/hy4flash-free"].name, "Hy4 flash");
  assert.deepEqual(standardCopy.provider.staticOnly.models, { pinned: { name: "Pinned" } });

  const managedCopy = JSON.parse(fs.readFileSync(path.join(privateManaged, "config/opencode/opencode.jsonc"), "utf8"));
  assert.equal(managedCopy.plugin, undefined, "managed config still strips plugins");
  assert.equal(managedCopy.provider.magpie.models["workbuddy/hy4flash-free"].name, "Hy4 flash");
  assert.equal(managedCopy.provider.openaiCompat.models["local-qwen"].limit.context, 131072);
});

test("pending tool arguments are published when filled and retained on completion", async (t) => {
  for (const finalStatus of ["completed", "error"]) await t.test(finalStatus, async () => {
    const fixture = openCodeFixture("shoggoth-opencode-tool-activity-");
    const sessionId = "ses_toolactivity12345";
    const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
    ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
      title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
    let userMessageId, poll = 0;
    const input = { command: "npm test", description: "验证聊天回归" };
    const host = fixture.host(ledger, async (method, route, body) => {
      if (method === "POST" && route.endsWith("/prompt_async")) {
        assert.equal(body.system, "CURRENT_OPENCODE_RUN");
        userMessageId = body.messageID; return { status: 204, data: null };
      }
      if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
        poll += 1;
        const completed = poll >= 4;
        return { data: [
          { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
          { info: { id: "msg_toolactivity12345", sessionID: sessionId, role: "assistant", parentID: userMessageId,
            ...(completed ? { time: { completed: Date.now() } } : {}) }, parts: [
            { type: "tool", id: "prt_toolactivity12345", callID: "call_toolactivity12345", tool: "bash",
              state: { status: poll === 1 ? "pending" : completed ? finalStatus : "running",
                input: poll === 1 ? {} : input,
                ...(poll >= 3 ? { title: "核对聊天工具状态" } : {}),
                ...(completed ? finalStatus === "error" ? { error: "fixture error" } : { output: "ok" } : {}) } },
          ] },
        ] };
      }
      if (route === "/permission" || route === "/question") return { data: [] };
      if (route === "/session/status") return { data: { [sessionId]: { type: poll >= 4 ? "idle" : "busy" } } };
      throw new Error(`unexpected ${method} ${route}`);
    });
    const { events, settled } = completion(host);
    try {
      await host.turnStart({ sessionId, operationId: `tool-activity-${finalStatus}`, prompt: "fixture",
        turnDeveloperInstructions: "CURRENT_OPENCODE_RUN", cwd: fixture.workspace, permissionPolicy: POLICY });
      await settled;
      const start = events.filter(event => event.type === "tool_start");
      const updates = events.filter(event => event.type === "tool_update");
      const results = events.filter(event => event.type === "tool_result");
      assert.equal(start.length, 1);
      assert.deepEqual(start[0].tool.input, {});
      assert.equal(updates.length, 2, "late native titles publish even when input stays unchanged");
      assert.deepEqual(updates[0].tool.input, input);
      assert.equal(updates[1].tool.activityTitle, "核对聊天工具状态");
      assert.equal(results.length, 1);
      assert.deepEqual(results[0].tool.input, input);
      assert.equal(results[0].tool.activityTitle, "核对聊天工具状态");
      assert.equal(results[0].tool.status, finalStatus === "error" ? "failed" : "completed");
    } finally { host.state = "stopped"; fixture.cleanup(); }
  });
});

test("the per-turn Run ID rides with the user message so the system prompt stays identical", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-run-id-");
  const sessionId = "ses_runidsystem123456";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const bodies = [];
  const host = fixture.host(ledger, async (method, route, body) => {
    if (method === "POST" && route.endsWith("/prompt_async")) { bodies.push(body); return { status: 204, data: null }; }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      const user = bodies.at(-1).messageID;
      return { data: [{ info: { id: user, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: `msg_reply${bodies.length}runid1234`, sessionID: sessionId, role: "assistant", parentID: user,
          time: { completed: Date.now() } }, parts: [{ type: "text", id: `prt_reply${bodies.length}runid12`, text: "ok" }] }] };
    }
    if (route === "/permission" || route === "/question") return { data: [] };
    if (route === "/session/status") return { data: { [sessionId]: { type: "idle" } } };
    throw new Error(`unexpected ${method} ${route}`);
  });
  try {
    for (const runId of ["run-1", "run-2"]) {
      const { settled } = completion(host);
      await host.turnStart({ sessionId, operationId: `op-${runId}`, prompt: "ask", context: "MEMORY",
        turnDeveloperInstructions: `RULES\n\nCurrent Shoggoth Run ID: ${runId}`, cwd: fixture.workspace, permissionPolicy: POLICY });
      await settled;
    }
    assert.deepEqual(bodies.map(body => body.system), ["RULES\n\nMEMORY", "RULES\n\nMEMORY"]);
    assert.deepEqual(bodies.map(body => body.parts.filter(part => part.type === "text").map(part => part.text)),
      [["ask", "Current Shoggoth Run ID: run-1"], ["ask", "Current Shoggoth Run ID: run-2"]]);
  } finally { host.state = "stopped"; fixture.cleanup(); }
});

test("native provider failures keep upstream availability distinct from limits and client errors", async (t) => {
  const privateTrace = "private-provider-error-canary";
  const unavailable = "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";
  const apiError = (statusCode, fields = {}) => ({ name: "APIError", data: {
    statusCode, message: unavailable, isRetryable: true,
    responseHeaders: { authorization: privateTrace },
    responseBody: JSON.stringify({ error: { type: "server_error", message: unavailable }, trace: privateTrace }),
    ...fields,
  } });
  const cases = [
    ...[500, 502, 503, 504, 599].map(status => [`HTTP ${status}`, apiError(status), "RUNTIME_UPSTREAM_UNAVAILABLE"]),
    ["top-level HTTP 503", { statusCode: 503, message: unavailable }, "RUNTIME_UPSTREAM_UNAVAILABLE"],
    ["quota takes precedence", apiError(503, { responseBody: "insufficient_quota" }), "RUNTIME_QUOTA_EXHAUSTED"],
    ["rate limit takes precedence", apiError(503, { message: "Rate limit exceeded" }), "RUNTIME_RATE_LIMITED"],
    ["HTTP 429", apiError(429), "RUNTIME_RATE_LIMITED"],
    ["unsupported file input", { name: "UnknownError", data: {
      message: "'file part media type application/octet-stream' functionality not supported.",
    } }, "RUNTIME_ATTACHMENT_UNSUPPORTED"],
    ...[400, 401, 403, 404, 499, 600, "503", null].map(status =>
      [`client or invalid status ${status}`, apiError(status), "OPENCODE_TURN_FAILED"]),
    ["unknown failure", { name: "UnknownError", data: { message: `Unexpected upstream error. token=${privateTrace}` } }, "OPENCODE_TURN_FAILED"],
  ];
  for (const [name, nativeError, expected] of cases) await t.test(name, async () => {
    const fixture = openCodeFixture("shoggoth-opencode-provider-error-");
    const sessionId = "ses_providererror12345";
    const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
    ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
      title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
    let userMessageId, prompts = 0;
    const host = fixture.host(ledger, async (method, route, body) => {
      if (method === "POST" && route.endsWith("/prompt_async")) {
        userMessageId = body.messageID; prompts += 1;
        return { status: 204, data: null };
      }
      if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) return { data: [
        { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_providererror12345", sessionID: sessionId, role: "assistant", parentID: userMessageId,
          time: { completed: Date.now() }, error: nativeError }, parts: [] },
      ] };
      if (method === "GET" && route === "/session/status") return { data: {} };
      if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
      throw new Error(`unexpected ${method} ${route}`);
    });
    const { events, settled } = completion(host);
    try {
      await host.turnStart({ sessionId, operationId: "provider-failure", prompt: "hi",
        cwd: fixture.workspace, permissionPolicy: POLICY });
      const terminal = await settled;
      assert.equal(terminal.status, "failed");
      assert.ok(terminal.failure?.message, "the structured provider reason reaches the terminal event");
      const read = await host.sessionRead({ sessionId, includeTurns: true });
      assert.equal(read.session.turns[0].errorCode, expected);
      const restored = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
      const restoredHost = fixture.host(restored, async () => { throw new Error("settled history must not call provider"); });
      const history = await restoredHost.sessionRead({ sessionId, includeTurns: true });
      assert.equal(history.session.turns[0].errorCode, expected);
      assert.equal(JSON.stringify({ events, history, ledger: restored.snapshot() }).includes(privateTrace), false);
      assert.equal(prompts, 1, "a provider failure never replays the user message");
    } finally {
      host.state = "stopped";
      fixture.cleanup();
    }
  });
});

test("OpenCode retains a free quota event between polls and can continue with a new turn", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-fast-quota-");
  const sessionId = "ses_fastquota12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let stream, userMessageId, prompts = 0, closed = 0;
  const encoder = new TextEncoder();
  const event = (id, status) => `data: ${JSON.stringify({ type: "session.status",
    properties: { sessionID: id, status } })}\r\n\r\n`;
  const quota = { type: "retry", action: { reason: "free_tier_limit" },
    message: "Free usage exceeded, subscribe to Go" };
  const host = fixture.host(ledger, async (method, route, body) => {
    if (method === "POST" && route.endsWith("/prompt_async")) {
      assert.ok(stream, "OpenCode can emit the failure as soon as a prompt is sent");
      userMessageId = body.messageID;
      prompts++;
      return { status: 204 };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) return { data: [
      { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
      { info: { id: `msg_fastquota12345-${prompts}`, sessionID: sessionId, role: "assistant",
        parentID: userMessageId, time: { completed: Date.now() }, ...(prompts === 2 ? { finish: "stop" } : {}) },
      parts: prompts === 2 ? [{ type: "text", id: "prt_recovered", text: "Recovered" }] : [] },
    ] };
    if (method === "GET" && route === "/session/status") return { data: {} };
    if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
    throw new Error(`unexpected ${method} ${route}`);
  });
  const password = "a".repeat(64);
  const client = new OpenCodeHttpClient({ url: "http://127.0.0.1:41234", password, fetch: async (target, options) => {
    assert.equal(target.href, "http://127.0.0.1:41234/event");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      options.signal.addEventListener("abort", () => { closed++; controller.close(); stream = null; }, { once: true });
    } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  } });
  host.client.observeEvents = client.observeEvents.bind(client);
  host.protocolFeatures = { sessionEvents: true };
  const send = operationId => host.turnStart({ sessionId, operationId, prompt: "hello",
    cwd: fixture.workspace, permissionPolicy: POLICY });
  try {
    const first = completion(host);
    void first.settled.catch(() => {});
    await send("quota");
    // History alone is already empty and idle. Wait for the matching event
    // from the accepting host before publishing this turn's terminal.
    assert.equal((await host.sessionRead({ sessionId, includeTurns: true })).session.turns[0].status, "inProgress");
    const wire = event(sessionId, quota) + event(sessionId, { type: "idle" });
    stream.enqueue(encoder.encode(wire.slice(0, 37)));
    stream.enqueue(encoder.encode(wire.slice(37)));
    const terminal = await first.settled;
    assert.deepEqual([terminal.status, terminal.errorCode, terminal.failure?.message],
      ["failed", "RUNTIME_QUOTA_EXHAUSTED", "Free usage limit reached"]);
    assert.equal(closed, 1);
    assert.equal(ledger.snapshot().sessions[0].turns[0].errorCode, "RUNTIME_QUOTA_EXHAUSTED");

    const second = completion(host);
    await send("recovered");
    assert.equal((await second.settled).status, "completed");
    assert.equal(closed, 2);

    const third = completion(host);
    await send("unrelated-quota");
    stream.enqueue(encoder.encode(event("ses_foreign12345", quota) + event(sessionId, { type: "idle" })));
    const missing = await third.settled;
    assert.deepEqual([missing.status, missing.errorCode, missing.failure?.message],
      ["failed", "OPENCODE_TURN_FAILED", "OpenCode did not return a reply."]);
    assert.equal(closed, 3);
    assert.equal(prompts, 3);
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});

test("direct and group OpenCode turns use saved files and reserve native file parts for images", async t => {
  for (const source of ["direct-chat", "group-chat"]) await t.test(source, async () => {
    const f = openCodeFixture("shoggoth-opencode-attachments-");
    const sessionId = "ses_attachmentinput12345";
    const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
    ledger.update(data => data.sessions.push({ id: sessionId, source, cwd: f.workspace,
      title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
    const attachments = [
      ["page.html", "application/octet-stream"], ["notes.md", "text/markdown"],
      ["data.json", "application/json"], ["report.pdf", "application/pdf"],
      ["archive.zip", "application/octet-stream"], ["drawing.svg", "image/svg+xml"],
      ["preview.png", "image/png"],
    ].map(([name, mimeType], index) => ({ id: `attachment-${index}`, name, mimeType,
      size: 10, path: path.join(f.workspace, name) }));
    for (const item of attachments) fs.writeFileSync(item.path, "file bytes", { mode: 0o600 });
    let submitted;
    const host = f.host(ledger, async (method, route, body) => {
      if (method === "POST" && route.endsWith("/prompt_async")) {
        submitted = body; return { status: 204, data: null };
      }
      if (route.startsWith(`/session/${sessionId}/message?`)) return { data: [
        { info: { id: submitted.messageID, sessionID: sessionId, role: "user" }, parts: submitted.parts },
        { info: { id: "msg_attachmentanswer12345", sessionID: sessionId, role: "assistant",
          parentID: submitted.messageID, time: { completed: 2 } }, parts: [{ type: "text", text: "ok" }] },
      ] };
      if (route === "/session/status") return { data: {} };
      if (["/permission", "/question"].includes(route)) return { data: [] };
      throw Error(`unexpected ${method} ${route}`);
    });
    const { settled } = completion(host);
    try {
      await host.turnStart({ sessionId, operationId: source, attachments,
        prompt: attachmentPrompt("检查附件", attachments), cwd: f.workspace, permissionPolicy: POLICY });
      assert.equal((await settled).status, "completed");
      assert.deepEqual(submitted.parts.filter(part => part.type === "file").map(part => part.mime), ["image/png"]);
      for (const item of attachments) assert.ok(submitted.parts[0].text.includes(item.path));
      assert.ok(submitted.parts.some(part => part.type === "text" && part.text.includes("BEGIN ATTACHMENT CONTENT")));
    } finally { host.state = "stopped"; f.cleanup(); }
  });
});

test("a failed file history continues in a normalized copy without rewriting or replaying the original", async t => {
 for (const scenario of ["success", "busy", "foreign-copy", "incomplete-copy", "patch-interrupted"]) await t.test(scenario, async () => {
  const f = openCodeFixture("shoggoth-opencode-attachment-recovery-");
  const sessionId = "ses_originalfiles12345", forkId = "ses_continuedfiles12345";
  const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "group-chat", cwd: f.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 2, turns: [{
      id: "opencode-turn-original", operationId: "original-operation", fingerprint: "a".repeat(64),
      messageId: "msg_originalfiles12345", acceptance: "accepted", status: "failed",
      errorCode: "OPENCODE_TURN_FAILED", assistantMessages: [], createdAt: 1, updatedAt: 2,
    }] }));
  const original = [{ info: { id: "msg_originalfiles12345", sessionID: sessionId, role: "user" }, parts: [
    { id: "prt_originaltext12345", sessionID: sessionId, messageID: "msg_originalfiles12345", type: "text",
      text: `User-provided attachment: ${JSON.stringify({ name: "page.html", path: path.join(f.workspace, "page.html") })}` },
    { id: "prt_originalfile12345", sessionID: sessionId, messageID: "msg_originalfiles12345", type: "file",
      mime: "application/octet-stream", filename: "page.html", url: "data:application/octet-stream;base64,PGh0bWw+" },
  ] }, { info: { id: "msg_originalerror12345", sessionID: sessionId, role: "assistant",
    parentID: "msg_originalfiles12345", time: { completed: 2 }, error: { name: "UnknownError", data: {
      message: "'file part media type application/octet-stream' functionality not supported.",
    } } }, parts: [] }];
  const snapshot = JSON.stringify(original);
  let fork, permission, prompts = 0, forks = 0, interruptPatch = scenario === "patch-interrupted";
  const native = async (method, route, body) => {
    if (route === "/session/status") return { data: scenario === "busy" ? { [sessionId]: { type: "busy" } } : {} };
    if (["/permission", "/question"].includes(route)) return { data: [] };
    if (method === "POST" && route === `/session/${sessionId}/fork`) {
      forks++;
      fork = structuredClone(original);
      for (const message of fork) { message.info.sessionID = forkId;
        for (const part of message.parts) part.sessionID = forkId; }
      if (scenario === "incomplete-copy") fork.pop();
      return { data: { id: forkId, directory: scenario === "foreign-copy" ? path.dirname(f.workspace) : f.workspace } };
    }
    if (method === "PATCH" && route === `/session/${forkId}`) {
      permission = body.permission; return { data: { id: forkId, directory: f.workspace, permission } };
    }
    if (method === "GET" && route === `/session/${sessionId}`) return { data: { id: sessionId, directory: f.workspace,
      permission: [{ permission: "*", pattern: "*", action: "ask" }] } };
    if (method === "GET" && route === `/session/${forkId}`) return { data: { id: forkId, directory: f.workspace, permission } };
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) return { data: structuredClone(original) };
    if (method === "GET" && route.startsWith(`/session/${forkId}/message?`)) return { data: structuredClone(fork) };
    if (method === "PATCH" && route.includes(`/session/${forkId}/message/`)) {
      const part = fork.flatMap(message => message.parts).find(item => item.id === body.id);
      assert.equal(body.type, "text");
      assert.equal(JSON.stringify(body).includes("base64"), false);
      assert.ok(body.text.includes("page.html"));
      Object.keys(part).forEach(key => delete part[key]); Object.assign(part, body);
      if (interruptPatch) { interruptPatch = false; throw Object.assign(Error("lost confirmation"), { code: "RUNTIME_CONNECTION_LOST" }); }
      return { data: structuredClone(part) };
    }
    if (method === "POST" && route === `/session/${forkId}/prompt_async`) {
      prompts++;
      assert.equal(fork.flatMap(message => message.parts).some(part => part.type === "file"), false);
      fork.push({ info: { id: body.messageID, sessionID: forkId, role: "user" }, parts: body.parts },
        { info: { id: "msg_continuedanswer12345", sessionID: forkId, role: "assistant",
          parentID: body.messageID, time: { completed: 3 } }, parts: [{ type: "text", text: "continued" }] });
      return { status: 204, data: null };
    }
    throw Error(`unexpected ${method} ${route}`);
  };
  const host = f.host(ledger, native);
  const input = { sessionId, operationId: "new-explicit-operation", prompt: "继续", cwd: f.workspace, permissionPolicy: POLICY };
  try {
    if (scenario !== "success") {
      await assert.rejects(host.turnStart(input), { code: scenario === "busy" ? "RUNTIME_SESSION_BUSY" : "RUNTIME_ATTACHMENT_RECOVERY_REQUIRED" });
      assert.equal(JSON.stringify(original), snapshot);
      assert.equal(prompts, 0, "preparation failure cannot dispatch a model request");
      assert.equal(ledger.snapshot().sessions[0].turns.length, 1, "no new execution receipt before preparation succeeds");
      if (scenario !== "patch-interrupted") return;
      assert.equal(ledger.snapshot().sessions[0].attachmentSessionId, forkId);
    }
    const { settled } = completion(host);
    await host.turnStart(input);
    assert.equal((await settled).status, "completed");
    assert.equal(prompts, 1); assert.equal(forks, 1);
    assert.equal(JSON.stringify(original), snapshot);
    assert.deepEqual(permission, [{ permission: "*", pattern: "*", action: "ask" }]);
    const stored = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
    assert.equal(stored.snapshot().sessions[0].attachmentSessionId, forkId);
    assert.equal(stored.snapshot().sessions[0].turns[0].errorCode, "OPENCODE_TURN_FAILED");
    const resumed = f.host(stored, native);
    const read = await resumed.sessionResume({ sessionId, cwd: f.workspace, permissionPolicy: POLICY });
    assert.equal(read.session.id, sessionId);
    assert.equal((await resumed.sessionRead({ sessionId, includeTurns: true })).session.turns.length, 2);
    assert.equal(prompts, 1, "resume must not replay either operation");
  } finally { host.state = "stopped"; f.cleanup(); }
 });
});

test("reconciling a pending native 503 turn retains the public upstream failure", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-upstream-recovery-");
  const sessionId = "ses_upstreamrecovery12345", messageId = "msg_upstreamrecovery12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1,
    turns: [{ id: "opencode-turn-upstream", operationId: "original-operation", messageId,
      fingerprint: "a".repeat(64), acceptance: "accepted", status: "inProgress", errorCode: null,
      assistantMessages: [], createdAt: 1, updatedAt: 1 }] }));
  const host = fixture.host(ledger, async (method, route) => {
    assert.equal(method, "GET", "reconciliation must not replay a prompt");
    assert.ok(route.startsWith(`/session/${sessionId}/message?`));
    return { data: [
      { info: { id: messageId, sessionID: sessionId, role: "user" }, parts: [] },
      { info: { id: "msg_recoveredanswer12345", sessionID: sessionId, role: "assistant", parentID: messageId,
        time: { completed: Date.now() }, error: { name: "APIError", data: { statusCode: 503,
          message: "Endpoint is unavailable", isRetryable: true } } }, parts: [] },
    ] };
  });
  try {
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_UPSTREAM_UNAVAILABLE");
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("a turn from a stopped server generation fences only its own operation", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-unknown-");
  const sessionId = "ses_12345678";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1,
    turns: [{ id: "opencode-turn-test", operationId: "original-operation",
      messageId: "msg_12345678", fingerprint: "a".repeat(64), acceptance: "accepted",
      status: "failed", errorCode: "RUNTIME_TURN_OUTCOME_UNKNOWN", assistantMessages: [],
      createdAt: 1, updatedAt: 1 }] }));
  const routes = [];
  let userMessageId = null;
  const host = fixture.host(ledger, async (method, route, body) => {
    routes.push(`${method} ${route}`);
    if (method === "POST" && route.endsWith("/prompt_async")) {
      userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: userMessageId ? [
        { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_answer12345", sessionID: sessionId, role: "assistant", parentID: userMessageId,
          time: { completed: Date.now() } }, parts: [{ type: "text", id: "prt_answer", text: "ok" }] },
      ] : [] };
    }
    if (method === "GET" && route === "/session/status") return { data: {} };
    return { data: [] };
  });
  const { settled } = completion(host);
  try {
    // The server that accepted the unknown turn is gone: reading and new
    // operations proceed, while the unresolved receipt stays in history.
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_TURN_OUTCOME_UNKNOWN");
    await host.turnStart({ sessionId, operationId: "second-operation", prompt: "continue",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal((await settled).status, "completed");
    assert.equal(routes.filter(route => route.endsWith("/prompt_async")).length, 1);
    assert.deepEqual(ledger.snapshot().sessions[0].turns.map(turn => [turn.operationId, turn.status]),
      [["original-operation", "failed"], ["second-operation", "completed"]]);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("an unconfirmed native stop fences other operations until its server stops, and its own forever", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-fence-");
  const sessionId = "ses_fencetest12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let prompts = 0, aborts = 0;
  const first = fixture.host(ledger, async (method, route) => {
    if (method === "POST" && route.endsWith("/prompt_async")) { prompts += 1; return { status: 204, data: null }; }
    if (method === "POST" && route.endsWith("/abort")) { aborts += 1; throw Object.assign(new Error("gone"), { code: "RUNTIME_CONNECTION_LOST" }); }
    if (method === "GET" && route === "/session/status") throw Object.assign(new Error("gone"), { code: "RUNTIME_CONNECTION_LOST" });
    return { data: [] };
  });
  const original = { sessionId, operationId: "unconfirmed", prompt: "work",
    cwd: fixture.workspace, permissionPolicy: POLICY };
  const { settled } = completion(first);
  try {
    await first.turnStart(original);
    const failed = await settled;
    assert.deepEqual([failed.status, failed.errorCode], ["failed", "RUNTIME_TURN_OUTCOME_UNKNOWN"]);
    assert.equal(aborts, 1);
    await assert.rejects(first.turnStart({ ...original, operationId: "other" }),
      { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
    await assert.rejects(first.sessionRead({ sessionId, includeTurns: true }),
      { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
    const observer = fixture.host(ledger, async () => ({ data: [] }));
    await assert.rejects(observer.turnStart({ ...original, operationId: "other-server-idle" }),
      { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
    observer.state = "stopped";
    assert.equal(prompts, 1, "an idle replacement server does not prove the accepting server stopped");
    await first.stop();
    const second = fixture.host(ledger, async (method, route) => {
      if (method === "POST" && route.endsWith("/prompt_async")) { prompts += 1; return { status: 204, data: null }; }
      if (method === "GET" && route === "/session/status") return { data: {} };
      return { data: [] };
    });
    try {
      await assert.rejects(second.turnStart(original), { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
      assert.equal(prompts, 1, "the unresolved operation itself is never sent again");
      await second.turnStart({ ...original, operationId: "other" });
      assert.equal(prompts, 2);
    } finally { second.state = "stopped"; }
  } finally {
    first.state = "stopped";
    fixture.cleanup();
  }
});

test("disk-full terminal writes do not keep a confirmed stopped OpenCode turn busy after recovery", async t => {
  for (const persistUnknown of [true, false]) await t.test(`unknown receipt persisted: ${persistUnknown}`, async () => {
    const f = openCodeFixture("shoggoth-opencode-disk-full-");
    const sessionId = "ses_diskfull12345";
    let diskFull = false, writes = 0;
    const fileSystem = Object.create(fs);
    fileSystem.writeSync = (...args) => {
      if (diskFull && (!persistUnknown || writes++ === 0)) throw Object.assign(Error("disk full"), { code: "ENOSPC" });
      return fs.writeSync(...args);
    };
    const ledger = new OpenCodeRuntimeLedger({ ...f.ledgerOptions, fs: fileSystem }).open();
    ledger.update(data => data.sessions.push({ id: sessionId, source: "disk-full", cwd: f.workspace,
      title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
    const messages = [];
    let prompts = 0, aborts = 0, clock = 1_000_000;
    const native = async (method, route, body) => {
      if (method === "POST" && route.endsWith("/prompt_async")) {
        prompts++;
        messages.push({ info: { id: body.messageID, sessionID: sessionId, role: "user" }, parts: [] },
          { info: { id: `msg_diskanswer${prompts}`, sessionID: sessionId, role: "assistant", parentID: body.messageID,
            ...(prompts > 1 ? { time: { completed: clock } } : {}) },
          parts: prompts > 1 ? [{ id: "prt_recovered", type: "text", text: "recovered" }] : [] });
        return { status: 204, data: null };
      }
      if (method === "POST" && route.endsWith("/abort")) { aborts++; diskFull = true; return { data: true }; }
      if (route === "/session/status") { clock += 61_000; return { data: {} }; }
      if (route.startsWith(`/session/${sessionId}/message?`)) return { data: structuredClone(messages) };
      return { data: [] };
    };
    const first = f.host(ledger, native, () => clock);
    const original = { sessionId, operationId: "disk-interrupted", prompt: "work", cwd: f.workspace, permissionPolicy: POLICY };
    const failed = completion(first);
    let second;
    try {
      await first.turnStart(original);
      assert.equal((await failed.settled).errorCode, "RUNTIME_TURN_OUTCOME_UNKNOWN");
      assert.equal(aborts, 1);
      assert.equal(ledger.snapshot().sessions[0].turns[0].status, persistUnknown ? "failed" : "inProgress");
      diskFull = false;
      // Real execution Hosts are per Run and share this workspace ledger.
      // The old server remains alive; only its exact turn has stopped.
      second = f.host(ledger, native, () => clock);
      await assert.rejects(second.turnStart(original), { code: "RUNTIME_TURN_OUTCOME_UNKNOWN" });
      const done = completion(second);
      void done.settled.catch(() => {});
      await second.turnStart({ ...original, operationId: "new-user-message", prompt: "continue" });
      assert.equal((await done.settled).status, "completed");
      assert.equal(prompts, 2, "the interrupted prompt was never replayed");
      assert.equal(aborts, 1, "a new message does not abort another server's work");
      assert.deepEqual(ledger.snapshot().sessions[0].turns.map(turn => [turn.status, turn.errorCode]),
        [["failed", "RUNTIME_TURN_OUTCOME_UNKNOWN"], ["completed", null]]);
      assert.equal(first.state, "ready", "recovery does not require restarting the Service or CLI");
    } finally { first.state = "stopped"; if (second) second.state = "stopped"; f.cleanup(); }
  });
});

test("reading from another OpenCode Host never resumes or interrupts a live turn between tool steps", async () => {
  const f = openCodeFixture("shoggoth-opencode-live-owner-");
  const sessionId = "ses_liveowner12345";
  const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "live-owner", cwd: f.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let messageId, release;
  const gate = new Promise(resolve => { release = resolve; });
  const messages = () => [
    { info: { id: messageId, sessionID: sessionId, role: "user" }, parts: [] },
    { info: { id: "msg_livestep12345", sessionID: sessionId, role: "assistant", parentID: messageId,
      time: { completed: Date.now() }, finish: "tool-calls" }, parts: [] },
  ];
  const first = f.host(ledger, async (method, route, body) => {
    if (route.endsWith("/prompt_async")) { messageId = body.messageID; return { status: 204 }; }
    if (route.startsWith(`/session/${sessionId}/message?`)) { await gate; return { data: messages() }; }
    if (route === "/session/status") return { data: { [sessionId]: { type: "busy" } } };
    return { data: [] };
  });
  const observer = f.host(ledger, async (method, route) => {
    assert.equal(method, "GET");
    assert.ok(route.startsWith(`/session/${sessionId}/message?`), "only native history is observed");
    return { data: messages() };
  });
  try {
    await first.turnStart({ sessionId, operationId: "long-running", prompt: "work", cwd: f.workspace, permissionPolicy: POLICY });
    assert.equal((await observer.sessionRead({ sessionId, includeTurns: true })).session.turns[0].status, "inProgress");
    assert.equal(observer.activeTurns.size, 0);
    await assert.rejects(observer.turnStart({ sessionId, operationId: "next", prompt: "next", cwd: f.workspace, permissionPolicy: POLICY }),
      { code: "RUNTIME_SESSION_BUSY" });
    assert.equal(first.activeTurns.size, 1);
  } finally {
    first.state = "stopped"; observer.state = "stopped"; release();
    await new Promise(resolve => setTimeout(resolve, 300));
    f.cleanup();
  }
});

test("a stopped generation with an unfinished tool step permits a new message without claiming success", async () => {
  const f = openCodeFixture("shoggoth-opencode-orphan-");
  const sessionId = "ses_orphaned12345", messageId = "msg_orphaned12345";
  const ledger = new OpenCodeRuntimeLedger(f.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "orphan", cwd: f.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1,
    turns: [{ id: "opencode-turn-orphan", operationId: "original-operation", messageId,
      fingerprint: "a".repeat(64), acceptance: "accepted", status: "inProgress", errorCode: null,
      assistantMessages: [], createdAt: 1, updatedAt: 1 }] }));
  const host = f.host(ledger, async (method, route) => {
    assert.equal(method, "GET", "reading recovery never dispatches or aborts work");
    assert.ok(route.startsWith(`/session/${sessionId}/message?`));
    return { data: [
      { info: { id: messageId, sessionID: sessionId, role: "user" }, parts: [] },
      { info: { id: "msg_orphanedstep12345", sessionID: sessionId, role: "assistant", parentID: messageId,
        time: { completed: Date.now() }, finish: "tool-calls" }, parts: [{ type: "text", text: "still working" }] },
    ] };
  });
  try {
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
    assert.equal(read.session.turns[0].errorCode, "RUNTIME_TURN_OUTCOME_UNKNOWN");
    assert.equal(host.activeTurns.size, 0, "a dead generation is not resumed in a new private server");
  } finally { host.state = "stopped"; f.cleanup(); }
});

test("a native permission reaches Shoggoth as the tool and its command, not a composed sentence", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-permission-");
  const sessionId = "ses_permission12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const state = { userMessageId: null, asked: false, replied: null };
  const host = fixture.host(ledger, async (method, route, body) => {
    if (method === "POST" && route.endsWith("/prompt_async")) { state.userMessageId = body.messageID; return { status: 204, data: null }; }
    if (method === "GET" && route === "/permission") {
      if (state.asked) return { data: [] };
      state.asked = true;
      return { data: [{ id: "per_one", sessionID: sessionId, permission: "bash", patterns: ["npm test"] }] };
    }
    if (method === "POST" && route === "/permission/per_one/reply") { state.replied = body.reply; return { data: true }; }
    if (method === "GET" && route === "/question") return { data: [] };
    if (method === "GET" && route === "/session/status") return { data: state.replied ? {} : { [sessionId]: { type: "busy" } } };
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: state.userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        ...(state.replied ? [{ info: { id: "msg_done12345", sessionID: sessionId, role: "assistant",
          parentID: state.userMessageId, time: { completed: Date.now() } },
        parts: [{ type: "text", id: "prt_done", text: "done" }] }] : []),
      ] };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
  const requests = [];
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
    requests.push(params);
    return { decision: "accept" };
  });
  const { settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "permission", prompt: "run the tests",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal((await settled).status, "completed");
    assert.equal(state.replied, "once");
    assert.deepEqual({ toolName: requests[0].toolName, toolInput: requests[0].toolInput,
      command: requests[0].command, reason: requests[0].reason },
    { toolName: "bash", toolInput: { command: "npm test" }, command: "npm test", reason: undefined });
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("Shoggoth tool prompts are answered only while no other MCP server can spell shoggoth_", () => {
  assert.equal(answersShoggothToolPrompts({ mcp: { shoggoth: {} } }), true);
  assert.equal(answersShoggothToolPrompts({ mcp: { shoggoth: {}, figma: {} } }), true);
  // `shoggoth_computer` + tool `status` would also be named shoggoth_computer_status.
  assert.equal(answersShoggothToolPrompts({ mcp: { shoggoth: {}, shoggoth_computer: {} } }), false);
  assert.equal(answersShoggothToolPrompts({ mcp: { shoggoth: {}, "Shoggoth-extra": {} } }), false);
  assert.equal(answersShoggothToolPrompts({ mcp: { figma: {} } }), false);
  assert.equal(answersShoggothToolPrompts({}), false);
});

test("Shoggoth's own tools skip the duplicate OpenCode prompt; other tools still reach the user", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-own-tools-");
  const sessionId = "ses_owntools12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const state = { userMessageId: null, asked: false, replies: {} };
  const host = fixture.host(ledger, async (method, route, body) => {
    if (method === "POST" && route.endsWith("/prompt_async")) { state.userMessageId = body.messageID; return { status: 204, data: null }; }
    if (method === "GET" && route === "/permission") {
      if (state.asked) return { data: [] };
      state.asked = true;
      return { data: [
        { id: "per_shoggoth", sessionID: sessionId, permission: "shoggoth_computer_status", patterns: ["*"] },
        { id: "per_bash", sessionID: sessionId, permission: "bash", patterns: ["rm -rf build"] },
      ] };
    }
    const reply = route.match(/^\/permission\/(per_[a-z]+)\/reply$/u);
    if (method === "POST" && reply) { state.replies[reply[1]] = body.reply; return { data: true }; }
    if (method === "GET" && route === "/question") return { data: [] };
    const done = Object.keys(state.replies).length === 2;
    if (method === "GET" && route === "/session/status") return { data: done ? {} : { [sessionId]: { type: "busy" } } };
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: state.userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        ...(done ? [{ info: { id: "msg_done12345", sessionID: sessionId, role: "assistant",
          parentID: state.userMessageId, time: { completed: Date.now() } },
        parts: [{ type: "text", id: "prt_done", text: "done" }] }] : []),
      ] };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
  host.answersShoggothToolPrompts = true;
  const asked = [];
  host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
    asked.push(params.toolName);
    return { decision: "decline" };
  });
  const { settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "own-tools", prompt: "check the computer",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal((await settled).status, "completed");
    assert.deepEqual(state.replies, { per_shoggoth: "once", per_bash: "reject" });
    assert.deepEqual(asked, ["bash"], "only the non-Shoggoth tool asks the user");
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

function stoppingClient(sessionId, statusFor, finalError) {
  const state = { userMessageId: null, aborted: false, routes: [] };
  state.request = async (method, route, body) => {
    state.routes.push(`${method} ${route}`);
    if (method === "POST" && route.endsWith("/prompt_async")) {
      state.userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "POST" && route === `/session/${sessionId}/abort`) {
      state.aborted = true;
      return { status: 200, data: true };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: state.userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_partial12345", sessionID: sessionId, role: "assistant",
          parentID: state.userMessageId, ...(state.aborted ? { time: { completed: Date.now() },
            error: finalError } : {}) }, parts: [{ type: "text", id: "prt_partial", text: "partial" }] },
      ] };
    }
    if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
    if (method === "GET" && route === "/session/status") {
      return { data: state.aborted ? {} : { [sessionId]: statusFor() } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return state;
}

test("a free-tier limit retry is stopped natively and settled as a quota failure", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-quota-");
  const sessionId = "ses_quotatest12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const client = stoppingClient(sessionId, () => ({ type: "retry", attempt: 1,
    message: "Free usage exceeded, subscribe to Go", action: { reason: "free_tier_limit" },
    next: Date.now() + 3 * 60 * 60_000 }), { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request);
  const { events, settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "quota", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["failed", "RUNTIME_QUOTA_EXHAUSTED"]);
    assert.equal(result.failure?.message, "Free usage limit reached");
    assert.equal(client.routes.filter(route => route.endsWith("/abort")).length, 1);
    const turn = ledger.snapshot().sessions[0].turns[0];
    assert.deepEqual([turn.status, turn.errorCode], ["failed", "RUNTIME_QUOTA_EXHAUSTED"]);
    assert.equal(events.some(event => event.type === "status" && event.status === "retrying"), false);
    assert.equal(JSON.stringify(events).includes("subscribe to Go"), false);
    const read = await host.sessionRead({ sessionId, includeTurns: true });
    assert.equal(read.session.turns[0].status, "failed");
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("a rate-limit retry scheduled beyond two minutes is stopped instead of held", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-farretry-");
  const sessionId = "ses_farretry12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  const client = stoppingClient(sessionId, () => ({ type: "retry", attempt: 2,
    message: "Rate limit exceeded. Please try again later.", next: Date.now() + 10 * 60_000 }),
  { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request);
  const { settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "far-retry", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["failed", "RUNTIME_RATE_LIMITED"]);
    assert.equal(client.aborted, true);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("a turn past its deadline is aborted natively and settled as interrupted with partial output", async () => {
  const fixture = openCodeFixture("shoggoth-opencode-deadline-");
  const sessionId = "ses_deadline12345";
  const ledger = new OpenCodeRuntimeLedger(fixture.ledgerOptions).open();
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: fixture.workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  let clock = 1_000_000;
  const client = stoppingClient(sessionId, () => { clock += 31 * 60_000; return { type: "busy" }; },
    { name: "MessageAbortedError", data: { message: "Aborted" } });
  const host = fixture.host(ledger, client.request, () => clock);
  host.promptTimeoutMs = 30 * 60_000; // Explicit finite policy still enforces a deadline.
  const { events, settled } = completion(host);
  try {
    await host.turnStart({ sessionId, operationId: "deadline", prompt: "work",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    const result = await settled;
    assert.deepEqual([result.status, result.errorCode], ["interrupted", "OPENCODE_TURN_TIMEOUT"]);
    const turn = ledger.snapshot().sessions[0].turns[0];
    assert.deepEqual(turn.assistantMessages, [{ id: "prt_partial", text: "partial" }]);
    assert.equal(events.filter(event => event.type === "text").length, 1);
    await host.turnStart({ sessionId, operationId: "after-timeout", prompt: "next",
      cwd: fixture.workspace, permissionPolicy: POLICY });
    assert.equal(client.routes.filter(route => route.endsWith("/prompt_async")).length, 2);
  } finally {
    host.state = "stopped";
    fixture.cleanup();
  }
});

test("provider rate limit is visible while OpenCode retries and remains safe on terminal failure", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-retry-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const account = "native-opencode-default-v1", profile = "retry-status-test";
  const policy = { approvalPolicy: "on-request", sandbox: "danger-full-access" };
  const host = new OpenCodeRuntimeHost({
    paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    runtimeBinding: { runtime: "opencode", runtimeProfileId: profile, runtimeAccountId: account },
    runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: account,
      home: root, binaryPath: "/bin/true", configurationMode: "native",
      configSourceHome: root, launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
    workspace, permissionPolicy: policy,
  });
  const ledger = new OpenCodeRuntimeLedger({ runtimeProfileId: profile, runtimeAccountId: account,
    workspaceShardId: "b".repeat(64), stateRoot: path.join(root, "state", "runtime-ledgers", "opencode"),
    trustedRoot: root }).open();
  const sessionId = "ses_retrytest12345";
  ledger.update(data => data.sessions.push({ id: sessionId, source: "test", cwd: workspace,
    title: null, archived: false, created: true, createdAt: 1, updatedAt: 1, turns: [] }));
  host.ledger = ledger;
  host.state = "ready";
  let userMessageId = null, statusReads = 0, prompts = 0;
  const privateError = "Rate limit exceeded. Request id: retry-fixture\n    at providerRequest (/Users/private/stack.js:10:2)";
  host.client = { request: async (method, route, body) => {
    if (method === "POST" && route === `/session/${sessionId}/prompt_async`) {
      prompts += 1;
      userMessageId = body.messageID;
      return { status: 204, data: null };
    }
    if (method === "GET" && route.startsWith(`/session/${sessionId}/message?`)) {
      return { data: [
        { info: { id: userMessageId, sessionID: sessionId, role: "user" }, parts: [] },
        { info: { id: "msg_assistant12345", sessionID: sessionId, role: "assistant",
          parentID: userMessageId,
          ...(statusReads >= 2 ? { time: { completed: Date.now() },
            error: { name: "APIError", data: { statusCode: 429, message: privateError } } } : {}) },
        parts: [] },
      ] };
    }
    if (method === "GET" && ["/permission", "/question"].includes(route)) return { data: [] };
    if (method === "GET" && route === "/session/status") {
      statusReads += 1;
      return { data: { [sessionId]: statusReads === 1
        ? { type: "retry", attempt: 1, message: privateError, next: Date.now() + 5000 }
        : { type: statusReads === 2 ? "busy" : "idle" } } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  } };
  const events = [];
  const completed = new Promise(resolve => host.subscribe(event => {
    events.push(event);
    if (event.type === "complete") resolve(event);
  }));
  let completionTimer;
  try {
    const started = await host.turnStart({ sessionId, operationId: "retry-operation",
      prompt: "test", cwd: workspace, permissionPolicy: policy });
    assert.equal(started.turn.status, "inProgress");
    const result = await Promise.race([completed, new Promise((_, reject) =>
      { completionTimer = setTimeout(() => reject(new Error("OpenCode retry did not settle")), 3000); })]);
    assert.equal(result.status, "failed");
    assert.deepEqual(events.filter(event => event.type === "status")
      .map(event => ({ status: event.status, reason: event.reason })), [
        { status: "retrying", reason: "RUNTIME_RATE_LIMITED" },
        { status: "running", reason: undefined },
      ]);
    assert.equal(host.sessionList().data[0].id, sessionId);
    assert.equal(ledger.snapshot().sessions[0].turns[0].errorCode, "RUNTIME_RATE_LIMITED");
    assert.equal(JSON.stringify(events).includes(privateError), false);
    assert.equal(result.failure.message, "Rate limit exceeded. Request id: retry-fixture");
    assert.equal(result.failure.httpStatus, 429);
    assert.equal(prompts, 1);
  } finally {
    clearTimeout(completionTimer);
    host.state = "stopped";
    fs.rmSync(root, { recursive: true, force: true });
  }
});
