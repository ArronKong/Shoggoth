"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { McpAuthSecretStore } = require("./agent-service/mcp-auth-secret-store");
const {
  MAX_MCP_CRYPTO_REQUEST_BYTES,
  cryptoError,
  decodeWorkerRequestFrame,
  encodeWorkerResponse,
  validateWorkerGate,
  validateWorkerRequest,
} = require("./agent-service/mcp-crypto-protocol");
const { assertStableAppPaths, inferAppPath } = require("./agent-service/bundle-paths");
const {
  CODEX_DESIGNATED_REQUIREMENT,
  CODEX_TEAM_IDENTIFIER,
  SHOGGOTH_APP_IDENTIFIER,
  assertCodeIdentity,
  isLocalFileCryptoAppIdentity,
  isStrictAdHocAppIdentity,
  isStrictLocalSignedAppIdentity,
} = require("./agent-service/code-identity");
const { assertPrivateDirectory, ensurePrivateDirectoryTree } = require("./agent-service/security");
const {
  createLocalFileSafeStorage,
} = require("./agent-service/local-file-safe-storage");

// 后台 Service/MCP 使用独立 profile，也必须使用独立的 Keychain service name。
// 若沿用 UI 的 `Shoggoth Safe Storage`，旧开发签名或旧 ACL 会让一次性 worker
// 卡在系统授权对话框，且会连带影响主界面已有的 Chromium 加密状态。
// Developer ID 正式包沿用固定命名空间。下方 ad-hoc 命名仅保留给旧调用方；
// 当前 packaged selector 会把经过严格身份校验的 ad-hoc 包直接切到本地文件
// crypto，不再启动 worker 或访问登录钥匙串。
const SHOGGOTH_AGENT_SERVICE_NAME = "Shoggoth Background Service v2";

function readSingleJsonLineSync(fd, maxBytes = MAX_MCP_CRYPTO_REQUEST_BYTES) {
  const bytes = fs.readFileSync(fd);
  try {
    if (bytes.length === 0 || bytes.length > maxBytes) throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 || newline !== bytes.length - 1 || bytes.subarray(0, newline).includes(0x0a)) {
      throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
    }
    return JSON.parse(bytes.subarray(0, newline).toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith("MCP_CRYPTO_")) throw error;
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  } finally {
    bytes.fill(0);
  }
}

async function readSingleJsonLine(input, maxBytes = MAX_MCP_CRYPTO_REQUEST_BYTES) {
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      const next = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      buffered.fill(0);
      buffered = next;
      if (buffered.length > maxBytes) throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
    }
    const newline = buffered.indexOf(0x0a);
    if (newline < 0 || newline !== buffered.length - 1
      || buffered.subarray(0, newline).includes(0x0a)) {
      throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
    }
    return JSON.parse(buffered.subarray(0, newline).toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith("MCP_CRYPTO_")) throw error;
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  } finally {
    buffered.fill(0);
  }
}

async function readWorkerRequest(input, gate, maxBytes = MAX_MCP_CRYPTO_REQUEST_BYTES) {
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = Buffer.concat([buffered, incoming]);
      buffered.fill(0);
      incoming.fill(0);
      buffered = next;
      if (buffered.length > maxBytes) throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
    }
    return decodeWorkerRequestFrame(buffered, gate);
  } catch (error) {
    if (error?.code?.startsWith("MCP_CRYPTO_")) throw error;
    throw cryptoError("MCP_CRYPTO_FRAME_INVALID");
  } finally {
    buffered.fill(0);
  }
}

function parentProcessFields(pid) {
  try {
    const parentPid = Number.parseInt(execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8", timeout: 500, maxBuffer: 4096,
    }).trim(), 10);
    return {
      executable: execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8", timeout: 500, maxBuffer: 4096,
      }).trim(),
      command: execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8", timeout: 500, maxBuffer: 16 * 1024,
      }).trim(),
      ppid: parentPid,
    };
  } catch {
    throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
  }
}

function keychainServiceNameForIdentity(identity) {
  if (!isStrictAdHocAppIdentity(identity)) return SHOGGOTH_AGENT_SERVICE_NAME;
  return `Shoggoth Background Service ad-hoc ${identity.cdHash}`;
}

function cryptoStorageForIdentity(identity, options = {}) {
  if (isLocalFileCryptoAppIdentity(identity)) {
    const createStorage = options.createLocalFileSafeStorage || createLocalFileSafeStorage;
    return createStorage({
      paths: options.paths,
      fs: options.fs,
      randomBytes: options.randomBytes,
      readOnly: options.readOnly === true,
    });
  }
  if (options.safeStorage) return options.safeStorage;
  return options.electron?.safeStorage;
}

function assertWorkerParent(gate, runtime = {}) {
  const returnIdentity = runtime.returnIdentity === true;
  const actual = {
    pid: runtime.ppid ?? process.ppid,
    execPath: path.resolve(runtime.execPath || process.execPath),
    appRoot: path.resolve(runtime.appRoot || process.argv[1] || ""),
    defaultApp: runtime.defaultApp ?? process.defaultApp,
    resourcesPath: path.resolve(runtime.resourcesPath || process.resourcesPath || "/"),
  };
  const parent = runtime.parent || parentProcessFields(actual.pid);
  const rolePattern = new RegExp(`--shoggoth-internal-role=${gate.callerRole}(?:\\s|$)`, "u");
  if (gate.parentPid !== actual.pid
    || path.resolve(parent.executable || "") !== gate.parentExecutable
    || gate.parentExecutable !== actual.execPath
    || gate.appRoot !== actual.appRoot
    || typeof parent.command !== "string"
    || !rolePattern.test(parent.command)) {
    throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
  }
  if (actual.defaultApp !== true) {
    const applicationsRoot = path.resolve(runtime.applicationsRoot || "/Applications");
    const appPath = inferAppPath(actual.execPath, applicationsRoot);
    assertStableAppPaths({
      appPath,
      executablePath: actual.execPath,
      resourcesPath: actual.resourcesPath,
      bootstrapPath: path.join(actual.resourcesPath, "app.asar", "app", "bootstrap.js"),
    }, { applicationsRoot });
    const verifyIdentity = runtime.verifyCodeIdentity
      || ((executable, expected = {}, identityOptions = {}) => (
        assertCodeIdentity(executable, expected, identityOptions)
      ));
    const identity = verifyIdentity(actual.execPath, {}, {
      allowAdHocIdentifier: SHOGGOTH_APP_IDENTIFIER,
      allowLocalSignedIdentifier: SHOGGOTH_APP_IDENTIFIER,
    });
    const signedIdentity = identity && typeof identity.teamIdentifier === "string"
      && identity.teamIdentifier.length > 0
      && typeof identity.designatedRequirement === "string"
      && identity.designatedRequirement.length > 0;
    if (signedIdentity) return returnIdentity ? identity : true;
    if (isStrictLocalSignedAppIdentity(identity)) return returnIdentity ? identity : true;
    if (!isStrictAdHocAppIdentity(identity)) {
      throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
    }

    if (gate.callerRole === "agent-service") {
      if (parent.ppid !== 1) throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
      return returnIdentity ? identity : true;
    }

    // ad-hoc 的 MCP helper 本身没有可验证 Team ID，因此重复验证它的直接
    // 父进程：必须是当前 App 内携带且仍保有 OpenAI 签名的官方 Codex。
    if (gate.callerRole !== "mcp" || !Number.isSafeInteger(parent.ppid) || parent.ppid <= 1) {
      throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
    }
    const codexExecutable = path.join(actual.resourcesPath, "codex", "package", "bin", "codex");
    const grandparent = runtime.grandparent || parentProcessFields(parent.ppid);
    if (path.resolve(grandparent.executable || "") !== codexExecutable
      || typeof grandparent.command !== "string" || grandparent.command.length === 0) {
      throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
    }
    const codexIdentity = verifyIdentity(codexExecutable, {
      teamIdentifier: CODEX_TEAM_IDENTIFIER,
      designatedRequirement: CODEX_DESIGNATED_REQUIREMENT,
    });
    if (codexIdentity?.teamIdentifier !== CODEX_TEAM_IDENTIFIER
      || codexIdentity?.designatedRequirement !== CODEX_DESIGNATED_REQUIREMENT) {
      throw cryptoError("MCP_CRYPTO_PARENT_INVALID");
    }
  }
  return returnIdentity ? null : true;
}

function writeFrame(output, frame, timeoutMs = 2_000) {
  if (!output || typeof output.write !== "function" || typeof output.once !== "function"
    || typeof output.off !== "function" || !Buffer.isBuffer(frame)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000) {
    if (Buffer.isBuffer(frame)) frame.fill(0);
    return Promise.reject(cryptoError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeCompleted = false;
    let drainCompleted = false;
    let settleImmediate = null;
    let callbackFallback = null;
    const timer = setTimeout(() => settle(cryptoError()), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (settleImmediate) clearImmediate(settleImmediate);
      if (callbackFallback) clearImmediate(callbackFallback);
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      frame.fill(0);
      if (error) reject(cryptoError());
      else resolve();
    };
    const maybeSettle = () => {
      if (!writeCompleted || !drainCompleted || settleImmediate) return;
      // 保留监听器跨过当前事件循环，收敛 write(true) 后紧随的异步 EPIPE。
      settleImmediate = setImmediate(() => settle());
    };
    const onDrain = () => { drainCompleted = true; maybeSettle(); };
    const onError = () => settle(cryptoError());
    const onClose = () => settle(cryptoError());
    const onWrite = (error) => {
      if (error) { onError(); return; }
      writeCompleted = true;
      maybeSettle();
    };
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
    try {
      const accepted = output.write(frame, onWrite);
      drainCompleted = accepted === true;
      if (output.write.length < 2) callbackFallback = setImmediate(() => onWrite());
      if (output.destroyed || output.closed || output.writableEnded) onClose();
      else maybeSettle();
    } catch {
      onError();
    }
  });
}

function assertEncryptionAvailable(safeStorage) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function"
      || typeof safeStorage.encryptString !== "function"
      || typeof safeStorage.decryptString !== "function"
      || safeStorage.isEncryptionAvailable() !== true) throw new Error("locked");
  } catch {
    throw cryptoError();
  }
}

async function performWorkerOperation({ gate, request, payload = Buffer.alloc(0), safeStorage, fs: fileSystem }) {
  if (["safeStorage.encrypt", "safeStorage.decrypt"].includes(request.operation)) {
    let result = null;
    let plaintext = null;
    try {
      assertEncryptionAvailable(safeStorage);
      if (!Buffer.isBuffer(payload) || payload.length !== request.payloadBytes) throw cryptoError();
      if (request.operation === "safeStorage.encrypt") {
        plaintext = payload.toString("utf8");
        const canonical = Buffer.from(plaintext, "utf8");
        try {
          if (!canonical.equals(payload)) throw cryptoError();
        } finally {
          canonical.fill(0);
        }
        result = safeStorage.encryptString(plaintext);
        if (!Buffer.isBuffer(result) || result.length === 0) throw cryptoError();
      } else {
        plaintext = safeStorage.decryptString(payload);
        if (typeof plaintext !== "string" || plaintext.length === 0) throw cryptoError();
        result = Buffer.from(plaintext, "utf8");
      }
      return encodeWorkerResponse({ gate, payload: result, ok: true });
    } catch {
      return encodeWorkerResponse({ gate, ok: false });
    } finally {
      plaintext = null;
      if (result) result.fill(0);
      payload.fill(0);
    }
  }

  const access = request.operation === "service.loadOrCreate" ? "service" : "helper";
  const store = new McpAuthSecretStore({ paths: request.paths, access, safeStorage, fs: fileSystem });
  let secret = null;
  try {
    await store.open();
    secret = access === "service" ? store.loadOrCreateForService() : store.readForHelper();
    return encodeWorkerResponse({ gate, secret, ok: true });
  } catch {
    return encodeWorkerResponse({ gate, ok: false });
  } finally {
    payload.fill(0);
    if (secret) secret.fill(0);
    try { await store.close(); } catch { /* one-shot process exits */ }
  }
}

async function startMcpCryptoWorker(options = {}) {
  const gateFd = options.gateFd ?? Number.parseInt(process.env.SHOGGOTH_CRYPTO_GATE_FD || "", 10);
  const electron = options.electron || require("electron");
  const electronApp = options.electronApp || electron.app;
  const gate = validateWorkerGate(options.gate || readSingleJsonLineSync(gateFd));
  const identity = assertWorkerParent(gate, {
    ...options.runtime,
    returnIdentity: true,
    appRoot: options.runtime?.appRoot
      || (typeof electronApp.getAppPath === "function" ? electronApp.getAppPath() : undefined),
  });
  const usesLocalFileCrypto = isLocalFileCryptoAppIdentity(identity);
  // Developer ID 包仍使用系统 safeStorage。Chromium 在第一次取得 safeStorage
  // 对象时就会固定 Keychain service name，因此必须先改名。本地稳定签名与经过
  // 完整 bundle/CDHash/父进程校验的 ad-hoc 包都改走私有文件主密钥。
  if (!usesLocalFileCrypto && typeof electronApp.setName === "function") {
    electronApp.setName(keychainServiceNameForIdentity(identity));
  }
  const decodedRequest = options.request
    ? { request: validateWorkerRequest(options.request, gate), payload: options.payload || Buffer.alloc(0) }
    : await readWorkerRequest(options.input || process.stdin, gate);
  const { request, payload } = decodedRequest;
  const cryptoProfileDir = path.join(request.paths.profileDir, "mcp-crypto-worker");
  const cryptoSessionDir = path.join(cryptoProfileDir, "session");
  const cryptoCacheDir = path.join(request.paths.cacheDir, "mcp-crypto-worker");
  if (request.operation === "helper.read") {
    // Runtime sandbox 只允许写受管 HOME。Helper 已在进入 worker 前创建这些目录；
    // worker 只验证，不能沿真实 Service trustedRoot 逐级 fchmod。
    assertPrivateDirectory(cryptoProfileDir);
    assertPrivateDirectory(cryptoSessionDir);
    assertPrivateDirectory(cryptoCacheDir);
  } else {
    ensurePrivateDirectoryTree(cryptoProfileDir, request.paths.trustedRoot);
    ensurePrivateDirectoryTree(cryptoSessionDir, request.paths.trustedRoot);
    ensurePrivateDirectoryTree(cryptoCacheDir, request.paths.trustedRoot);
  }
  electronApp.setPath("userData", cryptoProfileDir);
  electronApp.setPath("sessionData", cryptoSessionDir);
  electronApp.setPath("cache", cryptoCacheDir);
  await electronApp.whenReady();
  // 只有真正依赖系统钥匙串的 Developer ID 包才允许触发可见授权。本地稳定
  // 签名与严格 ad-hoc 包都使用 stateDir 下的私有文件主密钥，绝不能再触碰
  // Electron safeStorage 或唤起 SecurityAgent。
  if (!usesLocalFileCrypto) {
    if (typeof electronApp.setActivationPolicy === "function") {
      // Accessory permits a genuine Keychain authorization dialog without
      // adding a one-shot worker to the Dock or stealing focus on every read.
      electronApp.setActivationPolicy("accessory");
    }
  }
  const testStallMs = options.testCryptoStallMs
    ?? (process.env.NODE_ENV === "test"
      ? Number.parseInt(process.env.SHOGGOTH_TEST_CRYPTO_STALL_MS || "", 10) : 0);
  if (Number.isSafeInteger(testStallMs) && testStallMs >= 10 && testStallMs <= 10_000) {
    await new Promise((resolve) => setTimeout(resolve, testStallMs));
  }
  let safeStorage = null;
  try {
    safeStorage = cryptoStorageForIdentity(identity, {
      paths: request.paths,
      electron,
      safeStorage: options.safeStorage,
      createLocalFileSafeStorage: options.createLocalFileSafeStorage,
      fs: options.mcpAuthFs,
      randomBytes: options.localCryptoRandomBytes,
      readOnly: request.operation === "helper.read",
    });
    const frame = await performWorkerOperation({
      gate, request, payload, safeStorage, fs: options.mcpAuthFs,
    });
    const exitCode = frame[0] === 0 ? 0 : 1;
    await writeFrame(options.output || process.stdout, frame);
    if (typeof electronApp.exit === "function") electronApp.exit(exitCode);
    else electronApp.quit();
  } finally {
    if (usesLocalFileCrypto && typeof safeStorage?.close === "function") safeStorage.close();
  }
}

module.exports = {
  SHOGGOTH_AGENT_SERVICE_NAME,
  assertWorkerParent,
  cryptoStorageForIdentity,
  keychainServiceNameForIdentity,
  parentProcessFields,
  performWorkerOperation,
  readSingleJsonLine,
  readSingleJsonLineSync,
  readWorkerRequest,
  startMcpCryptoWorker,
  writeFrame,
};
