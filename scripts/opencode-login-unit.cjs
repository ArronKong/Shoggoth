"use strict";

// Settings sign-in into OpenCode's model providers: the host's provider auth
// calls and the Service login manager around them.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { OpenCodeLoginManager } = require("../app/agent-service/opencode-login-manager");
const { OpenCodeRuntimeAdapter } = require("../app/agent-service/opencode-runtime-adapter");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { validateRuntimeAccountServiceResult } = require("../app/agent-service/runtime-account-service-protocol");

const ACCOUNT = "native-opencode-default-v1";

function host(t, respond) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-opencode-login-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = new OpenCodeRuntimeHost({
    paths: { stateDir: path.join(root, "state"), trustedRoot: root },
    runtimeBinding: { runtime: "opencode", runtimeProfileId: "login-test", runtimeAccountId: ACCOUNT },
    runtimeEnvironment: Object.freeze({ runtime: "opencode", runtimeAccountId: ACCOUNT,
      home: root, binaryPath: "/bin/true", configurationMode: "native", configSourceHome: root,
      launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }) }),
    workspace: root, permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" },
  });
  const requests = [];
  value.state = "ready";
  value.client = { request: async (method, route, body, options) => {
    requests.push({ method, route, body, options });
    return { data: await respond(method, route, body, options) };
  } };
  return { host: value, requests };
}

test("the provider list merges OpenCode's catalog with its sign-in methods", async (t) => {
  const { host: opencode } = host(t, (method, route) => {
    if (route === "/provider") return { connected: ["openai"], all: [
      { id: "openai", name: "OpenAI" }, { id: "deepseek", name: "DeepSeek" }, { id: "github-copilot", name: "GitHub Copilot" },
      { id: "bad id!", name: "dropped" },
    ] };
    if (route === "/provider/auth") return {
      openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "api", label: "Manually enter API Key" }],
      "github-copilot": [{ type: "oauth", label: "Login with GitHub Copilot", prompts: [
        { type: "select", key: "deploymentType", message: "Select GitHub deployment type",
          options: [{ label: "GitHub.com", value: "github.com", hint: "Public" }, { label: "GitHub Enterprise", value: "enterprise" }] },
        { type: "text", key: "enterpriseUrl", message: "Enter your GitHub Enterprise URL", placeholder: "company.ghe.com",
          when: { key: "deploymentType", op: "eq", value: "enterprise" } },
        { type: "text", key: "bad key", message: "dropped" },
      ] }],
    };
    throw new Error(`unexpected ${method} ${route}`);
  });
  const options = validateRuntimeAccountServiceResult("runtime.account.login.options", await opencode.providerLoginOptions());
  assert.deepEqual(options.providers.map((provider) => [provider.id, provider.connected, provider.methods.map((m) => `${m.index}:${m.type}`)]), [
    ["openai", true, ["0:oauth", "1:api"]],
    ["deepseek", false, ["0:api"]],
    ["github-copilot", false, ["0:oauth"]],
  ], "a provider without its own methods signs in with an API key; invalid ids are dropped");
  assert.deepEqual(options.providers[2].methods[0].prompts, [
    { type: "select", key: "deploymentType", message: "Select GitHub deployment type", placeholder: null, when: null,
      options: [{ label: "GitHub.com", value: "github.com", hint: "Public" }, { label: "GitHub Enterprise", value: "enterprise", hint: null }] },
    { type: "text", key: "enterpriseUrl", message: "Enter your GitHub Enterprise URL", placeholder: "company.ghe.com", options: [],
      when: { key: "deploymentType", op: "eq", value: "enterprise" } },
  ]);
});

test("OAuth goes through OpenCode's authorize and callback; API keys are saved with their inputs", async (t) => {
  const { host: opencode, requests } = host(t, (method, route) => {
    if (route.endsWith("/oauth/authorize")) return { url: "https://github.com/login/device", method: "auto", instructions: "Enter code: ABCD-1234" };
    if (route.endsWith("/oauth/callback")) return true;
    if (route.startsWith("/auth/")) return true;
    throw new Error(`unexpected ${method} ${route}`);
  });
  assert.deepEqual(await opencode.providerLoginAuthorize({ providerId: "github-copilot", method: 0, inputs: { deploymentType: "github.com" } }),
    { url: "https://github.com/login/device", mode: "auto", instructions: "Enter code: ABCD-1234" });
  const controller = new AbortController();
  assert.equal(await opencode.providerLoginCallback({ providerId: "github-copilot", method: 0, signal: controller.signal }), true);
  assert.equal(await opencode.providerLoginApiKey({ providerId: "azure", key: "sk-test", metadata: { resourceName: "models" } }), true);
  assert.equal(await opencode.providerLoginApiKey({ providerId: "deepseek", key: "sk-test", metadata: {} }), true);
  assert.deepEqual(requests.map(({ method, route, body }) => [method, route, body]), [
    ["POST", "/provider/github-copilot/oauth/authorize", { method: 0, inputs: { deploymentType: "github.com" } }],
    ["POST", "/provider/github-copilot/oauth/callback", { method: 0 }],
    ["PUT", "/auth/azure", { type: "api", key: "sk-test", metadata: { resourceName: "models" } }],
    ["PUT", "/auth/deepseek", { type: "api", key: "sk-test" }],
  ]);
  assert.equal(requests[1].options.signal, controller.signal, "canceling the sign-in aborts the waiting callback");
  await assert.rejects(opencode.providerLoginAuthorize({ providerId: "../escape", method: 0, inputs: {} }),
    { code: "RUNTIME_LOGIN_PARAMS_INVALID" });
  assert.equal(requests.length, 4, "an invalid provider id never reaches OpenCode");
});

// A stand-in host whose callback the test settles.
function fakeHost({ mode = "auto", authorizeError = null, saved = true } = {}) {
  const calls = [];
  const callbacks = [];
  return {
    calls,
    callbacks,
    providerLoginOptions: async () => ({ providers: [] }),
    providerLoginAuthorize: async (input) => {
      calls.push(["authorize", input]);
      if (authorizeError) throw authorizeError;
      return { url: "https://auth.openai.com/oauth/authorize?x=1", mode, instructions: "" };
    },
    providerLoginCallback: (input) => new Promise((resolve, reject) => {
      calls.push(["callback", { ...input, signal: undefined }]);
      input.signal.addEventListener("abort", () => reject(new Error("aborted")));
      callbacks.push(resolve);
    }),
    providerLoginApiKey: async (input) => { calls.push(["apiKey", input]); return saved; },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const read = (manager) => validateRuntimeAccountServiceResult("runtime.account.login.read", manager.read({ runtimeAccountId: ACCOUNT }));

test("an automatic OAuth sign-in waits for OpenCode's callback", async () => {
  const fake = fakeHost();
  const manager = new OpenCodeLoginManager({ acquireHost: async () => fake, randomUUID: () => "req-1" });
  const start = await manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "openai", method: 0, inputs: {} });
  assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.provider.start", start),
    { requestId: "req-1", mode: "browser", status: "waiting", loginId: "req-1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" });
  assert.deepEqual([read(manager).login.browserOpened, read(manager).login.codeRequired], [false, false],
    "the app opens OpenCode's page");
  await assert.rejects(manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "openai", method: 0, inputs: {} }),
    { code: "AUTH_LOGIN_IN_PROGRESS" });
  await tick();
  fake.callbacks[0](true);
  await tick(); await tick();
  assert.equal(read(manager).login.status, "succeeded");
});

test("a code sign-in finishes on the pasted code, once", async () => {
  const fake = fakeHost({ mode: "code" });
  const manager = new OpenCodeLoginManager({ acquireHost: async () => fake, randomUUID: () => "req-1" });
  await manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "poe", method: 0, inputs: {} });
  assert.equal(read(manager).login.codeRequired, true);
  assert.equal(fake.calls.filter(([name]) => name === "callback").length, 0, "nothing waits before the code arrives");
  const submitted = manager.submit({ runtimeAccountId: ACCOUNT, requestId: "req-1", code: "abc123" });
  await tick();
  assert.deepEqual(fake.calls.at(-1), ["callback", { providerId: "poe", method: 0, code: "abc123", signal: undefined }]);
  fake.callbacks[0](true);
  assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.submit", await submitted), { requestId: "req-1", status: "succeeded" });
  await assert.rejects(manager.submit({ runtimeAccountId: ACCOUNT, requestId: "req-1", code: "again" }), { code: "AUTH_LOGIN_NOT_ACTIVE" });
});

test("canceling stops a waiting callback or a code that never came", async () => {
  const waiting = fakeHost();
  const automatic = new OpenCodeLoginManager({ acquireHost: async () => waiting, randomUUID: () => "req-1" });
  await automatic.providerStart({ runtimeAccountId: ACCOUNT, providerId: "openai", method: 0, inputs: {} });
  await tick();
  assert.deepEqual(await automatic.cancel({ runtimeAccountId: ACCOUNT, requestId: "req-1" }), { requestId: "req-1", status: "canceled" });
  const code = new OpenCodeLoginManager({ acquireHost: async () => fakeHost({ mode: "code" }), randomUUID: () => "req-2" });
  await code.providerStart({ runtimeAccountId: ACCOUNT, providerId: "poe", method: 0, inputs: {} });
  assert.deepEqual(await code.cancel({ runtimeAccountId: ACCOUNT, requestId: "req-2" }), { requestId: "req-2", status: "canceled" });
});

test("OpenCode errors and refused keys read as a failed sign-in, never as OpenCode's own text", async () => {
  const refused = new OpenCodeLoginManager({ acquireHost: async () => fakeHost({ authorizeError: new Error("private provider detail") }) });
  await assert.rejects(refused.providerStart({ runtimeAccountId: ACCOUNT, providerId: "openai", method: 0, inputs: {} }),
    (error) => error.code === "AUTH_LOGIN_FAILED" && !error.message.includes("private"));
  const keys = fakeHost();
  const manager = new OpenCodeLoginManager({ acquireHost: async () => keys });
  assert.deepEqual(validateRuntimeAccountServiceResult("runtime.account.login.apikey",
    await manager.apiKey({ runtimeAccountId: ACCOUNT, providerId: "deepseek", key: "sk-test", inputs: {} })), { saved: true });
  const rejected = new OpenCodeLoginManager({ acquireHost: async () => fakeHost({ saved: false }) });
  await assert.rejects(rejected.apiKey({ runtimeAccountId: ACCOUNT, providerId: "deepseek", key: "sk-test", inputs: {} }),
    { code: "AUTH_LOGIN_FAILED" });
  const plain = new OpenCodeLoginManager({ acquireHost: async () => ({}) });
  await assert.rejects(plain.options({ runtimeAccountId: ACCOUNT }), { code: "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED" });
});

test("a sign-in in progress keeps its OpenCode server running; a code never sent expires", async () => {
  const manager = new OpenCodeLoginManager({ acquireHost: async () => fakeHost({ mode: "code" }), randomUUID: () => "req-1", timeoutMs: 20 });
  assert.equal(manager.isActive(ACCOUNT), false);
  await manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "poe", method: 0, inputs: {} });
  assert.equal(manager.isActive(ACCOUNT), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([read(manager).login.status, read(manager).login.errorCode], ["timed_out", "AUTH_LOGIN_TIMEOUT"]);
  assert.equal(manager.isActive(ACCOUNT), false);
  await manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "poe", method: 0, inputs: {} });
  assert.equal(manager.isActive(ACCOUNT), true, "the next sign-in is not blocked by the expired one");
});

test("the Service reaches the host through the OpenCode handle and the V1 facade", async () => {
  const binding = { runtime: "opencode", runtimeProfileId: "login-test", runtimeAccountId: ACCOUNT };
  const inner = Object.assign(fakeHost(), { workspace: null, controlInstance: true,
    terminated: new Promise(() => {}), subscribe: () => () => {} });
  const adapter = new OpenCodeRuntimeAdapter({ runtimePool: { get: async () => inner, stop: async () => {}, stopAll: async () => {} } });
  const facade = runtimeHandleV1(await adapter.acquire(binding), binding);
  const manager = new OpenCodeLoginManager({ acquireHost: async () => facade, randomUUID: () => "req-1" });
  assert.deepEqual(await manager.options({ runtimeAccountId: ACCOUNT }), { providers: [] });
  await manager.providerStart({ runtimeAccountId: ACCOUNT, providerId: "openai", method: 0, inputs: {} });
  await tick();
  assert.deepEqual(await manager.cancel({ runtimeAccountId: ACCOUNT, requestId: "req-1" }), { requestId: "req-1", status: "canceled" },
    "the abort signal crosses both layers");
  assert.deepEqual(await manager.apiKey({ runtimeAccountId: ACCOUNT, providerId: "deepseek", key: "sk-test", inputs: {} }), { saved: true });
  assert.deepEqual(inner.calls.map(([name]) => name), ["authorize", "callback", "apiKey"]);
});
