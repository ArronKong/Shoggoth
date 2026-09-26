#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const service = path.resolve(__dirname, "../app/agent-service");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID, snapshotChecksum } = require(path.join(service, "product-store"));
const { EncryptedSecretStore } = require(path.join(service, "encrypted-secret-store"));
const { ProviderRuntimeBridge } = require(path.join(service, "provider-runtime-bridge"));
const { resolveServicePaths } = require(path.join(service, "paths"));
const {
  captureExecutionProviderRoute, assertExecutionProviderRouteCurrent, validateFrozenExecutionProviderRoute,
} = require(path.join(service, "execution-provider-route"));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-provider-contract-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const productStore = new JsonlProductStore({ paths, now: () => 100 }).open();
  const secretStore = await new EncryptedSecretStore({ paths, cryptoBroker: {
    encrypt: async (bytes) => Buffer.from(bytes), decrypt: async (bytes) => Buffer.from(bytes),
  } }).open();
  const secret = "fixture-secret-should-never-appear-in-route";
  await secretStore.put("credential-one", secret, { kind: "custom-responses" });
  const provider = productStore.putModelProvider({ id: "provider-one", kind: "custom-responses", name: "Fixture",
    baseUrl: "https://fixture.invalid/v1", model: "provider-model", models: ["provider-model", "override-model"],
    credentialRef: "credential-one", headers: null, awsRegion: null, awsProfile: null, validationStatus: "unverified" });
  const profile = productStore.putAgentProfile({ ...productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
    providerRef: provider.id, defaultModel: "provider-model" });
  const configured = [];
  const configWriter = { overlay(input) { configured.push(input); return { args: [] }; } };
  const bridge = new ProviderRuntimeBridge({ productStore, secretStore, configWriter });
  const capture = (modelRef = "override-model") => Object.freeze({
    profileId: profile.id, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
    ...captureExecutionProviderRoute({ productStore, secretStore,
      profile: productStore.getAgentProfile(profile.id), modelRef }),
  });
  t.after(async () => { await secretStore.close(); productStore.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { paths, productStore, secretStore, provider, profile, bridge, configured, capture, secret,
    prepare(contract) { return bridge.prepareRuntime({ runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, executionContract: contract }); } };
}

test("frozen route contains bounded identity/revisions/hashes and excludes provider endpoint and secrets", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  assert.equal(Object.isFrozen(contract.provider), true);
  assert.equal(Object.isFrozen(contract.providerFence), true);
  assert.equal(contract.provider.modelRef, "override-model");
  assert.equal(contract.provider.providerRevision, f.productStore.getModelProviderRevision(f.provider.id));
  assert.equal(contract.provider.credentialRevision, f.secretStore.getCredentialRevision("credential-one"));
  const serialized = JSON.stringify(contract);
  for (const text of [f.secret, f.provider.baseUrl, "ciphertext"]) assert.equal(serialized.includes(text), false);
  assert.equal(assertExecutionProviderRouteCurrent(contract, f), true);
  const reordered = { ...contract, provider: Object.fromEntries(Object.entries(contract.provider).reverse()) };
  assert.equal(assertExecutionProviderRouteCurrent(reordered, f), true);
  for (const provider of [{ ...contract.provider, extra: true }, { ...contract.provider, credentialRevision: null },
    { ...contract.provider, providerRevision: -1 }]) {
    assert.throws(() => validateFrozenExecutionProviderRoute({ ...contract, provider }), { code: "EXECUTION_CONTRACT_INVALID" });
  }
  assert.throws(() => validateFrozenExecutionProviderRoute({ ...contract, runtimeAccountId: "other" }),
    { code: "EXECUTION_CONTRACT_INVALID" });
});

test("Provider revision is internal, persists across snapshot/replay, and advances for identical writes and recreation", async (t) => {
  const f = await fixture(t);
  const first = f.productStore.getModelProviderRevision(f.provider.id);
  assert.equal(Object.hasOwn(f.provider, "revision"), false);
  assert.equal(Object.hasOwn(f.productStore.listModelProviders()[0], "revision"), false);
  f.productStore.close(); f.productStore.open();
  assert.equal(f.productStore.getModelProviderRevision(f.provider.id), first);
  f.productStore.putModelProvider(f.provider);
  const second = f.productStore.getModelProviderRevision(f.provider.id);
  assert.ok(second > first);
  const replayed = new JsonlProductStore({ paths: f.paths }).open();
  assert.equal(replayed.getModelProviderRevision(f.provider.id), second);
  replayed.opened = false;
  f.productStore.putAgentProfile({ ...f.profile, providerRef: null });
  f.productStore.deleteModelProvider(f.provider.id);
  f.productStore.putModelProvider(f.provider);
  assert.ok(f.productStore.getModelProviderRevision(f.provider.id) > second);
});

test("provider switch while loading a Secret fails before writing runtime config", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  const get = f.secretStore.get.bind(f.secretStore);
  f.secretStore.get = async (ref) => {
    const plaintext = await get(ref);
    f.productStore.putAgentProfile({ ...f.profile, providerRef: null });
    return plaintext;
  };
  await assert.rejects(f.prepare(contract), { code: "EXECUTION_CONTRACT_STALE" });
  assert.equal(f.configured.length, 0);
});

test("credential rotation while loading a Secret rejects the old run rather than loading the new credential", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  const get = f.secretStore.get.bind(f.secretStore);
  f.secretStore.get = async (ref) => {
    const plaintext = await get(ref);
    await f.secretStore.put(ref, "rotated-secret-never-accepted-by-old-run", { kind: "custom-responses" });
    return plaintext;
  };
  await assert.rejects(f.prepare(contract), { code: "EXECUTION_CONTRACT_STALE" });
  assert.equal(f.configured.length, 0);
});

test("frozen model reaches runtime config; the returned pre-spawn fence detects later changes", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  const prepared = await f.prepare(contract);
  assert.equal(prepared.runtimeConfig.provider.model, "override-model");
  assert.deepEqual(prepared.executionProviderRoute, validateFrozenExecutionProviderRoute(contract));
  assert.equal(prepared.assertCurrent(), true);
  f.productStore.putModelProvider({ ...f.provider, model: "override-model" });
  assert.throws(() => prepared.assertCurrent(), { code: "EXECUTION_CONTRACT_STALE" });
  await assert.rejects(f.prepare(contract), { code: "EXECUTION_CONTRACT_STALE" });
});

test("account changes and profile defaults cannot silently replace a frozen route", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  const account = f.productStore.getRuntimeAccount(f.profile.runtimeAccountId);
  f.productStore.putRuntimeAccount({ ...account, maxActive: 2 });
  assert.throws(() => assertExecutionProviderRouteCurrent(contract, f), { code: "EXECUTION_CONTRACT_STALE" });
  const current = f.capture();
  f.productStore.putAgentProfile({ ...f.profile, defaultModel: "override-model" });
  await assert.rejects(f.prepare(current), { code: "EXECUTION_CONTRACT_STALE" });
});

test("existing encrypted container revision conservatively invalidates routes on unrelated credential writes", async (t) => {
  const f = await fixture(t);
  const contract = f.capture();
  await f.secretStore.put("unrelated-credential", "unrelated-test-secret", { kind: "openrouter" });
  assert.throws(() => assertExecutionProviderRouteCurrent(contract, f), { code: "EXECUTION_CONTRACT_STALE" });
  const fresh = await f.prepare(f.capture());
  assert.equal(fresh.assertCurrent(), true);
});

test("native CLI default is represented by null without claiming an external credential revision", async (t) => {
  const f = await fixture(t);
  f.productStore.putAgentProfile({ ...f.profile, providerRef: null, defaultModel: null });
  const contract = f.capture(null);
  assert.deepEqual(contract.provider, { providerRef: null, providerRevision: null,
    credentialRef: null, credentialRevision: null, modelRef: null });
  const prepared = await f.prepare(contract);
  assert.equal(prepared.runtimeConfig, null);
  assert.deepEqual(prepared.spawnEnv, {});
  assert.equal(prepared.assertCurrent(), true);
});
