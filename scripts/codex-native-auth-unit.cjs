#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { NativeCodexAuth, nativeChatGptTokens } = require("../app/agent-service/codex-native-auth");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { readRuntimeAuthenticationState } = require("../app/agent-service/runtime-adapter");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");
const { stableAccountRead } = require("../app/agent-service/account-auth-manager");
const { validateRuntimeAccountServiceResult } = require("../app/agent-service/runtime-account-service-protocol");

const ROOT = path.resolve(__dirname, "..");
const ACCOUNT = "shoggoth-internal-codex-default-v1";

function token(account = "fixture-account", expiresAt = Date.now() + 3_600_000) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({
    exp: Math.floor(expiresAt / 1_000), email: "fixture@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" },
  })}.ZmFrZS1zaWduYXR1cmU`;
}

function tokens(account, expiresAt) {
  return nativeChatGptTokens({ authMethod: "chatgpt", authToken: token(account, expiresAt) });
}

function writeAuth(home, accessToken) {
  const body = JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: accessToken, access_token: accessToken,
      refresh_token: "fixture-refresh-token-never-used", account_id: "fixture-account" },
    last_refresh: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, "auth.json"), body, { mode: 0o600 });
  return body;
}

async function fixture(t, { onModelRequest = null, ...options } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-auth-")));
  const nativeHome = path.join(root, ".codex");
  fs.mkdirSync(nativeHome, { mode: 0o700 });
  const routingRequests = [];
  const unexpectedRequests = [];
  const hosts = [];
  let auth;
  // 0.159.2 discovers workspace routing during account/read and token login.
  // Keep the real CLI, but serve metadata locally so synthetic JWTs never go
  // to OpenAI. Optional model replies are scripted; no OAuth endpoint exists.
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (onModelRequest && request.method === "POST" && pathname === "/v1/responses") {
      onModelRequest(request, response);
      return;
    }
    // The CLI also reads plugin metadata in the background after sign-in.
    // Leave those catalogs unavailable; they must never trigger a write.
    if (request.method === "GET" && ["/plugins/featured", "/ps/plugins/installed",
      "/ps/plugins/list", "/ps/plugins/suggested/codex"].includes(pathname)) {
      response.writeHead(404).end();
      return;
    }
    // Starting a real turn also probes optional metadata/Apps and telemetry.
    // Keep them unavailable locally; only the scripted Responses route runs.
    if (onModelRequest && ((request.method === "GET" && ["/v1/models", "/api/codex/settings/user"].includes(pathname))
      || (request.method === "POST" && ["/api/codex/ps/mcp", "/codex/analytics-events/events"].includes(pathname)))) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" || !["/wham/accounts/check", "/api/codex/accounts/check"].includes(pathname)) {
      unexpectedRequests.push(`${request.method} ${pathname}`);
      response.writeHead(404).end();
      return;
    }
    routingRequests.push(pathname);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      accounts: [{ id: "fixture-account", plan_type: "plus", workspace_backend_origin: "https://routing.example.test",
        account_routing_override: "NO_CONSTRAINT" }],
    }));
  });
  t.after(async () => {
    try {
      await Promise.all(hosts.map((host) => host.stop()));
      await auth?.close();
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.deepEqual(unexpectedRequests, [], "tests must only use declared loopback endpoints");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = `cli_auth_credentials_store="file"\nchatgpt_base_url="${baseUrl}"\n`
    + (onModelRequest ? `model="gpt-4.1"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local auth regression"\nbase_url="${baseUrl}/v1"\nwire_api="responses"\nsupports_websockets=false\nrequires_openai_auth=true\n` : "");
  // Neither the source nor managed process can find the real user's Home or
  // credentials. Scripted model replies, when enabled, stay on loopback.
  fs.writeFileSync(path.join(nativeHome, "config.toml"), config, { mode: 0o600 });
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "app"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  // Keep synthetic account traffic on loopback even with a macOS system proxy.
  const parentEnv = { HOME: root, CODEX_HOME: nativeHome, PATH: "/usr/bin:/bin",
    NO_PROXY: "127.0.0.1,localhost" };
  const binding = { runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: ACCOUNT };
  const resolver = new RuntimeAccountResolver({ paths, homedir: root, parentEnv, repoRoot: ROOT });
  const environment = resolver.resolve(binding, defaultRuntimeAccountLookup(ACCOUNT));
  fs.writeFileSync(path.join(environment.home, "config.toml"), config, { mode: 0o600 });
  auth = new NativeCodexAuth({ paths, repoRoot: ROOT, homedir: root, parentEnv,
    packageVersion: "0.8.96", ...options });
  const makeHost = async (extra = {}) => {
    const host = new CodexRuntimeHost({ repoRoot: ROOT, parentEnv, nativeAuth: auth,
      runtimeBinding: binding, runtimeEnvironment: environment, ...extra });
    hosts.push(host);
    await host.initialize();
    return host;
  };
  return { root, paths, nativeHome, home: environment.home, auth, makeHost, routingRequests };
}

test("bundled Codex reuses native file auth without copying it or opening OAuth", async (t) => {
  const f = await fixture(t);
  const source = writeAuth(f.nativeHome, token());
  const host = await f.makeHost();
  const events = [];
  host.subscribe((event) => events.push(event));
  const result = await host.accountRead();
  assert.deepEqual(result, {
    account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true,
    authSource: "native-codex",
  });
  assert.equal(fs.existsSync(path.join(f.home, "auth.json")), false);
  assert.ok(f.routingRequests.length >= 2, "native and managed CLI must discover workspace routing");
  assert.equal(fs.readFileSync(path.join(f.nativeHome, "auth.json"), "utf8"), source);
  assert.ok(!JSON.stringify([result, events]).includes(token().split(".")[0] + "."));
  const wire = { ...stableAccountRead(result), login: null };
  assert.equal(validateRuntimeAccountServiceResult("runtime.account.auth.read", wire).authSource, "native-codex");
});

test("native logout removes borrowed auth, without falling back to a cached JWT", async (t) => {
  const f = await fixture(t);
  writeAuth(f.nativeHome, token());
  const host = await f.makeHost();
  assert.equal((await host.accountRead()).authSource, "native-codex");
  fs.unlinkSync(path.join(f.nativeHome, "auth.json"));
  assert.equal((await host.accountRead()).account, null);
  assert.equal((await host.accountRead()).account, null);
});

test("Shoggoth logout persists opt-out across restarts and preserves native login", async (t) => {
  const f = await fixture(t);
  const source = writeAuth(f.nativeHome, token());
  const host = await f.makeHost();
  assert.equal((await host.accountRead()).authSource, "native-codex");
  await host.accountLogout();
  assert.equal((await host.accountRead()).account, null);
  await host.stop();
  const restarted = await f.makeHost();
  assert.equal((await restarted.accountRead()).account, null);
  assert.equal(fs.readFileSync(path.join(f.nativeHome, "auth.json"), "utf8"), source);
});

test("existing independent ChatGPT login takes precedence", async (t) => {
  const f = await fixture(t, { hostFactory() { assert.fail("native auth must not be read"); } });
  writeAuth(f.home, token());
  const host = await f.makeHost();
  const result = await host.accountRead();
  assert.equal(result.account.type, "chatgpt");
  assert.equal(result.authSource, undefined);
});

test("an API Key provider never enables native token borrowing", async (t) => {
  const f = await fixture(t, { hostFactory() { assert.fail("native auth must not be read"); } });
  const host = await f.makeHost({ prepareRuntime: async () => ({
    spawnEnv: {}, registeredSecrets: [], runtimeConfig: { provider: { kind: "openai-api-key" } },
  }) });
  assert.equal((await host.accountRead()).authSource, undefined);
  await host.accountLogout();
  assert.equal(f.auth.enabled(f.home), false);
});

test("initial source failure stays unavailable and the next check can recover native login", async (t) => {
  let fail = true;
  const f = await fixture(t, { hostFactory() {
    if (fail) throw new Error("private fixture source failure");
    return { async initialize() {}, async readNativeChatGptTokens() { return tokens(); }, async stop() {} };
  } });
  const host = await f.makeHost();
  await assert.rejects(host.accountRead(), error => error.code === "CODEX_NATIVE_AUTH_READ_FAILED"
    && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("private fixture source failure"));
  await assert.rejects(readRuntimeAuthenticationState(host, { allowDeferred: true }), {
    code: "RUNTIME_AUTH_STATUS_UNAVAILABLE", cause: { code: "CODEX_NATIVE_AUTH_READ_FAILED" },
  });
  fail = false;
  assert.equal((await host.accountRead()).authSource, "native-codex");
  assert.equal(fs.existsSync(path.join(f.home, "auth.json")), false);
});

test("a shutdown error with verified process cleanup does not poison later native auth reads", async () => {
  let starts = 0;
  const auth = new NativeCodexAuth({ hostFactory: () => ({
    cleanupIncomplete: false, child: null, rpc: null,
    async initialize() { starts += 1; },
    async readNativeChatGptTokens() { return tokens(); },
    async stop() {
      if (starts === 1) throw Object.assign(new Error("fixture RPC shutdown error"), { code: "CODEX_RUNTIME_STOP_FAILED" });
    },
  }) });
  await assert.rejects(auth.read(), { code: "CODEX_NATIVE_AUTH_READ_FAILED" });
  assert.equal(auth.cleanupIncomplete, false);
  assert.equal((await auth.read()).chatgptAccountId, "fixture-account");
  assert.equal(starts, 2);
  await auth.close();
});

test("unverified auth process cleanup blocks another process without claiming logout", async () => {
  let starts = 0;
  const auth = new NativeCodexAuth({ hostFactory: () => ({
    cleanupIncomplete: true,
    async initialize() { starts += 1; },
    async readNativeChatGptTokens() { return tokens(); },
    async stop() { throw new Error("fixture cleanup failure"); },
  }) });
  await assert.rejects(auth.read(), { code: "CODEX_RUNTIME_CLEANUP_INCOMPLETE" });
  await assert.rejects(auth.read(), { code: "CODEX_RUNTIME_CLEANUP_INCOMPLETE" });
  assert.equal(starts, 1);
  await assert.rejects(auth.close(), { code: "CODEX_RUNTIME_CLEANUP_INCOMPLETE" });
});

test("late positive process-reaping proof unlocks concurrent auth reads without starting duplicate readers", async () => {
  let starts = 0, cleanupConfirmed = false, checks = 0;
  const failedHost = {
    cleanupIncomplete: true, child: {}, rpc: null,
    async initialize() { starts += 1; }, async readNativeChatGptTokens() { return tokens(); },
    async stop() { throw new Error("initial timeout"); },
    async confirmStoppedCleanup() {
      checks += 1;
      if (!cleanupConfirmed) return false;
      this.cleanupIncomplete = false; this.child = null; return true;
    },
  };
  const auth = new NativeCodexAuth({ hostFactory: () => starts === 0 ? failedHost : {
    async initialize() { starts += 1; }, async readNativeChatGptTokens() { return tokens(); }, async stop() {},
  } });
  await assert.rejects(auth.read(), { code: "CODEX_RUNTIME_CLEANUP_INCOMPLETE" });
  await assert.rejects(auth.read(), { code: "CODEX_RUNTIME_CLEANUP_INCOMPLETE" });
  assert.equal(starts, 1);
  cleanupConfirmed = true;
  const result = await Promise.all([auth.read(), auth.read()]);
  assert.equal(result[0].chatgptAccountId, "fixture-account");
  assert.equal(starts, 2); assert.equal(checks, 2);
  await auth.close();
});

test("Codex cleanup accepts final positive reaping proof and rechecks late close without signals", async () => {
  let groupExists = true, signalCount = 0;
  const host = Object.assign(Object.create(CodexRuntimeHost.prototype), {
    cleanupIncomplete: false, child: { pid: 54321, stdin: { end() {} } }, childClose: Promise.resolve(), rpc: { async terminate() {} },
    shutdownGraceMs: 1, killGraceMs: 1, startupGeneration: 0, state: "ready", _resolveTerminated() {}, _clearSecretReferences() {},
    killProcessGroup(_pid, signal) { signalCount += 1; if (signal === "SIGTERM") throw Error("transient signal error"); groupExists = false; },
    processGroupExists() { return groupExists; },
  });
  await assert.rejects(host.stop(), { code: "CODEX_RUNTIME_STOP_FAILED" });
  assert.equal(host.cleanupIncomplete, false, "final reaping proof prevents a permanent auth latch");
  assert.equal(host.child, null);
  host.cleanupIncomplete = true; host.cleanupPid = 54321; host.childCloseObserved = false;
  assert.equal(await host.confirmStoppedCleanup(), false);
  host.childCloseObserved = true; groupExists = true;
  assert.equal(await host.confirmStoppedCleanup(), false, "a still-present or recycled process group stays fenced");
  groupExists = false;
  assert.equal(await host.confirmStoppedCleanup(), true);
  assert.equal(signalCount, 2, "confirmation never sends another signal");
});

test("transient native auth read failure preserves an active native turn and blocks new auth checks", { timeout: 60_000 }, async (t) => {
  let sourceFailure = false;
  const borrowed = tokens();
  let releaseResponse;
  let acceptRequest;
  const requestAccepted = new Promise(resolve => { acceptRequest = resolve; });
  let requestCount = 0;
  const f = await fixture(t, {
    hostFactory: () => ({
      async initialize() {
        if (sourceFailure) throw Object.assign(new Error("private source failure details"), { code: "RPC_REQUEST_TIMEOUT" });
      },
      async readNativeChatGptTokens() { return borrowed; },
      async stop() {},
    }),
    onModelRequest(request, response) {
      requestCount += 1;
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      let sequence = 0;
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type,
        sequence_number: sequence++, ...data })}\n\n`);
      const id = "native-auth-regression-response";
      event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      releaseResponse = () => {
        const item = { id: "auth-recovery-reply", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "NATIVE_AUTH_TURN_SURVIVED", annotations: [] }] };
        event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
        event("response.output_item.done", { output_index: 0, item });
        event("response.completed", { response: { id, object: "response", status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } });
        response.end();
      };
      acceptRequest();
    },
  });
  const host = await f.makeHost();
  assert.equal((await host.accountRead()).authSource, "native-codex");
  const completed = [];
  let finishTurn;
  const turnFinished = new Promise(resolve => { finishTurn = resolve; });
  host.subscribe(event => {
    if (event.type === "complete") { completed.push(event); finishTurn(event); }
  });
  const { thread } = await host.threadStart({ cwd: f.root, model: "gpt-4.1", approvalPolicy: "never", sandbox: "read-only" });
  const { turn } = await host.turnStart({ threadId: thread.id, input: [{ type: "text", text: "Local fixture reply", text_elements: [] }] });
  await requestAccepted;
  sourceFailure = true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(host.accountRead(), error => error.code === "CODEX_NATIVE_AUTH_READ_FAILED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("private source failure details"));
  }
  await assert.rejects(readRuntimeAuthenticationState(host, { allowDeferred: true }), {
    code: "RUNTIME_AUTH_STATUS_UNAVAILABLE", cause: { code: "CODEX_NATIVE_AUTH_READ_FAILED" },
  });
  assert.equal(host.nativeAccessToken, borrowed.accessToken);
  assert.equal(completed.length, 0, "auth status lookup must not terminate the active turn");
  releaseResponse();
  const terminal = await turnFinished;
  assert.equal(terminal.turnId, turn.id);
  assert.equal(terminal.status, "completed");
  assert.equal(requestCount, 1, "the original request completes without replay");
  const history = await host.threadRead({ threadId: thread.id, includeTurns: true });
  assert.equal(history.thread.turns.find(value => value.id === turn.id)?.status, "completed");
  assert.ok(JSON.stringify(history.thread).includes("NATIVE_AUTH_TURN_SURVIVED"));
  sourceFailure = false;
  assert.equal((await host.accountRead()).authSource, "native-codex");
  assert.equal(host.nativeAccessToken, borrowed.accessToken);
});

test("confirmed native credential expiry still removes borrowed auth", async (t) => {
  let now = Date.now();
  const borrowed = tokens(undefined, now + 600_000);
  const f = await fixture(t, { now: () => now, hostFactory: () => ({
    async initialize() {},
    async readNativeChatGptTokens() { return borrowed; },
    async stop() {},
  }) });
  const host = await f.makeHost();
  assert.equal((await host.accountRead()).authSource, "native-codex");
  now = borrowed.expiresAt + 1;
  assert.equal((await host.accountRead()).account, null);
  assert.equal(host.nativeAccessToken, null);
});

test("explicit logout wins over a failing borrowed auth lookup", async (t) => {
  let failLookup = false;
  let failRead;
  let enteredRead;
  const entered = new Promise(resolve => { enteredRead = resolve; });
  const pending = new Promise((resolve, reject) => { failRead = reject; });
  const borrowed = tokens();
  const f = await fixture(t, { hostFactory: () => ({
    async initialize() { if (failLookup) { enteredRead(); await pending; } },
    async readNativeChatGptTokens() { return borrowed; },
    async stop() {},
  }) });
  const host = await f.makeHost();
  assert.equal((await host.accountRead()).authSource, "native-codex");
  failLookup = true;
  const reading = host.accountRead();
  await entered;
  const logout = host.accountLogout();
  failRead(Object.assign(new Error("private source failure"), { code: "RPC_REQUEST_TIMEOUT" }));
  await Promise.all([reading, logout]);
  assert.equal(f.auth.enabled(f.home), false);
  assert.equal(host.nativeAccessToken, null);
  assert.equal((await host.accountRead()).account, null);
});

test("source read coalesces Profiles and delegates expiry refresh to Codex", async (t) => {
  const reads = [];
  let starts = 0;
  const f = await fixture(t, { hostFactory: () => ({
    async initialize() { starts += 1; },
    async readNativeChatGptTokens(refresh) {
      reads.push(refresh);
      return tokens(undefined, Date.now() + (refresh ? 3_600_000 : -1_000));
    },
    async stop() {},
  }) });
  const [a, b] = await Promise.all([f.auth.read(), f.auth.read()]);
  assert.deepEqual(a, b);
  assert.equal(starts, 1);
  assert.deepEqual(reads, [false, true]);
});

test("refresh callback keeps JWTs in memory and rejects account changes", async (t) => {
  let account = "fixture-account";
  const refreshes = [];
  const f = await fixture(t, { hostFactory: () => ({
    async initialize() {},
    async readNativeChatGptTokens(refresh) {
      refreshes.push(refresh);
      return tokens(account, Date.now() + (refresh ? 7_200_000 : 3_600_000));
    },
    async stop() {},
  }) });
  const host = await f.makeHost();
  await host.accountRead();
  const originalToken = host.nativeAccessToken;
  const refresh = host.serverRequestHandlers.get("account/chatgptAuthTokens/refresh");
  const result = await refresh({ reason: "unauthorized", previousAccountId: account });
  assert.equal(result.chatgptAccountId, account);
  assert.notEqual(result.accessToken, originalToken);
  assert.equal(host.nativeAccessToken, result.accessToken);
  assert.ok(refreshes.includes(true));
  assert.equal(fs.existsSync(path.join(f.home, "auth.json")), false);
  account = "different-account";
  await assert.rejects(refresh({ reason: "unauthorized", previousAccountId: "fixture-account" }),
    { code: "RUNTIME_AUTH_REQUIRED" });
  // A new Profile must not switch the shared RuntimeAccount while another
  // Profile still has a run under the previous account.
  await assert.rejects(f.auth.read(), { code: "RUNTIME_AUTH_REQUIRED" });
  assert.equal((await host.accountRead()).account, null);
});

test("logout fences a late source read so automatic sign-in cannot bounce back", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { hostFactory: () => ({
    async initialize() {},
    async readNativeChatGptTokens() { entered(); await wait; return tokens(); },
    async stop() {},
  }) });
  const host = await f.makeHost();
  const reading = host.accountRead();
  await ready;
  const logout = host.accountLogout();
  release();
  await Promise.all([reading, logout]);
  assert.equal((await host.accountRead()).account, null);
  assert.equal(f.auth.enabled(f.home), false);
});

test("missing/invalid JWTs and native API keys are never treated as ChatGPT login", () => {
  for (const input of [null, {}, { authMethod: "apikey", authToken: token() },
    { authMethod: "chatgpt", authToken: "bad" },
    { authMethod: "chatgpt", authToken: "a.eyJleHAiOjEyM30.b" }]) { // gitleaks:allow -- synthetic test fixture; not a usable credential
    assert.equal(nativeChatGptTokens(input), null);
  }
});
