#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  JsonlProductStore,
  RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  defaultAgentProfile,
  eventChecksum,
  snapshotChecksum,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(
  ROOT, "app", "agent-service", "builtin-cli-profiles.js",
));
const { RuntimeSwitchManager } = require(path.join(
  ROOT, "app", "agent-service", "runtime-switch-manager.js",
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
  for (const event of events) event.checksum = eventChecksum(event);
  fs.appendFileSync(target, `${events.map(JSON.stringify).join("\n")}\n`);
}

function writeSnapshot(target, snapshot) {
  snapshot.checksum = snapshotChecksum(snapshot);
  fs.writeFileSync(target, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

function legacyV6Snapshot(agentProfiles, lastSeq = 0) {
  return {
    schemaVersion: 6,
    lastSeq,
    modelProviders: [],
    agentProfiles,
    workRuns: [],
    runNotes: [],
    mcpToolCalls: [],
  };
}

function runtimeAccountAuthorityView(store) {
  return {
    runtimeAccounts: store.listRuntimeAccounts().sort((left, right) => left.id.localeCompare(right.id)),
    agentProfiles: store.listAgentProfiles().sort((left, right) => left.id.localeCompare(right.id)),
  };
}

test("fresh v8 静默合成七个固定账号且只写默认 Profile 事件", () => {
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
  assert.equal(events[0].payload.profile.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
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
    backendId: "future-backend",
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
    backendId: "codex",
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: "native-provider-ref",
  }));
  assert.equal(nativeProvider.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(nativeProvider.providerRef, "native-provider-ref");
  const builtin = BUILTIN_CLI_AGENT_PROFILES[0];
  assert.throws(
    () => store.putAgentProfile(profile(builtin.id, {
      ...builtin, runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    })),
    (error) => error.code === "AGENT_PROFILE_IDENTITY_CONFLICT",
  );
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
    (error) => error.code === "AGENT_PROFILE_IDENTITY_CONFLICT",
  );
  const grok = BUILTIN_CLI_AGENT_PROFILES[1];
  assert.throws(
    () => store.putAgentProfile(profile(grok.id, {
      ...grok,
      runtimeAccountId: providerlessManaged.id,
      providerRef: "native-provider-ref",
    })),
    (error) => error.code === "AGENT_PROFILE_IDENTITY_CONFLICT",
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

  const { runtimeAccountId: _managedAccountId, ...legacyProviderless } = configured;
  time += 1;
  const restored = store.putAgentProfile({ ...legacyProviderless, providerRef: null });
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
    backendId: "future-backend",
    runtime: "future-runtime",
    runtimeAccountId: explicitAccount.id,
    providerRef: "explicit-provider",
  }));
  store.putAgentProfile({
    ...explicitProfile,
    runtime: "codex",
    runtimeProfileId: "explicit-owner-codex",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: null,
  });
  assert.deepEqual(store.getRuntimeAccount(explicitAccount.id), explicitAccount);

  const sharedAccount = store.putRuntimeAccount(managedAccount(
    "shared-managed-account",
    "future-runtime",
  ));
  const sharedOwner = store.putAgentProfile(profile("shared-owner", {
    backendId: "future-backend",
    runtime: "future-runtime",
    runtimeAccountId: sharedAccount.id,
    providerRef: "shared-provider",
  }));
  store.putAgentProfile(profile("shared-peer", {
    backendId: "future-backend-two",
    runtime: "future-runtime",
    runtimeAccountId: sharedAccount.id,
    providerRef: "shared-provider",
  }));
  store.putAgentProfile({
    ...sharedOwner,
    runtime: "codex",
    runtimeProfileId: "shared-owner-codex",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: null,
  });
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

test("legacy provider replay 保留最终 Profile Provider 且不写入 RuntimeAccount", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 350 });
  seeded.putModelProvider(provider("legacy-provider-one"));
  seeded.putModelProvider(provider("legacy-provider-two"));
  seeded.putAgentProfile(profile("legacy-provider-profile", {
    providerRef: "legacy-provider-one",
  }));
  seeded.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 6;
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  for (const candidate of snapshot.agentProfiles) delete candidate.runtimeAccountId;
  writeSnapshot(paths.stateSnapshotPath, snapshot);
  const legacy = snapshot.agentProfiles.find(({ id }) => id === "legacy-provider-profile");
  appendEvents(paths.eventLogPath, [
    {
      schemaVersion: 6,
      seq: snapshot.lastSeq + 1,
      aggregateId: legacy.id,
      type: "agent_profile.put",
      time: 400,
      payload: {
        profile: { ...legacy, providerRef: "legacy-provider-two", updatedAt: 351 },
      },
    },
    {
      schemaVersion: 6,
      seq: snapshot.lastSeq + 2,
      aggregateId: legacy.id,
      type: "agent_profile.put",
      time: 400,
      payload: {
        profile: { ...legacy, providerRef: "legacy-provider-one", updatedAt: 352 },
      },
    },
  ]);

  const migrated = openStore(paths);
  const profileAfter = migrated.getAgentProfile(legacy.id);
  const accountAfter = migrated.getRuntimeAccount(profileAfter.runtimeAccountId);
  assert.equal(profileAfter.providerRef, "legacy-provider-one");
  assert.equal(profileAfter.updatedAt, 352);
  assert.equal(profileAfter.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(accountAfter.providerRef, null);
  assert.equal(accountAfter.createdAt, null);
  assert.equal(accountAfter.updatedAt, null);
  migrated.close();
  const reopened = openStore(paths);
  assert.deepEqual(reopened.getRuntimeAccount(profileAfter.runtimeAccountId), accountAfter);
  reopened.close();
});

test("v6 默认 Shoggoth 自定义 provider 从 snapshot/event 迁移后可重开", () => {
  for (const source of ["snapshot", "event"]) {
    const paths = fixturePaths();
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    const providerId = `legacy-default-provider-${source}`;
    const legacyProfile = defaultAgentProfile(10);
    delete legacyProfile.runtimeAccountId;
    legacyProfile.providerRef = providerId;

    if (source === "snapshot") {
      const snapshot = legacyV6Snapshot([legacyProfile]);
      snapshot.modelProviders.push(provider(providerId));
      writeSnapshot(paths.stateSnapshotPath, snapshot);
    } else {
      appendEvents(paths.eventLogPath, [
        {
          schemaVersion: 6,
          seq: 1,
          aggregateId: providerId,
          type: "model_provider.put",
          time: 9,
          payload: { provider: provider(providerId) },
        },
        {
          schemaVersion: 6,
          seq: 2,
          aggregateId: legacyProfile.id,
          type: "agent_profile.put",
          time: 10,
          payload: { profile: legacyProfile },
        },
      ]);
    }

    const migrated = openStore(paths, { now: () => 11 });
    const migratedProfile = migrated.getAgentProfile(legacyProfile.id);
    const migratedAccount = migrated.getRuntimeAccount(
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    );
    assert.equal(migratedProfile.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    assert.equal(migratedProfile.providerRef, providerId);
    assert.equal(migratedAccount.providerRef, null);
    assert.equal(migratedAccount.createdAt, null);
    assert.equal(migratedAccount.updatedAt, null);
    migrated.close();

    const rewritten = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    assert.equal(rewritten.schemaVersion, STORE_SCHEMA_VERSION);
    const reopened = openStore(paths, { now: () => 12 });
    assert.deepEqual(reopened.getAgentProfile(legacyProfile.id), migratedProfile);
    assert.deepEqual(
      reopened.getRuntimeAccount(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID),
      migratedAccount,
    );
    reopened.close();
  }
});

test("v7 多个 managed Codex Profile 合并内部账号并保留各自 Provider/Model", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 15 });
  seeded.putModelProvider(provider("legacy-profile-provider-one"));
  seeded.putModelProvider(provider("legacy-profile-provider-two"));
  seeded.putModelProvider(provider("legacy-native-provider"));
  seeded.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION;
  const firstAccount = managedAccount("legacy-v7-codex-one", "codex", {
    providerRef: "legacy-profile-provider-one",
    createdAt: 10,
    updatedAt: 10,
  });
  const secondAccount = managedAccount("legacy-v7-codex-two", "codex", {
    providerRef: "legacy-profile-provider-two",
    createdAt: 11,
    updatedAt: 11,
  });
  const nativeLegacyAccount = managedAccount("legacy-v7-native-codex", "codex", {
    providerRef: "legacy-native-provider",
    createdAt: 12,
    updatedAt: 12,
  });
  snapshot.runtimeAccounts.push(firstAccount, secondAccount, nativeLegacyAccount);
  const nativeSpec = BUILTIN_CLI_AGENT_PROFILES[0];
  const firstProfile = profile("legacy-v7-profile-one", {
    runtimeAccountId: firstAccount.id,
    providerRef: "legacy-profile-provider-one",
    defaultModel: "model-one",
    createdAt: 10,
    updatedAt: 10,
  });
  snapshot.agentProfiles.push(
    firstProfile,
    profile("legacy-v7-profile-two", {
      runtimeAccountId: secondAccount.id,
      providerRef: "legacy-profile-provider-two",
      defaultModel: "model-two",
      createdAt: 11,
      updatedAt: 11,
    }),
    profile(nativeSpec.id, {
      ...nativeSpec,
      runtimeAccountId: nativeLegacyAccount.id,
      providerRef: "legacy-native-provider",
      defaultModel: "native-model",
      createdAt: 12,
      updatedAt: 12,
    }),
  );
  writeSnapshot(paths.stateSnapshotPath, snapshot);
  appendEvents(paths.eventLogPath, [{
    schemaVersion: RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
    seq: snapshot.lastSeq + 1,
    aggregateId: firstProfile.id,
    type: "agent_profile.put",
    time: 13,
    payload: {
      profile: {
        ...firstProfile,
        name: "legacy v7 replayed",
        defaultModel: "model-one-replayed",
        updatedAt: 13,
      },
    },
  }]);

  const migrated = openStore(paths, { now: () => 16 });
  const first = migrated.getAgentProfile("legacy-v7-profile-one");
  const second = migrated.getAgentProfile("legacy-v7-profile-two");
  const native = migrated.getAgentProfile(nativeSpec.id);
  assert.equal(first.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(second.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.deepEqual(
    [first.name, first.providerRef, first.defaultModel, second.providerRef, second.defaultModel],
    [
      "legacy v7 replayed",
      "legacy-profile-provider-one",
      "model-one-replayed",
      "legacy-profile-provider-two",
      "model-two",
    ],
  );
  assert.equal(migrated.getRuntimeAccount(firstAccount.id), null);
  assert.equal(migrated.getRuntimeAccount(secondAccount.id), null);
  assert.equal(migrated.getRuntimeAccount(nativeLegacyAccount.id), null);
  assert.equal(native.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.deepEqual(
    [native.providerRef, native.defaultModel],
    ["legacy-native-provider", "native-model"],
  );
  assert.equal(
    migrated.getRuntimeAccount(SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID).providerRef,
    null,
  );
  migrated.close();

  const reopened = openStore(paths, { now: () => 17 });
  assert.deepEqual(reopened.getAgentProfile(first.id), first);
  assert.deepEqual(reopened.getAgentProfile(second.id), second);
  assert.deepEqual(reopened.getAgentProfile(native.id), native);
  reopened.close();
});

test("相同 v6 终态从 event-only 或 compacted snapshot 迁移出相同账号 authority", () => {
  const eventPaths = fixturePaths();
  const snapshotPaths = fixturePaths();
  fs.mkdirSync(eventPaths.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(snapshotPaths.stateDir, { recursive: true, mode: 0o700 });
  const initial = profile("legacy-runtime-history", {
    runtimeProfileId: "legacy-runtime-codex",
    createdAt: 10,
    updatedAt: 10,
  });
  const finalProfile = {
    ...initial,
    runtime: "future-runtime",
    runtimeProfileId: "legacy-runtime-future",
    updatedAt: 20,
  };
  appendEvents(eventPaths.eventLogPath, [
    {
      schemaVersion: 6,
      seq: 1,
      aggregateId: initial.id,
      type: "agent_profile.put",
      time: 100,
      payload: { profile: initial },
    },
    {
      schemaVersion: 6,
      seq: 2,
      aggregateId: finalProfile.id,
      type: "agent_profile.put",
      time: 101,
      payload: { profile: finalProfile },
    },
  ]);
  writeSnapshot(
    snapshotPaths.stateSnapshotPath,
    legacyV6Snapshot([finalProfile], 2),
  );

  const fromEvents = openStore(eventPaths, { now: () => 1_000 });
  const fromSnapshot = openStore(snapshotPaths, { now: () => 1_000 });
  assert.deepEqual(
    runtimeAccountAuthorityView(fromEvents),
    runtimeAccountAuthorityView(fromSnapshot),
  );
  const activeProfile = fromEvents.getAgentProfile(finalProfile.id);
  assert.equal(fromEvents.getRuntimeAccount(activeProfile.runtimeAccountId).updatedAt, 20);
  fromEvents.close();
  fromSnapshot.close();
  assert.deepEqual(
    JSON.parse(fs.readFileSync(eventPaths.stateSnapshotPath, "utf8")).runtimeAccountTombstones,
    [],
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(snapshotPaths.stateSnapshotPath, "utf8")).runtimeAccountTombstones,
    [],
  );
});

test("v6 snapshot 与 event 保留旧版允许的长和特殊 Profile ID", () => {
  const legacyId = `legacy profile/带空格/😀/${"x".repeat(129)}`;
  const legacyProfile = profile(legacyId, {
    agentId: "legacy-special-agent",
    runtimeProfileId: "legacy-special-runtime",
    createdAt: 30,
    updatedAt: 30,
  });
  for (const source of ["snapshot", "event"]) {
    const paths = fixturePaths();
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    if (source === "snapshot") {
      writeSnapshot(paths.stateSnapshotPath, legacyV6Snapshot([legacyProfile]));
    } else {
      appendEvents(paths.eventLogPath, [{
        schemaVersion: 6,
        seq: 1,
        aggregateId: legacyId,
        type: "agent_profile.put",
        time: 31,
        payload: { profile: legacyProfile },
      }]);
    }
    const store = openStore(paths, { now: () => 1_000 });
    const migrated = store.getAgentProfile(legacyId);
    assert.equal(migrated.id, legacyId);
    assert.equal(migrated.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    assert.deepEqual(
      store.getRuntimeAccount(migrated.runtimeAccountId),
      DEFAULT_RUNTIME_ACCOUNTS.find(
        (account) => account.id === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      ),
    );
    store.close();
  }
  const livePaths = fixturePaths();
  const liveStore = openStore(livePaths, { now: () => 1_000 });
  const liveProfile = liveStore.putAgentProfile(legacyProfile);
  assert.equal(liveProfile.id, legacyId);
  assert.equal(liveProfile.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  liveStore.close();
});

test("v6 倒序 Profile timestamp 不会污染共享内部账号 revision", () => {
  const legacyProfile = profile("legacy-reversed-time", {
    runtimeProfileId: "legacy-reversed-time-runtime",
    createdAt: 100,
    updatedAt: 50,
  });
  for (const source of ["snapshot", "event"]) {
    const paths = fixturePaths();
    fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    if (source === "snapshot") {
      writeSnapshot(paths.stateSnapshotPath, legacyV6Snapshot([legacyProfile]));
    } else {
      appendEvents(paths.eventLogPath, [{
        schemaVersion: 6,
        seq: 1,
        aggregateId: legacyProfile.id,
        type: "agent_profile.put",
        time: 101,
        payload: { profile: legacyProfile },
      }]);
    }
    const store = openStore(paths, { now: () => 1_000 });
    const migrated = store.getAgentProfile(legacyProfile.id);
    assert.deepEqual(
      store.getRuntimeAccount(migrated.runtimeAccountId),
      {
        id: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        runtime: "codex",
        kind: "shoggoth-managed",
        installationKind: "bundled",
        homeKind: "managed-shared",
        providerRef: null,
        isDefault: true,
        createdAt: null,
        updatedAt: null,
      },
    );
    store.close();
  }
});

test("v6 null timestamp Profile 改绑不会删除共享内部账号", () => {
  const paths = fixturePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const legacyProfile = profile("legacy-null-time", {
    runtimeProfileId: "legacy-null-time-runtime",
    createdAt: null,
    updatedAt: null,
  });
  writeSnapshot(paths.stateSnapshotPath, legacyV6Snapshot([legacyProfile]));
  let time = 1_000;
  const store = openStore(paths, { now: () => time });
  const migratedProfile = store.getAgentProfile(legacyProfile.id);
  const migratedAccount = store.getRuntimeAccount(migratedProfile.runtimeAccountId);
  assert.equal(migratedAccount.createdAt, null);
  assert.equal(migratedAccount.updatedAt, null);

  assert.deepEqual(store.getRuntimeAccount(migratedAccount.id), migratedAccount);
  assert.throws(
    () => store.deleteRuntimeAccount(migratedAccount.id),
    (error) => error.code === "RUNTIME_ACCOUNT_DEFAULT",
  );
  store.close();
});

test("v6 Codex built-in Provider 保留在 Profile 且使用固定本机账号", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 360 });
  seeded.putModelProvider(provider("builtin-legacy-provider-one"));
  seeded.putModelProvider(provider("builtin-legacy-provider-two"));
  seeded.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 6;
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  for (const candidate of snapshot.agentProfiles) delete candidate.runtimeAccountId;
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const legacyBuiltin = profile(spec.id, {
    ...spec,
    providerRef: "builtin-legacy-provider-one",
    createdAt: 360,
    updatedAt: 360,
  });
  snapshot.agentProfiles.push(legacyBuiltin);
  writeSnapshot(paths.stateSnapshotPath, snapshot);
  appendEvents(paths.eventLogPath, [{
    schemaVersion: 6,
    seq: snapshot.lastSeq + 1,
    aggregateId: spec.id,
    type: "agent_profile.put",
    time: 361,
    payload: {
      profile: {
        ...legacyBuiltin,
        providerRef: "builtin-legacy-provider-two",
        updatedAt: 361,
      },
    },
  }]);

  const migrated = openStore(paths, { now: () => 362 });
  const migratedProfile = migrated.getAgentProfile(spec.id);
  const migratedAccount = migrated.getRuntimeAccount(migratedProfile.runtimeAccountId);
  assert.equal(migratedProfile.providerRef, "builtin-legacy-provider-two");
  assert.equal(migratedAccount.id, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.deepEqual(
    {
      runtime: migratedAccount.runtime,
      kind: migratedAccount.kind,
      isDefault: migratedAccount.isDefault,
      providerRef: migratedAccount.providerRef,
      createdAt: migratedAccount.createdAt,
      updatedAt: migratedAccount.updatedAt,
    },
    {
      runtime: "codex",
      kind: "native-user",
      isDefault: true,
      providerRef: null,
      createdAt: null,
      updatedAt: null,
    },
  );
  migrated.close();

  const rewritten = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(rewritten.schemaVersion, STORE_SCHEMA_VERSION);
  const reopened = openStore(paths, { now: () => 363 });
  assert.deepEqual(reopened.getAgentProfile(spec.id), migratedProfile);
  assert.deepEqual(reopened.getRuntimeAccount(migratedAccount.id), migratedAccount);
  reopened.close();
});

test("无 snapshot 的 v6 built-in provider 解绑不生成虚假账号 tombstone", () => {
  const paths = fixturePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const bound = profile(spec.id, {
    ...spec,
    providerRef: "v6-deleted-provider",
    createdAt: 1,
    updatedAt: 2,
  });
  appendEvents(paths.eventLogPath, [
    {
      schemaVersion: 6,
      seq: 1,
      aggregateId: "v6-deleted-provider",
      type: "model_provider.put",
      time: 1,
      payload: { provider: provider("v6-deleted-provider") },
    },
    {
      schemaVersion: 6,
      seq: 2,
      aggregateId: spec.id,
      type: "agent_profile.put",
      time: 2,
      payload: { profile: bound },
    },
    {
      schemaVersion: 6,
      seq: 3,
      aggregateId: spec.id,
      type: "agent_profile.put",
      time: 3,
      payload: { profile: { ...bound, providerRef: null, updatedAt: 3 } },
    },
    {
      schemaVersion: 6,
      seq: 4,
      aggregateId: "v6-deleted-provider",
      type: "model_provider.delete",
      time: 4,
      payload: {},
    },
  ]);

  const migrated = openStore(paths, { now: () => 5 });
  const migratedProfile = migrated.getAgentProfile(spec.id);
  assert.equal(migratedProfile.runtimeAccountId, NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
  assert.equal(migrated.getModelProvider("v6-deleted-provider"), null);
  assert.equal(migrated.listRuntimeAccounts().some((account) => (
    account.providerRef === "v6-deleted-provider"
  )), false);
  migrated.close();

  const rewritten = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(rewritten.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(rewritten.runtimeAccountTombstones.some((account) => (
    account.providerRef === "v6-deleted-provider"
  )), false);
  const reopened = openStore(paths, { now: () => 6 });
  assert.deepEqual(reopened.getAgentProfile(spec.id), migratedProfile);
  assert.equal(reopened.getModelProvider("v6-deleted-provider"), null);
  reopened.close();
});

test("v8 event replay 接受 Codex built-in 固定本机账号并拒绝 managed 账号", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 380 });
  seeded.putModelProvider(provider("builtin-v7-provider"));
  seeded.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  const spec = BUILTIN_CLI_AGENT_PROFILES[0];
  const account = DEFAULT_RUNTIME_ACCOUNTS.find(
    (candidate) => candidate.id === NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  );
  const builtin = profile(spec.id, {
    ...spec,
    runtimeAccountId: account.id,
    providerRef: "builtin-v7-provider",
    createdAt: 381,
    updatedAt: 381,
  });
  appendEvents(paths.eventLogPath, [{
    schemaVersion: STORE_SCHEMA_VERSION,
    seq: snapshot.lastSeq + 1,
    aggregateId: builtin.id,
    type: "agent_profile.put",
    time: 381,
    payload: { profile: builtin },
  }]);
  const replayed = openStore(paths, { now: () => 382 });
  assert.deepEqual(replayed.getAgentProfile(spec.id), builtin);
  assert.deepEqual(replayed.getRuntimeAccount(account.id), account);
  replayed.close();

  const invalidPaths = fixturePaths();
  const invalidSeeded = openStore(invalidPaths, { now: () => 383 });
  invalidSeeded.putModelProvider(provider("builtin-v7-invalid-provider"));
  invalidSeeded.close();
  const invalidSnapshot = JSON.parse(fs.readFileSync(invalidPaths.stateSnapshotPath, "utf8"));
  const invalidAccount = managedAccount("builtin-v8-invalid-managed", "codex", {
    createdAt: 384,
    updatedAt: 384,
  });
  const invalidBuiltin = profile(spec.id, {
    ...spec,
    runtimeAccountId: invalidAccount.id,
    providerRef: "builtin-v7-invalid-provider",
    createdAt: 384,
    updatedAt: 384,
  });
  appendEvents(invalidPaths.eventLogPath, [
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: invalidSnapshot.lastSeq + 1,
      aggregateId: invalidAccount.id,
      type: "runtime_account.put",
      time: 384,
      payload: { account: invalidAccount },
    },
    {
      schemaVersion: STORE_SCHEMA_VERSION,
      seq: invalidSnapshot.lastSeq + 2,
      aggregateId: invalidBuiltin.id,
      type: "agent_profile.put",
      time: 384,
      payload: { profile: invalidBuiltin },
    },
  ]);
  assert.throws(
    () => openStore(invalidPaths),
    (error) => error.code === "STORE_CORRUPT_EVENT_LOG",
  );
});

test("existing Profile 省略 runtimeAccountId 时保留账号并允许默认 Profile 更新", () => {
  const paths = fixturePaths();
  let time = 375;
  const store = openStore(paths, { now: () => time });
  const defaultProfile = store.listAgentProfiles().find(({ isDefault }) => isDefault);
  const { runtimeAccountId: _defaultAccountId, ...legacyDefaultUpdate } = defaultProfile;
  time += 1;
  const updatedDefault = store.putAgentProfile({
    ...legacyDefaultUpdate,
    name: "Updated default without account field",
  });
  assert.equal(updatedDefault.runtimeAccountId, defaultProfile.runtimeAccountId);

  const custom = store.putAgentProfile(profile("legacy-shaped-update"));
  const { runtimeAccountId: _customAccountId, ...legacyCustomUpdate } = custom;
  time += 1;
  const updatedCustom = store.putAgentProfile({ ...legacyCustomUpdate, name: "Updated custom" });
  assert.equal(updatedCustom.runtimeAccountId, custom.runtimeAccountId);
  assert.equal(updatedCustom.name, "Updated custom");
  store.close();
});

test("failed open 重试会 reset legacy/provider replay flags", () => {
  const paths = fixturePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const store = new JsonlProductStore({ paths });
  appendEvents(paths.eventLogPath, [
    {
      schemaVersion: 2,
      seq: 1,
      aggregateId: "first-attempt-provider",
      type: "model_provider.put",
      time: 1,
      payload: { provider: provider("first-attempt-provider") },
    },
    {
      schemaVersion: 2,
      seq: 2,
      aggregateId: "bad-event",
      type: "unknown.event",
      time: 2,
      payload: {},
    },
  ]);
  assert.throws(() => store.open(), (error) => error.code === "STORE_CORRUPT_EVENT_LOG");
  assert.equal(store.sawProviderEvent, true);

  fs.writeFileSync(paths.eventLogPath, "", { mode: 0o600 });
  appendEvents(paths.eventLogPath, [{
    schemaVersion: 1,
    seq: 1,
    aggregateId: "legacy-missing-provider",
    type: "agent_profile.put",
    time: 3,
    payload: {
      profile: profile("legacy-missing-provider", {
        providerRef: "missing-provider",
        createdAt: 3,
        updatedAt: 3,
      }),
    },
  }]);
  assert.throws(
    () => store.open(),
    (error) => error.code === "STORE_LEGACY_PROVIDER_REFERENCE_UNRESOLVED",
  );
  assert.equal(store.sawProviderEvent, false);
});

test("spread runtime switch 自动重派生账号，切回原 runtime 恢复原账号", () => {
  const paths = fixturePaths();
  let time = 400;
  const store = openStore(paths, { now: () => time });
  const original = store.putAgentProfile(profile("switch-profile"));
  time += 1;
  const switched = store.putAgentProfile({
    ...original, runtime: "future-runtime", runtimeProfileId: "switch-profile-future",
  });
  assert.notEqual(switched.runtimeAccountId, original.runtimeAccountId);
  assert.equal(store.getRuntimeAccount(switched.runtimeAccountId).runtime, "future-runtime");
  time += 1;
  const restored = store.putAgentProfile({
    ...switched, runtime: "codex", runtimeProfileId: original.runtimeProfileId,
  });
  assert.equal(restored.runtimeAccountId, original.runtimeAccountId);
  store.close();
});

test("v6 snapshot/event 后可顺序 replay v7 account/profile 事件并重写 v8", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 500 });
  seeded.putAgentProfile(profile("legacy-profile"));
  seeded.close();
  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = 6;
  delete snapshot.runtimeAccounts;
  delete snapshot.runtimeAccountTombstones;
  for (const candidate of snapshot.agentProfiles) delete candidate.runtimeAccountId;
  writeSnapshot(paths.stateSnapshotPath, snapshot);

  const legacyProfile = snapshot.agentProfiles.find((candidate) => candidate.id === "legacy-profile");
  const account = managedAccount("event-account", "future-runtime", {
    createdAt: 501, updatedAt: 501,
  });
  const eventProfile = profile("event-profile", {
    runtime: "future-runtime",
    runtimeProfileId: "event-profile-future",
    runtimeAccountId: account.id,
    createdAt: 502,
    updatedAt: 502,
  });
  appendEvents(paths.eventLogPath, [
    {
      schemaVersion: 6, seq: snapshot.lastSeq + 1, aggregateId: legacyProfile.id,
      type: "agent_profile.put", time: 501,
      payload: { profile: { ...legacyProfile, name: "legacy replayed", updatedAt: 501 } },
    },
    {
      schemaVersion: RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
      seq: snapshot.lastSeq + 2,
      aggregateId: account.id,
      type: "runtime_account.put", time: 502, payload: { account },
    },
    {
      schemaVersion: RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
      seq: snapshot.lastSeq + 3,
      aggregateId: eventProfile.id,
      type: "agent_profile.put", time: 503, payload: { profile: eventProfile },
    },
  ]);
  const replayed = openStore(paths);
  assert.equal(replayed.getAgentProfile("legacy-profile").name, "legacy replayed");
  assert.equal(replayed.getAgentProfile("event-profile").runtimeAccountId, account.id);
  replayed.close();
  assert.equal(
    JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).schemaVersion,
    STORE_SCHEMA_VERSION,
  );
});

test("v7 WorkRun ref 从 Profile 补齐账号并以 v8 roundtrip", () => {
  const paths = fixturePaths();
  const seeded = openStore(paths, { now: () => 550 });
  const profileValue = seeded.getAgentProfile(
    seeded.listAgentProfiles().find((candidate) => candidate.isDefault).id,
  );
  seeded.putWorkRun(workRun("v7-ref", profileValue));
  seeded.close();

  const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  snapshot.schemaVersion = RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION;
  for (const ref of [
    snapshot.workRuns[0].runtimeSessionRef,
    snapshot.workRuns[0].runtimeTurnRef,
  ]) delete ref.runtimeAccountId;
  writeSnapshot(paths.stateSnapshotPath, snapshot);
  const eventRun = workRun("v7-event-ref", profileValue);
  for (const ref of [eventRun.runtimeSessionRef, eventRun.runtimeTurnRef]) {
    delete ref.runtimeAccountId;
  }
  appendEvents(paths.eventLogPath, [{
    schemaVersion: RUNTIME_ACCOUNT_STORE_SCHEMA_VERSION,
    seq: snapshot.lastSeq + 1,
    aggregateId: eventRun.id,
    type: "work_run.put",
    time: 551,
    payload: { run: eventRun },
  }]);

  const migrated = openStore(paths, { now: () => 551 });
  const run = migrated.getWorkRun("v7-ref");
  const replayedRun = migrated.getWorkRun("v7-event-ref");
  assert.equal(run.runtimeSessionRef.runtimeAccountId, profileValue.runtimeAccountId);
  assert.equal(run.runtimeTurnRef.runtimeAccountId, profileValue.runtimeAccountId);
  assert.equal(replayedRun.runtimeSessionRef.runtimeAccountId, profileValue.runtimeAccountId);
  assert.equal(replayedRun.runtimeTurnRef.runtimeAccountId, profileValue.runtimeAccountId);
  migrated.close();
  const rewritten = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  assert.equal(rewritten.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(rewritten.workRuns[0].runtimeSessionRef, run.runtimeSessionRef);
  assert.deepEqual(rewritten.workRuns[0].runtimeTurnRef, run.runtimeTurnRef);
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
