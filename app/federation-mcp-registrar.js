"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  ensureFederationMcpCredential,
  federationMcpAuthPath,
} = require("./agent-service/federation-mcp-auth");
const { DEFAULT_RUNTIME_PROFILE_ID } = require("./agent-service/product-store");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("./agent-service/runtime-account");

const SERVER_NAME = "shoggoth";
const RUNTIME_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUNTIME_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HERMES_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const COMMAND_TIMEOUT_MS = 15_000;

function runFile(command, args, options = {}) {
  const executor = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    executor(command, args, {
      env: options.env || process.env,
      timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error) => error ? reject(error) : resolve());
  });
}

function discoverHermesProfiles(home = process.env.HERMES_HOME
  || path.join(os.homedir(), ".hermes")) {
  const profiles = new Set(["default"]);
  try {
    for (const entry of fs.readdirSync(path.join(home, "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory() && HERMES_PROFILE_PATTERN.test(entry.name)) profiles.add(entry.name);
    }
  } catch {}
  return [...profiles].sort((left, right) => (
    left === "default" ? -1 : right === "default" ? 1 : left.localeCompare(right)
  ));
}

function launchBase(options, client) {
  return {
    command: options.executablePath,
    args: [
      options.bootstrapPath,
      "--shoggoth-internal-role=mcp",
      `--shoggoth-runtime-profile=${options.runtimeProfileId}`,
      `--shoggoth-runtime-account=${options.runtimeAccountId}`,
    ],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      SHOGGOTH_FEDERATION_MCP_CLIENT: client,
      SHOGGOTH_FEDERATION_MCP_AUTH_FILE: federationMcpAuthPath(options.paths),
    },
  };
}

function openClawConfig(options) {
  return {
    ...launchBase(options, "openclaw"),
    connectionTimeoutMs: 10_000,
    requestTimeoutMs: 120_000,
    supportsParallelToolCalls: true,
    codex: { defaultToolsApprovalMode: "auto" },
  };
}

function hermesConfig(options) {
  return {
    ...launchBase(options, "hermes"),
    connect_timeout: 10,
    enabled: true,
  };
}

function createFederationMcpRegistrar(options = {}) {
  if (!options.paths?.stateDir || !options.paths?.trustedRoot
    || typeof options.executablePath !== "string" || !path.isAbsolute(options.executablePath)
    || typeof options.bootstrapPath !== "string" || !path.isAbsolute(options.bootstrapPath)
    || (options.runtimeProfileId !== undefined
      && (!RUNTIME_PROFILE_PATTERN.test(options.runtimeProfileId)))
    || (options.runtimeAccountId !== undefined
      && (!RUNTIME_ACCOUNT_PATTERN.test(options.runtimeAccountId)))
    || (options.getHermesMode !== undefined && typeof options.getHermesMode !== "function")
    || (options.listHermesProfiles !== undefined
      && typeof options.listHermesProfiles !== "function")) {
    throw new TypeError("Federation MCP registrar 配置无效");
  }
  const settings = {
    ...options,
    runtimeProfileId: options.runtimeProfileId || DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: options.runtimeAccountId || SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    openclawBin: options.openclawBin || "openclaw",
    hermesBin: options.hermesBin || "hermes",
  };
  const execute = (command, args) => runFile(command, args, {
    execFile: options.execFile,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return Object.freeze({
    async reconcile() {
      if (options.packaged !== true) return { skipped: "not-packaged", openclaw: false, hermes: [] };
      ensureFederationMcpCredential(settings.paths);
      let openclaw = false;
      try {
        await execute(settings.openclawBin, [
          "mcp", "set", SERVER_NAME, JSON.stringify(openClawConfig(settings)),
        ]);
        openclaw = true;
        try { await execute(settings.openclawBin, ["mcp", "reload"]); } catch {}
      } catch {}

      const hermes = [];
      if ((settings.getHermesMode?.() || "local") !== "remote") {
        let profiles;
        try {
          profiles = settings.listHermesProfiles
            ? await settings.listHermesProfiles() : discoverHermesProfiles(settings.hermesHome);
        } catch {
          profiles = ["default"];
        }
        profiles = [...new Set(Array.isArray(profiles) ? profiles : [])]
          .filter((profile) => HERMES_PROFILE_PATTERN.test(profile));
        if (!profiles.includes("default")) profiles.unshift("default");
        for (const profile of profiles) {
          const prefix = profile === "default" ? [] : ["--profile", profile];
          try {
            await execute(settings.hermesBin, [
              ...prefix,
              "config", "set", "--force", `mcp_servers.${SERVER_NAME}`,
              JSON.stringify(hermesConfig(settings)),
            ]);
            hermes.push(profile);
          } catch {}
        }
      }
      return { skipped: null, openclaw, hermes };
    },
  });
}

module.exports = {
  createFederationMcpRegistrar,
  discoverHermesProfiles,
  hermesConfig,
  openClawConfig,
};
