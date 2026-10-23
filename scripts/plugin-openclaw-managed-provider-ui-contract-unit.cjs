#!/usr/bin/env node
"use strict";
// Backend contract proof only: no Host, model request, real credential or build.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = fs.mkdtempSync("/private/tmp/sg-managed-provider-ui-unit-");
fs.chmodSync(root, 0o700);
const mkdir = name => { const value = path.join(root, name); fs.mkdirSync(value, { mode: 0o700 }); return value; };
const runtimeRoot = mkdir("runtime"), home = mkdir("home"), stateDir = mkdir("state"), workspace = mkdir("workspace");
const entryPath = path.join(runtimeRoot, "openclaw.mjs"), configPath = path.join(stateDir, "openclaw.json");
fs.writeFileSync(entryPath, "// synthetic runtime; never executed\n", { mode: 0o400 });
fs.writeFileSync(configPath, "{}", { mode: 0o600 });
const execution = { runtimeRoot, interpreterPath: fs.realpathSync(process.execPath), entryPath, home, stateDir, configPath, workspace,
  env: { HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath } };
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const cat = (extra = {}) => ({ label: "Fixture", builtin: true, envKeys: ["FIXTURE_API_KEY"], oauth: [],
  baseUrl: "https://fixture.test/v1", api: "openai-responses", defaultModels: [{ id: "fixture-real-model" }], ...extra });
const capabilities = (extra = {}) => ({ supported: true, create: true, updateProvider: true,
  renameProvider: false, batch: false, ...extra });
function fixture({ managed = true, native = false, authRowsByAgent = {}, caps = capabilities(), config = {}, catalog = { fixture: cat() }, unverified = false } = {}) {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:9",
    ...(managed ? { getManagedExecution: () => unverified ? null : execution, authResolver: {} } : {}) });
  backend._configSnapshot = async () => ({ parsed: config, hash: "fixture-hash" });
  backend._providerCatalogSnapshot = () => ({ providers: catalog });
  backend._localKeyDigests = async () => new Map();
  backend._loadEndpointAuthKeyProfiles = async () => new Map();
  if (native) backend._gatewayAuthProfileRows = async agentId => Object.hasOwn(authRowsByAgent, agentId) ? authRowsByAgent[agentId] : [];
  backend.attachModelChangeAdapter({ getCapabilities: async () => caps,
    ...(native ? { configurationSemantics: "native-config" } : {}),
    preview: async () => ({ blockers: [] }), apply: async () => ({}), recover: async () => ({}) });
  return backend;
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
test("managed capability never advertises legacy auth-profile writes, including an unverified scope", async () => {
  for (const caps of [capabilities(), { supported: false }, null]) {
    const backend = fixture({ caps, unverified: true });
    const value = await backend.getModelChangeCapabilities();
    assert.equal(value.providerDirectory, true);
    assert.equal(value.manageAuthProfiles, false);
    assert.deepEqual(await backend.listModelAuthProfiles(), {
      supported: false, reason: "managed-model-transaction", profiles: [],
    });
  }
});
test("managed direct auth mutations fail before CLI, file, SQLite, or profile inventory", async () => {
  const backend = fixture({ unverified: true });
  let sideEffects = 0;
  for (const name of ["_readAuthProfiles", "_listAgentSqliteAuthProfiles", "_loadCanonicalAuthProfiles"])
    backend[name] = () => { sideEffects += 1; throw new Error("must not reach legacy storage"); };
  for (const run of [
    () => backend.setModelAuthProfileKey("fixture", "synthetic-key"),
    () => backend.deleteModelAuthProfile("fixture:default"),
    () => backend._writeAuthProfileKey("fixture", "synthetic-key"),
    () => backend._deleteCanonicalAuthProfile("fixture:default"),
    () => backend._runModelAuthCli(["models", "auth", "paste-api-key", "--provider", "fixture"]),
    () => backend._runModelAuthCli(["models", "auth", "logout", "fixture:default"]),
    () => backend._runModelAuthCli(["models", "auth", "order", "set"]),
  ]) await assert.rejects(run, { code: "managed_model_transaction_required" });
  assert.throws(() => backend._writeAuthProfiles("/private/tmp/must-not-write.json", {}), {
    code: "managed_model_transaction_required",
  });
  assert.throws(() => backend._syncAgentSqliteAuthKey("fixture:default", {}), {
    code: "managed_model_transaction_required",
  });
  assert.equal(sideEffects, 0);
});
test("legacy public auth writes retain their existing delegation", async () => {
  const backend = fixture({ managed: false });
  const calls = [];
  backend._writeAuthProfileKey = async (...args) => { calls.push(args); return "fixture:default"; };
  backend._usesCanonicalModelAuthCli = () => true;
  backend._loadCanonicalAuthProfiles = async () => [{ id: "fixture:default" }];
  backend._deleteCanonicalAuthProfile = async (id) => calls.push([id]);
  assert.equal((await backend.getModelChangeCapabilities()).manageAuthProfiles, true);
  assert.deepEqual(await backend.setModelAuthProfileKey("fixture", "synthetic-key"), {
    ok: true, id: "fixture:default", activation: { kind: "gateway_restart", available: true },
  });
  assert.deepEqual(await backend.deleteModelAuthProfile("fixture:default"), {
    ok: true, id: "fixture:default", activation: { kind: "gateway_restart", available: true },
  });
  assert.equal(calls.length, 2);
});
test("complete catalog metadata enables exact managed provider creation", async () => {
  const row = (await fixture().getProviderDirectory()).providers[0];
  assert.equal(row.writeMode, "managed-model-change");
  assert.equal(row.inConfig, false);
  assert.equal(row.api, "openai-responses");
  assert.equal(row.defaultModelId, "fixture-real-model");
  assert.equal(row.baseUrl.defaultValue, "https://fixture.test/v1");
  assert.equal(row.baseUrl.editable, true);
  assert.equal(row.key.editable, true);
  assert.equal(row.key.editReason, null);
});
test("native Provider cards aggregate official API Key state across the target roster", async () => {
  const row = (await fixture({ native: true,
    caps: capabilities({ credentialManagement: true }), config: { agents: { entries: { main: {}, other: {}, unavailable: {} } } },
    authRowsByAgent: { other: [{ provider: "fixture", profileId: "fixture:manual", type: "api_key" }], unavailable: null },
  }).getProviderDirectory()).providers[0];
  assert.equal(row.writeMode, "native-config");
  assert.equal(row.configRevision, "fixture-hash");
  assert.equal(row.key.configured, true);
  assert.equal(row.key.clearable, true);
  assert.equal(row.key.source, "auth-profile");
  assert.equal(row.key.statusUnknown, true);
  assert.equal(row.key.redacted, null);
  assert.equal(Object.hasOwn(row, "authKeys"), false);
  assert.equal(row.key.editable, true);
});
test("native OAuth-only profiles do not claim an API Key, and unreadable state is not absence", async () => {
  const options = { native: true, caps: capabilities({ credentialManagement: true }),
    config: { agents: { entries: { main: {}, other: {} } } },
    authRowsByAgent: { other: [{ provider: "fixture", profileId: "fixture:oauth", type: "oauth" }] } };
  const row = (await fixture(options).getProviderDirectory()).providers[0];
  assert.equal(row.key.configured, false);
  assert.equal(row.key.clearable, false);
  const unknown = (await fixture({ ...options, authRowsByAgent: { other: null } }).getProviderDirectory()).providers[0];
  assert.equal(unknown.key.statusUnknown, true);
  assert.equal(unknown.key.clearable, true);
});
test("native endpoint Key state includes non-default Agent credentials without exposing an Agent selector", async () => {
  const snapshot = await fixture({ native: true, caps: capabilities({ credentialManagement: true }), catalog: {},
    config: { agents: { entries: { main: {}, other: {} } }, models: { providers: { fixture: {
      baseUrl: "https://fixture.test/v1", api: "openai-completions", models: [],
    } } } }, authRowsByAgent: { other: [{ provider: "fixture", profileId: "fixture:manual", type: "api_key" }] },
  }).listCustomEndpoints();
  assert.equal(snapshot.endpoints[0].hasApiKey, true);
  assert.equal(snapshot.endpoints[0].canClearApiKey, true);
  assert.equal(snapshot.endpoints[0].canRevealApiKey, false);
  assert.equal(Object.hasOwn(snapshot.form, "authAgents"), false);
});
test("missing endpoint keeps endpoint editable but blocks initial key", async () => {
  const row = (await fixture({ catalog: { fixture: cat({ baseUrl: null }) } }).getProviderDirectory()).providers[0];
  assert.equal(row.baseUrl.editable, true);
  assert.equal(row.key.editable, false);
  assert.equal(row.key.editReason, "endpoint_required");
});
test("missing/invalid catalog protocol or real model never invents a create target", async () => {
  for (const extra of [{ api: null }, { api: "not-a-protocol" }, { defaultModels: [] },
    { defaultModels: [{ id: "" }] }, { defaultModels: [{ id: "\u0000" }] }]) {
    const row = (await fixture({ catalog: { fixture: cat(extra) } }).getProviderDirectory()).providers[0];
    assert.equal(row.key.editable, false);
    assert.equal(row.key.editReason, "provider_metadata_required");
    assert.equal(row.baseUrl.editable, false);
  }
});
test("credential URLs containing embedded credentials, query, or fragment are not actionable", async () => {
  for (const baseUrl of ["https://name:credential@fixture.test/v1", "https://fixture.test/v1?key=no",
    "https://fixture.test/v1#fragment", "ftp://fixture.test/v1", "not-a-url"]) {
    const row = (await fixture({ catalog: { fixture: cat({ baseUrl }) } }).getProviderDirectory()).providers[0];
    assert.equal(row.key.editable, false);
    assert.equal(row.key.editReason, "endpoint_required");
  }
});
test("unavailable managed transaction is read-only and never falls back to config-only", async () => {
  const backend = fixture({ caps: capabilities({ supported: false }) });
  const row = (await backend.getProviderDirectory()).providers[0];
  assert.equal(row.key.editable, false);
  assert.equal(row.baseUrl.editable, false);
  assert.equal(row.key.editReason, "transaction_unavailable");
  assert.equal((await backend.getModelConfigWriteCapabilities()).supported, false);
});
test("existing managed provider uses safe key metadata, never raw config or key bytes", async () => {
  const config = { models: { providers: { fixture: { baseUrl: "https://fixture.test/v1",
    apiKey: "PRIVATE-SENTINEL", models: [{ id: "real-model" }] } } } };
  const output = await fixture({ config, catalog: {} }).getProviderDirectory();
  assert.equal(output.providers[0].key.configured, true);
  assert.equal(output.providers[0].key.source, "config");
  assert.equal(output.providers[0].key.editable, true);
  assert.equal(output.providers[0].api, "openai-completions", "existing implicit API is the runtime contract default");
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE-SENTINEL|apiKey|parsed|raw/);
});
test("managed auth-only profiles remain visible but direct removal is disabled", async () => {
  const config = { auth: { profiles: { "fixture:default": { provider: "fixture", mode: "api_key" } } } };
  const row = (await fixture({ config }).getProviderDirectory()).providers[0];
  assert.equal(row.key.configured, true);
  assert.equal(row.key.source, "auth-profile");
  assert.equal(row.key.clearable, false);
});
test("create capability is independent of update capability and invalid existing APIs stay read-only", async () => {
  const createOnly = (await fixture({ caps: capabilities({ updateProvider: false }) }).getProviderDirectory()).providers[0];
  assert.equal(createOnly.key.editable, true);
  assert.equal(createOnly.baseUrl.editable, true);
  const invalid = (await fixture({ config: { models: { providers: { fixture: { api: "not-supported",
    baseUrl: "https://fixture.test/v1", apiKey: "PRIVATE-SENTINEL", models: [{ id: "real-model" }] } } } } }).getProviderDirectory()).providers[0];
  assert.equal(invalid.key.editable, false);
  assert.equal(invalid.key.clearable, false);
  assert.equal(invalid.baseUrl.editable, false);
  assert.equal(invalid.key.editReason, "provider_metadata_required");
});
test("existing provider scope never borrows the catalog endpoint or protocol", async () => {
  const config = { models: { providers: { fixture: { models: [{ id: "model-without-endpoint" }] } } } };
  const row = (await fixture({ config, catalog: { fixture: cat({ api: "anthropic-messages" }) } }).getProviderDirectory()).providers[0];
  assert.equal(row.api, "openai-completions");
  assert.equal(row.key.editable, false);
  assert.equal(row.key.editReason, "endpoint_required");
});
test("managed endpoint selection is sequential and rename follows the exact runtime capability", async () => {
  for (const [caps, rename] of [[capabilities(), false], [capabilities({ renameProvider: undefined }), false],
    [capabilities({ supported: false, renameProvider: true }), false], [capabilities({ renameProvider: true }), true]]) {
    const value = await fixture({ caps }).listCustomEndpoints();
    assert.equal(value.form.singleModelMutations, true);
    assert.equal(value.form.batchModelSelection, false);
    assert.equal(value.form.providerIdEditable, rename);
  }
});
test("legacy endpoint form and directory shapes remain unchanged", async () => {
  const backend = fixture({ managed: false });
  const value = await backend.listCustomEndpoints();
  assert.equal(value.form.batchModelSelection, true);
  assert.equal(value.form.providerIdEditable, true);
  assert.equal(Object.hasOwn(value.form, "singleModelMutations"), false);
  const row = (await backend.getProviderDirectory()).providers[0];
  assert.equal(Object.hasOwn(row, "writeMode"), false);
  assert.equal(Object.hasOwn(row.key, "editable"), false);
  assert.equal(Object.hasOwn(row.key, "editReason"), false);
});
(async () => {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(JSON.stringify({ verified: true, checks: tests.length, hostStarts: 0, modelRequests: 0,
    realCredentialReads: 0, boundary: "managed backend capabilities and guarded legacy paths; no formal Service/Worker chain" }));
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
