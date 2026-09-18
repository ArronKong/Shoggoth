"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const MAX_CONFIG_BYTES = 1024 * 1024;
const SHOGGOTH_PERMISSION = "mcp(shoggoth/*)";

function prepareAntigravityNativeOnboarding({ home, nativeHome, trustedRoot, fs: fileSystem = fs }) {
  const target = path.join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json");
  ensurePrivateDirectoryTree(path.dirname(target), trustedRoot);
  const current = readJson(fileSystem, target, trustedRoot);
  if (current.onboardingComplete === true) return;
  // Reuse this same native account's existing consent; never accept new terms
  // or write to the user's CLI home on its behalf.
  const source = path.join(nativeHome, "antigravity-cli", "cache", "onboarding.json");
  let existing;
  try { existing = JSON.parse(readPrivateFile(source, { fs: fileSystem, maxBytes: 16 * 1024 })); }
  catch { /* Missing consent requires the user's native onboarding. */ }
  if (!plain(existing) || existing.onboardingComplete !== true) {
    throw configError("ANTIGRAVITY_ONBOARDING_REQUIRED", "Complete Antigravity CLI onboarding before using native approvals");
  }
  const consent = Object.fromEntries(["onboardingComplete", "consumerOnboardingComplete", "enterpriseOnboardingComplete"]
    .filter((key) => typeof existing[key] === "boolean").map((key) => [key, existing[key]]));
  atomicWritePrivateFile(target, `${JSON.stringify({ ...current, ...consent })}\n`, { fs: fileSystem, trustedRoot });
}

function configError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hardenManagedJson(fileSystem, target, trustedRoot) {
  const stat = statIfExists(fileSystem, target);
  if (!stat) return;
  const relative = path.relative(trustedRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config is unsafe");
  }
  if ((stat.mode & 0o077) !== 0) fileSystem.chmodSync(target, 0o600);
}

function readJson(fileSystem, target, trustedRoot, options = {}) {
  if (!statIfExists(fileSystem, target)) return {};
  hardenManagedJson(fileSystem, target, trustedRoot);
  let parsed;
  try {
    const contents = readPrivateFile(target, {
      fs: fileSystem,
      maxBytes: MAX_CONFIG_BYTES,
    });
    if (options.allowEmpty && contents.length === 0) return {};
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith?.("PRIVATE_FILE_") || error?.code?.startsWith?.("UNSAFE_")) {
      throw error;
    }
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config is malformed");
  }
  if (!plain(parsed)) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config must be an object");
  }
  const relative = path.relative(trustedRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity config escapes trusted storage");
  }
  return parsed;
}

function safeArg(value) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= 4096;
}

function normalizeMcpServer(value) {
  if (!value || typeof value !== "object" || typeof value.command !== "string"
    || !path.isAbsolute(value.command) || value.command.includes("\0")
    || !Array.isArray(value.args) || value.args.length > 32 || !value.args.every(safeArg)) {
    throw configError("ANTIGRAVITY_MCP_CONFIG_INVALID", "Antigravity MCP server is invalid");
  }
  return {
    command: path.resolve(value.command),
    args: [...value.args],
    // Persist only the launch mode, never a turn's one-use MCP credentials.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    disabled: false,
  };
}

function uniqueStrings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024
    || value.some((item) => !safeArg(item))) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity permission rules are invalid");
  }
  return [...new Set(value)];
}

function writeAntigravityManagedConfig(options = {}) {
  const fileSystem = options.fs || fs;
  const home = options.home;
  const trustedRoot = options.trustedRoot;
  if (typeof home !== "string" || !path.isAbsolute(home)
    || typeof trustedRoot !== "string" || !path.isAbsolute(trustedRoot)) {
    throw configError("ANTIGRAVITY_CONFIG_OPTIONS_INVALID", "Antigravity config paths are invalid");
  }
  const geminiRoot = path.join(home, ".gemini");
  const cliRoot = path.join(geminiRoot, "antigravity-cli");
  const configRoot = path.join(geminiRoot, "config");
  ensurePrivateDirectoryTree(geminiRoot, trustedRoot);
  ensurePrivateDirectoryTree(cliRoot, trustedRoot);
  ensurePrivateDirectoryTree(configRoot, trustedRoot);

  const settingsPath = path.join(cliRoot, "settings.json");
  const settings = readJson(fileSystem, settingsPath, trustedRoot);
  const permissions = settings.permissions === undefined ? {} : settings.permissions;
  if (!plain(permissions)) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity permissions config is invalid");
  }
  const allow = uniqueStrings(permissions.allow);
  if (!allow.includes(SHOGGOTH_PERMISSION)) allow.push(SHOGGOTH_PERMISSION);
  const nextSettings = {
    ...settings,
    ...(options.statusCommand ? { statusLine: {
      type: "command", command: options.statusCommand, enabled: true, stack_with_default: true,
    } } : {}),
    toolPermission: "proceed-in-sandbox",
    permissions: {
      ...permissions,
      allow,
      ...(permissions.deny === undefined ? {} : { deny: uniqueStrings(permissions.deny) }),
      ...(permissions.ask === undefined ? {} : { ask: uniqueStrings(permissions.ask) }),
    },
  };
  atomicWritePrivateFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, {
    fs: fileSystem,
    trustedRoot,
  });

  const mcpPath = path.join(configRoot, "mcp_config.json");
  const mcpConfig = readJson(fileSystem, mcpPath, trustedRoot, { allowEmpty: true });
  const mcpServers = mcpConfig.mcpServers === undefined ? {} : mcpConfig.mcpServers;
  if (!plain(mcpServers)) {
    throw configError("ANTIGRAVITY_MCP_CONFIG_INVALID", "Antigravity MCP config is invalid");
  }
  const nextMcp = {
    ...mcpConfig,
    mcpServers: {
      ...mcpServers,
      shoggoth: normalizeMcpServer(options.mcpServer),
    },
  };
  atomicWritePrivateFile(mcpPath, `${JSON.stringify(nextMcp, null, 2)}\n`, {
    fs: fileSystem,
    trustedRoot,
  });
  return Object.freeze({ settingsPath, mcpPath });
}

module.exports = {
  SHOGGOTH_PERMISSION,
  hardenManagedJson,
  prepareAntigravityNativeOnboarding,
  writeAntigravityManagedConfig,
};
