#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable, Writable } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { MCP_PRODUCT_TOOL_NAMES } = require(path.join(
  ROOT, "app", "agent-service", "mcp-product-tool-controller.js",
));
const { ensureFederationMcpCredential } = require(path.join(
  ROOT, "app", "agent-service", "federation-mcp-auth.js",
));

let McpAuthSecretStore;
let McpSessionManager;
let createMcpChallengeProof;
let MCP_MAX_FRAME_BYTES;
let MCP_STDIO_PROTOCOL_VERSION;
let authenticateMcpSession;
let createMcpStdioHandler;
let parseMcpRuntimeBinding;
let parseMcpRuntimeProfileId;
let runMcpStdioSession;
let resolveMcpCryptoRequestTimeout;
let runtimeMcpPaths;
let startShoggothMcpHelper;
let moduleLoadError = null;
try {
  ({ McpAuthSecretStore } = require(path.join(
    ROOT, "app", "agent-service", "mcp-auth-secret-store.js",
  )));
  ({ McpSessionManager, createMcpChallengeProof } = require(path.join(
    ROOT, "app", "agent-service", "mcp-session-manager.js",
  )));
  ({
    MCP_MAX_FRAME_BYTES,
    MCP_STDIO_PROTOCOL_VERSION,
    authenticateMcpSession,
    createMcpStdioHandler,
    parseMcpRuntimeBinding,
    parseMcpRuntimeProfileId,
    resolveMcpCryptoRequestTimeout,
    runtimeMcpPaths,
    runMcpStdioSession,
    startShoggothMcpHelper,
  } = require(path.join(ROOT, "app", "shoggoth-mcp-helper.js")));
} catch (error) {
  moduleLoadError = error;
}
const { createAgentService, PROTOCOL_VERSION } = require(path.join(
  ROOT, "app", "agent-service", "server.js",
));
const { startAgentServiceProcess } = require(path.join(ROOT, "app", "agent-service.js"));
const { readClientToken, requestService } = require(path.join(
  ROOT, "app", "agent-service", "client.js",
));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function listAllTools(handler, id) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const response = await handler({ jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} });
    assert.equal(response.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < MCP_MAX_FRAME_BYTES);
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (cursor) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
  } while (cursor);
  return tools;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fixturePaths(prefix = "shoggoth-mcp-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
}

function xorCipher(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0xa5;
  return bytes;
}

function fakeSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => xorCipher(value),
    decryptString: (bytes) => xorCipher(Buffer.from(bytes)).toString("utf8"),
    ...overrides,
  };
}

function fixedRandomBytes(seed = 0x41) {
  let call = 0;
  return (size) => {
    call += 1;
    return Buffer.alloc(size, (seed + call) & 0xff);
  };
}

function nonce(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function runtimeAccountId(runtimeProfileId) {
  return `${runtimeProfileId}-account`;
}

function profile(id, runtimeProfileId, enabled = true) {
  return { id, runtimeProfileId, runtimeAccountId: runtimeAccountId(runtimeProfileId), enabled };
}

function profileStore(profiles) {
  return { listAgentProfiles: () => profiles.map((value) => ({ ...value })) };
}

function authRequest(challenge, secret, overrides = {}) {
  const bound = { ...challenge, ...overrides };
  return {
    challengeId: bound.challengeId,
    protocolVersion: bound.protocolVersion,
    runtimeProfileId: bound.runtimeProfileId,
    runtimeAccountId: bound.runtimeAccountId,
    clientNonce: bound.clientNonce,
    serverNonce: bound.serverNonce,
    proof: createMcpChallengeProof(secret, bound),
  };
}

function publicError(error, code, message) {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  return error?.code === code && error?.message === message
    && !serialized.includes("runtime-a")
    && !serialized.includes("fixture-secret-canary");
}

function requireFreshWithMocks(target, mocks) {
  const targetId = require.resolve(target);
  const previousTarget = require.cache[targetId];
  const restored = [];
  try {
    for (const [dependency, patch] of mocks) {
      const dependencyId = require.resolve(dependency);
      if (!require.cache[dependencyId]) require(dependencyId);
      const entry = require.cache[dependencyId];
      restored.push([entry, entry.exports]);
      entry.exports = { ...entry.exports, ...patch };
    }
    delete require.cache[targetId];
    return require(targetId);
  } finally {
    delete require.cache[targetId];
    if (previousTarget) require.cache[targetId] = previousTarget;
    for (const [entry, exports] of restored.reverse()) entry.exports = exports;
  }
}

test("MCP auth 模块与固定私有路径可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof McpAuthSecretStore, "function");
  assert.equal(typeof McpSessionManager, "function");
  assert.equal(typeof createMcpChallengeProof, "function");
  assert.equal(typeof authenticateMcpSession, "function");
  assert.equal(typeof createMcpStdioHandler, "function");
  assert.equal(typeof parseMcpRuntimeBinding, "function");
  assert.equal(typeof parseMcpRuntimeProfileId, "function");
  assert.equal(typeof runMcpStdioSession, "function");
  assert.equal(typeof startShoggothMcpHelper, "function");
  const paths = fixturePaths();
  assert.equal(paths.mcpAuthPath, path.join(paths.stateDir, "mcp-auth.json"));
});

test("MCP helper argv 同时绑定唯一非敏感 runtimeProfileId 与 runtimeAccountId", () => {
  const argv = [
    "/Applications/Shoggoth.app",
    "--shoggoth-internal-role=mcp",
    "--shoggoth-runtime-profile=runtime-a",
    "--shoggoth-runtime-account=runtime-a-account",
  ];
  assert.deepEqual(parseMcpRuntimeBinding(argv), {
    runtimeProfileId: "runtime-a",
    runtimeAccountId: "runtime-a-account",
  });
  assert.equal(parseMcpRuntimeProfileId(argv), "runtime-a");
  for (const invalidArgv of [
    ["--shoggoth-internal-role=mcp"],
    ["--shoggoth-runtime-profile=runtime-a"],
    ["--shoggoth-runtime-account=runtime-a-account"],
    ["--shoggoth-runtime-profile=runtime-a", "--shoggoth-runtime-profile=runtime-b"],
    ["--shoggoth-runtime-profile=runtime-a", "--shoggoth-runtime-account=../escape"],
    ["--shoggoth-runtime-profile=../escape", "--shoggoth-runtime-account=runtime-a-account"],
    ["--shoggoth-runtime-profile=runtime-a", "--shoggoth-runtime-account=runtime-a-account",
      "--shoggoth-mcp-token=fixture-secret-canary"],
  ]) assert.throws(() => parseMcpRuntimeBinding(invalidArgv), /mcp_helper_arguments_invalid/u);
});

test("runtime MCP 仅接受独立推导的 Service 路径，同时保留受管 HOME", () => {
  const managed = fixturePaths("sm-managed-mcp-");
  const service = fixturePaths("sm-service-mcp-");
  const context = {
    runtimeProfileId: "runtime-a",
    runtimeAccountId: "runtime-a-account",
    servicePaths: {
      trustedRoot: service.trustedRoot,
      stateDir: service.stateDir,
      mcpAuthPath: service.mcpAuthPath,
      runtimeDir: service.runtimeDir,
      socketPath: service.socketPath,
    },
  };
  const binding = { runtimeProfileId: "runtime-a", runtimeAccountId: "runtime-a-account" };
  const paths = runtimeMcpPaths(managed, context, binding, service);
  assert.equal(paths.trustedRoot, service.trustedRoot);
  assert.equal(paths.stateDir, service.stateDir);
  assert.equal(paths.mcpAuthPath, service.mcpAuthPath);
  assert.equal(paths.socketPath, service.socketPath);
  assert.equal(paths.profileDir, managed.profileDir);
  assert.equal(paths.cacheDir, managed.cacheDir);
  assert.throws(
    () => runtimeMcpPaths(managed, context, binding, managed),
    /mcp_helper_auth_failed/u,
  );
  assert.throws(
    () => runtimeMcpPaths(managed, {
      runtimeProfileId: "runtime-b",
      runtimeAccountId: "runtime-a-account",
      servicePaths: {
        trustedRoot: service.trustedRoot,
        stateDir: service.stateDir,
        mcpAuthPath: service.mcpAuthPath,
        runtimeDir: service.runtimeDir,
        socketPath: service.socketPath,
      },
    }, binding, service),
    /mcp_helper_auth_failed/u,
  );
});

test("packaged MCP helper 的外置 crypto 预算覆盖冷启动身份校验且显式配置优先", () => {
  assert.equal(typeof resolveMcpCryptoRequestTimeout, "function");
  assert.equal(resolveMcpCryptoRequestTimeout({
    explicitTimeoutMs: undefined,
    isPackaged: true,
    defaultApp: false,
  }), 30_000);
  assert.equal(resolveMcpCryptoRequestTimeout({
    explicitTimeoutMs: 12_345,
    isPackaged: true,
    defaultApp: false,
  }), 12_345);
  assert.equal(resolveMcpCryptoRequestTimeout({
    explicitTimeoutMs: undefined,
    isPackaged: false,
    defaultApp: true,
  }), undefined);
});

test("Service 仅在真实 packaged 四条件成立时选择共享 selector 并保留 60s 启动参数", async () => {
  const paths = fixturePaths("sm-packaged-service-wiring-");
  const appRoot = "/Applications/Shoggoth.app/Contents/Resources/app.asar";
  const resourcesPath = "/Applications/Shoggoth.app/Contents/Resources";
  const selectorOptions = [];
  const externalOptions = [];
  const serviceOptions = [];
  const runtimeGateOptions = [];
  class FakePackagedBroker {
    constructor(options) { selectorOptions.push(options); }
    open() { return this; }
    close() {}
    loadOrCreateForService() { return Promise.resolve(Buffer.alloc(32)); }
    readForHelper() { return Promise.reject(new Error("wrong role")); }
    encrypt(value) { return Promise.resolve(Buffer.from(value)); }
    decrypt(value) { return Promise.resolve(Buffer.from(value)); }
  }
  class FakeExternalBroker extends FakePackagedBroker {
    constructor(options) { super(options); selectorOptions.pop(); externalOptions.push(options); }
  }
  class FakeRuntimeMcpGateIssuer {
    constructor(options) { runtimeGateOptions.push(options); }
  }
  const fakeServiceFactory = (options) => {
    serviceOptions.push(options);
    return { async start() {}, async stop() {} };
  };
  const fresh = requireFreshWithMocks(path.join(ROOT, "app", "agent-service.js"), [
    [path.join(ROOT, "app", "agent-service", "server.js"), {
      createAgentService: fakeServiceFactory,
    }],
    [path.join(ROOT, "app", "agent-service", "paths.js"), {
      resolveServicePaths: () => paths,
    }],
    [path.join(ROOT, "app", "agent-service", "packaged-mcp-crypto-broker.js"), {
      PackagedMcpCryptoBroker: FakePackagedBroker,
    }],
    [path.join(ROOT, "app", "agent-service", "mcp-crypto-broker.js"), {
      McpCryptoBroker: FakeExternalBroker,
    }],
    [path.join(ROOT, "app", "agent-service", "runtime-mcp-gate.js"), {
      RuntimeMcpGateIssuer: FakeRuntimeMcpGateIssuer,
    }],
  ]);
  const previousNodeEnv = process.env.NODE_ENV;
  const hadDefaultApp = Object.prototype.hasOwnProperty.call(process, "defaultApp");
  const previousDefaultApp = process.defaultApp;
  const electronApp = {
    isPackaged: true,
    getAppPath: () => appRoot,
    setPath() {},
    async whenReady() {},
    on() {},
    off() {},
    quit() {},
  };
  try {
    process.env.NODE_ENV = "production";
    process.defaultApp = false;
    await fresh.startAgentServiceProcess({
      electronApp,
      resourcesPath,
      applicationsRoot: "/Applications",
      version: "selector-wiring",
      signalEmitter: new EventEmitter(),
      mcpCryptoTermGraceMs: 123,
      mcpCryptoKillConfirmMs: 456,
      prewarmMcpAuth: false,
    });
    assert.equal(selectorOptions.length, 1);
    assert.equal(externalOptions.length, 0);
    assert.deepEqual(selectorOptions[0], {
      paths,
      callerRole: "agent-service",
      executablePath: process.execPath,
      appRoot,
      resourcesPath,
      applicationsRoot: "/Applications",
      defaultApp: false,
      parentEnv: process.env,
      requestTimeoutMs: 60_000,
      termGraceMs: 123,
      killConfirmMs: 456,
    });
    assert.equal(serviceOptions[0].cryptoBroker instanceof FakePackagedBroker, true);
    assert.equal(serviceOptions[0].mcpCryptoBroker, serviceOptions[0].cryptoBroker);
    assert.equal(serviceOptions[0].mcpAuthInitTimeoutMs, 65_000);
    assert.equal(serviceOptions[0].runtimeMcpGateIssuer instanceof FakeRuntimeMcpGateIssuer, true);
    assert.equal(runtimeGateOptions[0].mcpHelperLaunch, serviceOptions[0].mcpHelperLaunch);
    assert.deepEqual(runtimeGateOptions[0].mcpHelperLaunch, {
      command: process.execPath,
      argsPrefix: [],
    });
    assert.equal(runtimeGateOptions[0].bootstrapPath, path.join(appRoot, "app", "bootstrap.js"));

    for (const [nodeEnv, defaultApp, isPackaged] of [
      ["test", false, true],
      ["production", true, true],
      ["production", false, false],
    ]) {
      process.env.NODE_ENV = nodeEnv;
      process.defaultApp = defaultApp;
      await fresh.startAgentServiceProcess({
        electronApp: { ...electronApp, isPackaged },
        resourcesPath,
        version: "selector-negative-wiring",
        signalEmitter: new EventEmitter(),
        prewarmMcpAuth: false,
      });
    }
    assert.equal(selectorOptions.length, 1);
    assert.equal(externalOptions.length, 3);

    await fresh.startAgentServiceProcess({
      paths,
      electronApp,
      version: "selector-explicit-paths",
      signalEmitter: new EventEmitter(),
      safeStorage: fakeSafeStorage(),
    });
    assert.equal(selectorOptions.length, 1);
    assert.equal(externalOptions.length, 3);

    process.env.NODE_ENV = "production";
    process.defaultApp = false;
    const injectedSafeStorage = fakeSafeStorage();
    await fresh.startAgentServiceProcess({
      electronApp,
      resourcesPath,
      version: "selector-explicit-safe-storage",
      signalEmitter: new EventEmitter(),
      safeStorage: injectedSafeStorage,
      prewarmMcpAuth: false,
    });
    assert.equal(selectorOptions.length, 1);
    assert.equal(externalOptions.length, 3);
    assert.equal(serviceOptions.at(-1).safeStorage, injectedSafeStorage);
    assert.equal(serviceOptions.at(-1).cryptoBroker, undefined);
    assert.equal(serviceOptions.at(-1).mcpCryptoBroker, undefined);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (hadDefaultApp) process.defaultApp = previousDefaultApp;
    else delete process.defaultApp;
  }
});

test("MCP helper 的真实 packaged 分支选择共享 selector 并保留 30s 启动参数", async () => {
  const paths = fixturePaths("sm-packaged-helper-wiring-");
  const appRoot = "/Applications/Shoggoth.app/Contents/Resources/app.asar";
  const resourcesPath = "/Applications/Shoggoth.app/Contents/Resources";
  const selectorOptions = [];
  const lifecycle = [];
  class FakePackagedBroker {
    constructor(options) { selectorOptions.push(options); }
    open(options) { lifecycle.push(["open", options]); return this; }
    readForHelper() { return Promise.resolve(Buffer.alloc(32, 0x31)); }
    async close() { lifecycle.push(["close"]); }
  }
  class UnexpectedExternalBroker {
    constructor() { throw new Error("legacy external broker selected"); }
  }
  const fresh = requireFreshWithMocks(path.join(ROOT, "app", "shoggoth-mcp-helper.js"), [
    [path.join(ROOT, "app", "agent-service", "paths.js"), {
      resolveServicePaths: () => paths,
    }],
    [path.join(ROOT, "app", "agent-service", "packaged-mcp-crypto-broker.js"), {
      PackagedMcpCryptoBroker: FakePackagedBroker,
    }],
    [path.join(ROOT, "app", "agent-service", "mcp-crypto-broker.js"), {
      McpCryptoBroker: UnexpectedExternalBroker,
    }],
  ]);
  const previousNodeEnv = process.env.NODE_ENV;
  const hadDefaultApp = Object.prototype.hasOwnProperty.call(process, "defaultApp");
  const previousDefaultApp = process.defaultApp;
  const electronCalls = [];
  try {
    process.env.NODE_ENV = "production";
    process.defaultApp = false;
    await fresh.startShoggothMcpHelper({
      runtimeProfileId: "runtime-a",
      runtimeAccountId: "runtime-a-account",
      resourcesPath,
      applicationsRoot: "/Applications",
      mcpCryptoTermGraceMs: 123,
      mcpCryptoKillConfirmMs: 456,
      randomBytes: () => Buffer.alloc(32, 0x41),
      requestService: async (_paths, request) => request.method === "mcp.auth.challenge"
        ? {
          challengeId: Buffer.alloc(16, 0x42).toString("base64url"),
          protocolVersion: PROTOCOL_VERSION,
          runtimeProfileId: "runtime-a",
          runtimeAccountId: "runtime-a-account",
          clientNonce: request.params.clientNonce,
          serverNonce: Buffer.alloc(32, 0x43).toString("base64url"),
          expiresAt: Date.now() + 60_000,
        }
        : {
          token: Buffer.alloc(32, 0x44).toString("base64url"),
          protocolVersion: PROTOCOL_VERSION,
          runtimeProfileId: "runtime-a",
          runtimeAccountId: "runtime-a-account",
          profileId: "profile-a",
          expiresAt: Date.now() + 60_000,
        },
      input: Readable.from([]),
      output: memoryOutput().stream,
      electronApp: {
        isPackaged: true,
        getAppPath: () => appRoot,
        setPath() {},
        async whenReady() { electronCalls.push("ready"); },
        quit() { electronCalls.push("quit"); },
      },
    });
    assert.deepEqual(selectorOptions, [{
      paths,
      callerRole: "mcp",
      executablePath: process.execPath,
      appRoot,
      resourcesPath,
      applicationsRoot: "/Applications",
      defaultApp: false,
      parentEnv: process.env,
      requestTimeoutMs: 30_000,
      termGraceMs: 123,
      killConfirmMs: 456,
    }]);
    assert.deepEqual(lifecycle, [["open", { generation: 1 }], ["close"]]);
    assert.deepEqual(electronCalls, ["ready", "quit"]);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (hadDefaultApp) process.defaultApp = previousDefaultApp;
    else delete process.defaultApp;
  }
});

test("Service 首次创建 32B 长期 secret，safeStorage 密文以 0600 原子持久化并跨重启复用", () => {
  const paths = fixturePaths("shoggoth-mcp-secret-");
  const order = [];
  const partialFs = Object.create(fs);
  partialFs.writeSync = (fd, bytes, offset, length, position) => fs.writeSync(
    fd, bytes, offset, Math.min(length, 5), position,
  );
  partialFs.fsyncSync = (fd) => {
    order.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    return fs.fsyncSync(fd);
  };
  partialFs.renameSync = (source, target) => {
    order.push("rename");
    return fs.renameSync(source, target);
  };
  const first = new McpAuthSecretStore({
    paths,
    access: "service",
    fs: partialFs,
    safeStorage: fakeSafeStorage(),
    randomBytes: fixedRandomBytes(),
  }).open();
  const secret = first.loadOrCreateForService();
  assert.equal(Buffer.isBuffer(secret), true);
  assert.equal(secret.length, 32);
  assert.deepEqual(order.slice(-3), ["file", "rename", "directory"]);
  assert.equal(fs.statSync(paths.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.mcpAuthPath).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(paths.mcpAuthPath, "utf8");
  const container = JSON.parse(serialized);
  assert.deepEqual(Object.keys(container), ["version", "ciphertext"]);
  assert.equal(container.version, 1);
  assert.match(
    container.ciphertext,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
  );
  assert.equal(serialized.includes(secret.toString("hex")), false);
  assert.equal(serialized.includes(secret.toString("base64url")), false);
  first.close();

  const helper = new McpAuthSecretStore({
    paths, access: "helper", safeStorage: fakeSafeStorage(),
  }).open();
  assert.deepEqual(helper.readForHelper(), secret);
  helper.close();
  secret.fill(0);
});

test("Helper 只读：未初始化时不创建 secret，也不调用 randomBytes/encryptString", () => {
  const paths = fixturePaths("shoggoth-mcp-helper-readonly-");
  let randomCalls = 0;
  let encryptCalls = 0;
  const store = new McpAuthSecretStore({
    paths,
    access: "helper",
    randomBytes(size) { randomCalls += 1; return Buffer.alloc(size); },
    safeStorage: fakeSafeStorage({
      encryptString(value) { encryptCalls += 1; return xorCipher(value); },
    }),
  }).open();
  assert.throws(
    () => store.readForHelper(),
    (error) => publicError(error, "MCP_AUTH_NOT_INITIALIZED", "mcp_auth_not_initialized"),
  );
  assert.equal(fs.existsSync(paths.mcpAuthPath), false);
  assert.equal(fs.existsSync(paths.stateDir), false);
  assert.equal(randomCalls, 0);
  assert.equal(encryptCalls, 0);
  store.close();
});

test("safeStorage locked、加解密失败与损坏 plaintext 均固定 credentials_locked 且不泄密", () => {
  const paths = fixturePaths("shoggoth-mcp-locked-");
  const unlocked = new McpAuthSecretStore({
    paths, access: "service", safeStorage: fakeSafeStorage(), randomBytes: fixedRandomBytes(0x51),
  }).open();
  const canary = unlocked.loadOrCreateForService().toString("base64url");
  unlocked.close();

  for (const safeStorage of [
    fakeSafeStorage({ isEncryptionAvailable: () => false }),
    fakeSafeStorage({ decryptString() { throw new Error(`fixture-secret-canary-${canary}`); } }),
    fakeSafeStorage({ decryptString() { return "not-a-canonical-32-byte-secret"; } }),
  ]) {
    const locked = new McpAuthSecretStore({ paths, access: "helper", safeStorage }).open();
    assert.throws(
      () => locked.readForHelper(),
      (error) => error.code === "credentials_locked" && error.message === "credentials_locked"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
    );
    locked.close();
  }
  assert.equal(fs.readFileSync(paths.mcpAuthPath, "utf8").includes(canary), false);
});

test("secret 与 session 的 random/clock 底层异常统一脱敏，不透传 canary", () => {
  const canary = "fixture-secret-canary-random-clock";
  const paths = fixturePaths("shoggoth-mcp-random-error-");
  const store = new McpAuthSecretStore({
    paths,
    access: "service",
    safeStorage: fakeSafeStorage(),
    randomBytes() { throw new Error(canary); },
  }).open();
  assert.throws(
    () => store.loadOrCreateForService(),
    (error) => error.code === "MCP_AUTH_RANDOM_FAILED"
      && error.message === "mcp_auth_random_failed"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  store.close();

  const manager = new McpSessionManager({
    handshakeSecret: Buffer.alloc(32, 0x58),
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    randomBytes() { throw new Error(canary); },
  });
  assert.throws(
    () => manager.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x18),
    }),
    (error) => error.code === "MCP_AUTH_RANDOM_FAILED"
      && error.message === "mcp_auth_random_failed"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  manager.close();

  const badClock = new McpSessionManager({
    handshakeSecret: Buffer.alloc(32, 0x59),
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    now() { throw new Error(canary); },
  });
  assert.throws(
    () => badClock.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x19),
    }),
    (error) => error.code === "MCP_AUTH_CLOCK_INVALID"
      && error.message === "mcp_auth_clock_invalid"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
  );
  badClock.close();

  const overflowingClock = new McpSessionManager({
    handshakeSecret: Buffer.alloc(32, 0x5a),
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    now: () => Number.MAX_SAFE_INTEGER,
  });
  assert.throws(
    () => overflowingClock.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x1a),
    }),
    (error) => error.code === "MCP_AUTH_CLOCK_INVALID"
      && error.message === "mcp_auth_clock_invalid",
  );
  overflowingClock.close();
});

test("提交状态不确定时保留证据并锁定当前及重启后的 secret store", () => {
  const paths = fixturePaths("shoggoth-mcp-uncertain-");
  const initial = new McpAuthSecretStore({
    paths,
    access: "service",
    safeStorage: fakeSafeStorage(),
    randomBytes: fixedRandomBytes(0x60),
  }).open();
  initial.loadOrCreateForService().fill(0);
  initial.close();
  let failCommit = true;
  const faultFs = Object.create(fs);
  faultFs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && failCommit) {
      failCommit = false;
      throw Object.assign(new Error("fixture commit failed"), { code: "EIO" });
    }
    return fs.fsyncSync(fd);
  };
  faultFs.renameSync = (source, target) => {
    if (source.includes(".backup-") && target === paths.mcpAuthPath) {
      throw Object.assign(new Error("fixture rollback failed"), { code: "EIO" });
    }
    return fs.renameSync(source, target);
  };
  const store = new McpAuthSecretStore({
    paths,
    access: "service",
    fs: faultFs,
    safeStorage: fakeSafeStorage(),
    randomBytes: fixedRandomBytes(0x61),
  }).open();
  assert.throws(
    () => store.rotateForService(),
    (error) => error instanceof AggregateError
      && error.code === "MCP_AUTH_COMMIT_UNCERTAIN"
      && error.committedUncertain === true,
  );
  assert.throws(
    () => store.loadOrCreateForService(),
    (error) => error.code === "credentials_locked",
  );
  store.close();

  const reopened = new McpAuthSecretStore({
    paths, access: "service", safeStorage: fakeSafeStorage(),
  }).open();
  assert.throws(
    () => reopened.readForHelper(),
    (error) => error.code === "credentials_locked",
  );
  reopened.close();
});

test("Helper 只读 open 不恢复或删除 Service 的中断写证据", () => {
  const paths = fixturePaths("shoggoth-mcp-helper-evidence-");
  const service = new McpAuthSecretStore({
    paths,
    access: "service",
    safeStorage: fakeSafeStorage(),
    randomBytes: fixedRandomBytes(0x65),
  }).open();
  service.loadOrCreateForService().fill(0);
  service.close();
  const tempPath = `${paths.mcpAuthPath}.tmp`;
  fs.writeFileSync(tempPath, "uncommitted-fixture", { mode: 0o600 });
  const before = fs.readFileSync(tempPath);

  const helper = new McpAuthSecretStore({
    paths, access: "helper", safeStorage: fakeSafeStorage(),
  }).open();
  assert.throws(
    () => helper.readForHelper(),
    (error) => error.code === "credentials_locked",
  );
  assert.deepEqual(fs.readFileSync(tempPath), before);
  helper.close();
});

test("mcp-auth final/temp 的 symlink 与 hardlink 全部 fail closed", () => {
  for (const location of ["final", "temp"]) {
    for (const kind of ["symlink", "hardlink"]) {
      const paths = fixturePaths(`shoggoth-mcp-${location}-${kind}-`);
      fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      const victim = path.join(path.dirname(paths.stateDir), `victim-${location}-${kind}`);
      fs.writeFileSync(victim, "fixture-victim-evidence", { mode: 0o600 });
      const target = location === "final" ? paths.mcpAuthPath : `${paths.mcpAuthPath}.tmp`;
      if (kind === "symlink") fs.symlinkSync(victim, target);
      else fs.linkSync(victim, target);
      assert.throws(
        () => new McpAuthSecretStore({
          paths, access: "service", safeStorage: fakeSafeStorage(),
        }).open(),
        (error) => ["UNSAFE_SYMLINK", "UNSAFE_HARDLINK"].includes(error.code),
      );
      assert.equal(fs.readFileSync(victim, "utf8"), "fixture-victim-evidence");
    }
  }
});

test("challenge proof 绑定版本、Profile、Account、client/server nonce，成功换取短期 token", () => {
  const secret = Buffer.alloc(32, 0x71);
  let now = 1_000;
  const manager = new McpSessionManager({
    handshakeSecret: secret,
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    now: () => now,
    randomBytes: fixedRandomBytes(0x10),
  });
  assert.throws(
    () => manager.issueChallenge({
      protocolVersion: 1,
      runtimeProfileId: "runtime-a",
      clientNonce: nonce(0x01),
    }),
    (error) => publicError(error, "MCP_AUTH_REQUEST_INVALID", "mcp_auth_request_invalid"),
    "legacy profile-only challenge requests must fail closed",
  );
  const challenge = manager.issueChallenge({
    protocolVersion: 1,
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    clientNonce: nonce(0x01),
  });
  assert.deepEqual(Object.keys(challenge), [
    "challengeId", "protocolVersion", "runtimeProfileId", "runtimeAccountId",
    "clientNonce", "serverNonce", "expiresAt",
  ]);
  const result = manager.exchangeChallenge(authRequest(challenge, secret));
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.runtimeProfileId, "runtime-a");
  assert.equal(result.runtimeAccountId, runtimeAccountId("runtime-a"));
  assert.equal(result.profileId, "profile-a");
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(manager.authorizeSession({
    token: result.token,
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
  }), {
    protocolVersion: 1,
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    profileId: "profile-a",
    expiresAt: result.expiresAt,
  });
  assert.equal(JSON.stringify(manager).includes(result.token), false);
  now += 1;
  manager.close();
  secret.fill(0);
});

test("challenge one-shot：重放、跨 Profile、篡改 nonce/proof/version 全部固定拒绝", () => {
  const secret = Buffer.alloc(32, 0x72);
  const manager = new McpSessionManager({
    handshakeSecret: secret,
    profileStore: profileStore([
      profile("profile-a", "runtime-a"), profile("profile-b", "runtime-b"),
    ]),
    protocolVersion: 1,
    now: () => 2_000,
    randomBytes: fixedRandomBytes(0x20),
  });

  const successChallenge = manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x02),
  });
  const request = authRequest(successChallenge, secret);
  manager.exchangeChallenge(request);
  assert.throws(
    () => manager.exchangeChallenge(request),
    (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
  );

  for (const mutation of [
    (challenge) => authRequest(challenge, secret, { runtimeProfileId: "runtime-b" }),
    (challenge) => authRequest(challenge, secret, { runtimeAccountId: "runtime-other-account" }),
    (challenge) => ({ ...authRequest(challenge, secret), clientNonce: nonce(0x03) }),
    (challenge) => ({ ...authRequest(challenge, secret), serverNonce: nonce(0x04) }),
    (challenge) => ({ ...authRequest(challenge, secret), proof: nonce(0x05) }),
    (challenge) => ({ ...authRequest(challenge, secret), protocolVersion: 2 }),
  ]) {
    const challenge = manager.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x06),
    });
    const mutated = mutation(challenge);
    assert.throws(
      () => manager.exchangeChallenge(mutated),
      (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
    );
    assert.throws(
      () => manager.exchangeChallenge(authRequest(challenge, secret)),
      (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
    );
  }
  manager.close();
});

test("challenge TTL 与容量有界，过期记录清理且失败尝试也消费 challenge", () => {
  const secret = Buffer.alloc(32, 0x73);
  let now = 3_000;
  const manager = new McpSessionManager({
    handshakeSecret: secret,
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    now: () => now,
    randomBytes: fixedRandomBytes(0x30),
    challengeTtlMs: 50,
    maxChallenges: 2,
  });
  const first = manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x07),
  });
  manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x08),
  });
  assert.throws(
    () => manager.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x09),
    }),
    (error) => publicError(error, "MCP_AUTH_BUSY", "mcp_auth_busy"),
  );
  now = 3_051;
  manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x0a),
  });
  assert.throws(
    () => manager.exchangeChallenge(authRequest(first, secret)),
    (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
  );
  manager.close();
});

test("token 只存 digest：同 Profile 新认证轮换旧 token，TTL/close/disabled 立即失效", () => {
  const secret = Buffer.alloc(32, 0x74);
  let now = 4_000;
  const profiles = [profile("profile-a", "runtime-a")];
  const manager = new McpSessionManager({
    handshakeSecret: secret,
    profileStore: profileStore(profiles),
    protocolVersion: 1,
    now: () => now,
    randomBytes: fixedRandomBytes(0x40),
    sessionTtlMs: 100,
  });
  const exchange = () => {
    const challenge = manager.issueChallenge({
      protocolVersion: 1, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x0b),
    });
    return manager.exchangeChallenge(authRequest(challenge, secret));
  };
  const first = exchange();
  const second = exchange();
  assert.notEqual(first.token, second.token);
  assert.throws(
    () => manager.authorizeSession({
      token: first.token, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );
  assert.equal(manager.authorizeSession({
    token: second.token, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
  }).profileId, "profile-a");
  now = second.expiresAt + 1;
  assert.throws(
    () => manager.authorizeSession({
      token: second.token, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );

  now = 5_000;
  const third = exchange();
  profiles[0].enabled = false;
  assert.throws(
    () => manager.authorizeSession({
      token: third.token, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );
  manager.close();
  assert.throws(
    () => manager.authorizeSession({
      token: third.token, runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );
});

test("Service bridge session 只在内存签发并按 exact Profile/token 撤销", () => {
  const manager = new McpSessionManager({
    handshakeSecret: Buffer.alloc(32, 0x76),
    profileStore: profileStore([profile("profile-a", "runtime-a")]),
    protocolVersion: 1,
    now: () => 5_500,
    randomBytes: fixedRandomBytes(0x45),
  });
  const first = manager.issueBridgeSession({
    runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"),
  });
  assert.equal(first.runtimeProfileId, "runtime-a");
  assert.equal(first.runtimeAccountId, runtimeAccountId("runtime-a"));
  assert.equal(first.profileId, "profile-a");
  assert.equal(manager.revokeSession({
    runtimeProfileId: "runtime-other", runtimeAccountId: "runtime-other-account", token: first.token,
  }), false);
  assert.equal(manager.authorizeSession({
    runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"), token: first.token,
  }).profileId, "profile-a");
  assert.equal(manager.revokeSession({
    runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"), token: first.token,
  }), true);
  assert.throws(
    () => manager.authorizeSession({
      runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"), token: first.token,
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );

  const second = manager.issueBridgeSession({
    runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"),
  });
  manager.close();
  assert.throws(
    () => manager.authorizeSession({
      runtimeProfileId: "runtime-a", runtimeAccountId: runtimeAccountId("runtime-a"), token: second.token,
    }),
    (error) => publicError(error, "MCP_SESSION_INVALID", "mcp_session_invalid"),
  );
  assert.equal(JSON.stringify(manager).includes(first.token), false);
  assert.equal(JSON.stringify(manager).includes(second.token), false);
});

test("token 仅绑定唯一 enabled Profile，重复/禁用 Profile 与 session 容量均 fail closed", () => {
  const secret = Buffer.alloc(32, 0x75);
  const profiles = [
    profile("profile-a", "runtime-a"),
    profile("profile-a-duplicate", "runtime-a"),
    profile("profile-b", "runtime-b"),
  ];
  const manager = new McpSessionManager({
    handshakeSecret: secret,
    profileStore: profileStore(profiles),
    protocolVersion: 1,
    now: () => 6_000,
    randomBytes: fixedRandomBytes(0x50),
    maxSessions: 1,
  });
  const duplicate = manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x0c),
  });
  assert.throws(
    () => manager.exchangeChallenge(authRequest(duplicate, secret)),
    (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
  );

  profiles[1].enabled = false;
  const accepted = manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"), clientNonce: nonce(0x0d),
  });
  manager.exchangeChallenge(authRequest(accepted, secret));
  const full = manager.issueChallenge({
    protocolVersion: 1, runtimeProfileId: "runtime-b",
    runtimeAccountId: runtimeAccountId("runtime-b"), clientNonce: nonce(0x0e),
  });
  assert.throws(
    () => manager.exchangeChallenge(authRequest(full, secret)),
    (error) => publicError(error, "MCP_AUTH_BUSY", "mcp_auth_busy"),
  );
  assert.throws(
    () => manager.exchangeChallenge(authRequest(full, secret)),
    (error) => publicError(error, "MCP_AUTH_FAILED", "mcp_auth_failed"),
  );
  manager.close();
});

function memoryOutput() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString("utf8");
      callback();
    },
  });
  return { stream, read: () => value };
}

function readAllRegularFiles(root) {
  if (!fs.existsSync(root)) return "";
  const values = [];
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (stat.isFile() && stat.size <= 1024 * 1024) {
      values.push(fs.readFileSync(target));
    }
  };
  visit(root);
  return Buffer.concat(values).toString("utf8");
}

async function authenticateServiceSession(
  paths,
  safeStorage,
  runtimeProfileId,
  runtimeAccountIdValue,
  byte = 0x66,
) {
  const clientNonce = nonce(byte);
  const challenge = await requestService(paths, {
    version: PROTOCOL_VERSION,
    method: "mcp.auth.challenge",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId: runtimeAccountIdValue,
      clientNonce,
    },
  });
  const helperStore = new McpAuthSecretStore({
    paths, access: "helper", safeStorage,
  }).open();
  const longSecret = helperStore.readForHelper();
  try {
    return await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.exchange",
      params: authRequest(challenge, longSecret),
    });
  } finally {
    longSecret.fill(0);
    helperStore.close();
  }
}

test("Service start 不触发 safeStorage，首次 challenge 才创建 secret 并完成 Profile 短 token", async () => {
  const paths = fixturePaths("sm-si-");
  let encryptCalls = 0;
  const safeStorage = fakeSafeStorage({
    encryptString(value) {
      encryptCalls += 1;
      return xorCipher(value);
    },
  });
  const service = createAgentService({
    paths,
    version: "mcp-integration",
    safeStorage,
  });
  await service.start();
  let oldSessionToken;
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  try {
    assert.equal(encryptCalls, 0);
    assert.equal(fs.existsSync(paths.mcpAuthPath), false);
    const clientToken = readClientToken(paths);
    assert.equal((await requestService(paths, {
      token: clientToken, version: PROTOCOL_VERSION, method: "service.status",
    })).healthy, true);
    const clientNonce = nonce(0x66);
    const challenge = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId,
        runtimeAccountId: runtimeAccountIdValue,
        clientNonce,
      },
    });
    assert.equal(encryptCalls, 1);
    assert.equal(fs.existsSync(paths.mcpAuthPath), true);
    const helperStore = new McpAuthSecretStore({
      paths, access: "helper", safeStorage,
    }).open();
    const longSecret = helperStore.readForHelper();
    assert.equal(challenge.runtimeProfileId, runtimeProfileId);
    assert.equal(challenge.runtimeAccountId, runtimeAccountIdValue);
    assert.equal(challenge.clientNonce, clientNonce);
    const exchanged = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.exchange",
      params: authRequest(challenge, longSecret),
    });
    longSecret.fill(0);
    helperStore.close();
    oldSessionToken = exchanged.token;
    assert.equal(exchanged.runtimeProfileId, runtimeProfileId);
    assert.equal(exchanged.runtimeAccountId, runtimeAccountIdValue);
    const profileResult = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.profile.get",
      params: { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue, sessionToken: exchanged.token },
    });
    assert.equal(profileResult.name, "Shoggoth");
    assert.equal(profileResult.runtimeProfileId, runtimeProfileId);
    assert.equal(Object.prototype.hasOwnProperty.call(profileResult, "providerRef"), false);
    await assert.rejects(
      requestService(paths, {
        version: PROTOCOL_VERSION,
        method: "mcp.profile.get",
        params: {
          runtimeProfileId,
          runtimeAccountId: "other-runtime-account",
          sessionToken: exchanged.token,
        },
      }),
      (error) => error.code === "MCP_SESSION_INVALID"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(exchanged.token),
    );
    await assert.rejects(
      requestService(paths, { version: PROTOCOL_VERSION, method: "service.status" }),
      (error) => error.code === "AUTH_FAILED",
    );
    assert.equal(readAllRegularFiles(paths.stateDir).includes(exchanged.token), false);
  } finally {
    await service.stop({ notify: false });
  }

  await service.start();
  try {
    await assert.rejects(
      requestService(paths, {
        version: PROTOCOL_VERSION,
        method: "mcp.profile.get",
        params: { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue, sessionToken: oldSessionToken },
      }),
      (error) => error.code === "MCP_SESSION_INVALID",
    );
  } finally {
    await service.stop({ notify: false });
  }
});

test("正式模式可在 Service 健康后异步预热 MCP，且不阻塞 start/status", async () => {
  const paths = fixturePaths("sm-prewarm-");
  let loads = 0;
  const broker = {
    open() {},
    close() {},
    async loadOrCreateForService() {
      loads += 1;
      return Buffer.alloc(32, 0x71);
    },
  };
  const service = createAgentService({
    paths,
    version: "mcp-prewarm",
    mcpCryptoBroker: broker,
    prewarmMcpAuth: true,
  });
  await service.start();
  try {
    assert.equal((await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "service.status",
      token: readClientToken(paths),
    })).healthy, true);
    const deadline = Date.now() + 1_000;
    while (loads === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(loads, 1);
  } finally {
    await service.stop({ notify: false });
  }
});

test("Service mcp.tool.call 只以短 session 授权 Profile 为 authority，并严格校验 envelope", async () => {
  const paths = fixturePaths("sm-tool-route-");
  const safeStorage = fakeSafeStorage();
  const calls = [];
  const mcpProductToolController = {
    async handle(name, args, authority) {
      calls.push(structuredClone({ name, args, authority }));
      return { accepted: true, profileId: authority.profileId };
    },
  };
  const service = createAgentService({
    paths,
    version: "mcp-tool-routing",
    safeStorage,
    mcpProductToolController,
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  try {
    const session = await authenticateServiceSession(
      paths, safeStorage, profileValue.runtimeProfileId, profileValue.runtimeAccountId, 0x67,
    );
    const callId = "11111111-1111-4111-8111-111111111111";
    const result = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.tool.call",
      params: {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        sessionToken: session.token,
        callId,
        name: "kanban_list",
        arguments: { limit: 10 },
      },
    });
    assert.deepEqual(result, { accepted: true, profileId: profileValue.id });
    assert.deepEqual(calls, [{
      name: "kanban_list",
      args: { limit: 10 },
      authority: { profileId: profileValue.id, callId },
    }]);

    for (const params of [
      {
        runtimeProfileId: profileValue.runtimeProfileId,
        sessionToken: session.token,
        callId: "00000000-0000-4000-8000-000000000000",
        name: "kanban_list",
        arguments: {},
      },
      {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        sessionToken: session.token,
        callId: "not-a-uuid",
        name: "kanban_list",
        arguments: {},
      },
      {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        sessionToken: session.token,
        callId: "22222222-2222-4222-8222-222222222222",
        name: "kanban_list",
        arguments: {},
        profileId: "attacker-profile",
      },
      {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        sessionToken: session.token,
        callId: "33333333-3333-4333-8333-333333333333",
        name: "kanban_list",
      },
    ]) {
      await assert.rejects(
        requestService(paths, {
          version: PROTOCOL_VERSION,
          method: "mcp.tool.call",
          params,
        }),
        (error) => error.code === "MCP_AUTH_REQUEST_INVALID"
          && error.message === "mcp_auth_request_invalid",
      );
    }
    assert.equal(calls.length, 1);

    await assert.rejects(
      requestService(paths, {
        version: PROTOCOL_VERSION,
        method: "mcp.tool.call",
        params: {
          runtimeProfileId: profileValue.runtimeProfileId,
          runtimeAccountId: "other-runtime-account",
          sessionToken: session.token,
          callId: "44444444-4444-4444-8444-444444444444",
          name: "kanban_list",
          arguments: {},
        },
      }),
      (error) => error.code === "MCP_SESSION_INVALID",
    );
    assert.equal(calls.length, 1);
  } finally {
    await service.stop({ notify: false });
  }
});

test("Service 外部联邦 MCP session 独立认证并把 OpenClaw/Hermes 身份传给工具层", async () => {
  const paths = fixturePaths("sm-federation-tool-route-");
  const calls = [];
  const service = createAgentService({
    paths,
    version: "mcp-federation-routing",
    safeStorage: fakeSafeStorage(),
    mcpProductToolController: {
      async handle(name, args, trusted) {
        calls.push(structuredClone({ name, args, trusted }));
        return { accepted: true, client: trusted.federationClient };
      },
    },
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  try {
    const credential = ensureFederationMcpCredential(paths);
    const open = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.federation.open",
      params: {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        credentialToken: credential.token,
        client: "openclaw",
      },
    });
    const hermes = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.federation.open",
      params: {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        credentialToken: credential.token,
        client: "hermes",
      },
    });
    assert.equal(open.protocolVersion, PROTOCOL_VERSION);
    assert.equal(hermes.protocolVersion, PROTOCOL_VERSION);
    assert.notEqual(open.token, hermes.token);
    assert.equal(fs.existsSync(paths.mcpAuthPath), false,
      "外部联邦认证不得触发原生 MCP Keychain 握手");
    for (const [session, client, unit] of [[open, "openclaw", "5"], [hermes, "hermes", "6"]]) {
      const result = await requestService(paths, {
        version: PROTOCOL_VERSION,
        method: "mcp.tool.call",
        params: {
          runtimeProfileId: profileValue.runtimeProfileId,
          runtimeAccountId: profileValue.runtimeAccountId,
          sessionToken: session.token,
          callId: `${unit.repeat(8)}-${unit.repeat(4)}-4${unit.repeat(3)}-8${unit.repeat(3)}-${unit.repeat(12)}`,
          name: "federation_agent_list",
          arguments: { backendId: null },
        },
      });
      assert.deepEqual(result, { accepted: true, client });
    }
    assert.deepEqual(calls.map((call) => call.trusted.federationClient), ["openclaw", "hermes"]);
  } finally {
    await service.stop({ notify: false });
  }
});

test("Service mcp.tool.call 固定映射工具错误，并拒绝 hostile/超限 Controller 响应", async () => {
  const paths = fixturePaths("sm-tool-boundary-");
  const safeStorage = fakeSafeStorage();
  let mode = "public-error";
  let getterCalls = 0;
  const service = createAgentService({
    paths,
    version: "mcp-tool-boundary",
    safeStorage,
    mcpProductToolController: {
      async handle() {
        if (mode === "public-error") {
          throw Object.assign(new Error("fixture-secret-canary raw tool error"), {
            code: "MCP_TOOL_STATE_CONFLICT",
          });
        }
        if (mode === "hostile-error") {
          const error = {};
          Object.defineProperty(error, "code", {
            get() { getterCalls += 1; throw new Error("fixture-secret-canary getter"); },
          });
          throw error;
        }
        if (mode === "hostile-result") {
          const result = {};
          Object.defineProperty(result, "secret", {
            enumerable: true,
            get() { getterCalls += 1; return "fixture-secret-canary"; },
          });
          return result;
        }
        return { body: "x".repeat(64 * 1024) };
      },
    },
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  try {
    const session = await authenticateServiceSession(
      paths, safeStorage, runtimeProfileId, runtimeAccountIdValue, 0x68,
    );
    let index = 0;
    const invoke = () => requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.tool.call",
      params: {
        runtimeProfileId,
        runtimeAccountId: runtimeAccountIdValue,
        sessionToken: session.token,
        callId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++index).padStart(12, "0")}`,
        name: "profile_get",
        arguments: {},
      },
    });
    await assert.rejects(invoke(), (error) => error.code === "MCP_TOOL_STATE_CONFLICT"
      && error.message === "当前状态不允许该工具操作"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("fixture-secret-canary"));
    mode = "hostile-error";
    await assert.rejects(invoke(), (error) => error.code === "MCP_AUTH_FAILED"
      && error.message === "mcp_auth_failed");
    assert.equal(getterCalls, 0);
    mode = "hostile-result";
    await assert.rejects(invoke(), (error) => error.code === "MCP_TOOL_RESPONSE_INVALID");
    assert.equal(getterCalls, 0);
    mode = "oversized";
    await assert.rejects(invoke(), (error) => error.code === "MCP_TOOL_RESPONSE_TOO_LARGE");
  } finally {
    await service.stop({ notify: false });
  }
});

test("默认 MCP Product Controller 每代重建，迟到 fatal 被 fence 且 active fatal 先回错再 once stop", async () => {
  const paths = fixturePaths("sm-tool-generation-");
  const safeStorage = fakeSafeStorage();
  const runtimeFailure = deferred();
  const runtimeErrors = [];
  const service = createAgentService({
    paths,
    version: "mcp-tool-generation",
    safeStorage,
    onRuntimeError(error, cleanupError) {
      runtimeErrors.push({ error, cleanupError });
      runtimeFailure.resolve();
    },
  });
  await service.start();
  const oldController = service.mcpProductToolController;
  const profileValue = service.productStore.listAgentProfiles()[0];
  await service.stop({ notify: false });
  await service.start();
  const activeController = service.mcpProductToolController;
  assert.notEqual(activeController, oldController);

  const originalLookup = service.productStore.lookupMcpToolCall.bind(service.productStore);
  service.productStore.lookupMcpToolCall = () => {
    throw Object.assign(new Error("fixture-secret-canary late fatal"), {
      code: "STORE_COMMIT_UNCERTAIN",
    });
  };
  await assert.rejects(
    oldController.handle("profile_get", {}, {
      profileId: profileValue.id,
      callId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
    (error) => error.code === "MCP_TOOL_COMMIT_UNCERTAIN",
  );
  service.productStore.lookupMcpToolCall = originalLookup;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeErrors.length, 0, "旧代 Controller fatal 不得停止新代 Service");
  assert.equal(fs.existsSync(paths.socketPath), true);

  const session = await authenticateServiceSession(
    paths, safeStorage, profileValue.runtimeProfileId, profileValue.runtimeAccountId, 0x69,
  );
  service.productStore.lookupMcpToolCall = () => {
    throw Object.assign(new Error("fixture-secret-canary active fatal"), {
      code: "STORE_COMMIT_UNCERTAIN",
    });
  };
  await assert.rejects(
    requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.tool.call",
      params: {
        runtimeProfileId: profileValue.runtimeProfileId,
        runtimeAccountId: profileValue.runtimeAccountId,
        sessionToken: session.token,
        callId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "profile_get",
        arguments: {},
      },
    }),
    (error) => error.code === "MCP_TOOL_COMMIT_UNCERTAIN"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("fixture-secret-canary"),
  );
  service.productStore.lookupMcpToolCall = originalLookup;
  await runtimeFailure.promise;
  assert.equal(runtimeErrors.length, 1);
  assert.equal(runtimeErrors[0].error.code, "MCP_TOOL_COMMIT_UNCERTAIN");
  assert.equal(runtimeErrors[0].cleanupError, null);
  assert.equal(fs.existsSync(paths.socketPath), false);

  await service.start();
  assert.notEqual(service.mcpProductToolController, activeController);
  await service.stop({ notify: false });

  const explicit = { async handle() { return {}; } };
  const explicitService = createAgentService({
    paths: fixturePaths("sm-tool-explicit-"),
    version: "mcp-tool-explicit",
    safeStorage,
    mcpProductToolController: explicit,
  });
  await explicitService.start();
  assert.equal(explicitService.mcpProductToolController, explicit);
  await explicitService.stop({ notify: false });
  await explicitService.start();
  assert.equal(explicitService.mcpProductToolController, explicit);
  await explicitService.stop({ notify: false });
});

test("默认 MCP Product Controller 装配 Service 状态、Token 用量与 Federation 依赖", async () => {
  // Darwin 的 unix socket 路径上限很短，测试前缀必须保持紧凑。
  const paths = fixturePaths("sm-deps-");
  const federationCalls = [];
  const expectedBackends = [
    { id: "openclaw", connected: false, disabled: true, health: "disabled" },
    { id: "hermes", connected: false, disabled: true, health: "disabled" },
  ];
  const service = createAgentService({
    paths,
    version: "mcp-tool-default-dependencies",
    safeStorage: fakeSafeStorage(),
    federationHostClient: {
      async request(method, params) {
        federationCalls.push([method, structuredClone(params)]);
        if (method === "backend.status") {
          assert.deepEqual(params, {});
          return { backends: structuredClone(expectedBackends) };
        }
        assert.equal(method, "cron.list");
        assert.deepEqual(params, { backendId: "openclaw", enabled: null, limit: 10 });
        return { backendId: "openclaw", total: 0, jobs: [] };
      },
    },
  });
  await service.start();
  try {
    const profileValue = service.productStore.listAgentProfiles()[0];
    const authority = (callId) => ({ profileId: profileValue.id, callId });
    const appStatus = await service.mcpProductToolController.handle(
      "app_status", {}, authority("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1"),
    );
    assert.equal(appStatus.service.healthy, true);
    assert.equal(appStatus.service.serviceVersion, "mcp-tool-default-dependencies");
    assert.equal(Number.isSafeInteger(appStatus.service.startedAt), true);
    assert.deepEqual(appStatus.service.domainAvailability, {
      kanban: { available: true, reason: null },
      cron: { available: true, reason: null },
    });

    const usage = await service.mcpProductToolController.handle(
      "usage_get", { range: "7d" }, authority("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2"),
    );
    assert.equal(usage.range, "7d");
    assert.equal(usage.usage.series.totals.totalTokens, 0);

    await assert.rejects(() => service.mcpProductToolController.handle(
      "runtime_context_get", { runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5" },
      authority("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6"),
    ), (error) => error.code === "MCP_TOOL_NOT_FOUND",
    "默认 Service composition root 必须真实接入 Coordinator，而不是返回 unavailable stub");

    assert.deepEqual(await service.mcpProductToolController.handle(
      "backend_status", {}, authority("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3"),
    ), { backends: expectedBackends });
    assert.deepEqual(await service.mcpProductToolController.handle(
      "external_cron_list", { backendId: "openclaw", enabled: null, limit: 10 },
      authority("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4"),
    ), { backendId: "openclaw", total: 0, jobs: [] });
    assert.deepEqual(federationCalls, [
      ["backend.status", {}],
      ["cron.list", { backendId: "openclaw", enabled: null, limit: 10 }],
    ]);
  } finally {
    await service.stop({ notify: false });
  }
});

test("完整 MCP helper 经认证 Service 操作灵感，确认删除并保留正常读写权限边界", async () => {
  const paths = fixturePaths("sm-idea-");
  const safeStorage = fakeSafeStorage();
  const service = createAgentService({ paths, safeStorage, version: "mcp-inspiration" });
  await service.start();
  let handler;
  try {
    const profile = service.productStore.listAgentProfiles()[0];
    const session = await authenticateServiceSession(paths, safeStorage, profile.runtimeProfileId, profile.runtimeAccountId);
    handler = createMcpStdioHandler({ paths, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, sessionToken: session.token, requestService });
    await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: { elicitation: {} },
      clientInfo: { name: "inspiration-integration", version: "1" },
    } });
    const tools = await listAllTools(handler, 2);
    assert.equal(tools.filter(tool => tool.name.startsWith("inspiration_")).length, 10);
    let sequence = 3;
    const call = (name, args, context) => handler({ jsonrpc: "2.0", id: sequence++, method: "tools/call",
      params: { name: `inspiration_${name}`, arguments: args } }, context);
    const created = await call("create", { body: "通过完整 MCP 链路保存的灵感" });
    assert.equal(created.result.isError, false, JSON.stringify(created));
    const idea = created.result.structuredContent.idea;
    assert.equal(service.inspirationStore.get(idea.id).body, "通过完整 MCP 链路保存的灵感");
    const edited = await call("update", { id: idea.id, expectedRevision: idea.revision, patch: { favorite: true } });
    assert.equal(edited.result.isError, false);
    const listed = await call("list", { query: "完整 MCP", filter: "favorite", cursor: null, limit: 10 });
    assert.equal(listed.result.structuredContent.total, 1);
    const deleted = await call("delete", { id: idea.id, expectedRevision: edited.result.structuredContent.idea.revision }, {
      async requestClient(method, params) {
        assert.equal(method, "elicitation/create"); assert.ok(params.message.includes(idea.id));
        return { action: "accept", content: { confirm_product_action: "确认执行" } };
      },
    });
    assert.equal(deleted.result.isError, false, JSON.stringify(deleted));
    assert.equal(service.inspirationStore.get(idea.id), null);
  } finally {
    handler?.close();
    await service.stop({ notify: false });
  }
});

test("Electron ready 后注入原生 Notification sender，公开 payload 不携带 Profile/Run 私有字段", async () => {
  const { EventEmitter } = require("node:events");
  const paths = fixturePaths("sm-native-notification-");
  let ready = false;
  const shown = [];
  class FakeNotification {
    static isSupported() { assert.equal(ready, true); return true; }
    constructor(options) { shown.push({ phase: "construct", options: structuredClone(options) }); }
    show() { shown.push({ phase: "show" }); }
  }
  const electronApp = {
    isPackaged: false,
    setPath() {},
    async whenReady() { ready = true; },
    quit() {},
  };
  const service = await startAgentServiceProcess({
    paths,
    electronApp,
    Notification: FakeNotification,
    safeStorage: fakeSafeStorage(),
    version: "mcp-native-notification",
    signalEmitter: new EventEmitter(),
  });
  try {
    const profileValue = service.productStore.listAgentProfiles()[0];
    service.workDispatcher.enqueue({
      id: "run-notification",
      source: "chat",
      sourceId: "chat-notification",
      idempotencyKey: "notify-idempotency",
      profileId: profileValue.id,
      workspace: null,
    });
    const result = await service.mcpProductToolController.handle(
      "notification_send",
      { runId: "run-notification", title: "Title", body: "Body" },
      { profileId: profileValue.id, callId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    );
    assert.deepEqual(result, { delivered: true });
    assert.deepEqual(shown, [
      { phase: "construct", options: { title: "Title", body: "Body" } },
      { phase: "show" },
    ]);
  } finally {
    await service.stop({ notify: false });
  }
});

test("并发 challenge 共享同代 MCP auth singleflight，只创建一次长期 secret", async () => {
  const paths = fixturePaths("sm-cf-");
  const loadEntered = deferred();
  const releaseLoad = deferred();
  let loadCalls = 0;
  const store = {
    open() { return this; },
    close() {},
    loadOrCreateForService() {
      loadCalls += 1;
      loadEntered.resolve();
      return releaseLoad.promise;
    },
  };
  const service = createAgentService({
    paths,
    version: "mcp-singleflight",
    mcpAuthSecretStore: store,
    mcpAuthInitTimeoutMs: 500,
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  const requestChallenge = (byte) => requestService(paths, {
    version: PROTOCOL_VERSION,
    method: "mcp.auth.challenge",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId: runtimeAccountIdValue,
      clientNonce: nonce(byte),
    },
  });
  const first = requestChallenge(0x31);
  const second = requestChallenge(0x32);
  try {
    await loadEntered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loadCalls, 1);
    releaseLoad.resolve(Buffer.alloc(32, 0x33));
    const [left, right] = await Promise.all([first, second]);
    assert.notEqual(left.challengeId, right.challengeId);
    assert.equal(loadCalls, 1);
  } finally {
    releaseLoad.resolve(Buffer.alloc(32, 0x33));
    await Promise.allSettled([first, second]);
    await service.stop({ notify: false });
  }
});

test("默认 MCP auth deadline 覆盖 packaged safeStorage 冷启动且不误判 unavailable", async () => {
  const paths = fixturePaths("sm-cold-auth-");
  const service = createAgentService({
    paths,
    version: "mcp-cold-auth",
    mcpAuthSecretStore: {
      open() { return this; },
      close() {},
      async loadOrCreateForService() {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return Buffer.alloc(32, 0x39);
      },
    },
  });
  await service.start();
  try {
    const profileValue = service.productStore.listAgentProfiles()[0];
    const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
    const challenge = await requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId,
        runtimeAccountId: runtimeAccountIdValue,
        clientNonce: nonce(0x38),
      },
    }, { timeoutMs: 5_000 });
    assert.equal(challenge.runtimeProfileId, runtimeProfileId);
  } finally {
    await service.stop({ notify: false });
  }
});

test("挂起的 MCP auth 初始化有界失败且不阻塞普通 Service IPC", async () => {
  const paths = fixturePaths("sm-bd-");
  const loadEntered = deferred();
  const never = deferred();
  const service = createAgentService({
    paths,
    version: "mcp-bounded",
    mcpAuthInitTimeoutMs: 40,
    mcpAuthSecretStore: {
      open() { return this; },
      close() {},
      loadOrCreateForService() {
        loadEntered.resolve();
        return never.promise;
      },
    },
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  const challenge = requestService(paths, {
    version: PROTOCOL_VERSION,
    method: "mcp.auth.challenge",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId: runtimeAccountIdValue,
      clientNonce: nonce(0x34),
    },
  });
  try {
    await loadEntered.promise;
    const status = await requestService(paths, {
      token: readClientToken(paths), version: PROTOCOL_VERSION, method: "service.status",
    });
    assert.equal(status.healthy, true);
    await assert.rejects(
      challenge,
      (error) => error.code === "SERVICE_UNAVAILABLE" && error.message === "mcp_auth_unavailable",
    );
  } finally {
    await Promise.allSettled([challenge]);
    await service.stop({ notify: false });
  }
});

test("MCP auth 失败在当前 Service generation 内锁存，后续请求不重复唤起钥匙串", async () => {
  const paths = fixturePaths("sm-auth-latched-");
  let loadCalls = 0;
  const service = createAgentService({
    paths,
    version: "mcp-auth-latched",
    mcpAuthSecretStore: {
      open() { return this; },
      close() {},
      async loadOrCreateForService() {
        loadCalls += 1;
        throw new Error("keychain unavailable");
      },
    },
  });
  await service.start();
  try {
    const profileValue = service.productStore.listAgentProfiles()[0];
    const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
    const requestChallenge = (byte) => requestService(paths, {
      version: PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId,
        runtimeAccountId: runtimeAccountIdValue,
        clientNonce: nonce(byte),
      },
    });
    await assert.rejects(requestChallenge(0x3a), (error) => error.message === "mcp_auth_failed");
    await assert.rejects(
      requestChallenge(0x3b),
      (error) => error.code === "SERVICE_UNAVAILABLE" && error.message === "mcp_auth_unavailable",
    );
    assert.equal(loadCalls, 1);
  } finally {
    await service.stop({ notify: false });
  }
});

test("stop 会 fence 挂起的 MCP auth 初始化，迟到 secret 清零且不得发布 manager", async () => {
  const paths = fixturePaths("sm-st-");
  const loadEntered = deferred();
  const releaseLoad = deferred();
  const secret = Buffer.alloc(32, 0x35);
  let managerFactoryCalls = 0;
  const service = createAgentService({
    paths,
    version: "mcp-stop-race",
    mcpAuthInitTimeoutMs: 500,
    mcpAuthSecretStore: {
      open() { return this; },
      close() {},
      loadOrCreateForService() {
        loadEntered.resolve();
        return releaseLoad.promise;
      },
    },
    mcpSessionManagerFactory() {
      managerFactoryCalls += 1;
      return {
        issueChallenge: () => ({ unexpected: true }),
        exchangeChallenge: () => ({ unexpected: true }),
        authorizeSession: () => ({ unexpected: true }),
        close() {},
      };
    },
  });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  const challenge = requestService(paths, {
    version: PROTOCOL_VERSION,
    method: "mcp.auth.challenge",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      runtimeProfileId,
      runtimeAccountId: runtimeAccountIdValue,
      clientNonce: nonce(0x36),
    },
  });
  // stop 会等待已进入 handler 的响应完成；立即登记 rejection observer，避免测试把
  // 合法的停机拒绝误判成进程级 unhandled rejection。
  const challengeSettled = Promise.allSettled([challenge]);
  await loadEntered.promise;
  const stopping = service.stop({ notify: false });
  await stopping;
  releaseLoad.resolve(secret);
  await challengeSettled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(managerFactoryCalls, 0);
  assert.equal(secret.equals(Buffer.alloc(32)), true);
});

test("safeStorage locked 只降级 MCP auth，现有 Service client IPC 继续健康", async () => {
  const paths = fixturePaths("sm-sl-");
  const service = createAgentService({
    paths,
    version: "mcp-locked",
    safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
  });
  await service.start();
  try {
    const profileValue = service.productStore.listAgentProfiles()[0];
    const token = readClientToken(paths);
    assert.equal((await requestService(paths, {
      token, version: PROTOCOL_VERSION, method: "service.status",
    })).healthy, true);
    await assert.rejects(
      requestService(paths, {
        version: PROTOCOL_VERSION,
        method: "mcp.auth.challenge",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          runtimeProfileId: profileValue.runtimeProfileId,
          runtimeAccountId: profileValue.runtimeAccountId,
          clientNonce: nonce(0x67),
        },
      }),
      (error) => error.code === "SERVICE_UNAVAILABLE" && error.message === "mcp_auth_unavailable",
    );
  } finally {
    await service.stop({ notify: false });
  }
});

test("helper challenge 客户端校验 Service 绑定并且只把短 token 留在返回值", async () => {
  const paths = fixturePaths("shoggoth-mcp-helper-auth-");
  const safeStorage = fakeSafeStorage();
  const serviceSecretStore = new McpAuthSecretStore({
    paths, access: "service", safeStorage, randomBytes: fixedRandomBytes(0x68),
  }).open();
  serviceSecretStore.loadOrCreateForService().fill(0);
  serviceSecretStore.close();
  const calls = [];
  const requestOptions = [];
  const fakeRequest = async (_paths, request, options) => {
    calls.push(structuredClone(request));
    requestOptions.push(structuredClone(options));
    if (request.method === "mcp.auth.challenge") {
      const manager = new McpSessionManager({
        handshakeSecret: new McpAuthSecretStore({
          paths, access: "helper", safeStorage,
        }).open().readForHelper(),
        profileStore: profileStore([profile("profile-a", "runtime-a")]),
        protocolVersion: PROTOCOL_VERSION,
        randomBytes: fixedRandomBytes(0x69),
      });
      fakeRequest.manager = manager;
      return manager.issueChallenge(request.params);
    }
    return fakeRequest.manager.exchangeChallenge(request.params);
  };
  const session = await authenticateMcpSession({
    paths,
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    safeStorage,
    requestService: fakeRequest,
    randomBytes: () => Buffer.alloc(32, 0x6a),
  });
  assert.equal(session.runtimeProfileId, "runtime-a");
  assert.equal(session.runtimeAccountId, runtimeAccountId("runtime-a"));
  assert.equal(calls.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], "token"), false);
  assert.equal(JSON.stringify(calls).includes(session.token), false);
  assert.equal(requestOptions.length, 2);
  assert.equal(requestOptions.every((value) => value.timeoutMs === 10_000), true);
  fakeRequest.manager.close();

  await assert.rejects(
    authenticateMcpSession({
      paths,
      runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
      safeStorage,
      randomBytes: () => Buffer.alloc(32, 0x6b),
      requestService: async (_ignored, request) => ({
        challengeId: nonce(0x6c).slice(0, 22),
        protocolVersion: PROTOCOL_VERSION,
        runtimeProfileId: "runtime-other",
        runtimeAccountId: runtimeAccountId("runtime-a"),
        clientNonce: request.params.clientNonce,
        serverNonce: nonce(0x6d),
        expiresAt: Date.now() + 10_000,
      }),
    }),
    (error) => error.code === "MCP_HELPER_AUTH_FAILED" && error.message === "mcp_helper_auth_failed",
  );
});

test("MCP stdio 提供初始化、ping、固定产品工具与受控 request_user_input", async () => {
  const calls = [];
  const requestOptions = [];
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: nonce(0x70),
    serviceVersion: "0.0.test",
    requestService: async (_paths, request, options) => {
      calls.push(structuredClone(request));
      requestOptions.push(structuredClone(options));
      return {
        id: "profile-a",
        agentId: "shoggoth-profile-a",
        name: "Shoggoth",
        runtimeProfileId: "runtime-a",
        runtimeAccountId: runtimeAccountId("runtime-a"),
        defaultModel: null,
        defaultCwd: null,
        permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
        concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
        isDefault: true,
        enabled: true,
      };
    },
    paths: fixturePaths("shoggoth-mcp-handler-"),
    randomUUID: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });
  const beforeInit = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(beforeInit.error.code, -32002);
  const initialized = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: { sampling: {}, elicitation: {} },
      clientInfo: { name: "fixture", version: "1" },
      _meta: { progressToken: "hermes-compatible" } },
  });
  assert.equal(initialized.result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await handler({ jsonrpc: "2.0", id: 3, method: "ping" })).result, {});
  const listed = await listAllTools(handler, 4);
  assert.deepEqual(listed.map((tool) => tool.name), MCP_PRODUCT_TOOL_NAMES);
  const called = await handler({
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "profile_get", arguments: {} },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.name, "Shoggoth");
  assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);
  assert.equal(calls[0].method, "mcp.tool.call");
  assert.equal(calls[0].params.runtimeProfileId, "runtime-a");
  assert.equal(calls[0].params.runtimeAccountId, runtimeAccountId("runtime-a"));
  assert.equal(typeof calls[0].params.sessionToken, "string");
  assert.equal(calls[0].params.callId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(calls[0].params.name, "profile_get");
  assert.deepEqual(calls[0].params.arguments, {});
  assert.deepEqual(requestOptions, [{ timeoutMs: 45_000 }]);
  assert.equal(JSON.stringify(called).includes(calls[0].params.sessionToken), false);
  const unknown = await handler({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "unknown", arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test("MCP helper 将 12 个远程工具 exact 路由到 Service，非法 authority args 零调用", async () => {
  const calls = [];
  let uuidIndex = 0;
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: nonce(0x72),
    serviceVersion: "0.0.test",
    paths: fixturePaths("shoggoth-mcp-routes-"),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, "0")}`,
    requestService: async (_paths, request) => {
      calls.push(structuredClone(request));
      return { tool: request.params.name };
    },
  });
  await handler({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "fixture", version: "1" } },
  });
  const entityId = "11111111-1111-4111-8111-111111111111";
  const cases = [
    ["profile_get", {}],
    ["kanban_list", { kind: "boards", boardId: null, status: null, cursor: null, limit: 10 }],
    ["kanban_get", { cardId: entityId, cursor: null, maxBytes: 1024 }],
    ["kanban_update_progress", { cardId: entityId, runId: "run-1", message: "half", percent: 50 }],
    ["kanban_add_comment", { cardId: entityId, body: "comment" }],
    ["kanban_request_complete", { cardId: entityId }],
    ["cron_list", { enabled: null, cursor: null, limit: 10 }],
    ["cron_get", { jobId: entityId, cursor: null, maxBytes: 1024 }],
    ["run_get", { runId: "run-1" }],
    ["run_add_note", { runId: "run-1", body: "note" }],
    ["artifact_publish", { runId: "run-1", relativePath: "result.txt", name: "Result",
      kind: "file", mimeType: "text/plain" }],
    ["notification_send", { runId: "run-1", title: "Done", body: "Finished" }],
  ];
  for (const [index, [name, args]] of cases.entries()) {
    const response = await handler({
      jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name, arguments: args },
    });
    assert.equal(response.result.isError, false);
    assert.deepEqual(response.result.structuredContent, { tool: name });
    assert.deepEqual(JSON.parse(response.result.content[0].text), { tool: name });
  }
  assert.equal(calls.length, cases.length);
  for (const [index, request] of calls.entries()) {
    assert.equal(request.method, "mcp.tool.call");
    assert.deepEqual(request.params.arguments, cases[index][1]);
    assert.equal(request.params.name, cases[index][0]);
    assert.equal(request.params.runtimeProfileId, "runtime-a");
    assert.equal(request.params.runtimeAccountId, runtimeAccountId("runtime-a"));
    assert.equal(request.params.callId,
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    assert.equal(Object.hasOwn(request.params.arguments, "profileId"), false);
    assert.equal(Object.hasOwn(request.params.arguments, "createdAt"), false);
    assert.equal(Object.hasOwn(request.params.arguments, "operationId"), false);
  }
  const before = calls.length;
  const invalid = await handler({
    jsonrpc: "2.0", id: 99, method: "tools/call",
    params: { name: "run_get", arguments: { runId: "run-1", profileId: "attacker" } },
  });
  assert.equal(invalid.error.code, -32602);
  assert.equal(calls.length, before);
});

test("MCP helper 在重复结构化结果超过帧预算时保留完整文本结果", async () => {
  const payload = { content: "x".repeat(40 * 1024), sessionId: "browser-session-1" };
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: nonce(0x76),
    serviceVersion: "0.0.test",
    paths: fixturePaths("shoggoth-mcp-text-fallback-"),
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestService: async () => payload,
  });
  await handler({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "fixture", version: "1" } },
  });
  const response = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "profile_get", arguments: {} },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), payload);
  assert.equal(Object.hasOwn(response.result, "structuredContent"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= MCP_MAX_FRAME_BYTES);
});

test("MCP helper session 失效重认证时复用同一 callId，hostile error code getter 不执行", async () => {
  const calls = [];
  let getterCalls = 0;
  const nextToken = nonce(0x74);
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: nonce(0x73),
    sessionExpiresAt: Number.MAX_SAFE_INTEGER,
    serviceVersion: "0.0.test",
    paths: fixturePaths("shoggoth-mcp-refresh-call-"),
    randomUUID: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    refreshSession: async () => ({
      token: nextToken,
      protocolVersion: PROTOCOL_VERSION,
      runtimeProfileId: "runtime-a",
      runtimeAccountId: runtimeAccountId("runtime-a"),
      profileId: "profile-a",
      expiresAt: Date.now() + 60_000,
    }),
    requestService: async (_paths, request) => {
      calls.push(structuredClone(request));
      if (calls.length === 1) {
        throw Object.assign(new Error("expired"), { code: "MCP_SESSION_INVALID" });
      }
      return { run: { id: "run-1" } };
    },
  });
  await handler({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "fixture", version: "1" } },
  });
  const response = await handler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "run_get", arguments: { runId: "run-1" } },
  });
  assert.equal(response.result.isError, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.callId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  assert.equal(calls[1].params.callId, calls[0].params.callId);
  assert.notEqual(calls[1].params.sessionToken, calls[0].params.sessionToken);

  const hostile = {};
  Object.defineProperty(hostile, "code", {
    get() { getterCalls += 1; throw new Error("fixture-secret-canary getter"); },
  });
  const hostileHandler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: nonce(0x75),
    serviceVersion: "0.0.test",
    paths: fixturePaths("shoggoth-mcp-hostile-code-"),
    randomUUID: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
    refreshSession: async () => assert.fail("hostile code 不得触发 refresh"),
    requestService: async () => { throw hostile; },
  });
  await hostileHandler({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "fixture", version: "1" } },
  });
  const failure = await hostileHandler({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "profile_get", arguments: {} },
  });
  assert.equal(failure.result.isError, true);
  assert.equal(getterCalls, 0);
});

test("MCP stdio JSONL 有界串行处理，多帧响应不把 session token 写到 stdout", async () => {
  const token = nonce(0x71);
  const handler = createMcpStdioHandler({
    runtimeProfileId: "runtime-a",
    runtimeAccountId: runtimeAccountId("runtime-a"),
    sessionToken: token,
    serviceVersion: "0.0.test",
    paths: fixturePaths("shoggoth-mcp-stdio-"),
    requestService: async () => ({ name: "Shoggoth", runtimeProfileId: "runtime-a" }),
  });
  const input = Readable.from([
    "{broken\n",
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1.0.0" },
    } })}\n`,
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  ]);
  const output = memoryOutput();
  await runMcpStdioSession({ input, output: output.stream, handler });
  const responses = output.read().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 1);
  assert.equal(responses[2].id, 2);
  assert.ok(responses[2].result.tools.length > 0);
  assert.equal(typeof responses[2].result.nextCursor, "string");
  assert.equal(output.read().includes(token), false);
});

test("完整 helper 入口通过 Service 握手后服务 stdio，EOF 清理且不创建 BrowserWindow", async () => {
  const paths = fixturePaths("sm-he-");
  const safeStorage = fakeSafeStorage();
  const service = createAgentService({ paths, version: "helper-entry", safeStorage });
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId: runtimeAccountIdValue } = profileValue;
  const output = memoryOutput();
  const electronCalls = [];
  try {
    await startShoggothMcpHelper({
      paths,
      runtimeProfileId,
      runtimeAccountId: runtimeAccountIdValue,
      safeStorage,
      input: Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "fixture", version: "1.0.0" },
        } })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "profile_get", arguments: {} } })}\n`,
      ]),
      output: output.stream,
      platform: "darwin",
      electronApp: {
        setActivationPolicy: (policy) => { electronCalls.push(["activation", policy]); },
        dock: { hide: () => { electronCalls.push("dock-hide"); } },
        whenReady: async () => { electronCalls.push("ready"); },
        quit: () => { electronCalls.push("quit"); },
      },
    });
    const responses = output.read().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "shoggoth");
    assert.equal(responses[1].result.structuredContent.name, "Shoggoth");
    assert.deepEqual(electronCalls, [
      ["activation", "prohibited"], "ready", "dock-hide", ["activation", "prohibited"], "quit",
    ]);
  } finally {
    await service.stop({ notify: false });
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
  else console.log(`PASS shoggoth MCP auth/session unit (${tests.length})`);
})();
