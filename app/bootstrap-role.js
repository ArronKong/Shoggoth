"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { assertStableAppPaths, inferAppPath } = require("./agent-service/bundle-paths");
const {
  CODEX_DESIGNATED_REQUIREMENT,
  CODEX_TEAM_IDENTIFIER,
  assertCodeIdentity,
} = require("./agent-service/code-identity");
const { resolveCanonicalServicePaths } = require("./agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID } = require("./agent-service/runtime-account");
const { resolveCodexMcpParentBinaries } = require("./agent-service/codex-runtime-paths");
const { CODEX_PARENT_VERIFY_TIMEOUT_MS } = require("./agent-service/codex-startup-timeouts");
const {
  FEDERATION_MCP_CLIENTS,
  federationMcpAuthPath,
  loadFederationMcpCredential,
} = require("./agent-service/federation-mcp-auth");

const ROLE_PREFIX = "--shoggoth-internal-role=";
const INTERNAL_LAUNCH_MARKER = "launch-agent-v1";
const LAUNCH_AGENT_LABEL = "com.shoggoth.agent-service";
const PUBLIC_BOOTSTRAP_FAILURE_CODES = new Set([
  "BOOTSTRAP_ROLE_REJECTED",
  "BOOTSTRAP_CODE_IDENTITY_TIMEOUT",
  "BOOTSTRAP_CODE_IDENTITY_INVALID",
  "BOOTSTRAP_MCP_START_FAILED",
  "MCP_HELPER_ARGUMENTS_INVALID",
  "MCP_HELPER_AUTH_FAILED",
  "MCP_HELPER_FAILED",
]);

function bootstrapFailure(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function bootstrapFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && PUBLIC_BOOTSTRAP_FAILURE_CODES.has(descriptor.value)
      ? descriptor.value : "BOOTSTRAP_FAILED";
  } catch {
    return "BOOTSTRAP_FAILED";
  }
}

function secureEqual(left, right) {
  const a = Buffer.from(typeof left === "string" ? left : "");
  const b = Buffer.from(typeof right === "string" ? right : "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTestRoleGate(env, runtime) {
  if (env.NODE_ENV !== "test" || runtime.defaultApp !== true) return false;
  const gatePath = env.SHOGGOTH_TEST_ROLE_GATE_FILE;
  const expectedNonce = env.SHOGGOTH_TEST_ROLE_GATE_NONCE;
  if (!path.isAbsolute(gatePath || "") || !expectedNonce) return false;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(gatePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    const gate = JSON.parse(fs.readFileSync(fd, "utf8"));
    return gate.parentPid === runtime.ppid && secureEqual(gate.nonce, expectedNonce);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateInternalRoleGate(env, runtime = {}) {
  const actual = {
    platform: runtime.platform || process.platform,
    execPath: runtime.execPath || process.execPath,
    resourcesPath: runtime.resourcesPath || process.resourcesPath || "",
    ppid: runtime.ppid ?? process.ppid,
    defaultApp: runtime.defaultApp ?? process.defaultApp,
  };
  if (verifyTestRoleGate(env, actual)) return;
  if (actual.platform !== "darwin" || actual.defaultApp === true || actual.ppid !== 1) {
    throw new Error("Service role 来源不是受信 packaged launchd parent");
  }
  const executable = path.resolve(actual.execPath);
  const applicationsRoot = path.resolve(runtime.applicationsRoot || "/Applications");
  const appPath = inferAppPath(executable, applicationsRoot);
  if (!appPath || path.dirname(executable) !== path.join(appPath, "Contents", "MacOS")) {
    throw new Error("Service role executable 不是 packaged /Applications 路径");
  }
  const resourcesPath = path.resolve(actual.resourcesPath);
  const expectedResources = path.join(appPath, "Contents", "Resources");
  const expectedBootstrap = path.join(expectedResources, "app.asar", "app", "bootstrap.js");
  if (resourcesPath !== expectedResources) throw new Error("Service role resources 路径与 App 不一致");
  if (env.SHOGGOTH_BOOTSTRAP_PATH !== expectedBootstrap) throw new Error("Service role bootstrap 路径校验失败");
  if (env.SHOGGOTH_LAUNCHD_LABEL !== LAUNCH_AGENT_LABEL) throw new Error("Service role launchd label 校验失败");
  try {
    assertStableAppPaths({
      appPath,
      executablePath: executable,
      resourcesPath,
      bootstrapPath: expectedBootstrap,
    }, { applicationsRoot });
  } catch (error) {
    throw new Error(`Service role packaged 路径真实性校验失败: ${error.message}`);
  }
}

function mcpParentFields(pid) {
  try {
    return {
      executable: execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8", timeout: 500, maxBuffer: 4096,
      }).trim(),
      command: execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8", timeout: 500, maxBuffer: 16 * 1024,
      }).trim(),
    };
  } catch {
    throw new Error("MCP helper direct parent 无法验证");
  }
}

function mcpRuntimeProfileArg(argv) {
  const prefix = "--shoggoth-runtime-profile=";
  const values = argv.filter((arg) => typeof arg === "string" && arg.startsWith(prefix));
  if (values.length !== 1) return null;
  const value = values[0].slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : null;
}

function mcpRuntimeAccountArg(argv) {
  const prefix = "--shoggoth-runtime-account=";
  const values = argv.filter((arg) => typeof arg === "string" && arg.startsWith(prefix));
  if (values.length !== 1) return null;
  const value = values[0].slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null;
}

function validatedRuntimeServicePaths(value, canonicalPaths) {
  const expected = ["mcpAuthPath", "runtimeDir", "socketPath", "stateDir", "trustedRoot"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== expected.sort().join(",")
    || !expected.every((field) => typeof value[field] === "string"
      && path.isAbsolute(value[field]) && !value[field].includes("\0")
      && value[field] === canonicalPaths[field])
    || path.dirname(value.socketPath) !== value.runtimeDir
    || path.basename(value.socketPath) !== "service.sock"
    || path.dirname(value.mcpAuthPath) !== value.stateDir
    || path.basename(value.mcpAuthPath) !== "mcp-auth.json") return null;
  for (const target of [value.stateDir, value.runtimeDir]) {
    const relative = path.relative(value.trustedRoot, target);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  }
  return Object.freeze({ ...value });
}

function validateRuntimeMcpRoleGate(env, actual, runtime, argv) {
  const gatePath = env.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  const expectedNonce = env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE;
  const runtimeProfileId = mcpRuntimeProfileArg(argv);
  const runtimeAccountId = mcpRuntimeAccountArg(argv);
  if (env.ELECTRON_RUN_AS_NODE !== "1"
    || !path.isAbsolute(gatePath || "") || !/^[a-f0-9]{64}$/u.test(expectedNonce || "")
    || !runtimeProfileId || !runtimeAccountId
    || !Number.isSafeInteger(actual.ppid) || actual.ppid <= 1) return false;
  let canonicalPaths;
  try {
    canonicalPaths = resolveCanonicalServicePaths({ userInfo: runtime.userInfo });
  } catch {
    return false;
  }
  const gateRoot = path.join(canonicalPaths.runtimeDir, "mcp-gates");
  if (path.dirname(path.resolve(gatePath)) !== gateRoot
    || path.basename(gateRoot) !== "mcp-gates"
    || !/^mcp-[a-f0-9]{64}\.gate$/u.test(path.basename(gatePath))) return false;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    const rootStat = fs.lstatSync(gateRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) return false;
    fd = fs.openSync(gatePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.size <= 0 || stat.size > 4096
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return false;
    if (path.dirname(fs.realpathSync(gatePath)) !== fs.realpathSync(gateRoot)) return false;
    const gate = JSON.parse(fs.readFileSync(fd, "utf8"));
    const expectedKeys = "expiresAt,nonce,parentExecutable,parentPid,runtimeAccountId,runtimeProfileId,schemaVersion,servicePaths";
    if (!gate || Object.keys(gate).sort().join(",") !== expectedKeys
      || gate.schemaVersion !== 2 || gate.parentPid !== actual.ppid
      || gate.runtimeProfileId !== runtimeProfileId
      || gate.runtimeAccountId !== runtimeAccountId
      || !secureEqual(gate.nonce, expectedNonce)
      || typeof gate.parentExecutable !== "string" || !path.isAbsolute(gate.parentExecutable)
      || !Number.isSafeInteger(gate.expiresAt) || gate.expiresAt < actual.now()
      || gate.expiresAt > actual.now() + 60_000) return false;
    const servicePaths = validatedRuntimeServicePaths(gate.servicePaths, canonicalPaths);
    if (!servicePaths) return false;
    const parent = runtime.parent || mcpParentFields(actual.ppid);
    if (path.resolve(parent.executable || "") !== path.resolve(gate.parentExecutable)
      || typeof parent.command !== "string" || parent.command.length === 0) return false;
    const current = fs.lstatSync(gatePath);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false;
    // 外部 Runtime 的 OS sandbox 只允许 Relay 读取 Service-private gate，
    // 不能在这里 unlink。Relay 先通过本地 Service bridge 原子消费；
    // Service 再按签发时保存的 inode/PID identity 删除门票并升级同一 socket。
    return Object.freeze({
      gatePath,
      nonce: expectedNonce,
      parentPid: actual.ppid,
      runtimeProfileId,
      runtimeAccountId,
      servicePaths,
    });
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateExternalFederationMcpRoleGate(env, actual, runtime, argv) {
  const client = env.SHOGGOTH_FEDERATION_MCP_CLIENT;
  const authFile = env.SHOGGOTH_FEDERATION_MCP_AUTH_FILE;
  const runtimeProfileId = mcpRuntimeProfileArg(argv);
  const runtimeAccountId = mcpRuntimeAccountArg(argv);
  if (env.ELECTRON_RUN_AS_NODE !== "1" || !FEDERATION_MCP_CLIENTS.has(client)
    || !runtimeProfileId || !runtimeAccountId
    || !Number.isSafeInteger(actual.ppid) || actual.ppid <= 1
    || actual.platform !== "darwin" || actual.defaultApp === true) return null;
  let canonicalPaths;
  try {
    canonicalPaths = resolveCanonicalServicePaths({ userInfo: runtime.userInfo });
    if (typeof authFile !== "string" || !path.isAbsolute(authFile)
      || path.resolve(authFile) !== federationMcpAuthPath(canonicalPaths)) return null;
    loadFederationMcpCredential(canonicalPaths);
    if (typeof runtime.verifyExternalMcpApp === "function") {
      if (runtime.verifyExternalMcpApp(actual) !== true) return null;
    } else {
      const appPath = inferAppPath(actual.execPath);
      const expectedBootstrap = path.join(
        actual.resourcesPath, "app.asar", "app", "bootstrap.js",
      );
      if (!appPath || !argv.includes(expectedBootstrap)) return null;
      assertStableAppPaths({
        appPath,
        executablePath: actual.execPath,
        resourcesPath: actual.resourcesPath,
        bootstrapPath: expectedBootstrap,
      });
    }
  } catch {
    return null;
  }
  return Object.freeze({ client, authFile, runtimeProfileId, runtimeAccountId });
}

function validateMcpRoleGate(env, runtime = {}, argv = process.argv.slice(1)) {
  const actual = {
    platform: runtime.platform || process.platform,
    execPath: path.resolve(runtime.execPath || process.execPath),
    resourcesPath: path.resolve(runtime.resourcesPath || process.resourcesPath || "/"),
    ppid: runtime.ppid ?? process.ppid,
    defaultApp: runtime.defaultApp ?? process.defaultApp,
    now: runtime.now || Date.now,
  };
  const runtimeContext = validateRuntimeMcpRoleGate(env, actual, runtime, argv);
  if (runtimeContext) return runtimeContext;
  if (env.SHOGGOTH_FEDERATION_MCP_CLIENT !== undefined
    || env.SHOGGOTH_FEDERATION_MCP_AUTH_FILE !== undefined) {
    const federationContext = validateExternalFederationMcpRoleGate(
      env, actual, runtime, argv,
    );
    if (federationContext) return federationContext;
    throw new Error("MCP helper external federation gate 无效");
  }
  if (actual.defaultApp === true) {
    if (env.NODE_ENV === "test" && typeof runtime.verifyMcpParent === "function"
      && runtime.verifyMcpParent(actual) === true) return;
    if (verifyTestRoleGate(env, actual)) return;
    throw new Error("MCP helper source test gate 无效");
  }
  if (actual.platform !== "darwin" || !Number.isSafeInteger(actual.ppid) || actual.ppid <= 1) {
    throw new Error("MCP helper 来源不是受信 Codex parent");
  }
  const nativeAccount = mcpRuntimeAccountArg(argv) === NATIVE_CODEX_RUNTIME_ACCOUNT_ID;
  if (nativeAccount && !mcpRuntimeProfileArg(argv)) {
    throw new Error("MCP helper native Codex profile 无效");
  }
  const expectedParents = nativeAccount
    ? resolveCodexMcpParentBinaries({
      parentEnv: env,
      homedir: (runtime.userInfo || os.userInfo)().homedir,
    })
    : [path.join(actual.resourcesPath, "codex", "package", "bin", "codex")];
  const parent = runtime.parent || mcpParentFields(actual.ppid);
  const expectedParent = path.resolve(parent.executable || "");
  if (!expectedParents.includes(expectedParent)
    || typeof parent.command !== "string" || parent.command.length === 0) {
    throw new Error("MCP helper direct parent 路径无效");
  }
  if (typeof runtime.verifyCodeIdentity !== "function") {
    const appPath = inferAppPath(actual.execPath);
    assertStableAppPaths({
      appPath,
      executablePath: actual.execPath,
      resourcesPath: actual.resourcesPath,
      bootstrapPath: path.join(actual.resourcesPath, "app.asar", "app", "bootstrap.js"),
    });
  }
  let identity;
  try {
    identity = typeof runtime.verifyCodeIdentity === "function"
      ? runtime.verifyCodeIdentity(expectedParent)
      : assertCodeIdentity(expectedParent, {
        teamIdentifier: CODEX_TEAM_IDENTIFIER,
        designatedRequirement: CODEX_DESIGNATED_REQUIREMENT,
      }, { verifyTimeoutMs: CODEX_PARENT_VERIFY_TIMEOUT_MS });
  } catch (error) {
    throw bootstrapFailure(error?.code === "CODE_IDENTITY_TIMEOUT"
      ? "BOOTSTRAP_CODE_IDENTITY_TIMEOUT" : "BOOTSTRAP_CODE_IDENTITY_INVALID");
  }
  if (identity?.teamIdentifier !== CODEX_TEAM_IDENTIFIER
    || identity?.designatedRequirement !== CODEX_DESIGNATED_REQUIREMENT) {
    throw bootstrapFailure("BOOTSTRAP_CODE_IDENTITY_INVALID");
  }
  return null;
}

function assertServiceRoleIsolation(moduleCache = require.cache) {
  const forbidden = Object.keys(moduleCache).filter((filename) => {
    const normalized = filename.replaceAll("\\", "/");
    return normalized.endsWith("/app/ui-entry.js")
      || normalized.endsWith("/app/static-server.js")
      || normalized.endsWith("/app/openclaw-host.js")
      || normalized.includes("/app/core/openclaw-")
      || normalized.includes("/app/core/hermes-")
      || normalized.includes("/app/manage-ui/");
  });
  if (forbidden.length > 0) {
    throw new Error(`Service role 隔离失败，forbidden UI/product module 已加载: ${forbidden.join(", ")}`);
  }
}

function assertMcpRoleIsolation(moduleCache = require.cache) {
  const forbidden = Object.keys(moduleCache).filter((filename) => {
    const normalized = filename.replaceAll("\\", "/");
    return normalized.endsWith("/app/ui-entry.js")
      || normalized.endsWith("/app/static-server.js")
      || normalized.endsWith("/app/openclaw-host.js")
      || normalized.endsWith("/app/agent-service.js")
      || normalized.endsWith("/app/agent-service/server.js")
      || normalized.endsWith("/app/agent-service/product-store.js")
      || normalized.includes("/app/core/openclaw-")
      || normalized.includes("/app/core/hermes-")
      || normalized.includes("/app/manage-ui/");
  });
  if (forbidden.length > 0) {
    throw new Error(`MCP role 隔离失败，forbidden product module 已加载: ${forbidden.join(", ")}`);
  }
}

function assertMcpCryptoRoleIsolation(moduleCache = require.cache) {
  const forbidden = Object.keys(moduleCache).filter((filename) => {
    const normalized = filename.replaceAll("\\", "/");
    return normalized.endsWith("/app/ui-entry.js")
      || normalized.endsWith("/app/static-server.js")
      || normalized.endsWith("/app/openclaw-host.js")
      || normalized.endsWith("/app/agent-service.js")
      || normalized.endsWith("/app/agent-service/server.js")
      || normalized.endsWith("/app/agent-service/product-store.js")
      || normalized.includes("/app/core/openclaw-")
      || normalized.includes("/app/core/hermes-")
      || normalized.includes("/app/manage-ui/");
  });
  if (forbidden.length > 0) {
    throw new Error(`MCP crypto role 隔离失败，forbidden module 已加载: ${forbidden.join(", ")}`);
  }
}

function resolveRole(argv = process.argv.slice(1), env = process.env, runtime) {
  const roleArgs = argv.filter((arg) => typeof arg === "string" && arg.startsWith(ROLE_PREFIX));
  if (roleArgs.length === 0) return "ui";
  if (roleArgs.length !== 1) throw new Error("未知 role：重复的内部进程角色参数");
  const role = roleArgs[0].slice(ROLE_PREFIX.length);
  if (role !== "ui" && role !== "agent-service" && role !== "mcp" && role !== "mcp-crypto") {
    throw new Error(`未知 role (unknown role): ${role}`);
  }
  // Codex 的 MCP stdio launcher 在部分正式版本里不会把 TOML env table
  // 传给子进程。MCP role 已由「该账号对应的 Codex 直系父进程路径 + 固定代码签名」
  // 单独鉴权，因此不能再让一个可丢失的公开 marker 成为可用性前提。
  // Service/crypto role 没有该直系父进程证明，仍必须严格要求 marker。
  if (role !== "mcp" && env.SHOGGOTH_INTERNAL_LAUNCH !== INTERNAL_LAUNCH_MARKER) {
    throw new Error("agent role 缺少受控启动标记 (controlled launch marker)");
  }
  if (role === "agent-service") validateInternalRoleGate(env, runtime);
  if (role === "mcp") validateMcpRoleGate(env, runtime, argv);
  return role;
}

function dispatchRole(role, loaders = {}, runtimeMcpBridge = null) {
  const loadUi = loaders.ui || (() => require("./ui-entry"));
  const loadService = loaders.service || (() => {
    assertServiceRoleIsolation();
    const serviceModule = require("./agent-service");
    assertServiceRoleIsolation();
    return serviceModule.startAgentServiceProcess();
  });
  const loadMcp = loaders.mcp || (() => {
    assertMcpRoleIsolation();
    const helperModule = require("./shoggoth-mcp-helper");
    assertMcpRoleIsolation();
    return helperModule.startShoggothMcpHelper();
  });
  const loadRuntimeMcpRelay = loaders.runtimeMcpRelay || (() => {
    assertMcpRoleIsolation();
    const relayModule = require("./runtime-mcp-relay");
    assertMcpRoleIsolation();
    return relayModule.startRuntimeMcpRelay(runtimeMcpBridge);
  });
  const loadMcpCrypto = loaders.mcpCrypto || (() => {
    assertMcpCryptoRoleIsolation();
    const workerModule = require("./mcp-crypto-worker");
    assertMcpCryptoRoleIsolation();
    return workerModule.startMcpCryptoWorker();
  });
  if (role === "ui") return loadUi();
  if (role === "agent-service") return loadService();
  if (role === "mcp") {
    return runtimeMcpBridge ? loadRuntimeMcpRelay(runtimeMcpBridge) : loadMcp();
  }
  if (role === "mcp-crypto") return loadMcpCrypto();
  throw new Error(`未知 role (unknown role): ${role}`);
}

function main(argv, env, runtime, loaders) {
  let role;
  try {
    role = resolveRole(argv, env, runtime);
  } catch (error) {
    if ((env || process.env).NODE_ENV === "test") {
      try { console.error(`[bootstrap-test] role gate failed: ${error?.message || "unknown"}`); } catch {}
    }
    const code = bootstrapFailureCode(error);
    throw bootstrapFailure(code.startsWith("BOOTSTRAP_CODE_IDENTITY_") ? code : "BOOTSTRAP_ROLE_REJECTED");
  }
  const dispatch = (runtimeMcpBridge = null) => {
    try {
      const dispatched = dispatchRole(role, loaders, runtimeMcpBridge);
      if (role !== "mcp" || !dispatched || typeof dispatched.then !== "function") {
        return dispatched;
      }
      return Promise.resolve(dispatched).catch((error) => {
        const code = bootstrapFailureCode(error);
        throw bootstrapFailure(code.startsWith("MCP_HELPER_") ? code : "BOOTSTRAP_MCP_START_FAILED");
      });
    } catch (error) {
      if (role !== "mcp") throw error;
      const code = bootstrapFailureCode(error);
      throw bootstrapFailure(code.startsWith("MCP_HELPER_") ? code : "BOOTSTRAP_MCP_START_FAILED");
    }
  };
  const actualEnv = env || process.env;
  if (role === "mcp" && actualEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE !== undefined) {
    let context;
    try {
      context = validateMcpRoleGate(actualEnv, runtime, argv || process.argv.slice(1));
    } catch {
      throw bootstrapFailure("BOOTSTRAP_ROLE_REJECTED");
    }
    const openBridge = runtime?.openRuntimeMcpBridge
      || require("./runtime-mcp-relay").openRuntimeMcpBridge;
    return Promise.resolve()
      .then(() => openBridge(context, runtime?.runtimeMcpBridgeOptions))
      .catch(() => { throw bootstrapFailure("BOOTSTRAP_ROLE_REJECTED"); })
      .then((bridge) => {
        delete actualEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
        delete actualEnv.SHOGGOTH_RUNTIME_MCP_GATE_NONCE;
        return dispatch(bridge);
      });
  }
  return dispatch();
}

module.exports = {
  INTERNAL_LAUNCH_MARKER,
  ROLE_PREFIX,
  assertMcpRoleIsolation,
  assertMcpCryptoRoleIsolation,
  assertServiceRoleIsolation,
  bootstrapFailureCode,
  dispatchRole,
  main,
  resolveRole,
  validateInternalRoleGate,
  validateExternalFederationMcpRoleGate,
  validateMcpRoleGate,
};
