"use strict";
// Read-only code attestation stays outside the Service event loop. Neither
// cached checks nor first attestation start a Host, read a vault, or copy input.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const { createManagedPluginHostRuntimeManager } = require("../managed-plugin-host-runtime");
const inputPins = require("../managed-openclaw-runtime-pins.json");
const pin = inputPins.hosts.openclaw;
const MAX_NODES = 100000, MAX_CODES = 4;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const { stateDir, resourcesRoot } = workerData;
const runtimeDirectory = path.join(stateDir, "external-plugin-host-runtimes", "openclaw");
const manager = createManagedPluginHostRuntimeManager({ stateDir, resourcesRoot, inputPins });
const records = new Map();
function record(target, { sealed = false, containmentRoot = null } = {}) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (process.getuid && stat.uid !== BigInt(process.getuid())) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  const kind = stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
  if (!kind || ((kind === "file" || kind === "link") && stat.nlink !== 1n)) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  if (sealed && kind !== "link" && ((stat.mode & 0o222n) !== 0n || (stat.mode & 0o077n) !== 0n)) {
    fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  }
  const result = { path: target, kind, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), uid: String(stat.uid) };
  if (kind === "link") {
    if (!containmentRoot) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
    result.link = fs.readlinkSync(target); result.resolved = fs.realpathSync(target);
    if (!inside(containmentRoot, result.resolved) || result.resolved === containmentRoot) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  } else if (fs.realpathSync(target) !== target) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  return result;
}
// These two shared private ancestors also contain mutable Service ledgers and
// the other Runtime's directory. Their identity/permissions must remain exact;
// unrelated file publication is not a change to the sealed OpenClaw code.
function ancestorIdentity(target) {
  const value = record(target);
  if (value.kind !== "directory" || (BigInt(value.mode) & 0o777n) !== 0o700n) fail("EXTERNAL_PROVIDER_RUNTIME_PATH_UNSAFE");
  return { path: value.path, kind: value.kind, dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid };
}
function fingerprint(writer) {
  const hash = crypto.createHash("sha256"); let nodes = 0;
  const append = value => { if (++nodes > MAX_NODES) fail("EXTERNAL_PROVIDER_RUNTIME_CAPACITY"); hash.update(JSON.stringify(value) + "\n"); };
  const visit = (target, root = false) => {
    const value = record(target, { sealed: true, containmentRoot: writer.runtimeRoot }); append(value);
    if (value.kind === "directory") for (const name of fs.readdirSync(target).sort()) {
      // Keep the manager's exact semantic boundary. No dependency is skipped.
      if (root && name === ".git") continue;
      visit(path.join(target, name));
    }
  };
  visit(writer.runtimeRoot, true);
  const candidateDirectory = path.dirname(writer.runtimeRoot);
  for (const target of [stateDir, path.join(stateDir, "external-plugin-host-runtimes")]) append(ancestorIdentity(target));
  for (const target of [runtimeDirectory,
    path.join(runtimeDirectory, "candidates"), candidateDirectory,
    path.join(runtimeDirectory, "active.json"), path.join(runtimeDirectory, "activation.json"),
    path.join(candidateDirectory, "descriptor.json"), writer.interpreterPath]) append(record(target));
  return hash.digest("hex");
}
// macOS reports an interpreter execution/access as a file "change" event.
// Accept that event only when the complete previously attested file record is
// unchanged. Renames, absent filenames, errors and every identity/permission/
// size/mtime/ctime change still retire the stamp; no byte pin or tree check is
// removed, and the recursive Runtime-directory watcher stays fail-closed.
function watchInterpreter(writer, invalidate) {
  const signature = JSON.stringify(record(writer.interpreterPath));
  return fs.watch(writer.interpreterPath, { persistent: false }, (eventType, filename) => {
    try {
      if (eventType !== "change" || filename !== path.basename(writer.interpreterPath)
        || JSON.stringify(record(writer.interpreterPath)) !== signature) invalidate();
    } catch { invalidate(); }
  });
}
function attest(writer) {
  const candidateDirectory = path.dirname(writer.runtimeRoot);
  if (path.dirname(candidateDirectory) !== path.join(runtimeDirectory, "candidates")
    || path.basename(writer.runtimeRoot) !== "runtime" || !/^[a-f0-9]{64}$/u.test(path.basename(candidateDirectory))
    || writer.entryPath !== path.join(writer.runtimeRoot, pin.entryRelative)
    || writer.runtimeTreeSha256 !== pin.outputTreeSha256) fail("EXTERNAL_PROVIDER_RUNTIME_UNBOUND");
  const key = writer.runtimeRoot + "\0" + writer.interpreterPath;
  let cached = records.get(key);
  const before = fingerprint(writer);
  if (cached) {
    if (cached.retired || cached.stamp !== before) fail("EXTERNAL_PROVIDER_RUNTIME_CHANGED");
  } else {
    if (records.size >= MAX_CODES) fail("EXTERNAL_PROVIDER_RUNTIME_CAPACITY");
    const active = manager.getActive("openclaw");
    if (!active || active.runtimeRoot !== writer.runtimeRoot || active.runtimeTreeSha256 !== writer.runtimeTreeSha256
      || active.launch.executable !== writer.interpreterPath || active.launch.args[0] !== writer.entryPath) {
      fail("EXTERNAL_PROVIDER_RUNTIME_UNBOUND");
    }
    const after = fingerprint(writer);
    if (before !== after) fail("EXTERNAL_PROVIDER_RUNTIME_CHANGED");
    cached = { stamp: after, retired: false, watchers: [] }; records.set(key, cached);
    const invalidate = () => {
      if (cached.retired) return; cached.retired = true;
      parentPort.postMessage({ type: "invalidate", key });
    };
    try {
      cached.watchers.push(fs.watch(runtimeDirectory, { recursive: true, persistent: false }, invalidate));
      cached.watchers.push(watchInterpreter(writer, invalidate));
      for (const watcher of cached.watchers) watcher.on("error", invalidate);
      // A change between inventory and watch registration must also retire it.
      if (fingerprint(writer) !== after) { invalidate(); fail("EXTERNAL_PROVIDER_RUNTIME_CHANGED"); }
    } catch (error) {
      invalidate(); for (const watcher of cached.watchers) watcher.close(); throw error;
    }
  }
  return { key, stamp: cached.stamp };
}
parentPort.on("message", request => {
  if (request?.type === "close") {
    for (const cached of records.values()) for (const watcher of cached.watchers) watcher.close();
    records.clear(); parentPort.close(); return;
  }
  if (request?.type !== "attest" || !Number.isSafeInteger(request.id) || request.id <= 0) return;
  try { parentPort.postMessage({ type: "result", id: request.id, ok: true, ...attest(request.writer) }); }
  catch (error) {
    const key = request.writer?.runtimeRoot + "\0" + request.writer?.interpreterPath;
    const cached = records.get(key); if (cached) cached.retired = true;
    parentPort.postMessage({ type: "result", id: request.id, ok: false,
      code: /^EXTERNAL_PROVIDER_[A-Z_]+$/u.test(error?.code || "") ? error.code : "EXTERNAL_PROVIDER_RUNTIME_UNVERIFIED",
      causeCode: /^(?:EXTERNAL_PROVIDER|RUNTIME)_[A-Z_]+$/u.test(error?.code || "") ? error.code : "RUNTIME_IO_UNVERIFIED" });
  }
});
