#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { NativeCodexAuth, nativeChatGptTokens } = require("../app/agent-service/codex-native-auth");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
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

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-auth-"));
  const nativeHome = path.join(root, ".codex");
  fs.mkdirSync(nativeHome, { mode: 0o700 });
  // Neither the source nor managed process can find the real user's Home or
  // credentials. No test sends a model request or starts a browser login.
  fs.writeFileSync(path.join(nativeHome, "config.toml"), 'cli_auth_credentials_store="file"\n', { mode: 0o600 });
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "app"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const parentEnv = { HOME: root, CODEX_HOME: nativeHome, PATH: "/usr/bin:/bin" };
  const binding = { runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: ACCOUNT };
  const resolver = new RuntimeAccountResolver({ paths, homedir: root, parentEnv, repoRoot: ROOT });
  const environment = resolver.resolve(binding, defaultRuntimeAccountLookup(ACCOUNT));
  const auth = new NativeCodexAuth({ paths, repoRoot: ROOT, homedir: root, parentEnv,
    packageVersion: "0.8.96", ...options });
  const hosts = [];
  const makeHost = async (extra = {}) => {
    const host = new CodexRuntimeHost({ repoRoot: ROOT, parentEnv, nativeAuth: auth,
      runtimeBinding: binding, runtimeEnvironment: environment, ...extra });
    hosts.push(host);
    await host.initialize();
    return host;
  };
  t.after(async () => {
    await Promise.all(hosts.map((host) => host.stop()));
    await auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, nativeHome, home: environment.home, auth, makeHost };
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

test("source failure falls back to the independent login state", async (t) => {
  const f = await fixture(t, { hostFactory() { throw new Error("fixture source failure"); } });
  const host = await f.makeHost();
  assert.deepEqual(await host.accountRead(), { account: null, requiresOpenaiAuth: true });
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
