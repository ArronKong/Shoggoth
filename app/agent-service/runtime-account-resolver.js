"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeBinding } = require("./runtime-adapter");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  validateRuntimeAccount,
} = require("./runtime-account");
const {
  CODEX_APP_SERVER_ARGS,
  prepareCodexRuntimeAccountHome,
  resolveCodexRuntimeLayout,
  resolveCodexSystemBinary,
} = require("./codex-runtime-paths");
const { resolveGrokBuildBinary } = require("./grok-build-runtime-paths");
const {
  prepareAntigravityRuntimeAccountHome,
  resolveAntigravityBinary,
} = require("./antigravity-runtime-paths");
const { resolvePiBinary } = require("./pi-runtime-paths");
const { resolveClaudeCodeBinary } = require("./claude-code-runtime-paths");
const { resolveOpenCodeBinary } = require("./opencode-runtime-paths");
const { resolveDeepSeekHarnessBinary } = require("./deepseek-harness-runtime-paths");
const { serviceError } = require("./security");

const DEFAULT_ACCOUNT_BY_ID = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]),
);
const NATIVE_HOME = Object.freeze({
  codex: Object.freeze({ env: "CODEX_HOME", segments: Object.freeze([".codex"]) }),
  "grok-build": Object.freeze({ env: "GROK_HOME", segments: Object.freeze([".grok"]) }),
  antigravity: Object.freeze({ env: null, segments: Object.freeze([".gemini"]) }),
  pi: Object.freeze({ env: "PI_CODING_AGENT_DIR", segments: Object.freeze([".pi", "agent"]) }),
  "claude-code": Object.freeze({ env: "CLAUDE_CONFIG_DIR", segments: Object.freeze([".claude"]) }),
  opencode: Object.freeze({ env: "XDG_DATA_HOME", segments: Object.freeze([".local", "share"]) }),
  "deepseek-harness": Object.freeze({ env: "DSH_HOME", segments: Object.freeze([".dsh"]) }),
});

function resolverError(code, message) {
  return serviceError(code, message);
}

function runtimePathsOverlap(left, right) {
  if (typeof left !== "string" || !path.isAbsolute(left)
    || typeof right !== "string" || !path.isAbsolute(right)) return false;
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  const leftToRight = path.relative(resolvedLeft, resolvedRight);
  const rightToLeft = path.relative(resolvedRight, resolvedLeft);
  const contained = (relative) => relative === ""
    || (!path.isAbsolute(relative) && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
  return contained(leftToRight) || contained(rightToLeft);
}

function assertRuntimeHomesSeparated(left, right, label) {
  if (runtimePathsOverlap(left, right)) {
    throw resolverError(
      "RUNTIME_ACCOUNT_HOME_CONFLICT",
      `${label} must not overlap another RuntimeAccount authority`,
    );
  }
}

function internalCodexHomePaths(paths) {
  return Object.freeze([
    path.join(
      paths.runtimeAccountsDir || path.join(paths.stateDir, "runtime-accounts"),
      "codex",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      "home",
    ),
  ]);
}

function runtimeAccountIntegrationRoot(paths, runtime, runtimeAccountId) {
  return path.join(
    paths.runtimeIntegrationDir || path.join(paths.stateDir, "runtime-integration"),
    runtime,
    runtimeAccountId,
  );
}

function defaultRuntimeAccountLookup(runtimeAccountId) {
  return DEFAULT_ACCOUNT_BY_ID.get(runtimeAccountId) || null;
}

function ownedCanonicalDirectory(fileSystem, target, code, label) {
  let stat;
  try {
    stat = fileSystem.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw resolverError(code, `${label} is unavailable`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw resolverError(code, `${label} is not a safe user-owned directory`);
  }
  let resolved;
  try {
    resolved = fileSystem.realpathSync(target);
  } catch {
    throw resolverError(code, `${label} cannot be resolved`);
  }
  if (!path.isAbsolute(resolved)) {
    throw resolverError(code, `${label} did not resolve to an absolute directory`);
  }
  return path.resolve(resolved);
}

function canonicalMissingPath(fileSystem, target, code, label) {
  const suffix = [];
  let cursor = path.resolve(target);
  for (;;) {
    const existing = ownedCanonicalDirectory(fileSystem, cursor, code, label);
    if (existing !== null) return path.join(existing, ...suffix.reverse());
    const parent = path.dirname(cursor);
    if (parent === cursor) throw resolverError(code, `${label} has no safe existing ancestor`);
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
}

function resolveUserHome(fileSystem, value) {
  const candidate = typeof value === "function" ? value() : value;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw resolverError("RUNTIME_ACCOUNT_HOME_INVALID", "The OS user Home is invalid");
  }
  const resolved = ownedCanonicalDirectory(
    fileSystem,
    path.resolve(candidate),
    "RUNTIME_ACCOUNT_HOME_INVALID",
    "The OS user Home",
  );
  if (resolved === null) {
    throw resolverError("RUNTIME_ACCOUNT_HOME_MISSING", "The OS user Home does not exist");
  }
  return resolved;
}

function resolveNativeHome(fileSystem, parentEnv, userHome, runtime) {
  const spec = NATIVE_HOME[runtime];
  if (!spec) throw resolverError("RUNTIME_ACCOUNT_UNSUPPORTED", `Unsupported runtime: ${runtime}`);
  const explicit = spec.env === null ? undefined : parentEnv[spec.env];
  if (explicit !== undefined && (typeof explicit !== "string" || explicit.length === 0
    || explicit.includes("\0") || !path.isAbsolute(explicit))) {
    throw resolverError("RUNTIME_ACCOUNT_HOME_INVALID", `${spec.env} must be an absolute path`);
  }
  const requested = path.resolve(explicit || path.join(userHome, ...spec.segments));
  const existing = ownedCanonicalDirectory(
    fileSystem,
    requested,
    "RUNTIME_ACCOUNT_HOME_INVALID",
    `${runtime} Home`,
  );
  return existing || canonicalMissingPath(
    fileSystem,
    requested,
    "RUNTIME_ACCOUNT_HOME_INVALID",
    `${runtime} Home`,
  );
}

function resolveOpenCodeConfigHome(fileSystem, parentEnv, userHome) {
  const explicit = parentEnv.XDG_CONFIG_HOME;
  if (explicit !== undefined && (typeof explicit !== "string" || explicit.length === 0
    || explicit.includes("\0") || !path.isAbsolute(explicit))) {
    throw resolverError("RUNTIME_ACCOUNT_HOME_INVALID", "XDG_CONFIG_HOME must be an absolute path");
  }
  const requested = path.resolve(explicit || path.join(userHome, ".config"));
  return ownedCanonicalDirectory(fileSystem, requested, "RUNTIME_ACCOUNT_HOME_INVALID",
    "OpenCode config Home") || canonicalMissingPath(fileSystem, requested,
    "RUNTIME_ACCOUNT_HOME_INVALID", "OpenCode config Home");
}

function frozenEnvironment(value) {
  return Object.freeze({
    runtime: value.runtime,
    runtimeAccountId: value.runtimeAccountId,
    kind: value.kind,
    installationKind: value.installationKind,
    homeKind: value.homeKind,
    strategy: value.strategy,
    home: value.home,
    nativeHome: value.nativeHome,
    configSourceHome: value.configSourceHome || null,
    integrationRoot: value.integrationRoot,
    binaryPath: value.binaryPath,
    launchArgs: Object.freeze([...(value.launchArgs || [])]),
    spawnEnv: Object.freeze({ ...(value.spawnEnv || {}) }),
    configurationMode: value.configurationMode,
  });
}

function validateResolvedEnvironment(environment, bindingValue) {
  const binding = runtimeBinding(bindingValue);
  const homeEnvKey = {
    codex: "CODEX_HOME",
    "grok-build": "GROK_HOME",
    antigravity: "HOME",
    pi: "PI_CODING_AGENT_DIR",
    "claude-code": "CLAUDE_CONFIG_DIR",
    opencode: "XDG_DATA_HOME",
    "deepseek-harness": "DSH_HOME",
  }[binding.runtime];
  const configurationMode = binding.runtime === "codex" ? "overlay"
    : binding.runtime === "antigravity" || binding.runtime === "deepseek-harness"
      ? "integration" : "native";
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
    || !Object.isFrozen(environment)
    || environment.runtime !== binding.runtime
    || environment.runtimeAccountId !== binding.runtimeAccountId
    || typeof environment.home !== "string" || !path.isAbsolute(environment.home)
    || typeof environment.binaryPath !== "string" || !path.isAbsolute(environment.binaryPath)
    || !Array.isArray(environment.launchArgs) || !Object.isFrozen(environment.launchArgs)
    || !environment.spawnEnv || typeof environment.spawnEnv !== "object"
    || Array.isArray(environment.spawnEnv) || !Object.isFrozen(environment.spawnEnv)
    || typeof environment.spawnEnv.HOME !== "string"
    || !path.isAbsolute(environment.spawnEnv.HOME)
    || typeof environment.spawnEnv[homeEnvKey] !== "string"
    || !path.isAbsolute(environment.spawnEnv[homeEnvKey])
    || (binding.runtime === "opencode"
      && (typeof environment.configSourceHome !== "string"
        || !path.isAbsolute(environment.configSourceHome)))
    || environment.configurationMode !== configurationMode) {
    throw resolverError(
      "RUNTIME_ACCOUNT_ENVIRONMENT_INVALID",
      "Runtime account environment is invalid",
    );
  }
  return environment;
}

class RuntimeAccountResolver {
  constructor(options = {}) {
    this.paths = options.paths || null;
    this.fs = options.fs || fs;
    this.parentEnv = options.parentEnv || process.env;
    this.userHome = resolveUserHome(this.fs, options.homedir || os.homedir());
    this.repoRoot = options.repoRoot;
    this.packaged = options.packaged;
    this.resourcesPath = options.resourcesPath;
    this.platform = options.platform;
    this.arch = options.arch;
  }

  resolve(bindingValue, accountValue, options = {}) {
    const binding = runtimeBinding(bindingValue);
    let account;
    try {
      account = validateRuntimeAccount(accountValue);
    } catch (error) {
      if (error?.code !== "RUNTIME_ACCOUNT_INVALID") throw error;
      throw resolverError("RUNTIME_ACCOUNT_NOT_FOUND", "Runtime account is missing or invalid");
    }
    if (account.id !== binding.runtimeAccountId || account.runtime !== binding.runtime) {
      throw resolverError(
        "RUNTIME_ACCOUNT_BINDING_MISMATCH",
        "Runtime binding does not match its RuntimeAccount",
      );
    }
    if (account.kind === "native-user") {
      return this._resolveNative(binding, account, options);
    }
    return this._resolveManaged(binding, account, options);
  }

  _resolveManaged(binding, account, options) {
    if (account.runtime !== "codex") {
      throw resolverError(
        "RUNTIME_ACCOUNT_INSTALLATION_UNSUPPORTED",
        "Only Codex has a bundled Shoggoth-managed installation",
      );
    }
    if (!this.paths) {
      throw resolverError("RUNTIME_ACCOUNT_PATHS_REQUIRED", "Managed RuntimeAccount paths are required");
    }
    let home;
    const nativeCodexHome = (() => {
      try {
        return resolveNativeHome(this.fs, this.parentEnv, this.userHome, "codex");
      } catch {
        // The bundled Runtime does not depend on a usable native Codex Home.
        // A malformed native setting will still fail if that native account is used.
        return null;
      }
    })();
    const accountHome = path.join(this.paths.runtimeAccountsDir, "codex", account.id, "home");
    if (nativeCodexHome !== null) assertRuntimeHomesSeparated(nativeCodexHome, accountHome, "Native and managed Codex Homes");
    home = prepareCodexRuntimeAccountHome(this.paths, account.id);
    const layout = resolveCodexRuntimeLayout({
      repoRoot: options.repoRoot ?? this.repoRoot,
      packaged: options.packaged ?? this.packaged,
      resourcesPath: options.resourcesPath ?? this.resourcesPath,
      platform: options.platform ?? this.platform,
      arch: options.arch ?? this.arch,
    });
    return frozenEnvironment({
      runtime: binding.runtime,
      runtimeAccountId: binding.runtimeAccountId,
      kind: account.kind,
      installationKind: account.installationKind,
      homeKind: account.homeKind,
      strategy: "managed-shared",
      home,
      nativeHome: null,
      integrationRoot: null,
      binaryPath: layout.runtimePath,
      launchArgs: layout.args,
      spawnEnv: { HOME: this.userHome, CODEX_HOME: home },
      configurationMode: "overlay",
    });
  }

  _resolveNative(binding, account, options) {
    const runtime = binding.runtime;
    const nativeHome = resolveNativeHome(this.fs, this.parentEnv, this.userHome, runtime);
    const binaryOptions = {
      binaryPath: options.binaryPath,
      parentEnv: this.parentEnv,
      homedir: this.userHome,
      fs: this.fs,
    };
    let binaryPath;
    let home = nativeHome;
    let integrationRoot = null;
    let configSourceHome = null;
    let strategy = "native";
    let spawnEnv;
    if (runtime === "codex") {
      if (this.paths) {
        for (const managedHome of internalCodexHomePaths(this.paths)) {
          assertRuntimeHomesSeparated(nativeHome, managedHome, "Native and bundled Codex Homes");
        }
      }
      binaryPath = resolveCodexSystemBinary(binaryOptions);
      spawnEnv = { HOME: this.userHome, CODEX_HOME: nativeHome };
    } else if (runtime === "grok-build") {
      binaryPath = resolveGrokBuildBinary(binaryOptions);
      spawnEnv = { HOME: this.userHome, GROK_HOME: nativeHome };
    } else if (runtime === "antigravity") {
      binaryPath = resolveAntigravityBinary(binaryOptions);
      if (!this.paths) {
        throw resolverError(
          "RUNTIME_ACCOUNT_PATHS_REQUIRED",
          "Antigravity integration paths are required",
        );
      }
      // agy 1.1.x has no supported per-process MCP config overlay. Keep one
      // Shoggoth-owned Home per account so native ~/.gemini is never rewritten.
      integrationRoot = runtimeAccountIntegrationRoot(
        this.paths,
        runtime,
        binding.runtimeAccountId,
      );
      assertRuntimeHomesSeparated(
        nativeHome,
        integrationRoot,
        "Native Antigravity and Shoggoth integration Homes",
      );
      home = prepareAntigravityRuntimeAccountHome(this.paths, binding.runtimeAccountId);
      strategy = "account-integration";
      spawnEnv = { HOME: home };
    } else if (runtime === "pi") {
      binaryPath = resolvePiBinary(binaryOptions);
      spawnEnv = { HOME: this.userHome, PI_CODING_AGENT_DIR: nativeHome };
    } else if (runtime === "claude-code") {
      binaryPath = resolveClaudeCodeBinary(binaryOptions);
      spawnEnv = { HOME: this.userHome, CLAUDE_CONFIG_DIR: nativeHome };
    } else if (runtime === "opencode") {
      binaryPath = resolveOpenCodeBinary(binaryOptions);
      configSourceHome = resolveOpenCodeConfigHome(this.fs, this.parentEnv, this.userHome);
      spawnEnv = { HOME: this.userHome, XDG_DATA_HOME: nativeHome };
    } else if (runtime === "deepseek-harness") {
      binaryPath = resolveDeepSeekHarnessBinary(binaryOptions);
      if (!this.paths) {
        throw resolverError(
          "RUNTIME_ACCOUNT_PATHS_REQUIRED",
          "DeepSeek integration paths are required",
        );
      }
      integrationRoot = runtimeAccountIntegrationRoot(
        this.paths,
        runtime,
        binding.runtimeAccountId,
      );
      assertRuntimeHomesSeparated(
        nativeHome,
        integrationRoot,
        "Native DeepSeek and Shoggoth integration Homes",
      );
      strategy = "native-with-account-integration";
      spawnEnv = { HOME: this.userHome, DSH_HOME: nativeHome };
    } else {
      throw resolverError("RUNTIME_ACCOUNT_UNSUPPORTED", `Unsupported runtime: ${runtime}`);
    }
    return frozenEnvironment({
      runtime,
      runtimeAccountId: binding.runtimeAccountId,
      kind: account.kind,
      installationKind: account.installationKind,
      homeKind: account.homeKind,
      strategy,
      home,
      nativeHome,
      configSourceHome,
      integrationRoot,
      binaryPath,
      launchArgs: runtime === "codex" ? CODEX_APP_SERVER_ARGS : [],
      spawnEnv,
      configurationMode: runtime === "codex" ? "overlay"
        : runtime === "antigravity" || runtime === "deepseek-harness"
          ? "integration" : "native",
    });
  }
}

module.exports = {
  assertRuntimeHomesSeparated,
  resolveUserHome,
  RuntimeAccountResolver,
  defaultRuntimeAccountLookup,
  internalCodexHomePaths,
  resolveNativeHome,
  runtimeAccountIntegrationRoot,
  runtimePathsOverlap,
  validateResolvedEnvironment,
};
