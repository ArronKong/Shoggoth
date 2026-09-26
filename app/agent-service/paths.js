"use strict";

const os = require("node:os");
const path = require("node:path");

function commonAncestor(paths) {
  const split = paths.map((target) => path.resolve(target).split(path.sep));
  const shared = [];
  for (let index = 0; index < split[0].length; index += 1) {
    if (!split.every((parts) => parts[index] === split[0][index])) break;
    shared.push(split[0][index]);
  }
  return path.resolve(path.sep, ...shared.filter(Boolean));
}

function resolveServicePaths(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const userDataRoot = path.resolve(options.userDataRoot || (
    options.stateRoot
      ? path.dirname(path.resolve(options.stateRoot))
      : path.join(homeDir, "Library", "Application Support", "Shoggoth")
  ));
  const stateDir = path.resolve(
    options.stateRoot || path.join(userDataRoot, "shoggoth-core"),
  );
  const profileDir = path.resolve(options.profileRoot || path.join(userDataRoot, "agent-service-profile"));
  const cacheDir = path.resolve(
    options.cacheRoot || path.join(homeDir, "Library", "Caches", "com.shoggoth.agent-service"),
  );
  const trustedRoot = path.resolve(options.trustedRoot || (
    options.stateRoot || options.userDataRoot || options.profileRoot || options.cacheRoot
      ? commonAncestor([stateDir, profileDir, cacheDir])
      : homeDir
  ));
  // Runtime endpoints are control-plane state, not disposable cache. Keeping
  // them under Application Support prevents macOS or cache cleaners from
  // unlinking a live Service socket while the process still owns its inode.
  // This path is also shorter than the former cache path on macOS, preserving
  // the sockaddr_un budget for long account names.
  const runtimeDir = path.join(userDataRoot, "run");
  const defaultWorkspaceDir = path.join(stateDir, "workspaces");
  const backupsDir = path.join(stateDir, "backups");
  const agentsDir = path.join(stateDir, "agents");
  const skillsDir = path.join(stateDir, "skills");
  const pluginsDir = path.join(stateDir, "plugins");
  const nativeMcpDir = path.join(stateDir, "mcp-servers");
  const runtimeAccountsDir = path.join(stateDir, "runtime-accounts");
  const runtimeIntegrationDir = path.join(stateDir, "runtime-integration");
  const runtimeSessionOwnershipDir = path.join(stateDir, "runtime-session-ownership");
  const computerDir = path.join(stateDir, "computer");
  return Object.freeze({
    productSchemaVersion: 15,
    stateDir,
    userDataRoot,
    trustedRoot,
    stateSnapshotPath: path.join(stateDir, "state.snapshot.json"),
    eventLogPath: path.join(stateDir, "events.jsonl"),
    tokenUsagePath: path.join(stateDir, "token-usage.jsonl"),
    encryptedSecretsPath: path.join(stateDir, "encrypted-secrets.json"),
    mcpAuthPath: path.join(stateDir, "mcp-auth.json"),
    accountAuthStateV2Path: path.join(stateDir, "account-auth-state-v2.json"),
    runtimeSwitchPath: path.join(stateDir, "runtime-switch.json"),
    runtimeAccountsDir,
    runtimeIntegrationDir,
    runtimeSessionOwnershipDir,
    runtimeSessionOwnershipPath: path.join(runtimeSessionOwnershipDir, "ownership-v1.json"),
    toolPolicyPath: path.join(stateDir, "tool-permissions.json"),
    profileDir,
    cacheDir,
    runtimeDir,
    defaultWorkspaceDir,
    backupsDir,
    agentsDir,
    skillsDir,
    pluginsDir,
    pluginCatalogPath: path.join(pluginsDir, "catalog.sqlite"),
    pluginPackagesDir: path.join(pluginsDir, "packages"),
    pluginStagingDir: path.join(pluginsDir, "staging"),
    pluginDataDir: path.join(pluginsDir, "data"),
    pluginRollbackDir: path.join(pluginsDir, "plugin-rollback"),
    skillPackagesDir: path.join(skillsDir, "packages"),
    skillStagingDir: path.join(skillsDir, "staging"),
    skillRegistryPath: path.join(skillsDir, "registry.json"),
    nativeMcpDir,
    nativeMcpRegistryPath: path.join(nativeMcpDir, "registry.json"),
    computerDir,
    computerArtifactsDir: path.join(computerDir, "artifacts"),
    computerEphemeralDir: path.join(cacheDir, "computer-sessions"),
    socketPath: path.join(runtimeDir, "service.sock"),
    tokenPath: path.join(runtimeDir, "client.token"),
    lockPath: path.join(runtimeDir, "service.lock"),
    federationSocketPath: path.join(runtimeDir, "app-host.sock"),
    federationTokenPath: path.join(runtimeDir, "app-host.token"),
  });
}

// CLI tools may replace HOME. Production roots always derive from the system
// account, and never from an environment selector or a model-provided path.
function systemHome(userInfo = os.userInfo) {
  const home = userInfo()?.homedir;
  if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0")
    || path.resolve(home) === path.parse(home).root) throw new TypeError("Invalid system home");
  return path.resolve(home);
}

function resolveCanonicalServicePaths(options = {}) {
  return resolveServicePaths({ homeDir: systemHome(options.userInfo) });
}

module.exports = { resolveCanonicalServicePaths, resolveServicePaths, systemHome };
