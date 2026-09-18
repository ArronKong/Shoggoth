#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DEFAULT_AGENT_PROFILE_ID,
  JsonlProductStore,
  STORE_SCHEMA_VERSION,
  eventChecksum,
  snapshotChecksum,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { EncryptedSecretStore } = require(path.join(
  ROOT, "app", "agent-service", "encrypted-secret-store.js",
));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { runtimeAccountForLegacyProfile } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account-migration.js",
));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-provider-store-"));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function openStore(paths, options = {}) {
  const store = new JsonlProductStore({ paths, ...options });
  store.open();
  return store;
}

function validProvider(id = "provider-openrouter", overrides = {}) {
  return {
    id,
    kind: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    credentialRef: `credential-${id}`,
    headers: {
      "HTTP-Referer": "https://product.test/shoggoth",
      "X-OpenRouter-Title": "Shoggoth",
    },
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
    ...overrides,
  };
}

function validProfile(id, providerRef = null) {
  return {
    id,
    backendId: "shoggoth",
    agentId: id,
    name: `Fixture ${id}`,
    runtime: "codex",
    runtimeProfileId: id,
    providerRef,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
  };
}

function encodeSnapshot(snapshot) {
  const candidate = { ...snapshot };
  candidate.checksum = snapshotChecksum(candidate);
  return `${JSON.stringify(candidate)}\n`;
}

function removeRuntimeAccountSchema(snapshot) {
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  for (const profile of snapshot.agentProfiles) delete profile.runtimeAccountId;
}

test("ModelProvider 七种 kind 可持久化、查询、更新、删除并跨重启恢复", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 100 });
  const fixtures = [
    validProvider("provider-chatgpt", {
      kind: "chatgpt", name: "ChatGPT", baseUrl: null, credentialRef: null, headers: null,
    }),
    validProvider("provider-openai", {
      kind: "openai-api-key", name: "OpenAI API Key", baseUrl: null,
      credentialRef: "credential-provider-openai", headers: null,
    }),
    validProvider("provider-openrouter"),
    validProvider("provider-ollama", {
      kind: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", credentialRef: null,
      headers: null,
    }),
    validProvider("provider-lmstudio", {
      kind: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", credentialRef: null,
      headers: null,
    }),
    validProvider("provider-custom", {
      kind: "custom-responses", name: "Custom Responses", baseUrl: "https://example.test/v1",
    }),
    validProvider("provider-bedrock", {
      kind: "amazon-bedrock", name: "Amazon Bedrock", baseUrl: null, credentialRef: null,
      headers: null, awsRegion: "us-east-1", awsProfile: "shoggoth-dev",
    }),
  ];
  for (const provider of fixtures) assert.deepEqual(store.putModelProvider(provider), provider);
  assert.deepEqual(store.listModelProviders(), fixtures);
  assert.deepEqual(store.getModelProvider("provider-openrouter"), fixtures[2]);
  const updated = store.putModelProvider({
    ...fixtures[2], name: "OpenRouter Updated", validationStatus: "protocol_valid",
  });
  assert.equal(updated.name, "OpenRouter Updated");
  assert.equal(updated.validationStatus, "protocol_valid");
  assert.deepEqual(store.deleteModelProvider("provider-lmstudio"), fixtures[4]);
  assert.equal(store.deleteModelProvider("provider-missing"), null);
  store.close();

  const reopened = openStore(paths);
  assert.equal(reopened.listModelProviders().length, 6);
  assert.equal(reopened.getModelProvider("provider-openrouter").name, "OpenRouter Updated");
  assert.equal(reopened.getModelProvider("provider-lmstudio"), null);
  reopened.close();
});

test("ModelProvider 严格拒绝未知字段、非法枚举、非法 credentialRef 与敏感 auth 字段/值", () => {
  const paths = fixturePaths();
  const canary = `sk-proj-${"C".repeat(32)}`;
  const store = openStore(paths, { sensitiveValues: new Set(["registered-provider-secret"]) });
  const invalid = [
    validProvider("unknown-field", { extra: true }),
    validProvider("unknown-kind", { kind: "openai" }),
    validProvider("unknown-status", { validationStatus: "pending" }),
    validProvider("legacy-status", { validationStatus: "valid" }),
    validProvider("bad-ref-space", { credentialRef: "credential has spaces" }),
    validProvider("bad-ref-secret", { credentialRef: canary }),
    validProvider("auth-field", { apiKey: canary }),
    validProvider("token-field", { token: canary }),
    validProvider("authorization-field", { authorization: `Bearer ${"A".repeat(24)}` }),
    validProvider("registered-value", { name: "registered-provider-secret" }),
    validProvider("chatgpt-secret", { kind: "chatgpt" }),
    validProvider("bedrock-secret", { kind: "amazon-bedrock" }),
  ];
  for (const provider of invalid) {
    assert.throws(
      () => store.putModelProvider(provider),
      (error) => ["STORE_INVALID_RECORD", "STORE_SENSITIVE_FIELD", "STORE_SENSITIVE_VALUE"].includes(error.code)
        && !String(error.message).includes(canary),
    );
  }
  store.close();
  const disk = fs.readFileSync(paths.stateSnapshotPath, "utf8")
    + fs.readFileSync(paths.eventLogPath, "utf8");
  assert.equal(disk.includes(canary), false);
  assert.equal(disk.includes("registered-provider-secret"), false);
});

test("ModelProvider.model 允许 null，custom baseUrl 必须是安全 http(s)，authority kind 必须为 null", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  assert.equal(store.putModelProvider(validProvider("nullable-model", { model: null })).model, null);
  for (const [id, kind] of [
    ["nullable-chatgpt", "chatgpt"],
    ["nullable-openai", "openai-api-key"],
    ["nullable-bedrock", "amazon-bedrock"],
  ]) {
    assert.equal(store.putModelProvider(validProvider(id, {
      kind, model: null, baseUrl: null, credentialRef: null, headers: null,
      ...(kind === "amazon-bedrock" ? { awsRegion: "us-east-1" } : {}),
    })).model, null);
  }
  for (const [index, baseUrl] of [
    null,
    "data:text/plain,unsafe",
    "file:///tmp/unsafe",
    "ftp://example.test/v1",
    "https://user:password@example.test/v1",
    "https://example.test/v1?token=nope",
    "https://example.test/v1#fragment",
    "https://",
  ].entries()) {
    assert.throws(
      () => store.putModelProvider(validProvider(`unsafe-url-${index}`, { baseUrl })),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
  for (const [id, kind] of [
    ["chatgpt-url", "chatgpt"], ["openai-url", "openai-api-key"], ["bedrock-url", "amazon-bedrock"],
  ]) {
    assert.throws(
      () => store.putModelProvider(validProvider(id, { kind, credentialRef: null, baseUrl: "https://example.test/v1" })),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
  assert.equal(store.putModelProvider(validProvider("local-http", {
    kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", credentialRef: null,
  })).baseUrl, "http://127.0.0.1:11434/v1");
  store.close();
});

test("Provider headers 只允许有界非敏感 RFC token 静态字符串", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  assert.deepEqual(store.putModelProvider(validProvider("headers-valid")).headers, {
    "HTTP-Referer": "https://product.test/shoggoth",
    "X-OpenRouter-Title": "Shoggoth",
  });
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-Safe-${index}`, "ok"]));
  const invalidHeaders = [
    [],
    Object.assign(Object.create(null), { "X-Safe": "ok" }),
    { "Bad Header": "ok" },
    { ["X".repeat(129)]: "ok" },
    { "X-Safe": "x".repeat(4097) },
    { "X-Safe": "line\rbreak" },
    { "X-Safe": "line\nbreak" },
    { "X-Safe": "nul\0break" },
    { "X-Safe": "control\u0007break" },
    { Authorization: "safe-looking" },
    { "Proxy-Authorization": "safe-looking" },
    { Cookie: "safe-looking" },
    { "Set-Cookie": "safe-looking" },
    { "X-API-Key": "safe-looking" },
    { "X-Credential-Id": "safe-looking" },
    { "X-Access-Token": "safe-looking" },
    { "X-Client-Secret": "safe-looking" },
    tooMany,
  ];
  for (const [index, headers] of invalidHeaders.entries()) {
    assert.throws(
      () => store.putModelProvider(validProvider(`headers-invalid-${index}`, { headers })),
      (error) => [
        "STORE_INVALID_RECORD", "STORE_INVALID_JSON", "STORE_SENSITIVE_FIELD", "STORE_SENSITIVE_VALUE",
      ].includes(error.code),
    );
  }
  store.close();
});

test("ModelProvider 四态 validation 与 Bedrock AWS 字段严格持久化", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  for (const validationStatus of [
    "unverified", "protocol_valid", "agent_compatible", "invalid",
  ]) {
    assert.equal(store.putModelProvider(validProvider(`status-${validationStatus}`, {
      validationStatus,
    })).validationStatus, validationStatus);
  }
  assert.deepEqual(store.putModelProvider(validProvider("bedrock-aws", {
    kind: "amazon-bedrock",
    name: "Amazon Bedrock",
    baseUrl: null,
    credentialRef: null,
    headers: null,
    awsRegion: "us-west-2",
    awsProfile: "engineering-dev",
  })), {
    id: "bedrock-aws",
    kind: "amazon-bedrock",
    name: "Amazon Bedrock",
    baseUrl: null,
    model: "openai/gpt-5",
    credentialRef: null,
    headers: null,
    awsRegion: "us-west-2",
    awsProfile: "engineering-dev",
    validationStatus: "unverified",
  });
  for (const providerInput of [
    validProvider("bedrock-region-required", {
      kind: "amazon-bedrock", baseUrl: null, credentialRef: null, headers: null,
    }),
    validProvider("bedrock-region-empty", {
      kind: "amazon-bedrock", baseUrl: null, credentialRef: null, headers: null, awsRegion: "",
    }),
    validProvider("bedrock-region-malformed", {
      kind: "amazon-bedrock", baseUrl: null, credentialRef: null, headers: null,
      awsRegion: "us east 1",
    }),
    validProvider("bedrock-profile-empty", {
      kind: "amazon-bedrock", baseUrl: null, credentialRef: null, headers: null,
      awsRegion: "us-east-1", awsProfile: "",
    }),
    validProvider("openrouter-aws-forbidden", { awsRegion: "us-east-1" }),
  ]) {
    assert.throws(
      () => store.putModelProvider(providerInput),
      (error) => error.code === "STORE_INVALID_RECORD",
    );
  }
  store.close();
});

test("v1 Provider snapshot 迁移 AWS null 且旧 valid fail-safe 为 unverified", () => {
  const paths = fixturePaths();
  const first = openStore(paths, { now: () => 600 });
  first.putModelProvider(validProvider("legacy-provider"));
  first.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 1;
  removeRuntimeAccountSchema(snapshot);
  delete snapshot.runNotes;
  delete snapshot.mcpToolCalls;
  const legacyProvider = snapshot.modelProviders[0];
  delete legacyProvider.awsRegion;
  delete legacyProvider.awsProfile;
  legacyProvider.validationStatus = "valid";
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });

  const reopened = openStore(paths);
  assert.deepEqual(reopened.getModelProvider("legacy-provider"), {
    ...legacyProvider,
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
  });
  reopened.close();
  const migrated = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(migrated.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(migrated.modelProviders[0].validationStatus, "unverified");
  assert.equal(migrated.modelProviders[0].awsRegion, null);
  assert.equal(migrated.modelProviders[0].awsProfile, null);
});

test("v1 本地 Provider 的非法 credentialRef 迁移为 null 且不删除孤立密文证据", async () => {
  for (const kind of ["ollama", "lmstudio"]) {
    const paths = fixturePaths();
    const first = openStore(paths, { now: () => 610 });
    first.close();
    const secretStore = new EncryptedSecretStore({
      paths,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value, "utf8").reverse(),
        decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
      },
    });
    secretStore.open();
    await secretStore.put(
      `legacy-orphan-${kind}`,
      `legacy-local-secret-${kind}-000001`,
      { kind: "custom-responses" },
    );
    await secretStore.close();
    const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    snapshot.schemaVersion = 1;
    removeRuntimeAccountSchema(snapshot);
    delete snapshot.runNotes;
    delete snapshot.mcpToolCalls;
    snapshot.modelProviders = [{
      id: `legacy-${kind}`,
      kind,
      name: kind,
      baseUrl: kind === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:1234/v1",
      model: "fixture/model",
      credentialRef: `legacy-orphan-${kind}`,
      headers: null,
      validationStatus: "valid",
    }];
    fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });

    const reopened = openStore(paths);
    assert.equal(reopened.getModelProvider(`legacy-${kind}`).credentialRef, null);
    assert.equal(reopened.getModelProvider(`legacy-${kind}`).validationStatus, "unverified");
    reopened.close();
    assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8").includes(`legacy-orphan-${kind}`), false);
    secretStore.open();
    assert.equal(
      await secretStore.get(`legacy-orphan-${kind}`),
      `legacy-local-secret-${kind}-000001`,
    );
    await secretStore.close();
  }
});

test("AgentProfile.providerRef 必须存在，引用中的 Provider 不可删除", () => {
  const paths = fixturePaths();
  const store = openStore(paths);
  assert.throws(
    () => store.putAgentProfile(validProfile("profile-dangling", "provider-missing")),
    (error) => error.code === "UNKNOWN_MODEL_PROVIDER",
  );
  store.putModelProvider(validProvider("provider-linked"));
  store.putAgentProfile(validProfile("profile-linked", "provider-linked"));
  assert.throws(
    () => store.deleteModelProvider("provider-linked"),
    (error) => error.code === "MODEL_PROVIDER_IN_USE",
  );
  store.putAgentProfile(validProfile("profile-linked", null));
  assert.equal(store.deleteModelProvider("provider-linked").id, "provider-linked");
  store.close();
});

test("旧 v1 snapshot 无 modelProviders 且引用为空时原样载入并在下次 snapshot 明确升级", () => {
  const paths = fixturePaths();
  const first = openStore(paths, { now: () => 200 });
  first.close();
  const current = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  current.schemaVersion = 1;
  removeRuntimeAccountSchema(current);
  delete current.modelProviders;
  delete current.runNotes;
  delete current.mcpToolCalls;
  fs.writeFileSync(paths.stateSnapshotPath, encodeSnapshot(current), { mode: 0o600 });

  const reopened = openStore(paths, { now: () => 201 });
  assert.equal(reopened.listAgentProfiles().length, 1);
  assert.deepEqual(reopened.listModelProviders(), []);
  reopened.close();
  const upgraded = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.deepEqual(upgraded.modelProviders, []);
  assert.equal(upgraded.checksum, snapshotChecksum(upgraded));
});

test("v2 snapshot 必须含 modelProviders，不能借 legacy shape 丢弃 lastSeq 前的 Provider", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 250 });
  store.putModelProvider(validProvider("provider-must-survive"));
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(snapshot.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(snapshot.lastSeq > 0, true);
  snapshot.schemaVersion = 2;
  removeRuntimeAccountSchema(snapshot);
  delete snapshot.runNotes;
  delete snapshot.mcpToolCalls;
  delete snapshot.modelProviders;
  const evidence = encodeSnapshot(snapshot);
  fs.writeFileSync(paths.stateSnapshotPath, evidence, { mode: 0o600 });

  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );
  assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), evidence);
});

test("旧 v1 snapshot 的悬空 providerRef 显式 fail closed，保留原始证据且不静默丢引用", () => {
  const paths = fixturePaths();
  const first = openStore(paths, { now: () => 300 });
  first.close();
  const legacy = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  legacy.schemaVersion = 1;
  removeRuntimeAccountSchema(legacy);
  delete legacy.modelProviders;
  delete legacy.runNotes;
  delete legacy.mcpToolCalls;
  legacy.agentProfiles[0].providerRef = "legacy-provider-not-defined";
  const evidence = encodeSnapshot(legacy);
  fs.writeFileSync(paths.stateSnapshotPath, evidence, { mode: 0o600 });
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_LEGACY_PROVIDER_REFERENCE_UNRESOLVED",
  );
  assert.equal(fs.readFileSync(paths.stateSnapshotPath, "utf8"), evidence);
});

test("Provider 事件使用既有 checksum/seq/fsync 日志语义且 secret canary 不进入日志或 snapshot", () => {
  const paths = fixturePaths();
  const syncs = [];
  const instrumentedFs = Object.create(fs);
  instrumentedFs.fsyncSync = (fd) => { syncs.push(fd); return fs.fsyncSync(fd); };
  const store = openStore(paths, { fs: instrumentedFs, now: () => 400 });
  store.putModelProvider(validProvider("provider-replay"));
  const events = fs.readFileSync(paths.eventLogPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "model_provider.put");
  assert.equal(events.at(-1).aggregateId, "provider-replay");
  assert.equal(events.at(-1).seq, 2);
  assert.match(events.at(-1).checksum, /^[a-f0-9]{64}$/);
  assert.equal(syncs.length > 0, true);

  const replayed = openStore(paths);
  assert.equal(replayed.getModelProvider("provider-replay").id, "provider-replay");
  replayed.deleteModelProvider("provider-replay");
  const deleteEvent = fs.readFileSync(paths.eventLogPath, "utf8").trimEnd().split("\n").map(JSON.parse).at(-1);
  assert.equal(deleteEvent.type, "model_provider.delete");
  assert.deepEqual(deleteEvent.payload, {});
  replayed.close();
  store.close();

  const disk = fs.readFileSync(paths.stateSnapshotPath, "utf8")
    + fs.readFileSync(paths.eventLogPath, "utf8");
  assert.equal(disk.includes(`sk-proj-${"C".repeat(32)}`), false);
});

test("event replay 在 Provider 删除发生当下就校验引用，不接受随后修复的非法中间状态", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 500 });
  store.putModelProvider(validProvider("provider-event-linked"));
  store.putAgentProfile(validProfile("profile-event-linked", "provider-event-linked"));
  const detached = {
    ...store.getAgentProfile("profile-event-linked"),
    providerRef: null,
    updatedAt: 501,
  };
  const events = [
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: 4,
      aggregateId: "provider-event-linked",
      type: "model_provider.delete",
      time: 501,
      payload: {},
    },
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: 5,
      aggregateId: "profile-event-linked",
      type: "agent_profile.put",
      time: 502,
      payload: { profile: detached },
    },
  ];
  for (const event of events) event.checksum = eventChecksum(event);
  fs.appendFileSync(paths.eventLogPath, `${events.map(JSON.stringify).join("\n")}\n`);
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
});

test("event replay 在 AgentProfile put 当下要求 Provider 已存在", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 520 });
  const profile = {
    ...validProfile("profile-before-provider", "provider-after-profile"),
    createdAt: 520,
    updatedAt: 520,
  };
  const migrated = runtimeAccountForLegacyProfile(profile);
  profile.runtimeAccountId = migrated.runtimeAccountId;
  const runtimeAccount = { ...migrated.account, createdAt: 520, updatedAt: 520 };
  const provider = validProvider("provider-after-profile");
  const events = [
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: 2,
      aggregateId: profile.id,
      type: "agent_profile.put",
      time: 521,
      payload: { profile, runtimeAccount },
    },
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: 3,
      aggregateId: provider.id,
      type: "model_provider.put",
      time: 522,
      payload: { provider },
    },
  ];
  for (const event of events) event.checksum = eventChecksum(event);
  fs.appendFileSync(paths.eventLogPath, `${events.map(JSON.stringify).join("\n")}\n`);
  assert.throws(
    () => openStore(paths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
});

test("credentialRef 在 put、snapshot migration 与逐事件 replay 中必须全 Store 唯一", () => {
  const putPaths = fixturePaths();
  const putStore = openStore(putPaths);
  putStore.putModelProvider(validProvider("provider-owner-a", { credentialRef: "shared-ref" }));
  assert.throws(
    () => putStore.putModelProvider(validProvider("provider-owner-b", { credentialRef: "shared-ref" })),
    (error) => error.code === "MODEL_PROVIDER_CREDENTIAL_CONFLICT",
  );

  const snapshotPaths = fixturePaths();
  const snapshotStore = openStore(snapshotPaths, { now: () => 530 });
  snapshotStore.close();
  const snapshot = JSON.parse(fs.readFileSync(snapshotPaths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 1;
  removeRuntimeAccountSchema(snapshot);
  snapshot.modelProviders = ["a", "b"].map((suffix) => {
    const provider = validProvider(`legacy-owner-${suffix}`, { credentialRef: "legacy-shared-ref" });
    delete provider.awsRegion;
    delete provider.awsProfile;
    provider.validationStatus = "valid";
    return provider;
  });
  fs.writeFileSync(snapshotPaths.stateSnapshotPath, encodeSnapshot(snapshot), { mode: 0o600 });
  assert.throws(
    () => openStore(snapshotPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT",
  );

  const replayPaths = fixturePaths();
  const replayStore = openStore(replayPaths, { now: () => 540 });
  const providers = ["a", "b"].map((suffix) => validProvider(`event-owner-${suffix}`, {
    credentialRef: "event-shared-ref",
  }));
  const events = providers.map((provider, index) => ({
    schemaVersion: STORE_SCHEMA_VERSION,
    seq: index + 2,
    aggregateId: provider.id,
    type: "model_provider.put",
    time: 541 + index,
    payload: { provider },
  }));
  for (const event of events) event.checksum = eventChecksum(event);
  fs.appendFileSync(replayPaths.eventLogPath, `${events.map(JSON.stringify).join("\n")}\n`);
  assert.throws(
    () => openStore(replayPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
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
  else console.log(`PASS codex provider store unit (${tests.length})`);
})();
