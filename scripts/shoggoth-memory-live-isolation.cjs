"use strict";

const fs = require("node:fs"), path = require("node:path");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { prepareAntigravityRuntimeAccountHome } = require("../app/agent-service/antigravity-runtime-paths");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { verifyAntigravityAcpServer } = require("../app/agent-service/antigravity-acp-distribution");
const fail = code => { throw Object.assign(new Error(code), { code }); };

// The native read-only profile derives its automatic Docker deny paths from
// HOME. A disposable HOME must preserve only the canonical socket-directory
// identity, without copying Docker config, moving the system link or widening
// the requested sandbox. The alias is a deny-path input, never a write grant.
function prepareGrokSocketDenyAlias(root, directory, socketPath = "/var/run/docker.sock") {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) fail("MEMORY_LIVE_SOCKET_DIRECTORY_UNSAFE");
  const stat = fs.lstatSync(directory), linkStat = fs.lstatSync(socketPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || stat.mode & 0o022 || !linkStat.isSymbolicLink()) fail("MEMORY_LIVE_SOCKET_DIRECTORY_UNSAFE");
  const target = fs.readlinkSync(socketPath);
  if (!path.isAbsolute(target) || path.basename(target) !== "docker.sock"
    || fs.realpathSync(path.dirname(target)) !== directory) fail("MEMORY_LIVE_SOCKET_TARGET_MISMATCH");
  const parent = path.join(root, ".docker");
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.symlinkSync(directory, path.join(parent, "run"), "dir");
  return { kind: "grok-automatic-socket-deny", socketPath, target, directory,
    socketInode: linkStat.ino, directoryInode: stat.ino, directoryDevice: stat.dev };
}

function assertGrokSocketDenyAlias(root, evidence) {
  const stat = fs.lstatSync(evidence.directory), link = fs.lstatSync(evidence.socketPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== evidence.directoryInode
    || stat.dev !== evidence.directoryDevice || stat.uid !== process.getuid() || stat.mode & 0o022
    || !link.isSymbolicLink() || link.ino !== evidence.socketInode || fs.readlinkSync(evidence.socketPath) !== evidence.target
    || fs.realpathSync(path.join(root, ".docker", "run")) !== evidence.directory) fail("MEMORY_LIVE_SOCKET_IDENTITY_CHANGED");
}

async function prepareAntigravityFileAccount(root, options, bytes) {
  const sourceDir = path.dirname(options.runtimeBin);
  const sourcePaths = { stateDir: path.resolve(sourceDir, "../../.."), trustedRoot: path.parse(sourceDir).root };
  const source = await verifyAntigravityAcpServer({ paths: sourcePaths });
  if (fs.realpathSync(options.runtimeBin) !== source.serverPath) fail("MEMORY_LIVE_CLI_INVALID");
  const auth = JSON.parse(bytes.toString("utf8"));
  if (!auth || typeof auth !== "object" || !["refresh_token", "client_id", "client_secret"].every(key => typeof auth[key] === "string" && auth[key])) {
    fail("MEMORY_LIVE_ANTIGRAVITY_AUTH_INVALID");
  }
  const paths = resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) });
  const destination = path.join(paths.stateDir, "runtime-bin", "antigravity-acp", source.version);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const sourceFile of [source.serverPath, source.harnessPath]) {
    const target = path.join(destination, path.basename(sourceFile));
    fs.copyFileSync(sourceFile, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(target, 0o700);
  }
  await verifyAntigravityAcpServer({ paths });
  const home = prepareAntigravityRuntimeAccountHome(paths, NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID);
  const acp = path.join(home, ".gemini", "antigravity-acp");
  fs.mkdirSync(acp, { mode: 0o700 });
  const tokenPath = path.join(acp, "acp_token.json");
  fs.writeFileSync(tokenPath, bytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(acp, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }), { flag: "wx", mode: 0o600 });
  return { runtime: "antigravity", authFiles: [path.relative(root, tokenPath)],
    isolation: { kind: "antigravity-file-credentials", version: source.version, copiedOfficialBinaries: true,
      credentialSource: "explicit-private-file", keychainPreparation: false } };
}


// Acceptance-only outer boundary. The unmodified signed ACP server and its
// descendants may write only the disposable root. Keychain IPC stays denied
// even if a future upstream code path ignores its file-storage selection.
function antigravityRuntimeSandbox(root, repo, rollbackSource) {
  const os = require("node:os"), home = fs.realpathSync(os.homedir());
  const publicRoots = ["app", "build", "resources", "schemas", "scripts", "node_modules", "vendor", ".vendor"]
    .map(name => path.join(repo, name)).filter(target => fs.existsSync(target)).map(target => fs.realpathSync(target));
  if (rollbackSource) publicRoots.push(fs.realpathSync(rollbackSource));
  const publicFiles = [path.join(repo, "package.json"), path.join(repo, "package-lock.json")]
    .filter(target => fs.existsSync(target)).map(target => fs.realpathSync(target));
  const quote = JSON.stringify;
  const exclusions = publicRoots.map(target => `(require-not (subpath ${quote(target)}))`)
    .concat(publicFiles.map(target => `(require-not (literal ${quote(target)}))`)).join(" ");
  const policy = ["(version 1)", "(allow default)",
    `(deny file-read-data (require-all (subpath ${quote(home)}) ${exclusions}))`,
    `(deny file-write* (require-all (require-not (subpath ${quote(root)})) (require-not (literal "/dev/null"))))`,
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
    '(deny process-exec (literal "/usr/bin/security"))',
  ].join("\n") + "\n";
  const policyPath = path.join(root, "antigravity-worker.sb");
  fs.writeFileSync(policyPath, policy, { flag: "wx", mode: 0o600 });
  return { command: "/usr/bin/sandbox-exec", argsPrefix: ["-f", policyPath], policyPath,
    evidence: { kind: "macos-seatbelt", scope: "official-runtime-descendants", originalHomeDataRead: "denied-except-public-source", originalHomeWrite: "denied",
      keychainIPC: "denied", writes: "disposable-root-only", publicRoots, publicFiles } };
}

module.exports = { prepareGrokSocketDenyAlias, assertGrokSocketDenyAlias, prepareAntigravityFileAccount, antigravityRuntimeSandbox };
