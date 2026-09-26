"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { validRuntimeAccountId, validRuntimeProfileId } = require("./runtime-adapter");

const DEEPSEEK_HARNESS_RUNTIME = "deepseek-harness";
const DEEPSEEK_HARNESS_PROFILE = "shoggoth";
const DEEPSEEK_HARNESS_INTEGRATION_PROFILE = "headless";
const DEEPSEEK_HARNESS_INTEGRATION_MARKER = ".shoggoth-integration-v1.json";
const MIN_DEEPSEEK_HARNESS_VERSION = Object.freeze([0, 1, 1]);
const DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function runtimeError(code, message) {
  return serviceError(code, message);
}

function prepareDeepSeekHarnessHome(paths, runtimeProfileId, options = {}) {
  if (!validRuntimeProfileId(runtimeProfileId)) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_RUNTIME_PROFILE_INVALID",
      "DeepSeek runtime profile id is invalid",
    );
  }
  const profileId = runtimeProfileId;
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("DEEPSEEK_HARNESS_PATHS_INVALID", "DeepSeek runtime paths are invalid");
  }
  const base = path.join(paths.stateDir, DEEPSEEK_HARNESS_RUNTIME);
  const home = path.join(base, profileId);
  const relative = path.relative(base, home);
  if (relative !== profileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_RUNTIME_PROFILE_INVALID",
      "DeepSeek runtime profile path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(home, paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, "profiles"), paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, "profiles", DEEPSEEK_HARNESS_PROFILE), paths.trustedRoot);
  ensurePrivateDirectoryTree(path.join(home, "sessions"), paths.trustedRoot);
  if (options.bridgePath !== undefined) {
    writeManagedProfile({
      fs: options.fs || fs,
      home,
      trustedRoot: paths.trustedRoot,
      bridgePath: assertDeepSeekHarnessBridgePath(options.bridgePath, { fs: options.fs || fs }),
    });
  }
  return home;
}

function writeManagedProfile({ fs: fileSystem, home, trustedRoot, bridgePath }) {
  const profileRoot = path.join(home, "profiles", DEEPSEEK_HARNESS_PROFILE);
  const packageJson = `${JSON.stringify({
    name: "shoggoth-deepseek-harness-profile",
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base"],
        patchReload: "startup",
      },
    },
  }, null, 2)}\n`;
  const patch = managedPatch(bridgePath);
  atomicWritePrivateFile(path.join(profileRoot, "package.json"), packageJson, {
    fs: fileSystem,
    trustedRoot,
  });
  atomicWritePrivateFile(path.join(profileRoot, "cordis.patch.yml"), patch, {
    fs: fileSystem,
    trustedRoot,
  });
}

function managedPatch(bridgePath, options = {}) {
  const bridgeUrl = pathToFileURL(bridgePath).href.replace(/'/gu, "''");
  const lines = [
    "# Managed by Shoggoth. DSH itself remains an unmodified official installation.",
    "- id: agent-instructions",
    "  disabled: true",
    "",
    "- id: skill",
    "  disabled: true",
    "",
    "- id: skill-filesystem",
    "  disabled: true",
    "",
    "- id: skill-badge",
    "  disabled: true",
    "",
    "- id: tool-skill",
    "  disabled: true",
    "",
    "- id: approval",
    "  config:",
    "    policy: !!js process.env.SHOGGOTH_DSH_APPROVAL_POLICY",
    "",
    "- id: permission",
    "  config:",
    "    presets:",
    "      read-only:",
    "        sandbox: read-only",
    "        approval: !!js process.env.SHOGGOTH_DSH_APPROVAL_POLICY",
    "      workspace-write:",
    "        sandbox: workspace-write",
    "        approval: !!js process.env.SHOGGOTH_DSH_APPROVAL_POLICY",
    "      danger-full-access:",
    "        sandbox: danger-full-access",
    "        approval: !!js process.env.SHOGGOTH_DSH_APPROVAL_POLICY",
    "    defaultPreset: !!js process.env.DSH_PERMISSION_MODE",
    "",
    "- insert:",
    "    - id: shoggoth-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      disabled: !!js process.env.SHOGGOTH_DSH_CONTROL_INSTANCE === '1'",
    "      config: !!js JSON.parse(process.env.SHOGGOTH_DSH_MCP_CONFIG)",
    "    - id: shoggoth-runtime-bridge",
    `      name: '${bridgeUrl}'`,
    "",
  ];
  if (options.disableHeadless === true) {
    lines.splice(1, 0,
      "- id: headless-startup",
      "  disabled: true",
      "",
      "- id: headless-runner",
      "  disabled: true",
      "",
    );
  }
  return lines.join("\n");
}

function prepareDeepSeekHarnessRuntimeAccountIntegration(paths, runtimeAccountId, options = {}) {
  if (!validRuntimeAccountId(runtimeAccountId)) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_INVALID",
      "DeepSeek runtime account id is invalid",
    );
  }
  if (!paths || typeof paths.stateDir !== "string" || !path.isAbsolute(paths.stateDir)
    || typeof paths.trustedRoot !== "string" || !path.isAbsolute(paths.trustedRoot)) {
    throw runtimeError("DEEPSEEK_HARNESS_PATHS_INVALID", "DeepSeek runtime paths are invalid");
  }
  const fileSystem = options.fs || fs;
  const bridgePath = assertDeepSeekHarnessBridgePath(options.bridgePath, { fs: fileSystem });
  const integrationRoot = paths.runtimeIntegrationDir
    || path.join(paths.stateDir, "runtime-integration");
  const runtimeRoot = path.join(integrationRoot, DEEPSEEK_HARNESS_RUNTIME);
  const accountRoot = path.join(runtimeRoot, runtimeAccountId);
  const relative = path.relative(runtimeRoot, accountRoot);
  if (relative !== runtimeAccountId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_INVALID",
      "DeepSeek integration path escapes its root",
    );
  }
  ensurePrivateDirectoryTree(integrationRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(runtimeRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(accountRoot, paths.trustedRoot);
  const markerPath = path.join(accountRoot, DEEPSEEK_HARNESS_INTEGRATION_MARKER);
  const patchPath = path.join(accountRoot, "cordis.patch.yml");
  const marker = Object.freeze({
    schemaVersion: 1,
    owner: "shoggoth",
    runtime: DEEPSEEK_HARNESS_RUNTIME,
    runtimeAccountId,
  });
  const markerStat = lstatIfExists(markerPath);
  if (markerStat) {
    let current;
    try {
      current = JSON.parse(readPrivateFile(markerPath, {
        fs: fileSystem,
        maxBytes: 4096,
      }).toString("utf8"));
    } catch {
      throw runtimeError(
        "DEEPSEEK_HARNESS_INTEGRATION_CONFLICT",
        "DeepSeek integration ownership marker is invalid",
      );
    }
    if (!current || typeof current !== "object" || Array.isArray(current)
      || JSON.stringify(current) !== JSON.stringify(marker)) {
      throw runtimeError(
        "DEEPSEEK_HARNESS_INTEGRATION_CONFLICT",
        "DeepSeek integration is owned by another configuration",
      );
    }
  } else if (fileSystem.readdirSync(accountRoot).length > 0) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_INTEGRATION_CONFLICT",
      "DeepSeek integration directory is already occupied",
    );
  } else {
    atomicWritePrivateFile(markerPath, `${JSON.stringify(marker)}\n`, {
      fs: fileSystem,
      trustedRoot: paths.trustedRoot,
    });
  }
  const patch = managedPatch(bridgePath, { disableHeadless: true });
  let currentPatch = null;
  try {
    currentPatch = readPrivateFile(patchPath, {
      fs: fileSystem,
      maxBytes: 1024 * 1024,
    }).toString("utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw runtimeError(
        "DEEPSEEK_HARNESS_INTEGRATION_CONFLICT",
        "DeepSeek integration patch is unsafe",
      );
    }
  }
  if (currentPatch !== patch) {
    atomicWritePrivateFile(patchPath, patch, {
      fs: fileSystem,
      trustedRoot: paths.trustedRoot,
    });
  }
  return Object.freeze({
    profile: DEEPSEEK_HARNESS_INTEGRATION_PROFILE,
    patchPath,
    root: accountRoot,
  });
}

function executableRealpath(candidate, fileSystem) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")
    || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = fileSystem.realpathSync(candidate);
    const stat = fileSystem.lstatSync(resolved);
    if (!path.isAbsolute(resolved) || !stat.isFile() || stat.isSymbolicLink()) return null;
    fileSystem.accessSync(resolved, fileSystem.constants.X_OK);
    return path.resolve(resolved);
  } catch {
    return null;
  }
}

function resolveDeepSeekHarnessExecutable(candidate, options = {}) {
  const resolved = executableRealpath(candidate, options.fs || fs);
  if (!resolved) {
    throw runtimeError(
      options.code || "DEEPSEEK_HARNESS_BINARY_INVALID",
      options.message || "DeepSeek executable is unavailable or unsafe",
    );
  }
  return resolved;
}

function resolveDeepSeekHarnessBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    return resolveDeepSeekHarnessExecutable(options.binaryPath, {
      fs: fileSystem,
      code: "DEEPSEEK_HARNESS_BINARY_INVALID",
      message: "DeepSeek binaryPath must be an absolute executable regular file",
    });
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "dsh"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "dsh"));
  }
  candidates.push("/opt/homebrew/bin/dsh", "/usr/local/bin/dsh");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = executableRealpath(candidate, fileSystem);
    if (resolved) return resolved;
  }
  throw runtimeError(
    "DEEPSEEK_HARNESS_BINARY_NOT_FOUND",
    "DeepSeek CLI executable was not found",
  );
}

function resolveDeepSeekHarnessLaunch(binaryPath, options = {}) {
  const fileSystem = options.fs || fs;
  const resolvedBinary = resolveDeepSeekHarnessExecutable(binaryPath, { fs: fileSystem });
  const header = Buffer.alloc(256);
  let descriptor;
  try {
    const file = fileSystem.openSync(resolvedBinary, "r");
    try {
      const bytesRead = fileSystem.readSync(file, header, 0, header.length, 0);
      const newline = header.indexOf(0x0a, 0);
      descriptor = header.subarray(0, newline >= 0 && newline < bytesRead ? newline : bytesRead)
        .toString("utf8").replace(/\r$/u, "");
    } finally {
      fileSystem.closeSync(file);
    }
  } catch {
    throw runtimeError(
      "DEEPSEEK_HARNESS_BINARY_INVALID",
      "DeepSeek executable could not be inspected safely",
    );
  }
  if (!descriptor.startsWith("#!")) {
    return Object.freeze({ command: resolvedBinary, argsPrefix: Object.freeze([]) });
  }
  if (descriptor !== "#!/usr/bin/env node") {
    throw runtimeError(
      "DEEPSEEK_HARNESS_BINARY_INVALID",
      "DeepSeek executable uses an unsupported interpreter",
    );
  }
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.homedir || os.homedir();
  const candidates = [];
  for (const entry of String(parentEnv.PATH || "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry) && !entry.includes("\0")) {
      candidates.push(path.join(entry, "node"));
    }
  }
  if (typeof userHome === "string" && path.isAbsolute(userHome) && !userHome.includes("\0")) {
    candidates.push(path.join(userHome, ".local", "bin", "node"));
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  for (const candidate of [...new Set(candidates)]) {
    const resolvedNode = executableRealpath(candidate, fileSystem);
    if (resolvedNode) {
      return Object.freeze({
        command: resolvedNode,
        argsPrefix: Object.freeze([resolvedBinary]),
      });
    }
  }
  throw runtimeError(
    "DEEPSEEK_HARNESS_NODE_NOT_FOUND",
    "Node.js executable for DeepSeek was not found",
  );
}

function parseDeepSeekHarnessVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? Object.freeze(parts) : null;
}

function supportsDeepSeekHarnessVersion(value) {
  const version = Array.isArray(value) ? value : parseDeepSeekHarnessVersion(value);
  if (!version || version.length !== 3) return false;
  for (let index = 0; index < MIN_DEEPSEEK_HARNESS_VERSION.length; index += 1) {
    if (version[index] > MIN_DEEPSEEK_HARNESS_VERSION[index]) return true;
    if (version[index] < MIN_DEEPSEEK_HARNESS_VERSION[index]) return false;
  }
  return true;
}

function assertDeepSeekHarnessBridgePath(value, options = {}) {
  const fileSystem = options.fs || fs;
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw runtimeError("DEEPSEEK_HARNESS_BRIDGE_INVALID", "DeepSeek Bridge path is invalid");
  }
  try {
    const stat = fileSystem.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe bridge");
  } catch {
    throw runtimeError(
      "DEEPSEEK_HARNESS_BRIDGE_INVALID",
      "DeepSeek Bridge is unavailable or unsafe",
    );
  }
  return path.resolve(value);
}

function normalizeDeepSeekHarnessPermissionPolicy(
  value = DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !VALID_APPROVAL_POLICIES.has(value.approvalPolicy)
    || !VALID_SANDBOXES.has(value.sandbox)) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_PERMISSION_POLICY_INVALID",
      "DeepSeek permission policy is invalid",
    );
  }
  return Object.freeze({ approvalPolicy: value.approvalPolicy, sandbox: value.sandbox });
}

function deepSeekHarnessPermissionFingerprint(value) {
  const policy = normalizeDeepSeekHarnessPermissionPolicy(value);
  return JSON.stringify([policy.approvalPolicy, policy.sandbox]);
}

function normalizeDeepSeekHarnessWorkspace(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || !value.isWellFormed() || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw runtimeError(
      "DEEPSEEK_HARNESS_WORKSPACE_INVALID",
      "DeepSeek workspace must be canonical and absolute",
    );
  }
  return value;
}

module.exports = {
  DEEPSEEK_HARNESS_INTEGRATION_MARKER,
  DEEPSEEK_HARNESS_INTEGRATION_PROFILE,
  DEEPSEEK_HARNESS_PROFILE,
  DEEPSEEK_HARNESS_RUNTIME,
  DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY,
  MIN_DEEPSEEK_HARNESS_VERSION,
  assertDeepSeekHarnessBridgePath,
  deepSeekHarnessPermissionFingerprint,
  normalizeDeepSeekHarnessPermissionPolicy,
  normalizeDeepSeekHarnessWorkspace,
  parseDeepSeekHarnessVersion,
  prepareDeepSeekHarnessHome,
  prepareDeepSeekHarnessRuntimeAccountIntegration,
  resolveDeepSeekHarnessBinary,
  resolveDeepSeekHarnessExecutable,
  resolveDeepSeekHarnessLaunch,
  supportsDeepSeekHarnessVersion,
};
