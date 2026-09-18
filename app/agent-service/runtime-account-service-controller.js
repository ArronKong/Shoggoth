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

const DEFAULT_INVENTORY_CACHE_MS = 1_000;
const MAX_INVENTORY_CACHE_MS = 10_000;

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

function projectLegacyHome(entry) {
  return {
    id: entry.id,
    runtime: entry.runtime,
    runtimeAccountId: entry.runtimeAccountId,
    accountKind: entry.accountKind,
    role: entry.role,
    affectedAgentCount: entry.profileIds.length,
    bytes: entry.stats.bytes,
    files: entry.stats.files,
    dirs: entry.stats.dirs,
    symlinks: entry.stats.symlinks,
    incomplete: entry.stats.incomplete,
    lastModifiedAt: entry.lastModifiedAt,
  };
}

function projectBackup(entry) {
  return {
    id: entry.id,
    category: entry.category,
    role: entry.role,
    bytes: entry.stats.bytes,
    files: entry.stats.files,
    dirs: entry.stats.dirs,
    symlinks: entry.stats.symlinks,
    incomplete: entry.stats.incomplete,
    lastModifiedAt: entry.lastModifiedAt,
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

function inventorySignature(accounts, profiles) {
  const accountProjection = accounts.map((account) => [
    account.id, account.runtime, account.kind,
  ]);
  const profileProjection = profiles.map((profile) => [
    profile.id,
    profile.runtime,
    profile.runtimeProfileId,
    profile.runtimeAccountId,
    profile.isDefault,
  ]).map(JSON.stringify).sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify([accountProjection, profileProjection]);
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
  return (account, manifest) => {
    if (account.kind === "shoggoth-managed") {
      const canonical = manifest.entries.find((entry) => (
        entry.runtimeAccountId === account.id && entry.role === "canonical"
      ));
      if (canonical) return safeStats(account.id, "managed-legacy", canonical.stats);
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
    if (!pathExists(fileSystem, nativeHome)) {
      return safeStats(account.id, "native-system", null, false);
    }
    return safeStats(account.id, "native-system", inspectRuntimeStorage(nativeHome, {
      // A live Home can be large. Return a lower bound within the RPC budget.
      maxDurationMs: 1_000,
      ...options.scanLimits,
      ignoreIpcEntries: true,
      fs: fileSystem,
      trustedRoot: nativeHome,
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
    requireMethods(options.legacyRuntimeHomeStore, ["refresh"], "LegacyRuntimeHomeStore");
    requireMethods(options.runtimeStorageCleanup, ["prepare", "commit", "close"], "RuntimeStorageCleanup");
    requireMethods(options.runtimeBackupStore, ["refresh"], "RuntimeBackupStore");
    requireMethods(options.runtimeBackupCleanup, ["prepare", "commit", "close"], "RuntimeBackupCleanup");
    if (!options.paths?.stateDir || !options.paths?.runtimeAccountsDir || !options.paths?.backupsDir) {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Service paths are invalid");
    }
    this.productStore = options.productStore;
    this.runtimeAccountAdmission = options.runtimeAccountAdmission;
    this.accountAuthManager = options.accountAuthManager;
    this.legacyRuntimeHomeStore = options.legacyRuntimeHomeStore;
    this.runtimeStorageCleanup = options.runtimeStorageCleanup;
    this.runtimeBackupStore = options.runtimeBackupStore;
    this.runtimeBackupCleanup = options.runtimeBackupCleanup;
    this.readStorage = options.readAccountStorage || defaultStorageReader(options);
    if (typeof this.readStorage !== "function") {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Storage reader is invalid");
    }
    this.now = options.now || Date.now;
    this.inventoryCacheMs = options.inventoryCacheMs ?? DEFAULT_INVENTORY_CACHE_MS;
    if (typeof this.now !== "function" || !Number.isSafeInteger(this.inventoryCacheMs)
      || this.inventoryCacheMs < 0 || this.inventoryCacheMs > MAX_INVENTORY_CACHE_MS) {
      throw controllerError(
        "RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID",
        "Inventory cache options are invalid",
      );
    }
    this.inventoryCache = null;
    this.backupInventoryCache = null;
    this.opened = false;
  }

  open() {
    this.opened = true;
    return this;
  }

  close() {
    this.opened = false;
    this.inventoryCache = null;
    this.backupInventoryCache = null;
    this.runtimeStorageCleanup.close();
    this.runtimeBackupCleanup.close();
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
    const profiles = this.productStore.listAgentProfiles();
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
      sharedAgentCount: profiles.reduce(
        (count, profile) => count + Number(profile.runtimeAccountId === account.id),
        0,
      ),
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

  #inventory(accounts, profiles) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Inventory clock is invalid");
    }
    const signature = inventorySignature(accounts, profiles);
    const cached = this.inventoryCache;
    if (this.inventoryCacheMs > 0 && cached && cached.signature === signature
      && now >= cached.cachedAt && now - cached.cachedAt < this.inventoryCacheMs) {
      return cached.manifest;
    }
    const manifest = this.legacyRuntimeHomeStore.refresh({ accounts, profiles });
    this.inventoryCache = { signature, cachedAt: now, manifest };
    return manifest;
  }

  #backupInventory() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw controllerError("RUNTIME_ACCOUNT_SERVICE_OPTIONS_INVALID", "Inventory clock is invalid");
    }
    const cached = this.backupInventoryCache;
    if (this.inventoryCacheMs > 0 && cached && now >= cached.cachedAt
      && now - cached.cachedAt < this.inventoryCacheMs) {
      return cached.manifest;
    }
    const manifest = this.runtimeBackupStore.refresh();
    this.backupInventoryCache = { cachedAt: now, manifest };
    return manifest;
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
      const manifest = account.kind === "shoggoth-managed"
        ? this.#inventory(accounts, profiles) : { entries: [] };
      result = await this.readStorage(account, manifest);
    } else if (method === "runtime.account.legacyHomes.list") {
      if (params.runtimeAccountId !== null) this.#account(params.runtimeAccountId, accounts);
      const manifest = this.#inventory(accounts, profiles);
      const homes = manifest.entries
        .filter((entry) => params.runtimeAccountId === null
          || entry.runtimeAccountId === params.runtimeAccountId)
        .map(projectLegacyHome)
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const page = pageById(homes, params.cursor, params.limit);
      result = { homes: page.page, nextCursor: page.nextCursor, hasMore: page.hasMore };
    } else if (method === "runtime.account.backups.list") {
      const backups = this.#backupInventory().entries
        .map(projectBackup)
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
      const page = pageById(backups, params.cursor, params.limit);
      result = { backups: page.page, nextCursor: page.nextCursor, hasMore: page.hasMore };
    } else if (method === "runtime.account.legacyHomes.cleanup.prepare") {
      result = await this.runtimeStorageCleanup.prepare(params);
    } else if (method === "runtime.account.legacyHomes.cleanup.commit") {
      try {
        result = await this.runtimeStorageCleanup.commit(params);
      } finally {
        this.inventoryCache = null;
      }
    } else if (method === "runtime.account.backups.cleanup.prepare") {
      result = await this.runtimeBackupCleanup.prepare(params);
    } else if (method === "runtime.account.backups.cleanup.commit") {
      try {
        result = await this.runtimeBackupCleanup.commit(params);
      } finally {
        this.backupInventoryCache = null;
      }
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
  DEFAULT_INVENTORY_CACHE_MS,
  RuntimeAccountServiceController,
  createRuntimeAccountServiceController,
  projectRuntimeBackup: projectBackup,
  projectLegacyRuntimeHome: projectLegacyHome,
};
