#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  JsonlProductStore,
  STORE_SCHEMA_VERSION,
  defaultAgentProfile,
  eventChecksum,
  snapshotChecksum,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(
  ROOT, "app", "agent-service", "builtin-cli-profiles.js",
));
const { RuntimeSwitchManager } = require(path.join(
  ROOT, "scripts", "fixtures", "legacy-runtime-switch-manager.cjs",
));
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixturePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-account-store-"));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function openStore(paths, options = {}) {
  const store = new JsonlProductStore({ paths, ...options });
  return store.open();
}

function profile(id, overrides = {}) {
  return {
    id,
    backendId: "shoggoth",
    agentId: id,
    name: id,
    runtime: "codex",
    runtimeProfileId: id,
    runtimeAccountId: BUILTIN_CLI_AGENT_PROFILES.some(spec => spec.id === id)
      ? require("../app/agent-service/runtime-account").DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[overrides.runtime || "codex"]
      : SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: null,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
    ...overrides,
  };
}

function provider(id) {
  return {
    id,
    kind: "ollama",
    name: id,
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture-model",
    credentialRef: null,
    headers: null,
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
  };
}

function managedAccount(id, runtime = "codex", overrides = {}) {
  return {
    id,
    runtime,
    kind: "shoggoth-managed",
    installationKind: "bundled",
    homeKind: "managed-shared",
    providerRef: null,
    isDefault: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function workRun(id, profileValue, runtimeAccountId = profileValue.runtimeAccountId) {
  const ref = {
    runtime: profileValue.runtime,
    runtimeProfileId: profileValue.runtimeProfileId,
    runtimeAccountId,
    sessionId: `session-${id}`,
  };
  return {
    id,
    source: "chat",
    sourceId: `source-${id}`,
    idempotencyKey: `idem-${id}`,
    profileId: profileValue.id,
    workspace: null,
    status: "queued",
    contextSnapshotId: null,
    runtimeSessionRef: ref,
    runtimeTurnRef: { ...ref, turnId: `turn-${id}` },
    eventSeq: 1,
    waitingRequestId: null,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    errorCode: null,
    retryOf: null,
  };
}

function appendEvents(target, events) {
  for (const event of events) {
    if (event.schemaVersion < 12 && event.payload?.profile) event.payload.profile = legacyProfile(event.payload.profile);
    if (event.schemaVersion <= 10 && event.payload?.provider) delete event.payload.provider.revision;
    if (event.schemaVersion <= 10 && event.payload?.profile?.concurrency?.maxActive === null) {
      event.payload.profile.concurrency = { maxActive: 4, maxWorkspaceWrites: 4 };
    }
  }
  for (const event of events) event.checksum = eventChecksum(event);
  fs.appendFileSync(target, `${events.map(JSON.stringify).join("\n")}\n`);
}

function writeSnapshot(target, snapshot) {
  if (snapshot.schemaVersion <= 10) {
    for (const provider of snapshot.modelProviders || []) delete provider.revision;
    for (const profile of snapshot.agentProfiles || []) {
      if (profile.concurrency?.maxActive === null) {
        profile.concurrency = { maxActive: 4, maxWorkspaceWrites: 4 };
      }
    }
  }
  snapshot.checksum = snapshotChecksum(snapshot);
  fs.writeFileSync(target, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

function runtimeAccountAuthorityView(store) {
  return {
    runtimeAccounts: store.listRuntimeAccounts().sort((left, right) => left.id.localeCompare(right.id)),
    agentProfiles: store.listAgentProfiles().sort((left, right) => left.id.localeCompare(right.id)),
  };
}

test("fresh current 静默合成七个固定账号且只写默认 Profile 事件", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 100 });
  assert.deepEqual(store.listRuntimeAccounts(), DEFAULT_RUNTIME_ACCOUNTS);
  assert.equal(
    store.listAgentProfiles()[0].runtimeAccountId,
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  );
  const events = fs.readFileSync(paths.eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ["agent_profile.put"]);
  assert.equal(events[0].schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(events[0].payload.profile.bindings[0].runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.deepEqual(snapshot.runtimeAccounts, DEFAULT_RUNTIME_ACCOUNTS);
  assert.deepEqual(snapshot.runtimeAccountTombstones, []);
});

test("RuntimeAccount CRUD、引用、runtime 与 built-in binding 全部 fail closed", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 200 });
  const account = store.putRuntimeAccount(managedAccount("managed-one", "future-runtime"));
  assert.deepEqual(account, managedAccount("managed-one", "future-runtime", {
    createdAt: 200, updatedAt: 200,
  }));
  assert.throws(
    () => store.putRuntimeAccount({ ...account, runtime: "antigravity" }),
    (error) => error.code === "RUNTIME_ACCOUNT_IDENTITY_IMMUTABLE",
  );
  assert.throws(
    () => store.putAgentProfile(profile("unknown-account", { runtimeAccountId: "missing" })),
    (error) => error.code === "UNKNOWN_RUNTIME_ACCOUNT",
  );
  assert.throws(
    () => store.putAgentProfile(profile("runtime-mismatch", {
      runtime: "antigravity", runtimeAccountId: account.id,
    })),
    (error) => error.code === "RUNTIME_ACCOUNT_PROFILE_MISMATCH",
  );
  store.putAgentProfile(profile("account-user", {
    backendId: "shoggoth",
    runtime: "future-runtime",
    runtimeAccountId: account.id,
  }));
  assert.throws(() => store.deleteRuntimeAccount(account.id),
    (error) => error.code === "RUNTIME_ACCOUNT_IN_USE");
  assert.throws(() => store.deleteRuntimeAccount(NATIVE_CODEX_RUNTIME_ACCOUNT_ID),
    (error) => error.code === "RUNTIME_ACCOUNT_DEFAULT");
  const disposable = store.putRuntimeAccount(managedAccount("disposable"));
  assert.deepEqual(store.deleteRuntimeAccount(disposable.id), disposable);
  store.putModelProvider(provider("native-provider-ref"));
  const nativeProvider = store.putAgentProfile(profile("native-provider", {
    backendId: "shoggoth",
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: "native-provider-ref",
  }));
  assert.equal(nativeProvider.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(nativeProvider.providerRef, "native-provider-ref");
  const builtin = BUILTIN_CLI_AGENT_PROFILES[0];
  const configuredBuiltin = store.putAgentProfile(profile(builtin.id, {
    ...builtin,
    providerRef: "native-provider-ref",
  }));
  assert.equal(configuredBuiltin.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  const providerlessManaged = store.putRuntimeAccount(managedAccount("managed-builtin-providerless"));
  assert.throws(
    () => store.putAgentProfile({
      ...configuredBuiltin,
      runtimeAccountId: providerlessManaged.id,
      providerRef: null,
    }),
    (error) => ["AGENT_PROFILE_IDENTITY_CONFLICT", "AGENT_BINDING_PROJECTION_READONLY", "RUNTIME_ACCOUNT_RUNTIME_MISMATCH", "RUNTIME_ACCOUNT_BINDING_MISMATCH", "RUNTIME_ACCOUNT_PROFILE_MISMATCH", "STORE_INVALID_RECORD"].includes(error.code),
  );
  const grok = BUILTIN_CLI_AGENT_PROFILES[1];
  assert.throws(
    () => store.putAgentProfile(profile(grok.id, {
      ...grok,
      runtimeAccountId: providerlessManaged.id,
      providerRef: "native-provider-ref",
    })),
    (error) => ["AGENT_PROFILE_IDENTITY_CONFLICT", "AGENT_BINDING_PROJECTION_READONLY", "RUNTIME_ACCOUNT_RUNTIME_MISMATCH", "RUNTIME_ACCOUNT_BINDING_MISMATCH", "RUNTIME_ACCOUNT_PROFILE_MISMATCH", "STORE_INVALID_RECORD"].includes(error.code),
  );
  assert.throws(
    () => store.putAgentProfile(profile("long-account", {
      runtimeAccountId: `a${"b".repeat(128)}`,
    })),
    (error) => error.code === "STORE_INVALID_RECORD",
  );
  store.close();
});

test("Codex built-in 切换 Profile Provider 时保持固定本机账号", () => {
  const paths = fixturePaths();
  let time = 225;
  const store = openStore(paths, { now: () => time });
  store.putModelProvider(provider("builtin-provider"));
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const native = store.putAgentProfile(profile(spec.id, { ...spec }));
  assert.equal(native.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);

  time += 1;
  const configured = store.putAgentProfile({
    ...native,
    providerRef: "builtin-provider",
  });
  assert.equal(configured.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);

  time += 1;
  const restored = store.putAgentProfile({ ...configured, providerRef: null });
  assert.equal(restored.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(store.deleteModelProvider("builtin-provider").id, "builtin-provider");
  const eventReplayed = openStore(paths, { now: () => 228 });
  assert.equal(eventReplayed.getAgentProfile(spec.id).runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(eventReplayed.getModelProvider("builtin-provider"), null);
  eventReplayed.close();
  store.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.deepEqual(snapshot.runtimeAccountTombstones, []);
});

test("显式与共享的非 Codex managed 账号在 Profile 改绑后保留", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 240 });
  store.putModelProvider(provider("explicit-provider"));
  store.putModelProvider(provider("shared-provider"));

  const explicitAccount = store.putRuntimeAccount(managedAccount(
    "explicit-managed-account",
    "future-runtime",
  ));
  const explicitProfile = store.putAgentProfile(profile("explicit-owner", {
    backendId: "shoggoth",
    runtime: "future-runtime",
    runtimeAccountId: explicitAccount.id,
    providerRef: "explicit-provider",
  }));
  const addedexplicitProfile = store.addAgentRuntimeBinding(explicitProfile.id, {
    runtime: "codex", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  }, { operationId: "switch-explicitProfile" });
  store.setAgentDefaultBinding(explicitProfile.id, addedexplicitProfile.binding.id, { revision: addedexplicitProfile.revision });

  assert.deepEqual(store.getRuntimeAccount(explicitAccount.id), explicitAccount);

  const sharedAccount = store.putRuntimeAccount(managedAccount(
    "shared-managed-account",
    "future-runtime",
  ));
  const sharedOwner = store.putAgentProfile(profile("shared-owner", {
    backendId: "shoggoth",
    runtime: "future-runtime",
    runtimeAccountId: sharedAccount.id,
    providerRef: "shared-provider",
  }));
  store.putAgentProfile(profile("shared-peer", {
    backendId: "shoggoth",
    runtime: "future-runtime",
    runtimeAccountId: sharedAccount.id,
    providerRef: "shared-provider",
  }));
  const addedsharedOwner = store.addAgentRuntimeBinding(sharedOwner.id, {
    runtime: "codex", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  }, { operationId: "switch-sharedOwner" });
  store.setAgentDefaultBinding(sharedOwner.id, addedsharedOwner.binding.id, { revision: addedsharedOwner.revision });

  assert.deepEqual(store.getRuntimeAccount(sharedAccount.id), sharedAccount);
  store.close();

  const reopened = openStore(paths, { now: () => 241 });
  assert.deepEqual(reopened.getRuntimeAccount(explicitAccount.id), explicitAccount);
  assert.deepEqual(reopened.getRuntimeAccount(sharedAccount.id), sharedAccount);
  reopened.close();
});

test("RuntimeAccount 删除身份经 event/snapshot 保留且不能跨身份复用", () => {
  const paths = fixturePaths();
  let time = 250;
  const writer = openStore(paths, { now: () => time });
  const account = writer.putRuntimeAccount(managedAccount("durable-account-id"));
  assert.deepEqual(writer.deleteRuntimeAccount(account.id), account);

  time = 251;
  const eventReplayed = openStore(paths, { now: () => time });
  assert.equal(eventReplayed.getRuntimeAccount(account.id), null);
  const before = fs.readFileSync(paths.eventLogPath);
  assert.throws(
    () => eventReplayed.putRuntimeAccount(managedAccount(account.id, "future-runtime")),
    (error) => error.code === "RUNTIME_ACCOUNT_IDENTITY_IMMUTABLE",
  );
  assert.deepEqual(fs.readFileSync(paths.eventLogPath), before);
  eventReplayed.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.deepEqual(snapshot.runtimeAccountTombstones, [account]);
  time = 252;
  const snapshotReplayed = openStore(paths, { now: () => time });
  assert.throws(
    () => snapshotReplayed.putRuntimeAccount(managedAccount(account.id, "future-runtime")),
    (error) => error.code === "RUNTIME_ACCOUNT_IDENTITY_IMMUTABLE",
  );
  const restored = snapshotReplayed.putRuntimeAccount(account);
  assert.equal(restored.createdAt, account.createdAt);
  assert.equal(restored.updatedAt > account.updatedAt, true);
  snapshotReplayed.close();
  assert.deepEqual(
    JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).runtimeAccountTombstones,
    [],
  );
});

test("同一 RuntimeAccount 的 Profile Provider/Model 独立且 replay 一致", async () => {
  const paths = fixturePaths();
  let time = 300;
  const store = openStore(paths, { now: () => time });
  store.putModelProvider(provider("provider-one"));
  store.putModelProvider(provider("provider-two"));
  const first = store.putAgentProfile(profile("profile-one", {
    providerRef: "provider-one",
    defaultModel: "model-one",
  }));
  const account = store.getRuntimeAccount(first.runtimeAccountId);
  assert.equal(first.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(account.providerRef, null);
  const lastEvent = fs.readFileSync(paths.eventLogPath, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.deepEqual(Object.keys(lastEvent.payload), ["profile"]);

  const second = store.putAgentProfile(profile("profile-two", {
    runtimeAccountId: account.id,
    providerRef: "provider-two",
    defaultModel: "model-two",
  }));
  const staleProfileRevision = store.getAgentProfile("profile-one").updatedAt;
  time = 301;
  const updatedFirst = store.putAgentProfile({
    ...first,
    providerRef: null,
    defaultModel: "chatgpt-model",
  });
  const untouchedSecond = store.getAgentProfile("profile-two");
  assert.equal(updatedFirst.providerRef, null);
  assert.equal(updatedFirst.defaultModel, "chatgpt-model");
  assert.deepEqual(untouchedSecond, second);
  assert.throws(
    () => store.putRuntimeAccount({ ...account, providerRef: "provider-one" }),
    (error) => error.code === "RUNTIME_ACCOUNT_INVALID",
  );
  assert.deepEqual(store.getAgentProfile("profile-one"), updatedFirst);
  assert.deepEqual(store.getAgentProfile("profile-two"), second);

  const replayed = openStore(paths, { now: () => 302 });
  assert.deepEqual(replayed.getAgentProfile("profile-one"), updatedFirst);
  assert.deepEqual(replayed.getAgentProfile("profile-two"), second);
  const manager = new RuntimeSwitchManager({
    productStore: store,
    runtimeManager: { acquire() {}, stop() {} },
    contextSnapshotStore: { get() { return null; } },
    transcriptStore: { listEvents() { return []; } },
    assertExclusive() {},
    journal: {},
  });
  await assert.rejects(
    manager.switchProfile({
      profileId: "profile-one",
      expectedProfileUpdatedAt: staleProfileRevision,
      candidateBinding: {
        runtime: "future-runtime",
        runtimeProfileId: "future-profile",
        runtimeAccountId: "future-account",
      },
      verifyCanary: async () => ({ ok: true }),
    }),
    (error) => error.code === "RUNTIME_SWITCH_PROFILE_CONFLICT",
  );
  assert.equal(store.deleteModelProvider("provider-one").id, "provider-one");
  assert.throws(
    () => store.deleteModelProvider("provider-two"),
    (error) => error.code === "MODEL_PROVIDER_IN_USE",
  );
  replayed.close();
  store.close();
});

test("runtime projection writes are rejected; dedicated Binding changes default without deleting source", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 400 });
  const original = store.putAgentProfile(profile("switch-profile"));
  assert.throws(() => store.putAgentProfile({ ...original, runtime: "future-runtime" }),
    { code: "AGENT_BINDING_PROJECTION_READONLY" });
  const account = store.putRuntimeAccount(managedAccount("switch-account", "future-runtime"));
  const added = store.addAgentRuntimeBinding(original.id, { runtime: account.runtime, runtimeAccountId: account.id },
    { operationId: "switch" });
  const changed = store.setAgentDefaultBinding(original.id, added.binding.id, { revision: added.revision });
  assert.equal(store.getAgentProfile(original.id).runtimeAccountId, account.id);
  store.setAgentDefaultBinding(original.id, original.defaultBindingId, { revision: changed.revision });
  assert.equal(store.getAgentProfile(original.id).runtimeAccountId, original.runtimeAccountId);
  store.close();
});

test("v8 WorkRun 新写严格要求账号且必须匹配 Profile binding", () => {
  const paths = fixturePaths();
  const store = openStore(paths, { now: () => 560 });
  const profileValue = store.listAgentProfiles().find((candidate) => candidate.isDefault);
  const missingAccount = workRun("missing-account", profileValue);
  delete missingAccount.runtimeSessionRef.runtimeAccountId;
  delete missingAccount.runtimeTurnRef.runtimeAccountId;
  assert.throws(
    () => store.putWorkRun(missingAccount),
    (error) => error.code === "STORE_INVALID_RECORD",
  );
  assert.throws(
    () => store.putWorkRun(workRun("wrong-account", profileValue, "other-account")),
    (error) => error.code === "WORK_RUN_BINDING_INVALID",
  );
  store.close();
});

test("RuntimeAccount snapshot/event 模型错误映射为存储损坏且 revision 不倒退", () => {
  const snapshotPaths = fixturePaths();
  const snapshotStore = openStore(snapshotPaths);
  snapshotStore.close();
  const snapshot = JSON.parse(fs.readFileSync(snapshotPaths.stateSnapshotPath, "utf8"));
  snapshot.runtimeAccounts[0].kind = "unknown-kind";
  writeSnapshot(snapshotPaths.stateSnapshotPath, snapshot);
  assert.throws(() => openStore(snapshotPaths),
    (error) => error.code === "STORE_CORRUPT_SNAPSHOT");

  const eventPaths = fixturePaths();
  let time = 600;
  const eventStore = openStore(eventPaths, { now: () => time });
  const account = eventStore.putRuntimeAccount(managedAccount("revision-account"));
  time = 700;
  const latest = eventStore.putRuntimeAccount(account);
  appendEvents(eventPaths.eventLogPath, [{
    schemaVersion: STORE_SCHEMA_VERSION,
    seq: 4,
    aggregateId: latest.id,
    type: "runtime_account.put",
    time: 701,
    payload: { account: { ...latest, updatedAt: 650 } },
  }]);
  assert.throws(() => openStore(eventPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG");

  const unknownPaths = fixturePaths();
  const unknownStore = openStore(unknownPaths);
  appendEvents(unknownPaths.eventLogPath, [{
    schemaVersion: STORE_SCHEMA_VERSION,
    seq: 2,
    aggregateId: "unknown-field-account",
    type: "runtime_account.put",
    time: 800,
    payload: { account: { ...managedAccount("unknown-field-account"), extra: true } },
  }]);
  assert.throws(() => openStore(unknownPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG");
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
      console.error(error.stack || error);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`PASS runtime account product store unit (${tests.length})`);
})();
