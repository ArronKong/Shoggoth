#!/usr/bin/env node
"use strict";

// Installation-only backup: never stops processes, changes authority, replaces
// the App, edits flags, reads a linked target, or copies an external CLI Home.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { audit } = require("./runtime-upgrade-audit.cjs");
const { assertInstallProcesses, PERMIT_ENV } = require("./runtime-install-process-guard.cjs");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function hashFile(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("BACKUP_NON_REGULAR_FILE");
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(target);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]
      || before[key] !== current[key]) || current.isSymbolicLink()) fail("BACKUP_SOURCE_CHANGED");
    return hash.digest("hex");
  } finally { buffer.fill(0); fs.closeSync(fd); }
}
function manifestTree(root) {
  const entries = [];
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("BACKUP_UNSAFE_ROOT");
  function visit(relative) {
    const target = path.join(root, relative), before = fs.lstatSync(target);
    if (before.uid !== process.getuid()) fail("BACKUP_FOREIGN_OWNER");
    const entry = { path: relative.split(path.sep).join("/"), mode: before.mode & 0o777 };
    if (before.isSymbolicLink()) {
      entries.push({ ...entry, type: "symlink", target: fs.readlinkSync(target) });
    } else if (before.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const name of fs.readdirSync(target).sort()) visit(path.join(relative, name));
    } else if (before.isFile()) {
      entries.push({ ...entry, type: "file", bytes: before.size, sha256: hashFile(target) });
    } else fail("BACKUP_SPECIAL_FILE");
    const after = fs.lstatSync(target);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) fail("BACKUP_SOURCE_CHANGED");
  }
  visit("");
  return { entries, digest: digest(JSON.stringify(entries)),
    fileCount: entries.filter(entry => entry.type === "file").length,
    symlinkCount: entries.filter(entry => entry.type === "symlink").length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) };
}
function assertStopped(paths, permitPath) {
  if (fs.existsSync(paths.lockPath) || fs.existsSync(paths.socketPath)) fail("BACKUP_SERVICE_ACTIVE");
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".writer.lock")) fail("BACKUP_WRITER_ACTIVE");
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  }
  visit(paths.stateDir);
  const processGuard = assertInstallProcesses({ permitPath });
  try {
    execFileSync("/bin/launchctl", ["print", `gui/${process.getuid()}/com.shoggoth.agent-service`],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    fail("BACKUP_LAUNCH_AGENT_LOADED");
  } catch (error) {
    if (error.code === "BACKUP_LAUNCH_AGENT_LOADED") throw error;
    if (error.status !== 113 || !String(error.stderr).includes('Could not find service "com.shoggoth.agent-service"')) {
      fail("BACKUP_LAUNCH_AGENT_STATE_UNKNOWN");
    }
  }
  return processGuard;
}
function writeJson(target, value) {
  const fd = fs.openSync(target, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function backup(output, { permitPath = process.env[PERMIT_ENV] || null } = {}) {
  const paths = resolveCanonicalServicePaths();
  output = path.resolve(output);
  const relative = path.relative(paths.stateDir, output);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") fail("BACKUP_OUTPUT_INSIDE_SOURCE");
  if (fs.existsSync(output)) fail("BACKUP_OUTPUT_EXISTS");
  const processGuard = assertStopped(paths, permitPath);
  const manifest = manifestTree(paths.stateDir);
  const free = fs.statfsSync(path.dirname(paths.stateDir));
  if (free.bavail * free.bsize < manifest.bytes * 2 + 256 * 1024 * 1024) fail("BACKUP_SPACE_INSUFFICIENT");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const before = audit(paths);
  if (!before.quiescent || before.product.eventLog?.bytes !== 0) fail("BACKUP_SNAPSHOT_NOT_QUIESCENT");
  writeJson(path.join(output, "source-manifest.json"), { version: 1, source: paths.stateDir, ...manifest });
  writeJson(path.join(output, "before-audit.json"), before);
  const archive = path.join(output, "state.tar");
  const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };
  execFileSync("/usr/bin/tar", ["-cpf", archive, "-C", path.dirname(paths.stateDir), path.basename(paths.stateDir)],
    { env: tarEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 1024 * 1024 });
  fs.chmodSync(archive, 0o600);
  const archiveFd = fs.openSync(archive, fs.constants.O_RDONLY);
  try { fs.fsyncSync(archiveFd); } finally { fs.closeSync(archiveFd); }
  const extras = [];
  for (const [name, source] of [["config.json", path.join(paths.userDataRoot, "config.json")],
    ["com.shoggoth.agent-service.plist", path.join(os.userInfo().homedir, "Library", "LaunchAgents", "com.shoggoth.agent-service.plist")]]) {
    if (!fs.existsSync(source)) continue;
    const sourceHash = hashFile(source), destination = path.join(output, name);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    const extraFd = fs.openSync(destination, fs.constants.O_RDONLY);
    try { fs.fsyncSync(extraFd); } finally { fs.closeSync(extraFd); }
    if (hashFile(destination) !== sourceHash || hashFile(source) !== sourceHash) fail("BACKUP_EXTRA_MISMATCH");
    extras.push({ name, sha256: sourceHash });
  }
  assertStopped(paths, permitPath);
  if (manifestTree(paths.stateDir).digest !== manifest.digest) fail("BACKUP_SOURCE_CHANGED");
  const restoreDirectory = fs.mkdtempSync(path.join(path.dirname(output), "verify-restore-"));
  let verified = false;
  try {
    execFileSync("/usr/bin/tar", ["-xpf", archive, "-C", restoreDirectory],
      { env: tarEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 1024 * 1024 });
    const restored = manifestTree(path.join(restoreDirectory, path.basename(paths.stateDir)));
    if (restored.digest !== manifest.digest) fail("BACKUP_RESTORE_MANIFEST_MISMATCH");
    assertStopped(paths, permitPath);
    verified = true;
    const receipt = { version: 1, createdAt: new Date().toISOString(), verified: true,
      sourceStateDir: paths.stateDir, archive: "state.tar", archiveSha256: hashFile(archive),
      manifestDigest: manifest.digest, fileCount: manifest.fileCount, symlinkCount: manifest.symlinkCount,
      sourceBytes: manifest.bytes, archiveBytes: fs.statSync(archive).size,
      includesExistingBackups: true, followsSymlinks: false, extras, restoredCopyRemoved: true, processGuard,
      encryptionBoundary: "Ciphertext and local master key preserved. macOS Keychain remains on this Mac; no keychain export or decryption was performed." };
    writeJson(path.join(output, "receipt.json"), receipt);
    const outputFd = fs.openSync(output, fs.constants.O_RDONLY);
    try { fs.fsyncSync(outputFd); } finally { fs.closeSync(outputFd); }
    return { output, ...receipt };
  } finally {
    // Only this invocation's newly-created verification copy is removed.
    fs.rmSync(restoreDirectory, { recursive: true, force: true });
    if (!verified) writeJson(path.join(output, "verification-failed.json"), { verified: false, originalDataUnchanged: true });
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!["--output", "--external-mcp-permit"].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail("BACKUP_ARGUMENTS_INVALID");
      options.set(args[i], args[i + 1]);
    }
    if (!options.has("--output")) fail("Usage: runtime-upgrade-backup.cjs --output NEW_DIRECTORY [--external-mcp-permit PRIVATE_JSON]");
    console.log(JSON.stringify(backup(options.get("--output"), { permitPath: options.get("--external-mcp-permit") || process.env[PERMIT_ENV] || null }), null, 2));
  } catch (error) { console.error(error.code || "BACKUP_FAILED"); process.exitCode = 1; }
}
module.exports = { manifestTree, backup };
