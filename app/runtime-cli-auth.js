"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
  internalCodexHomePaths,
  resolveNativeHome,
  runtimeAccountIntegrationRoot,
  runtimePathsOverlap,
} = require("./agent-service/runtime-account-resolver");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
  NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
  NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
  NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
  NATIVE_PI_RUNTIME_ACCOUNT_ID,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("./agent-service/runtime-account");
const {
  resolveCodexRuntimeLayout,
  resolveCodexSystemBinary,
} = require("./agent-service/codex-runtime-paths");
const { resolveGrokBuildBinary } = require("./agent-service/grok-build-runtime-paths");
const { resolveAntigravityBinary } = require("./agent-service/antigravity-runtime-paths");
const { resolvePiBinary } = require("./agent-service/pi-runtime-paths");
const { resolveClaudeCodeBinary } = require("./agent-service/claude-code-runtime-paths");
const { resolveDeepSeekHarnessBinary } = require("./agent-service/deepseek-harness-runtime-paths");

const ACCOUNT_BY_ID = new Map(DEFAULT_RUNTIME_ACCOUNTS.map((account) => [account.id, account]));
const NATIVE_HOME_SEGMENTS = Object.freeze({
  codex: Object.freeze([".codex"]),
  "grok-build": Object.freeze([".grok"]),
  antigravity: Object.freeze([".gemini"]),
  pi: Object.freeze([".pi", "agent"]),
  "claude-code": Object.freeze([".claude"]),
  "deepseek-harness": Object.freeze([".dsh"]),
});
const AUTH_SPECS = Object.freeze([
  Object.freeze({
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    name: "Codex",
    homeEnv: "CODEX_HOME",
    credentialFile: "auth.json",
    credentialProbe: "file",
    loginArgs: Object.freeze([
      "-c", 'forced_login_method="chatgpt"', "login", "--device-auth",
    ]),
    logoutArgs: Object.freeze(["-c", 'forced_login_method="chatgpt"', "logout"]),
    docsUrl: "https://developers.openai.com/codex/auth/",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    name: "Codex",
    homeEnv: "CODEX_HOME",
    credentialFile: "auth.json",
    credentialProbe: "file",
    loginArgs: Object.freeze(["login", "--device-auth"]),
    logoutArgs: Object.freeze(["logout"]),
    docsUrl: "https://developers.openai.com/codex/auth/",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_GROK_BUILD_RUNTIME_ACCOUNT_ID,
    name: "Grok",
    homeEnv: "GROK_HOME",
    credentialFile: "auth.json",
    credentialProbe: "file",
    loginArgs: Object.freeze(["login", "--device-auth"]),
    logoutArgs: Object.freeze(["logout"]),
    docsUrl: "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
    name: "Antigravity",
    homeEnv: null,
    credentialFile: null,
    credentialProbe: "runtime",
    loginArgs: Object.freeze([]),
    logoutArgs: Object.freeze([]),
    docsUrl: "https://antigravity.google/docs/cli/install/",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID,
    name: "Pi",
    homeEnv: "PI_CODING_AGENT_DIR",
    credentialFile: "auth.json",
    credentialProbe: "file",
    loginArgs: Object.freeze([]),
    logoutArgs: Object.freeze([]),
    docsUrl: "https://pi.dev/docs/latest/providers",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID,
    name: "Claude Code",
    homeEnv: "CLAUDE_CONFIG_DIR",
    credentialFile: null,
    credentialProbe: "runtime",
    loginArgs: Object.freeze(["auth", "login", "--claudeai"]),
    logoutArgs: Object.freeze(["auth", "logout"]),
    docsUrl: "https://code.claude.com/docs/en/authentication",
  }),
  Object.freeze({
    runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
    name: "DeepSeek Harness",
    homeEnv: "DSH_HOME",
    credentialFile: null,
    credentialProbe: "runtime",
    loginArgs: Object.freeze(["web", "--no-open", "--port", "0"]),
    logoutArgs: Object.freeze([]),
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  }),
]);

function directoryState(fileSystem, target) {
  try {
    const stat = fileSystem.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      return { state: "unsafe", path: target };
    }
    return { state: "safe", path: fileSystem.realpathSync(target) };
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "unsafe", path: target };
  }
}

function resolveManagedCodexHome(paths, fileSystem) {
  const legacyHome = path.join(
    paths.stateDir,
    "codex",
    LEGACY_DEFAULT_SHOGGOTH_RUNTIME_PROFILE_ID,
  );
  const accountHome = path.join(
    paths.runtimeAccountsDir,
    "codex",
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    "home",
  );
  const legacy = directoryState(fileSystem, legacyHome);
  const account = directoryState(fileSystem, accountHome);
  const unsafe = legacy.state === "unsafe" || account.state === "unsafe";
  const conflict = legacy.state === "safe" && account.state === "safe";
  return {
    home: legacy.state === "safe" ? legacy.path
      : account.state === "safe" ? account.path : accountHome,
    error: unsafe ? "Internal Codex Home is invalid or unsafe"
      : conflict ? "Both legacy and account-scoped internal Codex Homes exist" : null,
  };
}

function nativeHomeFallback(userHome, runtime) {
  return path.join(userHome, ...NATIVE_HOME_SEGMENTS[runtime]);
}

function resolveAccountHome(spec, account, options) {
  if (account.kind === "shoggoth-managed") {
    return resolveManagedCodexHome(options.paths, options.fs);
  }
  if (account.id === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID) {
    return {
      home: path.join(
        options.paths.runtimeIntegrationDir,
        "antigravity",
        account.id,
        "home",
      ),
      error: null,
    };
  }
  try {
    return {
      home: resolveNativeHome(options.fs, options.parentEnv, options.userHome, account.runtime),
      error: null,
    };
  } catch {
    return {
      home: nativeHomeFallback(options.userHome, account.runtime),
      error: `${spec.name} CLI Home is invalid or unsafe`,
    };
  }
}

function resolveBinary(account, options) {
  if (account.kind === "shoggoth-managed") {
    return options.resolveBundledCodexLayout({
      repoRoot: options.repoRoot,
      packaged: options.packaged,
      resourcesPath: options.resourcesPath,
      platform: options.platform,
      arch: options.arch,
    }).runtimePath;
  }
  const binaryOptions = {
    parentEnv: options.parentEnv,
    homedir: options.userHome,
    fs: options.fs,
  };
  return options.binaryResolvers[account.runtime](binaryOptions);
}

function authorityConflictReason(account, options) {
  let nativeHome;
  try {
    nativeHome = resolveNativeHome(options.fs, options.parentEnv, options.userHome, account.runtime);
  } catch {
    return account.id === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID
      ? "Antigravity CLI Home is invalid or unsafe"
      : null;
  }
  if (account.runtime === "codex") {
    return internalCodexHomePaths(options.paths).some((managedHome) => (
      runtimePathsOverlap(nativeHome, managedHome)
    )) ? "Native and Shoggoth-managed Codex Homes overlap" : null;
  }
  if (account.id === NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID
    || account.id === NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID) {
    const integrationRoot = runtimeAccountIntegrationRoot(
      options.paths,
      account.runtime,
      account.id,
    );
    return runtimePathsOverlap(nativeHome, integrationRoot)
      ? `Native ${account.runtime === "antigravity" ? "Antigravity" : "DeepSeek Harness"} Home overlaps its Shoggoth integration Home`
      : null;
  }
  return null;
}

function createRuntimeCliAuth(options = {}) {
  const fileSystem = options.fs || fs;
  const parentEnv = options.parentEnv || process.env;
  const rawUserHome = typeof options.homedir === "function"
    ? options.homedir() : options.homedir || os.homedir();
  if (!options.paths || typeof options.paths.stateDir !== "string"
    || typeof options.paths.runtimeAccountsDir !== "string"
    || typeof options.paths.runtimeIntegrationDir !== "string"
    || typeof rawUserHome !== "string" || !path.isAbsolute(rawUserHome)) {
    throw new TypeError("Runtime CLI auth paths are invalid");
  }
  const userHome = path.resolve(rawUserHome);
  const context = {
    paths: options.paths,
    fs: fileSystem,
    parentEnv,
    userHome,
    repoRoot: options.repoRoot,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    platform: options.platform,
    arch: options.arch,
    resolveBundledCodexLayout: options.resolveBundledCodexLayout || resolveCodexRuntimeLayout,
    binaryResolvers: {
      codex: resolveCodexSystemBinary,
      "grok-build": resolveGrokBuildBinary,
      antigravity: resolveAntigravityBinary,
      pi: resolvePiBinary,
      "claude-code": resolveClaudeCodeBinary,
      "deepseek-harness": resolveDeepSeekHarnessBinary,
      ...(options.binaryResolvers || {}),
    },
  };
  return AUTH_SPECS.filter((spec) => require("./runtime-availability")
    .isRuntimeAvailable(ACCOUNT_BY_ID.get(spec.runtimeAccountId).runtime)).map((spec) => {
    const account = ACCOUNT_BY_ID.get(spec.runtimeAccountId);
    const accountHome = resolveAccountHome(spec, account, context);
    const authorityConflict = authorityConflictReason(account, context);
    let binaryPath = null;
    let unavailableReason = accountHome.error || authorityConflict;
    if (!unavailableReason) {
      try {
        binaryPath = resolveBinary(account, context);
      } catch {
        unavailableReason = `${spec.name} CLI is not installed or executable`;
      }
    }
    return Object.freeze({
      runtime: account.runtime,
      runtimeAccountId: account.id,
      name: spec.name,
      binaryPath,
      ...(binaryPath === null ? { unavailableReason } : {}),
      accountHome: path.resolve(accountHome.home),
      processHome: account.runtime === "antigravity"
        ? path.resolve(accountHome.home) : userHome,
      homeEnv: spec.homeEnv,
      accountKind: account.kind,
      credentialFile: spec.credentialFile,
      credentialProbe: spec.credentialProbe,
      loginArgs: authorityConflict ? Object.freeze([]) : spec.loginArgs,
      logoutArgs: authorityConflict ? Object.freeze([]) : spec.logoutArgs,
      docsUrl: spec.docsUrl,
    });
  });
}

module.exports = { AUTH_SPECS, createRuntimeCliAuth };
