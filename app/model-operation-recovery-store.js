"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  readPrivateFile,
  recoverInterruptedPrivateFile,
  statIfExists,
} = require("./agent-service/private-file");

const VERSION = 1;
const MAX_OPERATIONS = 512;
const MAX_BYTES = 384 * 1024;
const MARKER = "model_recovery_requested";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RETAINED_STATUSES = new Set([
  "unconfirmed", "in_progress", "partial", "blocked", "needs_secret", "cleanup_pending", "not_found",
]);
const TERMINAL_STATUSES = new Set(["applied", "failed", "compensated"]);
const activeStores = new Map();

function failure(code) {
  const error = new Error("模型操作恢复记录无法核实，请保留原操作并重试读取。");
  error.code = code;
  return error;
}

function closedRecord(value, required, optional = [], code = "model_recovery_invalid") {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw failure(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw failure(code);
  const captured = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw failure(code);
    captured[key] = descriptor.value;
  }
  return captured;
}

function captureIdentity(value) {
  const row = closedRecord(value, ["version", "backendId", "providerKey", "operationId"]);
  if (row.version !== VERSION || typeof row.backendId !== "string" || !ID_RE.test(row.backendId)
    || typeof row.providerKey !== "string" || !PROVIDER_RE.test(row.providerKey)
    || typeof row.operationId !== "string" || !ID_RE.test(row.operationId)) throw failure("model_recovery_invalid");
  return Object.freeze(row);
}

function captureRow(value) {
  const row = closedRecord(value, ["version", "backendId", "providerKey", "operationId", "status"], ["code"]);
  captureIdentity({ version: row.version, backendId: row.backendId, providerKey: row.providerKey, operationId: row.operationId });
  if (!RETAINED_STATUSES.has(row.status) || Object.hasOwn(row, "code") && row.code !== MARKER)
    throw failure("model_recovery_invalid");
  return Object.freeze(row);
}

function captureSnapshot(value) {
  const snapshot = closedRecord(value, ["version", "revision", "operations"], [], "model_recovery_corrupt");
  if (snapshot.version !== VERSION || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !Array.isArray(snapshot.operations) || snapshot.operations.length > MAX_OPERATIONS)
    throw failure("model_recovery_corrupt");
  const ids = new Set();
  const operations = snapshot.operations.map(value => {
    let row;
    try { row = captureRow(value); } catch { throw failure("model_recovery_corrupt"); }
    if (ids.has(row.operationId)) throw failure("model_recovery_corrupt");
    ids.add(row.operationId);
    return row;
  });
  return Object.freeze({ version: VERSION, revision: snapshot.revision, operations: Object.freeze(operations) });
}

function matchesIdentity(row, identity) {
  return row.backendId === identity.backendId && row.providerKey === identity.providerKey
    && row.operationId === identity.operationId;
}

function verifyTerminal(value, identity) {
  const receipt = closedRecord(value,
    ["version", "backendId", "providerKey", "operationId", "status", "stage", "terminal"], ["code"],
    "model_recovery_receipt_unverified");
  if (receipt.version !== VERSION || !matchesIdentity(receipt, identity) || receipt.terminal !== true
    || !TERMINAL_STATUSES.has(receipt.status) || typeof receipt.stage !== "string" || !ID_RE.test(receipt.stage)
    || Object.hasOwn(receipt, "code") && (typeof receipt.code !== "string" || !ID_RE.test(receipt.code)))
    throw failure("model_recovery_receipt_unverified");
  return receipt.status;
}

function directoryStat(stat, exactMode) {
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()
    || typeof process.getuid === "function" && stat.uid !== process.getuid()
    || exactMode !== undefined && (stat.mode & 0o7777) !== exactMode)
    throw failure("model_recovery_unsafe_path");
  return stat;
}

function fileStat(stat, links = 1) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.nlink !== links || (stat.mode & 0o7777) !== 0o600
    || typeof process.getuid === "function" && stat.uid !== process.getuid()
    || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES)
    throw failure("model_recovery_unsafe_path");
  return stat;
}

const sameNode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Main-owned metadata only. This store grants no model/credential authority.
 * The App single-instance lock provides cross-process ownership; this Map also
 * fences accidental overlapping instances inside the same Main process. */
class ModelOperationRecoveryStore {
  #fs;
  #trustedRoot;
  #root;
  #file;
  #observe;
  #observeOwner;
  #trustedIdentity;
  #rootIdentity;
  #fileIdentity = null;
  #bytes = null;
  #snapshot = null;
  #mode = "new";
  #closing = false;
  #tail = Promise.resolve();
  #owner = Object.freeze({});

  constructor({ userDataRoot, coordinator, fs: fileSystem = fs } = {}) {
    if (typeof userDataRoot !== "string" || !path.isAbsolute(userDataRoot)
      || !coordinator || typeof coordinator.observeOperation !== "function") throw failure("model_recovery_invalid");
    this.#fs = fileSystem;
    this.#trustedRoot = path.resolve(userDataRoot);
    this.#root = path.join(this.#trustedRoot, "model-operation-recovery");
    this.#file = path.join(this.#root, "identities.json");
    this.#observe = coordinator.observeOperation;
    this.#observeOwner = coordinator;
  }

  #enqueue(action) {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }

  #requireOpen() {
    if (this.#mode !== "open") throw failure("model_recovery_unavailable");
  }

  #assertAnchors() {
    const trusted = directoryStat(this.#fs.lstatSync(this.#trustedRoot));
    const root = directoryStat(this.#fs.lstatSync(this.#root), 0o700);
    if (!sameNode(trusted, this.#trustedIdentity) || !sameNode(root, this.#rootIdentity))
      throw failure("model_recovery_unsafe_path");
  }

  #fsyncTrustedRoot() {
    const fd = this.#fs.openSync(this.#trustedRoot, this.#fs.constants.O_RDONLY | (this.#fs.constants.O_NOFOLLOW || 0));
    try {
      if (!sameNode(directoryStat(this.#fs.fstatSync(fd)), this.#trustedIdentity)) throw failure("model_recovery_unsafe_path");
      this.#fs.fsyncSync(fd);
    } finally { this.#fs.closeSync(fd); }
    this.#assertAnchors();
  }

  #readTarget(links = 1) {
    this.#assertAnchors();
    const before = fileStat(this.#fs.lstatSync(this.#file), links);
    let bytes;
    if (links === 1) {
      bytes = readPrivateFile(this.#file, { fs: this.#fs, maxBytes: MAX_BYTES });
    } else {
      const fd = this.#fs.openSync(this.#file, this.#fs.constants.O_RDONLY | (this.#fs.constants.O_NOFOLLOW || 0));
      try {
        if (!sameFile(fileStat(this.#fs.fstatSync(fd), links), before)) throw failure("model_recovery_unsafe_path");
        bytes = this.#fs.readFileSync(fd);
      } finally { this.#fs.closeSync(fd); }
    }
    const after = fileStat(this.#fs.lstatSync(this.#file), links);
    this.#assertAnchors();
    if (!sameFile(before, after) || !Buffer.isBuffer(bytes) || bytes.length !== after.size || bytes.length > MAX_BYTES)
      throw failure("model_recovery_unsafe_path");
    return { bytes, identity: after };
  }

  #assertOriginalTarget(links = 1) {
    if (!this.#fileIdentity) {
      if (statIfExists(this.#fs, this.#file)) throw failure("model_recovery_unsafe_path");
      return;
    }
    const current = this.#readTarget(links);
    if (!sameFile(current.identity, this.#fileIdentity) || !current.bytes.equals(this.#bytes))
      throw failure("model_recovery_unsafe_path");
  }

  #verifyDisk() {
    try { this.#assertAnchors(); this.#assertOriginalTarget(); }
    catch { this.#mode = "failed"; throw failure("model_recovery_unavailable"); }
  }

  #guardedFs() {
    const guarded = Object.create(this.#fs);
    for (const method of ["lstatSync", "openSync", "fstatSync", "readFileSync", "writeSync", "fsyncSync", "fchmodSync", "readdirSync", "unlinkSync"]) {
      guarded[method] = (...args) => {
        this.#assertAnchors();
        const result = this.#fs[method](...args);
        this.#assertAnchors();
        return result;
      };
    }
    // Always close an already-owned descriptor even if its directory was replaced.
    guarded.closeSync = fd => {
      const result = this.#fs.closeSync(fd);
      this.#assertAnchors();
      return result;
    };
    guarded.linkSync = (source, destination) => {
      this.#assertAnchors();
      if (source === this.#file) this.#assertOriginalTarget();
      const result = this.#fs.linkSync(source, destination);
      this.#assertAnchors();
      return result;
    };
    guarded.renameSync = (source, destination) => {
      this.#assertAnchors();
      if (source === `${this.#file}.tmp` && destination === this.#file)
        this.#assertOriginalTarget(this.#fileIdentity ? 2 : 1);
      const result = this.#fs.renameSync(source, destination);
      this.#assertAnchors();
      return result;
    };
    return guarded;
  }

  #commit(snapshot) {
    const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
    if (bytes.length > MAX_BYTES) throw failure("model_recovery_capacity");
    this.#assertAnchors();
    this.#assertOriginalTarget();
    try {
      atomicWritePrivateFile(this.#file, bytes, {
        trustedRoot: this.#trustedRoot, fs: this.#guardedFs(), expectedIdentity: this.#fileIdentity,
      });
      const installed = this.#readTarget();
      if (!installed.bytes.equals(bytes)) throw failure("model_recovery_unsafe_path");
      this.#fileIdentity = installed.identity;
      this.#bytes = installed.bytes;
      this.#snapshot = snapshot;
    } catch (error) {
      if (error?.committed || error?.committedUncertain) this.#mode = "failed";
      else {
        try { this.#assertAnchors(); this.#assertOriginalTarget(); }
        catch { this.#mode = "failed"; }
      }
      throw failure(this.#mode === "failed" ? "model_recovery_commit_unknown" : "model_recovery_save_failed");
    }
  }

  #nextSnapshot(operations) {
    if (this.#snapshot.revision === Number.MAX_SAFE_INTEGER) throw failure("model_recovery_capacity");
    return Object.freeze({ version: VERSION, revision: this.#snapshot.revision + 1, operations: Object.freeze(operations) });
  }

  open() {
    if (this.#closing || this.#mode !== "new") return Promise.reject(failure("model_recovery_unavailable"));
    this.#mode = "opening";
    return this.#enqueue(() => {
      try {
        if (activeStores.has(this.#root)) throw failure("model_recovery_already_open");
        activeStores.set(this.#root, this.#owner);
        this.#trustedIdentity = directoryStat(this.#fs.lstatSync(this.#trustedRoot));
        let root = statIfExists(this.#fs, this.#root);
        const created = !root;
        if (created) { this.#fs.mkdirSync(this.#root, { mode: 0o700 }); root = this.#fs.lstatSync(this.#root); }
        this.#rootIdentity = directoryStat(root, 0o700);
        this.#assertAnchors();
        if (created) this.#fsyncTrustedRoot();
        // Refuse wide/special modes before the shared helper can tighten a path.
        const names = this.#fs.readdirSync(this.#root);
        for (const name of names) {
          if (name !== "identities.json" && name !== "identities.json.tmp" && !name.startsWith("identities.json.backup-"))
            throw failure("model_recovery_unsafe_path");
          const stat = this.#fs.lstatSync(path.join(this.#root, name));
          if (!stat?.isFile?.() || stat.isSymbolicLink?.() || (stat.mode & 0o7777) !== 0o600
            || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw failure("model_recovery_unsafe_path");
        }
        const recovery = recoverInterruptedPrivateFile(this.#file, { fs: this.#guardedFs(), trustedRoot: this.#trustedRoot });
        if (recovery === "uncertain") throw failure("model_recovery_commit_unknown");
        this.#assertAnchors();
        const existing = statIfExists(this.#fs, this.#file);
        if (existing) {
          const current = this.#readTarget();
          let parsed;
          try { parsed = JSON.parse(current.bytes.toString("utf8")); }
          catch { throw failure("model_recovery_corrupt"); }
          this.#snapshot = captureSnapshot(parsed);
          // Files are produced only by this writer. Canonical bytes also reject
          // duplicate JSON keys and invalid UTF-8 that JSON.parse can otherwise mask.
          if (!current.bytes.equals(Buffer.from(`${JSON.stringify(this.#snapshot)}\n`, "utf8")))
            throw failure("model_recovery_corrupt");
          this.#fileIdentity = current.identity;
          this.#bytes = current.bytes;
        } else {
          if (recovery !== "none") throw failure("model_recovery_commit_unknown");
          this.#commit(Object.freeze({ version: VERSION, revision: 0, operations: Object.freeze([]) }));
        }
        this.#mode = "open";
        return this.#snapshot;
      } catch (error) {
        this.#mode = "failed";
        if (activeStores.get(this.#root) === this.#owner) activeStores.delete(this.#root);
        throw failure(typeof error?.code === "string" && error.code.startsWith("model_recovery_") ? error.code : "model_recovery_unavailable");
      }
    });
  }

  read() {
    if (this.#closing) return Promise.reject(failure("model_recovery_unavailable"));
    return this.#enqueue(() => { this.#requireOpen(); this.#verifyDisk(); return this.#snapshot; });
  }

  retain(value) {
    if (this.#closing) return Promise.reject(failure("model_recovery_unavailable"));
    let row;
    try { row = captureRow(value); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(() => {
      this.#requireOpen(); this.#verifyDisk();
      const index = this.#snapshot.operations.findIndex(existing => existing.operationId === row.operationId);
      let retained = row;
      if (index !== -1) {
        const existing = this.#snapshot.operations[index];
        if (!matchesIdentity(existing, row)) throw failure("model_recovery_scope_mismatch");
        if (existing.code === MARKER && row.code !== MARKER) retained = Object.freeze({ ...row, code: MARKER });
        if (existing.status === retained.status && existing.code === retained.code)
          return Object.freeze({ version: VERSION, revision: this.#snapshot.revision, operation: existing });
      } else if (this.#snapshot.operations.length >= MAX_OPERATIONS) throw failure("model_recovery_capacity");
      const operations = [...this.#snapshot.operations];
      if (index === -1) operations.push(retained); else operations[index] = retained;
      this.#commit(this.#nextSnapshot(operations));
      return Object.freeze({ version: VERSION, revision: this.#snapshot.revision, operation: retained });
    });
  }

  ack(value) {
    if (this.#closing) return Promise.reject(failure("model_recovery_unavailable"));
    let identity;
    try { identity = captureIdentity(value); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(() => {
      this.#requireOpen(); this.#verifyDisk();
      const index = this.#snapshot.operations.findIndex(row => row.operationId === identity.operationId);
      if (index !== -1 && !matchesIdentity(this.#snapshot.operations[index], identity)) throw failure("model_recovery_scope_mismatch");
      let outcome;
      try {
        // Capture this trusted synchronous callback at construction. No Renderer
        // receipt, recover call, backend access or async authorization fallback.
        outcome = verifyTerminal(this.#observe.call(this.#observeOwner, identity.backendId, {
          operationId: identity.operationId, providerKey: identity.providerKey,
        }), identity);
      } catch { throw failure("model_recovery_receipt_unverified"); }
      this.#verifyDisk();
      if (index !== -1) this.#commit(this.#nextSnapshot(this.#snapshot.operations.filter((_, position) => position !== index)));
      return Object.freeze({ version: VERSION, revision: this.#snapshot.revision, backendId: identity.backendId,
        providerKey: identity.providerKey, operationId: identity.operationId, status: "acknowledged", outcome });
    });
  }

  close() {
    this.#closing = true;
    return this.#enqueue(() => {
      this.#mode = "closed";
      if (activeStores.get(this.#root) === this.#owner) activeStores.delete(this.#root);
    });
  }
}

module.exports = { ModelOperationRecoveryStore };
