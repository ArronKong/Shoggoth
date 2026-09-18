"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { CODEX_VERSION } = require("./codex-schema-contract");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const CODEX_APP_SERVER_ARGS = Object.freeze([
  "-c",
  "check_for_update_on_startup=false",
  "app-server",
  "--stdio",
]);
const PARENT_ENV_ALLOWLIST = Object.freeze([
  "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "USER", "LOGNAME", "SHELL",
]);
const RESERVED_SPAWN_ENV = new Set(["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);

function runtimeError(code, message) {
  return serviceError(code, message);
}

function assertRuntimeProfileId(runtimeProfileId) {
  if (typeof runtimeProfileId !== "string" || runtimeProfileId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runtimeProfileId)) {
    throw runtimeError("CODEX_RUNTIME_PROFILE_INVALID", "Codex runtime profile id is invalid");
  }
  return runtimeProfileId;
}

function assertRegularExecutable(target, label) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw runtimeError("CODEX_RUNTIME_INVALID", `${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw runtimeError("CODEX_RUNTIME_INVALID", `${label} is unsafe`);
  }
  try {
    if (fs.realpathSync(target) !== path.resolve(target)) throw new Error("escaped path");
    fs.accessSync(target, fs.constants.X_OK);
  } catch {
    throw runtimeError("CODEX_RUNTIME_INVALID", `${label} is not an executable regular file`);
  }
}

function executableRealpath(candidate, fileSystem = fs) {
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

function resolveCodexSystemBinary(options = {}) {
  const fileSystem = options.fs || fs;
  if (options.binaryPath !== undefined) {
    const resolved = executableRealpath(options.binaryPath, fileSystem);
    if (!resolved) {
      throw runtimeError(
        "CODEX_RUNTIME_INVALID",
        "Codex binaryPath must be an absolute executable regular file",
      );
    }
    return resolved;
  }
  const candidates = [];
  const pathValue = options.parentEnv?.PATH;
  if (typeof pathValue === "string") {
    for (const entry of pathValue.split(path.delimiter)) {
      if (path.isAbsolute(entry)) candidates.push(path.join(entry, "codex"));
    }
  }
  const home = options.homedir || os.homedir();
  if (typeof home === "string" && path.isAbsolute(home)) {
    candidates.push(path.join(home, ".local", "bin", "codex"));
  }
  candidates.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex");
  for (const candidate of [...new Set(candidates)]) {
    const resolved = executableRealpath(candidate, fileSystem);
    if (resolved) return resolved;
  }
  throw runtimeError("CODEX_SYSTEM_BINARY_NOT_FOUND", "Codex CLI is not installed or executable");
}

function resolveCodexMcpParentBinaries(options = {}) {
  const launcher = resolveCodexSystemBinary(options);
  if (path.basename(launcher) !== "codex.js") return Object.freeze([launcher]);
  const packageRoot = path.dirname(path.dirname(launcher));
  const metadata = readJsonFile(path.join(packageRoot, "package.json"), "CODEX_RUNTIME_PACKAGE_INVALID");
  if (metadata.name !== "@openai/codex" || metadata.bin?.codex !== "bin/codex.js"
    || path.join(packageRoot, "bin", "codex.js") !== launcher) {
    throw runtimeError("CODEX_RUNTIME_PACKAGE_INVALID", "Codex npm entrypoint is invalid");
  }
  // The official npm launcher spawns its platform package's native executable.
  // Resolve metadata only; never load or execute installed JavaScript here.
  const requireFromLauncher = createRequire(launcher);
  const parents = [];
  for (const [arch, target] of [["arm64", "aarch64-apple-darwin"], ["x64", "x86_64-apple-darwin"]]) {
    let vendorRoot;
    try {
      vendorRoot = path.join(path.dirname(requireFromLauncher.resolve(`@openai/codex-darwin-${arch}/package.json`)), "vendor");
    } catch {
      vendorRoot = path.join(packageRoot, "vendor");
    }
    const candidate = executableRealpath(path.join(vendorRoot, target, "bin", "codex"));
    if (candidate) parents.push(candidate);
  }
  if (parents.length === 0) {
    throw runtimeError("CODEX_RUNTIME_PACKAGE_INVALID", "Codex npm native executable is unavailable");
  }
  return Object.freeze([...new Set(parents)]);
}

function readJsonFile(target, code) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== path.resolve(target)) throw new Error("unsafe");
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw runtimeError(code, "Codex runtime metadata is unavailable or malformed");
  }
}

function escapesRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function assertContainedExistingPath(root, target, label) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (escapesRoot(realRoot, realTarget)) throw new Error("escaped root");
  } catch {
    throw runtimeError("CODEX_RUNTIME_MANIFEST_INVALID", `${label} escapes its trusted root`);
  }
}

function resolveManifestDestination(repoRoot, value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)
    || value.split(/[\\/]+/u).includes("..")) {
    throw runtimeError("CODEX_RUNTIME_MANIFEST_INVALID", `${label} must be a contained relative path`);
  }
  const target = path.resolve(repoRoot, value);
  if (escapesRoot(repoRoot, target)) {
    throw runtimeError("CODEX_RUNTIME_MANIFEST_INVALID", `${label} escapes repoRoot`);
  }
  assertContainedExistingPath(repoRoot, target, label);
  return target;
}

function resolveCodexRuntimeLayout(options) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const platformKey = `${platform}-${arch}`;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, "..", ".."));
  const packaged = Boolean(options.packaged);
  const resourcesPath = path.resolve(options.resourcesPath || process.resourcesPath || repoRoot);
  const manifestPath = packaged
    ? path.join(resourcesPath, "codex", "runtime-manifest.json")
    : path.join(repoRoot, "build", "codex-runtime-manifest.json");
  assertContainedExistingPath(packaged ? resourcesPath : repoRoot, manifestPath, "Codex runtime manifest");
  const manifest = readJsonFile(manifestPath, "CODEX_RUNTIME_MANIFEST_INVALID");
  const platformManifest = manifest.platforms?.[platformKey];
  if (manifest.schemaVersion !== 1 || manifest.runtime?.name !== "codex"
    || manifest.runtime?.version !== CODEX_VERSION || manifest.schema?.version !== CODEX_VERSION
    || manifest.schema?.includeExperimental !== false || !platformManifest) {
    throw runtimeError("CODEX_RUNTIME_VERSION_MISMATCH", "Codex runtime manifest is incompatible");
  }
  let runtimePath;
  let packageRoot;
  let hostPath;
  if (packaged) {
    packageRoot = path.join(resourcesPath, "codex", "package");
    runtimePath = path.join(packageRoot, "bin", "codex");
    hostPath = path.join(packageRoot, "bin", "codex-code-mode-host");
    for (const [target, label] of [
      [packageRoot, "Codex package"],
      [runtimePath, "Codex runtime"],
      [hostPath, "Codex code mode host"],
    ]) assertContainedExistingPath(resourcesPath, target, label);
  } else {
    runtimePath = resolveManifestDestination(repoRoot, platformManifest.destination, "destination");
    packageRoot = resolveManifestDestination(repoRoot, platformManifest.packageDestination, "packageDestination");
    hostPath = resolveManifestDestination(repoRoot, platformManifest.hostDestination, "hostDestination");
  }
  assertRegularExecutable(runtimePath, "Codex runtime");
  assertRegularExecutable(hostPath, "Codex code mode host");
  const packageMetadata = readJsonFile(path.join(packageRoot, "codex-package.json"), "CODEX_RUNTIME_PACKAGE_INVALID");
  if (packageMetadata.layoutVersion !== 1 || packageMetadata.version !== CODEX_VERSION
    || packageMetadata.variant !== "codex" || packageMetadata.entrypoint !== "bin/codex") {
    throw runtimeError("CODEX_RUNTIME_VERSION_MISMATCH", "Codex package metadata is incompatible");
  }
  if (!packaged) {
    if (path.dirname(path.dirname(runtimePath)) !== packageRoot
      || path.join(packageRoot, "bin", "codex-code-mode-host") !== hostPath) {
      throw runtimeError("CODEX_RUNTIME_MANIFEST_INVALID", "Codex runtime manifest paths disagree");
    }
  }
  return Object.freeze({
    version: CODEX_VERSION,
    manifestPath,
    runtimePath,
    packageRoot,
    hostPath,
    args: CODEX_APP_SERVER_ARGS,
  });
}

function prepareCodexHome(paths, runtimeProfileId) {
  assertRuntimeProfileId(runtimeProfileId);
  const base = path.join(paths.stateDir, "codex");
  const codexHome = path.join(base, runtimeProfileId);
  const relative = path.relative(base, codexHome);
  if (relative !== runtimeProfileId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError("CODEX_RUNTIME_PROFILE_INVALID", "Codex runtime profile path escapes its root");
  }
  ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
  ensurePrivateDirectoryTree(base, paths.trustedRoot);
  ensurePrivateDirectoryTree(codexHome, paths.trustedRoot);
  return codexHome;
}

function prepareCodexRuntimeAccountHome(paths, runtimeAccountId) {
  if (typeof runtimeAccountId !== "string" || runtimeAccountId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(runtimeAccountId)) {
    throw runtimeError("CODEX_RUNTIME_ACCOUNT_INVALID", "Codex runtime account id is invalid");
  }
  const accountsRoot = paths.runtimeAccountsDir || path.join(paths.stateDir, "runtime-accounts");
  const runtimeRoot = path.join(accountsRoot, "codex");
  const accountRoot = path.join(runtimeRoot, runtimeAccountId);
  const codexHome = path.join(accountRoot, "home");
  const relative = path.relative(runtimeRoot, accountRoot);
  if (relative !== runtimeAccountId || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError("CODEX_RUNTIME_ACCOUNT_INVALID", "Codex runtime account path escapes its root");
  }
  ensurePrivateDirectoryTree(accountsRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(runtimeRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(accountRoot, paths.trustedRoot);
  ensurePrivateDirectoryTree(codexHome, paths.trustedRoot);
  return codexHome;
}

function buildCodexSpawnEnv({ codexHome, parentEnv = process.env, spawnEnv = {}, installationKind = "bundled" }) {
  const env = {};
  for (const key of PARENT_ENV_ALLOWLIST) {
    if (typeof parentEnv[key] === "string" && parentEnv[key].length > 0) env[key] = parentEnv[key];
  }
  env.HOME ||= os.homedir();
  env.PATH ||= "/usr/bin:/bin";
  if (installationKind === "system") {
    // LaunchAgent does not source shell startup files. npm's Codex entrypoint
    // needs Node from the same installation directories used for CLI discovery.
    env.PATH = [...new Set([
      ...env.PATH.split(path.delimiter), path.join(env.HOME, ".local", "bin"),
      "/opt/homebrew/bin", "/usr/local/bin",
    ])].join(path.delimiter);
  }
  env.TMPDIR ||= os.tmpdir();
  for (const [key, value] of Object.entries(spawnEnv || {})) {
    if (RESERVED_SPAWN_ENV.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof value !== "string" || value.includes("\0")) {
      throw runtimeError("CODEX_SPAWN_ENV_INVALID", "Codex explicit spawn environment is invalid");
    }
    env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  return Object.freeze(env);
}

module.exports = {
  CODEX_APP_SERVER_ARGS,
  PARENT_ENV_ALLOWLIST,
  assertRuntimeProfileId,
  buildCodexSpawnEnv,
  prepareCodexHome,
  prepareCodexRuntimeAccountHome,
  resolveCodexSystemBinary,
  resolveCodexMcpParentBinaries,
  resolveCodexRuntimeLayout,
  runtimeError,
};
