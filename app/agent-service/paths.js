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
  const nativeMcpDir = path.join(stateDir, "mcp-servers");
  const nativeRuntimeImportsDir = path.join(stateDir, "native-runtime-imports");
  const runtimeAccountsDir = path.join(stateDir, "runtime-accounts");
  const runtimeIntegrationDir = path.join(stateDir, "runtime-integration");
  const runtimeSessionOwnershipDir = path.join(stateDir, "runtime-session-ownership");
  const legacyRuntimeHomesDir = path.join(stateDir, "legacy-runtime-homes");
  const computerDir = path.join(stateDir, "computer");
  return Object.freeze({
    stateDir,
    userDataRoot,
    trustedRoot,
    stateSnapshotPath: path.join(stateDir, "state.snapshot.json"),
    eventLogPath: path.join(stateDir, "events.jsonl"),
    tokenUsagePath: path.join(stateDir, "token-usage.jsonl"),
    encryptedSecretsPath: path.join(stateDir, "encrypted-secrets.json"),
    mcpAuthPath: path.join(stateDir, "mcp-auth.json"),
    accountAuthStatePath: path.join(stateDir, "account-auth-state.json"),
    accountAuthStateV2Path: path.join(stateDir, "account-auth-state-v2.json"),
    runtimeSwitchPath: path.join(stateDir, "runtime-switch.json"),
    runtimeAccountMigrationPath: path.join(stateDir, "runtime-account-migration-v1.json"),
    legacyCodexApiKeyMigrationPath: path.join(
      stateDir,
      "legacy-codex-api-key-migration-v1.json",
    ),
    memoryMigrationPath: path.join(stateDir, "memory-authority-v1.json"),
    nativeRuntimeImportPath: path.join(nativeRuntimeImportsDir, "native-runtime-import-v1.json"),
    nativeRuntimeImportStagingDir: path.join(nativeRuntimeImportsDir, "staging"),
    runtimeAccountsDir,
    runtimeIntegrationDir,
    runtimeSessionOwnershipDir,
    runtimeSessionOwnershipPath: path.join(runtimeSessionOwnershipDir, "ownership-v1.json"),
    legacyRuntimeHomesDir,
    legacyRuntimeHomesPath: path.join(legacyRuntimeHomesDir, "manifest.json"),
    runtimeCleanupAuditPath: path.join(legacyRuntimeHomesDir, "cleanup-audit.jsonl"),
    backupCleanupAuditPath: path.join(backupsDir, ".cleanup-audit.jsonl"),
    toolPolicyPath: path.join(stateDir, "tool-permissions.json"),
    profileDir,
    cacheDir,
    runtimeDir,
    defaultWorkspaceDir,
    backupsDir,
    agentsDir,
    skillsDir,
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

function resolveCanonicalServicePaths(options = {}) {
  const userInfo = options.userInfo || os.userInfo;
  if (typeof userInfo !== "function") {
    throw new TypeError("canonical service userInfo must be a function");
  }
  const account = userInfo();
  if (!account || typeof account.homedir !== "string" || !path.isAbsolute(account.homedir)
    || account.homedir.includes("\0")) {
    throw new TypeError("canonical service home directory is invalid");
  }
  // Runtime CLI 会覆盖 HOME；安全边界必须锚定系统账号记录，而不是可继承的环境变量。
  return resolveServicePaths({ homeDir: account.homedir });
}

module.exports = { resolveCanonicalServicePaths, resolveServicePaths };
