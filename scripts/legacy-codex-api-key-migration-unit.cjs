#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_AGENT_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE_ID,
  JsonlProductStore,
} = require("../app/agent-service/product-store");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const {
  LEGACY_CODEX_AUTH_QUARANTINE_BASENAME,
  deterministicCredentialRef,
  migrateLegacySharedCodexApiKey,
} = require("../app/agent-service/legacy-codex-api-key-migration");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");

const KEY = "sk-shoggoth-legacy-migration-canary-000000000001";
const OTHER_KEY = "sk-shoggoth-existing-different-canary-00000002";
const PROVIDER_ID = "provider-openai-legacy";
const MODEL = "gpt-5.4";
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function safeStorage() {
  const transform = (value) => {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
    for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0x5a;
    return bytes;
  };
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => transform(value),
    decryptString: (value) => transform(value).toString("utf8"),
  };
}

function provider(id = PROVIDER_ID, credentialRef = null) {
  return {
    id,
    kind: "openai-api-key",
    name: "OpenAI API Key",
    baseUrl: null,
    model: MODEL,
    credentialRef,
    headers: null,
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
  };
}

function fixturePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-legacy-codex-key-"));
  return {
    root,
    paths: resolveServicePaths({
      stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"),
      trustedRoot: root,
    }),
  };
}

function legacyHome(paths, runtimeProfileId = DEFAULT_RUNTIME_PROFILE_ID) {
  return path.join(paths.stateDir, "codex", runtimeProfileId);
}

function authPath(paths, runtimeProfileId = DEFAULT_RUNTIME_PROFILE_ID) {
  return path.join(legacyHome(paths, runtimeProfileId), "auth.json");
}

function quarantinePath(paths, runtimeProfileId = DEFAULT_RUNTIME_PROFILE_ID) {
  return path.join(legacyHome(paths, runtimeProfileId), LEGACY_CODEX_AUTH_QUARANTINE_BASENAME);
}

function writeAuth(paths, value, runtimeProfileId = DEFAULT_RUNTIME_PROFILE_ID) {
  fs.mkdirSync(legacyHome(paths, runtimeProfileId), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(paths.stateDir, "codex"), 0o700);
  fs.chmodSync(legacyHome(paths, runtimeProfileId), 0o700);
  const serialized = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(authPath(paths, runtimeProfileId), serialized, { mode: 0o600 });
  fs.chmodSync(authPath(paths, runtimeProfileId), 0o600);
}

function canonicalAuth(key = KEY) {
  return { auth_mode: "apikey", OPENAI_API_KEY: key };
}

function chatGptAuth() {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: "fixture-chatgpt-token" },
    last_refresh: "2026-09-07T00:00:00Z",
  };
}

async function openFixture(options = {}) {
  const fixture = fixturePaths();
  const userHome = path.join(fixture.root, "user-home");
  fs.mkdirSync(userHome, { recursive: true, mode: 0o700 });
  const storage = safeStorage();
  const productStore = new JsonlProductStore({ paths: fixture.paths, now: () => 100 });
  const secretStore = new EncryptedSecretStore({ paths: fixture.paths, safeStorage: storage });
  productStore.open();
  await secretStore.open();
  if (options.owner !== false) {
    const credentialRef = options.credentialRef ?? null;
    productStore.putModelProvider(provider(PROVIDER_ID, credentialRef));
    const profile = productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    productStore.putAgentProfile({ ...profile, providerRef: PROVIDER_ID, defaultModel: MODEL });
    if (credentialRef !== null && options.existingSecret) {
      await secretStore.put(credentialRef, options.existingSecret, { kind: "openai-api-key" });
    }
  }
  return {
    ...fixture,
    storage,
    productStore,
    secretStore,
    parentEnv: {},
    homedir: () => userHome,
  };
}

async function closeFixture(fixture, remove = true) {
  await fixture.secretStore.close().catch(() => {});
  try { fixture.productStore.close(); } catch {}
  if (remove) fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function reopenFixture(fixture) {
  const productStore = new JsonlProductStore({ paths: fixture.paths, now: () => 200 }).open();
  const secretStore = new EncryptedSecretStore({
    paths: fixture.paths,
    safeStorage: fixture.storage,
  });
  await secretStore.open();
  return { ...fixture, productStore, secretStore };
}

function serializedError(error) {
  return JSON.stringify(error, Object.getOwnPropertyNames(error));
}

function assertNoPlaintext(paths) {
  for (const target of [
    paths.encryptedSecretsPath,
    paths.eventLogPath,
    paths.stateSnapshotPath,
    paths.legacyCodexApiKeyMigrationPath,
  ]) {
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, "utf8").includes(KEY), false, target);
  }
}

test("canonical legacy API key 迁入密文 Store、绑定唯一 Provider 并只删除 shared auth", async () => {
  let fixture = await openFixture();
  try {
    writeAuth(fixture.paths, canonicalAuth());
    const nativeHome = path.join(fixture.root, "user-home", ".codex");
    fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
    const nativeAuth = path.join(nativeHome, "auth.json");
    fs.writeFileSync(nativeAuth, "native-codex-authority\n", { mode: 0o600 });

    const result = await migrateLegacySharedCodexApiKey(fixture);
    assert.deepEqual(result, {
      status: "migrated",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      providerId: PROVIDER_ID,
    });
    const expectedRef = deterministicCredentialRef(DEFAULT_AGENT_PROFILE_ID, PROVIDER_ID);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, expectedRef);
    assert.equal(await fixture.secretStore.get(expectedRef), KEY);
    assert.equal(fs.existsSync(authPath(fixture.paths)), false);
    assert.equal(fs.existsSync(quarantinePath(fixture.paths)), false);
    assert.equal(fs.readFileSync(nativeAuth, "utf8"), "native-codex-authority\n");
    assert.equal(JSON.parse(fs.readFileSync(
      fixture.paths.legacyCodexApiKeyMigrationPath,
      "utf8",
    )).entries[0].stage, "complete");
    assertNoPlaintext(fixture.paths);

    await closeFixture(fixture, false);
    fixture = await reopenFixture(fixture);
    assert.deepEqual(await migrateLegacySharedCodexApiKey(fixture), {
      status: "complete",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      providerId: PROVIDER_ID,
    });
    assert.equal(await fixture.secretStore.get(expectedRef), KEY);
    assertNoPlaintext(fixture.paths);
  } finally {
    await closeFixture(fixture);
  }
});

test("默认与非默认 Shoggoth/Codex Profile 的 legacy key 会逐 Home 独立迁移", async () => {
  const fixture = await openFixture();
  const secondProfileId = "second-shoggoth-profile";
  const secondRuntimeProfileId = "second-shoggoth-runtime-profile";
  const secondProviderId = "provider-openai-second";
  try {
    fixture.productStore.putModelProvider(provider(secondProviderId));
    const current = fixture.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    fixture.productStore.putAgentProfile({
      ...current,
      id: secondProfileId,
      agentId: "second-shoggoth-agent",
      runtimeProfileId: secondRuntimeProfileId,
      providerRef: secondProviderId,
      isDefault: false,
    });
    writeAuth(fixture.paths, canonicalAuth(KEY));
    writeAuth(fixture.paths, canonicalAuth(OTHER_KEY), secondRuntimeProfileId);

    const result = await migrateLegacySharedCodexApiKey(fixture);
    assert.deepEqual(result, { status: "migrated", profileId: null, providerId: null });
    const defaultRef = deterministicCredentialRef(DEFAULT_AGENT_PROFILE_ID, PROVIDER_ID);
    const secondRef = deterministicCredentialRef(secondProfileId, secondProviderId);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, defaultRef);
    assert.equal(fixture.productStore.getModelProvider(secondProviderId).credentialRef, secondRef);
    assert.equal(await fixture.secretStore.get(defaultRef), KEY);
    assert.equal(await fixture.secretStore.get(secondRef), OTHER_KEY);
    assert.equal(fs.existsSync(authPath(fixture.paths)), false);
    assert.equal(fs.existsSync(authPath(fixture.paths, secondRuntimeProfileId)), false);
    const journal = JSON.parse(fs.readFileSync(
      fixture.paths.legacyCodexApiKeyMigrationPath,
      "utf8",
    ));
    assert.equal(journal.entries.length, 2);
    assert.ok(journal.entries.every((entry) => entry.stage === "complete"));
    for (const target of [
      fixture.paths.encryptedSecretsPath,
      fixture.paths.eventLogPath,
      fixture.paths.stateSnapshotPath,
      fixture.paths.legacyCodexApiKeyMigrationPath,
    ]) {
      if (!fs.existsSync(target)) continue;
      const serialized = fs.readFileSync(target, "utf8");
      assert.equal(serialized.includes(KEY), false, target);
      assert.equal(serialized.includes(OTHER_KEY), false, target);
    }
  } finally {
    await closeFixture(fixture);
  }
});

test("disabled Shoggoth/Codex Profile 的合法 legacy key 仍会迁移且保持禁用", async () => {
  const fixture = await openFixture();
  const profileId = "disabled-shoggoth-profile";
  const runtimeProfileId = "disabled-shoggoth-runtime-profile";
  const providerId = "provider-openai-disabled";
  try {
    fixture.productStore.putModelProvider(provider(providerId));
    const current = fixture.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    fixture.productStore.putAgentProfile({
      ...current,
      id: profileId,
      agentId: "disabled-shoggoth-agent",
      runtimeProfileId,
      providerRef: providerId,
      isDefault: false,
      enabled: false,
    });
    writeAuth(fixture.paths, canonicalAuth(OTHER_KEY), runtimeProfileId);

    assert.deepEqual(await migrateLegacySharedCodexApiKey(fixture), {
      status: "migrated", profileId, providerId,
    });
    const credentialRef = deterministicCredentialRef(profileId, providerId);
    assert.equal(fixture.productStore.getAgentProfile(profileId).enabled, false);
    assert.equal(fixture.productStore.getModelProvider(providerId).credentialRef, credentialRef);
    assert.equal(await fixture.secretStore.get(credentialRef), OTHER_KEY);
    assert.equal(fs.existsSync(authPath(fixture.paths, runtimeProfileId)), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("ChatGPT auth 原样保留且不会创建 key migration journal", async () => {
  const fixture = await openFixture({ owner: false });
  try {
    const chatGpt = chatGptAuth();
    writeAuth(fixture.paths, chatGpt);
    assert.deepEqual(await migrateLegacySharedCodexApiKey(fixture), {
      status: "not_applicable", profileId: null, providerId: null,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(authPath(fixture.paths), "utf8")), chatGpt);
    assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
    assert.deepEqual(fixture.secretStore.listMetadata(), []);
  } finally {
    await closeFixture(fixture);
  }
});

test("无 legacy key 时畸形 native CODEX_HOME 不阻止 fresh bundled Service 启动", async () => {
  let fixture = await openFixture();
  let service = null;
  try {
    assert.deepEqual(await migrateLegacySharedCodexApiKey({
      ...fixture,
      parentEnv: { CODEX_HOME: "relative-native-home" },
    }), {
      status: "not_applicable", profileId: null, providerId: null,
    });
    assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
    assert.deepEqual(fixture.secretStore.listMetadata(), []);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);

    await closeFixture(fixture, false);
    service = createAgentService({
      paths: fixture.paths,
      safeStorage: fixture.storage,
      version: "legacy-codex-api-key-no-source-test",
      parentEnv: { CODEX_HOME: "relative-native-home" },
      runtimeStorageHomedir: fixture.homedir,
    });
    await service.start();
    assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
    await service.stop({ notify: false });
    service = null;
  } finally {
    if (service) await service.stop({ notify: false }).catch(() => {});
    await closeFixture(fixture);
  }
});

test("非 canonical、混合、损坏 auth 全部 fail closed 且不写密文或 Provider", async () => {
  const cases = [
    "{not-json\n",
    { auth_mode: "apikey", OPENAI_API_KEY: KEY, extra: true },
    { auth_mode: "apikey", OPENAI_API_KEY: null },
    { auth_mode: "chatgpt", OPENAI_API_KEY: KEY, tokens: {} },
    { auth_mode: "chatgpt", OPENAI_API_KEY: "", tokens: {} },
    { auth_mode: "chatgpt", OPENAI_API_KEY: 42, tokens: {} },
    { auth_mode: "unknown" },
  ];
  for (const value of cases) {
    const fixture = await openFixture();
    try {
      writeAuth(fixture.paths, value);
      await assert.rejects(
        migrateLegacySharedCodexApiKey(fixture),
        (error) => error.code === "LEGACY_CODEX_API_KEY_MIGRATION_AUTH_INVALID"
          && !serializedError(error).includes(KEY),
      );
      assert.equal(fs.existsSync(authPath(fixture.paths)), true);
      assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);
      assert.deepEqual(fixture.secretStore.listMetadata(), []);
    } finally {
      await closeFixture(fixture);
    }
  }
});

test("symlink、hardlink 与过宽权限 auth 均拒绝且不删除证据", async () => {
  for (const kind of ["symlink", "hardlink", "permissions"]) {
    const fixture = await openFixture();
    try {
      writeAuth(fixture.paths, canonicalAuth());
      if (kind === "symlink") {
        const target = path.join(fixture.root, "symlink-target.json");
        fs.renameSync(authPath(fixture.paths), target);
        fs.symlinkSync(target, authPath(fixture.paths));
      } else if (kind === "hardlink") {
        fs.linkSync(authPath(fixture.paths), path.join(fixture.root, "auth-hardlink.json"));
      } else {
        fs.chmodSync(authPath(fixture.paths), 0o644);
      }
      await assert.rejects(
        migrateLegacySharedCodexApiKey(fixture),
        (error) => String(error.code).startsWith("LEGACY_CODEX_API_KEY_MIGRATION_")
          && !serializedError(error).includes(KEY),
      );
      assert.equal(fs.existsSync(authPath(fixture.paths)), true);
      assert.deepEqual(fixture.secretStore.listMetadata(), []);
      assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);
    } finally {
      await closeFixture(fixture);
    }
  }
});

test("native CODEX_HOME 与任一 legacy Home 重叠时在首个持久 mutation 前拒绝", async () => {
  for (const overlap of ["equal", "ancestor", "descendant"]) {
    const fixture = await openFixture();
    try {
      writeAuth(fixture.paths, canonicalAuth());
      const nativeHome = overlap === "equal" ? legacyHome(fixture.paths)
        : overlap === "ancestor" ? path.join(fixture.paths.stateDir, "codex")
          : path.join(legacyHome(fixture.paths), "native-codex-child");
      const eventLogBefore = fs.readFileSync(fixture.paths.eventLogPath);
      await assert.rejects(
        migrateLegacySharedCodexApiKey({
          ...fixture,
          parentEnv: { CODEX_HOME: nativeHome },
        }),
        (error) => error.code === "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_CONFLICT",
      );
      assert.deepEqual(fs.readFileSync(fixture.paths.eventLogPath), eventLogBefore);
      assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
      assert.deepEqual(fixture.secretStore.listMetadata(), []);
      assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);
      assert.deepEqual(JSON.parse(fs.readFileSync(authPath(fixture.paths), "utf8")), canonicalAuth());
    } finally {
      await closeFixture(fixture);
    }
  }
});

test("有 legacy key 时畸形 native CODEX_HOME 在 credential/auth mutation 前 fail closed", async () => {
  const fixture = await openFixture();
  try {
    writeAuth(fixture.paths, canonicalAuth());
    const eventLogBefore = fs.readFileSync(fixture.paths.eventLogPath);
    await assert.rejects(
      migrateLegacySharedCodexApiKey({
        ...fixture,
        parentEnv: { CODEX_HOME: "relative-native-home" },
      }),
      (error) => error.code === "LEGACY_CODEX_API_KEY_MIGRATION_NATIVE_HOME_INVALID",
    );
    assert.deepEqual(fs.readFileSync(fixture.paths.eventLogPath), eventLogBefore);
    assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
    assert.deepEqual(fixture.secretStore.listMetadata(), []);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(authPath(fixture.paths), "utf8")), canonicalAuth());
  } finally {
    await closeFixture(fixture);
  }
});

test("后项 Profile 归属歧义会让全部 Home 在 preflight 阶段保持未修改", async () => {
  const fixture = await openFixture();
  const secondRuntimeProfileId = "zzzz-unowned-runtime-profile";
  try {
    const current = fixture.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    fixture.productStore.putAgentProfile({
      ...current,
      id: "zzzz-unowned-profile",
      agentId: "zzzz-unowned-agent",
      runtimeProfileId: secondRuntimeProfileId,
      providerRef: null,
      isDefault: false,
    });
    writeAuth(fixture.paths, canonicalAuth(KEY));
    writeAuth(fixture.paths, canonicalAuth(OTHER_KEY), secondRuntimeProfileId);
    const eventLogBefore = fs.readFileSync(fixture.paths.eventLogPath);

    await assert.rejects(
      migrateLegacySharedCodexApiKey(fixture),
      (error) => error.code === "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
    );
    assert.deepEqual(fs.readFileSync(fixture.paths.eventLogPath), eventLogBefore);
    assert.equal(fs.existsSync(fixture.paths.legacyCodexApiKeyMigrationPath), false);
    assert.deepEqual(fixture.secretStore.listMetadata(), []);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(authPath(fixture.paths), "utf8")), canonicalAuth(KEY));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(authPath(fixture.paths, secondRuntimeProfileId), "utf8")),
      canonicalAuth(OTHER_KEY),
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("必须恰有一个 Shoggoth/Codex/OpenAI Profile owner", async () => {
  for (const ambiguous of [false, true]) {
    const fixture = await openFixture({ owner: ambiguous });
    try {
      if (ambiguous) {
        const current = fixture.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
        fixture.productStore.putAgentProfile({
          ...current,
          id: "second-shoggoth-profile",
          agentId: "second-shoggoth-agent",
          runtimeProfileId: "second-shoggoth-runtime-profile",
          isDefault: false,
        });
      }
      writeAuth(fixture.paths, canonicalAuth());
      await assert.rejects(
        migrateLegacySharedCodexApiKey(fixture),
        (error) => error.code === "LEGACY_CODEX_API_KEY_MIGRATION_OWNER_AMBIGUOUS",
      );
      assert.equal(fs.existsSync(authPath(fixture.paths)), true);
      assert.deepEqual(fixture.secretStore.listMetadata(), []);
    } finally {
      await closeFixture(fixture);
    }
  }
});

test("Provider 已有不同 key 拒绝，已有相同 key 复用原 ref 后安全清除 auth", async () => {
  for (const [existingSecret, succeeds] of [[OTHER_KEY, false], [KEY, true]]) {
    const credentialRef = "provider-credential-existing-openai";
    const fixture = await openFixture({ credentialRef, existingSecret });
    try {
      writeAuth(fixture.paths, canonicalAuth());
      if (succeeds) {
        await migrateLegacySharedCodexApiKey(fixture);
        assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, credentialRef);
        assert.equal(fs.existsSync(authPath(fixture.paths)), false);
      } else {
        await assert.rejects(
          migrateLegacySharedCodexApiKey(fixture),
          (error) => error.code
            === "LEGACY_CODEX_API_KEY_MIGRATION_EXISTING_CREDENTIAL_CONFLICT"
            && !serializedError(error).includes(KEY) && !serializedError(error).includes(OTHER_KEY),
        );
        assert.equal(fs.existsSync(authPath(fixture.paths)), true);
        assert.equal(await fixture.secretStore.get(credentialRef), OTHER_KEY);
      }
    } finally {
      await closeFixture(fixture);
    }
  }
});

function crashFs({ auth, quarantine }, operation) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync" && operation === "rename") {
        return (source, destination) => {
          target.renameSync(source, destination);
          if (source === auth && destination === quarantine) throw new Error(KEY);
        };
      }
      if (property === "unlinkSync" && operation === "unlink") {
        return (targetPath) => {
          target.unlinkSync(targetPath);
          if (targetPath === quarantine) throw new Error(KEY);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function assertCrashConverges(operation) {
  let fixture = await openFixture();
  try {
    writeAuth(fixture.paths, canonicalAuth());
    const options = { ...fixture };
    if (operation === "secret") {
      options.secretStore = {
        listMetadata: fixture.secretStore.listMetadata.bind(fixture.secretStore),
        get: fixture.secretStore.get.bind(fixture.secretStore),
        async put(...args) {
          await fixture.secretStore.put(...args);
          throw new Error(KEY);
        },
      };
    } else if (operation === "provider") {
      options.productStore = {
        listAgentProfiles: fixture.productStore.listAgentProfiles.bind(fixture.productStore),
        getModelProvider: fixture.productStore.getModelProvider.bind(fixture.productStore),
        putModelProvider(value) {
          fixture.productStore.putModelProvider(value);
          throw new Error(KEY);
        },
      };
    } else if (operation === "journal") {
      let writes = 0;
      options.atomicWrite = (target, value, writeOptions) => {
        atomicWritePrivateFile(target, value, writeOptions);
        writes += 1;
        if (writes === 1) {
          const error = new Error(KEY);
          error.committed = true;
          throw error;
        }
      };
    } else {
      options.fs = crashFs({
        auth: authPath(fixture.paths),
        quarantine: quarantinePath(fixture.paths),
      }, operation);
    }
    await assert.rejects(
      migrateLegacySharedCodexApiKey(options),
      (error) => !serializedError(error).includes(KEY),
    );
    await closeFixture(fixture, false);
    fixture = await reopenFixture(fixture);
    assert.equal((await migrateLegacySharedCodexApiKey(fixture)).status, "migrated");
    const expectedRef = deterministicCredentialRef(DEFAULT_AGENT_PROFILE_ID, PROVIDER_ID);
    assert.equal(fixture.productStore.getModelProvider(PROVIDER_ID).credentialRef, expectedRef);
    assert.equal(await fixture.secretStore.get(expectedRef), KEY);
    assert.equal(fs.existsSync(authPath(fixture.paths)), false);
    assert.equal(fs.existsSync(quarantinePath(fixture.paths)), false);
    assertNoPlaintext(fixture.paths);
  } finally {
    await closeFixture(fixture);
  }
}

test("journal/secret/provider/rename/unlink 任一点崩溃后重启都收敛", async () => {
  for (const operation of ["journal", "secret", "provider", "rename", "unlink"]) {
    await assertCrashConverges(operation);
  }
});

test("Service 启动先恢复 journal-owned secret、再做 orphan GC，并可正常 stop/restart", async () => {
  let fixture = await openFixture();
  let service = null;
  try {
    writeAuth(fixture.paths, canonicalAuth());
    await assert.rejects(migrateLegacySharedCodexApiKey({
      ...fixture,
      secretStore: {
        listMetadata: fixture.secretStore.listMetadata.bind(fixture.secretStore),
        get: fixture.secretStore.get.bind(fixture.secretStore),
        async put(...args) {
          await fixture.secretStore.put(...args);
          throw new Error(KEY);
        },
      },
    }));
    await closeFixture(fixture, false);
    const initialContainer = JSON.parse(fs.readFileSync(fixture.paths.encryptedSecretsPath, "utf8"));
    assert.equal(initialContainer.revision, 1);

    service = createAgentService({
      paths: fixture.paths,
      safeStorage: fixture.storage,
      version: "legacy-codex-api-key-migration-test",
      parentEnv: fixture.parentEnv,
      runtimeStorageHomedir: fixture.homedir,
    });
    await service.start();
    const expectedRef = deterministicCredentialRef(DEFAULT_AGENT_PROFILE_ID, PROVIDER_ID);
    assert.equal(service.productStore.getModelProvider(PROVIDER_ID).credentialRef, expectedRef);
    assert.equal(await service.secretStore.get(expectedRef), KEY);
    assert.equal(JSON.parse(fs.readFileSync(
      fixture.paths.encryptedSecretsPath,
      "utf8",
    )).revision, 1, "generic orphan GC must not delete the journal-owned credential first");
    assert.equal(fs.existsSync(authPath(fixture.paths)), false);
    await service.stop({ notify: false });
    const freshChatGptAuth = chatGptAuth();
    writeAuth(fixture.paths, freshChatGptAuth);
    await service.start();
    assert.equal(await service.secretStore.get(expectedRef), KEY);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(authPath(fixture.paths), "utf8")),
      freshChatGptAuth,
      "a normal ChatGPT login after migration must survive Service restart",
    );
    await service.stop({ notify: false });
    service = null;
    assertNoPlaintext(fixture.paths);
  } finally {
    if (service) await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
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
  else console.log(`PASS legacy Codex API key migration unit (${tests.length})`);
})();
