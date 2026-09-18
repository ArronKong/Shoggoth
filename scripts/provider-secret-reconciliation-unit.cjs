#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  reconcileProviderCredentialSecrets,
} = require(path.join(ROOT, "app", "agent-service", "provider-secret-reconciliation.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function provider(credentialRef) {
  return { credentialRef };
}

function secretStoreFixture(metadata, deleteImpl = null) {
  const entries = metadata.map((entry) => ({ ...entry }));
  const deleted = [];
  return {
    deleted,
    listMetadata() { return entries.map((entry) => ({ ...entry })); },
    async delete(credentialRef) {
      deleted.push(credentialRef);
      if (deleteImpl) return deleteImpl(credentialRef, entries);
      const index = entries.findIndex((entry) => entry.credentialRef === credentialRef);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    },
  };
}

test("只清理 Provider 管理命名空间内且没有 ModelProvider owner 的密文", async () => {
  const productStore = {
    listModelProviders: () => [
      provider("provider-credential-owned-a"),
      provider("provider-credential-owned-b"),
      provider("legacy-credential-owned"),
      provider(null),
    ],
  };
  const secretStore = secretStoreFixture([
    { credentialRef: "provider-credential-owned-a", kind: "openai-api-key" },
    { credentialRef: "provider-credential-orphan-a", kind: "openrouter" },
    { credentialRef: "legacy-credential-orphan", kind: "openrouter" },
    { credentialRef: "provider-credential-owned-b", kind: "custom-responses" },
    { credentialRef: "provider-credential-orphan-b", kind: "openai-api-key" },
  ]);

  assert.deepEqual(
    await reconcileProviderCredentialSecrets({ productStore, secretStore }),
    { ownedCredentialCount: 3, deletedCredentialCount: 2 },
  );
  assert.deepEqual(secretStore.deleted, [
    "provider-credential-orphan-a",
    "provider-credential-orphan-b",
  ]);
  assert.deepEqual(secretStore.listMetadata().map((entry) => entry.credentialRef), [
    "provider-credential-owned-a",
    "legacy-credential-orphan",
    "provider-credential-owned-b",
  ]);
});

test("delete commit uncertain 会阻止启动对账继续且错误不携带底层 secret", async () => {
  const plaintextCanary = "plaintext-provider-secret-must-not-leak";
  const secretStore = secretStoreFixture([
    { credentialRef: "provider-credential-orphan-a", kind: "openai-api-key" },
    { credentialRef: "provider-credential-orphan-b", kind: "openai-api-key" },
  ], async () => {
    const error = new Error(plaintextCanary);
    error.code = "SECRET_COMMIT_UNCERTAIN";
    throw error;
  });

  await assert.rejects(
    reconcileProviderCredentialSecrets({
      productStore: { listModelProviders: () => [] },
      secretStore,
    }),
    (error) => error.code === "PROVIDER_SECRET_RECONCILIATION_FAILED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(plaintextCanary),
  );
  assert.deepEqual(secretStore.deleted, ["provider-credential-orphan-a"]);
});

test("delete 静默未提交也由二次 metadata 校验 fail closed", async () => {
  const secretStore = secretStoreFixture([
    { credentialRef: "provider-credential-orphan", kind: "openrouter" },
  ], async () => false);

  await assert.rejects(
    reconcileProviderCredentialSecrets({
      productStore: { listModelProviders: () => [] },
      secretStore,
    }),
    (error) => error.code === "PROVIDER_SECRET_RECONCILIATION_FAILED",
  );
  assert.deepEqual(secretStore.deleted, ["provider-credential-orphan"]);
});

test("不可信 ownership/metadata 形状拒绝清理", async () => {
  for (const fixture of [
    {
      productStore: { listModelProviders: () => [{ credentialRef: undefined }] },
      secretStore: secretStoreFixture([
        { credentialRef: "provider-credential-orphan", kind: "openrouter" },
      ]),
    },
    {
      productStore: { listModelProviders: () => [] },
      secretStore: { listMetadata: () => [{ credentialRef: null }], delete: async () => true },
    },
  ]) {
    await assert.rejects(
      reconcileProviderCredentialSecrets(fixture),
      (error) => error.code === "PROVIDER_SECRET_RECONCILIATION_FAILED",
    );
    assert.deepEqual(fixture.secretStore.deleted || [], []);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS provider secret reconciliation unit (${tests.length})`);
})();
