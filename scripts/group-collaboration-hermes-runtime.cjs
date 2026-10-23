"use strict";
// A shared, test-owned snapshot of the already-installed Hermes application.
// Preparing it copies public tracked Runtime code only. It never invokes the
// install/update launcher and never copies original USER/SOUL/session/auth data.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SOURCE_ROOT = path.join(os.homedir(), ".hermes", "hermes-agent");
const PRIVATE_COMPONENTS = new Set([".git", ".venv", ".hermes", "node_modules", "__pycache__"]);
function rootPath(root, empty = false) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !root.startsWith("/private/tmp/sggroup-hermes-runtime-")) throw fail("GROUP_LIVE_HERMES_ARCHIVE_ROOT_INVALID");
  const stat = fs.lstatSync(root);
  if (!root.startsWith("/private/tmp/sggroup-hermes-runtime-") || path.resolve(root) !== root || !stat.isDirectory()
    || stat.isSymbolicLink() || fs.realpathSync(root) !== root || stat.uid !== process.getuid() || stat.mode & 0o077
    || empty && fs.readdirSync(root).length) throw fail("GROUP_LIVE_HERMES_ARCHIVE_ROOT_INVALID");
  return root;
}
function regularBytes(file, limit = 32 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit || before.mode & 0o022)
    throw fail("GROUP_LIVE_HERMES_PUBLIC_FILE_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size || bytes.length !== opened.size
      || before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw fail("GROUP_LIVE_HERMES_PUBLIC_FILE_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function relativeSafe(relative) {
  return typeof relative === "string" && relative.length > 0 && !path.isAbsolute(relative)
    && path.normalize(relative) === relative && !relative.split(path.sep).some(part => part === ".." || PRIVATE_COMPONENTS.has(part))
    && !["USER.md", "SOUL.md", "MEMORY.md", "auth.json", ".env"].includes(relative);
}
function fileState(file) {
  const stat = fs.lstatSync(file), bytes = regularBytes(file);
  return { path: file, sha256: sha(bytes), bytes: bytes.length, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function originalKnownFiles() {
  return [path.join(SOURCE_ROOT, "install-stamp.json"), path.join(SOURCE_ROOT, "hermes_bootstrap.py"),
    path.join(SOURCE_ROOT, "hermes_cli/main.py"), path.join(SOURCE_ROOT, "hermes_cli/web_dist/index.html"),
    path.join(SOURCE_ROOT, ".hermes/bin/hermes"), path.join(os.homedir(), ".local/bin/hermes")].map(fileState);
}
function write(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function prepareArchive(root) {
  rootPath(root, true);
  const knownBefore = originalKnownFiles(), commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE_ROOT, encoding: "utf8", timeout: 5000 }).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw fail("GROUP_LIVE_HERMES_RUNTIME_COMMIT_INVALID");
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: SOURCE_ROOT, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
  const selected = new Set(names.filter(relativeSafe)), skipped = names.filter(name => !selected.has(name));
  // Prepared dashboard assets and version metadata are public installed
  // artifacts, but may be untracked. No other untracked files enter the copy.
  selected.add("install-stamp.json");
  const web = path.join(SOURCE_ROOT, "hermes_cli/web_dist");
  const walkWeb = relative => {
    const full = path.join(SOURCE_ROOT, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw fail("GROUP_LIVE_HERMES_WEB_ASSET_SYMLINK");
    if (stat.isDirectory()) for (const entry of fs.readdirSync(full)) walkWeb(path.join(relative, entry));
    else if (stat.isFile() && relativeSafe(relative)) selected.add(relative);
  };
  if (!fs.existsSync(path.join(web, "index.html"))) throw fail("GROUP_LIVE_HERMES_WEB_ASSETS_MISSING");
  walkWeb("hermes_cli/web_dist");
  let totalBytes = 0; const files = [];
  for (const relative of [...selected].sort()) {
    const stat = fs.lstatSync(path.join(SOURCE_ROOT, relative));
    if (stat.isSymbolicLink()) { skipped.push(relative); continue; }
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw fail("GROUP_LIVE_HERMES_PUBLIC_FILE_UNSAFE");
    totalBytes += stat.size; files.push(relative);
  }
  const disk = fs.statfsSync("/private/tmp");
  if (disk.bavail * disk.bsize < 1024 ** 3 + totalBytes * 2) throw fail("GROUP_LIVE_DISK_SPACE_LOW");
  // PM's committed facts select the prepared generation. The source .venv
  // can be a stale real directory and must not be guessed as the active one.
  const installState = path.join(os.homedir(), ".hermes/installs", sha(fs.realpathSync(SOURCE_ROOT)).slice(0, 16));
  const dependencyFactsPath = path.join(installState, "facts.json"), dependencyFacts = regularBytes(dependencyFactsPath, 1024 * 1024);
  const selectedEnvironment = JSON.parse(dependencyFacts).packages?.venv?.environment;
  if (typeof selectedEnvironment !== "string" || path.resolve(selectedEnvironment) !== selectedEnvironment
    || !selectedEnvironment.startsWith(path.join(installState, "environments") + path.sep))
    throw fail("GROUP_LIVE_HERMES_PREPARED_INTERPRETER_UNCONFIRMED");
  const venv = fs.realpathSync(selectedEnvironment), interpreter = path.join(venv, "bin/python");
  if (!venv.startsWith(path.join(installState, "environments") + path.sep)
    || !fs.lstatSync(path.join(venv, "pyvenv.cfg")).isFile() || !fs.statSync(interpreter).isFile())
    throw fail("GROUP_LIVE_HERMES_PREPARED_INTERPRETER_UNCONFIRMED");
  const application = path.join(root, "application"), fingerprints = {}, fileModes = {};
  for (const relative of files) {
    const bytes = regularBytes(path.join(SOURCE_ROOT, relative));
    const mode = fs.statSync(path.join(SOURCE_ROOT, relative)).mode & 0o111 ? 0o500 : 0o400;
    write(path.join(application, relative), bytes, mode);
    fingerprints[path.join("application", relative)] = sha(bytes); fileModes[path.join("application", relative)] = mode;
  }
  const entry = path.join(root, "entry.py"), launcher = path.join(root, "hermes");
  write(entry, "import sys\nsys.dont_write_bytecode=True\nsys.path.insert(0," + JSON.stringify(application) + ")\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nmain()\n", 0o400);
  const shellQuote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  write(launcher, "#!/bin/sh\nexec " + shellQuote(interpreter) + " -I -B " + shellQuote(entry) + ' "$@"\n', 0o500);
  fingerprints["entry.py"] = sha(regularBytes(entry)); fingerprints.hermes = sha(regularBytes(launcher)); fileModes["entry.py"] = 0o400; fileModes.hermes = 0o500;
  const seal = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) seal(path.join(directory, entry.name)); fs.chmodSync(directory, 0o500); };
  seal(application);
  const knownAfter = originalKnownFiles();
  if (JSON.stringify(knownBefore) !== JSON.stringify(knownAfter)) throw fail("GROUP_LIVE_HERMES_ORIGINAL_PUBLIC_FILES_CHANGED");
  const marker = { version: 1, owner: "group-collaboration-live-evaluation", sourceRoot: SOURCE_ROOT, sourceCommit: commit,
    publicRuntimeFiles: files.length, totalBytes, application, entry, launcher, interpreter,
    interpreterRealPath: fs.realpathSync(interpreter), interpreterSha256: sha(fs.readFileSync(interpreter)),
    dependencyFactsPath, dependencyFactsSha256: sha(dependencyFacts), interpreterSelection: "pm-committed-facts-packages-venv-environment",
    fingerprints, fileModes, archiveDigest: sha(JSON.stringify({ fingerprints, fileModes })), knownOriginalFiles: knownBefore,
    knownOriginalFilesPreservedAtPreparation: true, originalWholeHomeWriteObservation: "not-observed",
    skippedPrivateOrSymlinkPaths: skipped, preparedByInvokingInstallOrModel: false, readOnlyRuntimeFileModes: true };
  write(path.join(root, ".group-collaboration-owned-hermes-runtime.json"), JSON.stringify(marker) + "\n", 0o400);
  fs.chmodSync(root, 0o500);
  return { root, archiveDigest: marker.archiveDigest, sourceCommit: commit, publicRuntimeFiles: files.length, totalBytes, providerCalls: 0 };
}
function loadArchive(root) {
  rootPath(root);
  const markerFile = path.join(root, ".group-collaboration-owned-hermes-runtime.json"), marker = JSON.parse(regularBytes(markerFile, 8 * 1024 * 1024));
  if (marker.version !== 1 || marker.owner !== "group-collaboration-live-evaluation" || marker.preparedByInvokingInstallOrModel !== false
    || marker.application !== path.join(root, "application") || marker.entry !== path.join(root, "entry.py")
    || marker.launcher !== path.join(root, "hermes") || !/^[a-f0-9]{40}$/u.test(marker.sourceCommit || "")
    || !/^[a-f0-9]{64}$/u.test(marker.archiveDigest || "") || marker.readOnlyRuntimeFileModes !== true || !marker.fingerprints || typeof marker.fingerprints !== "object"
    || !marker.fileModes || typeof marker.fileModes !== "object" || Object.keys(marker.fileModes).length !== Object.keys(marker.fingerprints).length
    || sha(JSON.stringify({ fingerprints: marker.fingerprints, fileModes: marker.fileModes })) !== marker.archiveDigest) throw fail("GROUP_LIVE_HERMES_ARCHIVE_METADATA_INVALID");
  // Seal the complete inventory, including directories and the launcher
  // import path. Extra shadow modules/assets are a source change even when
  // every previously-listed file still has the expected byte digest.
  const markerName = ".group-collaboration-owned-hermes-runtime.json";
  const expectedFiles = new Set([...Object.keys(marker.fingerprints), markerName]), expectedDirectories = new Set([""]);
  for (const relative of expectedFiles) { let parent = path.dirname(relative); while (parent !== ".") { expectedDirectories.add(parent); parent = path.dirname(parent); } }
  const actualFiles = [], actualDirectories = [];
  const walk = relative => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o222 || stat.mode & 0o077)
      throw fail("GROUP_LIVE_HERMES_ARCHIVE_PERMISSIONS_CHANGED");
    if (stat.isDirectory()) {
      if (!expectedDirectories.has(relative)) throw fail("GROUP_LIVE_HERMES_ARCHIVE_INVENTORY_CHANGED");
      actualDirectories.push(relative);
      for (const entry of fs.readdirSync(full).sort()) walk(path.join(relative, entry));
    } else if (stat.isFile()) {
      if (!expectedFiles.has(relative)) throw fail("GROUP_LIVE_HERMES_ARCHIVE_INVENTORY_CHANGED");
      const expectedMode = relative === markerName ? 0o400 : marker.fileModes[relative];
      if (![0o400, 0o500].includes(expectedMode) || (stat.mode & 0o777) !== expectedMode) throw fail("GROUP_LIVE_HERMES_ARCHIVE_PERMISSIONS_CHANGED");
      actualFiles.push(relative);
    } else throw fail("GROUP_LIVE_HERMES_ARCHIVE_INVENTORY_CHANGED");
  };
  walk("");
  if (actualFiles.length !== expectedFiles.size || actualDirectories.length !== expectedDirectories.size)
    throw fail("GROUP_LIVE_HERMES_ARCHIVE_INVENTORY_CHANGED");
  for (const [relative, digest] of Object.entries(marker.fingerprints)) {
    if (!relativeSafe(relative) || !/^[a-f0-9]{64}$/u.test(digest) || fs.lstatSync(path.join(root, relative)).mode & 0o222 || sha(regularBytes(path.join(root, relative))) !== digest)
      throw fail("GROUP_LIVE_HERMES_ARCHIVE_CHANGED");
  }
  const expectedFacts = path.join(os.homedir(), ".hermes/installs", sha(fs.realpathSync(SOURCE_ROOT)).slice(0, 16), "facts.json");
  if (marker.sourceRoot !== SOURCE_ROOT || marker.dependencyFactsPath !== expectedFacts || marker.interpreterSelection !== "pm-committed-facts-packages-venv-environment"
    || sha(regularBytes(expectedFacts, 1024 * 1024)) !== marker.dependencyFactsSha256)
    throw fail("GROUP_LIVE_HERMES_DEPENDENCY_FACTS_CHANGED");
  if (typeof marker.interpreter !== "string" || !marker.interpreter.startsWith(path.join(os.homedir(), ".hermes/installs") + path.sep) || path.resolve(marker.interpreter) !== marker.interpreter || fs.realpathSync(marker.interpreter) !== marker.interpreterRealPath || sha(fs.readFileSync(marker.interpreter)) !== marker.interpreterSha256) throw fail("GROUP_LIVE_HERMES_INTERPRETER_CHANGED");
  return { launcher: marker.launcher, env: { HERMES_DISABLE_LAZY_INSTALLS: "1", PYTHONDONTWRITEBYTECODE: "1", HERMES_WEB_DIST: path.join(marker.application, "hermes_cli/web_dist") },
    evidence: { root, archiveDigest: marker.archiveDigest, markerSha256: sha(regularBytes(markerFile, 8 * 1024 * 1024)), sourceCommit: marker.sourceCommit,
      publicRuntimeFiles: marker.publicRuntimeFiles, totalBytes: marker.totalBytes, interpreter: marker.interpreter,
      interpreterRealPath: marker.interpreterRealPath, interpreterSha256: marker.interpreterSha256, dependencyFactsPath: marker.dependencyFactsPath,
      dependencyFactsSha256: marker.dependencyFactsSha256, interpreterSelection: marker.interpreterSelection, launcherSha256: marker.fingerprints.hermes,
      originalKnownPublicFilesPreserved: JSON.stringify(marker.knownOriginalFiles) === JSON.stringify(originalKnownFiles()),
      originalWholeHomeWriteObservation: "not-observed", frozenReadOnlyReuse: true } };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--prepare-owned-runtime") throw fail("GROUP_LIVE_HERMES_ARCHIVE_ARGS_INVALID");
    process.stdout.write(JSON.stringify(prepareArchive(process.argv[3])) + "\n");
  } catch (error) { process.stderr.write(JSON.stringify({ status: "failed", errorCode: /^[A-Z][A-Z0-9_]+$/u.test(error?.code || "") ? error.code : "GROUP_LIVE_HERMES_ARCHIVE_FAILED", providerCalls: 0 }) + "\n"); process.exitCode = 1; }
}
module.exports = { prepareArchive, loadArchive, relativeSafe, regularBytes };
