"use strict";

const path = require("node:path");
const { assertStableAppPaths, inferAppPath } = require("./bundle-paths");
const {
  SHOGGOTH_APP_IDENTIFIER,
  isLocalFileCryptoAppIdentity,
  readCodeIdentityAsync,
} = require("./code-identity");
const { createLocalFileSafeStorage } = require("./local-file-safe-storage");
const { migrateLegacyMcpAuth } = require("./mcp-auth-legacy-migration");
const { InProcessMcpCryptoBroker, McpCryptoBroker } = require("./mcp-crypto-broker");
const { cryptoError } = require("./mcp-crypto-protocol");

const REQUIRED_PATH_FIELDS = Object.freeze([
  "trustedRoot", "stateDir", "mcpAuthPath", "profileDir", "cacheDir",
]);
const DELEGATE_METHODS = Object.freeze([
  "open", "close", "loadOrCreateForService", "readForHelper", "encrypt", "decrypt",
]);

function validAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function validPaths(paths) {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return false;
  if (!REQUIRED_PATH_FIELDS.every((field) => validAbsolutePath(paths[field]))) return false;
  return path.dirname(paths.mcpAuthPath) === paths.stateDir
    && path.basename(paths.mcpAuthPath) === "mcp-auth.json";
}

function validDelegate(delegate) {
  return delegate && (typeof delegate === "object" || typeof delegate === "function")
    && DELEGATE_METHODS.every((method) => typeof delegate[method] === "function");
}

function validDeveloperIdentity(identity) {
  return identity && typeof identity === "object"
    && typeof identity.teamIdentifier === "string" && identity.teamIdentifier.length > 0
    && typeof identity.designatedRequirement === "string"
    && identity.designatedRequirement.length > 0;
}

class PackagedMcpCryptoBroker {
  constructor(options = {}) {
    try {
      if (!validPaths(options.paths)
        || !["agent-service", "mcp"].includes(options.callerRole)
        || !validAbsolutePath(options.executablePath)
        || !validAbsolutePath(options.appRoot)
        || !validAbsolutePath(options.resourcesPath)
        || !validAbsolutePath(options.applicationsRoot)
        || typeof options.defaultApp !== "boolean"
        || !options.parentEnv || typeof options.parentEnv !== "object"
        || Array.isArray(options.parentEnv)) {
        throw cryptoError();
      }
      this.assertStableAppPaths = options.assertStableAppPaths === undefined
        ? assertStableAppPaths : options.assertStableAppPaths;
      this.readCodeIdentityAsync = options.readCodeIdentityAsync === undefined
        ? readCodeIdentityAsync : options.readCodeIdentityAsync;
      this.createLocalFileSafeStorage = options.createLocalFileSafeStorage === undefined
        ? createLocalFileSafeStorage : options.createLocalFileSafeStorage;
      this.createExternalBroker = options.createExternalBroker === undefined
        ? ((brokerOptions) => new McpCryptoBroker(brokerOptions))
        : options.createExternalBroker;
      if (![this.assertStableAppPaths, this.readCodeIdentityAsync,
        this.createLocalFileSafeStorage, this.createExternalBroker]
        .every((factory) => typeof factory === "function")) {
        throw cryptoError();
      }

      this.paths = options.paths;
      this.callerRole = options.callerRole;
      this.executablePath = path.resolve(options.executablePath);
      this.appRoot = path.resolve(options.appRoot);
      this.resourcesPath = path.resolve(options.resourcesPath);
      this.applicationsRoot = path.resolve(options.applicationsRoot);
      this.defaultApp = options.defaultApp;
      this.parentEnv = options.parentEnv;
      this.requestTimeoutMs = options.requestTimeoutMs;
      this.termGraceMs = options.termGraceMs;
      this.killConfirmMs = options.killConfirmMs;
      this.fs = options.fs;
    } catch {
      throw cryptoError();
    }

    this.opened = false;
    this.generation = 0;
    this.epoch = 0;
    this.selection = null;
    this.delegate = null;
    this.closePromise = null;
    this.cleanupFailed = false;
    this.localIdentity = false;
    this.migrationPromise = null;
    this.migrationBroker = null;
    this.migrationBrokerClosePromise = null;
    this.migrationAttempted = false;
  }

  open(options = {}) {
    const generation = options.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0
      || this.opened || this.closePromise || this.cleanupFailed) {
      throw cryptoError();
    }
    this.epoch += 1;
    const epoch = this.epoch;
    this.generation = generation;
    this.opened = true;
    this.delegate = null;
    this.localIdentity = false;
    this.migrationAttempted = false;
    const selection = Promise.resolve().then(() => this.#select(generation, epoch));
    this.selection = selection;
    void selection.catch(() => {});
    return this;
  }

  loadOrCreateForService(options) {
    return this.#invoke("loadOrCreateForService", options);
  }

  readForHelper(options) {
    return this.#invoke("readForHelper", options);
  }

  encrypt(payload, options) {
    return this.#invoke("encrypt", payload, options);
  }

  decrypt(payload, options) {
    return this.#invoke("decrypt", payload, options);
  }

  migrateLegacyMcpAuth({ generation, isCurrent } = {}) {
    if (this.callerRole !== "agent-service" || generation !== this.generation
      || !Number.isSafeInteger(generation) || generation <= 0 || !this.opened
      || (isCurrent !== undefined && typeof isCurrent !== "function")) {
      return Promise.reject(cryptoError());
    }
    if (this.migrationPromise) return this.migrationPromise;
    const epoch = this.epoch;
    const pending = this.#migrate(generation, epoch, isCurrent);
    this.migrationPromise = pending;
    void pending.finally(() => {
      if (this.migrationPromise === pending) this.migrationPromise = null;
    }).catch(() => {});
    return pending;
  }

  async #migrate(generation, epoch, isCurrent) {
    const assertCurrent = () => {
      this.#assertCurrent(generation, epoch);
      if (isCurrent && isCurrent() !== true) throw cryptoError();
    };
    try {
      const delegate = await this.selection;
      assertCurrent();
      if (!this.localIdentity || delegate !== this.delegate) throw cryptoError();
      return await migrateLegacyMcpAuth({
        paths: this.paths,
        fs: this.fs,
        createLocalFileSafeStorage: this.createLocalFileSafeStorage,
        assertCurrent,
        rewrap: async () => {
          assertCurrent();
          if (this.migrationAttempted) throw cryptoError();
          this.migrationAttempted = true;
          const broker = this.createExternalBroker({
            paths: this.paths, callerRole: "agent-service",
            executablePath: this.executablePath, appRoot: this.appRoot,
            defaultApp: this.defaultApp, parentEnv: this.parentEnv,
            // Only explicit migration may wait for a user's Keychain prompt.
            requestTimeoutMs: 60_000, termGraceMs: this.termGraceMs,
            killConfirmMs: this.killConfirmMs,
          });
          if (!broker || typeof broker.open !== "function" || typeof broker.close !== "function"
            || typeof broker.rewrapLegacyMcpAuth !== "function") throw cryptoError();
          this.migrationBroker = broker;
          this.migrationBrokerClosePromise = null;
          try {
            await broker.open({ generation });
            assertCurrent();
            return await broker.rewrapLegacyMcpAuth({ generation });
          } finally {
            try { await this.#closeMigrationBroker(); }
            finally {
              if (this.migrationBroker === broker) {
                this.migrationBroker = null;
                this.migrationBrokerClosePromise = null;
              }
            }
          }
        },
      });
    } catch (error) {
      throw cryptoError(error?.code === "MCP_CRYPTO_MIGRATION_COMMIT_UNCERTAIN"
        ? error.code : undefined);
    }
  }

  #closeMigrationBroker() {
    if (!this.migrationBroker) return Promise.resolve();
    if (!this.migrationBrokerClosePromise) {
      const broker = this.migrationBroker;
      this.migrationBrokerClosePromise = Promise.resolve().then(() => broker.close()).catch(() => {
        this.cleanupFailed = true;
        throw cryptoError();
      });
    }
    return this.migrationBrokerClosePromise;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (!this.opened && !this.selection && !this.delegate) {
      return this.cleanupFailed ? Promise.reject(cryptoError()) : Promise.resolve();
    }

    const selection = this.selection;
    const delegate = this.delegate;
    const migration = this.migrationPromise;
    this.epoch += 1;
    this.opened = false;
    this.generation = 0;
    this.selection = null;
    this.delegate = null;
    this.localIdentity = false;

    const closing = (async () => {
      let closeFailed = this.cleanupFailed;
      try { await this.#closeMigrationBroker(); } catch { closeFailed = true; }
      if (migration) {
        try { await migration; } catch { /* retired generations cannot commit */ }
        closeFailed ||= this.cleanupFailed;
      }
      if (selection) {
        try { await selection; } catch { /* selection owns unpublished cleanup */ }
        closeFailed ||= this.cleanupFailed;
      }
      if (delegate) {
        try { await delegate.close(); } catch {
          this.cleanupFailed = true;
          closeFailed = true;
        }
      }
      if (closeFailed) throw cryptoError();
    })();
    this.closePromise = closing;
    void closing.finally(() => {
      if (this.closePromise === closing) this.closePromise = null;
    }).catch(() => {});
    return closing;
  }

  async #select(generation, epoch) {
    let delegate = null;
    let localStorage = null;
    try {
      this.#assertCurrent(generation, epoch);
      this.assertStableAppPaths({
        appPath: inferAppPath(this.executablePath, this.applicationsRoot),
        executablePath: this.executablePath,
        bootstrapPath: path.join(this.appRoot, "app", "bootstrap.js"),
        resourcesPath: this.resourcesPath,
      }, { applicationsRoot: this.applicationsRoot });
      this.#assertCurrent(generation, epoch);

      this.#assertCurrent(generation, epoch);
      const identity = await this.readCodeIdentityAsync(this.executablePath, {
        allowAdHocIdentifier: SHOGGOTH_APP_IDENTIFIER,
        allowLocalSignedIdentifier: SHOGGOTH_APP_IDENTIFIER,
      });
      const localIdentity = isLocalFileCryptoAppIdentity(identity);
      if (!this.#isCurrent(generation, epoch)) {
        // close 可能在异步 codesign 返回前撤销本代。若迟到结果证明这是本地
        // 分支，仍用 owned delegate 接管刚创建的 storage，再统一走 close 清零；
        // 该 delegate 从不 open、更不会发布。
        if (localIdentity) {
          localStorage = this.createLocalFileSafeStorage({
            paths: this.paths,
            readOnly: this.callerRole === "mcp",
          });
          delegate = new InProcessMcpCryptoBroker({
            paths: this.paths,
            callerRole: this.callerRole,
            safeStorage: localStorage,
            ownsSafeStorage: true,
          });
        }
        throw cryptoError();
      }
      this.#assertCurrent(generation, epoch);

      if (localIdentity) {
        localStorage = this.createLocalFileSafeStorage({
          paths: this.paths,
          readOnly: this.callerRole === "mcp",
        });
        this.#assertCurrent(generation, epoch);
        delegate = new InProcessMcpCryptoBroker({
          paths: this.paths,
          callerRole: this.callerRole,
          safeStorage: localStorage,
          ownsSafeStorage: true,
        });
      } else if (validDeveloperIdentity(identity)) {
        delegate = this.createExternalBroker({
          paths: this.paths,
          callerRole: this.callerRole,
          executablePath: this.executablePath,
          appRoot: this.appRoot,
          defaultApp: this.defaultApp,
          parentEnv: this.parentEnv,
          requestTimeoutMs: this.requestTimeoutMs,
          termGraceMs: this.termGraceMs,
          killConfirmMs: this.killConfirmMs,
        });
      } else {
        throw cryptoError();
      }
      if (!validDelegate(delegate)) throw cryptoError();
      this.#assertCurrent(generation, epoch);

      this.#assertCurrent(generation, epoch);
      await delegate.open({ generation });
      this.#assertCurrent(generation, epoch);
      this.delegate = delegate;
      this.localIdentity = localIdentity;
      localStorage = null;
      return delegate;
    } catch {
      let cleanupFailed = false;
      if (delegate) {
        try { await delegate.close(); } catch { cleanupFailed = true; }
      } else if (localStorage && typeof localStorage.close === "function") {
        try { await localStorage.close(); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) this.cleanupFailed = true;
      throw cryptoError();
    }
  }

  async #invoke(operation, ...args) {
    let result = null;
    const generation = this.generation;
    const epoch = this.epoch;
    const selection = this.selection;
    try {
      const operationOptions = operation === "encrypt" || operation === "decrypt"
        ? args[1]
        : args[0];
      const operationGeneration = operationOptions?.generation === undefined
        && (operation === "encrypt" || operation === "decrypt")
        ? generation
        : operationOptions?.generation;
      if (!Number.isSafeInteger(operationGeneration) || operationGeneration <= 0
        || operationGeneration !== generation || !selection) {
        throw cryptoError();
      }
      this.#assertCurrent(generation, epoch);
      this.#assertCurrent(generation, epoch);
      const delegate = await selection;
      this.#assertCurrent(generation, epoch);
      if (delegate !== this.delegate || typeof delegate?.[operation] !== "function") {
        throw cryptoError();
      }
      this.#assertCurrent(generation, epoch);
      result = await delegate[operation](...args);
      this.#assertCurrent(generation, epoch);
      return result;
    } catch (error) {
      if (Buffer.isBuffer(result)) result.fill(0);
      let code = null;
      try {
        if (error && typeof error === "object") code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      } catch { /* hostile diagnostics must not escape the fixed error boundary */ }
      if (this.#isCurrent(generation, epoch)
        && ["MCP_CRYPTO_BACKPRESSURE", "MCP_CRYPTO_CANCELED"].includes(code)) {
        throw cryptoError(code);
      }
      throw cryptoError();
    }
  }

  #assertCurrent(generation, epoch) {
    if (!this.#isCurrent(generation, epoch)) {
      throw cryptoError();
    }
  }

  #isCurrent(generation, epoch) {
    return this.opened && this.generation === generation && this.epoch === epoch;
  }
}

module.exports = { PackagedMcpCryptoBroker };
