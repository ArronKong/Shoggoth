"use strict";

// App-owned compatibility candidates. This module never modifies an installed
// host, starts a writer on its own, or treats a JSON readiness flag as authority.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const HEX = /^[a-f0-9]{64}$/;
const BACKENDS = new Set(["openclaw", "hermes"]);
const AUTHORITIES = new WeakMap();
const CONTROLLER_METHODS = Object.freeze([
  "inspectWriter", "acquireDrain", "assertIdle", "stopWriter",
  "claimExclusiveDataFence", "startPaused", "waitHealthy", "resume", "failClosed", "abortAndWait",
]);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value));
function failure(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}
function requireValue(condition, code, detail) { if (!condition) throw failure(code, detail); }
function plain(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function inside(root, value) { return value === root || value.startsWith(root + path.sep); }
function backend(value) { requireValue(BACKENDS.has(value), "RUNTIME_BACKEND_UNSUPPORTED"); return value; }
function relative(value) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 4096
    && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part && part !== "." && part !== ".."), "RUNTIME_PATH_INVALID");
  return value;
}
function fileStatIdentity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function safeDirectory(root) {
  const stat = fs.lstatSync(root);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "RUNTIME_DIRECTORY_UNSAFE");
  return fs.realpathSync(root);
}
function readStableFile(target, { privateFile = false, maxBytes = Infinity } = {}) {
  const before = fs.lstatSync(target);
  requireValue(before.isFile() && !before.isSymbolicLink(), "RUNTIME_FILE_UNSAFE");
  requireValue(before.size <= maxBytes, "RUNTIME_FILE_TOO_LARGE");
  if (privateFile) {
    requireValue(before.nlink === 1 && (before.mode & 0o077) === 0
      && (!process.getuid || before.uid === process.getuid()), "RUNTIME_PRIVATE_FILE_UNSAFE");
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    requireValue(fileStatIdentity(before) === fileStatIdentity(fs.fstatSync(fd)), "RUNTIME_INPUT_CHANGED");
    const bytes = fs.readFileSync(fd);
    requireValue(fileStatIdentity(before) === fileStatIdentity(fs.fstatSync(fd))
      && fileStatIdentity(before) === fileStatIdentity(fs.lstatSync(target)), "RUNTIME_INPUT_CHANGED");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function hashFile(target) {
  const before = fs.lstatSync(target);
  requireValue(before.isFile() && !before.isSymbolicLink(), "RUNTIME_FILE_UNSAFE");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    requireValue(fileStatIdentity(before) === fileStatIdentity(fs.fstatSync(fd)), "RUNTIME_INPUT_CHANGED");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    requireValue(fileStatIdentity(before) === fileStatIdentity(fs.fstatSync(fd))
      && fileStatIdentity(before) === fileStatIdentity(fs.lstatSync(target)), "RUNTIME_INPUT_CHANGED");
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

/** Every selected runtime input is inventoried, including dependencies, binary
 * files, dotfiles and internal links. Only root .git metadata is excluded.
 * Executable bits are semantic; immutable candidate modes need not equal npm's.
 */
function snapshotRuntimeTree(root, { containmentRoot = root, immutable = false } = {}) {
  root = safeDirectory(root);
  containmentRoot = safeDirectory(containmentRoot);
  requireValue(inside(containmentRoot, root), "RUNTIME_TREE_OUTSIDE_ROOT");
  const records = [];
  let bytes = 0;
  const walk = (dir, prefix) => {
    const before = fs.lstatSync(dir);
    requireValue(before.isDirectory() && !before.isSymbolicLink(), "RUNTIME_DIRECTORY_UNSAFE");
    if (immutable) requireValue((before.mode & 0o222) === 0 && (before.mode & 0o077) === 0,
      "RUNTIME_CANDIDATE_MUTABLE");
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      if (!prefix && name === ".git") continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      relative(rel);
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        let resolved;
        try { resolved = fs.realpathSync(target); } catch { throw failure("RUNTIME_LINK_BROKEN", rel); }
        requireValue(inside(containmentRoot, resolved), "RUNTIME_LINK_ESCAPE", rel);
        const link = path.relative(containmentRoot, resolved).split(path.sep).join("/");
        requireValue(link.length > 0, "RUNTIME_LINK_ROOT_ALIAS", rel);
        records.push({ path: rel, kind: "link", target: link });
      } else if (stat.isDirectory()) {
        records.push({ path: rel, kind: "directory" });
        walk(target, rel);
      } else {
        requireValue(stat.isFile(), "RUNTIME_SPECIAL_FILE", rel);
        if (immutable) requireValue(stat.nlink === 1 && (stat.mode & 0o222) === 0
          && (stat.mode & 0o077) === 0, "RUNTIME_CANDIDATE_MUTABLE", rel);
        requireValue((stat.mode & 0o002) === 0, "RUNTIME_WORLD_WRITABLE_INPUT", rel);
        records.push({ path: rel, kind: "file", executable: !!(stat.mode & 0o111),
          size: stat.size, sha256: hashFile(target) });
        bytes += stat.size;
      }
    }
    const after = fs.lstatSync(dir);
    requireValue(before.dev === after.dev && before.ino === after.ino
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    "RUNTIME_INPUT_CHANGED");
  };
  walk(root, "");
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: sha(jsonBytes(records)), records, bytes,
    files: records.filter(item => item.kind === "file").length,
    links: records.filter(item => item.kind === "link").length };
}
function loadJson(target, privateFile = false) {
  try { return JSON.parse(readStableFile(target, { privateFile, maxBytes: 4 * 1024 * 1024 })); }
  catch (error) { if (error.code) throw error; throw failure("RUNTIME_JSON_INVALID"); }
}
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function defaultInputPins() {
  const target = path.join(__dirname, "managed-plugin-host-runtime-pins.json");
  return fs.existsSync(target) ? loadJson(target) : { version: 1, hosts: {} };
}
function validatePin(value, id) {
  requireValue(plain(value) && value.backendId === id && value.version === 1
    && typeof value.hostVersion === "string" && value.hostVersion.length <= 80
    && [value.inputTreeSha256, value.outputTreeSha256, value.dependencyTreeSha256, value.payloadTreeSha256,
      value.payloadManifestSha256, value.identityFileSha256, value.interpreter?.sha256].every(item => HEX.test(item)),
  "RUNTIME_INPUT_UNPINNED");
  relative(value.identityFile);
  relative(value.dependencyPath);
  relative(value.entryRelative);
  relative(value.payloadRelative);
  relative(value.manifestFile);
  requireValue(Array.isArray(value.licenseFiles) && value.licenseFiles.length > 0
    && value.licenseFiles.every(item => plain(item) && HEX.test(item.sha256)), "RUNTIME_LICENSE_UNPINNED");
  for (const item of value.licenseFiles) relative(item.path);
  requireValue(plain(value.interpreter) && /^(arm64|x64)$/.test(value.interpreter.architecture)
    && /^(darwin|linux|win32)$/.test(value.interpreter.platform)
    && /^\d+\.\d+\.\d+$/.test(value.interpreter.version), "RUNTIME_INTERPRETER_UNPINNED");
  return value;
}
function nodeEngineSupported(version) {
  const parts = version.split(".").map(Number);
  return parts[0] === 24 && parts[1] >= 16 || parts[0] > 26 || parts[0] === 26 && parts[1] >= 1;
}
function checkedInterpreter({ backendId, interpreterPath, pin, architecture, sourceRoot }) {
  requireValue(typeof interpreterPath === "string" && path.isAbsolute(interpreterPath), "RUNTIME_INTERPRETER_REQUIRED");
  const executable = fs.realpathSync(interpreterPath);
  const before = hashFile(executable);
  requireValue(before === pin.interpreter.sha256, "RUNTIME_INTERPRETER_HASH_MISMATCH");
  let actual;
  try {
    const args = backendId === "openclaw" ? ["-p",
      "JSON.stringify({version:process.versions.node,architecture:process.arch,platform:process.platform})"]
      : ["-I", "-B", "-c", "import json,sys,platform,importlib.util; print(json.dumps({'version':platform.python_version(),'architecture':{'aarch64':'arm64','arm64':'arm64','x86_64':'x64','AMD64':'x64'}.get(platform.machine(),platform.machine()),'platform':{'win32':'win32','darwin':'darwin'}.get(sys.platform,sys.platform),'prefix':sys.prefix,'basePrefix':sys.base_prefix,'paths':sys.path,'uvicorn':importlib.util.find_spec('uvicorn') is not None}))"];
    actual = JSON.parse(execFileSync(interpreterPath, args, { encoding: "utf8", timeout: 10000,
      maxBuffer: 16 * 1024, cwd: sourceRoot, env: { ...process.env, NODE_OPTIONS: "",
        PYTHONPATH: "", PYTHONHOME: "", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { throw failure("RUNTIME_INTERPRETER_PROBE_FAILED"); }
  requireValue(hashFile(executable) === before, "RUNTIME_INTERPRETER_CHANGED");
  requireValue(actual.version === pin.interpreter.version && actual.architecture === architecture
    && actual.architecture === pin.interpreter.architecture && actual.platform === pin.interpreter.platform,
  "RUNTIME_INTERPRETER_PLATFORM_MISMATCH");
  if (backendId === "openclaw") requireValue(nodeEngineSupported(actual.version), "RUNTIME_NODE_ENGINE_UNSUPPORTED");
  else requireValue(/^3\.(11|12|13)\./.test(actual.version) && actual.uvicorn,
    "RUNTIME_HERMES_DEPENDENCY_UNAVAILABLE");
  return { path: interpreterPath, realPath: executable, sha256: before, ...actual };
}
function verifyPatch(sourceRoot, payloadRoot, pin) {
  requireValue(snapshotRuntimeTree(payloadRoot).sha256 === pin.payloadTreeSha256, "RUNTIME_PAYLOAD_TREE_MISMATCH");
  const manifestPath = path.join(payloadRoot, pin.manifestFile);
  requireValue(hashFile(manifestPath) === pin.payloadManifestSha256, "RUNTIME_PAYLOAD_MANIFEST_MISMATCH");
  const manifest = loadJson(manifestPath);
  requireValue(manifest.version === 1, "RUNTIME_PATCH_VERSION_MISMATCH");
  const openclaw = pin.backendId === "openclaw";
  requireValue(openclaw ? manifest.package === "openclaw" && manifest.packageVersion === pin.hostVersion
    : manifest.host === "hermes" && manifest.sourceCommit === pin.hostVersion, "RUNTIME_PATCH_VERSION_MISMATCH");
  requireValue(hashFile(path.join(sourceRoot, pin.identityFile)) === pin.identityFileSha256,
    "RUNTIME_SOURCE_IDENTITY_MISMATCH");
  if (openclaw) {
    const pkg = loadJson(path.join(sourceRoot, pin.identityFile));
    requireValue(pkg.name === "openclaw" && pkg.version === pin.hostVersion
      && pkg.engines?.node === ">=24.16.0 <25 || >=26.1.0", "RUNTIME_SOURCE_IDENTITY_MISMATCH");
  }
  for (const notice of pin.licenseFiles) {
    requireValue(hashFile(path.join(sourceRoot, notice.path)) === notice.sha256
      && hashFile(path.join(payloadRoot, notice.path)) === notice.sha256, "RUNTIME_LICENSE_MISMATCH");
  }
  const changes = [];
  const changed = new Set();
  const add = (rel, bytes, expected) => {
    relative(rel);
    requireValue(!changed.has(rel) && HEX.test(expected) && sha(bytes) === expected,
      "RUNTIME_PATCH_OUTPUT_MISMATCH");
    changed.add(rel); changes.push({ path: rel, bytes });
  };
  requireValue(Array.isArray(manifest.files) && manifest.files.length > 0, "RUNTIME_PATCH_INVALID");
  for (const item of manifest.files) {
    relative(item.path);
    const input = path.join(sourceRoot, item.path);
    if (openclaw) {
      const original = readStableFile(input);
      requireValue(sha(original) === item.beforeSha256, "RUNTIME_PATCH_SOURCE_MISMATCH");
      let output = original.toString("utf8");
      for (const edit of item.edits || []) {
        requireValue(typeof edit.before === "string" && edit.before.length > 0 && typeof edit.after === "string",
          "RUNTIME_PATCH_INVALID");
        const index = output.indexOf(edit.before);
        requireValue(index >= 0 && output.indexOf(edit.before, index + 1) < 0, "RUNTIME_PATCH_ANCHOR_MISMATCH");
        output = output.slice(0, index) + edit.after + output.slice(index + edit.before.length);
      }
      add(item.path, Buffer.from(output), item.afterSha256);
    } else {
      requireValue(item.originalSha256 === null ? !fs.existsSync(input)
        : hashFile(input) === item.originalSha256, "RUNTIME_PATCH_SOURCE_MISMATCH");
      add(item.path, readStableFile(path.join(payloadRoot, "patched", item.path)), item.patchedSha256);
    }
  }
  for (const item of manifest.dependencies || []) {
    relative(item.path);
    requireValue(hashFile(path.join(sourceRoot, item.path)) === item.sha256, "RUNTIME_PATCH_DEPENDENCY_MISMATCH");
  }
  for (const item of manifest.newFiles || []) {
    relative(item.path); relative(item.source);
    requireValue(!fs.existsSync(path.join(sourceRoot, item.path)), "RUNTIME_SOURCE_ALREADY_PATCHED");
    add(item.path, readStableFile(path.join(payloadRoot, item.source)), item.sha256);
  }
  return changes;
}
function patchedTreeDigest(input, changes) {
  const records = new Map(input.records.map(item => [item.path, { ...item }]));
  for (const change of changes) {
    const original = records.get(change.path);
    requireValue(!original || original.kind === "file", "RUNTIME_PATCH_PATH_UNSAFE");
    const parents = change.path.split("/"); parents.pop();
    for (let n = 1; n <= parents.length; n++) {
      const dir = parents.slice(0, n).join("/");
      requireValue(!records.has(dir) || records.get(dir).kind === "directory", "RUNTIME_PATCH_PATH_UNSAFE");
      if (!records.has(dir)) records.set(dir, { path: dir, kind: "directory" });
    }
    records.set(change.path, { path: change.path, kind: "file", executable: original?.executable || false,
      size: change.bytes.length, sha256: sha(change.bytes) });
  }
  return sha(jsonBytes([...records.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
function inspectInput(args, pin, resourcesRoot) {
  const id = backend(args.backendId);
  const sourceRoot = safeDirectory(args.sourceRoot);
  const architecture = args.architecture || process.arch;
  requireValue(/^(arm64|x64)$/.test(architecture), "RUNTIME_ARCHITECTURE_UNSUPPORTED");
  const payloadRoot = safeDirectory(path.join(resourcesRoot, pin.payloadRelative));
  requireValue(inside(resourcesRoot, payloadRoot), "RUNTIME_PAYLOAD_PATH_ESCAPE");
  const changes = verifyPatch(sourceRoot, payloadRoot, pin);
  const interpreter = checkedInterpreter({ backendId: id, interpreterPath: args.interpreterPath,
    pin, architecture, sourceRoot });
  const input = snapshotRuntimeTree(sourceRoot);
  requireValue(input.sha256 === pin.inputTreeSha256, "RUNTIME_INPUT_TREE_MISMATCH");
  requireValue(patchedTreeDigest(input, changes) === pin.outputTreeSha256, "RUNTIME_FIXED_OUTPUT_TREE_MISMATCH");
  const dependency = snapshotRuntimeTree(path.join(sourceRoot, pin.dependencyPath), { containmentRoot: sourceRoot });
  requireValue(dependency.sha256 === pin.dependencyTreeSha256, "RUNTIME_DEPENDENCY_TREE_MISMATCH");
  if (id === "hermes") requireValue(fs.existsSync(path.join(sourceRoot, "venv", "pyvenv.cfg"))
    && fs.existsSync(path.join(sourceRoot, "hermes_cli", "web_dist", "index.html")),
  "RUNTIME_HERMES_DEPENDENCY_UNAVAILABLE");
  return { backendId: id, sourceRoot, payloadRoot, architecture, interpreter, input, dependency, changes };
}

function privateDir(target) {
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(target);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (!process.getuid || stat.uid === process.getuid()), "RUNTIME_PRIVATE_DIRECTORY_UNSAFE");
}
function syncDir(target) { const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicJson(target, value) {
  if (fs.existsSync(target)) readStableFile(target, { privateFile: true, maxBytes: 64 * 1024 });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}-${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let renamed = false;
  try {
    fs.writeFileSync(fd, jsonBytes(value)); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(temp, target); renamed = true; syncDir(path.dirname(target));
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    if (!renamed) { try { fs.unlinkSync(temp); } catch {} }
    else throw failure("RUNTIME_POINTER_COMMIT_UNCERTAIN");
    throw error;
  }
}
function copyVerifiedTree(input, source, target) {
  fs.mkdirSync(target, { mode: 0o700 });
  for (const item of input.records) {
    const dest = path.join(target, item.path);
    if (item.kind === "directory") fs.mkdirSync(dest, { mode: 0o700 });
    else if (item.kind === "link") {
      fs.symlinkSync(path.relative(path.dirname(dest), path.join(target, item.target)), dest);
    } else {
      const bytes = readStableFile(path.join(source, item.path));
      requireValue(bytes.length === item.size && sha(bytes) === item.sha256, "RUNTIME_INPUT_CHANGED");
      const src=path.join(source,item.path);const before=fs.lstatSync(src);
      requireValue(before.isFile()&&!before.isSymbolicLink(),"RUNTIME_INPUT_CHANGED");
      // APFS may clone extents while retaining separate inodes. It is never a
      // hardlink, and changing/sealing this private copy cannot mutate input.
      // COPYFILE_FICLONE falls back to an ordinary copy on unsupported systems.
      fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
      const after=fs.lstatSync(src),copied=fs.lstatSync(dest);
      requireValue(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size
        &&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&copied.isFile()&&!copied.isSymbolicLink()
        &&copied.nlink===1&&!(copied.dev===after.dev&&copied.ino===after.ino)&&copied.size===item.size
        &&hashFile(dest)===item.sha256,"RUNTIME_COPY_MISMATCH");
      fs.chmodSync(dest,item.executable?0o700:0o600);
      const fd=fs.openSync(dest,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
  }
}
function sealTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) sealTree(target);
    else if (stat.isFile()) fs.chmodSync(target, stat.mode & 0o111 ? 0o500 : 0o400);
  }
  syncDir(root); fs.chmodSync(root, 0o500);
}
function removeOwnedStaging(root) {
  // Only a fresh directory made in this invocation reaches this function.
  const loosen = dir => { fs.chmodSync(dir, 0o700); for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) loosen(path.join(dir, entry.name));
  } };
  loosen(root); fs.rmSync(root, { recursive: true, force: true });
}
function identity(value) {
  return plain(value) && Number.isSafeInteger(value.pid) && value.pid > 1
    && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && value.startIdentity.length <= 256
    && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce);
}
function sameIdentity(a, b) { return identity(a) && identity(b)
  && ["pid", "startIdentity", "nonce"].every(key => a[key] === b[key]); }

/** Trusted composition-root API. The opaque handle cannot be serialized,
 * recreated by IPC, or reused by another manager. Callbacks must implement real
 * supervisor effects; synthetic tests explicitly do not certify a supervisor.
 */
function createManagedHostRuntimeAuthority(controller) {
  requireValue(plain(controller) && CONTROLLER_METHODS.every(name => typeof controller[name] === "function"),
    "RUNTIME_SUPERVISOR_UNAVAILABLE");
  const handle = Object.freeze(Object.create(null));
  AUTHORITIES.set(handle, { manager: null,
    controller: Object.freeze(Object.fromEntries(CONTROLLER_METHODS.map(name => [name, controller[name].bind(controller)]))) });
  return handle;
}
function createManagedPluginHostRuntimeManager(options = {}) {
  requireValue(typeof options.stateDir === "string" && path.isAbsolute(options.stateDir), "RUNTIME_STATE_REQUIRED");
  requireValue(typeof options.resourcesRoot === "string" && path.isAbsolute(options.resourcesRoot), "RUNTIME_RESOURCES_REQUIRED");
  const stateDir = path.resolve(options.stateDir);
  const resourcesRoot = safeDirectory(options.resourcesRoot);
  const stageTimeoutMs = options.stageTimeoutMs ?? 15000;
  requireValue(Number.isSafeInteger(stageTimeoutMs) && stageTimeoutMs >= 25 && stageTimeoutMs <= 60000,
    "RUNTIME_STAGE_TIMEOUT_INVALID");
  const pins = freeze(JSON.parse(JSON.stringify(options.inputPins || defaultInputPins())));
  requireValue(pins.version === 1 && plain(pins.hosts), "RUNTIME_INPUT_UNPINNED");
  const token = Object.freeze({});
  const verifiedActivations = new Set();
  let authority = null;
  if (options.activationAuthority !== undefined && options.activationAuthority !== null) {
    authority = AUTHORITIES.get(options.activationAuthority);
    requireValue(authority && authority.manager === null, "RUNTIME_ACTIVATION_AUTHORITY_INVALID");
    authority.manager = token;
  }
  const root = path.join(stateDir, "external-plugin-host-runtimes");
  const pinFor = id => validatePin(pins.hosts[backend(id)], id);
  const dirs = id => ({ backendRoot: path.join(root, id), candidates: path.join(root, id, "candidates"),
    candidate: path.join(root, id, "candidate.json"), active: path.join(root, id, "active.json"),
    journal: path.join(root, id, "activation.json") });
  const ensureRoot = id => {
    privateDir(stateDir); requireValue(fs.realpathSync(stateDir) === stateDir, "RUNTIME_STATE_PATH_UNSAFE");
    privateDir(root); privateDir(dirs(id).backendRoot); privateDir(dirs(id).candidates);
  };
  const mutation = async (id, task) => {
    ensureRoot(id);
    const lock = path.join(dirs(id).backendRoot, ".mutation-lock");
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
      if (error.code === "EEXIST") throw failure("RUNTIME_MUTATION_OWNER_UNKNOWN"); throw error;
    }
    const stat = fs.lstatSync(lock);
    try { return await task(); } finally {
      const current = fs.lstatSync(lock);
      requireValue(current.dev === stat.dev && current.ino === stat.ino && current.isDirectory(), "RUNTIME_MUTATION_LOCK_CHANGED");
      fs.rmdirSync(lock); syncDir(dirs(id).backendRoot);
    }
  };
  const readPointer = (id, kind) => {
    const file = dirs(id)[kind];
    if (!fs.existsSync(file)) return null;
    const pointer = loadJson(file, true);
    requireValue(plain(pointer) && pointer.version === 1 && pointer.backendId === id
      && HEX.test(pointer.candidateId) && HEX.test(pointer.descriptorDigest), "RUNTIME_POINTER_INVALID");
    return pointer;
  };
  const candidateById = (id, candidateId) => {
    requireValue(HEX.test(candidateId), "RUNTIME_CANDIDATE_INVALID");
    const pin = pinFor(id);
    const dir = path.join(dirs(id).candidates, candidateId);
    requireValue(safeDirectory(dir) === dir, "RUNTIME_CANDIDATE_PATH_UNSAFE");
    const descriptor = loadJson(path.join(dir, "descriptor.json"), true);
    requireValue(plain(descriptor) && descriptor.version === 1 && descriptor.backendId === id
      && descriptor.candidateId === candidateId && descriptor.policyDigest === sha(jsonBytes(pin))
      && descriptor.inputTreeSha256 === pin.inputTreeSha256 && descriptor.runtimeTreeSha256 === pin.outputTreeSha256
      && descriptor.architecture === pin.interpreter.architecture && descriptor.interpreter?.sha256 === pin.interpreter.sha256,
    "RUNTIME_DESCRIPTOR_INVALID");
    requireValue(sha(jsonBytes({ backendId: id, policyDigest: sha(jsonBytes(pin)),
      runtimeTreeSha256: pin.outputTreeSha256, interpreterSha256: pin.interpreter.sha256,
      architecture: pin.interpreter.architecture })) === candidateId, "RUNTIME_CANDIDATE_ID_MISMATCH");
    const runtimeRoot = path.join(dir, "runtime");
    requireValue(snapshotRuntimeTree(runtimeRoot, { immutable: true }).sha256 === descriptor.runtimeTreeSha256,
      "RUNTIME_CANDIDATE_TREE_MISMATCH");
    if (id === "hermes") relative(descriptor.interpreterRelative);
    const interpreterPath = id === "hermes" ? path.join(runtimeRoot, descriptor.interpreterRelative)
      : descriptor.interpreter.path;
    const interpreter = checkedInterpreter({ backendId: id, interpreterPath, pin,
      architecture: descriptor.architecture, sourceRoot: runtimeRoot });
    if (id === "hermes") assertHermesOwnedDependencies(runtimeRoot, interpreter);
    return freeze({ ...descriptor, runtimeRoot, descriptorDigest: sha(jsonBytes(descriptor)),
      launch: { executable: interpreterPath, args: id === "openclaw" ? [path.join(runtimeRoot, pin.entryRelative)]
        : ["-B", "-m", "hermes_cli.main"], cwd: runtimeRoot,
      env: id === "hermes" ? { PYTHONPATH: runtimeRoot, PYTHONHOME: "", PYTHONDONTWRITEBYTECODE: "1",
        HERMES_WEB_DIST: path.join(runtimeRoot, "hermes_cli", "web_dist") } : { NODE_OPTIONS: "" } } });
  };
  function assertHermesOwnedDependencies(runtimeRoot, interpreter) {
    requireValue(inside(runtimeRoot, interpreter.realPath) && inside(runtimeRoot, fs.realpathSync(interpreter.prefix))
      && inside(runtimeRoot, fs.realpathSync(interpreter.basePrefix))
      && interpreter.paths.filter(Boolean).every(item => inside(runtimeRoot, path.resolve(item))),
    "RUNTIME_HERMES_DEPENDENCIES_NOT_SELF_CONTAINED");
    requireValue(fs.existsSync(path.join(runtimeRoot, "venv", "pyvenv.cfg"))
      && fs.existsSync(path.join(runtimeRoot, "hermes_cli", "web_dist", "index.html")),
    "RUNTIME_HERMES_DEPENDENCY_UNAVAILABLE");
  }
  const current = (id, kind) => {
    backend(id);
    let journal = null;
    if (kind === "active" && fs.existsSync(dirs(id).journal)) {
      journal = loadJson(dirs(id).journal, true);
      requireValue(["activated", "rejected"].includes(journal.phase), "RUNTIME_ACTIVATION_NEEDS_VERIFICATION");
    }
    const pointer = readPointer(id, kind);
    if (!pointer) return null;
    const candidate = candidateById(id, pointer.candidateId);
    requireValue(candidate.descriptorDigest === pointer.descriptorDigest, "RUNTIME_POINTER_DESCRIPTOR_MISMATCH");
    if (kind !== "active") return candidate;
    requireValue(identity(pointer.writer) && typeof pointer.operationId === "string"
      && typeof pointer.dataRoot === "string" && typeof pointer.adapterGeneration === "string",
    "RUNTIME_ACTIVE_RECORD_INVALID");
    return freeze({ ...candidate, activationStatus: verifiedActivations.has(`${id}:${pointer.operationId}`)
      ? "verified-in-current-process" : "needs_verification",
    activation: { operationId: pointer.operationId, identity: pointer.writer, dataRoot: pointer.dataRoot,
      adapterGeneration: pointer.adapterGeneration } });
  };
  async function inspectSource(args) {
    requireValue(plain(args), "RUNTIME_REQUEST_INVALID");
    const result = inspectInput(args, pinFor(args.backendId), resourcesRoot);
    return freeze({ backendId: result.backendId, hostVersion: pinFor(args.backendId).hostVersion,
      inputTreeSha256: result.input.sha256, dependencyTreeSha256: result.dependency.sha256,
      files: result.input.files, links: result.input.links, bytes: result.input.bytes,
      interpreter: result.interpreter, dependencyMode: result.backendId === "hermes"
        ? inside(result.sourceRoot, result.interpreter.realPath) && inside(result.sourceRoot, result.interpreter.prefix)
          && inside(result.sourceRoot, result.interpreter.basePrefix) ? "source-local-verified" : "external-verified-not-self-contained"
        : "verified-external-node",
      activationAvailable: !!authority, sourceVerified: true, candidateColdStartVerified: false });
  }
  async function prepareCandidate(args) {
    requireValue(plain(args), "RUNTIME_REQUEST_INVALID");
    const id = backend(args.backendId);
    const pin = pinFor(id);
    // All read checks precede state creation/copy. An unsupported update leaves
    // the existing active and candidate pointers exactly as they were.
    const result = inspectInput(args, pin, resourcesRoot);
    requireValue(!inside(result.sourceRoot, stateDir) && !inside(stateDir, result.sourceRoot), "RUNTIME_SOURCE_STATE_OVERLAP");
    return mutation(id, async () => {
      const available = fs.statfsSync(root);
      requireValue(Number(available.bavail) * Number(available.bsize) >= result.input.bytes + 64 * 1024 * 1024,
        "RUNTIME_INSUFFICIENT_SPACE");
      const stage = path.join(dirs(id).candidates, `.staging-${crypto.randomUUID()}`);
      fs.mkdirSync(stage, { mode: 0o700 });
      let published = false;
      try {
        const runtime = path.join(stage, "runtime");
        copyVerifiedTree(result.input, result.sourceRoot, runtime);
        requireValue(snapshotRuntimeTree(runtime).sha256 === result.input.sha256, "RUNTIME_COPY_MISMATCH");
        for (const change of result.changes) {
          const dest = path.join(runtime, change.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          if (fs.existsSync(dest)) requireValue(fs.lstatSync(dest).isFile() && !fs.lstatSync(dest).isSymbolicLink(), "RUNTIME_PATCH_PATH_UNSAFE");
          const fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
            | (fs.constants.O_NOFOLLOW || 0), 0o600);
          try { fs.writeFileSync(fd, change.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        requireValue(snapshotRuntimeTree(result.sourceRoot).sha256 === result.input.sha256,
          "RUNTIME_SOURCE_CHANGED_DURING_COPY");
        requireValue(snapshotRuntimeTree(result.payloadRoot).sha256 === pin.payloadTreeSha256, "RUNTIME_PAYLOAD_CHANGED_DURING_COPY");
        let interpreterRelative = null;
        if (id === "hermes") {
          requireValue(inside(result.sourceRoot, path.resolve(args.interpreterPath)), "RUNTIME_HERMES_EXTERNAL_VENV");
          interpreterRelative = path.relative(result.sourceRoot, path.resolve(args.interpreterPath)).split(path.sep).join("/");
          relative(interpreterRelative);
          const probe = checkedInterpreter({ backendId: id, interpreterPath: path.join(runtime, interpreterRelative),
            pin, architecture: result.architecture, sourceRoot: runtime });
          assertHermesOwnedDependencies(runtime, probe);
        }
        const runtimeTreeSha256 = snapshotRuntimeTree(runtime).sha256;
        requireValue(runtimeTreeSha256 === pin.outputTreeSha256, "RUNTIME_FIXED_OUTPUT_TREE_MISMATCH");
        const candidateId = sha(jsonBytes({ backendId: id, policyDigest: sha(jsonBytes(pin)),
          runtimeTreeSha256, interpreterSha256: result.interpreter.sha256, architecture: result.architecture }));
        const descriptor = { version: 1, backendId: id, candidateId, hostVersion: pin.hostVersion,
          policyDigest: sha(jsonBytes(pin)), inputTreeSha256: result.input.sha256,
          dependencyTreeSha256: result.dependency.sha256, payloadTreeSha256: pin.payloadTreeSha256,
          runtimeTreeSha256, architecture: result.architecture, interpreter: result.interpreter,
          interpreterRelative, dependencyMode: id === "hermes" ? "candidate-owned" : "verified-external-node",
          candidateColdStartVerified: false };
        atomicJson(path.join(stage, "descriptor.json"), descriptor);
        sealTree(runtime); fs.chmodSync(path.join(stage, "descriptor.json"), 0o400); syncDir(stage); fs.chmodSync(stage, 0o500);
        const target = path.join(dirs(id).candidates, candidateId);
        if (fs.existsSync(target)) {
          const existing = candidateById(id, candidateId);
          requireValue(existing.descriptorDigest === sha(jsonBytes(descriptor)), "RUNTIME_EXISTING_CANDIDATE_MISMATCH");
          removeOwnedStaging(stage);
        } else { fs.renameSync(stage, target); syncDir(dirs(id).candidates); }
        published = true;
        atomicJson(dirs(id).candidate, { version: 1, backendId: id, candidateId,
          descriptorDigest: sha(jsonBytes(descriptor)) });
        return candidateById(id, candidateId);
      } finally { if (!published && fs.existsSync(stage)) removeOwnedStaging(stage); }
    });
  }
  async function activateCandidate({ backendId: id, candidateId, operationId } = {}) {
    backend(id);
    requireValue(authority && authority.manager === token, "RUNTIME_SUPERVISOR_UNAVAILABLE");
    requireValue(typeof operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId), "RUNTIME_OPERATION_INVALID");
    return mutation(id, async () => {
      const candidate = candidateById(id, candidateId);
      const selected = readPointer(id, "candidate");
      requireValue(selected && selected.candidateId === candidateId && selected.descriptorDigest === candidate.descriptorDigest,
        "RUNTIME_CANDIDATE_NOT_CURRENT");
      if (fs.existsSync(dirs(id).journal)) requireValue(["activated", "rejected"].includes(loadJson(dirs(id).journal, true).phase),
        "RUNTIME_ACTIVATION_NEEDS_VERIFICATION");
      const control = authority.controller;
      const abort = new AbortController();
      const inFlight = new Set();
      let closed = false; let timedOut = false; let dataRoot = null;
      const assertCurrent = () => requireValue(!closed && !abort.signal.aborted, "RUNTIME_ACTIVATION_RETIRED");
      let context = Object.freeze({ backendId: id, operationId, candidate,
        nonce: crypto.randomBytes(32).toString("hex"), signal: abort.signal, assertCurrent });
      let drain; let fence; let sideEffects = false; let spawned = null; let completed = false;
      let journal = { version: 1, backendId: id, operationId, candidateId, dataRoot: null,
        previousActive: readPointer(id, "active"), phase: "inspecting_owner" };
      atomicJson(dirs(id).journal, journal);
      const phase = value => { journal = { ...journal, phase: value }; atomicJson(dirs(id).journal, journal); };
      const invoke = async (stage, callback, args, cleanup = false) => {
        if (!cleanup) assertCurrent();
        // The actual Host must reject a buffered mutation after this stage's
        // deadline; canceling the local wait alone cannot retract network I/O.
        const stageArgs = Object.freeze({ ...args, deadlineAt: Date.now() + stageTimeoutMs });
        const pending = Promise.resolve().then(() => { if (!cleanup) assertCurrent(); return callback(stageArgs); });
        if (!cleanup) {
          inFlight.add(pending);
          pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
        }
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = failure("RUNTIME_SUPERVISOR_TIMEOUT", stage); error.stage = stage;
            if (!cleanup) {
              timedOut = true; abort.abort(error);
              // Mark uncertainty immediately, before attempting cooperative abort.
              try { phase("needs_verification"); } catch {}
            }
            reject(error);
          }, stageTimeoutMs);
        });
        try { const result = await Promise.race([pending, deadline]); if (!cleanup) assertCurrent(); return result; }
        finally { clearTimeout(timer); }
      };
      const bound = proof => plain(proof) && proof.backendId === id && proof.operationId === operationId && proof.dataRoot === dataRoot;
      const assertDrain = async () => {
        requireValue(drain && typeof drain.assertValid === "function" && typeof drain.release === "function", "RUNTIME_DRAIN_INVALID");
        const proof = await invoke("drain.assertValid", drain.assertValid.bind(drain), context);
        requireValue(bound(proof) && typeof proof.leaseNonce === "string" && HEX.test(proof.leaseNonce)
          && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > Date.now(), "RUNTIME_DRAIN_INVALID");
      };
      const assertFence = async () => {
        requireValue(fence && typeof fence.assertValid === "function" && typeof fence.release === "function", "RUNTIME_FENCE_INVALID");
        const proof = await invoke("fence.assertValid", fence.assertValid.bind(fence), context);
        requireValue(bound(proof) && proof.exclusive === true && proof.fenceNonce === context.nonce,
          "RUNTIME_FENCE_INVALID");
      };
      const healthMatches = proof => bound(proof) && sameIdentity(proof.identity, spawned)
        && proof.runtimeTreeSha256 === candidate.runtimeTreeSha256 && proof.selectionSupported === true
        && typeof proof.adapterGeneration === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proof.adapterGeneration);
      try {
        let writer = await invoke("inspectWriter", control.inspectWriter, context);
        requireValue(plain(writer) && typeof writer.dataRoot === "string", "RUNTIME_WRITER_OWNER_UNKNOWN");
        dataRoot = safeDirectory(writer.dataRoot);
        requireValue(writer.backendId === id && writer.dataRoot === dataRoot
          && (writer.ownership === "absent" && writer.identity === null
            || writer.ownership === "managed" && identity(writer.identity)), "RUNTIME_WRITER_OWNER_UNKNOWN");
        context = Object.freeze({ ...context, dataRoot, previousWriter: writer.identity });
        journal = { ...journal, dataRoot }; phase("prepared");
        drain = await invoke("acquireDrain", control.acquireDrain, context); await assertDrain();
        const idle = await invoke("assertIdle", control.assertIdle, { ...context, drain });
        requireValue(bound(idle) && idle.complete === true && idle.running === 0 && idle.queued === 0, "RUNTIME_HOST_NOT_IDLE");
        phase("drained");
        await assertDrain();
        writer = await invoke("inspectWriter.beforeStop", control.inspectWriter, context);
        requireValue(writer.dataRoot === dataRoot && writer.backendId === id
          && (context.previousWriter ? writer.ownership === "managed" && sameIdentity(writer.identity, context.previousWriter)
            : writer.ownership === "absent" && writer.identity === null), "RUNTIME_WRITER_CHANGED");
        if (context.previousWriter) { sideEffects = true; phase("stopping"); await invoke("stopWriter", control.stopWriter, context); }
        const stopped = await invoke("inspectWriter.afterStop", control.inspectWriter, context);
        requireValue(stopped.backendId === id && stopped.dataRoot === dataRoot && stopped.ownership === "absent"
          && stopped.identity === null, "RUNTIME_PREVIOUS_WRITER_NOT_EXITED");
        fence = await invoke("claimExclusiveDataFence", control.claimExclusiveDataFence, context); await assertFence(); await assertDrain();
        // Recheck immutable code/interpreter immediately before the only start.
        candidateById(id, candidateId);
        sideEffects = true; phase("starting_paused");
        spawned = await invoke("startPaused", control.startPaused, { ...context, drain, fence });
        requireValue(identity(spawned) && spawned.nonce === context.nonce
          && (!context.previousWriter || !sameIdentity(spawned, context.previousWriter)), "RUNTIME_NEW_WRITER_IDENTITY_INVALID");
        await assertFence(); await assertDrain();
        const health = await invoke("waitHealthy", control.waitHealthy, { ...context, identity: spawned, drain, fence });
        requireValue(healthMatches(health) && health.paused === true, "RUNTIME_HEALTH_INVALID");
        const currentWriter = await invoke("inspectWriter.afterHealth", control.inspectWriter, context);
        requireValue(currentWriter.backendId === id && currentWriter.dataRoot === dataRoot
          && currentWriter.ownership === "managed" && sameIdentity(currentWriter.identity, spawned), "RUNTIME_NEW_WRITER_IDENTITY_INVALID");
        phase("healthy_paused"); await assertFence(); await assertDrain();
        const resumed = await invoke("resume", control.resume, { ...context, identity: spawned, drain, fence, health });
        requireValue(healthMatches(resumed) && resumed.paused === false
          && resumed.adapterGeneration === health.adapterGeneration, "RUNTIME_RESUME_INVALID");
        await assertFence();
        const active = { version: 1, backendId: id, candidateId, descriptorDigest: candidate.descriptorDigest,
          operationId, writer: spawned, dataRoot, adapterGeneration: resumed.adapterGeneration };
        atomicJson(dirs(id).active, active); phase("activated");
        verifiedActivations.add(`${id}:${operationId}`);
        completed = true;
        return freeze({ candidate, active, healthVerified: true });
      } catch (error) {
        abort.abort(error);
        if (timedOut) {
          let canceled = false;
          try {
            const proof = await invoke("abortAndWait", control.abortAndWait,
              { ...context, identity: spawned, drain, fence }, true);
            await Promise.resolve();
            canceled = bound(proof) && proof.complete === true && inFlight.size === 0;
          } catch {}
          // A supervisor that cannot retire its outstanding work is unknown,
          // never reported as canceled. No further start/resume step is invoked.
          error.cancellationConfirmed = canceled;
          journal = { ...journal, cancellationConfirmed: canceled };
        }
        if (sideEffects) { try { await invoke("failClosed", control.failClosed,
          { ...context, identity: spawned, drain, fence }, true); } catch {} }
        try { phase(sideEffects || timedOut ? "needs_verification" : "rejected"); } catch {}
        throw error;
      } finally {
        closed = true;
        // The controller owns transfer of the data fence to its writer. Release
        // must not unlock a living writer's lifetime fence after successful handoff.
        let releaseUnknown = false;
        try { if (fence) await invoke("fence.release", fence.release.bind(fence), context, true); } catch { releaseUnknown = true; }
        try { if (drain) await invoke("drain.release", drain.release.bind(drain), context, true); } catch { releaseUnknown = true; }
        if (releaseUnknown) {
          verifiedActivations.delete(`${id}:${operationId}`);
          try { phase("needs_verification"); } catch {}
          if (completed) throw failure("RUNTIME_SUPERVISOR_RELEASE_UNKNOWN");
        }
      }
    });
  }
  return Object.freeze({ inspectSource, prepareCandidate, activateCandidate,
    getCandidate: id => current(id, "candidate"), getActive: id => current(id, "active") });
}
module.exports = { createManagedPluginHostRuntimeManager, createManagedHostRuntimeAuthority,
  snapshotRuntimeTree, hashFile, nodeEngineSupported, patchedTreeDigest };
