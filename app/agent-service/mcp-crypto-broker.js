"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { McpAuthSecretStore } = require("./mcp-auth-secret-store");
const {
  MCP_CRYPTO_PROTOCOL_VERSION,
  MCP_CRYPTO_RESPONSE_HEADER_BYTES,
  MAX_SAFE_STORAGE_PAYLOAD_BYTES,
  cryptoError,
  decodeWorkerResponse,
  encodeWorkerRequest,
} = require("./mcp-crypto-protocol");

// Packaged Electron 首次拉起 one-shot worker 还要完成 codesign 与 Keychain
// 初始化；在刚替换 App 或钥匙串唤醒后，实机冷启动可超过 2 秒。worker
// 独立于 Service 主事件循环，故保留严格 8 秒硬期限，同时不误杀正常请求。
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_TERM_GRACE_MS = 100;
const DEFAULT_KILL_CONFIRM_MS = 1000;
const MAX_QUEUED_REQUESTS = 32;

function workerPaths(paths) {
  return {
    trustedRoot: paths.trustedRoot,
    stateDir: paths.stateDir,
    mcpAuthPath: paths.mcpAuthPath,
    profileDir: paths.profileDir,
    cacheDir: paths.cacheDir,
  };
}

function workerEnvironment(parentEnv = process.env) {
  const env = {};
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "NODE_ENV"]) {
    if (typeof parentEnv[key] === "string" && !parentEnv[key].includes("\0")) env[key] = parentEnv[key];
  }
  env.SHOGGOTH_INTERNAL_LAUNCH = "launch-agent-v1";
  env.SHOGGOTH_CRYPTO_GATE_FD = "3";
  // 真实 Electron 隔离测试用受控 worker stall 代替访问临时 HOME 下不存在的
  // macOS 默认钥匙串，避免测试向用户弹出系统级“找不到钥匙串”对话框。
  if (parentEnv.NODE_ENV === "test"
    && path.isAbsolute(parentEnv.SHOGGOTH_TEST_ROLE_GATE_FILE || "")
    && typeof parentEnv.SHOGGOTH_TEST_ROLE_GATE_NONCE === "string"
    && /^\d{2,5}$/u.test(parentEnv.SHOGGOTH_TEST_CRYPTO_STALL_MS || "")) {
    env.SHOGGOTH_TEST_CRYPTO_STALL_MS = parentEnv.SHOGGOTH_TEST_CRYPTO_STALL_MS;
  }
  return env;
}

function positiveTimeout(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 10 || result > 90_000) {
    throw cryptoError("MCP_CRYPTO_OPTIONS_INVALID");
  }
  return result;
}

class InProcessMcpCryptoBroker {
  constructor(options = {}) {
    const callerRole = options.callerRole === undefined ? "agent-service" : options.callerRole;
    if (!["agent-service", "mcp"].includes(callerRole)) {
      throw cryptoError("MCP_CRYPTO_OPTIONS_INVALID");
    }
    this.callerRole = callerRole;
    this.ownsSafeStorage = options.ownsSafeStorage === true;
    this.safeStorage = options.safeStorage || null;
    this.safeStorageClosed = false;
    this.store = options.store || new McpAuthSecretStore({
      paths: options.paths,
      access: this.callerRole === "mcp" ? "helper" : "service",
      safeStorage: this.safeStorage,
      fs: options.fs,
    });
    this.opened = false;
    this.generation = 0;
    this.storeFlight = null;
    this.storeTail = Promise.resolve();
    this.closePromise = null;
    this.closing = false;
  }

  open(options = {}) {
    const generation = options.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0 || this.opened || this.closing
      || (this.ownsSafeStorage && this.safeStorageClosed)) {
      throw cryptoError();
    }
    this.generation = generation;
    this.opened = true;
    this.storeFlight = {
      generation,
      openPromise: null,
      storeOpened: false,
    };
    this.closePromise = null;
    return this;
  }

  async loadOrCreateForService({ generation } = {}) {
    if (this.callerRole !== "agent-service" || !this.#isCurrentGeneration(generation)) {
      throw cryptoError();
    }
    return this.#runStoreOperation(generation, "loadOrCreateForService");
  }

  async readForHelper({ generation } = {}) {
    if (this.callerRole !== "mcp" || !this.#isCurrentGeneration(generation)) {
      throw cryptoError();
    }
    return this.#runStoreOperation(generation, "readForHelper");
  }

  async encrypt(payload, options = {}) {
    let plaintext = null;
    try {
      const generation = options?.generation === undefined
        ? this.generation
        : options.generation;
      if (!this.#isCurrentGeneration(generation)
        || !Buffer.isBuffer(payload) || payload.length === 0) throw new Error("invalid");
      this.#assertAvailable();
      plaintext = payload.toString("utf8");
      const encrypted = this.safeStorage.encryptString(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("invalid");
      return Buffer.from(encrypted);
    } catch {
      throw cryptoError();
    } finally {
      plaintext = null;
    }
  }

  async decrypt(payload, options = {}) {
    let plaintext = null;
    try {
      const generation = options?.generation === undefined
        ? this.generation
        : options.generation;
      if (!this.#isCurrentGeneration(generation)
        || !Buffer.isBuffer(payload) || payload.length === 0) throw new Error("invalid");
      this.#assertAvailable();
      plaintext = this.safeStorage.decryptString(payload);
      if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("invalid");
      return Buffer.from(plaintext, "utf8");
    } catch {
      throw cryptoError();
    } finally {
      plaintext = null;
    }
  }

  close() {
    if (!this.opened && this.closePromise) return this.closePromise;
    const flight = this.storeFlight;
    const closeOwnedStorage = this.ownsSafeStorage && !this.safeStorageClosed;
    this.closing = true;
    this.opened = false;
    this.generation = 0;
    this.storeFlight = null;
    if (closeOwnedStorage) this.safeStorageClosed = true;
    const closing = (async () => {
      try {
        if (flight) {
          await this.#enqueueStore(async () => {
            if (!flight.storeOpened) return;
            await this.store.close();
            flight.storeOpened = false;
          });
        }
      } finally {
        try {
          if (closeOwnedStorage && typeof this.safeStorage?.close === "function") {
            await this.safeStorage.close();
          }
        } finally {
          this.closing = false;
        }
      }
    })();
    this.closePromise = closing;
    return closing;
  }

  #enqueueStore(action) {
    const result = this.storeTail.then(action);
    this.storeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #openStoreOnce(flight) {
    if (!flight.openPromise) {
      flight.openPromise = this.#enqueueStore(async () => {
        await this.store.open();
        flight.storeOpened = true;
      });
    }
    return flight.openPromise;
  }

  async #runStoreOperation(generation, operation) {
    const flight = this.storeFlight;
    if (!flight || flight.generation !== generation) throw cryptoError();
    let operationResult;
    try {
      await this.#openStoreOnce(flight);
      if (!this.#isCurrentGeneration(generation) || this.storeFlight !== flight) {
        throw cryptoError();
      }
      await this.#enqueueStore(() => {
        if (!this.#isCurrentGeneration(generation) || this.storeFlight !== flight
          || !flight.storeOpened) {
          throw cryptoError();
        }
        operationResult = this.store[operation]();
      });
    } catch {
      throw cryptoError();
    }
    let result;
    try {
      result = await operationResult;
    } catch (error) {
      if (!this.#isCurrentGeneration(generation) || this.storeFlight !== flight) {
        throw cryptoError();
      }
      throw error;
    }
    if (!this.#isCurrentGeneration(generation) || this.storeFlight !== flight) {
      if (Buffer.isBuffer(result)) result.fill(0);
      throw cryptoError();
    }
    return result;
  }

  #isCurrentGeneration(generation) {
    return this.opened
      && Number.isSafeInteger(generation)
      && generation > 0
      && generation === this.generation;
  }

  #assertAvailable() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== "function"
      || typeof this.safeStorage.encryptString !== "function"
      || typeof this.safeStorage.decryptString !== "function"
      || this.safeStorage.isEncryptionAvailable() !== true) throw new Error("unavailable");
  }
}

class McpCryptoBroker {
  constructor(options = {}) {
    if (!options.paths || !path.isAbsolute(options.executablePath || "")
      || !path.isAbsolute(options.appRoot || "")
      || !["agent-service", "mcp"].includes(options.callerRole)) {
      throw cryptoError("MCP_CRYPTO_OPTIONS_INVALID");
    }
    this.paths = options.paths;
    this.executablePath = path.resolve(options.executablePath);
    this.appRoot = path.resolve(options.appRoot);
    this.callerRole = options.callerRole;
    this.defaultApp = options.defaultApp === true;
    this.parentEnv = options.parentEnv || process.env;
    this.spawn = options.spawn || spawn;
    this.signalProcess = options.signalProcess || process.kill.bind(process);
    this.platform = options.platform || process.platform;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.termGraceMs = positiveTimeout(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    this.killConfirmMs = positiveTimeout(options.killConfirmMs, DEFAULT_KILL_CONFIRM_MS);
    this.opened = false;
    this.generation = 0;
    this.active = new Set();
    this.residualGroups = new Set();
    this.requestQueue = Promise.resolve();
    this.queuedRequests = 0;
    this.generationUnavailable = false;
  }

  open(options = {}) {
    const generation = options.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0 || this.residualGroups.size > 0) {
      throw cryptoError();
    }
    this.generation = generation;
    this.opened = true;
    this.requestQueue = Promise.resolve();
    this.queuedRequests = 0;
    this.generationUnavailable = false;
    return this;
  }

  loadOrCreateForService({ generation }) {
    if (this.callerRole !== "agent-service") return Promise.reject(cryptoError());
    return this.#request("service.loadOrCreate", generation);
  }

  readForHelper({ generation }) {
    if (this.callerRole !== "mcp") return Promise.reject(cryptoError());
    return this.#request("helper.read", generation);
  }

  encrypt(payload, options = {}) {
    return this.#request("safeStorage.encrypt", options.generation || this.generation, payload, {
      expectedPayloadBytes: 0,
      maxPayloadBytes: MAX_SAFE_STORAGE_PAYLOAD_BYTES,
    });
  }

  decrypt(payload, options = {}) {
    return this.#request("safeStorage.decrypt", options.generation || this.generation, payload, {
      expectedPayloadBytes: 0,
      maxPayloadBytes: MAX_SAFE_STORAGE_PAYLOAD_BYTES,
    });
  }

  async close() {
    this.opened = false;
    this.generation = 0;
    this.generationUnavailable = true;
    const results = await Promise.allSettled([
      this.requestQueue,
      ...[...this.active].map((entry) => entry.terminate()),
    ]);
    if (results.some((result) => result.status === "rejected") || this.residualGroups.size > 0) {
      throw cryptoError();
    }
  }

  #request(operation, generation, payload = null, responseOptions = {
    expectedPayloadBytes: 32, maxPayloadBytes: 32,
  }) {
    if (!this.opened || !Number.isSafeInteger(generation) || generation <= 0
      || (this.generation !== 0 && generation !== this.generation)
      || (payload !== null && (!Buffer.isBuffer(payload) || payload.length === 0
        || payload.length > MAX_SAFE_STORAGE_PAYLOAD_BYTES))) {
      return Promise.reject(cryptoError());
    }
    if (this.generationUnavailable || this.queuedRequests >= MAX_QUEUED_REQUESTS) {
      return Promise.reject(cryptoError());
    }
    const queuedPayload = payload === null ? null : Buffer.from(payload);
    this.queuedRequests += 1;
    const execute = () => {
      if (!this.opened || this.generationUnavailable
        || (this.generation !== 0 && generation !== this.generation)) {
        throw cryptoError();
      }
      return this.#requestWorker(operation, generation, queuedPayload, responseOptions);
    };
    const result = this.requestQueue.then(execute, execute).catch(() => {
      // macOS 的钥匙串失败可能伴随系统级授权对话框。同一 Service generation
      // 只允许一次真实尝试；后续请求固定降级，避免刷新/MCP 重连反复弹窗。
      if (this.opened && this.generation === generation) this.generationUnavailable = true;
      throw cryptoError();
    });
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.queuedRequests -= 1;
      if (queuedPayload) queuedPayload.fill(0);
    });
  }

  #requestWorker(operation, generation, payload = null, responseOptions = {
    expectedPayloadBytes: 32, maxPayloadBytes: 32,
  }) {
    if (this.generation === 0) this.generation = generation;
    let nonceBytes;
    try { nonceBytes = this.randomBytes(32); } catch { return Promise.reject(cryptoError()); }
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 32) {
      if (Buffer.isBuffer(nonceBytes)) nonceBytes.fill(0);
      return Promise.reject(cryptoError());
    }
    const nonce = nonceBytes.toString("base64url");
    nonceBytes.fill(0);
    const gate = {
      version: MCP_CRYPTO_PROTOCOL_VERSION,
      parentPid: process.pid,
      generation,
      nonce,
      callerRole: this.callerRole,
      parentExecutable: this.executablePath,
      appRoot: this.appRoot,
    };
    const request = {
      version: MCP_CRYPTO_PROTOCOL_VERSION,
      generation,
      operation,
      paths: workerPaths(this.paths),
      payloadBytes: payload?.length || 0,
    };
    const args = this.defaultApp
      ? [this.appRoot, "--shoggoth-internal-role=mcp-crypto"]
      : ["--shoggoth-internal-role=mcp-crypto"];
    let child;
    try {
      child = this.spawn(this.executablePath, args, {
        detached: this.platform !== "win32",
        env: workerEnvironment(this.parentEnv),
        stdio: ["pipe", "pipe", "ignore", "pipe"],
      });
    } catch {
      return Promise.reject(cryptoError());
    }
    return this.#exchange(child, gate, request, payload, responseOptions);
  }

  #exchange(child, gate, request, payload, responseOptions) {
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let stdout = Buffer.alloc(0);
    let deadline = null;
    let exitOutcome = null;
    let stdoutEnded = false;
    let resolvePromise;
    let rejectPromise;
    let requestFrame = null;

    try {
      requestFrame = encodeWorkerRequest({ gate, request, payload });
    } catch {
      try { child.kill("SIGKILL"); } catch {}
      return Promise.reject(cryptoError());
    }

    const signalGroup = (signal) => {
      try {
        if (this.platform !== "win32" && child.pid) this.signalProcess(-child.pid, signal);
        else child.kill(signal);
      } catch { /* exit race */ }
    };
    const cleanupTimers = () => {
      if (deadline) clearTimeout(deadline);
    };
    const finish = (error, secret = null) => {
      if (settled) {
        if (secret) secret.fill(0);
        return;
      }
      settled = true;
      cleanupTimers();
      this.active.delete(entry);
      stdout.fill(0);
      stdout = Buffer.alloc(0);
      requestFrame.fill(0);
      if (error) rejectPromise(cryptoError());
      else resolvePromise(secret);
    };
    const wait = (delay) => new Promise((resolve) => { setTimeout(resolve, delay); });
    const groupExists = () => {
      if (this.platform === "win32" || !child.pid) {
        return child.exitCode === null && child.signalCode === null;
      }
      try {
        this.signalProcess(-child.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    };
    const terminate = async () => {
      const groupId = child.pid || null;
      try {
        signalGroup("SIGTERM");
        await wait(this.termGraceMs);
        if (!groupExists()) return;
        signalGroup("SIGKILL");
        const deadlineAt = Date.now() + this.killConfirmMs;
        while (true) {
          if (!groupExists()) return;
          if (Date.now() >= deadlineAt) throw cryptoError();
          await wait(Math.min(10, Math.max(1, deadlineAt - Date.now())));
        }
      } catch {
        if (groupId) this.residualGroups.add(groupId);
        throw cryptoError();
      }
    };
    let terminationPromise = null;
    const terminateOnce = () => {
      terminating = true;
      if (!terminationPromise) terminationPromise = terminate();
      return terminationPromise;
    };
    const terminateAndFinish = async () => {
      try {
        await terminateOnce();
        finish(new Error("terminated"));
      } catch (error) {
        finish(new Error("terminate-failed"));
        throw error;
      }
    };
    const entry = { child, terminate: terminateAndFinish };
    this.active.add(entry);

    const finishWorkerResponse = () => {
      if (!exitOutcome || !stdoutEnded || settled || terminating) return;
      const { code, signal } = exitOutcome;
      if (timedOut || code !== 0 || signal !== null) {
        finish(new Error("worker-exit"));
        return;
      }
      try {
        const secret = decodeWorkerResponse(stdout, gate, responseOptions);
        finish(null, secret);
      } catch {
        finish(new Error("invalid"));
      }
    };

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      child.stdout?.on("data", (chunk) => {
        if (settled) {
          if (Buffer.isBuffer(chunk)) chunk.fill(0);
          return;
        }
        const incoming = Buffer.from(chunk);
        const combined = Buffer.concat([stdout, incoming]);
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
        stdout.fill(0);
        incoming.fill(0);
        stdout = combined;
        if (stdout.length > MCP_CRYPTO_RESPONSE_HEADER_BYTES + responseOptions.maxPayloadBytes) {
          timedOut = true;
          void entry.terminate().catch(() => {});
        }
      });
      child.stdout?.once("end", () => {
        stdoutEnded = true;
        finishWorkerResponse();
      });
      child.once("error", () => {
        if (!terminating && !timedOut) finish(new Error("spawn"));
      });
      child.once("exit", (code, signal) => {
        if (timedOut || terminating) return;
        exitOutcome = { code, signal };
        finishWorkerResponse();
      });
      deadline = setTimeout(() => {
        timedOut = true;
        void entry.terminate().catch(() => {});
      }, this.requestTimeoutMs);
      try {
        child.stdio[3].end(`${JSON.stringify(gate)}\n`);
        child.stdin.end(requestFrame, () => requestFrame.fill(0));
      } catch {
        void entry.terminate().catch(() => {});
      }
    });
    return promise;
  }
}

module.exports = {
  DEFAULT_KILL_CONFIRM_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TERM_GRACE_MS,
  InProcessMcpCryptoBroker,
  McpCryptoBroker,
  workerEnvironment,
  workerPaths,
};
