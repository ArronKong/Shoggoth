"use strict";
// Per-conversation model sources for the built-in Codex Harness.
// Fixtures only; no real credentials or model requests.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const provider = require("../app/agent-service/codex-session-provider");
const route = require("../app/agent-service/execution-provider-route");
const config = require("../app/agent-service/codex-runtime-config");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { ProviderRuntimeBridge } = require("../app/agent-service/provider-runtime-bridge");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

const INTERNAL = SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
const endpoint = (id, models) => ({ id, kind: "custom-responses", name: `${id} name`, baseUrl: "https://gateway.example/v1",
  model: models[0], models, credentialRef: `secret-${id}`, headers: null, awsRegion: null, awsProfile: null,
  validationStatus: "protocol_valid" });

const preset = (id, kind, model) => ({ id, kind, name: kind, baseUrl: null, model, credentialRef: `secret-${id}`,
  headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });

function store({ providerRef = null, defaultModel = "gpt-default", runtimeAccountId = INTERNAL } = {}) {
  const profile = { id: "profile-1", backendId: "shoggoth", runtime: "codex", runtimeProfileId: "runtime-1", isDefault: true,
    runtimeAccountId, providerRef, defaultModel, enabled: true, permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } };
  const second = { ...profile, id: "profile-2", isDefault: false, runtimeProfileId: "runtime-2", providerRef: null };
  const secondOpenRouter = provider.presetProviderId("openrouter", second);
  const providers = new Map([["custom-one", endpoint("custom-one", ["one-a", "one-b"])],
    ["custom-two", endpoint("custom-two", ["two-a"])], ["foreign", endpoint("foreign", ["x"])],
    ["provider-openrouter", preset("provider-openrouter", "openrouter", "openai/gpt-5")],
    ["provider-ollama", preset("provider-ollama", "ollama", "qwen3")],
    [secondOpenRouter, preset(secondOpenRouter, "openrouter", "other/model")],
    ["stray-preset", preset("stray-preset", "lmstudio", "local")]]);
  const foreignOwner = { ...profile, id: "profile-hermes", runtimeProfileId: "runtime-foreign", backendId: "hermes", isDefault: false, providerRef: "foreign" };
  return {
    profile, second, providers,
    listAgentProfiles: () => [profile, second, foreignOwner],
    listModelProviders: () => [...providers.values()],
    getModelProvider: id => providers.get(id) ?? null,
    getModelProviderRevision: () => 1,
    getAgentProfile: id => (id === profile.id ? profile : null),
    getRuntimeAccount: id => ({ id, runtime: "codex", updatedAt: 1 }),
  };
}
const secretStore = { getCredentialRevision: () => 1 };

test("a Profile's sources are ChatGPT, its own presets and the Shoggoth endpoints", () => {
  const s = store({ providerRef: "custom-one", defaultModel: "one-a" });
  assert.deepEqual(provider.sourceProviders(s, s.profile).map((entry) => entry.id),
    ["provider-openrouter", "provider-ollama", "custom-one", "custom-two"],
    "another Profile's preset, a preset outside the id convention and a Hermes endpoint are not offered");
  assert.deepEqual(provider.sourceProviders(s, s.second).map((entry) => entry.id),
    [provider.presetProviderId("openrouter", s.second), "custom-one", "custom-two"]);
  assert.equal(provider.presetProviderId("openrouter", s.profile), "provider-openrouter");
  assert.match(provider.presetProviderId("openrouter", s.second), /^provider-openrouter-profile-2-[0-9a-f]{8}$/u);
  const stray = store({ providerRef: "stray-preset", defaultModel: "local" });
  assert.ok(provider.sourceProviders(stray, stray.profile).some((entry) => entry.id === "stray-preset"),
    "the Profile's own default always counts");
});

test("sources resolve to the Profile default, ChatGPT, or one of its sources only", () => {
  const s = store({ providerRef: "custom-one", defaultModel: "one-a" });
  assert.equal(provider.resolveProviderSelection(s, s.profile, null), "custom-one");
  assert.equal(provider.resolveProviderSelection(s, s.profile, "@chatgpt"), null);
  assert.equal(provider.resolveProviderSelection(s, s.profile, "custom-two"), "custom-two");
  assert.equal(provider.resolveProviderSelection(s, s.profile, "provider-openrouter"), "provider-openrouter");
  assert.throws(() => provider.resolveProviderSelection(s, s.profile, "@base"), { code: "SESSION_MODEL_PROVIDER_INVALID" });
  assert.throws(() => provider.resolveProviderSelection(s, s.profile, "foreign"), { code: "SESSION_MODEL_PROVIDER_UNAVAILABLE" });
  assert.throws(() => provider.resolveProviderSelection(s, s.profile, provider.presetProviderId("openrouter", s.second)),
    { code: "SESSION_MODEL_PROVIDER_UNAVAILABLE" }, "another assistant's preset");
  assert.throws(() => provider.resolveProviderSelection(s, s.profile, "gone"), { code: "SESSION_MODEL_PROVIDER_UNAVAILABLE" });
  assert.throws(() => provider.resolveProviderSelection(s, s.profile, "../x"), { code: "SESSION_MODEL_PROVIDER_INVALID" });
  assert.equal(provider.selectionForProviderRef(s, s.profile, "custom-one"), null);
  assert.equal(provider.selectionForProviderRef(s, s.profile, null), "@chatgpt");
  assert.equal(provider.selectionForProviderRef(s, s.profile, "provider-ollama"), "provider-ollama");
  assert.deepEqual(provider.applyProviderRef(s, s.profile, null), { ...s.profile, providerRef: null, defaultModel: null });
  assert.equal(provider.applyProviderRef(s, s.profile, "custom-two").defaultModel, "two-a");
  assert.equal(provider.applyProviderRef(s, s.profile, "provider-ollama").defaultModel, "qwen3");
  assert.deepEqual(provider.codexModelProvider(s, null), { kind: "chatgpt", configId: "openai" });
  assert.match(provider.codexModelProvider(s, "custom-two").configId, /^shoggoth_[0-9a-f]{16}$/u);
  assert.equal(provider.codexModelProvider(s, "provider-ollama").kind, "ollama");
  assert.equal(provider.routeRequiresOpenaiAuth(s, { runtime: "codex", runtimeAccountId: INTERNAL, provider: { providerRef: "custom-two" } }), false);
  assert.equal(provider.routeRequiresOpenaiAuth(s, { runtime: "codex", runtimeAccountId: INTERNAL, provider: { providerRef: "provider-ollama" } }), false);
  assert.equal(provider.routeRequiresOpenaiAuth(s, { runtime: "codex", runtimeAccountId: INTERNAL, provider: { providerRef: null } }), true);
  const chatgptDefault = store();
  assert.equal(provider.selectionForProviderRef(chatgptDefault, chatgptDefault.profile, null), null);
  const native = store({ runtimeAccountId: "native-codex-default-v1" });
  assert.equal(provider.resolveProviderSelection(native, native.profile, "custom-two"), null, "native Codex keeps its own source");
  assert.throws(() => provider.applyProviderRef(native, native.profile, "custom-two"), { code: "SESSION_MODEL_PROVIDER_UNAVAILABLE" });
});

test("models.list may ask for the ChatGPT catalog only", () => {
  const { validateProfileServiceParams } = require("../app/agent-service/profile-service-protocol");
  const base = { profileId: "profile-1", cursor: null, limit: 100 };
  assert.deepEqual(validateProfileServiceParams("profile.models.list", { ...base, source: "chatgpt" }), { ...base, source: "chatgpt" });
  assert.deepEqual(validateProfileServiceParams("profile.models.list", base), base);
  assert.throws(() => validateProfileServiceParams("profile.models.list", { ...base, source: "custom-one" }));
  assert.throws(() => validateProfileServiceParams("profile.binding.models.list",
    { ...base, bindingId: "binding-1", source: "chatgpt" }));
});

test("an execution route freezes the conversation source and stays current only while it exists", () => {
  const s = store();
  const frozen = route.captureExecutionProviderRoute({ productStore: s, secretStore, profile: s.profile,
    modelRef: "two-a", providerRef: "custom-two" });
  assert.equal(frozen.provider.providerRef, "custom-two");
  assert.equal(frozen.provider.modelRef, "two-a");
  assert.equal(route.assertExecutionProviderRouteCurrent(frozen, { productStore: s, secretStore }), true);
  const following = route.captureExecutionProviderRoute({ productStore: s, secretStore, profile: s.profile, modelRef: "gpt-default" });
  assert.equal(following.provider.providerRef, null);
  assert.equal(route.assertExecutionProviderRouteCurrent(following, { productStore: s, secretStore }), true);
  s.providers.delete("custom-two");
  assert.throws(() => route.assertExecutionProviderRouteCurrent(frozen, { productStore: s, secretStore }), { code: "EXECUTION_CONTRACT_STALE" });
  assert.equal(route.assertExecutionProviderRouteCurrent(following, { productStore: s, secretStore }), true,
    "removing another source leaves default routes current");
});

test("one ChatGPT process declares every other source; Bedrock and OpenAI keys at most once", () => {
  const extra = (id, kind = "custom-responses") => ({ id, kind, name: id, baseUrl: "https://gateway.example/v1", model: "m",
    headers: null, awsRegion: null, awsProfile: null, credentialEnv: "SHOGGOTH_PROVIDER_0123456789ABCDEF_API_KEY" });
  const openai = (id) => ({ ...extra(id, "openai-api-key"), baseUrl: null, credentialEnv: "OPENAI_API_KEY" });
  const ollama = { ...extra("provider-ollama", "ollama"), baseUrl: "http://127.0.0.1:11434/v1", credentialEnv: null };
  const bedrock = (id) => ({ ...extra(id, "amazon-bedrock"), baseUrl: null, credentialEnv: null, awsRegion: "us-east-1", awsProfile: "dev" });
  const normalized = config.validateRuntimeConfig({ provider: null,
    extraProviders: [extra("a"), extra("b"), openai("provider-openai-api-key"), ollama, bedrock("provider-amazon-bedrock")] });
  const overrides = config.configOverridesFor(normalized);
  assert.ok(overrides.includes('model_provider="openai"') && overrides.includes('forced_login_method="chatgpt"'));
  for (const id of ["a", "b"]) {
    const alias = config.providerConfigAlias(extra(id));
    assert.ok(overrides.includes(`model_providers.${alias}.env_key="SHOGGOTH_PROVIDER_0123456789ABCDEF_API_KEY"`));
    assert.ok(config.managedConfigFor(normalized).includes(`[model_providers.${alias}]`));
  }
  const openaiAlias = config.providerConfigAlias(openai("provider-openai-api-key"));
  assert.ok(overrides.includes(`model_providers.${openaiAlias}.base_url="https://api.openai.com/v1"`));
  assert.ok(overrides.includes(`model_providers.${openaiAlias}.requires_openai_auth=false`));
  assert.ok(overrides.includes(`model_providers.${config.providerConfigAlias(ollama)}.base_url="http://127.0.0.1:11434/v1"`));
  assert.ok(!overrides.some((value) => value.startsWith(`model_providers.${config.providerConfigAlias(ollama)}.env_key`)));
  assert.ok(overrides.includes('model_providers.amazon-bedrock.aws.region="us-east-1"'));
  assert.ok(overrides.includes('model_providers.amazon-bedrock.aws.profile="dev"'));
  assert.ok(config.managedConfigFor(normalized).includes("[model_providers.amazon-bedrock.aws]"));
  assert.ok(!overrides.join("\n").includes("fixture-secret"), "credentials are referenced by env name only");
  for (const extraProviders of [[extra("a"), extra("a")], [openai("x"), openai("y")], [bedrock("x"), bedrock("y")],
    [{ ...extra("c"), kind: "chatgpt", baseUrl: null, credentialEnv: null }]]) {
    assert.throws(() => config.validateRuntimeConfig({ provider: null, extraProviders }), { code: "CODEX_RUNTIME_CONFIG_INVALID" });
  }
  assert.throws(() => config.validateRuntimeConfig({ provider: null }), { code: "CODEX_RUNTIME_CONFIG_INVALID" });
});

test("management keeps ChatGPT while an execution host loads only its selected provider", async () => {
  const s = store({ providerRef: "provider-openrouter", defaultModel: "openai/gpt-5" });
  s.providers.set("provider-openrouter", { ...s.providers.get("provider-openrouter"), baseUrl: "https://openrouter.ai/api/v1",
    headers: { "HTTP-Referer": "https://product.test/shoggoth", "X-OpenRouter-Title": "Shoggoth" } });
  s.providers.set("provider-ollama", { ...s.providers.get("provider-ollama"), baseUrl: "http://127.0.0.1:11434/v1", credentialRef: null });
  s.providers.set("provider-amazon-bedrock", { ...preset("provider-amazon-bedrock", "amazon-bedrock", "anthropic.claude"),
    credentialRef: null, awsRegion: "us-east-1" });
  const secrets = new Map([["secret-provider-openrouter", ["openrouter", "or-key-fixture"]],
    ["secret-custom-one", ["custom-responses", "one-key-fixture"]]]);
  const secrets$ = { listMetadata: () => [...secrets].map(([credentialRef, [kind]]) => ({ credentialRef, kind })),
    get: async (ref) => secrets.get(ref)?.[1], getCredentialRevision: () => 1 };
  const bridge = new ProviderRuntimeBridge({ productStore: s, secretStore: secrets$, parentEnv: { AWS_PROFILE: "dev" },
    configWriter: { overlay: () => ({ args: [] }) } });
  const contract = (providerRef, modelRef) => ({ ...route.captureExecutionProviderRoute({ productStore: s, secretStore: secrets$,
    profile: s.profile, modelRef, providerRef }), runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL });
  const management = await bridge.prepareRuntime({ runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL });
  assert.equal(management.runtimeConfig.provider, null);
  assert.deepEqual(management.runtimeConfig.extraProviders.map((entry) => entry.id),
    ["provider-openrouter", "provider-ollama", "provider-amazon-bedrock", "custom-one"],
    "custom-two has no stored key and is left out instead of failing the others");
  const prepared = await bridge.prepareRuntime({ runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL,
    executionContract: contract(undefined, "openai/gpt-5") });
  assert.equal(prepared.runtimeConfig.provider.id, "provider-openrouter");
  assert.deepEqual(Object.values(prepared.spawnEnv), ["or-key-fixture"]);
  assert.deepEqual(prepared.registeredSecrets, ["or-key-fixture"]);
  await assert.rejects(bridge.prepareRuntime({ runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL,
    executionContract: contract("custom-two", "two-a") }), { code: "credentials_missing" }, "a run on the broken source fails");
  s.providers.delete("provider-ollama");
  prepared.assertCurrent();
  assert.throws(() => management.assertCurrent(), { code: "EXECUTION_CONTRACT_STALE" });
});

test("each native thread names its provider and keeps the endpoint's own reasoning settings", async () => {
  const calls = [];
  const host = {
    modelProviderKind: "chatgpt", terminated: new Promise(() => {}),
    async threadStart(params) { calls.push(["start", params]); return { thread: { id: `thread-${calls.length}` }, approvalsReviewer: "user" }; },
    async threadResume(params) { calls.push(["resume", params]); return { thread: { id: params.threadId }, approvalsReviewer: "user" }; },
  };
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host } });
  const handle = await adapter.acquire({ runtime: "codex", runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL });
  const custom = { kind: "custom-responses", configId: "shoggoth_0123456789abcdef" };
  await handle.sessionStart({ model: "two-a", modelProvider: custom, cwd: null }).catch(() => {});
  await handle.sessionResume({ sessionId: "thread-old", model: "gpt", modelProvider: { kind: "chatgpt", configId: "openai" }, cwd: null }).catch(() => {});
  await handle.sessionStart({ model: "gpt", cwd: null }).catch(() => {});
  assert.equal(calls[0][1].config.model_provider, "shoggoth_0123456789abcdef");
  assert.equal(calls[1][1].config.model_provider, "openai", "a resumed thread names its provider explicitly");
  assert.equal(calls[2][1].config, undefined, "omitted keeps the process default");
  await assert.rejects(handle.sessionStart({ model: "x", modelProvider: { kind: "custom-responses", configId: "evil\"]" } }),
    { code: "RUNTIME_PROTOCOL_INVALID" });
  // The built-in Harness never sends model work without a named source.
  await assert.rejects(handle.turnStart({ sessionId: "thread-3", prompt: "hi", operationId: "op" }),
    { code: "RUNTIME_MODEL_PROVIDER_REQUIRED" });
  await assert.rejects(handle.resolveModelOnly({ model: "gpt" }), { code: "RUNTIME_MODEL_PROVIDER_REQUIRED" });
  const native = await adapter.acquire({ runtime: "codex", runtimeProfileId: "runtime-2", runtimeAccountId: "native-codex-default-v1" });
  await assert.rejects(native.turnStart({ sessionId: "thread-x", prompt: "hi", operationId: "op" }),
    (error) => error?.code !== "RUNTIME_MODEL_PROVIDER_REQUIRED", "native Codex keeps its own default");
});

test("third-party Harness sources disable hosted web search on session start and resume", async () => {
  for (const [kind, model] of [["custom-responses", "mimo-v2.6-flash"], ["custom-responses", "DeepSeek-V4.1-Flash"],
    ["openrouter", "vendor/model"], ["ollama", "local"], ["lmstudio", "local"], ["amazon-bedrock", "anthropic.claude"]]) {
    const calls = [];
    const host = {
      modelProviderKind: "chatgpt", terminated: new Promise(() => {}),
      async threadStart(params) { calls.push(params); return { thread: { id: "search-fixture" } }; },
      async threadResume(params) { calls.push(params); return { thread: { id: params.threadId } }; },
    };
    const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host },
      secretGateway: { bind: async () => assert.fail("third-party requests keep their own provider route") } })
      .acquire({ runtime: "codex", runtimeProfileId: "runtime-search", runtimeAccountId: INTERNAL });
    const configId = kind === "amazon-bedrock" ? "amazon-bedrock" : "shoggoth_0123456789abcdef";
    const input = { model, modelProvider: { kind, configId },
      modelSecretScope: { profileId: "profile", sessionId: "search-fixture" } };
    await handle.sessionStart(input);
    await handle.sessionResume({ ...input, sessionId: "search-fixture" });
    assert.deepEqual(calls.map(call => call.config), [
      { model_provider: configId, web_search: "disabled" },
      { model_provider: configId, web_search: "disabled" },
    ], `${kind}/${model}: hosted search must not prevent an ordinary chat request`);
  }
});

test("official OpenAI sources and native Codex retain their web search configuration", async () => {
  for (const selection of [undefined, { kind: "chatgpt", configId: "openai" },
    { kind: "openai-api-key", configId: "shoggoth_0123456789abcdef" }]) {
    const calls = [];
    const host = {
      modelProviderKind: "chatgpt", terminated: new Promise(() => {}),
      async threadStart(params) { calls.push(params); return { thread: { id: "official-search" } }; },
      async threadResume(params) { calls.push(params); return { thread: { id: params.threadId } }; },
    };
    const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } })
      .acquire({ runtime: "codex", runtimeProfileId: "runtime-official", runtimeAccountId: INTERNAL });
    await handle.sessionStart({ modelProvider: selection });
    await handle.sessionResume({ sessionId: "official-search", modelProvider: selection });
    for (const call of calls) assert.deepEqual(call.config, selection ? { model_provider: selection.configId } : undefined);
  }
  const calls = [], host = {
    modelProviderKind: "native", terminated: new Promise(() => {}),
    async threadStart(params) { calls.push(params); return { thread: { id: "native-search" } }; },
    async threadResume(params) { calls.push(params); return { thread: { id: params.threadId } }; },
  };
  const native = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } })
    .acquire({ runtime: "codex", runtimeProfileId: "runtime-native", runtimeAccountId: "native-codex-default-v1" });
  await native.sessionStart({});
  await native.sessionResume({ sessionId: "native-search" });
  for (const call of calls) assert.equal(call.config, undefined, "native CLI preferences remain authoritative");
});

test("a conversation's source travels with its model choice, survives restart and is dropped with it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csp-"));
  try {
    const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
    const binding = { id: "11111111-1111-4111-8111-111111111111", profileId: "profile", runtime: "codex",
      runtimeAccountId: INTERNAL, enabled: true };
    const open = () => new ChatSessionStore({ paths, now: () => 100, getProfileBinding: () => binding,
      acquireWriterLease: () => ({ release() {} }) }).open();
    let sessions = open();
    const created = sessions.createSession({ operationId: "create", profileId: "profile", workspace: null, createdAt: 100 });
    const key = created.sessionKey;
    let current = sessions.switchRuntime(key, { bindingId: binding.id, revision: created.revision, model: "two-a",
      modelProviderRef: "custom-two" });
    assert.equal(current.modelProviderRef, "custom-two");
    sessions.close(); sessions = open();
    assert.equal(sessions.getSession(key).modelProviderRef, "custom-two");
    current = sessions.getSession(key);
    assert.throws(() => sessions.switchRuntime(key, { bindingId: binding.id, revision: current.revision,
      modelProviderRef: "custom-one" }), { code: "CHAT_RUNTIME_SWITCH_INVALID" }, "a source always comes with a model");
    assert.throws(() => sessions.switchRuntime(key, { bindingId: binding.id, revision: current.revision,
      model: "x", modelProviderRef: "../bad" }), { code: "CHAT_RUNTIME_SWITCH_INVALID" });
    current = sessions.switchRuntime(key, { bindingId: binding.id, revision: current.revision, model: "gpt-x", modelProviderRef: null });
    assert.equal(Object.hasOwn(current, "modelProviderRef"), false);
    current = sessions.switchRuntime(key, { bindingId: binding.id, revision: current.revision, model: "one-a", modelProviderRef: "custom-one" });
    current = sessions.setModelOverride(key, "gpt-y");
    assert.equal(Object.hasOwn(current, "modelProviderRef"), false, "a model without source returns to the default source");
    current = sessions.queueRuntimeSelection(key, { bindingId: binding.id, model: "two-a", permissionMode: null,
      modelProviderRef: "custom-two", revision: current.revision });
    assert.equal(current.nextRuntimeSelection.modelProviderRef, "custom-two");
    sessions.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a native session's source is recorded with its id, survives restart and is never projected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csp-src-"));
  try {
    const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
    const binding = { id: "11111111-1111-4111-8111-111111111111", profileId: "profile", runtime: "codex",
      runtimeAccountId: INTERNAL, enabled: true };
    const open = () => new ChatSessionStore({ paths, now: () => 100, getProfileBinding: () => binding,
      acquireWriterLease: () => ({ release() {} }) }).open();
    let sessions = open();
    const key = sessions.createSession({ operationId: "create", profileId: "profile", workspace: null, createdAt: 100 }).sessionKey;
    sessions.requestBinding(key, "fixture-binding", 100);
    sessions.completeBinding(key, "fixture-binding", "thread-1");
    assert.equal(sessions.recordRuntimeModelSource(key, "thread-other", "@chatgpt").runtimeModelSource, undefined,
      "a record for another native session is ignored");
    const recorded = sessions.recordRuntimeModelSource(key, "thread-1", "custom-two");
    assert.deepEqual(recorded.runtimeModelSource, { runtimeSessionId: "thread-1", source: "custom-two" });
    assert.throws(() => sessions.recordRuntimeModelSource(key, "thread-1", "../bad"), { code: "CHAT_SESSION_INVALID" });
    sessions.close(); sessions = open();
    const reopened = sessions.getSession(key);
    assert.deepEqual(reopened.runtimeModelSource, { runtimeSessionId: "thread-1", source: "custom-two" });
    const { validateChatServiceResult } = require("../app/agent-service/chat-service-protocol");
    assert.equal(Object.hasOwn(validateChatServiceResult("chat.session.create", { session: reopened }).session,
      "runtimeModelSource"), false);
    assert.equal(Object.hasOwn(validateChatServiceResult("chat.session.list",
      { sessions: [reopened], nextCursor: null, hasMore: false }).sessions[0], "runtimeModelSource"), false);
    sessions.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Real bundled Codex: ChatGPT and two other sources run at the same time in
// provider-specific app-servers with the same managed Home. Each request
// reaches its own server with its own credential.
const CODEX = path.join(__dirname, "..", ".vendor", "codex", process.arch === "arm64" ? "arm64" : "x64", "package", "bin", "codex");
test("bundled Codex routes concurrent threads to their own provider and credential", { skip: !fs.existsSync(CODEX) && "bundled Codex not prepared", timeout: 240_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csp-codex-"));
  const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const chatgptToken = [b64({ alg: "none" }), b64({ exp: 4102444800, "https://api.openai.com/auth": {
    chatgpt_account_id: "acct-fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "user-fixture" } }), "sig"].join(".");
  const endpointKey = "fixture-endpoint-key";
  const secondKey = "fixture-second-key";
  const seen = [];
  const gets = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      try { if (req.headers["content-encoding"] === "zstd") body = zlib.zstdDecompressSync(body); } catch {}
      if (req.method === "GET") gets.push(req.url.split("?")[0]);
      if (req.method === "POST" && /\/responses$/u.test(req.url)) {
        let parsed = {}; try { parsed = JSON.parse(body.toString("utf8")); } catch {}
        seen.push({ route: req.url.split("/")[1], model: parsed.model,
          auth: req.headers.authorization === `Bearer ${endpointKey}` ? "endpoint"
            : req.headers.authorization === `Bearer ${secondKey}` ? "second"
              : req.headers.authorization === `Bearer ${chatgptToken}` ? "chatgpt" : "other" });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [{ type: "response.created", response: { id: "r" } },
          { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text: "ok" }] } },
          { type: "response.completed", response: { id: "r", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }]) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        return res.end();
      }
      res.writeHead(404); res.end("{}");
    });
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const productStore = store({ providerRef: "custom-two", defaultModel: "two-a" });
  productStore.providers.set("custom-two", { ...productStore.providers.get("custom-two"), baseUrl: `${origin}/custom/v1` });
  productStore.providers.set("custom-three", { ...endpoint("custom-three", ["three-a"]), baseUrl: `${origin}/second/v1` });
  const credentials = new Map([["secret-custom-two", endpointKey], ["secret-custom-three", secondKey]]);
  const fixtureSecrets = {
    listMetadata: () => [...credentials.keys()].map(credentialRef => ({ credentialRef, kind: "custom-responses" })),
    get: async ref => credentials.get(ref),
    getCredentialRevision: () => 1,
  };
  const bridge = new ProviderRuntimeBridge({ productStore, secretStore: fixtureSecrets,
    configWriter: { overlay({ runtimeConfig }) {
      const overrides = [...config.configOverridesFor(runtimeConfig),
        `openai_base_url="${origin}/chatgpt"`, `chatgpt_base_url="${origin}/backend"`,
        'cli_auth_credentials_store="file"'];
      return { args: overrides.flatMap(value => ["-c", value]) };
    } } });
  const workspace = path.join(root, "work");
  fs.mkdirSync(workspace);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const deadProxy = "http://127.0.0.1:9";
  const parentEnv = { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root,
    HTTPS_PROXY: deadProxy, HTTP_PROXY: deadProxy, ALL_PROXY: deadProxy, NO_PROXY: "127.0.0.1,localhost" };
  const repoRoot = path.join(__dirname, "..");
  const resolver = new RuntimeAccountResolver({ paths, homedir: root, parentEnv, repoRoot });
  const binding = { runtime: "codex", runtimeProfileId: "runtime-1", runtimeAccountId: INTERNAL };
  const runtime = resolver.resolve(binding, defaultRuntimeAccountLookup(INTERNAL));
  fs.writeFileSync(path.join(runtime.home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: chatgptToken, id_token: chatgptToken, refresh_token: "fixture-refresh", account_id: "acct-fixture" },
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  const pool = new CodexRuntimePool({ paths, parentEnv, runtimeAccountResolver: resolver, repoRoot,
    hostOptions: { repoRoot, prepareRuntime: bridge.prepareRuntime.bind(bridge) } });
  const adapter = new CodexRuntimeAdapter({ runtimePool: pool, secretGateway: {
    async bind() { return { baseUrl: `${origin}/chatgpt`, close() {} }; },
  } });
  const contract = (providerRef, modelRef) => ({ ...route.captureExecutionProviderRoute({
    productStore, secretStore: fixtureSecrets, profile: productStore.profile, modelRef, providerRef,
  }), ...binding });
  async function selection(providerRef, model, projected = false) {
    const modelProvider = provider.codexModelProvider(productStore, providerRef);
    const host = await adapter.acquire(binding, { executionContract: contract(providerRef, model),
      ...(projected ? { modelSecretProviderKind: modelProvider.kind } : {}) });
    return { host, params: { model, modelProvider, cwd: workspace,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" },
      ...(projected ? { modelSecretScope: { profileId: productStore.profile.id, sessionId: "fixture-projected" } } : {}) } };
  }
  async function turn(host, sessionId) {
    let unsubscribe;
    let timeout;
    try {
      const done = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("fixture turn did not finish")), 15_000);
        timeout.unref();
        unsubscribe = host.subscribe(event => {
          if (event.type === "complete" && event.sessionId === sessionId) resolve(event.status);
        });
      });
      done.catch(() => {});
      await host.turnStart({ sessionId, prompt: "hi" });
      assert.equal(await done, "completed");
    } finally {
      clearTimeout(timeout);
      unsubscribe?.();
    }
  }
  try {
    const [chat, custom, other, projected] = await Promise.all([
      selection(null, "gpt-fixture"),
      selection("custom-two", "two-a"),
      selection("custom-three", "three-a"),
      selection(null, "gpt-fixture", true),
    ]);
    assert.equal(new Set([chat.host, custom.host, other.host, projected.host]).size, 4);
    assert.equal((await selection("custom-two", "two-a")).host, custom.host);
    await (await adapter.acquire(binding)).modelsList({ limit: 100, includeHidden: false });
    assert.ok(gets.includes("/chatgpt/models"), "ChatGPT management reads the live catalog");

    const sessions = await Promise.all([chat, custom, other, projected].map(async ({ host, params }) => {
      const started = await host.sessionStart({ ...params, persistent: true });
      await turn(host, started.session.id);
      return started.session;
    }));
    assert.deepEqual(seen.map(entry => [entry.route, entry.model, entry.auth]).sort(), [
      ["chatgpt", "gpt-fixture", "chatgpt"], ["chatgpt", "gpt-fixture", "chatgpt"],
      ["custom", "two-a", "endpoint"], ["second", "three-a", "second"],
    ]);

    await adapter.stop(binding);
    for (const [index, providerRef, model, projection] of [[1, "custom-two", "two-a", false], [3, null, "gpt-fixture", true]]) {
      const { host, params } = await selection(providerRef, model, projection);
      const sessionId = sessions[index].id;
      const resumed = await host.sessionResume({ ...params, sessionId });
      assert.equal(resumed.session.id, sessionId);
      await turn(host, sessionId);
    }
    assert.deepEqual(seen.slice(4).map(entry => [entry.route, entry.model, entry.auth]), [
      ["custom", "two-a", "endpoint"], ["chatgpt", "gpt-fixture", "chatgpt"],
    ]);
  } finally {
    try { await adapter.stopAll(); }
    finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
