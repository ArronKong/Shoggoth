#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { execFileSync, spawn } = require("node:child_process");
const { PassThrough, Readable } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app/agent-service/paths"));
const {
  DEFAULT_AGENT_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE_ID,
} = require(path.join(ROOT, "app/agent-service/product-store"));
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app/agent-service/runtime-account"));
const { createAgentService, PROTOCOL_VERSION } = require(path.join(ROOT, "app/agent-service/server"));
const { readClientToken, requestService } = require(path.join(ROOT, "app/agent-service/client"));
const {
  DEFAULT_REQUEST_TIMEOUT_MS, InProcessMcpCryptoBroker, McpCryptoBroker, workerEnvironment,
} = require(path.join(ROOT, "app/agent-service/mcp-crypto-broker"));
const { PackagedMcpCryptoBroker } = require(path.join(
  ROOT, "app/agent-service/packaged-mcp-crypto-broker",
));
const { createLocalFileSafeStorage, localCryptoKeyPath } = require(path.join(
  ROOT, "app/agent-service/local-file-safe-storage",
));
const { PendingCommandInbox } = require(path.join(
  ROOT, "app/agent-service/pending-command-inbox",
));
const { EncryptedSecretStore } = require(path.join(
  ROOT, "app/agent-service/encrypted-secret-store",
));
const {
  decodeWorkerResponse, encodeWorkerResponse,
} = require(path.join(ROOT, "app/agent-service/mcp-crypto-protocol"));
const {
  SHOGGOTH_AGENT_SERVICE_NAME, assertWorkerParent, keychainServiceNameForIdentity,
  cryptoStorageForIdentity, performWorkerOperation, readSingleJsonLine,
  startMcpCryptoWorker, writeFrame,
} = require(path.join(ROOT, "app/mcp-crypto-worker"));
const {
  CODEX_DESIGNATED_REQUIREMENT,
  CODEX_TEAM_IDENTIFIER,
  isLocalFileCryptoAppIdentity,
  isStrictAdHocAppIdentity,
  isStrictLocalSignedAppIdentity,
  readCodeIdentity,
  readCodeIdentityAsync,
} = require(path.join(ROOT, "app/agent-service/code-identity"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("wait timeout");
}
function fixturePaths(prefix = "smcw-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
}
function nonce(byte = 7) { return Buffer.alloc(32, byte).toString("base64url"); }
function gate(overrides = {}) {
  return {
    version: 1, parentPid: process.pid, generation: 3, nonce: nonce(),
    callerRole: "agent-service", parentExecutable: process.execPath, appRoot: ROOT,
    ...overrides,
  };
}
function xor(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0xa5;
  return bytes;
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: xor,
  decryptString: (bytes) => xor(Buffer.from(bytes)).toString("utf8"),
};
const LOCAL_ROOT_HASH = "ddb8a6fee24f4bd865bab191d92c44062f213137";
const localIdentity = () => ({
  localSigned: true,
  teamIdentifier: null,
  identifier: "ai.shoggoth.desktop",
  certificateRootHash: LOCAL_ROOT_HASH,
  designatedRequirement:
    `identifier "ai.shoggoth.desktop" and certificate root = H"${LOCAL_ROOT_HASH}"`,
});
const adHocIdentity = () => ({
  adHoc: true,
  teamIdentifier: null,
  identifier: "ai.shoggoth.desktop",
  cdHash: "7076af64a5ba86c476dadac67886bda36e1228f0",
  designatedRequirement: 'cdhash H"7076af64a5ba86c476dadac67886bda36e1228f0"',
});
const localCodesignDetails = [
  "Identifier=ai.shoggoth.desktop",
  "TeamIdentifier=not set",
  "Signature size=900",
  "Authority=Shoggoth Local Code Signing Stable",
  `# designated => identifier "ai.shoggoth.desktop" and certificate root = H"${LOCAL_ROOT_HASH}"`,
].join("\n");
const fakeCodesignExecFile = (details, { calls = null, errorAt = null } = {}) => (
  command, args, options, callback
) => {
  const phase = args[0] === "--verify" ? "verify" : "describe";
  calls?.push({ command, args: [...args], options: { ...options } });
  queueMicrotask(() => callback(
    phase === errorAt ? new Error(`${phase}_codesign_failure_must_not_leak`) : null,
    "",
    phase === "describe" ? details : "",
  ));
};

const PACKAGED_EXECUTABLE = "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth";
const PACKAGED_RESOURCES = "/Applications/Shoggoth.app/Contents/Resources";
const PACKAGED_APP_ROOT = `${PACKAGED_RESOURCES}/app.asar`;
const PACKAGED_PARENT_ENV = Object.freeze({ LANG: "zh_CN.UTF-8" });

function developerIdentity() {
  return {
    teamIdentifier: "SHOGGOTH01",
    designatedRequirement: "identifier ai.shoggoth.desktop and anchor apple generic",
  };
}

function selectorOptions(patch = {}) {
  const paths = patch.paths || fixturePaths("smcw-packaged-selector-");
  return {
    paths,
    callerRole: "agent-service",
    executablePath: PACKAGED_EXECUTABLE,
    appRoot: PACKAGED_APP_ROOT,
    resourcesPath: PACKAGED_RESOURCES,
    applicationsRoot: "/Applications",
    defaultApp: false,
    parentEnv: PACKAGED_PARENT_ENV,
    requestTimeoutMs: 60_000,
    termGraceMs: 100,
    killConfirmMs: 1_000,
    assertStableAppPaths(config, options) {
      assert.deepEqual(config, {
        appPath: "/Applications/Shoggoth.app",
        executablePath: PACKAGED_EXECUTABLE,
        bootstrapPath: `${PACKAGED_APP_ROOT}/app/bootstrap.js`,
        resourcesPath: PACKAGED_RESOURCES,
      });
      assert.deepEqual(options, { applicationsRoot: "/Applications" });
    },
    readCodeIdentityAsync: async (executablePath, options) => {
      assert.equal(executablePath, PACKAGED_EXECUTABLE);
      assert.deepEqual(options, {
        allowAdHocIdentifier: "ai.shoggoth.desktop",
        allowLocalSignedIdentifier: "ai.shoggoth.desktop",
      });
      return localIdentity();
    },
    createLocalFileSafeStorage: (options) => createLocalFileSafeStorage(options),
    createExternalBroker: (options) => new McpCryptoBroker(options),
    ...patch,
    paths,
  };
}

function fixedSelectorError(error) {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  return error?.code === "MCP_CRYPTO_UNAVAILABLE"
    && error?.message === "mcp_crypto_unavailable"
    && !serialized.includes("selector-secret-canary");
}

function trackedSafeStorage() {
  let available = true;
  let closeCalls = 0;
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      if (!available) throw new Error("closed");
      return xor(value);
    },
    decryptString(bytes) {
      if (!available) throw new Error("closed");
      return xor(Buffer.from(bytes)).toString("utf8");
    },
    close() { closeCalls += 1; available = false; },
    get closeCalls() { return closeCalls; },
  };
}

test("packaged selector 的 local Service/helper 真实共享同一 32B secret 且绝不创建外置 broker", async () => {
  const paths = fixturePaths("smcw-packaged-selector-local-");
  let externalFactoryCalls = 0;
  let stablePathCalls = 0;
  let identityCalls = 0;
  let localFactoryCalls = 0;
  const common = {
    paths,
    assertStableAppPaths(...args) {
      stablePathCalls += 1;
      return selectorOptions({ paths }).assertStableAppPaths(...args);
    },
    async readCodeIdentityAsync(...args) {
      identityCalls += 1;
      await selectorOptions({ paths }).readCodeIdentityAsync(...args);
      return localIdentity();
    },
    createLocalFileSafeStorage(options) {
      localFactoryCalls += 1;
      assert.deepEqual(options, localFactoryCalls === 1
        ? { paths, readOnly: false }
        : { paths, readOnly: true });
      return createLocalFileSafeStorage(options);
    },
    createExternalBroker() {
      externalFactoryCalls += 1;
      throw new Error("local selector must not create external broker");
    },
  };
  const serviceSelector = new PackagedMcpCryptoBroker(selectorOptions({
    ...common,
    callerRole: "agent-service",
    requestTimeoutMs: 60_000,
  })).open({ generation: 1 });
  const serviceSecret = await serviceSelector.loadOrCreateForService({ generation: 1 });
  assert.equal(Buffer.isBuffer(serviceSecret), true);
  assert.equal(serviceSecret.length, 32);
  await assert.rejects(() => serviceSelector.readForHelper({ generation: 1 }), fixedSelectorError);
  const plaintext = Buffer.from("selector-local-encrypt-roundtrip", "utf8");
  const ciphertext = await serviceSelector.encrypt(plaintext, { generation: 1 });
  const decrypted = await serviceSelector.decrypt(ciphertext, { generation: 1 });
  assert.deepEqual(decrypted, plaintext);
  plaintext.fill(0);
  ciphertext.fill(0);
  decrypted.fill(0);
  await serviceSelector.close();

  const helperSelector = new PackagedMcpCryptoBroker(selectorOptions({
    ...common,
    callerRole: "mcp",
    requestTimeoutMs: 30_000,
  })).open({ generation: 1 });
  const helperSecret = await helperSelector.readForHelper({ generation: 1 });
  assert.equal(helperSecret.length, 32);
  assert.deepEqual(helperSecret, serviceSecret);
  await assert.rejects(
    () => helperSelector.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
  assert.equal(externalFactoryCalls, 0);
  assert.equal(localFactoryCalls, 2);
  assert.equal(stablePathCalls, 2);
  assert.equal(identityCalls, 2);
  serviceSecret.fill(0);
  helperSecret.fill(0);
  await helperSelector.close();
});

test("packaged selector 为 Developer ID 的 Service/helper 原样保留外置启动参数", async () => {
  const cases = [
    ["developer-service", developerIdentity(), "agent-service", 60_000, false],
    ["developer-helper", developerIdentity(), "mcp", 30_000, true],
  ];
  for (const [name, identity, callerRole, requestTimeoutMs, defaultApp] of cases) {
    const paths = fixturePaths(`smcw-packaged-selector-${name}-`);
    let localFactoryCalls = 0;
    let externalFactoryCalls = 0;
    const capture = { open: [], operations: [], close: 0 };
    const delegate = {
      open(options) { capture.open.push(structuredClone(options)); return this; },
      loadOrCreateForService(options) {
        capture.operations.push(["loadOrCreateForService", structuredClone(options)]);
        return Promise.resolve(Buffer.alloc(32, 0x61));
      },
      readForHelper(options) {
        capture.operations.push(["readForHelper", structuredClone(options)]);
        return Promise.resolve(Buffer.alloc(32, 0x62));
      },
      encrypt() { throw new Error("not used"); },
      decrypt() { throw new Error("not used"); },
      async close() { capture.close += 1; },
    };
    const selector = new PackagedMcpCryptoBroker(selectorOptions({
      paths,
      callerRole,
      defaultApp,
      requestTimeoutMs,
      readCodeIdentityAsync: async () => identity,
      createLocalFileSafeStorage() {
        localFactoryCalls += 1;
        throw new Error("external identity must not create local storage");
      },
      createExternalBroker(options) {
        externalFactoryCalls += 1;
        assert.deepEqual(options, {
          paths,
          callerRole,
          executablePath: PACKAGED_EXECUTABLE,
          appRoot: PACKAGED_APP_ROOT,
          defaultApp,
          parentEnv: PACKAGED_PARENT_ENV,
          requestTimeoutMs,
          termGraceMs: 100,
          killConfirmMs: 1_000,
        });
        return delegate;
      },
    })).open({ generation: 11 });
    const secret = callerRole === "agent-service"
      ? await selector.loadOrCreateForService({ generation: 11 })
      : await selector.readForHelper({ generation: 11 });
    assert.equal(secret.length, 32);
    secret.fill(0);
    assert.deepEqual(capture.open, [{ generation: 11 }]);
    assert.deepEqual(capture.operations, [[
      callerRole === "agent-service" ? "loadOrCreateForService" : "readForHelper",
      { generation: 11 },
    ]]);
    assert.equal(localFactoryCalls, 0);
    assert.equal(externalFactoryCalls, 1);
    await selector.close();
    assert.equal(capture.close, 1);
  }
});

test("packaged selector 的严格 ad-hoc Service/helper 共享本地文件 secret 且不创建外置 worker", async () => {
  const paths = fixturePaths("smcw-packaged-selector-adhoc-local-");
  let localFactoryCalls = 0;
  let externalFactoryCalls = 0;
  const common = {
    paths,
    readCodeIdentityAsync: async () => adHocIdentity(),
    createLocalFileSafeStorage(options) {
      localFactoryCalls += 1;
      assert.deepEqual(options, localFactoryCalls === 1
        ? { paths, readOnly: false }
        : { paths, readOnly: true });
      return createLocalFileSafeStorage(options);
    },
    createExternalBroker() {
      externalFactoryCalls += 1;
      throw new Error("strict ad-hoc selector must not create external worker");
    },
  };
  const serviceSelector = new PackagedMcpCryptoBroker(selectorOptions({
    ...common,
    callerRole: "agent-service",
  })).open({ generation: 17 });
  const serviceSecret = await serviceSelector.loadOrCreateForService({ generation: 17 });
  await serviceSelector.close();

  const helperSelector = new PackagedMcpCryptoBroker(selectorOptions({
    ...common,
    callerRole: "mcp",
  })).open({ generation: 17 });
  const helperSecret = await helperSelector.readForHelper({ generation: 17 });
  assert.deepEqual(helperSecret, serviceSecret);
  assert.equal(localFactoryCalls, 2);
  assert.equal(externalFactoryCalls, 0);
  serviceSecret.fill(0);
  helperSecret.fill(0);
  await helperSelector.close();
});

test("packaged selector 的 rejected identity 同代 singleflight 且第三次不重试任何工厂", async () => {
  const identityFlight = {};
  identityFlight.promise = new Promise((resolve, reject) => {
    identityFlight.resolve = resolve;
    identityFlight.reject = reject;
  });
  let identityCalls = 0;
  let localFactoryCalls = 0;
  let externalFactoryCalls = 0;
  const selector = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync() { identityCalls += 1; return identityFlight.promise; },
    createLocalFileSafeStorage() { localFactoryCalls += 1; throw new Error("unexpected local"); },
    createExternalBroker() { externalFactoryCalls += 1; throw new Error("unexpected external"); },
  })).open({ generation: 5 });
  const first = selector.loadOrCreateForService({ generation: 5 });
  const second = selector.encrypt(Buffer.from("singleflight"), { generation: 5 });
  first.catch(() => {});
  second.catch(() => {});
  await waitFor(() => identityCalls === 1);
  identityFlight.reject(new Error("selector-secret-canary-identity"));
  await assert.rejects(first, fixedSelectorError);
  await assert.rejects(second, fixedSelectorError);
  await assert.rejects(
    selector.loadOrCreateForService({ generation: 5 }), fixedSelectorError,
  );
  assert.equal(identityCalls, 1);
  assert.equal(localFactoryCalls, 0);
  assert.equal(externalFactoryCalls, 0);
  await selector.close();
});

test("packaged selector close 会撤销迟到 local delegate、清零 owned storage 且从未发布", async () => {
  const identityFlight = {};
  identityFlight.promise = new Promise((resolve) => { identityFlight.resolve = resolve; });
  const storages = [];
  let identityCalls = 0;
  let externalFactoryCalls = 0;
  const selector = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync() { identityCalls += 1; return identityFlight.promise; },
    createLocalFileSafeStorage() {
      const storage = trackedSafeStorage();
      storages.push(storage);
      return storage;
    },
    createExternalBroker() { externalFactoryCalls += 1; throw new Error("unexpected external"); },
  })).open({ generation: 1 });
  const pending = selector.loadOrCreateForService({ generation: 1 });
  pending.catch(() => {});
  await waitFor(() => identityCalls === 1);
  const closing = selector.close();
  assert.throws(() => selector.open({ generation: 2 }), fixedSelectorError);
  identityFlight.resolve(localIdentity());
  await assert.rejects(pending, fixedSelectorError);
  await closing;
  assert.equal(storages.length, 1);
  assert.equal(storages[0].isEncryptionAvailable(), false);
  assert.equal(storages[0].closeCalls, 1);
  assert.equal(externalFactoryCalls, 0);
  await assert.rejects(
    selector.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
});

test("packaged selector close/reopen 新 generation 重做 identity/factory 并永久拒绝旧代", async () => {
  const paths = fixturePaths("smcw-packaged-selector-reopen-");
  const storages = [];
  let identityCalls = 0;
  let localFactoryCalls = 0;
  let externalFactoryCalls = 0;
  const selector = new PackagedMcpCryptoBroker(selectorOptions({
    paths,
    readCodeIdentityAsync: async () => { identityCalls += 1; return localIdentity(); },
    createLocalFileSafeStorage() {
      localFactoryCalls += 1;
      const storage = trackedSafeStorage();
      storages.push(storage);
      return storage;
    },
    createExternalBroker() { externalFactoryCalls += 1; throw new Error("unexpected external"); },
  })).open({ generation: 1 });
  const first = await selector.loadOrCreateForService({ generation: 1 });
  assert.equal(first.length, 32);
  await selector.close();
  assert.equal(storages[0].isEncryptionAvailable(), false);
  assert.equal(storages[0].closeCalls, 1);
  await assert.rejects(
    selector.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );

  selector.open({ generation: 2 });
  await assert.rejects(
    selector.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
  const second = await selector.loadOrCreateForService({ generation: 2 });
  assert.deepEqual(second, first);
  assert.equal(identityCalls, 2);
  assert.equal(localFactoryCalls, 2);
  assert.equal(externalFactoryCalls, 0);
  assert.equal(storages[0].isEncryptionAvailable(), false);
  assert.equal(storages[1].isEncryptionAvailable(), true);
  first.fill(0);
  second.fill(0);
  await selector.close();
  assert.equal(storages[1].isEncryptionAvailable(), false);
  assert.equal(storages[1].closeCalls, 1);
});

test("packaged selector 构造器拒绝无效 paths/role/绝对路径与显式无效工厂", () => {
  const valid = selectorOptions();
  for (const patch of [
    { paths: null },
    { paths: { ...valid.paths, mcpAuthPath: path.join(valid.paths.cacheDir, "mcp-auth.json") } },
    { callerRole: "attacker" },
    { executablePath: "relative/Shoggoth" },
    { appRoot: "relative/app.asar" },
    { resourcesPath: "relative/Resources" },
    { applicationsRoot: "relative/Applications" },
    { assertStableAppPaths: null },
    { readCodeIdentityAsync: null },
    { createLocalFileSafeStorage: null },
    { createExternalBroker: null },
  ]) {
    assert.throws(
      () => new PackagedMcpCryptoBroker({ ...valid, ...patch }),
      fixedSelectorError,
    );
  }
});

test("packaged selector 的 local 构造与 external open 失败都关闭未发布资源并固定脱敏", async () => {
  const mutablePaths = { ...fixturePaths("smcw-packaged-selector-local-constructor-fail-") };
  const localStorages = [];
  const localSelector = new PackagedMcpCryptoBroker(selectorOptions({
    paths: mutablePaths,
    createLocalFileSafeStorage() {
      const storage = trackedSafeStorage();
      localStorages.push(storage);
      return storage;
    },
  })).open({ generation: 1 });
  mutablePaths.mcpAuthPath = path.join(mutablePaths.cacheDir, "selector-secret-canary.json");
  await assert.rejects(
    localSelector.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
  assert.equal(localStorages.length, 1);
  assert.equal(localStorages[0].isEncryptionAvailable(), false);
  assert.equal(localStorages[0].closeCalls, 1);
  await localSelector.close();

  let externalFactoryCalls = 0;
  let externalCloseCalls = 0;
  const externalDelegate = {
    open() { throw new Error("selector-secret-canary-external-open"); },
    close() { externalCloseCalls += 1; },
    loadOrCreateForService() { throw new Error("must not run"); },
    readForHelper() { throw new Error("must not run"); },
    encrypt() { throw new Error("must not run"); },
    decrypt() { throw new Error("must not run"); },
  };
  const externalSelector = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync: async () => developerIdentity(),
    createExternalBroker() { externalFactoryCalls += 1; return externalDelegate; },
  })).open({ generation: 2 });
  await assert.rejects(
    externalSelector.loadOrCreateForService({ generation: 2 }), fixedSelectorError,
  );
  await assert.rejects(
    externalSelector.loadOrCreateForService({ generation: 2 }), fixedSelectorError,
  );
  assert.equal(externalFactoryCalls, 1);
  assert.equal(externalCloseCalls, 1);
  await externalSelector.close();
});

test("packaged selector 的 external factory/open cleanup 与 published close 失败均 sticky fail closed", async () => {
  let factoryCalls = 0;
  const factoryFailure = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync: async () => developerIdentity(),
    createExternalBroker() {
      factoryCalls += 1;
      throw new Error("selector-secret-canary-external-factory");
    },
  })).open({ generation: 1 });
  await assert.rejects(
    factoryFailure.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
  await assert.rejects(
    factoryFailure.loadOrCreateForService({ generation: 1 }), fixedSelectorError,
  );
  assert.equal(factoryCalls, 1);
  await factoryFailure.close();

  let cleanupCloseCalls = 0;
  const cleanupFailure = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync: async () => developerIdentity(),
    createExternalBroker: () => ({
      open() { throw new Error("selector-secret-canary-open-before-cleanup"); },
      close() {
        cleanupCloseCalls += 1;
        throw new Error("selector-secret-canary-unpublished-close");
      },
      loadOrCreateForService() { throw new Error("must not run"); },
      readForHelper() { throw new Error("must not run"); },
      encrypt() { throw new Error("must not run"); },
      decrypt() { throw new Error("must not run"); },
    }),
  })).open({ generation: 2 });
  await assert.rejects(
    cleanupFailure.loadOrCreateForService({ generation: 2 }), fixedSelectorError,
  );
  assert.equal(cleanupCloseCalls, 1);
  await assert.rejects(cleanupFailure.close(), fixedSelectorError);
  assert.throws(() => cleanupFailure.open({ generation: 3 }), fixedSelectorError);
  await assert.rejects(cleanupFailure.close(), fixedSelectorError);

  let publishedCloseCalls = 0;
  const publishedFailure = new PackagedMcpCryptoBroker(selectorOptions({
    readCodeIdentityAsync: async () => developerIdentity(),
    createExternalBroker: () => ({
      open() { return this; },
      close() {
        publishedCloseCalls += 1;
        throw new Error("selector-secret-canary-published-close");
      },
      loadOrCreateForService() { return Promise.resolve(Buffer.alloc(32, 0x65)); },
      readForHelper() { throw new Error("must not run"); },
      encrypt() { throw new Error("must not run"); },
      decrypt() { throw new Error("must not run"); },
    }),
  })).open({ generation: 4 });
  const secret = await publishedFailure.loadOrCreateForService({ generation: 4 });
  secret.fill(0);
  await assert.rejects(publishedFailure.close(), fixedSelectorError);
  assert.equal(publishedCloseCalls, 1);
  assert.throws(() => publishedFailure.open({ generation: 5 }), fixedSelectorError);
});

test("共享严格 ad-hoc 身份谓词只接受完全绑定的 Shoggoth App 自身份", () => {
  const adHoc = adHocIdentity();
  assert.equal(isStrictAdHocAppIdentity(adHoc), true);
  assert.equal(isStrictAdHocAppIdentity({ ...adHoc, identifier: "ai.attacker.desktop" }), false);
  assert.equal(isStrictAdHocAppIdentity({
    ...adHoc,
    cdHash: "8076af64a5ba86c476dadac67886bda36e1228f0",
  }), false);
  assert.equal(isStrictAdHocAppIdentity({
    ...adHoc,
    designatedRequirement: 'cdhash H"8076af64a5ba86c476dadac67886bda36e1228f0"',
  }), false);
  assert.equal(isStrictAdHocAppIdentity({ ...adHoc, teamIdentifier: "SHOGGOTH01" }), false);
});

test("共享严格 local-signed 身份谓词只接受完全绑定的 Shoggoth App 自身份", () => {
  const local = localIdentity();
  assert.equal(isStrictLocalSignedAppIdentity(local), true);
  assert.equal(isStrictLocalSignedAppIdentity({
    ...local,
    identifier: "ai.attacker.desktop",
  }), false);
  assert.equal(isStrictLocalSignedAppIdentity({
    ...local,
    certificateRootHash: "edb8a6fee24f4bd865bab191d92c44062f213137",
  }), false);
  assert.equal(isStrictLocalSignedAppIdentity({
    ...local,
    designatedRequirement:
      'identifier "ai.attacker.desktop" and certificate root = H"ddb8a6fee24f4bd865bab191d92c44062f213137"',
  }), false);
  assert.equal(isStrictLocalSignedAppIdentity({ ...local, teamIdentifier: "SHOGGOTH01" }), false);
});

test("本地文件 crypto 身份仅接受严格 local-signed 或严格 ad-hoc App", () => {
  assert.equal(isLocalFileCryptoAppIdentity(localIdentity()), true);
  assert.equal(isLocalFileCryptoAppIdentity(adHocIdentity()), true);
  assert.equal(isLocalFileCryptoAppIdentity(developerIdentity()), false);
  assert.equal(isLocalFileCryptoAppIdentity({
    ...adHocIdentity(),
    designatedRequirement: 'cdhash H"8076af64a5ba86c476dadac67886bda36e1228f0"',
  }), false);
});

test("async code identity 复用 canonical parser 读取本地稳定签名", async () => {
  const executable = "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth";
  const calls = [];
  assert.deepEqual(await readCodeIdentityAsync(
    executable,
    {
      allowLocalSignedIdentifier: "ai.shoggoth.desktop",
      execFile: fakeCodesignExecFile(localCodesignDetails, { calls }),
    },
  ), localIdentity());
  const options = { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 };
  assert.deepEqual(calls, [
    {
      command: "/usr/bin/codesign",
      args: ["--verify", "--strict", path.resolve(executable)],
      options,
    },
    {
      command: "/usr/bin/codesign",
      args: ["-d", "--verbose=4", "-r-", path.resolve(executable)],
      options,
    },
  ]);
});

test("async code identity 将 verify callback error 固定映射为 identity error", async () => {
  await assert.rejects(readCodeIdentityAsync(
    "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    {
      allowLocalSignedIdentifier: "ai.shoggoth.desktop",
      execFile: fakeCodesignExecFile(localCodesignDetails, { errorAt: "verify" }),
    },
  ), (error) => {
    assert.equal(error?.code, "CODE_IDENTITY_INVALID");
    assert.equal(error?.message, "code_identity_invalid");
    return true;
  });
});

test("async code identity 将 describe callback error 固定映射为 identity error", async () => {
  await assert.rejects(readCodeIdentityAsync(
    "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    {
      allowLocalSignedIdentifier: "ai.shoggoth.desktop",
      execFile: fakeCodesignExecFile(localCodesignDetails, { errorAt: "describe" }),
    },
  ), (error) => {
    assert.equal(error?.code, "CODE_IDENTITY_INVALID");
    assert.equal(error?.message, "code_identity_invalid");
    return true;
  });
});

test("packaged one-shot crypto 为真实钥匙串冷启动保留有界期限", () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 8_000);
});

test("ad-hoc 包按当前 CDHash 隔离 Keychain service，稳定签名沿用固定命名空间", () => {
  const first = {
    adHoc: true,
    teamIdentifier: null,
    identifier: "ai.shoggoth.desktop",
    cdHash: "7076af64a5ba86c476dadac67886bda36e1228f0",
    designatedRequirement: "cdhash H\"7076af64a5ba86c476dadac67886bda36e1228f0\"",
  };
  const second = {
    ...first,
    cdHash: "8176af64a5ba86c476dadac67886bda36e1228f1",
    designatedRequirement: "cdhash H\"8176af64a5ba86c476dadac67886bda36e1228f1\"",
  };
  assert.equal(
    keychainServiceNameForIdentity(first),
    "Shoggoth Background Service ad-hoc 7076af64a5ba86c476dadac67886bda36e1228f0",
  );
  assert.notEqual(keychainServiceNameForIdentity(first), keychainServiceNameForIdentity(second));
  assert.equal(keychainServiceNameForIdentity({
    teamIdentifier: "SHOGGOTH01",
    designatedRequirement: "identifier ai.shoggoth.desktop and anchor apple generic",
  }), SHOGGOTH_AGENT_SERVICE_NAME);
  assert.equal(keychainServiceNameForIdentity(null), SHOGGOTH_AGENT_SERVICE_NAME);
});

test("本地稳定签名与严格 ad-hoc 绕过 safeStorage，Developer ID 新写入使用系统存储", () => {
  const paths = fixturePaths("smcw-local-storage-selection-");
  const localIdentity = {
    localSigned: true,
    teamIdentifier: null,
    identifier: "ai.shoggoth.desktop",
    certificateRootHash: "ddb8a6fee24f4bd865bab191d92c44062f213137",
    designatedRequirement: "identifier \"ai.shoggoth.desktop\" and certificate root = H\"ddb8a6fee24f4bd865bab191d92c44062f213137\"",
  };
  const localStorage = { kind: "local-file" };
  const systemStorage = { ...safeStorage, kind: "keychain" };
  let safeStorageReads = 0;
  let localFactoryCalls = 0;
  const electron = {};
  Object.defineProperty(electron, "safeStorage", {
    get() {
      safeStorageReads += 1;
      return systemStorage;
    },
  });
  const options = {
    paths,
    electron,
    createLocalFileSafeStorage() {
      localFactoryCalls += 1;
      return localStorage;
    },
  };

  assert.equal(cryptoStorageForIdentity(localIdentity, options), localStorage);
  assert.equal(localFactoryCalls, 1);
  assert.equal(safeStorageReads, 0, "本地签名路径不得触碰登录钥匙串 getter");

  const officialStorage = cryptoStorageForIdentity({
    teamIdentifier: "SHOGGOTH01",
    designatedRequirement: "identifier ai.shoggoth.desktop and anchor apple generic",
  }, options);
  assert.equal(officialStorage.isEncryptionAvailable(), true);
  const encrypted = officialStorage.encryptString("official-value");
  assert.deepEqual(encrypted, systemStorage.encryptString("official-value"));
  assert.equal(officialStorage.decryptString(encrypted), "official-value");
  officialStorage.close();
  assert.equal(cryptoStorageForIdentity({
    adHoc: true,
    teamIdentifier: null,
    identifier: "ai.shoggoth.desktop",
    cdHash: "7076af64a5ba86c476dadac67886bda36e1228f0",
    designatedRequirement: "cdhash H\"7076af64a5ba86c476dadac67886bda36e1228f0\"",
  }, options), localStorage);
  assert.equal(localFactoryCalls, 2);
  assert.equal(safeStorageReads, 1);
});

test("正式 worker 可读取测试版的 MCP 密钥及密文，保留原文件且只读打开旧主密钥", async () => {
  const paths = fixturePaths("smcw-official-upgrade-");
  const local = createLocalFileSafeStorage({ paths });
  const serviceGate = gate();
  const request = { version: 1, generation: 3, operation: "service.loadOrCreate", paths };
  const originalFrame = await performWorkerOperation({ gate: serviceGate, request, safeStorage: local });
  const originalSecret = decodeWorkerResponse(originalFrame, serviceGate);
  const originalFile = fs.readFileSync(paths.mcpAuthPath);
  const key = fs.readFileSync(localCryptoKeyPath(paths));
  const encrypted = local.encryptString("legacy-credential");
  local.close();
  let readOnly;
  let legacy;
  const official = cryptoStorageForIdentity({ teamIdentifier: "SHOGGOTH01" }, {
    paths, safeStorage,
    createLocalFileSafeStorage(options) {
      readOnly = options.readOnly;
      legacy = createLocalFileSafeStorage(options);
      return legacy;
    },
  });
  try {
    for (const operation of ["service.loadOrCreate", "helper.read"]) {
      const operationGate = operation === "helper.read" ? gate({ callerRole: "mcp" }) : serviceGate;
      const response = await performWorkerOperation({
        gate: operationGate, request: { ...request, operation }, safeStorage: official,
      });
      const secret = decodeWorkerResponse(response, operationGate);
      assert.deepEqual(secret, originalSecret);
      secret.fill(0);
    }
    assert.equal(official.decryptString(encrypted), "legacy-credential");
    assert.equal(readOnly, true);
    assert.deepEqual(fs.readFileSync(paths.mcpAuthPath), originalFile);
    assert.deepEqual(fs.readFileSync(localCryptoKeyPath(paths)), key);
    const corrupt = Buffer.from(encrypted);
    corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => official.decryptString(corrupt), { code: "LOCAL_CRYPTO_UNAVAILABLE" });
    assert.deepEqual(official.encryptString("new-value"), safeStorage.encryptString("new-value"));
  } finally {
    official.close();
    originalSecret.fill(0);
    key.fill(0);
  }
  assert.equal(legacy.isEncryptionAvailable(), false);
});

test("正式 worker 不为缺失旧密钥创建替代品，不用旧格式绕过锁定的系统存储", () => {
  const oldPaths = fixturePaths("smcw-old-key-");
  const oldStorage = createLocalFileSafeStorage({ paths: oldPaths });
  const encrypted = oldStorage.encryptString("old-value");
  oldStorage.close();
  const paths = fixturePaths("smcw-missing-old-key-");
  const official = cryptoStorageForIdentity({ teamIdentifier: "SHOGGOTH01" }, { paths, safeStorage });
  assert.throws(() => official.decryptString(encrypted), { code: "LOCAL_CRYPTO_UNAVAILABLE" });
  assert.equal(fs.existsSync(localCryptoKeyPath(paths)), false);
  official.close();
  let localReads = 0;
  const locked = cryptoStorageForIdentity({ teamIdentifier: "SHOGGOTH01" }, {
    paths: oldPaths,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
    createLocalFileSafeStorage() { localReads += 1; throw new Error("must not read"); },
  });
  assert.equal(locked.isEncryptionAvailable(), false);
  assert.throws(() => locked.decryptString(encrypted), { code: "MCP_CRYPTO_UNAVAILABLE" });
  assert.equal(localReads, 0);
  locked.close();
});

test("从测试版升级后仍可读待处理命令和 Provider 凭据，后续写入使用系统格式", async () => {
  const { paths, pendingPath } = await seedStrictLocalEncryptedState("smcw-legacy-domains-");
  const local = createLocalFileSafeStorage({ paths, readOnly: true });
  const oldSecrets = new EncryptedSecretStore({ paths, safeStorage: local });
  await oldSecrets.open();
  await oldSecrets.put("upgrade-credential", "fixture-value", { kind: "openai-api-key" });
  await oldSecrets.close();
  local.close();
  const official = cryptoStorageForIdentity({ teamIdentifier: "SHOGGOTH01" }, { paths, safeStorage });
  const inbox = new PendingCommandInbox({ paths, safeStorage: official });
  const secrets = new EncryptedSecretStore({ paths, safeStorage: official });
  try {
    await inbox.open();
    assert.equal(inbox.isLocked(), false);
    assert.equal(inbox.get("strict-local-failure-fixture").prompt, "strict local encrypted pending command");
    await inbox.transition("strict-local-failure-fixture", "canceled");
    const persistedInbox = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    assert.doesNotThrow(() => JSON.parse(safeStorage.decryptString(Buffer.from(persistedInbox.ciphertext, "base64"))));
    await secrets.open();
    assert.equal(await secrets.get("upgrade-credential"), "fixture-value");
    await secrets.put("upgrade-credential", "updated-fixture-value", { kind: "openai-api-key" });
    const persistedSecrets = JSON.parse(fs.readFileSync(paths.encryptedSecretsPath, "utf8"));
    assert.equal(safeStorage.decryptString(Buffer.from(persistedSecrets.credentials["upgrade-credential"].ciphertext, "base64")), "updated-fixture-value");
  } finally {
    await inbox.close();
    await secrets.close();
    official.close();
  }
});

test("本地稳定签名 packaged worker 不命名/聚焦 Keychain App，也不读取 safeStorage getter", async () => {
  const paths = fixturePaths("smcw-local-packaged-worker-");
  const applicationsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smcw-applications-"));
  const appPath = path.join(applicationsRoot, "Shoggoth.app");
  const executable = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appRoot = path.join(resourcesPath, "app.asar");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executable, "local signed executable fixture\n");
  fs.writeFileSync(appRoot, "local signed app.asar fixture\n");

  const calls = [];
  const electronApp = {
    getAppPath: () => appRoot,
    setName() { calls.push("name"); },
    setPath() { calls.push("path"); },
    async whenReady() { calls.push("ready"); },
    setActivationPolicy() { calls.push("activation"); },
    focus() { calls.push("focus"); },
    exit() { calls.push("exit"); },
  };
  const electron = { app: electronApp };
  Object.defineProperty(electron, "safeStorage", {
    get() {
      calls.push("safeStorage");
      throw new Error("local signed worker must not access Electron safeStorage");
    },
  });
  const workerGate = gate({ parentExecutable: executable, appRoot });
  const payload = Buffer.from("local-packaged-worker-probe", "utf8");
  const output = new PassThrough();
  output.resume();
  await startMcpCryptoWorker({
    gate: workerGate,
    request: {
      version: 1,
      generation: workerGate.generation,
      operation: "safeStorage.encrypt",
      paths: {
        trustedRoot: paths.trustedRoot,
        stateDir: paths.stateDir,
        mcpAuthPath: paths.mcpAuthPath,
        profileDir: paths.profileDir,
        cacheDir: paths.cacheDir,
      },
      payloadBytes: payload.length,
    },
    payload,
    electron,
    electronApp,
    output,
    localCryptoRandomBytes: (bytes) => Buffer.alloc(bytes, bytes === 32 ? 0x91 : 0x92),
    runtime: {
      ppid: process.pid,
      execPath: executable,
      appRoot,
      resourcesPath,
      applicationsRoot,
      defaultApp: false,
      parent: {
        executable,
        command: `${executable} --shoggoth-internal-role=agent-service`,
        ppid: 1,
      },
      verifyCodeIdentity: () => ({
        localSigned: true,
        teamIdentifier: null,
        identifier: "ai.shoggoth.desktop",
        certificateRootHash: "ddb8a6fee24f4bd865bab191d92c44062f213137",
        designatedRequirement: "identifier \"ai.shoggoth.desktop\" and certificate root = H\"ddb8a6fee24f4bd865bab191d92c44062f213137\"",
      }),
    },
  });
  assert.equal(calls.includes("ready"), true);
  assert.equal(calls.includes("exit"), true);
  assert.equal(calls.includes("name"), false);
  assert.equal(calls.includes("activation"), false);
  assert.equal(calls.includes("focus"), false);
  assert.equal(calls.includes("safeStorage"), false);
});

test("crypto worker 保留独立 Keychain 身份但不显示 Dock 图标或抢焦点", async () => {
  assert.equal(SHOGGOTH_AGENT_SERVICE_NAME, "Shoggoth Background Service v2");
  const paths = fixturePaths("smcw-name-");
  const calls = [];
  const output = new PassThrough();
  output.resume();
  const workerGate = gate();
  const payload = Buffer.from("keychain-name-probe", "utf8");
  const visibleSafeStorage = {
    ...safeStorage,
    encryptString(value) {
      calls.push(["safeStorage"]);
      return safeStorage.encryptString(value);
    },
  };
  const electronApp = {
    getAppPath: () => ROOT,
    setName(value) { calls.push(["name", value]); },
    setPath(name) { calls.push(["path", name]); },
    async whenReady() { calls.push(["ready"]); },
    setActivationPolicy(value) { calls.push(["activation", value]); },
    dock: { async show() { calls.push(["dock-show"]); } },
    focus(options) { calls.push(["focus", options]); },
    exit() {},
  };
  await startMcpCryptoWorker({
    gate: workerGate,
    request: {
      version: 1,
      generation: workerGate.generation,
      operation: "safeStorage.encrypt",
      paths: {
        trustedRoot: paths.trustedRoot,
        stateDir: paths.stateDir,
        mcpAuthPath: paths.mcpAuthPath,
        profileDir: paths.profileDir,
        cacheDir: paths.cacheDir,
      },
      payloadBytes: payload.length,
    },
    payload,
    electron: { app: electronApp, safeStorage: visibleSafeStorage },
    electronApp,
    safeStorage: visibleSafeStorage,
    output,
    runtime: {
      ppid: process.pid,
      execPath: process.execPath,
      appRoot: ROOT,
      defaultApp: true,
      parent: {
        ppid: 1,
        executable: process.execPath,
        command: `${process.execPath} --shoggoth-internal-role=agent-service`,
      },
    },
  });
  assert.deepEqual(calls[0], ["name", SHOGGOTH_AGENT_SERVICE_NAME]);
  assert.equal(calls.findIndex(([kind]) => kind === "name")
    < calls.findIndex(([kind]) => kind === "ready"), true);
  assert.deepEqual(calls.find(([kind]) => kind === "activation"), ["activation", "accessory"]);
  assert.equal(calls.some(([kind]) => kind === "focus" || kind === "dock-show"), false);
  assert.equal(calls.findIndex(([kind]) => kind === "activation")
    < calls.findIndex(([kind]) => kind === "safeStorage"), true);
});

test("crypto worker 必须先固定后台名称再接触 Electron safeStorage", async () => {
  const paths = fixturePaths("smcw-name-order-");
  const calls = [];
  const output = new PassThrough();
  output.resume();
  const workerGate = gate();
  const payload = Buffer.from("keychain-name-order-probe", "utf8");
  const electronApp = {
    getAppPath: () => ROOT,
    setName(value) { calls.push(["name", value]); },
    setPath(name) { calls.push(["path", name]); },
    async whenReady() { calls.push(["ready"]); },
    setActivationPolicy() {},
    focus() {},
    exit() {},
  };
  const electron = { app: electronApp };
  Object.defineProperty(electron, "safeStorage", {
    enumerable: true,
    get() {
      calls.push(["safeStorage-access"]);
      return safeStorage;
    },
  });
  await startMcpCryptoWorker({
    gate: workerGate,
    request: {
      version: 1,
      generation: workerGate.generation,
      operation: "safeStorage.encrypt",
      paths: {
        trustedRoot: paths.trustedRoot,
        stateDir: paths.stateDir,
        mcpAuthPath: paths.mcpAuthPath,
        profileDir: paths.profileDir,
        cacheDir: paths.cacheDir,
      },
      payloadBytes: payload.length,
    },
    payload,
    electron,
    electronApp,
    output,
    runtime: {
      ppid: process.pid,
      execPath: process.execPath,
      appRoot: ROOT,
      resourcesPath: ROOT,
      defaultApp: true,
      parent: {
        executable: process.execPath,
        command: `${process.execPath} --shoggoth-internal-role=agent-service`,
        ppid: 1,
      },
    },
  });
  const nameIndex = calls.findIndex(([kind]) => kind === "name");
  const safeStorageIndex = calls.findIndex(([kind]) => kind === "safeStorage-access");
  assert.ok(nameIndex >= 0);
  assert.ok(safeStorageIndex > nameIndex, JSON.stringify(calls));
});

test("packaged crypto 不修改登录钥匙串 ACL，专用条目由当前 App 首次创建并继承信任", async () => {
  const paths = fixturePaths("smcw-no-acl-mutation-");
  const output = new PassThrough();
  output.resume();
  const workerGate = gate({
    parentExecutable: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
  });
  const payload = Buffer.from("no-keychain-acl-mutation", "utf8");
  let aclMutationCalls = 0;
  const electronApp = {
    getAppPath: () => ROOT,
    setName() {},
    setPath() {},
    async whenReady() {},
    setActivationPolicy() {},
    focus() {},
    exit() {},
  };
  await startMcpCryptoWorker({
    gate: workerGate,
    request: {
      version: 1,
      generation: workerGate.generation,
      operation: "safeStorage.encrypt",
      paths: {
        trustedRoot: paths.trustedRoot,
        stateDir: paths.stateDir,
        mcpAuthPath: paths.mcpAuthPath,
        profileDir: paths.profileDir,
        cacheDir: paths.cacheDir,
      },
      payloadBytes: payload.length,
    },
    payload,
    electron: { app: electronApp, safeStorage },
    electronApp,
    safeStorage,
    output,
    ensureSafeStorageTrustedApplication() { aclMutationCalls += 1; },
    runtime: {
      ppid: process.pid,
      execPath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
      appRoot: ROOT,
      defaultApp: true,
      parent: {
        executable: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
        command: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth --shoggoth-internal-role=agent-service",
        ppid: 1,
      },
    },
  });
  assert.equal(aclMutationCalls, 0);
});

function fakeSpawnFactory(mode, capture = {}) {
  return (_executable, _args, options) => {
    capture.options = options;
    const child = new EventEmitter();
    child.pid = 98761;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const gatePipe = new PassThrough();
    child.stdio = [child.stdin, child.stdout, null, gatePipe];
    let gateBody = "";
    let requestBody = "";
    gatePipe.on("data", (chunk) => { gateBody += chunk; });
    child.stdin.on("data", (chunk) => { requestBody += chunk; });
    let gateEnded = false;
    let requestEnded = false;
    let responseStarted = false;
    const respond = () => {
      if (!gateEnded || !requestEnded || mode === "hang" || responseStarted) return;
      responseStarted = true;
      const parsedGate = JSON.parse(gateBody);
      const requestNewline = requestBody.indexOf("\n");
      const parsedRequest = JSON.parse(requestBody.slice(0, requestNewline));
      const requestPayload = Buffer.from(requestBody.slice(requestNewline + 1), "utf8");
      let frame;
      if (mode === "malformed") frame = Buffer.alloc(12, 0x44);
      else if (mode === "oversize") frame = Buffer.alloc(74, 0x45);
      else if (mode === "wrong-gate") frame = encodeWorkerResponse({ gate: { ...parsedGate, nonce: nonce(9) }, secret: Buffer.alloc(32, 4), ok: true });
      else if (parsedRequest.operation === "safeStorage.encrypt"
        || parsedRequest.operation === "safeStorage.decrypt") {
        frame = encodeWorkerResponse({ gate: parsedGate, payload: Buffer.from(requestPayload).reverse(), ok: true });
      } else frame = encodeWorkerResponse({ gate: parsedGate, secret: Buffer.alloc(32, 4), ok: true });
      capture.responseFrame = frame;
      if (mode === "exit-first") {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        setImmediate(() => child.stdout.end(frame));
        return;
      }
      const finish = () => {
        child.stdout.end(frame);
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      };
      if (mode === "cold-start") setTimeout(finish, 1_200);
      else finish();
    };
    gatePipe.on("end", () => { gateEnded = true; respond(); });
    child.stdin.on("end", () => { requestEnded = true; capture.request = requestBody; respond(); });
    return child;
  };
}

test("worker 二进制响应绑定 generation/nonce，secret 不经 JSON 字符串", () => {
  const secret = Buffer.alloc(32, 0x51);
  const frame = encodeWorkerResponse({ gate: gate(), secret, ok: true });
  assert.equal(frame.length, 73);
  assert.equal(frame.toString("utf8").includes(secret.toString("base64url")), false);
  const decoded = decodeWorkerResponse(frame, gate());
  assert.equal(decoded.equals(secret), true);
  decoded.fill(0);
  assert.throws(() => decodeWorkerResponse(frame, gate({ nonce: nonce(2) })), /mcp_crypto_unavailable/u);
});

test("worker 只接受同 executable、父 PID/role/app 与 generation gate", () => {
  const valid = gate();
  assert.equal(assertWorkerParent(valid, {
    ppid: process.pid, execPath: process.execPath, appRoot: ROOT, defaultApp: true,
    parent: { executable: process.execPath, command: `${process.execPath} ${ROOT} --shoggoth-internal-role=agent-service` },
  }), true);
  for (const broken of [
    { ...valid, parentPid: process.pid + 1 },
    { ...valid, parentExecutable: "/tmp/fake" },
    { ...valid, callerRole: "mcp" },
  ]) assert.throws(() => assertWorkerParent(broken, {
    ppid: process.pid, execPath: process.execPath, appRoot: ROOT, defaultApp: true,
    parent: { executable: process.execPath, command: `${process.execPath} ${ROOT} --shoggoth-internal-role=agent-service` },
  }), /mcp_crypto_unavailable/u);
});

test("packaged worker 除稳定 App 路径外还必须通过 TeamIdentifier/designated identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smcw-signed-app-"));
  const applicationsRoot = path.join(root, "Applications");
  const appPath = path.join(applicationsRoot, "Shoggoth.app");
  const executable = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const archive = path.join(resourcesPath, "app.asar");
  const codexExecutable = path.join(resourcesPath, "codex", "package", "bin", "codex");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(codexExecutable), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executable, "fixture", { mode: 0o700 });
  fs.writeFileSync(codexExecutable, "fixture", { mode: 0o700 });
  fs.writeFileSync(archive, "fixture", { mode: 0o600 });
  const packagedGate = gate({ parentExecutable: executable, appRoot: archive });
  const runtime = {
    ppid: process.pid, execPath: executable, appRoot: archive, defaultApp: false,
    resourcesPath, applicationsRoot,
    parent: {
      executable,
      command: `${executable} --shoggoth-internal-role=agent-service`,
      ppid: 1,
    },
  };
  assert.equal(assertWorkerParent(packagedGate, {
    ...runtime,
    verifyCodeIdentity: () => ({
      teamIdentifier: "SHOGGOTH01",
      designatedRequirement: "identifier com.shoggoth.desktop and anchor apple generic",
    }),
  }), true);
  assert.throws(() => assertWorkerParent(packagedGate, {
    ...runtime,
    verifyCodeIdentity: () => ({ teamIdentifier: "", designatedRequirement: "" }),
  }), /mcp_crypto_unavailable/u);

  const adHocIdentity = {
    teamIdentifier: null,
    designatedRequirement: 'cdhash H"7076af64a5ba86c476dadac67886bda36e1228f0"',
    identifier: "ai.shoggoth.desktop",
    adHoc: true,
    cdHash: "7076af64a5ba86c476dadac67886bda36e1228f0",
  };
  assert.equal(assertWorkerParent(packagedGate, {
    ...runtime,
    verifyCodeIdentity: () => adHocIdentity,
  }), true, "launchd 拥有的 packaged Service 可使用当前 App 的严格 ad-hoc 自身份");
  assert.throws(() => assertWorkerParent(packagedGate, {
    ...runtime,
    parent: { ...runtime.parent, ppid: 99 },
    verifyCodeIdentity: () => adHocIdentity,
  }), /mcp_crypto_unavailable/u, "普通父进程不能借 ad-hoc 身份启动 Service crypto worker");

  const mcpGate = gate({
    callerRole: "mcp",
    parentExecutable: executable,
    appRoot: archive,
  });
  const mcpRuntime = {
    ...runtime,
    parent: {
      executable,
      command: `${executable} --shoggoth-internal-role=mcp`,
      ppid: 771,
    },
    grandparent: {
      executable: codexExecutable,
      command: `${codexExecutable} app-server`,
    },
    verifyCodeIdentity: (subject) => subject === executable
      ? adHocIdentity
      : {
        teamIdentifier: CODEX_TEAM_IDENTIFIER,
        designatedRequirement: CODEX_DESIGNATED_REQUIREMENT,
      },
  };
  assert.equal(assertWorkerParent(mcpGate, mcpRuntime), true,
    "ad-hoc MCP helper 仍须由 bundled 官方 Codex 直接启动");
  assert.throws(() => assertWorkerParent(mcpGate, {
    ...mcpRuntime,
    verifyCodeIdentity: (subject) => subject === executable
      ? adHocIdentity
      : { teamIdentifier: "FAKE000000", designatedRequirement: "identifier fake" },
  }), /mcp_crypto_unavailable/u);
});

test("code identity 默认拒绝 ad-hoc，仅显式 Shoggoth bundle + cdhash 自身份可用", () => {
  const executable = "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth";
  const cdHash = "7076af64a5ba86c476dadac67886bda36e1228f0";
  const details = [
    `Executable=${executable}`,
    "Identifier=ai.shoggoth.desktop",
    "CodeDirectory v=20500 flags=0x10002(adhoc,runtime)",
    `CDHash=${cdHash}`,
    "Signature=adhoc",
    "TeamIdentifier=not set",
    `# designated => cdhash H\"${cdHash}\"`,
  ].join("\n");
  const spawnSync = (_command, args) => args[0] === "--verify"
    ? { status: 0, stdout: "", stderr: "" }
    : { status: 0, stdout: "", stderr: details };

  assert.throws(() => readCodeIdentity(executable, { spawnSync }), /code_identity_invalid/u);
  assert.deepEqual(readCodeIdentity(executable, {
    spawnSync,
    allowAdHocIdentifier: "ai.shoggoth.desktop",
  }), {
    teamIdentifier: null,
    designatedRequirement: `cdhash H\"${cdHash}\"`,
    identifier: "ai.shoggoth.desktop",
    adHoc: true,
    cdHash,
  });

  for (const malformed of [
    details.replace("Identifier=ai.shoggoth.desktop", "Identifier=ai.attacker.desktop"),
    details.replace(`CDHash=${cdHash}`, "CDHash=1111111111111111111111111111111111111111"),
    details.replace("Signature=adhoc", "Signature=Developer ID Application: Fake"),
  ]) {
    assert.throws(() => readCodeIdentity(executable, {
      allowAdHocIdentifier: "ai.shoggoth.desktop",
      spawnSync: (_command, args) => args[0] === "--verify"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 0, stdout: "", stderr: malformed },
    }), /code_identity_invalid/u);
  }

  const certificateRootHash = "ddb8a6fee24f4bd865bab191d92c44062f213137";
  const localDetails = [
    `Executable=${executable}`,
    "Identifier=ai.shoggoth.desktop",
    "CodeDirectory v=20500 flags=0x10000(runtime)",
    "Signature size=2332",
    "Authority=Shoggoth Local Code Signing Stable",
    "TeamIdentifier=not set",
    `# designated => identifier \"ai.shoggoth.desktop\" and certificate root = H\"${certificateRootHash}\"`,
  ].join("\n");
  assert.deepEqual(readCodeIdentity(executable, {
    allowLocalSignedIdentifier: "ai.shoggoth.desktop",
    spawnSync: (_command, args) => args[0] === "--verify"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: "", stderr: localDetails },
  }), {
    teamIdentifier: null,
    designatedRequirement: `identifier \"ai.shoggoth.desktop\" and certificate root = H\"${certificateRootHash}\"`,
    identifier: "ai.shoggoth.desktop",
    localSigned: true,
    certificateRootHash,
  });
  for (const malformed of [
    localDetails.replace("Identifier=ai.shoggoth.desktop", "Identifier=ai.attacker.desktop"),
    localDetails.replace("Signature size=2332", "Signature=adhoc"),
    localDetails.replace(certificateRootHash, "not-a-certificate-hash"),
  ]) {
    assert.throws(() => readCodeIdentity(executable, {
      allowLocalSignedIdentifier: "ai.shoggoth.desktop",
      spawnSync: (_command, args) => args[0] === "--verify"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 0, stdout: "", stderr: malformed },
    }), /code_identity_invalid/u);
  }
});

test("packaged code identity 校验给大型 Codex 二进制保留有界冷启动预算", () => {
  const executable = "/Applications/Shoggoth.app/Contents/Resources/codex/package/bin/codex";
  const calls = [];
  const details = [
    `Executable=${executable}`,
    "Identifier=codex",
    `TeamIdentifier=${CODEX_TEAM_IDENTIFIER}`,
    `# designated => ${CODEX_DESIGNATED_REQUIREMENT}`,
  ].join("\n");
  const identity = readCodeIdentity(executable, {
    spawnSync(_command, args, options) {
      calls.push({ args, options });
      return args[0] === "--verify"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 0, stdout: "", stderr: details };
    },
  });
  assert.equal(identity.teamIdentifier, CODEX_TEAM_IDENTIFIER);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.timeout >= 15_000 && call.options.timeout <= 20_000, true,
      "codesign 仍需有界，但冷启动实机已稳定超过 8 秒，需要覆盖首轮签名链校验");
  }
});

test("worker one-shot service 创建、helper 只读，safeStorage ciphertext 持久化且明文仅 Buffer 返回", async () => {
  const paths = fixturePaths();
  const serviceGate = gate();
  const serviceRequest = {
    version: 1, generation: 3, operation: "service.loadOrCreate",
    paths: { trustedRoot: paths.trustedRoot, stateDir: paths.stateDir, mcpAuthPath: paths.mcpAuthPath, profileDir: paths.profileDir, cacheDir: paths.cacheDir },
  };
  const frame = await performWorkerOperation({ gate: serviceGate, request: serviceRequest, safeStorage });
  const secret = decodeWorkerResponse(frame, serviceGate);
  assert.equal(fs.readFileSync(paths.mcpAuthPath, "utf8").includes(secret.toString("base64url")), false);
  const helperGate = gate({ callerRole: "mcp", generation: 4, nonce: nonce(3) });
  const helperFrame = await performWorkerOperation({
    gate: helperGate,
    request: { ...serviceRequest, generation: 4, operation: "helper.read" },
    safeStorage,
  });
  const helperSecret = decodeWorkerResponse(helperFrame, helperGate);
  assert.equal(helperSecret.equals(secret), true);
  secret.fill(0);
  helperSecret.fill(0);
});

test("in-process broker 分离 service 创建与 helper 只读权限", async () => {
  const paths = fixturePaths("smcw-in-process-roles-");
  const serviceStorage = safeStorage;
  const serviceBroker = new InProcessMcpCryptoBroker({
    paths, callerRole: "agent-service", safeStorage: serviceStorage,
  }).open({ generation: 1 });
  const secret = await serviceBroker.loadOrCreateForService({ generation: 1 });
  await assert.rejects(() => serviceBroker.readForHelper({ generation: 1 }));
  await serviceBroker.close();

  const helperStorage = safeStorage;
  const helperBroker = new InProcessMcpCryptoBroker({
    paths, callerRole: "mcp", safeStorage: helperStorage,
  }).open({ generation: 1 });
  assert.deepEqual(await helperBroker.readForHelper({ generation: 1 }), secret);
  await assert.rejects(() => helperBroker.loadOrCreateForService({ generation: 1 }));
  secret.fill(0);
  await helperBroker.close();
});

test("owned local safeStorage 在 broker close 时清零且只关闭一次", async () => {
  const paths = fixturePaths("smcw-in-process-owned-");
  let closeCalls = 0;
  let available = true;
  const storage = {
    ...safeStorage,
    isEncryptionAvailable: () => available,
    close() { closeCalls += 1; available = false; },
  };
  const broker = new InProcessMcpCryptoBroker({
    paths,
    callerRole: "agent-service",
    safeStorage: storage,
    ownsSafeStorage: true,
  }).open({ generation: 7 });
  const secret = await broker.loadOrCreateForService({ generation: 7 });
  secret.fill(0);
  await broker.close();
  await broker.close();
  assert.equal(storage.isEncryptionAvailable(), false);
  assert.equal(closeCalls, 1);
  assert.throws(() => broker.open({ generation: 8 }));
});

test("non-owned broker 可按新 generation 安全 reopen，旧 generation 永久失效", async () => {
  const paths = fixturePaths("smcw-in-process-reopen-");
  const broker = new InProcessMcpCryptoBroker({
    paths, callerRole: "agent-service", safeStorage,
  }).open({ generation: 1 });
  const first = await broker.loadOrCreateForService({ generation: 1 });
  first.fill(0);
  await broker.close();
  await assert.rejects(() => broker.loadOrCreateForService({ generation: 1 }));
  broker.open({ generation: 2 });
  await assert.rejects(() => broker.loadOrCreateForService({ generation: 1 }));
  const second = await broker.loadOrCreateForService({ generation: 2 });
  second.fill(0);
  await broker.close();
});

test("in-process broker 拒绝跨 generation 完成的旧 store open", async () => {
  let releaseFirstOpen = null;
  let openCalls = 0;
  let closeCalls = 0;
  let operationCalls = 0;
  const store = {
    open() {
      openCalls += 1;
      if (openCalls === 1) {
        return new Promise((resolve) => { releaseFirstOpen = resolve; });
      }
      return this;
    },
    close() { closeCalls += 1; },
    loadOrCreateForService() {
      operationCalls += 1;
      return Buffer.alloc(32, 0x53);
    },
    readForHelper() { throw new Error("helper operation must not run"); },
  };
  const broker = new InProcessMcpCryptoBroker({
    callerRole: "agent-service", safeStorage, store,
  }).open({ generation: 1 });
  const stale = broker.loadOrCreateForService({ generation: 1 });
  stale.catch(() => {});
  await waitFor(() => typeof releaseFirstOpen === "function");

  const closing = broker.close();
  let reopenWhileClosingError = null;
  try { broker.open({ generation: 2 }); } catch (error) { reopenWhileClosingError = error; }
  releaseFirstOpen();

  await assert.rejects(stale, /mcp_crypto_unavailable/u);
  await closing;
  if (!reopenWhileClosingError) await broker.close();
  assert.equal(reopenWhileClosingError?.code, "MCP_CRYPTO_UNAVAILABLE");

  broker.open({ generation: 2 });
  const current = broker.loadOrCreateForService({ generation: 2 });
  const secret = await current;
  assert.equal(secret.equals(Buffer.alloc(32, 0x53)), true);
  secret.fill(0);
  assert.equal(openCalls, 2);
  assert.equal(closeCalls, 1);
  assert.equal(operationCalls, 1, "旧 generation 不得在 await 后调用 store operation");
  await broker.close();
  assert.equal(closeCalls, 2);
});

test("in-process broker 清零并拒绝跨 close 完成的旧 store operation 结果", async () => {
  let releaseOperation = null;
  let closeCalls = 0;
  const returnedSecret = Buffer.alloc(32, 0x56);
  const store = {
    open() { return this; },
    close() { closeCalls += 1; },
    loadOrCreateForService() {
      return new Promise((resolve) => {
        releaseOperation = () => resolve(returnedSecret);
      });
    },
    readForHelper() { throw new Error("helper operation must not run"); },
  };
  const broker = new InProcessMcpCryptoBroker({
    callerRole: "agent-service", safeStorage, store,
  }).open({ generation: 1 });
  const stale = broker.loadOrCreateForService({ generation: 1 });
  stale.catch(() => {});
  await waitFor(() => typeof releaseOperation === "function");

  const closing = broker.close();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const closedBeforeOperation = closeSettled;
  releaseOperation();
  const staleOutcome = await stale.then(
    () => "resolved",
    (error) => error?.code === "MCP_CRYPTO_UNAVAILABLE" ? "rejected" : "wrong-error",
  );
  await closing;
  assert.equal(closedBeforeOperation, true,
    "close 不得等待已调用 store operation 的 Promise settlement");
  assert.equal(closeCalls, 1);
  assert.equal(staleOutcome, "rejected");
  assert.equal(returnedSecret.every((byte) => byte === 0), true);
});

test("未 open 的 owned broker close 仍只清零 safeStorage 一次并进入终态", async () => {
  let closeCalls = 0;
  let available = true;
  const storage = {
    ...safeStorage,
    isEncryptionAvailable: () => available,
    close() { closeCalls += 1; available = false; },
  };
  const broker = new InProcessMcpCryptoBroker({
    paths: fixturePaths("smcw-in-process-owned-unopened-"),
    callerRole: "agent-service",
    safeStorage: storage,
    ownsSafeStorage: true,
  });
  await broker.close();
  await broker.close();
  assert.equal(storage.isEncryptionAvailable(), false);
  assert.equal(closeCalls, 1);
  assert.throws(() => broker.open({ generation: 1 }), /mcp_crypto_unavailable/u);
});

test("owned broker 并发 close 共享 promise 且都等待 store cleanup", async () => {
  let releaseStoreClose = null;
  const store = {
    open() { return this; },
    close() { return new Promise((resolve) => { releaseStoreClose = resolve; }); },
    loadOrCreateForService() { return Buffer.alloc(32, 0x54); },
    readForHelper() { throw new Error("helper operation must not run"); },
  };
  const storage = { ...safeStorage, close() {} };
  const broker = new InProcessMcpCryptoBroker({
    callerRole: "agent-service", safeStorage: storage, ownsSafeStorage: true, store,
  }).open({ generation: 7 });
  const secret = await broker.loadOrCreateForService({ generation: 7 });
  secret.fill(0);

  const firstClose = broker.close();
  await waitFor(() => typeof releaseStoreClose === "function");
  const secondClose = broker.close();
  let secondSettled = false;
  void secondClose.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const secondWaited = !secondSettled;
  releaseStoreClose();
  await Promise.all([firstClose, secondClose]);

  assert.equal(firstClose, secondClose);
  assert.equal(secondWaited, true);
});

test("owned broker 从 close 入口起即禁止 reopen", async () => {
  let releaseStoreClose = null;
  const store = {
    open() { return this; },
    close() { return new Promise((resolve) => { releaseStoreClose = resolve; }); },
    loadOrCreateForService() { return Buffer.alloc(32, 0x55); },
    readForHelper() { throw new Error("helper operation must not run"); },
  };
  const storage = { ...safeStorage, close() {} };
  const broker = new InProcessMcpCryptoBroker({
    callerRole: "agent-service", safeStorage: storage, ownsSafeStorage: true, store,
  }).open({ generation: 7 });
  const secret = await broker.loadOrCreateForService({ generation: 7 });
  secret.fill(0);

  const closing = broker.close();
  await waitFor(() => typeof releaseStoreClose === "function");
  let reopenError = null;
  try { broker.open({ generation: 8 }); } catch (error) { reopenError = error; }
  releaseStoreClose();
  await closing;
  assert.equal(reopenError?.code, "MCP_CRYPTO_UNAVAILABLE");
});

test("worker request 畸形、多帧与 oversize 全部 fail closed", async () => {
  for (const input of [Readable.from(["{}"]), Readable.from(["{}\n{}\n"]), Readable.from(["x".repeat(17 * 1024)])]) {
    await assert.rejects(readSingleJsonLine(input), /mcp_crypto_unavailable/u);
  }
});

test("worker stdout write true/false 均等待有界 settle，error/close/timeout 全路径清零 frame", async () => {
  const fastErrorOutput = new EventEmitter();
  fastErrorOutput.on("error", () => {});
  fastErrorOutput.write = () => {
    setImmediate(() => fastErrorOutput.emit("error", new Error("worker-fast-epipe-canary")));
    return true;
  };
  const fastErrorFrame = Buffer.alloc(73, 0x61);
  const fastErrorOutcome = await Promise.race([
    writeFrame(fastErrorOutput, fastErrorFrame, 30).then(
      () => "resolved",
      (error) => error?.code === "MCP_CRYPTO_UNAVAILABLE" ? "rejected" : "wrong-error",
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 80)),
  ]);
  assert.equal(fastErrorOutcome, "rejected");
  assert.equal(fastErrorFrame.every((byte) => byte === 0), true);

  const backpressured = new EventEmitter();
  let writeCallback;
  backpressured.write = (_frame, callback) => { writeCallback = callback; return false; };
  const backpressuredFrame = Buffer.alloc(73, 0x62);
  let backpressuredSettled = false;
  const pendingBackpressure = writeFrame(backpressured, backpressuredFrame, 100)
    .finally(() => { backpressuredSettled = true; });
  writeCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backpressuredSettled, false, "write callback 不能替代 drain");
  backpressured.emit("drain");
  await pendingBackpressure;
  assert.equal(backpressuredFrame.every((byte) => byte === 0), true);

  const hungOutput = new EventEmitter();
  hungOutput.write = () => false;
  const hungFrame = Buffer.alloc(73, 0x63);
  await assert.rejects(
    writeFrame(hungOutput, hungFrame, 10),
    (error) => error.code === "MCP_CRYPTO_UNAVAILABLE",
  );
  assert.equal(hungFrame.every((byte) => byte === 0), true);
});

test("broker 使用固定环境白名单、严格校验 worker frame", async () => {
  for (const mode of ["valid", "exit-first", "malformed", "oversize", "wrong-gate"]) {
    const capture = {};
    const broker = new McpCryptoBroker({
      paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
      appRoot: ROOT, defaultApp: true, spawn: fakeSpawnFactory(mode, capture),
      parentEnv: { HOME: os.homedir(), SECRET_CANARY: "worker-secret-canary-0001" },
      randomBytes: () => Buffer.alloc(32, 7), requestTimeoutMs: 200,
    }).open();
    if (mode === "valid" || mode === "exit-first") {
      const secret = await broker.loadOrCreateForService({ generation: 3 });
      assert.equal(secret.equals(Buffer.alloc(32, 4)), true);
      secret.fill(0);
      assert.equal(capture.responseFrame.every((byte) => byte === 0), true,
        "broker 必须清零原始 stdout 成功 frame，而不只清零聚合副本");
    } else {
      await assert.rejects(broker.loadOrCreateForService({ generation: 3 }), /mcp_crypto_unavailable/u);
    }
    assert.equal(JSON.stringify(capture.options.env).includes("worker-secret-canary-0001"), false);
    assert.equal(capture.request.includes("worker-secret-canary-0001"), false);
    await broker.close();
  }
  assert.equal(Object.prototype.hasOwnProperty.call(workerEnvironment({ TOKEN: "nope" }), "TOKEN"), false);
  assert.equal(workerEnvironment({
    NODE_ENV: "test",
    SHOGGOTH_TEST_ROLE_GATE_FILE: "/tmp/shoggoth-test-gate.json",
    SHOGGOTH_TEST_ROLE_GATE_NONCE: "fixture-nonce",
    SHOGGOTH_TEST_CRYPTO_STALL_MS: "10000",
  }).SHOGGOTH_TEST_CRYPTO_STALL_MS, "10000");
  assert.equal(Object.prototype.hasOwnProperty.call(workerEnvironment({
    NODE_ENV: "production",
    SHOGGOTH_TEST_CRYPTO_STALL_MS: "10000",
  }), "SHOGGOTH_TEST_CRYPTO_STALL_MS"), false);
});

test("broker 默认期限容纳 packaged Electron 首次冷启动且仍保持有界", async () => {
  const broker = new McpCryptoBroker({
    paths: fixturePaths(),
    callerRole: "agent-service",
    executablePath: process.execPath,
    appRoot: ROOT,
    defaultApp: true,
    spawn: fakeSpawnFactory("cold-start"),
    randomBytes: () => Buffer.alloc(32, 7),
  }).open({ generation: 3 });
  const startedAt = Date.now();
  const secret = await broker.loadOrCreateForService({ generation: 3 });
  assert.equal(secret.length, 32);
  assert.ok(Date.now() - startedAt >= 1_100);
  assert.ok(Date.now() - startedAt < 2_500);
  secret.fill(0);
  await broker.close();
});

test("broker 同代串行访问钥匙串且首个失败后不再重复拉起系统授权", async () => {
  let spawnCalls = 0;
  const broker = new McpCryptoBroker({
    paths: fixturePaths(),
    callerRole: "agent-service",
    executablePath: process.execPath,
    appRoot: ROOT,
    defaultApp: true,
    spawn(...args) {
      spawnCalls += 1;
      return fakeSpawnFactory("malformed")(...args);
    },
    randomBytes: () => Buffer.alloc(32, 7),
    requestTimeoutMs: 200,
  }).open({ generation: 3 });

  const firstGeneration = await Promise.allSettled([
    broker.loadOrCreateForService({ generation: 3 }),
    broker.loadOrCreateForService({ generation: 3 }),
    broker.encrypt(Buffer.from("must-not-open-another-keychain-dialog"), { generation: 3 }),
  ]);
  assert.equal(firstGeneration.every((result) => result.status === "rejected"), true);
  assert.equal(spawnCalls, 1, "同一代首次失败后排队请求必须直接失败，不能再次弹系统授权");
  await assert.rejects(
    broker.loadOrCreateForService({ generation: 3 }),
    /mcp_crypto_unavailable/u,
  );
  assert.equal(spawnCalls, 1);
  await broker.close();

  broker.open({ generation: 4 });
  await assert.rejects(
    broker.loadOrCreateForService({ generation: 4 }),
    /mcp_crypto_unavailable/u,
  );
  assert.equal(spawnCalls, 2, "显式重启后的新代才允许重新尝试一次");
  await broker.close();
});

test("broker 通用 encrypt/decrypt 只接受 Buffer 且通过 one-shot worker", async () => {
  const broker = new McpCryptoBroker({
    paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
    appRoot: ROOT, defaultApp: true, spawn: fakeSpawnFactory("valid"),
    randomBytes: () => Buffer.alloc(32, 7), requestTimeoutMs: 200,
  }).open();
  const plaintext = Buffer.from("pending-command-canary", "utf8");
  const ciphertext = await broker.encrypt(plaintext, { generation: 3 });
  const decrypted = await broker.decrypt(ciphertext, { generation: 3 });
  assert.equal(Buffer.isBuffer(ciphertext), true);
  assert.equal(Buffer.isBuffer(decrypted), true);
  plaintext.fill(0);
  ciphertext.fill(0);
  decrypted.fill(0);
  await broker.close();
});

test("broker hard timeout 对忽略 TERM 的 worker 升级 KILL 并确认退出", async () => {
  const signals = [];
  let childRef;
  let groupExists = true;
  const spawnFake = (...args) => {
    childRef = fakeSpawnFactory("hang")(...args);
    return childRef;
  };
  const broker = new McpCryptoBroker({
    paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
    appRoot: ROOT, defaultApp: true, spawn: spawnFake, requestTimeoutMs: 30, termGraceMs: 20,
    signalProcess(_pid, signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        groupExists = false;
        childRef.signalCode = signal;
        setImmediate(() => childRef.emit("exit", null, signal));
      } else if (signal === 0 && !groupExists) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    },
  }).open();
  await assert.rejects(broker.loadOrCreateForService({ generation: 3 }), /mcp_crypto_unavailable/u);
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
  await broker.close();
});

test("broker close 会取消在途 worker，等待 KILL 确认且迟到请求固定失败", async () => {
  const signals = [];
  let childRef;
  let groupExists = true;
  const broker = new McpCryptoBroker({
    paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
    appRoot: ROOT, defaultApp: true,
    spawn(...args) {
      childRef = fakeSpawnFactory("hang")(...args);
      return childRef;
    },
    requestTimeoutMs: 1000,
    termGraceMs: 20,
    signalProcess(_pid, signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        groupExists = false;
        childRef.signalCode = signal;
        setImmediate(() => childRef.emit("exit", null, signal));
      } else if (signal === 0 && !groupExists) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    },
  }).open();
  const pending = broker.loadOrCreateForService({ generation: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  await broker.close();
  await assert.rejects(pending, /mcp_crypto_unavailable/u);
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
  await assert.rejects(broker.loadOrCreateForService({ generation: 4 }), /mcp_crypto_unavailable/u);
});

test("leader 在 TERM 后退出仍须 probe PGID、KILL 后确认 ESRCH", async () => {
  const signals = [];
  let childRef;
  let groupExists = true;
  let allowGroupExit = false;
  let sawKill;
  const killObserved = new Promise((resolve) => { sawKill = resolve; });
  const broker = new McpCryptoBroker({
    paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
    appRoot: ROOT, defaultApp: true,
    spawn(...args) {
      childRef = fakeSpawnFactory("hang")(...args);
      return childRef;
    },
    requestTimeoutMs: 30,
    termGraceMs: 20,
    killConfirmMs: 80,
    signalProcess(_pid, signal) {
      signals.push(signal);
      if (signal === "SIGTERM") {
        childRef.signalCode = signal;
        setImmediate(() => childRef.emit("exit", null, signal));
      } else if (signal === "SIGKILL") {
        sawKill();
      } else if (signal === 0 && allowGroupExit) {
        groupExists = false;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    },
  }).open();
  const pending = broker.loadOrCreateForService({ generation: 3 });
  pending.catch(() => {});
  await killObserved;
  const closing = broker.close();
  closing.catch(() => {});
  const pendingSettledBeforeGroupExit = await Promise.race([
    pending.then(() => true, () => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  const closeSettledBeforeGroupExit = await Promise.race([
    closing.then(() => true, () => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(pendingSettledBeforeGroupExit, false);
  assert.equal(closeSettledBeforeGroupExit, false);
  allowGroupExit = true;
  await assert.rejects(pending, /mcp_crypto_unavailable/u);
  await closing;
  assert.deepEqual(signals.slice(0, 3), ["SIGTERM", 0, "SIGKILL"]);
  assert.equal(signals.at(-1), 0);
});

test("PGID 在 KILL 后仍存在时 close 固定拒绝且不伪报清理完成", async () => {
  let childRef;
  const broker = new McpCryptoBroker({
    paths: fixturePaths(), callerRole: "agent-service", executablePath: process.execPath,
    appRoot: ROOT, defaultApp: true,
    spawn(...args) {
      childRef = fakeSpawnFactory("hang")(...args);
      return childRef;
    },
    requestTimeoutMs: 120,
    termGraceMs: 10,
    killConfirmMs: 30,
    signalProcess(_pid, signal) {
      if (signal === "SIGTERM") {
        childRef.signalCode = signal;
        setImmediate(() => childRef.emit("exit", null, signal));
      }
      // signal 0 与 KILL 都模拟仍有同 PGID 后代存活。
    },
  }).open();
  const pending = broker.loadOrCreateForService({ generation: 3 });
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(broker.close(), /mcp_crypto_unavailable/u);
  await assert.rejects(pending, /mcp_crypto_unavailable/u);
});

async function seedStrictLocalEncryptedState(prefix) {
  const paths = fixturePaths(prefix);
  const storage = createLocalFileSafeStorage({ paths });
  const broker = new InProcessMcpCryptoBroker({
    paths,
    callerRole: "agent-service",
    safeStorage: storage,
    ownsSafeStorage: true,
  }).open({ generation: 1 });
  const inbox = new PendingCommandInbox({ paths, cryptoBroker: broker });
  let inboxOpened = false;
  let secret = null;
  let primaryError = null;
  try {
    secret = await broker.loadOrCreateForService({ generation: 1 });
    assert.equal(secret.length, 32);
    await inbox.open();
    inboxOpened = true;
    await inbox.enqueue({
      operationId: "strict-local-failure-fixture",
      runId: "strict-local-failure-run",
      sessionKey: crypto.randomUUID(),
      prompt: "strict local encrypted pending command",
      createdAt: Date.now(),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (secret) secret.fill(0);
  }
  const cleanupErrors = [];
  try {
    if (inboxOpened) await inbox.close();
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try { await broker.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "strict-local encrypted fixture setup and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "strict-local encrypted fixture cleanup failed");
  }
  return {
    paths,
    keyPath: localCryptoKeyPath(paths),
    pendingPath: path.join(paths.stateDir, "pending-commands.json"),
  };
}

function flipCanonicalEnvelopeCiphertext(target) {
  const envelope = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(typeof envelope.ciphertext, "string");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  assert.ok(ciphertext.length > 36, "fixture 必须包含 AES-GCM header 与非空密文");
  assert.equal(ciphertext.toString("base64"), envelope.ciphertext);
  ciphertext[ciphertext.length - 1] ^= 0x01;
  envelope.ciphertext = ciphertext.toString("base64");
  ciphertext.fill(0);
  fs.writeFileSync(target, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  assert.equal(fs.statSync(target).mode & 0o077, 0);
}

function strictLocalServiceSelector(paths) {
  const observation = {
    externalWorkerFactoryCalls: 0,
    localStorageFactoryCalls: 0,
    localStorages: [],
    prewarmCalls: 0,
    prewarmOutcome: null,
  };
  let resolvePrewarm;
  observation.prewarmSettled = new Promise((resolve) => { resolvePrewarm = resolve; });
  const selector = new PackagedMcpCryptoBroker(selectorOptions({
    paths,
    callerRole: "agent-service",
    createLocalFileSafeStorage(options) {
      observation.localStorageFactoryCalls += 1;
      const storage = createLocalFileSafeStorage(options);
      observation.localStorages.push(storage);
      return storage;
    },
    createExternalBroker() {
      observation.externalWorkerFactoryCalls += 1;
      throw new Error("strict local failure fixture must not create external worker");
    },
  }));
  const loadOrCreateForService = selector.loadOrCreateForService.bind(selector);
  selector.loadOrCreateForService = (options) => {
    observation.prewarmCalls += 1;
    let result;
    try {
      result = loadOrCreateForService(options);
    } catch (error) {
      observation.prewarmOutcome = { ok: false, code: error?.code };
      resolvePrewarm(observation.prewarmOutcome);
      throw error;
    }
    void Promise.resolve(result).then(
      () => {
        observation.prewarmOutcome = { ok: true };
        resolvePrewarm(observation.prewarmOutcome);
      },
      (error) => {
        observation.prewarmOutcome = { ok: false, code: error?.code };
        resolvePrewarm(observation.prewarmOutcome);
      },
    );
    return result;
  };
  return { selector, observation };
}

async function assertStrictLocalServiceFailsClosed(paths, options = {}) {
  const { selector, observation } = strictLocalServiceSelector(paths);
  const encryptedEvidence = new Map([
    [paths.mcpAuthPath, fs.readFileSync(paths.mcpAuthPath)],
    [path.join(paths.stateDir, "pending-commands.json"),
      fs.readFileSync(path.join(paths.stateDir, "pending-commands.json"))],
  ]);
  observation.evidenceBuffers = [...encryptedEvidence.values()];
  if (typeof options.onEvidenceBuffers === "function") {
    options.onEvidenceBuffers(observation.evidenceBuffers);
  }
  const service = createAgentService({
    paths,
    version: "strict-local-failure-integration",
    cryptoBroker: selector,
    prewarmMcpAuth: true,
  });
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => { unhandledRejections.push(reason); };
  process.on("unhandledRejection", onUnhandledRejection);
  let startAttempted = false;
  let primaryError = null;
  try {
    if (typeof options.decorateService === "function") options.decorateService(service);
    startAttempted = true;
    await service.start();
    let prewarmTimer = null;
    let prewarmOutcome;
    try {
      prewarmOutcome = await Promise.race([
        observation.prewarmSettled,
        new Promise((_, reject) => {
          prewarmTimer = setTimeout(
            () => reject(new Error("strict-local prewarm did not settle")), 1_000,
          );
        }),
      ]);
    } finally {
      if (prewarmTimer) clearTimeout(prewarmTimer);
    }
    assert.deepEqual(prewarmOutcome, { ok: false, code: "MCP_CRYPTO_UNAVAILABLE" });
    await new Promise((resolve) => setImmediate(resolve));

    const request = (method, params = {}) => requestService(paths, {
      version: PROTOCOL_VERSION,
      method,
      params,
      token: readClientToken(paths),
    });
    const status = await request("service.status");
    assert.equal(status.healthy, true);
    assert.equal(status.pendingCommandsLocked, true);
    assert.equal(status.mcpCredentialsLocked, true);
    assert.equal(observation.prewarmCalls, 1);
    assert.equal(observation.externalWorkerFactoryCalls, 0);

    const sessions = await request("chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID,
      cursor: null,
      limit: 10,
      includeArchived: false,
    });
    assert.ok(sessions.sessions.length > 0);
    await assert.rejects(request("chat.send", {
      operationId: `strict-local-locked-${crypto.randomUUID()}`,
      sessionKey: sessions.sessions[0].sessionKey,
      prompt: "must fail while strict local encrypted state is locked",
      createdAt: Date.now(),
    }), (error) => error?.code === "SERVICE_UNAVAILABLE"
      && error?.message === "Shoggoth Service 暂时不可用");
    if (typeof options.beforeCleanup === "function") await options.beforeCleanup();
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  try {
    if (startAttempted) {
      try { await service.stop({ notify: false }); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandledRejections, []);
      assert.equal(observation.externalWorkerFactoryCalls, 0);
      for (const storage of observation.localStorages) {
        assert.equal(storage.isEncryptionAvailable(), false);
      }
      for (const [target, evidence] of encryptedEvidence) {
        assert.equal(fs.readFileSync(target).equals(evidence), true);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  } finally {
    try {
      process.off("unhandledRejection", onUnhandledRejection);
    } finally {
      for (const evidence of encryptedEvidence.values()) evidence.fill(0);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "strict-local Service assertion and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "strict-local Service cleanup failed");
  }
  return observation;
}

function removeStrictLocalFixtureRoot(trustedRoot) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = fs.realpathSync(trustedRoot);
  const basename = path.basename(fixtureRoot);
  if (path.dirname(fixtureRoot) !== temporaryRoot
    || !["smcw-slk-", "smcw-slc-"].some((prefix) => basename.startsWith(prefix))) {
    throw new Error("refusing to remove non strict-local fixture root");
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

async function withStrictLocalFixtureCleanup(fixture, options, action) {
  let result;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    try {
      result = await action();
    } catch (error) {
      primaryError = error;
    }
  } finally {
    try {
      if (options.restoreKeyMode === true && fs.existsSync(fixture.keyPath)) {
        fs.chmodSync(fixture.keyPath, 0o600);
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try { removeStrictLocalFixtureRoot(fixture.paths.trustedRoot); } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "strict-local fixture assertion and cleanup both failed",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "strict-local fixture cleanup failed");
  }
  return result;
}

test("strict-local master key 权限过宽时真实 Service 健康但双锁且不启动外置 worker", async () => {
  const fixture = await seedStrictLocalEncryptedState("smcw-slk-");
  const unhandledListenerCount = process.listenerCount("unhandledRejection");
  fs.chmodSync(fixture.keyPath, 0o644);
  await withStrictLocalFixtureCleanup(fixture, { restoreKeyMode: true }, async () => {
    const observation = await assertStrictLocalServiceFailsClosed(fixture.paths);
    assert.equal(observation.localStorageFactoryCalls, 1);
    assert.equal(observation.localStorages.length, 0);
    assert.equal(process.listenerCount("unhandledRejection"), unhandledListenerCount);
    assert.equal(observation.evidenceBuffers.every(
      (evidence) => evidence.every((byte) => byte === 0),
    ), true);
  });
  assert.equal(fs.existsSync(fixture.paths.trustedRoot), false);
});

test("strict-local MCP/Inbox 认证密文损坏时真实 Service 健康但双锁", async () => {
  const fixture = await seedStrictLocalEncryptedState("smcw-slc-");
  const unhandledListenerCount = process.listenerCount("unhandledRejection");
  flipCanonicalEnvelopeCiphertext(fixture.paths.mcpAuthPath);
  flipCanonicalEnvelopeCiphertext(fixture.pendingPath);
  await withStrictLocalFixtureCleanup(fixture, {}, async () => {
    const observation = await assertStrictLocalServiceFailsClosed(fixture.paths);
    assert.equal(observation.localStorageFactoryCalls, 1);
    assert.equal(observation.localStorages.length, 1);
    assert.equal(process.listenerCount("unhandledRejection"), unhandledListenerCount);
    assert.equal(observation.evidenceBuffers.every(
      (evidence) => evidence.every((byte) => byte === 0),
    ), true);

    const primaryFailure = new Error("strict-local-primary-failure-probe");
    const cleanupFailure = new Error("strict-local-cleanup-failure-probe");
    let cleanupEvidence = null;
    await assert.rejects(assertStrictLocalServiceFailsClosed(fixture.paths, {
      onEvidenceBuffers(buffers) { cleanupEvidence = buffers; },
      decorateService(service) {
        const realStop = service.stop.bind(service);
        service.stop = async (...args) => {
          await realStop(...args);
          throw cleanupFailure;
        };
      },
      beforeCleanup() { throw primaryFailure; },
    }), (error) => error instanceof AggregateError
      && error.errors[0] === primaryFailure
      && error.errors.includes(cleanupFailure));
    assert.equal(process.listenerCount("unhandledRejection"), unhandledListenerCount);
    assert.equal(cleanupEvidence.every(
      (evidence) => evidence.every((byte) => byte === 0),
    ), true);
  });
  assert.equal(fs.existsSync(fixture.paths.trustedRoot), false);
});

test("Service start 不解析损坏 MCP store；crypto broker 初始化并发 singleflight 且普通 status 不阻塞", async () => {
  const paths = fixturePaths("smcs-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.mcpAuthPath, "{broken\n", { mode: 0o600 });
  let loads = 0;
  let resolveLoad;
  const broker = {
    open() {}, close() {},
    loadOrCreateForService() {
      loads += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
  };
  const service = createAgentService({ paths, version: "crypto-broker", mcpCryptoBroker: broker, mcpAuthInitTimeoutMs: 300 });
  await service.start();
  const runtimeProfile = service.productStore.listAgentProfiles()[0];
  const challenge = (byte) => requestService(paths, { version: PROTOCOL_VERSION, method: "mcp.auth.challenge", params: {
    protocolVersion: PROTOCOL_VERSION,
    runtimeProfileId: runtimeProfile.runtimeProfileId,
    runtimeAccountId: runtimeProfile.runtimeAccountId,
    clientNonce: nonce(byte),
  } });
  const first = challenge(5);
  const second = challenge(6);
  try {
    await waitFor(() => loads === 1);
    assert.equal(loads, 1);
    const status = await requestService(paths, { version: PROTOCOL_VERSION, method: "service.status", token: readClientToken(paths) });
    assert.equal(status.healthy, true);
    resolveLoad(Buffer.alloc(32, 8));
    await Promise.all([first, second]);
  } finally {
    resolveLoad?.(Buffer.alloc(32, 8));
    await Promise.allSettled([first, second]);
    await service.stop({ notify: false });
  }
});

test("PendingCommand 加密挂起只让 chat.send 有界失败，status 与主 Service event loop 保持健康", async () => {
  const paths = fixturePaths("smcp-general-crypto-");
  let enterEncrypt;
  let rejectEncrypt;
  const encryptEntered = new Promise((resolve) => { enterEncrypt = resolve; });
  const broker = {
    open() {},
    close() { rejectEncrypt?.(new Error("closed")); },
    loadOrCreateForService() { return Promise.reject(new Error("not used")); },
    encrypt() {
      enterEncrypt();
      return new Promise((_, reject) => { rejectEncrypt = reject; });
    },
    decrypt() { return Promise.reject(new Error("not used")); },
  };
  const mainSafeStorage = {
    isEncryptionAvailable() { throw new Error("main-safe-storage-canary"); },
    encryptString() { throw new Error("main-safe-storage-canary"); },
    decryptString() { throw new Error("main-safe-storage-canary"); },
  };
  const service = createAgentService({
    paths, version: "general-crypto-isolation", cryptoBroker: broker,
    safeStorage: mainSafeStorage,
    runtimePool: { get() { assert.fail("加密未提交不得启动 runtime"); }, async stopAll() {} },
  });
  await service.start();
  const request = (method, params) => requestService(paths, {
    version: PROTOCOL_VERSION, token: readClientToken(paths), method, params,
  });
  let send = null;
  try {
    const sessions = await request("chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10, includeArchived: false,
    });
    send = request("chat.send", {
      operationId: "crypto-hang-send", sessionKey: sessions.sessions[0].sessionKey,
      prompt: "crypto-hang-prompt", createdAt: Date.now(),
    });
    await encryptEntered;
    const startedAt = Date.now();
    const status = await request("service.status", {});
    assert.equal(status.healthy, true);
    assert.ok(Date.now() - startedAt < 500);
    rejectEncrypt(new Error("worker-timeout"));
    await assert.rejects(send, (error) => error.code === "SERVICE_UNAVAILABLE"
      && !error.message.includes("worker-timeout")
      && !error.message.includes("main-safe-storage-canary"));
  } finally {
    rejectEncrypt?.(new Error("cleanup"));
    await Promise.allSettled([send]);
    await service.stop({ notify: false });
  }
});

test("损坏 MCP container 只让 challenge 固定 unavailable，普通 Service 保持健康", async () => {
  const paths = fixturePaths("smcc-");
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.mcpAuthPath, "{broken\n", { mode: 0o600 });
  const service = createAgentService({ paths, version: "corrupt-degrade", safeStorage });
  await service.start();
  try {
    const status = await requestService(paths, {
      version: PROTOCOL_VERSION, method: "service.status", token: readClientToken(paths),
    });
    assert.equal(status.healthy, true);
    await assert.rejects(requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        clientNonce: nonce(0x42),
      },
    }), (error) => error.code === "SERVICE_UNAVAILABLE" && error.message === "mcp_auth_unavailable");
  } finally {
    await service.stop({ notify: false });
  }
});

test("真实 Electron 非空 Inbox decrypt hang 期间已可 status/chat 只读且密文证据不变", async () => {
  if (process.platform !== "darwin") return;
  const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: ROOT, encoding: "utf8",
  }).trim();
  const repositoryRoot = path.dirname(path.resolve(ROOT, commonGitDir));
  const electronBinary = require(path.join(repositoryRoot, "node_modules", "electron"));
  const homeDir = fs.mkdtempSync("/tmp/sgwd-");
  const paths = resolveServicePaths({ homeDir });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const evidence = Buffer.from(`${JSON.stringify({
    version: 1,
    revision: 1,
    ciphertext: Buffer.alloc(64, 0x5d).toString("base64"),
  })}\n`, "utf8");
  const inboxPath = path.join(paths.stateDir, "pending-commands.json");
  fs.writeFileSync(inboxPath, evidence, { mode: 0o600 });
  const gatePath = path.join(homeDir, "role-gate.json");
  const gateNonce = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(gatePath, JSON.stringify({ parentPid: process.pid, nonce: gateNonce }), { mode: 0o600 });
  const child = spawn(electronBinary, [ROOT, "--shoggoth-internal-role=agent-service"], {
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_ENV: "test",
      SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
      SHOGGOTH_TEST_ROLE_GATE_FILE: gatePath,
      SHOGGOTH_TEST_ROLE_GATE_NONCE: gateNonce,
      SHOGGOTH_TEST_CRYPTO_STALL_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const hasCryptoWorker = () => {
    const processes = execFileSync("/bin/ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
    return processes.split("\n").some((line) => line.trimStart().startsWith(`${child.pid} `)
      && line.includes("--shoggoth-internal-role=mcp-crypto"));
  };
  try {
    await waitFor(hasCryptoWorker, 2_500);
    await waitFor(() => fs.existsSync(paths.socketPath) && fs.existsSync(paths.tokenPath), 700);
    assert.equal(hasCryptoWorker(), true, "Service listen 时 decrypt worker 应仍处于 hard-timeout 边界内");
    const request = (method, params, timeoutMs = 700) => requestService(paths, {
      version: PROTOCOL_VERSION,
      method,
      params,
      token: readClientToken(paths),
    }, { timeoutMs });
    const statusStartedAt = Date.now();
    assert.equal((await request("service.status", {})).healthy, true);
    const sessions = await request("chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10, includeArchived: false,
    });
    assert.equal(sessions.sessions.length > 0, true);
    assert.ok(Date.now() - statusStartedAt < 500);
    await assert.rejects(
      request("chat.send", {
        operationId: "real-decrypt-locked-send",
        sessionKey: sessions.sessions[0].sessionKey,
        prompt: "decrypt-evidence-must-not-be-replaced",
        createdAt: Date.now(),
      }),
      (error) => error.code === "SERVICE_UNAVAILABLE",
    );
    assert.equal(fs.readFileSync(inboxPath).equals(evidence), true);
    await waitFor(() => !hasCryptoWorker(), DEFAULT_REQUEST_TIMEOUT_MS + 1_500);
    await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "service.stop",
      token: readClientToken(paths),
    });
  } catch (error) {
    error.message = `${error.message}\nElectron output:\n${output}`;
    throw error;
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
});

test("真实 Electron safeStorage 卡住只超时目标 MCP/Inbox 操作，普通 status 健康且 worker 无残留", async () => {
  if (process.platform !== "darwin") return;
  const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: ROOT, encoding: "utf8",
  }).trim();
  const repositoryRoot = path.dirname(path.resolve(ROOT, commonGitDir));
  const electronBinary = require(path.join(repositoryRoot, "node_modules", "electron"));
  const homeDir = fs.mkdtempSync("/tmp/sgwc-");
  const paths = resolveServicePaths({ homeDir });
  const gatePath = path.join(homeDir, "role-gate.json");
  const gateNonce = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(gatePath, JSON.stringify({ parentPid: process.pid, nonce: gateNonce }), { mode: 0o600 });
  const child = spawn(electronBinary, [ROOT, "--shoggoth-internal-role=agent-service"], {
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_ENV: "test",
      SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
      SHOGGOTH_TEST_ROLE_GATE_FILE: gatePath,
      SHOGGOTH_TEST_ROLE_GATE_NONCE: gateNonce,
      SHOGGOTH_TEST_CRYPTO_STALL_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitFor(() => fs.existsSync(paths.socketPath) && fs.existsSync(paths.tokenPath), 5000);
    const startedAt = Date.now();
    const challenge = requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        clientNonce: nonce(0x41),
      },
    }, { timeoutMs: 10_000 });
    challenge.catch(() => {});
    let sawWorker = false;
    await waitFor(() => {
      const processes = execFileSync("/bin/ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
      sawWorker = processes.split("\n").some((line) => line.trimStart().startsWith(`${child.pid} `)
        && line.includes("--shoggoth-internal-role=mcp-crypto"));
      return sawWorker;
    }, 2500);
    const statusStartedAt = Date.now();
    const status = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "service.status",
      token: readClientToken(paths),
    }, { timeoutMs: 700 });
    assert.equal(status.healthy, true);
    assert.ok(Date.now() - statusStartedAt < 500);
    await assert.rejects(
      challenge,
      (error) => error.code === "SERVICE_UNAVAILABLE" && error.message === "mcp_auth_unavailable",
    );
    assert.ok(Date.now() - startedAt < 10_000);
    assert.equal(sawWorker, true);
    await waitFor(() => {
      const processes = execFileSync("/bin/ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
      return !processes.split("\n").some((line) => line.trimStart().startsWith(`${child.pid} `)
        && line.includes("--shoggoth-internal-role=mcp-crypto"));
    }, DEFAULT_REQUEST_TIMEOUT_MS + 1_500);

    const authenticatedRequest = (method, params, timeoutMs = 3500) => requestService(paths, {
      version: PROTOCOL_VERSION,
      method,
      params,
      token: readClientToken(paths),
    }, { timeoutMs });
    const sessions = await authenticatedRequest("chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID,
      cursor: null,
      limit: 10,
      includeArchived: false,
    });
    const sendStartedAt = Date.now();
    const send = authenticatedRequest("chat.send", {
      operationId: "real-electron-crypto-hang",
      sessionKey: sessions.sessions[0].sessionKey,
      prompt: "must-stay-inside-the-anonymous-worker-pipe",
      createdAt: Date.now(),
    });
    send.catch(() => {});
    const inboxStatusStartedAt = Date.now();
    const inboxStatus = await authenticatedRequest("service.status", {}, 700);
    assert.equal(inboxStatus.healthy, true);
    assert.ok(Date.now() - inboxStatusStartedAt < 500);
    await assert.rejects(send, (error) => error.code === "SERVICE_UNAVAILABLE"
      && !error.message.includes("must-stay-inside-the-anonymous-worker-pipe"));
    assert.ok(Date.now() - sendStartedAt < 700, "同代首次失败后 chat.send 必须快速固定降级");
    const processesAfterSend = execFileSync("/bin/ps", ["-axo", "ppid=,command="], {
      encoding: "utf8",
    });
    assert.equal(processesAfterSend.split("\n").some((line) => (
      line.trimStart().startsWith(`${child.pid} `)
      && line.includes("--shoggoth-internal-role=mcp-crypto")
    )), false, "同代后续操作不能再次拉起钥匙串 worker");
    await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "service.stop",
      token: readClientToken(paths),
    });
  } catch (error) {
    error.message = `${error.message}\nElectron output:\n${output}`;
    throw error;
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`); console.error(error?.stack || error); }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS shoggoth MCP crypto unit (${tests.length})`);
})();
