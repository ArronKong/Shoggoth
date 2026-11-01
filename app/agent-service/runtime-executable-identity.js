"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serviceError } = require("./security");

const MAX_FILES = 512;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const fail = () => serviceError("RUNTIME_IDENTITY_UNAVAILABLE", "Runtime executable identity is unavailable");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function fileObservation(file, fileSystem = fs, required = false) {
  try {
    const real = fileSystem.realpathSync(file);
    const stat = fileSystem.statSync(real, { bigint: true });
    if (!stat.isFile()) {
      if (!required && stat.isDirectory()) return Object.freeze({ file, real: null, bytes: 0,
        signature: `directory:${real}:${stat.ino}:${stat.mtimeNs ?? stat.mtimeMs}` });
      throw fail();
    }
    if (stat.size > BigInt(MAX_FILE_BYTES)) throw fail();
    return Object.freeze({ file, real, bytes: Number(stat.size), signature: [real, stat.dev, stat.ino, stat.size,
      stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs, stat.mode].map(String).join("\0") });
  } catch (error) {
    if (!required && ["ENOENT", "ENOTDIR"].includes(error?.code)) return Object.freeze({ file, real: null, bytes: 0, signature: "missing" });
    throw fail();
  }
}

// No processes, Runtime homes or credentials are touched by this read. It is
// also suitable for invalidating a settings proof after a same-path upgrade.
function executableFileStamp(file, fileSystem = fs) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw fail();
  return digest(fileObservation(file, fileSystem, true).signature);
}

function executableInterpreter(file, searchPath, fileSystem = fs) {
  const descriptor = fileSystem.openSync(file, "r");
  const header = Buffer.alloc(256);
  let line;
  try { const length = fileSystem.readSync(descriptor, header, 0, header.length, 0);
    line = header.subarray(0, length).toString("utf8").split(/\r?\n/u, 1)[0]; }
  finally { fileSystem.closeSync(descriptor); }
  if (!line.startsWith("#!")) return null;
  const match = /^#!\s*(\/[^\s]+)(?:\s+(?:-S\s+)?([^\s]+))?/u.exec(line);
  if (!match) throw fail();
  if (path.basename(match[1]) !== "env") return fileSystem.realpathSync(match[1]);
  if (!/^[A-Za-z0-9_.-]+$/u.test(match[2] ?? "")) throw fail();
  for (const directory of String(searchPath).split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, match[2]);
    try { fileSystem.accessSync(candidate, fileSystem.constants.X_OK); return fileSystem.realpathSync(candidate); } catch {}
  }
  throw fail();
}

function manifest(file, fileSystem) {
  try {
    const stat = fileSystem.statSync(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw fail();
    const value = JSON.parse(fileSystem.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    throw fail();
  }
}

function packageRoot(file, fileSystem) {
  let directory = path.dirname(file);
  for (let depth = 0; depth < 7; depth++) {
    if (manifest(path.join(directory, "package.json"), fileSystem)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function packageEntryFiles(root, value) {
  const entries = [value.main, typeof value.bin === "string" ? value.bin : null,
    ...Object.values(value.bin && typeof value.bin === "object" ? value.bin : {})];
  return entries.filter(entry => typeof entry === "string" && entry.length < 1024)
    .map(entry => path.resolve(root, entry)).filter(file => file.startsWith(root + path.sep))
    .flatMap(file => path.extname(file) ? [file] : [file, `${file}.js`, `${file}.cjs`, `${file}.mjs`, path.join(file, "index.js")]);
}

function dependencyRoot(root, name, fileSystem, watched) {
  if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(name)) throw fail();
  let directory = root;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(directory, "node_modules", name);
    const file = path.join(candidate, "package.json"); watched.add(file);
    if (watched.size > MAX_FILES * 2) throw fail();
    if (manifest(file, fileSystem)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

class RuntimeExecutableIdentity {
  constructor({ fileSystem = fs } = {}) {
    this.fs = fileSystem;
    this.topologies = new Map();
    this.hashes = new Map();
    this.pending = new Map();
  }

  observe({ binaryPath, interpreterPath = null, extraPaths = [] }) {
    const primary = fileObservation(binaryPath, this.fs, true);
    const topologyKey = JSON.stringify([binaryPath, interpreterPath, extraPaths]);
    let topology = this.topologies.get(topologyKey);
    if (!topology || topology.primary !== primary.signature || topology.manifests.some(previous =>
      fileObservation(previous.file, this.fs).signature !== previous.signature)) {
      const files = new Set([binaryPath, ...(interpreterPath ? [interpreterPath] : []), ...extraPaths]);
      const manifests = new Set();
      const root = interpreterPath || primary.real.includes(`${path.sep}node_modules${path.sep}`)
        ? packageRoot(primary.real, this.fs) : null;
      if (root) {
        const addPackage = directory => {
          const file = path.join(directory, "package.json"), data = manifest(file, this.fs);
          manifests.add(file); files.add(file);
          if (data) for (const entry of packageEntryFiles(directory, data)) files.add(entry);
          return data;
        };
        const data = addPackage(root);
        if (!data) throw fail();
        for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
          const file = path.join(root, name); manifests.add(file); files.add(file);
        }
        // Track the directly imported package manifests and entry points, and
        // native optional payloads. Do not scan an entire dependency tree on
        // every admission or pretend this covers arbitrary dynamic imports.
        const dependencies = Object.keys({ ...data.dependencies, ...data.optionalDependencies });
        if (dependencies.length > 128) throw fail();
        for (const name of dependencies) {
          const dependency = dependencyRoot(root, name, this.fs, manifests);
          if (dependency) addPackage(dependency);
        }
        let cursor = root;
        for (let depth = 0; depth < 7; depth++) {
          if (path.basename(cursor) === "node_modules") {
            const lock = path.join(cursor, ".package-lock.json"); manifests.add(lock); files.add(lock); break;
          }
          const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
        }
      }
      if (files.size > MAX_FILES) throw fail();
      topology = { primary: primary.signature, files: [...files].sort(),
        manifests: [...manifests].map(file => fileObservation(file, this.fs)),
        coverage: root ? "executable-interpreter-direct-package-entries" : "executable-and-explicit-resources" };
      this.topologies.set(topologyKey, topology);
      while (this.topologies.size > 64) this.topologies.delete(this.topologies.keys().next().value);
    }
    const files = topology.files.map(file => fileObservation(file, this.fs, file === binaryPath || file === interpreterPath || extraPaths.includes(file)));
    if (files.reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL_BYTES) throw fail();
    return Object.freeze({ stamp: digest(JSON.stringify(files.map(file => [file.file, file.signature]))),
      binaryPath: primary.real, interpreted: interpreterPath !== null && interpreterPath !== primary.real,
      coverage: topology.coverage, files: Object.freeze(files) });
  }

  async capture(observation) {
    if (this.hashes.has(observation.stamp)) return this.hashes.get(observation.stamp);
    if (this.pending.has(observation.stamp)) return this.pending.get(observation.stamp);
    if (this.pending.size >= 8) throw fail();
    const work = (async () => {
      const hashes = [];
      for (const file of observation.files) {
        if (file.real === null) { hashes.push([file.file, null]); continue; }
        const hash = crypto.createHash("sha256");
        try {
          for await (const bytes of this.fs.createReadStream(file.real)) hash.update(bytes);
        } catch { throw fail(); }
        if (fileObservation(file.file, this.fs, true).signature !== file.signature) throw fail();
        hashes.push([file.file, hash.digest("hex")]);
      }
      if (observation.files.some(file => fileObservation(file.file, this.fs).signature !== file.signature)) throw fail();
      const value = Object.freeze({ version: 1, stamp: observation.stamp, digest: digest(JSON.stringify(hashes)),
        interpreted: observation.interpreted, coverage: observation.coverage });
      this.hashes.set(observation.stamp, value);
      while (this.hashes.size > 64) this.hashes.delete(this.hashes.keys().next().value);
      return value;
    })().finally(() => { this.pending.delete(observation.stamp); });
    this.pending.set(observation.stamp, work);
    return work;
  }
}

module.exports = { RuntimeExecutableIdentity, executableFileStamp, executableInterpreter };
