"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const MAX_CONFIG_BYTES = 1024 * 1024;
// The retired agy CLI integration wrote an ungated `shoggoth` entry into the
// account's global MCP config. The ACP server loads that file for every session,
// so the stale entry must go; the gated helper is passed per session instead.
const RETIRED_GLOBAL_MCP_SERVER = "shoggoth";

function configError(code, message) {
  return serviceError(code, message);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertManagedFile(fileSystem, target, trustedRoot) {
  const stat = statIfExists(fileSystem, target);
  if (!stat) return null;
  const relative = path.relative(trustedRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config is unsafe");
  }
  return stat;
}

function readManagedJson(fileSystem, target, trustedRoot) {
  if (!assertManagedFile(fileSystem, target, trustedRoot)) return null;
  let parsed;
  try {
    const contents = readPrivateFile(target, { fs: fileSystem, maxBytes: MAX_CONFIG_BYTES });
    if (contents.length === 0) return {};
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (error?.code?.startsWith?.("PRIVATE_FILE_") || error?.code?.startsWith?.("UNSAFE_")) throw error;
    throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config is malformed");
  }
  if (!plain(parsed)) throw configError("ANTIGRAVITY_CONFIG_INVALID", "Antigravity managed config must be an object");
  return parsed;
}

// Prepares the account's GEMINI_HOME for the official ACP server. Returns the
// paths the host needs; never touches the user's native ~/.gemini.
function prepareAntigravityAcpHome(options = {}) {
  const fileSystem = options.fs || fs;
  const { home, trustedRoot } = options;
  if (typeof home !== "string" || !path.isAbsolute(home)
    || typeof trustedRoot !== "string" || !path.isAbsolute(trustedRoot)) {
    throw configError("ANTIGRAVITY_CONFIG_OPTIONS_INVALID", "Antigravity config paths are invalid");
  }
  const geminiHome = path.join(home, ".gemini");
  const configRoot = path.join(geminiHome, "config");
  const acpRoot = path.join(geminiHome, "antigravity-acp");
  for (const directory of [geminiHome, configRoot, acpRoot]) {
    ensurePrivateDirectoryTree(directory, trustedRoot);
  }
  const mcpPath = path.join(configRoot, "mcp_config.json");
  const mcpConfig = readManagedJson(fileSystem, mcpPath, trustedRoot);
  if (mcpConfig && plain(mcpConfig.mcpServers)
    && Object.prototype.hasOwnProperty.call(mcpConfig.mcpServers, RETIRED_GLOBAL_MCP_SERVER)) {
    const { [RETIRED_GLOBAL_MCP_SERVER]: _retired, ...mcpServers } = mcpConfig.mcpServers;
    atomicWritePrivateFile(mcpPath, `${JSON.stringify({ ...mcpConfig, mcpServers }, null, 2)}\n`, {
      fs: fileSystem,
      trustedRoot,
    });
  }
  return Object.freeze({
    geminiHome,
    settingsPath: path.join(acpRoot, "settings.json"),
  });
}

// `auth.type` is written by the ACP server after a successful `authenticate`.
// Its presence means a login method was selected, not that credentials are valid.
function antigravityAcpAuthType(options = {}) {
  const fileSystem = options.fs || fs;
  const settings = readManagedJson(fileSystem, options.settingsPath, options.trustedRoot);
  const type = settings?.auth?.type;
  return typeof type === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(type) ? type : null;
}

module.exports = {
  RETIRED_GLOBAL_MCP_SERVER,
  antigravityAcpAuthType,
  prepareAntigravityAcpHome,
};
