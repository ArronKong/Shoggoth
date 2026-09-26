"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateRuntimeAccount } = require("./runtime-account");
const { resolveNativeHome } = require("./runtime-account-resolver");
const {
  RUNTIME_ACCOUNT_SERVICE_METHOD_SET,
  validateRuntimeAccountServiceParams,
  validateRuntimeAccountServiceResult,
} = require("./runtime-account-service-protocol");
const { inspectRuntimeStorage } = require("./runtime-storage-inspector");
const { serviceError } = require("./security");

function controllerError(code, message) {
  return serviceError(code, message);
}

function requireMethods(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw controllerError(
      "RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID",
      `${label} dependency is invalid`,
    );
  }
}

function safeStats(runtimeAccountId, scope, stats, available = true) {
  return {
    runtimeAccountId,
    scope,
    available,
    bytes: stats?.bytes || 0,
    files: stats?.files || 0,
    dirs: stats?.dirs || 0,
    symlinks: stats?.symlinks || 0,
    incomplete: stats?.incomplete || false,
    limitReason: stats?.limitReason || null,
  };
}

function pageById(items, cursor, limit) {
  const start = cursor === null
    ? 0 : items.findIndex((item) => item.id.localeCompare(cursor, "en") > 0);
  const offset = start === -1 ? items.length : start;
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    page,
    nextCursor: hasMore ? page.at(-1).id : null,
    hasMore,
  };
}

function pathExists(fileSystem, target) {
  try {
    fileSystem.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function defaultStorageReader(options) {
  const fileSystem = options.fs || fs;
  const parentEnv = options.parentEnv || process.env;
  const homedir = options.homedir || os.homedir;
  return (account) => {
    if (account.kind === "shoggoth-managed") {
      const root = path.join(
        options.paths.runtimeAccountsDir,
        account.runtime,
        account.id,
        "home",
      );
      if (!pathExists(fileSystem, root)) {
        return safeStats(account.id, "managed-account", null, false);
      }
      return safeStats(account.id, "managed-account", inspectRuntimeStorage(root, {
        ...options.scanLimits,
        fs: fileSystem,
        trustedRoot: path.resolve(options.paths.stateDir),
      }));
    }

    const nativeHome = resolveNativeHome(
      fileSystem,
      parentEnv,
      typeof homedir === "function" ? homedir() : homedir,
      account.runtime,
    );
    // XDG_DATA_HOME is shared by many apps; only OpenCode's child belongs to this account.
    const scanRoot = account.runtime === "opencode" ? path.join(nativeHome, "opencode") : nativeHome;
    if (!pathExists(fileSystem, scanRoot)) {
      return safeStats(account.id, "native-system", null, false);
    }
    return safeStats(account.id, "native-system", inspectRuntimeStorage(scanRoot, {
      // A live Home can be large. Return a lower bound within the RPC budget.
      maxDurationMs: 1_000,
      ...options.scanLimits,
      ignoreIpcEntries: true,
      fs: fileSystem,
      trustedRoot: scanRoot,
    }));
  };
}

class RuntimeAccountServiceController {
  constructor(options = {}) {
    requireMethods(
      options.productStore,
      ["listRuntimeAccounts", "getRuntimeAccount", "listAgentProfiles"],
      "ProductStore",
    );
    requireMethods(options.runtimeAccountAdmission, ["read"], "RuntimeAccountAdmission");
    requireMethods(
      options.accountAuthManager,
      ["read", "loginStart", "loginCancel", "logout"],
      "AccountAuthManager",
    );
    if (!options.paths?.stateDir || !options.paths?.runtimeAccountsDir) {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Service paths are invalid");
    }
    this.productStore = options.productStore;
    this.runtimeAccountAdmission = options.runtimeAccountAdmission;
    this.accountAuthManager = options.accountAuthManager;
    this.readStorage = options.readAccountStorage || defaultStorageReader(options);
    if (typeof this.readStorage !== "function") {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Storage reader is invalid");
    }
    this.opened = false;
  }

  open() {
    this.opened = true;
    return this;
  }

  close() {
    this.opened = false;
  }

  #assertOpen() {
    if (!this.opened) {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_CLOSED", "RuntimeAccount Service is closed");
    }
  }

  #accountsAndProfiles() {
    const accounts = this.productStore.listRuntimeAccounts()
      .map(validateRuntimeAccount)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const accountIds = new Set(accounts.map((account) => account.id));
    const profiles = require("./agent-runtime-profile-views").agentRuntimeProfileViews(this.productStore);
    if (!Array.isArray(profiles) || profiles.length > 10_000
      || profiles.some((profile) => !profile || typeof profile !== "object"
        || typeof profile.runtimeAccountId !== "string"
        || !accountIds.has(profile.runtimeAccountId))) {
      throw controllerError("RUNTIME_ACCOUNT_RESPONSE_INVALID", "Agent profiles are invalid");
    }
    return { accounts, profiles };
  }

  #accountSummary(account, profiles) {
    const admission = this.runtimeAccountAdmission.read(account.id);
    return {
      id: account.id,
      runtime: account.runtime,
      kind: account.kind,
      installationKind: account.installationKind,
      homeKind: account.homeKind,
      isDefault: account.isDefault,
      sharedAgentCount: new Set(profiles.filter(profile => profile.runtimeAccountId === account.id)
        .map(profile => profile.id)).size,
      admission: {
        generation: admission.generation,
        active: admission.active,
        maxActive: admission.maxActive,
        mutationActive: admission.mutationActive,
        backoffUntil: admission.backoffUntil,
      },
    };
  }

  #account(runtimeAccountId, accounts) {
    const account = accounts.find((candidate) => candidate.id === runtimeAccountId);
    if (!account) throw controllerError("RUNTIME_ACCOUNT_NOT_FOUND", "RuntimeAccount not found");
    return account;
  }

  #authAccount(runtimeAccountId, accounts) {
    const account = this.#account(runtimeAccountId, accounts);
    if (account.runtime !== "codex") {
      throw controllerError(
        "RUNTIME_ACCOUNT_AUTH_UNSUPPORTED",
        "RuntimeAccount Service authentication is unsupported for this runtime",
      );
    }
    return account;
  }

  async handle(method, input) {
    this.#assertOpen();
    if (!RUNTIME_ACCOUNT_SERVICE_METHOD_SET.has(method)) {
      throw controllerError("INVALID_PARAMS", "Unknown RuntimeAccount Service method");
    }
    const params = validateRuntimeAccountServiceParams(method, input);
    const { accounts, profiles } = this.#accountsAndProfiles();
    let result;

    if (method === "runtime.account.list") {
      const summaries = accounts.map((account) => this.#accountSummary(account, profiles));
      const page = pageById(summaries, params.cursor, params.limit);
      result = { accounts: page.page, nextCursor: page.nextCursor, hasMore: page.hasMore };
    } else if (method === "runtime.account.read") {
      result = { account: this.#accountSummary(this.#account(params.runtimeAccountId, accounts), profiles) };
    } else if (method === "runtime.account.auth.read") {
      this.#authAccount(params.runtimeAccountId, accounts);
      result = await this.accountAuthManager.read({ runtimeAccountId: params.runtimeAccountId });
    } else if (method === "runtime.account.login.start") {
      this.#authAccount(params.runtimeAccountId, accounts);
      result = await this.accountAuthManager.loginStart(params);
    } else if (method === "runtime.account.login.cancel") {
      this.#authAccount(params.runtimeAccountId, accounts);
      result = await this.accountAuthManager.loginCancel(params);
    } else if (method === "runtime.account.logout") {
      this.#authAccount(params.runtimeAccountId, accounts);
      result = await this.accountAuthManager.logout(params);
    } else if (method === "runtime.account.storage.read") {
      const account = this.#account(params.runtimeAccountId, accounts);
      result = await this.readStorage(account);
    } else {
      throw controllerError("INVALID_PARAMS", "Unknown RuntimeAccount Service method");
    }
    return validateRuntimeAccountServiceResult(method, result);
  }
}

function createRuntimeAccountServiceController(options = {}) {
  return new RuntimeAccountServiceController(options);
}

module.exports = {
  RuntimeAccountServiceController,
  createRuntimeAccountServiceController,
};
