#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { McpAuthSecretStore } = require("../app/agent-service/mcp-auth-secret-store");
const { PackagedMcpCryptoBroker } = require("../app/agent-service/packaged-mcp-crypto-broker");
const { McpCryptoBroker } = require("../app/agent-service/mcp-crypto-broker");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const {
  createLocalFileSafeStorage, isLocalFileCiphertext, localCryptoKeyPath,
} = require("../app/agent-service/local-file-safe-storage");
const {
  decodeWorkerResponse, encodeWorkerRequest, encodeWorkerResponse, validateWorkerRequest,
} = require("../app/agent-service/mcp-crypto-protocol");
const {
  performWorkerOperation, SHOGGOTH_AGENT_SERVICE_NAME, startMcpCryptoWorker,
} = require("../app/mcp-crypto-worker");

const tests = [];
const GENERATION = 3;
const OPERATION = "service.rewrapLegacyMcpAuth";
const APP = "/Applications/Shoggoth.app";
const EXECUTABLE = `${APP}/Contents/MacOS/Shoggoth`;
const RESOURCES = `${APP}/Contents/Resources`;
const APP_ROOT = `${RESOURCES}/app.asar`;
const CANARY = "legacy-rewrap-error-canary";
const ROOT_HASH = "ddb8a6fee24f4bd865bab191d92c44062f213137";
const localIdentity = () => ({
  localSigned: true, teamIdentifier: null, identifier: "ai.shoggoth.desktop",
  certificateRootHash: ROOT_HASH,
  designatedRequirement: `identifier "ai.shoggoth.desktop" and certificate root = H"${ROOT_HASH}"`,
});
const adHocIdentity = () => ({
  adHoc: true, teamIdentifier: null, identifier: "ai.shoggoth.desktop",
  cdHash: "7076af64a5ba86c476dadac67886bda36e1228f0",
  designatedRequirement: 'cdhash H"7076af64a5ba86c476dadac67886bda36e1228f0"',
});
const developerIdentity = () => ({
  teamIdentifier: "SHOGGOTH01",
  designatedRequirement: "identifier ai.shoggoth.desktop and anchor apple generic",
});

function test(name, fn) { tests.push({ name, fn }); }
function fixedError(error) {
  return error?.code === "MCP_CRYPTO_UNAVAILABLE"
    && error?.message === "mcp_crypto_unavailable"
    && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(CANARY);
}
function gate(callerRole = "agent-service") {
  return {
    version: 1, parentPid: process.pid, generation: GENERATION,
    nonce: Buffer.alloc(32, 7).toString("base64url"), callerRole,
    parentExecutable: EXECUTABLE, appRoot: APP_ROOT,
  };
}
function request(paths, patch = {}) {
  return {
    version: 1, generation: GENERATION, operation: OPERATION,
    paths: Object.fromEntries([
      "trustedRoot", "stateDir", "mcpAuthPath", "profileDir", "cacheDir",
    ].map((name) => [name, paths[name]])),
    payloadBytes: 0, ...patch,
  };
}

// This is a test-only v10 envelope. No Electron process or real Keychain is used.
function legacyStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from("v10"), nonce, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      assert.equal(value.subarray(0, 3).toString(), "v10");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(3, 15));
      decipher.setAuthTag(value.subarray(15, 31));
      return Buffer.concat([decipher.update(value.subarray(31)), decipher.final()]).toString("utf8");
    },
    close() { key.fill(0); },
  };
}

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(target));
    else files.push(target);
  }
  return files.sort();
}
function snapshot(root) {
  return filesUnder(root).map((target) => ({
    name: path.relative(root, target), mode: fs.statSync(target).mode & 0o777,
    hash: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
  }));
}
function writeCiphertext(paths, ciphertext) {
  fs.writeFileSync(paths.mcpAuthPath, `${JSON.stringify({
    version: 1, ciphertext: ciphertext.toString("base64"),
  })}\n`, { mode: 0o600 });
}
function readCiphertext(paths) {
  return Buffer.from(JSON.parse(fs.readFileSync(paths.mcpAuthPath, "utf8")).ciphertext, "base64");
}
function fsWithSyncHook(onSync) {
  const descriptors = new Map();
  return {
    ...fs,
    openSync(target, ...args) {
      const fd = fs.openSync(target, ...args);
      descriptors.set(fd, target);
      return fd;
    },
    closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
    fsyncSync(fd) { onSync(descriptors.get(fd)); return fs.fsyncSync(fd); },
  };
}
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smcw-legacy-rewrap-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c"),
  });
  const legacy = legacyStorage();
  const brokers = [];
  let secret;
  try {
    createLocalFileSafeStorage({ paths }).close();
    const store = new McpAuthSecretStore({ paths, access: "service", safeStorage: legacy }).open();
    try { secret = store.loadOrCreateForService(); } finally { store.close(); }
    await fn({ root, paths, legacy, secret, brokers });
  } finally {
    for (const broker of brokers) await broker.close();
    secret?.fill(0);
    legacy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function worker(f, overrides = {}) {
  const workerGate = overrides.gate || gate();
  const workerRequest = overrides.request || request(f.paths);
  const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
  let frame;
  try {
    frame = await performWorkerOperation({
      gate: workerGate, request: workerRequest, safeStorage: f.legacy,
      localSafeStorage: local, ...overrides,
    });
    return decodeWorkerResponse(frame, workerGate, {
      expectedPayloadBytes: 0, maxPayloadBytes: 4096,
    });
  } finally {
    frame?.fill(0);
    local.close();
  }
}

function selector(f, patch = {}) {
  const calls = { factories: 0, opens: 0, rewraps: 0, closes: 0 };
  const broker = new PackagedMcpCryptoBroker({
    paths: f.paths, callerRole: patch.callerRole || "agent-service", fs: patch.fs,
    executablePath: EXECUTABLE, appRoot: APP_ROOT, resourcesPath: RESOURCES,
    applicationsRoot: "/Applications", defaultApp: false, parentEnv: { LANG: "C" },
    assertStableAppPaths() {},
    readCodeIdentityAsync: async () => (patch.identity || localIdentity)(),
    createLocalFileSafeStorage,
    createExternalBroker(options) {
      calls.factories += 1;
      assert.equal(options.callerRole, "agent-service");
      return {
        open({ generation }) { assert.equal(generation, GENERATION); calls.opens += 1; return this; },
        async close() { calls.closes += 1; },
        async rewrapLegacyMcpAuth({ generation }) {
          assert.equal(generation, GENERATION);
          calls.rewraps += 1;
          return patch.rewrap ? patch.rewrap(f, () => worker(f)) : worker(f);
        },
        loadOrCreateForService() { throw new Error("migration must not create or rotate the secret"); },
        readForHelper() { throw new Error("migration must not use helper.read"); },
        encrypt() { throw new Error("migration must use its dedicated operation"); },
        decrypt() { throw new Error("migration must use its dedicated operation"); },
      };
    },
  }).open({ generation: GENERATION });
  f.brokers.push(broker);
  return { broker, calls };
}

function workerLaunch(f, patch = {}) {
  const applicationsRoot = path.join(f.root, "applications");
  const bundle = path.join(applicationsRoot, "Shoggoth.app");
  const executable = path.join(bundle, "Contents", "MacOS", "Shoggoth");
  const resourcesPath = path.join(bundle, "Contents", "Resources");
  const appRoot = path.join(resourcesPath, "app.asar");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executable, "fixture executable\n");
  fs.writeFileSync(appRoot, "fixture archive\n");
  const calls = [];
  const chunks = [];
  let appName = "Shoggoth";
  let frozenNamespace = null;
  let ready;
  const mainLoopReady = patch.delayedInput ? new Promise((resolve) => { ready = resolve; }) : null;
  const input = patch.delayedInput ? new PassThrough() : null;
  const output = new PassThrough();
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const electronApp = {
    getAppPath: () => appRoot,
    setName(value) { appName = value; calls.push(["name", value]); },
    setPath(name) { calls.push(["path", name]); },
    async whenReady() { calls.push(["ready"]); await mainLoopReady; },
    setActivationPolicy(value) { calls.push(["activation", value]); },
    exit(code) { calls.push(["exit", code]); },
  };
  const electron = { app: electronApp };
  Object.defineProperty(electron, "safeStorage", {
    get() {
      calls.push(["safeStorage"]);
      if (!patch.delayedInput) return f.legacy;
      return {
        ...f.legacy,
        decryptString(value) {
          if (frozenNamespace !== SHOGGOTH_AGENT_SERVICE_NAME) throw new Error("wrong frozen namespace");
          return f.legacy.decryptString(value);
        },
      };
    },
  });
  const workerGate = { ...gate(patch.callerRole), parentExecutable: executable, appRoot };
  return {
    calls, chunks, gate: workerGate,
    start: () => {
      if (patch.delayedInput) setImmediate(() => {
        // Electron fixes the namespace when the main loop starts, independently
        // of the first safeStorage getter. Changing app.name later cannot fix it.
        frozenNamespace = appName;
        calls.push(["namespace-frozen", frozenNamespace]);
        ready();
        input.end(encodeWorkerRequest({ gate: workerGate, request: request(f.paths) }));
      });
      return startMcpCryptoWorker({
        gate: workerGate, request: patch.delayedInput ? undefined : request(f.paths),
        input, electron, electronApp, output,
        createLocalFileSafeStorage(options) {
          calls.push(["localStorage", options.readOnly]);
          assert.equal(options.paths.mcpAuthPath, f.paths.mcpAuthPath);
          return createLocalFileSafeStorage(options);
        },
        runtime: {
          ppid: process.pid, execPath: executable, appRoot, resourcesPath, applicationsRoot,
          defaultApp: patch.defaultApp === true,
          parent: {
            executable, ppid: 1,
            command: `${executable} --shoggoth-internal-role=${workerGate.callerRole}`,
          },
          verifyCodeIdentity: patch.identity || localIdentity,
        },
      });
    },
  };
}

test("专用 worker request 只允许 service、当前代及空 payload", async () => fixture(async (f) => {
  assert.equal(validateWorkerRequest(request(f.paths), gate()).operation, OPERATION);
  for (const [workerRequest, workerGate] of [
    [request(f.paths), gate("mcp")],
    [request(f.paths, { generation: GENERATION + 1 }), gate()],
    [request(f.paths, { payloadBytes: 1 }), gate()],
  ]) {
    assert.throws(() => validateWorkerRequest(workerRequest, workerGate),
      (error) => error.code === "MCP_CRYPTO_REQUEST_INVALID");
  }
}));

test("worker 仅返回现有主钥封装的同一 secret，所有文件不变", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  const ciphertext = await worker(f);
  const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
  try {
    assert.equal(isLocalFileCiphertext(ciphertext), true);
    assert.equal(local.decryptString(ciphertext), f.secret.toString("base64url"));
    assert.deepEqual(snapshot(f.root), before);
  } finally { ciphertext.fill(0); local.close(); }
}));

test("worker 的旧解密失败及非规范 secret 都固定拒绝且零写入", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  for (const decryptString of [
    () => { throw new Error(CANARY); },
    () => Buffer.alloc(31).toString("base64url"),
    () => `${f.secret.toString("base64url")}=`,
  ]) {
    await assert.rejects(worker(f, { safeStorage: { ...f.legacy, decryptString } }), fixedError);
    assert.deepEqual(snapshot(f.root), before);
  }
}));

test("本地专用迁移 worker 先固定旧命名空间与加载现有主钥，再访问 safeStorage", async () => {
  for (const identity of [localIdentity, adHocIdentity]) await fixture(async (f) => {
    const launch = workerLaunch(f, { identity });
    const before = snapshot(f.root);
    await launch.start();
    const names = launch.calls.filter(([kind]) => kind === "name");
    assert.deepEqual(names, [["name", SHOGGOTH_AGENT_SERVICE_NAME]]);
    assert.deepEqual(launch.calls.filter(([kind]) => kind === "localStorage"), [["localStorage", true]]);
    assert.deepEqual(launch.calls.filter(([kind]) => kind === "exit"), [["exit", 0]]);
    const accessed = launch.calls.findIndex(([kind]) => kind === "safeStorage");
    assert.equal(accessed > launch.calls.findIndex(([kind]) => kind === "name"), true);
    assert.equal(accessed > launch.calls.findIndex(([kind]) => kind === "localStorage"), true);
    assert.equal(launch.calls.filter(([kind]) => kind === "safeStorage").length, 1);
    const frame = Buffer.concat(launch.chunks);
    let ciphertext;
    const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
    try {
      ciphertext = decodeWorkerResponse(frame, launch.gate, {
        expectedPayloadBytes: 0, maxPayloadBytes: 4096,
      });
      assert.equal(local.decryptString(ciphertext), f.secret.toString("base64url"));
      assert.deepEqual(snapshot(f.root), before);
    } finally {
      frame.fill(0); ciphertext?.fill(0); local.close();
      launch.chunks.forEach((chunk) => chunk.fill(0));
    }
  });
});

test("异步 stdin 到达前 main loop 冻结的 Keychain 名称必须已是 v2", async () => {
  for (const identity of [localIdentity, adHocIdentity]) await fixture(async (f) => {
    const launch = workerLaunch(f, { identity, delayedInput: true });
    const before = snapshot(f.root);
    await launch.start();
    const frame = Buffer.concat(launch.chunks);
    let ciphertext;
    const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
    try {
      assert.deepEqual(launch.calls.find(([kind]) => kind === "namespace-frozen"),
        ["namespace-frozen", SHOGGOTH_AGENT_SERVICE_NAME]);
      assert.equal(launch.calls.findIndex(([kind]) => kind === "name")
        < launch.calls.findIndex(([kind]) => kind === "namespace-frozen"), true);
      assert.deepEqual(launch.calls.filter(([kind]) => kind === "exit"), [["exit", 0]]);
      ciphertext = decodeWorkerResponse(frame, launch.gate, { expectedPayloadBytes: 0, maxPayloadBytes: 4096 });
      assert.equal(local.decryptString(ciphertext), f.secret.toString("base64url"));
      assert.deepEqual(snapshot(f.root), before);
    } finally {
      frame.fill(0); ciphertext?.fill(0); local.close();
      launch.chunks.forEach((chunk) => chunk.fill(0));
    }
  });
});

test("Developer ID、defaultApp 与 helper 的专用 worker 请求在访问 Keychain 前拒绝", async () => {
  for (const patch of [
    { identity: developerIdentity }, { defaultApp: true }, { callerRole: "mcp" },
  ]) await fixture(async (f) => {
    const launch = workerLaunch(f, patch);
    const before = snapshot(f.root);
    await assert.rejects(launch.start(), (error) => error.code === (
      patch.callerRole === "mcp" ? "MCP_CRYPTO_REQUEST_INVALID" : "MCP_CRYPTO_UNAVAILABLE"
    ));
    assert.equal(launch.calls.some(([kind]) => kind === "safeStorage" || kind === "activation"), false);
    assert.equal(launch.chunks.length, 0);
    assert.deepEqual(snapshot(f.root), before);
  });
});

test("专用 worker 主钥缺失时只读加载失败，不访问 Keychain 或生成替代主钥", async () => fixture(async (f) => {
  const launch = workerLaunch(f);
  fs.unlinkSync(localCryptoKeyPath(f.paths));
  const before = snapshot(f.root);
  await assert.rejects(launch.start(), (error) => error.code === "LOCAL_CRYPTO_UNAVAILABLE");
  assert.deepEqual(launch.calls.filter(([kind]) => kind === "localStorage"), [["localStorage", true]]);
  assert.equal(launch.calls.some(([kind]) => kind === "safeStorage"), false);
  assert.equal(fs.existsSync(localCryptoKeyPath(f.paths)), false);
  assert.deepEqual(snapshot(f.root), before);
}));

test("local/ad-hoc 迁移保存同一 secret、主钥与私有原密文备份，重复执行不再创建 worker", async () => {
  for (const identity of [localIdentity, adHocIdentity]) await fixture(async (f) => {
    const oldBytes = fs.readFileSync(f.paths.mcpAuthPath);
    const key = fs.readFileSync(localCryptoKeyPath(f.paths));
    const { broker, calls } = selector(f, { identity });
    assert.deepEqual(await broker.migrateLegacyMcpAuth({ generation: GENERATION }), {
      migrated: true, restartRequired: true,
    });
    assert.equal(isLocalFileCiphertext(readCiphertext(f.paths)), true);
    assert.equal(fs.readFileSync(localCryptoKeyPath(f.paths)).equals(key), true);
    const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
    const reader = new McpAuthSecretStore({
      paths: f.paths, access: "helper", safeStorage: local,
    }).open();
    let recovered;
    try { recovered = reader.readForHelper(); assert.equal(recovered.equals(f.secret), true); }
    finally { recovered?.fill(0); reader.close(); local.close(); key.fill(0); }
    const backups = filesUnder(f.root).filter((target) => fs.readFileSync(target).equals(oldBytes));
    assert.equal(backups.length, 1);
    assert.notEqual(path.dirname(backups[0]), f.paths.stateDir);
    assert.equal(fs.statSync(path.dirname(backups[0])).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backups[0]).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(f.paths.stateDir).some((name) => name.startsWith("mcp-auth.json.backup-")), false);
    const after = snapshot(f.root);
    assert.deepEqual(await broker.migrateLegacyMcpAuth({ generation: GENERATION }), {
      migrated: false, restartRequired: false,
    });
    assert.equal(calls.rewraps, 1);
    assert.equal(calls.factories, 1);
    assert.equal(calls.opens, 1);
    assert.equal(calls.closes, 1);
    assert.deepEqual(snapshot(f.root), after);
  });
});

test("helper 与 Developer ID 都不能发起本地迁移", async () => {
  for (const patch of [{ callerRole: "mcp" }, { identity: developerIdentity }]) await fixture(async (f) => {
    const before = snapshot(f.root);
    const { broker, calls } = selector(f, patch);
    await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
    assert.equal(calls.rewraps, 0);
    assert.deepEqual(snapshot(f.root), before);
  });
});

test("外置 broker helper 在 spawn 前拒绝专用操作", async () => fixture(async (f) => {
  let spawns = 0;
  const broker = new McpCryptoBroker({
    paths: f.paths, callerRole: "mcp", executablePath: EXECUTABLE, appRoot: APP_ROOT,
    spawn() { spawns += 1; throw new Error("must not spawn"); },
  }).open({ generation: GENERATION });
  f.brokers.push(broker);
  await assert.rejects(broker.rewrapLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.equal(spawns, 0);
}));

test("外置 broker 使用空请求 payload 和绑定 nonce 的二进制密文响应", async () => fixture(async (f) => {
  const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
  const expected = local.encryptString(f.secret.toString("base64url"));
  local.close();
  let sentRequest;
  let responseFrame;
  const broker = new McpCryptoBroker({
    paths: f.paths, callerRole: "agent-service", executablePath: EXECUTABLE,
    appRoot: APP_ROOT, platform: "win32", requestTimeoutMs: 1_000,
    spawn() {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      const gatePipe = new PassThrough();
      child.stdio = [child.stdin, child.stdout, null, gatePipe];
      child.kill = () => { child.signalCode = "SIGTERM"; return true; };
      const streams = [gatePipe, child.stdin].map((input) => new Promise((resolve) => {
        const chunks = [];
        input.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        input.on("end", () => resolve(Buffer.concat(chunks)));
      }));
      void Promise.all(streams).then(([gateFrame, requestFrame]) => {
        const workerGate = JSON.parse(gateFrame.toString("utf8"));
        sentRequest = Buffer.from(requestFrame);
        responseFrame = encodeWorkerResponse({ gate: workerGate, payload: expected, ok: true });
        gateFrame.fill(0);
        requestFrame.fill(0);
        child.stdout.end(responseFrame);
        setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); });
      });
      return child;
    },
  }).open({ generation: GENERATION });
  f.brokers.push(broker);
  const ciphertext = await broker.rewrapLegacyMcpAuth({ generation: GENERATION });
  try {
    assert.equal(ciphertext.equals(expected), true);
    const newline = sentRequest.indexOf(0x0a);
    const sentHeader = JSON.parse(sentRequest.subarray(0, newline).toString("utf8"));
    assert.equal(sentHeader.operation, OPERATION);
    assert.equal(sentHeader.payloadBytes, 0);
    assert.equal(sentRequest.length, newline + 1);
    assert.equal(responseFrame.every((byte) => byte === 0), true);
  } finally { expected.fill(0); ciphertext.fill(0); sentRequest?.fill(0); }
}));

test("旧密文解密失败不会备份、覆写文件或更换主钥", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  const { broker, calls } = selector(f, {
    rewrap: () => worker(f, { safeStorage: {
      ...f.legacy, decryptString() { throw new Error(CANARY); },
    } }),
  });
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.equal(calls.rewraps, 1);
  assert.equal(calls.closes, 1);
  assert.deepEqual(snapshot(f.root), before);
}));

test("未知旧密文格式在调用 worker 前拒绝且零写入", async () => fixture(async (f) => {
  writeCiphertext(f.paths, Buffer.from("v11-unsupported-ciphertext"));
  const before = snapshot(f.root);
  const { broker, calls } = selector(f);
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.equal(calls.rewraps, 0);
  assert.deepEqual(snapshot(f.root), before);
}));

test("迁移时现有主钥缺失会拒绝，不创建替代主钥或调用 worker", async () => fixture(async (f) => {
  const { broker, calls } = selector(f);
  await broker.selection;
  fs.unlinkSync(localCryptoKeyPath(f.paths));
  const before = snapshot(f.root);
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.equal(fs.existsSync(localCryptoKeyPath(f.paths)), false);
  assert.equal(calls.rewraps, 0);
  assert.deepEqual(snapshot(f.root), before);
}));

test("worker 返回非本地、认证失败或非规范 secret 的密文均拒绝提交", async () => {
  for (const kind of ["legacy", "tampered", "invalid-secret"]) await fixture(async (f) => {
    const before = snapshot(f.root);
    const { broker } = selector(f, {
      async rewrap() {
        if (kind === "legacy") return readCiphertext(f.paths);
        const local = createLocalFileSafeStorage({ paths: f.paths, readOnly: true });
        try {
          const ciphertext = local.encryptString(kind === "invalid-secret" ? "invalid" : f.secret.toString("base64url"));
          if (kind === "tampered") ciphertext[ciphertext.length - 1] ^= 1;
          return ciphertext;
        } finally { local.close(); }
      },
    });
    await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
    assert.deepEqual(snapshot(f.root), before);
  });
});

test("worker 等待期间原文件发生变化时 CAS 拒绝，保留并发写入", async () => fixture(async (f) => {
  let concurrentSnapshot;
  const { broker } = selector(f, {
    async rewrap(_fixture, invoke) {
      const ciphertext = await invoke();
      writeCiphertext(f.paths, f.legacy.encryptString(Buffer.alloc(32, 0x54).toString("base64url")));
      concurrentSnapshot = snapshot(f.root);
      return ciphertext;
    },
  });
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.deepEqual(snapshot(f.root), concurrentSnapshot);
}));

test("close 撤销迁移，迟到 worker 结果拒绝提交并清零", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  let release;
  let returnedCiphertext;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { broker, calls } = selector(f, {
    async rewrap(_fixture, invoke) {
      returnedCiphertext = await invoke();
      return new Promise((resolve) => { release = () => resolve(returnedCiphertext); entered(); });
    },
  });
  const pending = broker.migrateLegacyMcpAuth({ generation: GENERATION });
  const rejected = assert.rejects(pending, fixedError);
  let timer;
  try {
    await Promise.race([started, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("migration never reached worker")), 2_000);
    })]);
    const closing = broker.close();
    release();
    await rejected;
    await closing;
  } finally { clearTimeout(timer); release?.(); }
  assert.equal(returnedCiphertext.every((byte) => byte === 0), true);
  assert.equal(calls.closes, 1);
  assert.deepEqual(snapshot(f.root), before);
}));

test("错误 generation 与已关闭 broker 拒绝且不拉起 worker", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  const { broker, calls } = selector(f);
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION + 1 }), fixedError);
  await broker.close();
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), fixedError);
  assert.equal(calls.rewraps, 0);
  assert.deepEqual(snapshot(f.root), before);
}));

test("服务生命周期先退役时未 close 的 broker 也拒绝迟到迁移结果", async () => fixture(async (f) => {
  const before = snapshot(f.root);
  let current = true;
  let returnedCiphertext;
  const { broker, calls } = selector(f, {
    async rewrap(_fixture, invoke) {
      returnedCiphertext = await invoke();
      await new Promise((resolve) => setImmediate(() => { current = false; resolve(); }));
      return returnedCiphertext;
    },
  });
  await assert.rejects(broker.migrateLegacyMcpAuth({
    generation: GENERATION, isCurrent: () => current,
  }), fixedError);
  assert.equal(broker.opened, true);
  assert.equal(calls.rewraps, 1);
  assert.equal(calls.closes, 1);
  assert.equal(returnedCiphertext.every((byte) => byte === 0), true);
  assert.deepEqual(snapshot(f.root), before);
}));

test("原子提交在 temp fsync 期间遭遇同 inode 同大小改写时 CAS 拒绝并保留并发内容", async () => fixture(async (f) => {
  const original = fs.readFileSync(f.paths.mcpAuthPath);
  const identity = fs.statSync(f.paths.mcpAuthPath);
  const concurrent = Buffer.alloc(original.length, 0x78);
  let injected = false;
  const faultFs = fsWithSyncHook((target) => {
    if (target !== `${f.paths.mcpAuthPath}.tmp` || injected) return;
    injected = true;
    fs.writeFileSync(f.paths.mcpAuthPath, concurrent);
    fs.utimesSync(f.paths.mcpAuthPath, identity.atime, new Date(identity.mtimeMs + 2_000));
  });
  assert.throws(() => atomicWritePrivateFile(f.paths.mcpAuthPath, Buffer.from("candidate\n"), {
    fs: faultFs, trustedRoot: f.paths.trustedRoot,
    expectedIdentity: Object.fromEntries(["dev", "ino", "size", "mtimeMs"].map((field) => [field, identity[field]])),
  }), (error) => error.code === "PRIVATE_FILE_COMPARE_FAILED");
  const after = fs.statSync(f.paths.mcpAuthPath);
  assert.equal(injected, true);
  assert.equal(after.ino, identity.ino);
  assert.equal(after.size, identity.size);
  assert.equal(after.mode & 0o777, identity.mode & 0o777);
  assert.equal(fs.readFileSync(f.paths.mcpAuthPath).equals(concurrent), true);
  assert.equal(fs.existsSync(`${f.paths.mcpAuthPath}.tmp`), false);
  assert.equal(fs.readdirSync(f.paths.stateDir).some((name) => name.startsWith("mcp-auth.json.backup-")), false);
}));

test("迁移提交后清理目录 fsync 失败返回状态不确定，保留独立原密文备份与主钥", async () => fixture(async (f) => {
  const original = fs.readFileSync(f.paths.mcpAuthPath);
  const key = fs.readFileSync(localCryptoKeyPath(f.paths));
  let stateSyncs = 0;
  let injected = false;
  const faultFs = fsWithSyncHook((target) => {
    if (target !== f.paths.stateDir) return;
    stateSyncs += 1;
    if (stateSyncs === 3) {
      injected = true;
      throw Object.assign(new Error(CANARY), { code: "EIO" });
    }
  });
  const { broker } = selector(f, { fs: faultFs });
  await assert.rejects(broker.migrateLegacyMcpAuth({ generation: GENERATION }), (error) => (
    error.code === "MCP_CRYPTO_MIGRATION_COMMIT_UNCERTAIN"
    && error.message === "mcp_crypto_unavailable"
    && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(CANARY)
  ));
  assert.equal(injected, true);
  assert.equal(stateSyncs, 3);
  assert.equal(isLocalFileCiphertext(readCiphertext(f.paths)), true);
  assert.equal(fs.readFileSync(localCryptoKeyPath(f.paths)).equals(key), true);
  const backups = filesUnder(f.root).filter((target) => fs.readFileSync(target).equals(original));
  assert.equal(backups.length, 1);
  assert.notEqual(path.dirname(backups[0]), f.paths.stateDir);
  assert.equal(fs.statSync(path.dirname(backups[0])).mode & 0o777, 0o700);
  assert.equal(fs.statSync(backups[0]).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(f.paths.stateDir).some((name) => name.startsWith("mcp-auth.json.backup-")), false);
  key.fill(0);
}));

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`); console.error(error?.stack || error); }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS shoggoth MCP legacy rewrap unit (${tests.length})`);
})();
