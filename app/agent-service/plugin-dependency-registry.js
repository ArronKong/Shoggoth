"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PluginComponentResolver } = require("./plugin-component-resolver");
const { assertPrivateDirectory, assertPrivateRegularFile, ensurePrivateDirectory,
  lstatIfExists, serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_BINARY = 256 * 1024 * 1024;
const MAX_REGISTRY = 2 * 1024 * 1024;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw serviceError(code, "插件依赖尚未固定、已变化或不受支持"); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const same = (a, b) => ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]
  .every(key => a[key] === b[key]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function pinOf(input = {}) {
  const pin = Object.fromEntries(["installationId", "componentId", "releaseDigest", "descriptorDigest"]
    .map(key => [key, input[key]]));
  if (!ID.test(pin.installationId || "") || ![pin.componentId, pin.releaseDigest, pin.descriptorDigest]
    .every(value => typeof value === "string" && HASH.test(value))) fail("DEPENDENCY_INPUT_INVALID");
  return pin;
}
function identity(pin) { return sha(JSON.stringify([pin.installationId, pin.componentId])); }
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function binaryArch(header, size) {
  const expected = process.arch === "arm64" ? 0x100000c : process.arch === "x64" ? 0x1000007 : null;
  if (process.platform === "darwin" && expected !== null && header.length >= 32) {
    if (header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === expected
      && header.readUInt32LE(12) === 2) return process.arch;
    const magic = header.readUInt32BE(0), stride = magic === 0xcafebabf ? 32 : 20;
    if ([0xcafebabe, 0xcafebabf].includes(magic)) {
      const count = header.readUInt32BE(4);
      if (count < 1 || count > 8 || header.length < 8 + count * stride) fail("DEPENDENCY_EXECUTABLE_INVALID");
      for (let index = 0; index < count; index++) {
        const offset = 8 + index * stride;
        const start = stride === 32 ? Number(header.readBigUInt64BE(offset + 8)) : header.readUInt32BE(offset + 8);
        const length = stride === 32 ? Number(header.readBigUInt64BE(offset + 16)) : header.readUInt32BE(offset + 12);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 8 + count * stride
          || length < 32 || start + length > size) fail("DEPENDENCY_EXECUTABLE_INVALID");
        if (header.readUInt32BE(offset) === expected) return process.arch;
      }
    }
  }
  if (process.platform === "linux" && header.length >= 64 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    && header[4] === 2 && header[5] === 1 && [2, 3].includes(header.readUInt16LE(16))
    && header.readUInt16LE(18) === (process.arch === "arm64" ? 183 : process.arch === "x64" ? 62 : -1)) return process.arch;
  fail("DEPENDENCY_EXECUTABLE_INVALID");
}

// Read only. Version probing is deliberately deferred until native confirmation.
function inspectExecutable(executablePath) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)
    || executablePath.length > 4096 || !executablePath.isWellFormed() || executablePath.includes("\0")) {
    fail("DEPENDENCY_EXECUTABLE_INVALID");
  }
  const selectedPath = path.resolve(executablePath);
  let canonicalPath, before, fd;
  try {
    canonicalPath = fs.realpathSync(selectedPath);
    before = fs.lstatSync(canonicalPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 32
      || before.size > MAX_BINARY || (before.uid !== uid && before.uid !== 0)
      || (before.mode & 0o022) !== 0 || (before.mode & 0o6000) !== 0 || (before.mode & 0o111) === 0) {
      fail("DEPENDENCY_EXECUTABLE_INVALID");
    }
    // Root-owned binaries must not be replaceable through a writable parent.
    if (before.uid === 0) {
      let directory = path.dirname(canonicalPath);
      for (;;) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
          fail("DEPENDENCY_EXECUTABLE_INVALID");
        }
        if (directory === path.dirname(directory)) break;
        directory = path.dirname(directory);
      }
    }
    fs.accessSync(canonicalPath, fs.constants.X_OK);
    fd = fs.openSync(canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(before, fs.fstatSync(fd))) fail("DEPENDENCY_CHANGED");
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, header;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - bytes), null);
      if (!count) break;
      if (header === undefined) header = Buffer.from(buffer.subarray(0, Math.min(count, 512)));
      bytes += count;
      if (bytes > before.size) fail("DEPENDENCY_CHANGED");
      hash.update(buffer.subarray(0, count));
    }
    if (bytes !== before.size || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(canonicalPath))
      || fs.realpathSync(selectedPath) !== canonicalPath) fail("DEPENDENCY_CHANGED");
    return { selectedPath, canonicalPath, sha256: hash.digest("hex"), size: bytes,
      platform: process.platform, arch: binaryArch(header, bytes), uid: before.uid, mode: before.mode & 0o777 };
  } catch (error) {
    if (error?.code?.startsWith("DEPENDENCY_")) throw error;
    fail("DEPENDENCY_EXECUTABLE_INVALID");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inspectScript(component, root) {
  const { spec } = component;
  const interpreter = spec.command === "node" ? "node" : ["python", "python3"].includes(spec.command) ? "python" : null;
  if (component.transport !== "stdio" || !interpreter) fail("DEPENDENCY_INTERPRETER_UNSUPPORTED");
  if (spec.cwd !== undefined && !["./", "${PLUGIN_ROOT}", "${PLUGIN_ROOT}/"].includes(spec.cwd)) {
    fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED");
  }
  const args = spec.args || [];
  if (!Array.isArray(args) || !args.length || args.length > 60 || args.some(value => typeof value !== "string"
    || value.length > 4096 || !value.isWellFormed() || value.includes("\0"))) fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED");
  const script = args[0].replace(/^\$\{PLUGIN_ROOT\}\//u, "./");
  if (!script.startsWith("./") || script.includes("\\") || script.includes("${")
    || script.split("/").some((part, index) => !part || (index > 0 && [".", ".."].includes(part)))
    || !(interpreter === "node" ? /\.(?:js|cjs|mjs)$/u : /\.py$/u).test(script)) fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED");
  // Flags may never occupy the interpreter option position. Reject common
  // evaluation/loader forms even as script arguments to keep review unambiguous.
  if (args.slice(1).some(value => /^(?:-[ecm]|--(?:eval|print|require|import|loader|experimental-loader|input-type|inspect))(?:=|$)/u.test(value))) {
    fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED");
  }
  for (const name of Object.keys(spec.env || {})) {
    if (/^(?:NODE_|PYTHON|LD_|DYLD_|NPM_|UV_|VIRTUAL_ENV|CONDA|PATH$|HOME$|SHELL$|ENV$|BASH_ENV$|LOGNAME$|USER$)/iu.test(name)) {
      fail("DEPENDENCY_ENV_UNSUPPORTED");
    }
  }
  let target;
  try {
    target = fs.realpathSync(path.join(root, script));
    const stat = fs.lstatSync(target);
    if (!inside(root, target) || !stat.isFile() || stat.nlink !== 1
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED");
  } catch { fail("DEPENDENCY_ARGUMENTS_UNSUPPORTED"); }
  return { interpreter, script, scriptPath: target, scriptArgs: args.slice(1) };
}

class PluginDependencyRegistry {
  constructor({ store, resolver = new PluginComponentResolver({ store }), runProbe = spawnSync,
    onPhase = null } = {}) {
    if (!store?.paths?.pluginDataDir || typeof resolver.inspectMcpServer !== "function"
      || typeof resolver.inspectMcpDependency !== "function"
      || typeof store.getAuthorityIncarnation !== "function"
      || typeof runProbe !== "function") throw new TypeError("Dependency registry requires PluginStore and resolver");
    Object.assign(this, { store, resolver, runProbe, onPhase });
    this.directory = path.join(store.paths.pluginDataDir, ".prepared-dependencies");
    this.file = path.join(this.directory, "registry.json");
  }
  _read() {
    assertPrivateDirectory(this.store.paths.pluginDataDir);
    if (!lstatIfExists(this.directory)) return { version: 1, entries: {}, operations: {} };
    assertPrivateDirectory(this.directory);
    if (!lstatIfExists(this.file)) return { version: 1, entries: {}, operations: {} };
    const stat = assertPrivateRegularFile(this.file);
    if (stat.size > MAX_REGISTRY) fail("DEPENDENCY_REGISTRY_INVALID");
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let value;
    try {
      if (!same(stat, fs.fstatSync(fd))) fail("DEPENDENCY_REGISTRY_INVALID");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length);
      if (bytes.length !== stat.size || !same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(this.file))) {
        fail("DEPENDENCY_REGISTRY_INVALID");
      }
      value = JSON.parse(bytes);
    } catch { fail("DEPENDENCY_REGISTRY_INVALID"); }
    finally { fs.closeSync(fd); }
    if (!plain(value) || value.version !== 1 || !plain(value.entries) || !plain(value.operations)
      || Object.keys(value.entries).length > 256 || Object.keys(value.operations).length > 1024
      || !HASH.test(value.digest || "")) fail("DEPENDENCY_REGISTRY_INVALID");
    const { digest, ...body } = value;
    if (sha(JSON.stringify(body)) !== digest) fail("DEPENDENCY_REGISTRY_INVALID");
    for (const [key, record] of Object.entries(value.entries)) {
      if (!HASH.test(key) || !plain(record) || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !["ready", "revoked"].includes(record.status) || !["node", "python"].includes(record.interpreter)
        || !HASH.test(record.authorityIncarnation || "")
        || typeof record.version !== "string" || record.version.length > 64 || !plain(record.executable)
        || !HASH.test(record.executable.sha256 || "") || identity(pinOf(record.pin)) !== key) fail("DEPENDENCY_REGISTRY_INVALID");
    }
    for (const [key, record] of Object.entries(value.operations)) {
      if (!ID.test(key) || !plain(record) || !HASH.test(record.fingerprint || "")
        || !HASH.test(record.authorityIncarnation || "")
        || !["probing", "completed", "failed"].includes(record.phase)) fail("DEPENDENCY_REGISTRY_INVALID");
    }
    return body;
  }
  _write(body) {
    assertPrivateDirectory(this.store.paths.pluginDataDir);
    ensurePrivateDirectory(this.directory);
    if (lstatIfExists(this.file)) assertPrivateRegularFile(this.file);
    const bytes = Buffer.from(JSON.stringify({ ...body, digest: sha(JSON.stringify(body)) }));
    if (bytes.length > MAX_REGISTRY) fail("DEPENDENCY_REGISTRY_LIMIT");
    const temporary = path.join(this.directory, `.registry-${crypto.randomUUID()}`);
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, this.file); syncDirectory(this.directory); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  _component(input) {
    const pin = pinOf(input), component = this.resolver.inspectMcpDependency(pin);
    if (this.store.hasPendingInstallationDisable?.(pin.installationId)) fail("PLUGIN_COMPONENT_INACTIVE");
    const root = fs.realpathSync(path.join(this.store.paths.pluginPackagesDir, pin.releaseDigest));
    return { pin, component, root, ...inspectScript(component, root) };
  }
  preview(input) {
    const current = this._component(input), executable = inspectExecutable(input.executablePath);
    const body = this._read(), existing = body.entries[identity(current.pin)];
    const result = { pin: current.pin, interpreter: current.interpreter,
      authorityIncarnation: this.store.getAuthorityIncarnation(),
      executable: { ...executable, version: null }, script: current.script,
      args: current.scriptArgs, expectedRevision: existing?.revision || 0, probeStatus: "not-executed" };
    return { ...result, previewDigest: sha(JSON.stringify(result)) };
  }
  _result(record, operationId = null) {
    return { status: record.status, pin: record.pin, interpreter: record.interpreter,
      authorityIncarnation: record.authorityIncarnation,
      executable: { ...record.executable, version: record.version },
      revision: record.revision, expectedRevision: record.revision,
      ...(operationId ? { operationId } : {}) };
  }
  getOperation(operationId) {
    if (typeof operationId !== "string" || !ID.test(operationId)) fail("DEPENDENCY_INPUT_INVALID");
    const operation = this._read().operations[operationId];
    if (operation && operation.authorityIncarnation !== this.store.getAuthorityIncarnation()) {
      return { operationId, phase: "outcome_unknown", reasonCode: "PLUGIN_RESTORE_RECONCILIATION_REQUIRED" };
    }
    return operation ? { operationId, phase: operation.phase,
      ...(operation.result ? { result: structuredClone(operation.result) } : {}),
      ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}) } : null;
  }
  queryState(input) {
    const current = this._component(input), record = this._read().entries[identity(current.pin)];
    if (!record) return { status: "missing", pin: current.pin, interpreter: current.interpreter, expectedRevision: 0 };
    if (!sameJson(record.pin, current.pin) || record.authorityIncarnation !== this.store.getAuthorityIncarnation()) {
      return { ...this._result(record), pin: current.pin, status: "stale", reasonCode: "DEPENDENCY_CHANGED" };
    }
    if (record.status === "revoked") return this._result(record);
    try {
      if (!sameJson(inspectExecutable(record.executable.selectedPath), record.executable)) fail("DEPENDENCY_CHANGED");
      return this._result(record);
    } catch { return { ...this._result(record), status: "changed", reasonCode: "DEPENDENCY_CHANGED" }; }
  }
  prepare(input) {
    const pin = pinOf(input), key = identity(pin);
    if (input.confirmed !== true || !ID.test(input.operationId || "") || !HASH.test(input.previewDigest || "")
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("DEPENDENCY_CONFIRMATION_REQUIRED");
    const authorityIncarnation = this.store.getAuthorityIncarnation();
    const fingerprint = sha(JSON.stringify({ kind: "prepare", pin, authorityIncarnation, executablePath: input.executablePath,
      previewDigest: input.previewDigest, expectedRevision: input.expectedRevision }));
    let body = this._read(), operation = body.operations[input.operationId];
    if (operation && operation.fingerprint !== fingerprint) fail("REVISION_CONFLICT");
    if (operation?.phase === "completed") return operation.result;
    if (operation?.phase === "failed") fail("DEPENDENCY_OPERATION_FAILED");
    if (this.store.getInstallation(pin.installationId)?.desiredState !== "disabled") fail("DEPENDENCY_REQUIRES_DISABLE");
    const preview = this.preview(input);
    if (preview.expectedRevision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (preview.previewDigest !== input.previewDigest) fail("DEPENDENCY_CHANGED");
    if (!operation && Object.keys(body.operations).length >= 1024) fail("DEPENDENCY_REGISTRY_LIMIT");
    if (!body.entries[key] && Object.keys(body.entries).length >= 256) fail("DEPENDENCY_REGISTRY_LIMIT");
    body.operations[input.operationId] = { fingerprint, authorityIncarnation, phase: "probing" };
    this._write(body);
    this.onPhase?.("dependency-probing");
    let probeRoot;
    try {
      probeRoot = fs.mkdtempSync(path.join(this.directory, ".probe-")); fs.chmodSync(probeRoot, 0o700);
      const options = { cwd: probeRoot, env: { PATH: "", HOME: probeRoot, TMPDIR: probeRoot, LANG: "C", LC_ALL: "C" },
        encoding: "utf8", timeout: 2000, maxBuffer: 1024, windowsHide: true, shell: false };
      const args = preview.interpreter === "node" ? ["--version"] : ["-I", "-S", "--version"];
      const result = this.runProbe(preview.executable.canonicalPath, args, options);
      const version = `${result.stdout || ""}${result.stderr || ""}`.trim();
      const matched = preview.interpreter === "node" ? /^v(\d+)\.\d+\.\d+$/u.exec(version)
        : /^Python (\d+)\.(\d+)\.\d+$/u.exec(version);
      if (result.error || result.status !== 0 || result.signal || !matched
        || (preview.interpreter === "node" ? Number(matched[1]) < 20
          : Number(matched[1]) !== 3 || Number(matched[2]) < 8)) fail("DEPENDENCY_PROBE_FAILED");
      if (this.preview(input).previewDigest !== input.previewDigest) fail("DEPENDENCY_CHANGED");
      if (this.store.getInstallation(pin.installationId)?.desiredState !== "disabled") fail("DEPENDENCY_REQUIRES_DISABLE");
      body = this._read();
      if ((body.entries[key]?.revision || 0) !== input.expectedRevision) fail("REVISION_CONFLICT");
      const { version: _unprobed, ...executable } = preview.executable;
      const record = { pin, authorityIncarnation, interpreter: preview.interpreter, executable, version,
        status: "ready", revision: input.expectedRevision + 1 };
      body.entries[key] = record;
      const receipt = this._result(record, input.operationId);
      body.operations[input.operationId] = { fingerprint, authorityIncarnation, phase: "completed", result: receipt };
      this._write(body);
      this.onPhase?.("dependency-committed");
      return receipt;
    } catch (error) {
      if (error?.code !== "PLUGIN_SIMULATED_CRASH") {
        body = this._read();
        if (body.operations[input.operationId]?.phase !== "completed") {
          body.operations[input.operationId] = { fingerprint, authorityIncarnation, phase: "failed", reasonCode: error?.code || "DEPENDENCY_PROBE_FAILED" };
          this._write(body);
        }
      }
      throw error;
    } finally { if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true }); }
  }
  revoke(input) {
    const pin = pinOf(input), key = identity(pin);
    if (input.confirmed !== true || !ID.test(input.operationId || "") || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1) fail("DEPENDENCY_CONFIRMATION_REQUIRED");
    const authorityIncarnation = this.store.getAuthorityIncarnation();
    const fingerprint = sha(JSON.stringify({ kind: "revoke", pin, authorityIncarnation, expectedRevision: input.expectedRevision }));
    const body = this._read(), operation = body.operations[input.operationId];
    if (operation && operation.fingerprint !== fingerprint) fail("REVISION_CONFLICT");
    if (operation?.phase === "completed") return operation.result;
    this._component(input);
    if (this.store.getInstallation(pin.installationId)?.desiredState !== "disabled") fail("DEPENDENCY_REQUIRES_DISABLE");
    const record = body.entries[key];
    if (!record || record.revision !== input.expectedRevision || !sameJson(record.pin, pin)) fail("REVISION_CONFLICT");
    if (!operation && Object.keys(body.operations).length >= 1024) fail("DEPENDENCY_REGISTRY_LIMIT");
    record.status = "revoked"; record.revision += 1; record.authorityIncarnation = authorityIncarnation;
    const result = this._result(record, input.operationId);
    body.operations[input.operationId] = { fingerprint, authorityIncarnation, phase: "completed", result };
    this._write(body);
    return result;
  }
  resolve(input) {
    this.resolver.inspectMcpServer(pinOf(input));
    if (!this._read().entries[identity(pinOf(input))]) fail("DEPENDENCY_PREPARATION_REQUIRED");
    const current = this._component(input), state = this.queryState(input);
    if (state.status !== "ready") fail(state.status === "missing" ? "DEPENDENCY_PREPARATION_REQUIRED" : "DEPENDENCY_CHANGED");
    const fingerprint = sha(JSON.stringify([state.authorityIncarnation, state.pin, state.revision, state.executable]));
    const flags = current.interpreter === "node" ? ["--no-addons", "--no-global-search-paths", "--"] : ["-I", "-S", "-B", "--"];
    return { command: state.executable.canonicalPath, args: [...flags, current.scriptPath, ...current.scriptArgs],
      cwd: "${PLUGIN_ROOT}", env: { ...current.component.spec.env, PATH: "", HOME: "${PLUGIN_DATA}",
        SHELL: "", LOGNAME: "", USER: "", TERM: "dumb" }, dependencyFingerprint: fingerprint,
      assertDependencyCurrent: () => {
        this.resolver.inspectMcpServer(pinOf(input));
        const latest = this.queryState(input);
        if (latest.status !== "ready" || sha(JSON.stringify([latest.authorityIncarnation,
          latest.pin, latest.revision, latest.executable])) !== fingerprint) {
          fail("DEPENDENCY_CHANGED");
        }
      } };
  }
}

module.exports = { PluginDependencyRegistry, inspectExecutable };
