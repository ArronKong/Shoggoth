#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { EncryptedSecretStore } = require(path.join(
  ROOT, "app", "agent-service", "encrypted-secret-store.js",
));
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));

let ProviderService;
let buildProviderPreset;
let CodexProviderProtocolValidator;
let moduleLoadError = null;
try {
  ({ CodexProviderProtocolValidator, ProviderService, buildProviderPreset } = require(path.join(
    ROOT, "app", "agent-service", "codex-provider-service.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function xorCipher(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0x5a;
  return bytes;
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => xorCipher(value),
    decryptString: (bytes) => xorCipher(Buffer.from(bytes)).toString("utf8"),
  };
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-provider-service-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const productStore = new JsonlProductStore({ paths });
  const secretStore = new EncryptedSecretStore({ paths, safeStorage: safeStorage() });
  secretStore.open();
  productStore.setSensitiveValueMatcherSessionFactory(
    (action) => secretStore.withPlaintextMatcher(action),
  );
  productStore.open();
  let sequence = 0;
  const service = new ProviderService({
    productStore,
    secretStore,
    publicProductUrl: "https://product.test/shoggoth",
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    runtimePool: options.runtimePool,
    protocolValidator: options.protocolValidator
      || (async () => ({ parsedBy: "codex-0.149.0" })),
  });
  return { root, paths, productStore, secretStore, service };
}

test("OpenAI bootstrap capability 支持默认 Profile 首配与轮换，并以可补偿密文暂存 key", async () => {
  const calls = [];
  const runtimePool = {
    async stop(runtimeProfileId) { calls.push(["stop", runtimeProfileId]); },
  };
  const value = fixture({ runtimePool });
  const secret = "openai-bootstrap-secret-canary-000001";
  try {
    const saved = await value.service.save(input("openai-api-key", { model: "gpt-5" }));
    const profile = value.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    assert.equal(profile.providerRef, null);
    assert.equal(Object.isFrozen(value.service.profileBootstrapCapability), true);
    const prepared = await value.service.profileBootstrapCapability.configureOpenAiApiKey({
      profile,
      provider: saved,
      defaultModel: "gpt-5",
      secret,
      assertCurrent() {},
    });
    assert.equal(prepared.provider.validationStatus, "protocol_valid");
    assert.match(prepared.provider.credentialRef, /^provider-credential-/u);
    assert.equal(JSON.stringify(prepared).includes(secret), false);
    assert.equal(value.productStore.getModelProvider(saved.id).validationStatus, "protocol_valid");
    assert.deepEqual(value.secretStore.listMetadata(), [{
      credentialRef: prepared.provider.credentialRef,
      kind: "openai-api-key",
    }]);
    await prepared.compensate();
    assert.deepEqual(value.productStore.getModelProvider(saved.id), saved);
    assert.deepEqual(value.secretStore.listMetadata(), []);
    assert.deepEqual(calls, []);

    value.productStore.putAgentProfile({
      ...profile, providerRef: saved.id, defaultModel: "gpt-5",
    });
    const rotatedInput = Object.freeze({
      profile: value.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
      provider: value.productStore.getModelProvider(saved.id),
      defaultModel: "gpt-5",
      secret: "openai-bootstrap-rotated-canary-000002",
      assertCurrent() {},
    });
    const rotated = await value.service.profileBootstrapCapability.configureOpenAiApiKey(rotatedInput);
    assert.notEqual(rotated.provider.credentialRef, saved.credentialRef);
    assert.equal(rotatedInput.secret, "openai-bootstrap-rotated-canary-000002");
    await rotated.compensate();
  } finally {
    await closeFixture(value);
  }
});

test("OpenAI bootstrap commit 删除旧 credential，仅保留新密文", async () => {
  const value = fixture();
  const oldSecret = "openai-bootstrap-old-secret-000001";
  const newSecret = "openai-bootstrap-new-secret-000002";
  try {
    await value.service.save(input("openai-api-key", { model: "gpt-5" }));
    const before = await value.service.setSecret({
      providerId: "provider-openai-api-key",
      secret: oldSecret,
    });
    const profileBefore = value.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const prepared = await value.service.profileBootstrapCapability.configureOpenAiApiKey({
      profile: profileBefore,
      provider: before,
      defaultModel: "gpt-5",
      secret: newSecret,
      assertCurrent() {},
    });

    value.productStore.putAgentProfile({
      ...profileBefore,
      providerRef: prepared.provider.id,
      defaultModel: "gpt-5",
    });
    await prepared.commit();

    assert.equal(await value.secretStore.get(before.credentialRef), null);
    assert.equal(await value.secretStore.get(prepared.provider.credentialRef), newSecret);
    assert.deepEqual(value.secretStore.listMetadata(), [{
      credentialRef: prepared.provider.credentialRef,
      kind: "openai-api-key",
    }]);
  } finally {
    await closeFixture(value);
  }
});

test("OpenAI bootstrap compensation 恢复旧 credential 引用与密文", async () => {
  const value = fixture();
  const oldSecret = "openai-bootstrap-compensate-old-000001";
  try {
    await value.service.save(input("openai-api-key", { model: "gpt-5" }));
    const before = await value.service.setSecret({
      providerId: "provider-openai-api-key",
      secret: oldSecret,
    });
    const prepared = await value.service.profileBootstrapCapability.configureOpenAiApiKey({
      profile: value.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
      provider: before,
      defaultModel: "gpt-5",
      secret: "openai-bootstrap-compensate-new-000002",
      assertCurrent() {},
    });
    const newCredentialRef = prepared.provider.credentialRef;

    await prepared.compensate();

    assert.deepEqual(value.productStore.getModelProvider(before.id), before);
    assert.equal(await value.secretStore.get(before.credentialRef), oldSecret);
    assert.equal(await value.secretStore.get(newCredentialRef), null);
    assert.deepEqual(value.secretStore.listMetadata(), [{
      credentialRef: before.credentialRef,
      kind: "openai-api-key",
    }]);
  } finally {
    await closeFixture(value);
  }
});

test("两个共享内部 RuntimeAccount 的非默认 Profile 独立首配、轮换、清除 OpenAI key", async () => {
  const value = fixture({ runtimePool: { async stop() {} } });
  try {
    const providerA = await value.service.save({
      ...input("openai-api-key", { model: "gpt-5" }),
      id: "provider-openai-profile-a",
    });
    const providerB = await value.service.save({
      ...input("openai-api-key", { model: "gpt-5-mini" }),
      id: "provider-openai-profile-b",
    });
    value.productStore.putAgentProfile(profile("profile-openai-a", "runtime-openai-a", null));
    value.productStore.putAgentProfile(profile("profile-openai-b", "runtime-openai-b", null));

    const prepare = async (profileId, providerId, model, secret) => {
      const prepared = await value.service.profileBootstrapCapability.configureOpenAiApiKey({
        profile: value.productStore.getAgentProfile(profileId),
        provider: value.productStore.getModelProvider(providerId),
        defaultModel: model,
        secret,
        assertCurrent() {},
      });
      const before = value.productStore.getAgentProfile(profileId);
      value.productStore.putAgentProfile({
        ...before,
        providerRef: providerId,
        defaultModel: model,
      });
      await prepared.commit();
      return prepared.provider;
    };
    const firstA = await prepare(
      "profile-openai-a", providerA.id, "gpt-5", "profile-a-openai-key-000001",
    );
    const firstB = await prepare(
      "profile-openai-b", providerB.id, "gpt-5-mini", "profile-b-openai-key-000001",
    );
    assert.equal(await value.secretStore.get(firstA.credentialRef), "profile-a-openai-key-000001");
    assert.equal(await value.secretStore.get(firstB.credentialRef), "profile-b-openai-key-000001");

    const rotatedA = await value.service.profileBootstrapCapability.configureOpenAiApiKey({
      profile: value.productStore.getAgentProfile("profile-openai-a"),
      provider: value.productStore.getModelProvider(providerA.id),
      defaultModel: "gpt-5",
      secret: "profile-a-openai-key-000002",
      assertCurrent() {},
    });
    await rotatedA.commit();
    assert.equal(await value.secretStore.get(firstA.credentialRef), null);
    assert.equal(await value.secretStore.get(rotatedA.provider.credentialRef), "profile-a-openai-key-000002");
    assert.equal(await value.secretStore.get(firstB.credentialRef), "profile-b-openai-key-000001");

    await assert.rejects(
      value.service.profileBootstrapCapability.configureOpenAiApiKey({
        profile: value.productStore.getAgentProfile("profile-openai-a"),
        provider: value.productStore.getModelProvider(providerB.id),
        defaultModel: "gpt-5-mini",
        secret: "must-not-cross-profile-boundary",
        assertCurrent() {},
      }),
      (error) => error.code === "PROVIDER_RUNTIME_PROFILE_MISMATCH",
    );

    const profileA = value.productStore.getAgentProfile("profile-openai-a");
    const clearedProfileA = value.productStore.putAgentProfile({
      ...profileA,
      providerRef: null,
      defaultModel: null,
    });
    assert.deepEqual(
      await value.service.profileBootstrapCapability.clearUnreferencedOpenAiApiKey({
        profile: clearedProfileA,
        providerRef: providerA.id,
        assertCurrent() {},
      }),
      { cleared: true },
    );
    assert.equal(await value.secretStore.get(rotatedA.provider.credentialRef), null);
    assert.equal(await value.secretStore.get(firstB.credentialRef), "profile-b-openai-key-000001");

    const unauthorized = value.productStore.putAgentProfile({
      ...profile("profile-native-codex", "runtime-native-codex", null),
      backendId: "shoggoth",
      runtimeAccountId: "native-codex-default-v1",
    });
    await assert.rejects(
      value.service.profileBootstrapCapability.configureOpenAiApiKey({
        profile: unauthorized,
        provider: value.productStore.getModelProvider(providerA.id),
        defaultModel: "gpt-5",
        secret: "must-not-configure-native-profile",
        assertCurrent() {},
      }),
      (error) => error.code === "PROVIDER_RUNTIME_PROFILE_MISMATCH",
    );
  } finally {
    await closeFixture(value);
  }
});

async function closeFixture(value) {
  if (typeof value.service?.close === "function") await value.service.close();
  await value.secretStore.close();
  value.productStore.close();
}

function input(kind, overrides = {}) {
  return {
    id: `provider-${kind}`,
    kind,
    name: kind,
    model: "fixture/model",
    ...overrides,
  };
}

function profile(id, runtimeProfileId, providerRef) {
  return {
    id,
    backendId: "shoggoth",
    agentId: id,
    name: id,
    runtime: "codex",
    runtimeProfileId,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

test("ProviderService/preset 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof ProviderService, "function");
  assert.equal(typeof buildProviderPreset, "function");
  assert.equal(typeof CodexProviderProtocolValidator, "function");
});

test("默认 protocol validator 只启动本地 Codex 0.149.0 parser", async () => {
  const validator = new CodexProviderProtocolValidator({ repoRoot: ROOT });
  assert.deepEqual(await validator.validate(buildProviderPreset(input("ollama"), {})), {
    parsedBy: "codex-0.149.0",
  });
});

test("六种 preset 生成不可覆盖的准确持久化字段", () => {
  const options = { publicProductUrl: "https://product.test/shoggoth" };
  const expected = [
    ["openai-api-key", null, null, null, null],
    ["openrouter", "https://openrouter.ai/api/v1", {
      "HTTP-Referer": "https://product.test/shoggoth",
      "X-OpenRouter-Title": "Shoggoth",
    }, null, null],
    ["ollama", "http://127.0.0.1:11434/v1", null, null, null],
    ["lmstudio", "http://127.0.0.1:1234/v1", null, null, null],
  ];
  for (const [kind, baseUrl, headers, awsRegion, awsProfile] of expected) {
    assert.deepEqual(buildProviderPreset(input(kind), options), {
      ...input(kind), baseUrl, credentialRef: null, headers, awsRegion, awsProfile,
      validationStatus: "unverified",
    });
  }
  assert.deepEqual(buildProviderPreset(input("custom-responses", {
    baseUrl: "https://gateway.test/openai/v1/",
    headers: { "X-Tenant": "fixture" },
  }), options), {
    ...input("custom-responses"),
    baseUrl: "https://gateway.test/openai/v1",
    credentialRef: null,
    headers: { "X-Tenant": "fixture" },
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
  });
  assert.deepEqual(buildProviderPreset(input("amazon-bedrock", {
    awsRegion: "us-west-2", awsProfile: "engineering-dev",
  }), options), {
    ...input("amazon-bedrock"),
    baseUrl: null,
    credentialRef: null,
    headers: null,
    awsRegion: "us-west-2",
    awsProfile: "engineering-dev",
    validationStatus: "unverified",
  });
});

test("OpenRouter 缺正式 HTTPS publicProductUrl fail closed，固定字段不允许覆盖", () => {
  for (const publicProductUrl of [
    undefined, null, "", "http://product.test/shoggoth", "https://example",
  ]) {
    assert.throws(
      () => buildProviderPreset(input("openrouter"), { publicProductUrl }),
      (error) => error.code === "PROVIDER_PUBLIC_PRODUCT_URL_REQUIRED",
    );
  }
  for (const override of [
    { baseUrl: "https://gateway.test/v1" },
    { headers: { "X-OpenRouter-Title": "Other" } },
    { awsRegion: "us-east-1" },
    { credentialRef: "forged-ref" },
    { validationStatus: "agent_compatible" },
  ]) {
    assert.throws(
      () => buildProviderPreset(input("openrouter", override), {
        publicProductUrl: "https://product.test/shoggoth",
      }),
      (error) => error.code === "PROVIDER_PRESET_OVERRIDE_FORBIDDEN",
    );
  }
});

test("custom-responses 只接受 API root，拒绝已拼接 endpoint", () => {
  for (const baseUrl of [
    "https://gateway.test/v1/responses",
    "https://gateway.test/v1/responses/",
    "https://gateway.test/v1/chat/completions",
    "https://gateway.test/v1/chat/completions/",
    "https://gateway.test/v1/%72esponses",
    "https://gateway.test/v1/%2572esponses",
  ]) {
    assert.throws(
      () => buildProviderPreset(input("custom-responses", { baseUrl }), {}),
      (error) => error.code === "PROVIDER_BASE_URL_ENDPOINT_FORBIDDEN",
    );
  }
  assert.throws(
    () => buildProviderPreset(input("custom-responses", {
      baseUrl: "https://gateway.test/v1/%E0%A4%A",
    }), {}),
    (error) => error.code === "PROVIDER_BASE_URL_INVALID",
  );
  for (const baseUrl of [
    "https://gateway.test/v1/%2Fresponses",
    "https://gateway.test/v1/chat%2Fcompletions",
    "https://gateway.test/v1/%252Fresponses",
    "https://gateway.test/v1/chat%252Fcompletions",
  ]) {
    assert.throws(
      () => buildProviderPreset(input("custom-responses", { baseUrl }), {}),
      (error) => ["PROVIDER_BASE_URL_INVALID", "PROVIDER_BASE_URL_ENDPOINT_FORBIDDEN"]
        .includes(error.code),
    );
  }
  for (const baseUrl of [
    "https://gateway.test/v1/%2Fmodels",
    "https://gateway.test/v1/%2fmodels",
    "https://gateway.test/v1/%252Fmodels",
    "https://gateway.test/v1/%252fmodels",
    "https://gateway.test/v1/%25252Fmodels",
    "https://gateway.test/v1/models%2Fdetail",
    "https://gateway.test/v1%5cresponses",
    "https://gateway.test/v1%255cresponses",
    "https://gateway.test/v1%5cchat%5ccompletions",
    "https://gateway.test/v1%255cchat%255ccompletions",
    "https://gateway.test/v1%00models",
    "https://gateway.test/v1%2500models",
    "https://gateway.test/v1%1fmodels",
    "https://gateway.test/v1%251fmodels",
    "https://gateway.test/v1\nmodels",
    "https://gateway.test/v1/./models",
    "https://gateway.test/v1/../models",
    "https://gateway.test/v1/%2e/models",
    "https://gateway.test/v1/%2E%2e/models",
    "https://gateway.test/v1/%252e/models",
    "https://gateway.test/v1/%252e%252e/models",
    "https://gateway.test/v1/responses/%252e",
    "https://gateway.test/v1/chat/completions/%252e",
  ]) {
    assert.throws(
      () => buildProviderPreset(input("custom-responses", { baseUrl }), {}),
      (error) => error.code === "PROVIDER_BASE_URL_INVALID",
    );
  }
  assert.equal(buildProviderPreset(input("custom-responses", {
    baseUrl: "https://gateway.test/v1/models",
  }), {}).baseUrl, "https://gateway.test/v1/models");
  assert.equal(buildProviderPreset(input("custom-responses", {
    baseUrl: "https://gateway.test/v1/models.json",
  }), {}).baseUrl, "https://gateway.test/v1/models.json");
  assert.equal(buildProviderPreset(input("custom-responses", {
    baseUrl: "https://gateway.test/v1/.well-known/models",
  }), {}).baseUrl, "https://gateway.test/v1/.well-known/models");
});

test("用户 save 不能伪造成功态；相同配置保留状态，配置变化重置 unverified", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("ollama"));
    value.productStore.putModelProvider({ ...saved, validationStatus: "protocol_valid" });
    assert.equal((await value.service.save(input("ollama"))).validationStatus, "protocol_valid");
    assert.equal((await value.service.save(input("ollama", { model: "fixture/changed" }))).validationStatus, "unverified");
    await assert.rejects(
      value.service.save(input("ollama", { validationStatus: "agent_compatible" })),
      (error) => error.code === "PROVIDER_PRESET_OVERRIDE_FORBIDDEN",
    );
  } finally {
    await closeFixture(value);
  }
});

test("既有 Provider ID 的 kind 不可原地切换，避免 credentialRef 跨 authority 复用", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("custom-responses", { baseUrl: "https://gateway.test/v1" }));
    await value.service.setSecret({
      providerId: saved.id, secret: "kind-binding-secret-000001",
    });
    await assert.rejects(
      value.service.save({
        id: saved.id, kind: "ollama", name: "Ollama", model: "fixture/model",
      }),
      (error) => error.code === "PROVIDER_KIND_IMMUTABLE",
    );
    assert.equal(value.productStore.getModelProvider(saved.id).kind, "custom-responses");
  } finally {
    await closeFixture(value);
  }
});

test("custom secret replacement 使用新 credentialRef 后切换引用并删除旧值", async () => {
  const value = fixture();
  try {
    await value.service.save(input("custom-responses", { baseUrl: "https://gateway.test/v1" }));
    const first = await value.service.setSecret({
      providerId: "provider-custom-responses", secret: "first-provider-secret-000001",
    });
    assert.match(first.credentialRef, /^provider-credential-/u);
    assert.equal(value.productStore.getModelProvider(first.id).validationStatus, "unverified");
    value.productStore.putModelProvider({ ...first, validationStatus: "protocol_valid" });
    const second = await value.service.setSecret({
      providerId: first.id, secret: "second-provider-secret-000002",
    });
    assert.notEqual(second.credentialRef, first.credentialRef);
    assert.equal(second.validationStatus, "unverified");
    assert.deepEqual(value.secretStore.listMetadata(), [{
      credentialRef: second.credentialRef, kind: "custom-responses",
    }]);
    assert.equal(await value.secretStore.get(first.credentialRef), null);
    assert.equal(await value.secretStore.get(second.credentialRef), "second-provider-secret-000002");
  } finally {
    await closeFixture(value);
  }
});

test("六种 preset 仅在 runtime-material 变化时停止全部绑定 runtime", async () => {
  const cases = [
    { kind: "openai-api-key", initial: { model: "fixture/model-a" }, changed: { model: "fixture/model-b" } },
    { kind: "openrouter", initial: { model: "fixture/model-a" }, changed: { model: "fixture/model-b" } },
    { kind: "ollama", initial: { model: "fixture/model-a" }, changed: { model: "fixture/model-b" } },
    { kind: "lmstudio", initial: { model: "fixture/model-a" }, changed: { model: "fixture/model-b" } },
    {
      kind: "custom-responses",
      initial: { model: "fixture/model-a", baseUrl: "https://gateway.test/v1" },
      changed: { model: "fixture/model-a", baseUrl: "https://gateway.test/openai/v1" },
    },
    {
      kind: "amazon-bedrock",
      initial: { model: "fixture/model-a", awsRegion: "us-east-1", awsProfile: "fixture-old" },
      changed: { model: "fixture/model-a", awsRegion: "us-west-2", awsProfile: "fixture-new" },
    },
  ];
  const observed = [];
  for (const entry of cases) {
    const value = fixture();
    const stops = [];
    value.service = new ProviderService({
      productStore: value.productStore,
      secretStore: value.secretStore,
      publicProductUrl: "https://product.test/shoggoth",
      runtimePool: {
        async stop(runtimeProfileId) { stops.push(runtimeProfileId); },
      },
      protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
    });
    try {
      const saved = await value.service.save(input(entry.kind, entry.initial));
      value.productStore.putAgentProfile(profile(
        `profile-${entry.kind}-a`, `runtime-${entry.kind}-a`, saved.id,
      ));
      value.productStore.putAgentProfile(profile(
        `profile-${entry.kind}-b`, `runtime-${entry.kind}-b`, saved.id,
      ));

      await value.service.save(input(entry.kind, entry.initial));
      const unchangedStops = stops.splice(0);
      await value.service.save(input(entry.kind, entry.changed));
      observed.push({
        kind: entry.kind,
        unchangedStops,
        changedStops: stops.splice(0).sort(),
      });
    } finally {
      await closeFixture(value);
    }
  }
  assert.deepEqual(observed, cases.map(({ kind }) => ({
    kind,
    unchangedStops: [],
    changedStops: [`runtime-${kind}-a`, `runtime-${kind}-b`],
  })));
});

test("custom config/secret/clear 变更停止全部绑定 runtime 后才删除旧 secret", async () => {
  const value = fixture();
  const events = [];
  value.service = new ProviderService({
    productStore: value.productStore,
    secretStore: value.secretStore,
    publicProductUrl: "https://product.test/shoggoth",
    randomUUID: (() => {
      let sequence = 100;
      return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    })(),
    runtimePool: {
      async stop(runtimeProfileId) { events.push(["stop", runtimeProfileId]); },
    },
    protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
  });
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    value.productStore.putAgentProfile(profile("profile-custom-a", "runtime-custom-a", saved.id));
    value.productStore.putAgentProfile(profile("profile-custom-b", "runtime-custom-b", saved.id));

    await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/openai/v1",
    }));
    assert.deepEqual(new Set(events.map((entry) => entry[1])), new Set([
      "runtime-custom-a", "runtime-custom-b",
    ]));
    events.length = 0;
    await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/openai/v1",
      model: "fixture/changed-model",
    }));
    assert.deepEqual(new Set(events.map((entry) => entry[1])), new Set([
      "runtime-custom-a", "runtime-custom-b",
    ]));

    await value.service.setSecret({ providerId: saved.id, secret: "custom-converge-old-secret-000001" });
    const oldRef = value.productStore.getModelProvider(saved.id).credentialRef;
    events.length = 0;
    const originalDelete = value.secretStore.delete.bind(value.secretStore);
    value.secretStore.delete = async (credentialRef) => {
      events.push(["delete", credentialRef]);
      assert.equal(events.filter(([type]) => type === "stop").length, 2);
      return originalDelete(credentialRef);
    };
    await value.service.setSecret({ providerId: saved.id, secret: "custom-converge-new-secret-000002" });
    assert.equal(events.at(-1)[0], "delete");
    assert.equal(events.at(-1)[1], oldRef);

    const currentRef = value.productStore.getModelProvider(saved.id).credentialRef;
    events.length = 0;
    await value.service.clearSecret({ providerId: saved.id });
    assert.equal(events.at(-1)[0], "delete");
    assert.equal(events.at(-1)[1], currentRef);
  } finally {
    await closeFixture(value);
  }
});

test("custom runtime stop 不确定时保留新旧 secret 证据并 poison", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    const first = await value.service.setSecret({
      providerId: saved.id, secret: "custom-stop-old-secret-000001",
    });
    value.productStore.putAgentProfile(profile("profile-stop-failure", "runtime-stop-failure", saved.id));
    value.service = new ProviderService({
      productStore: value.productStore,
      secretStore: value.secretStore,
      runtimePool: {
        async stop() {
          throw Object.assign(new Error("runtime stop detail"), { code: "CODEX_RUNTIME_STOP_FAILED" });
        },
      },
      randomUUID: () => "00000000-0000-4000-8000-000000000999",
      protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
    });
    await assert.rejects(
      value.service.setSecret({
        providerId: saved.id, secret: "custom-stop-new-secret-000002",
      }),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN"
        && !error.message.includes("runtime stop detail"),
    );
    const refs = value.secretStore.listMetadata().map((entry) => entry.credentialRef);
    assert.equal(refs.length, 2);
    assert.equal(refs.includes(first.credentialRef), true);
    assert.throws(() => value.service.list(), (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN");
  } finally {
    await closeFixture(value);
  }
});

test("custom clear 已确认停止 runtime 后即使 delete generation 变 stale 也不留旧 secret orphan", async () => {
  const value = fixture();
  const stopStarted = deferred();
  const releaseStop = deferred();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    await value.service.setSecret({
      providerId: saved.id, secret: "custom-clear-stale-secret-000001",
    });
    value.productStore.putAgentProfile(profile("profile-clear-stale", "runtime-clear-stale", saved.id));
    value.service = new ProviderService({
      productStore: value.productStore,
      secretStore: value.secretStore,
      runtimePool: {
        async stop() {
          stopStarted.resolve();
          await releaseStop.promise;
        },
      },
      protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
    });
    const clearing = value.service.clearSecret({ providerId: saved.id });
    await stopStarted.promise;
    const deleting = value.service.delete({ providerId: saved.id });
    const deletionOutcome = deleting.catch((error) => error);
    releaseStop.resolve();
    await assert.rejects(clearing, (error) => error.code === "PROVIDER_OPERATION_STALE");
    assert.equal((await deletionOutcome).code, "MODEL_PROVIDER_IN_USE");
    assert.deepEqual(value.secretStore.listMetadata(), []);
  } finally {
    await closeFixture(value);
  }
});

test("Ollama/LM Studio 固定为本地无凭据 preset", async () => {
  const value = fixture();
  try {
    for (const kind of ["ollama", "lmstudio"]) {
      const saved = await value.service.save(input(kind));
      await assert.rejects(
        value.service.setSecret({ providerId: saved.id, secret: "local-secret-forbidden-000001" }),
        (error) => error.code === "PROVIDER_SECRET_AUTHORITY_FORBIDDEN",
      );
      assert.equal(value.productStore.getModelProvider(saved.id).credentialRef, null);
    }
    assert.deepEqual(value.secretStore.listMetadata(), []);
  } finally {
    await closeFixture(value);
  }
});

test("OpenAI credential 加密轮换与清除不获取 Host，不调用 account login/logout", async () => {
  const value = fixture();
  const hostCalls = [];
  const stops = [];
  value.service = new ProviderService({
    productStore: value.productStore,
    secretStore: value.secretStore,
    runtimePool: {
      async get(runtimeProfileId) {
        hostCalls.push(["get", runtimeProfileId]);
        return {
          async accountLoginApiKey() { hostCalls.push(["login"]); },
          async accountLogout() { hostCalls.push(["logout"]); },
        };
      },
      async stop(runtimeProfileId) { stops.push(runtimeProfileId); },
    },
    protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
  });
  const firstCanary = "openai-runtime-key-canary-00000001";
  const secondCanary = "openai-runtime-key-canary-00000002";
  try {
    await value.service.save(input("openai-api-key"));
    value.productStore.putAgentProfile(profile(
      "profile-openai", "runtime-openai", "provider-openai-api-key",
    ));
    const first = await value.service.setSecret(Object.freeze({
      providerId: "provider-openai-api-key",
      secret: firstCanary,
    }));
    const second = await value.service.setSecret(Object.freeze({
      providerId: "provider-openai-api-key",
      secret: secondCanary,
    }));
    assert.match(first.credentialRef, /^provider-credential-/u);
    assert.match(second.credentialRef, /^provider-credential-/u);
    assert.notEqual(second.credentialRef, first.credentialRef);
    assert.equal(second.validationStatus, "unverified");
    assert.equal(await value.secretStore.get(first.credentialRef), null);
    assert.equal(await value.secretStore.get(second.credentialRef), secondCanary);
    assert.deepEqual(value.secretStore.listMetadata(), [{
      credentialRef: second.credentialRef,
      kind: "openai-api-key",
    }]);
    assert.equal(JSON.stringify(value.productStore.listModelProviders()).includes(firstCanary), false);
    assert.equal(JSON.stringify(value.productStore.listModelProviders()).includes(secondCanary), false);
    const stateBytes = fs.readdirSync(value.paths.stateDir)
      .filter((name) => fs.statSync(path.join(value.paths.stateDir, name)).isFile())
      .map((name) => fs.readFileSync(path.join(value.paths.stateDir, name)))
      .reduce((total, bytes) => Buffer.concat([total, bytes]), Buffer.alloc(0));
    assert.equal(stateBytes.includes(Buffer.from(firstCanary)), false);
    assert.equal(stateBytes.includes(Buffer.from(secondCanary)), false);
    assert.equal(fs.existsSync(value.paths.accountAuthStatePath), false);
    await value.service.clearSecret({ providerId: "provider-openai-api-key" });
    assert.deepEqual(hostCalls, []);
    assert.deepEqual(stops, ["runtime-openai", "runtime-openai", "runtime-openai"]);
    assert.equal(value.productStore.getModelProvider(second.id).credentialRef, null);
    assert.deepEqual(value.secretStore.listMetadata(), []);
  } finally {
    await closeFixture(value);
  }
});

test("Provider secret API 拒绝旧版 runtimeProfileId 参数且不获取 Host", async () => {
  const value = fixture();
  const calls = [];
  value.service = new ProviderService({
    productStore: value.productStore,
    secretStore: value.secretStore,
    runtimePool: {
      async get(runtimeProfileId) {
        calls.push(["get", runtimeProfileId]);
        return { accountLoginApiKey: async () => ({ type: "apiKey" }), accountLogout: async () => ({}) };
      },
    },
    protocolValidator: async () => ({ parsedBy: "codex-0.149.0" }),
  });
  try {
    await value.service.save(input("openai-api-key"));
    await value.service.save(input("ollama"));
    value.productStore.putAgentProfile(profile(
      "profile-wrong-provider", "runtime-wrong-provider", "provider-ollama",
    ));
    for (const action of [
      () => value.service.setSecret({
        providerId: "provider-openai-api-key",
        runtimeProfileId: "runtime-missing",
        secret: "openai-binding-secret-000001",
      }),
      () => value.service.setSecret({
        providerId: "provider-openai-api-key",
        runtimeProfileId: "runtime-wrong-provider",
        secret: "openai-binding-secret-000002",
      }),
      () => value.service.clearSecret({
        providerId: "provider-openai-api-key",
        runtimeProfileId: "runtime-wrong-provider",
      }),
    ]) {
      await assert.rejects(action(), (error) => error.code === "PROVIDER_SECRET_PARAMS_INVALID");
    }
    assert.deepEqual(calls, []);
  } finally {
    await closeFixture(value);
  }
});

test("known ProductStore 失败后的 secret rollback uncertain 聚合主错并 poison", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    const primary = Object.assign(new Error("primary product-store failure"), {
      code: "STORE_WRITE_REJECTED",
    });
    const rollback = Object.assign(new Error("rollback secret commit uncertain"), {
      code: "SECRET_COMMIT_UNCERTAIN",
    });
    value.productStore.putModelProvider = () => { throw primary; };
    value.secretStore.delete = async () => { throw rollback; };
    await assert.rejects(
      value.service.setSecret({ providerId: saved.id, secret: "rollback-uncertain-secret-000001" }),
      (error) => error instanceof AggregateError
        && error.code === "PROVIDER_COMMIT_UNCERTAIN"
        && error.errors[0] === primary
        && error.errors[1] === rollback,
    );
    assert.throws(
      () => value.service.list(),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN",
    );
  } finally {
    await closeFixture(value);
  }
});

test("同 Provider setSecret/delete 串行，删除不会被迟到 secret switch 复活或留 orphan", async () => {
  const value = fixture();
  const putStarted = deferred();
  const releasePut = deferred();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    const originalPut = value.secretStore.put.bind(value.secretStore);
    value.secretStore.put = async (...args) => {
      putStarted.resolve();
      await releasePut.promise;
      return originalPut(...args);
    };
    const setting = value.service.setSecret({
      providerId: saved.id,
      secret: "serialized-delete-secret-000001",
    });
    await putStarted.promise;
    const deleting = value.service.delete({ providerId: saved.id });
    releasePut.resolve();
    await assert.rejects(
      setting,
      (error) => error.code === "PROVIDER_OPERATION_STALE",
    );
    await deleting;
    assert.equal(value.productStore.getModelProvider(saved.id), null);
    assert.deepEqual(value.secretStore.listMetadata(), []);
  } finally {
    await closeFixture(value);
  }
});

test("delete 进行中的 stale save 被 generation fence 拒绝，完成后显式 save 可重建", async () => {
  const value = fixture();
  const deleteStarted = deferred();
  const releaseDelete = deferred();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    await value.service.setSecret({ providerId: saved.id, secret: "delete-fence-secret-000001" });
    const originalDelete = value.secretStore.delete.bind(value.secretStore);
    value.secretStore.delete = async (...args) => {
      deleteStarted.resolve();
      await releaseDelete.promise;
      return originalDelete(...args);
    };
    const deleting = value.service.delete({ providerId: saved.id });
    await deleteStarted.promise;
    await assert.rejects(
      value.service.save(input("custom-responses", { baseUrl: "https://gateway.test/v1" })),
      (error) => error.code === "PROVIDER_OPERATION_STALE",
    );
    releaseDelete.resolve();
    await deleting;
    assert.equal(value.productStore.getModelProvider(saved.id), null);
    assert.equal((await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }))).id, saved.id);
  } finally {
    await closeFixture(value);
  }
});

test("ProviderService close fence 拒绝新操作并等待已进入的 Provider 操作", async () => {
  const value = fixture();
  const putStarted = deferred();
  const releasePut = deferred();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    const originalPut = value.secretStore.put.bind(value.secretStore);
    value.secretStore.put = async (...args) => {
      putStarted.resolve();
      await releasePut.promise;
      return originalPut(...args);
    };
    const setting = value.service.setSecret({
      providerId: saved.id,
      secret: "close-fence-secret-000001",
    });
    await putStarted.promise;
    let closeSettled = false;
    const closing = value.service.close().then(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    assert.throws(
      () => value.service.list(),
      (error) => error.code === "PROVIDER_SERVICE_CLOSING",
    );
    await assert.rejects(
      value.service.save(input("ollama", { id: "provider-after-close" })),
      (error) => error.code === "PROVIDER_SERVICE_CLOSING",
    );
    releasePut.resolve();
    await setting;
    await closing;
    assert.equal(closeSettled, true);
    assert.throws(
      () => value.service.list(),
      (error) => error.code === "PROVIDER_SERVICE_CLOSING",
    );
  } finally {
    await value.secretStore.close();
    value.productStore.close();
  }
});

test("物理删除 secret 前重新确认 credentialRef 没有其他 Provider owner", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("custom-responses", {
      baseUrl: "https://gateway.test/v1",
    }));
    const withSecret = await value.service.setSecret({
      providerId: saved.id,
      secret: "shared-owner-secret-000001",
    });
    const originalList = value.productStore.listModelProviders.bind(value.productStore);
    value.productStore.listModelProviders = () => [
      ...originalList(),
      { ...withSecret, id: "provider-phantom-owner" },
    ];
    await value.service.clearSecret({ providerId: saved.id });
    assert.equal(await value.secretStore.get(withSecret.credentialRef), "shared-owner-secret-000001");
    value.productStore.listModelProviders = originalList;
    await value.secretStore.delete(withSecret.credentialRef);
  } finally {
    await closeFixture(value);
  }
});

test("protocol validate 离线成功才写 protocol_valid；agent 即使 opt-in 本阶段也拒绝未运行", async () => {
  const value = fixture();
  try {
    await value.service.save(input("ollama"));
    assert.deepEqual(await value.service.validate({
      providerId: "provider-ollama", level: "protocol",
    }), {
      providerId: "provider-ollama", validationStatus: "protocol_valid", parsedBy: "codex-0.149.0",
    });
    await assert.rejects(
      value.service.validate({ providerId: "provider-ollama", level: "agent" }),
      (error) => error.code === "PROVIDER_AGENT_VALIDATION_OPT_IN_REQUIRED",
    );
    await assert.rejects(
      value.service.validate({
        providerId: "provider-ollama", level: "agent", allowPaidModelRequest: true,
      }),
      (error) => error.code === "PROVIDER_AGENT_VALIDATION_NOT_RUN",
    );
    assert.equal(value.productStore.getModelProvider("provider-ollama").validationStatus, "protocol_valid");
  } finally {
    await closeFixture(value);
  }
});

test("OpenRouter/OpenAI protocol validation 要求可解密凭据且错误文案不串 Provider", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("openrouter"));
    await assert.rejects(
      value.service.validate({ providerId: saved.id, level: "protocol" }),
      (error) => error.code === "PROVIDER_CREDENTIAL_REQUIRED",
    );
    assert.equal(value.productStore.getModelProvider(saved.id).validationStatus, "invalid");
    await value.service.setSecret({
      providerId: saved.id, secret: "openrouter-validation-secret-000001",
    });
    assert.equal((await value.service.validate({
      providerId: saved.id, level: "protocol",
    })).validationStatus, "protocol_valid");

    const openai = await value.service.save(input("openai-api-key", { model: "gpt-5" }));
    await assert.rejects(
      value.service.validate({ providerId: openai.id, level: "protocol" }),
      (error) => error.code === "PROVIDER_CREDENTIAL_REQUIRED"
        && !error.message.includes("OpenRouter"),
    );
  } finally {
    await closeFixture(value);
  }
});

test("secret switch commit uncertain 保留新旧 credential 证据并 poison ProviderService", async () => {
  const value = fixture();
  try {
    await value.service.save(input("custom-responses", { baseUrl: "https://gateway.test/v1" }));
    const first = await value.service.setSecret({
      providerId: "provider-custom-responses", secret: "first-uncertain-secret-000001",
    });
    const originalPut = value.productStore.putModelProvider.bind(value.productStore);
    value.productStore.putModelProvider = () => {
      const error = new Error("fixture commit detail must not escape");
      error.code = "STORE_COMMIT_UNCERTAIN";
      throw error;
    };
    await assert.rejects(
      value.service.setSecret({
        providerId: first.id, secret: "second-uncertain-secret-000002", // gitleaks:allow -- synthetic test fixture; not a usable credential
      }),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN"
        && !error.message.includes("fixture commit detail"),
    );
    const refs = value.secretStore.listMetadata().map((entry) => entry.credentialRef);
    assert.equal(refs.length, 2);
    assert.equal(refs.includes(first.credentialRef), true);
    assert.notEqual(refs.find((ref) => ref !== first.credentialRef), undefined);
    assert.throws(
      () => value.service.list(),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN",
    );
    value.productStore.putModelProvider = originalPut;
  } finally {
    await closeFixture(value);
  }
});

test("旧 secret 清理 commit uncertain 在新引用已提交后仍 fail closed", async () => {
  const value = fixture();
  try {
    await value.service.save(input("custom-responses", { baseUrl: "https://gateway.test/v1" }));
    const first = await value.service.setSecret({
      providerId: "provider-custom-responses", secret: "first-cleanup-secret-000001",
    });
    const originalDelete = value.secretStore.delete.bind(value.secretStore);
    value.secretStore.delete = async () => {
      const error = new Error("cleanup commit detail must not escape");
      error.code = "SECRET_COMMIT_UNCERTAIN";
      throw error;
    };
    await assert.rejects(
      value.service.setSecret({
        providerId: first.id, secret: "second-cleanup-secret-000002",
      }),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN"
        && !error.message.includes("cleanup commit detail"),
    );
    assert.notEqual(value.productStore.getModelProvider(first.id).credentialRef, first.credentialRef);
    assert.throws(
      () => value.service.list(),
      (error) => error.code === "PROVIDER_COMMIT_UNCERTAIN",
    );
    value.secretStore.delete = originalDelete;
  } finally {
    await closeFixture(value);
  }
});

test("validation 仅确定性失败写 invalid；transient 与 stale 不覆盖现有/新配置状态", async () => {
  const value = fixture();
  try {
    const saved = await value.service.save(input("ollama"));
    value.productStore.putModelProvider({ ...saved, validationStatus: "protocol_valid" });
    const deterministic = new Error("deterministic fixture");
    deterministic.code = "PROVIDER_PROTOCOL_CONFIG_INVALID";
    deterministic.deterministic = true;
    value.service.protocolValidator = async () => { throw deterministic; };
    await assert.rejects(
      value.service.validate({ providerId: saved.id, level: "protocol" }),
      (error) => error === deterministic,
    );
    assert.equal(value.productStore.getModelProvider(saved.id).validationStatus, "invalid");

    value.productStore.putModelProvider({
      ...value.productStore.getModelProvider(saved.id), validationStatus: "protocol_valid",
    });
    const transient = Object.assign(new Error("transient fixture"), { code: "RPC_REQUEST_TIMEOUT" });
    value.service.protocolValidator = async () => { throw transient; };
    await assert.rejects(
      value.service.validate({ providerId: saved.id, level: "protocol" }),
      (error) => error === transient,
    );
    assert.equal(value.productStore.getModelProvider(saved.id).validationStatus, "protocol_valid");

    value.service.protocolValidator = async (provider) => {
      value.productStore.putModelProvider({
        ...provider, model: "fixture/concurrently-changed", validationStatus: "unverified",
      });
      return { parsedBy: "codex-0.149.0" };
    };
    await assert.rejects(
      value.service.validate({ providerId: saved.id, level: "protocol" }),
      (error) => error.code === "PROVIDER_VALIDATION_STALE",
    );
    assert.equal(value.productStore.getModelProvider(saved.id).model, "fixture/concurrently-changed");
    assert.equal(value.productStore.getModelProvider(saved.id).validationStatus, "unverified");
  } finally {
    await closeFixture(value);
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
  else console.log(`PASS codex provider service unit (${tests.length})`);
})();
