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
    runtimeAccountId: "shoggoth-internal-codex-default-v1",
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
  for (const profile of snapshot.agentProfiles) {
    delete profile.runtimeAccountId;
    if (profile.concurrency.maxActive === null) profile.concurrency = { maxActive: 4, maxWorkspaceWrites: 4 };
  }
  for (const provider of snapshot.modelProviders || []) delete provider.revision;
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
  store.putAgentProfile(validProfile("profile-before-provider")); store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath));
  const profile = snapshot.agentProfiles.find(item => item.id === "profile-before-provider");
  profile.providerRef = "provider-after-profile";
  const provider = validProvider("provider-after-profile");
  const events = [
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: snapshot.lastSeq + 1,
      aggregateId: profile.id,
      type: "agent_profile.put",
      time: 521,
      payload: { profile },
    },
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: snapshot.lastSeq + 2,
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

test("credentialRef 在当前 put、snapshot 与逐事件 replay 中必须全 Store 唯一", () => {
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
  snapshot.modelProviders = ["a", "b"].map(suffix => ({ ...validProvider(`snapshot-owner-${suffix}`, { credentialRef: "snapshot-shared-ref" }), revision: 1 }));
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
