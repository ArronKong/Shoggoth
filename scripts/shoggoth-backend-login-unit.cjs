"use strict";

// Settings sign-in through the Service (flow "browser"): the backend maps the
// runtime.account.login.* RPCs onto the OAuth modal's start/poll/cancel shape.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const {
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID: AGY,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID: CODEX,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID: GROK,
  NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID: OPENCODE,
} = require("../app/agent-service/runtime-account");

const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake";
const OPENAI = "https://auth.openai.com/oauth/authorize?client_id=fake";

function fixture(options = {}) {
  const calls = [];
  const state = { login: null };
  const responses = {
    "runtime.account.login.start": ({ runtimeAccountId }) => (runtimeAccountId === AGY
      ? { requestId: "agy-1", mode: "browser", status: "waiting", loginId: "agy-1", authUrl: null }
      : { requestId: "codex-1", mode: "browser", status: "waiting", loginId: "codex-1", authUrl: OPENAI }),
    "runtime.account.login.read": () => ({ login: state.login }),
    "runtime.account.login.cancel": ({ requestId }) => ({ requestId, status: "canceled" }),
    "runtime.account.login.options": () => ({ providers: [{ id: "deepseek", name: "DeepSeek", connected: false,
      methods: [{ index: 0, type: "api", label: "API Key", prompts: [] }] }] }),
    "runtime.account.login.provider.start": () => ({ requestId: "oc-1", mode: "browser", status: "waiting",
      loginId: "oc-1", authUrl: "https://github.com/login/device" }),
    "runtime.account.login.submit": ({ requestId }) => ({ requestId, status: state.submitStatus || "succeeded" }),
    "runtime.account.login.apikey": () => ({ saved: true }),
    "profile.auth.read": () => ({ status: "unauthenticated" }),
  };
  const backend = new ShoggothBackend({
    runtimeCliAuth: options.runtimeCliAuth,
    readToken: () => "token",
    requestService: async (_paths, request, options) => {
      calls.push({ method: request.method, params: request.params, timeoutMs: options.timeoutMs });
      return responses[request.method](request.params);
    },
  });
  const login = (patch) => {
    state.login = { requestId: "agy-1", mode: "browser", status: "waiting", updatedAt: 1, errorCode: null,
      authUrl: null, stage: "starting", browserOpened: true, instructions: null, codeRequired: false, ...patch };
  };
  return { backend, calls, login, state };
}

test("an Antigravity sign-in starts without a URL and reports the server's page while it waits", async () => {
  const f = fixture();
  assert.deepEqual(await f.backend.startOAuthLogin(AGY), {
    sessionId: "agy-1", flow: "browser", expiresIn: 900, authUrl: null,
    verificationUrl: null, userCode: null, profile: "default",
  });
  assert.deepEqual(f.calls[0], { method: "runtime.account.login.start",
    params: { runtimeAccountId: AGY, mode: "browser" }, timeoutMs: 30_000 });
  f.login({ stage: "installing" });
  assert.deepEqual(await f.backend.pollOAuthSession(AGY, "agy-1"),
    { status: "pending", errorMessage: "", authUrl: null, stage: "installing", browserOpened: true,
      instructions: null, codeRequired: false });
  f.login({ stage: "waiting", authUrl: GOOGLE });
  assert.equal((await f.backend.pollOAuthSession(AGY, "agy-1")).authUrl, GOOGLE);
  f.login({ status: "succeeded", stage: null, authUrl: GOOGLE });
  assert.equal((await f.backend.pollOAuthSession(AGY, "agy-1")).status, "approved");
  assert.equal((await f.backend.pollOAuthSession(AGY, "agy-1")).status, "expired", "a finished session is gone");
});

test("a failed sign-in explains itself in plain words", async () => {
  const f = fixture();
  await f.backend.startOAuthLogin(AGY);
  f.login({ status: "failed", stage: null, errorCode: "ANTIGRAVITY_ACP_DOWNLOAD_FAILED" });
  const failed = await f.backend.pollOAuthSession(AGY, "agy-1");
  assert.equal(failed.status, "error");
  assert.match(failed.errorMessage, /下载 Antigravity 官方服务端失败/u);
});

test("Codex returns its page at start; the app opens it", async () => {
  const f = fixture();
  assert.equal((await f.backend.startOAuthLogin(CODEX)).authUrl, OPENAI);
});

test("cancel stops the Service sign-in of that session only", async () => {
  const f = fixture();
  assert.deepEqual(await f.backend.cancelOAuthSession("unknown"), { ok: false });
  assert.equal(f.calls.length, 0, "an unknown session is not sent to the Service");
  await f.backend.startOAuthLogin(AGY);
  assert.deepEqual(await f.backend.cancelOAuthSession("agy-1"), { ok: true });
  assert.deepEqual(f.calls.at(-1), { method: "runtime.account.login.cancel",
    params: { runtimeAccountId: AGY, requestId: "agy-1" }, timeoutMs: 20_000 });
  assert.equal((await f.backend.pollOAuthSession(AGY, "agy-1")).status, "expired");
});

test("a runtime without Service sign-in is refused before any RPC", async () => {
  const f = fixture();
  await assert.rejects(f.backend.startOAuthLogin(GROK), { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.backend.pollOAuthSession(GROK, "agy-1")).status, "expired",
    "a session is only readable through the account that started it");
});

test("a malformed Service sign-in state is rejected", async () => {
  const f = fixture();
  await f.backend.startOAuthLogin(AGY);
  f.state.login = { requestId: "agy-1", mode: "browser", status: "waiting" };
  await assert.rejects(f.backend.pollOAuthSession(AGY, "agy-1"));
});

test("OpenCode lists providers, signs into the chosen one and saves API keys", async () => {
  const f = fixture();
  assert.deepEqual((await f.backend.listOAuthLoginOptions(OPENCODE)).providers.map((provider) => provider.id), ["deepseek"]);
  const target = { providerId: "github-copilot", method: 0, inputs: { deploymentType: "github.com" } };
  assert.deepEqual(await f.backend.startOAuthLogin(OPENCODE, undefined, target), {
    sessionId: "oc-1", flow: "browser", expiresIn: 900, authUrl: "https://github.com/login/device",
    verificationUrl: null, userCode: null, profile: "default",
  });
  assert.deepEqual(f.calls.at(-1).params, { runtimeAccountId: OPENCODE, ...target });
  assert.deepEqual(await f.backend.submitOAuthCode(OPENCODE, "oc-1", "abc123"), { ok: true, status: "approved", message: "" });
  assert.deepEqual(f.calls.at(-1), { method: "runtime.account.login.submit",
    params: { runtimeAccountId: OPENCODE, requestId: "oc-1", code: "abc123" }, timeoutMs: 60_000 });
  assert.deepEqual(await f.backend.saveOAuthApiKey(OPENCODE, { providerId: "deepseek", method: 0, inputs: {} }, "sk-test"), { ok: true });
  assert.deepEqual(f.calls.at(-1).params, { runtimeAccountId: OPENCODE, providerId: "deepseek", key: "sk-test", inputs: {} });
});

test("a rejected code keeps the session and reads as a failed sign-in", async () => {
  const f = fixture();
  await f.backend.startOAuthLogin(OPENCODE, undefined, { providerId: "poe", method: 0, inputs: {} });
  f.state.submitStatus = "failed";
  const result = await f.backend.submitOAuthCode(OPENCODE, "oc-1", "wrong");
  assert.equal(result.ok, false);
  assert.match(result.message, /登录没有完成/u);
  assert.deepEqual(await f.backend.submitOAuthCode(OPENCODE, "unknown", "x"),
    { ok: false, status: "expired", message: "登录请求已结束，请重新登录" });
});

test("provider choices exist only for a runtime that signs into providers", async () => {
  const f = fixture();
  await assert.rejects(f.backend.listOAuthLoginOptions(AGY), { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
  await assert.rejects(f.backend.saveOAuthApiKey(CODEX, { providerId: "x", method: 0, inputs: {} }, "k"),
    { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
  assert.equal(f.calls.length, 0);
});

test("Settings offers each default runtime its own sign-in, and a switch for a native CLI", async () => {
  const runtimes = [[CODEX, "codex", "/opt/codex"], [AGY, "antigravity", null],
    [OPENCODE, "opencode", "/opt/opencode"], [GROK, "grok-build", "/opt/grok"]];
  const f = fixture({ runtimeCliAuth: runtimes.map(([runtimeAccountId, runtime, binaryPath]) => ({
    runtime, name: runtime, runtimeAccountId, binaryPath, ...(binaryPath ? {} : { unavailableReason: "not installed" }),
    accountHome: `/tmp/${runtime}`, processHome: "/tmp", homeEnv: null, accountKind: "native-user",
    credentialFile: null, credentialProbe: "runtime", loginArgs: ["login"], logoutArgs: ["logout"],
    docsUrl: "https://example.test/",
  })) });
  for (const [runtimeAccountId, runtime] of runtimes) {
    f.backend._profilesByAgent.set(runtime, { id: `profile-${runtime}`, name: runtime, runtime, runtimeAccountId, isDefault: true });
  }
  f.backend.setDisabledBackendsProvider(() => ["grok-build"]);
  const { providers } = await f.backend.listOAuthProviders();
  assert.deepEqual(Object.fromEntries(providers.map((provider) => [provider.id, [provider.flow, provider.connection ?? null]])), {
    [CODEX]: ["browser", { id: "codex", enabled: true }],
    [AGY]: ["browser", null],
    [OPENCODE]: ["providers", { id: "opencode", enabled: true }],
    [GROK]: ["external", { id: "grok-build", enabled: false }],
  });
  assert.deepEqual(f.calls.map((call) => call.params.profileId).sort(), ["profile-codex", "profile-opencode"],
    "a switched-off CLI is not probed");
});
