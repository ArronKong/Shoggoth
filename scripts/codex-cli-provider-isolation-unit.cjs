"use strict";

// Real Product projections and provider bridge; fixtures never read user Homes,
// keys or provider services. Native and Harness share an Agent, not a model route.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID: NATIVE,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID: HARNESS } = require("../app/agent-service/runtime-account");
const { agentRuntimeProfileViews } = require("../app/agent-service/agent-runtime-profile-views");
const { captureExecutionProviderRoute, assertExecutionProviderRouteCurrent } = require("../app/agent-service/execution-provider-route");
const { createProfileServiceController } = require("../app/agent-service/profile-service-controller");
const { ProviderRuntimeBridge } = require("../app/agent-service/provider-runtime-bridge");
const { CodexRuntimeConfigWriter } = require("../app/agent-service/codex-runtime-config");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-isolation-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const store = new JsonlProductStore({ paths }).open();
  const provider = store.putModelProvider({ id: "harness-endpoint", kind: "custom-responses", name: "Harness endpoint",
    baseUrl: "https://gateway.example/v1", model: "harness-only", models: ["harness-only"],
    credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
  const profile = store.putAgentProfile({ ...store.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    providerRef: provider.id, defaultModel: provider.model });
  const native = store.addAgentRuntimeBinding(profile.id, { runtime: "codex", runtimeAccountId: NATIVE },
    { operationId: "fixture-native-codex" }).binding;
  const bundled = store.getAgentRuntimeBinding(profile.id, profile.defaultBindingId);
  const noSecret = () => { throw new Error("Native Codex must not read a Harness credential"); };
  const secrets = { get: noSecret, listMetadata: () => [], getCredentialRevision: noSecret };
  const configWriter = new CodexRuntimeConfigWriter({ paths });
  const bridge = new ProviderRuntimeBridge({ productStore: store, secretStore: secrets, configWriter });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, provider, profile, native, bundled, secrets, configWriter, bridge };
}

test("native execution projections omit Harness defaults without changing the stored Agent", t => {
  const f = fixture(t);
  const native = f.store.resolveAgentRuntimeProfile(f.profile.id, f.native.id);
  assert.equal(native.providerRef, null);
  assert.equal(native.defaultModel, null);
  const view = agentRuntimeProfileViews(f.store).find(p => p.runtimeAccountId === NATIVE);
  assert.equal(view.providerRef, null);
  assert.equal(view.defaultModel, null);
  const harness = f.store.resolveAgentRuntimeProfile(f.profile.id, f.bundled.id);
  assert.equal(harness.providerRef, f.provider.id);
  assert.equal(harness.defaultModel, "harness-only");
  assert.equal(f.store.getAgentProfile(f.profile.id).providerRef, f.provider.id);
  const { ShoggothBackend } = require("../app/core/shoggoth-backend");
  const facade = { _bindingsByProfile: new Map([[f.profile.id, [f.native, f.bundled]]]) };
  const nativeSessionProfile = ShoggothBackend.prototype._profileForSession.call(facade, f.profile,
    { runtimeBindingId: f.native.id });
  assert.equal(nativeSessionProfile.providerRef, null);
  assert.equal(nativeSessionProfile.defaultModel, null, "chat metadata must not label CLI as the Harness default");
});

test("native catalog reads its own host even when the Agent defaults to a Harness endpoint", async t => {
  const f = fixture(t), reads = [];
  const controller = createProfileServiceController({ productStore: f.store,
    runtimeManager: { stop: async () => {}, acquire: async binding => ({ modelsList: async () => {
      reads.push(binding.runtimeAccountId);
      return { data: [{ model: "cli-own-model", displayName: "CLI own model", description: "", hidden: false, isDefault: true }], nextCursor: null };
    } }) },
    accountAuthManager: { read: async () => { throw new Error("Native catalog does not require Harness ChatGPT login"); } },
    providerBootstrap: { configureOpenAiApiKey: async () => {}, clearUnreferencedOpenAiApiKey: async () => {} },
  }).open();
  t.after(() => controller.close());
  const cli = await controller.handle("profile.binding.models.list", {
    profileId: f.profile.id, bindingId: f.native.id, cursor: null, limit: 100 });
  assert.deepEqual(cli.models.map(m => m.id), ["cli-own-model"]);
  assert.deepEqual(reads, [NATIVE]);
  const harness = await controller.handle("profile.binding.models.list", {
    profileId: f.profile.id, bindingId: f.bundled.id, cursor: null, limit: 100 });
  assert.deepEqual(harness.models.map(m => m.id), ["harness-only"]);
  f.store.setAgentDefaultBinding(f.profile.id, f.native.id, { revision: f.store.getAgentRuntimeBindings(f.profile.id).revision });
  const nativeDefault = await controller.handle("profile.models.list", { profileId: f.profile.id, cursor: null, limit: 100 });
  assert.deepEqual(nativeDefault.models.map(m => m.id), ["cli-own-model"]);
});

test("native launch preserves CLI provider/auth/model settings and injects no Harness credentials", async t => {
  const f = fixture(t);
  f.store.putModelProvider({ ...f.provider, credentialRef: "harness-credential-not-readable-by-cli" });
  const prepared = await f.bridge.prepareRuntime({ runtimeProfileId: f.native.runtimeProfileId, runtimeAccountId: NATIVE });
  assert.equal(prepared.runtimeConfig, null);
  assert.deepEqual(prepared.spawnEnv, {});
  assert.deepEqual(prepared.registeredSecrets, []);
  const values = prepared.configArgs.filter((_, index) => index % 2 === 1);
  assert.equal(values.some(v => /^(?:model=|model_provider=|forced_login_method=|model_providers\.)/u.test(v)), false);
  assert.ok(values.some(v => v.startsWith("mcp_servers.shoggoth.")), "product MCP binding remains scoped");
  const { models: _models, credentialRef: _credentialRef, validationStatus: _status, ...provider } = f.provider;
  assert.throws(() => f.configWriter.overlay({ runtimeProfileId: f.native.runtimeProfileId, runtimeAccountId: NATIVE,
    runtimeConfig: { provider: { ...provider, credentialEnv: null } } }), { code: "CODEX_RUNTIME_CONFIG_INVALID" });
});

test("changing a Harness default never changes or invalidates a native execution route", t => {
  const f = fixture(t);
  const native = f.store.resolveAgentRuntimeProfile(f.profile.id, f.native.id);
  const route = captureExecutionProviderRoute({ productStore: f.store, secretStore: f.secrets, profile: native });
  assert.equal(route.provider.providerRef, null);
  assert.equal(route.provider.modelRef, null);
  f.store.putModelProvider({ ...f.provider, model: "harness-new", models: ["harness-new"] });
  f.store.putAgentProfile({ ...f.store.getAgentProfile(f.profile.id), defaultModel: "harness-new" });
  assert.equal(assertExecutionProviderRouteCurrent(route, { productStore: f.store, secretStore: f.secrets }), true);
  const after = captureExecutionProviderRoute({ productStore: f.store, secretStore: f.secrets,
    profile: f.store.resolveAgentRuntimeProfile(f.profile.id, f.native.id) });
  assert.deepEqual(after, route);
  assert.equal(f.store.resolveAgentRuntimeProfile(f.profile.id, f.bundled.id).defaultModel, "harness-new");
  assert.equal(f.store.resolveAgentRuntimeProfile(f.profile.id, f.bundled.id).runtimeAccountId, HARNESS);
});

test("Service model selection and execution stay on native Codex, with an independent Harness default", async () => {
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
  const f = await openHandoffFixture({ builtinCliProfiles: true, catalogs: { codex: ["fixture-model", "cli-second"] } });
  try {
    const store = f.service.productStore;
    store.putModelProvider({ id: "harness-endpoint", kind: "custom-responses", name: "Harness endpoint",
      baseUrl: "https://gateway.example/v1", model: "harness-only", models: ["harness-only"],
      credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
    store.putAgentProfile({ ...store.getAgentProfile(f.profile.id), providerRef: "harness-endpoint", defaultModel: "harness-only" });
    const native = store.addAgentRuntimeBinding(f.profile.id, { runtime: "codex", runtimeAccountId: NATIVE },
      { operationId: "isolation-native" }).binding;
    const session = f.createSession();
    f.service.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: native.id, revision: session.revision,
      clearModelOverride: true, permissionMode: null });
    const state = await f.controller.handle("chat.session.runtime.state", { profileId: f.profile.id, sessionKey: session.sessionKey });
    assert.equal(state.model, null, "no native model override means use CLI config, never the Harness default");
    const catalog = await f.service.profileServiceController.handle("profile.binding.models.list", {
      profileId: f.profile.id, bindingId: native.id, cursor: null, limit: 100 });
    assert.deepEqual(catalog.models.map(m => m.id), ["fixture-model", "cli-second"]);
    const { requestService, readClientToken } = require("../app/agent-service/client");
    const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
    await requestService(f.paths, { version: SERVICE_PROTOCOL_VERSION, token: readClientToken(f.paths),
      method: "chat.session.runtime.model.set", params: {
      profileId: f.profile.id, sessionKey: session.sessionKey, bindingId: native.id,
      model: "cli-second", revision: state.revision, acceptAdjustments: true } });
    const run = await f.send(session.sessionKey, "native-isolated-run", "native fixture request");
    assert.equal(run.status, "running", run.errorCode);
    const acquired = f.transport.acquisitions.filter(a => a.binding.runtimeAccountId === NATIVE
      && a.options.executionContract).at(-1);
    assert.ok(acquired, "execution uses the native account");
    assert.equal(acquired.options.executionContract.defaultModel, "cli-second");
    assert.equal(acquired.options.executionContract.provider.providerRef, null);
    await f.complete(run);
    assert.equal(store.getAgentProfile(f.profile.id).providerRef, "harness-endpoint");
    assert.equal(store.getAgentProfile(f.profile.id).defaultModel, "harness-only");
  } finally { await f.close(); }
});
