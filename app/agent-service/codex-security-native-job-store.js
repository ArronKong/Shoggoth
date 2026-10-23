"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OWNER_FIELDS = Object.freeze(["runId", "profileId", "bindingId", "runtimeProfileId", "runtimeAccountId",
  "attemptId", "accountGeneration", "workspace", "contextSnapshotId"]);
const INSTALL_FIELDS = Object.freeze(["installationId", "revision", "releaseDigest", "sourceDigest", "sourceIdentity"]);
const RECORD_FIELDS = Object.freeze(["version", "operationId", "requestDigest", "owner", "installation", "planDigest",
  "state", "nativeThreadId", "scanId", "createdAt", "updatedAt", "revision", "errorCode"]);
const STATES = new Set(["prepared", "starting", "native_ready", "needs_verification", "metadata_closed", "failed_unsent"]);
const TERMINAL = new Set(["metadata_closed", "failed_unsent"]);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha(JSON.stringify(value));
const fail = code => { throw serviceError(`CODEX_SECURITY_JOB_${code}`, "Codex Security 原任务记录不可写、已变化或只能核实"); };
function exact(value, fields) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === fields.length
    && fields.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value"); });
}
function text(value, max = 128) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max
    && value.isWellFormed() && !/[\x00-\x1f\x7f]/u.test(value);
}
function ownerOf(value) {
  if (!exact(value, OWNER_FIELDS) || OWNER_FIELDS.slice(0, 6).some(key => !text(value[key]))
    || !Number.isSafeInteger(value.accountGeneration) || value.accountGeneration < 1
    || !text(value.workspace, 4096) || !path.isAbsolute(value.workspace)
    || (value.contextSnapshotId !== null && !text(value.contextSnapshotId))) fail("INVALID");
  return Object.fromEntries(OWNER_FIELDS.map(key => [key, value[key]]));
}
function installationOf(value) {
  if (!exact(value, INSTALL_FIELDS) || !ID.test(value.installationId || "")
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !HASH.test(value.releaseDigest || "") || !HASH.test(value.sourceDigest || "")
    || value.sourceIdentity !== "bundled:codex-security") fail("INVALID");
  return Object.fromEntries(INSTALL_FIELDS.map(key => [key, value[key]]));
}
function scopeOf(value) {
  if (!exact(value, ["operationId", "requestDigest", "owner"]) || !ID.test(value.operationId || "")
    || !HASH.test(value.requestDigest || "")) fail("INVALID");
  return { operationId: value.operationId, requestDigest: value.requestDigest, owner: ownerOf(value.owner) };
}
function identity(record) {
  return digest({ operationId: record.operationId, requestDigest: record.requestDigest,
    owner: record.owner, installation: record.installation, planDigest: record.planDigest });
}
function validateRecord(value) {
  if (!exact(value, RECORD_FIELDS) || value.version !== 1 || !ID.test(value.operationId || "")
    || !HASH.test(value.requestDigest || "") || !HASH.test(value.planDigest || "") || !STATES.has(value.state)
    || (value.nativeThreadId !== null && !text(value.nativeThreadId, 512)) || value.scanId !== null
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.errorCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.errorCode))
    || (["prepared", "failed_unsent"].includes(value.state) && value.nativeThreadId !== null)
    || (["native_ready", "metadata_closed"].includes(value.state) && value.nativeThreadId === null)) fail("CORRUPT");
  ownerOf(value.owner); installationOf(value.installation);
  return value;
}

// Service-only durable identities. A handle is NOT scanner permission. This
// foundation has no "scan completed" or "retry scan" transition. Incomplete
// records on restart are observation-only; terminal IDs are never pruned.
class CodexSecurityNativeJobStore {
  #records = new Map();
  #handles = new WeakMap();
  #byId = new Map();
  #writer = null;
  #writerIdentity = null;
  #open = false;
  #failed = false;

  constructor({ paths, maxPending = 64, now = Date.now } = {}) {
    if (!paths?.trustedRoot || !paths.stateDir || !path.isAbsolute(paths.trustedRoot)
      || !path.isAbsolute(paths.stateDir) || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) {
      throw new TypeError("Codex Security job store requires private Service paths");
    }
    this.paths = Object.freeze({ trustedRoot: path.resolve(paths.trustedRoot), stateDir: path.resolve(paths.stateDir) });
    this.directory = path.join(this.paths.stateDir, "codex-security-native-jobs");
    this.maxPending = maxPending; this.now = now;
  }

  open() {
    if (this.#open) return this;
    if (this.#failed) fail("WRITE_UNCERTAIN");
    ensurePrivateDirectoryTree(this.directory, this.paths.trustedRoot);
    this.#writer = acquirePrivateWriterLease({ trustedRoot: this.paths.trustedRoot, lockPath: path.join(this.directory, "writer.lock") });
    this.#writerIdentity = fs.lstatSync(this.#writer.lockPath);
    try {
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[a-f0-9]{64}\.json(?:\.tmp|\.backup-[1-9][0-9]*-[a-f0-9]{16})?$/u.test(name)) {
          const file = path.join(this.directory, name.slice(0, 69));
          if (recoverInterruptedPrivateFile(file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("WRITE_UNCERTAIN");
        } else if (name === "writer.lock" || name === this.#writer.record.candidateBasename) {
          // Only this exact captured writer's two linked files are allowed.
        } else fail("CORRUPT");
      }
      this.#open = true;
      for (const name of fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const value = JSON.parse(readPrivateFile(path.join(this.directory, name), { maxBytes: 32 * 1024 }));
        if (!exact(value, ["record", "checksum"]) || digest(value.record) !== value.checksum) fail("CORRUPT");
        const record = validateRecord(value.record);
        if (name !== `${sha(record.operationId)}.json` || this.#records.has(record.operationId)) fail("CORRUPT");
        this.#records.set(record.operationId, record);
      }
      for (const record of [...this.#records.values()]) {
        if (!TERMINAL.has(record.state) && record.state !== "needs_verification") {
          this.#write({ ...record, state: "needs_verification", errorCode: "SERVICE_RESTART_OBSERVE_ONLY",
            updatedAt: Math.max(record.updatedAt + 1, this.now()), revision: record.revision + 1 });
        }
      }
      return this;
    } catch (error) {
      this.#open = false; this.#records.clear(); this.#writer.release(); this.#writer = null;
      throw error;
    }
  }

  #assertWriter() {
    if (!this.#open || !this.#writer || this.#failed) fail(this.#failed ? "WRITE_UNCERTAIN" : "CLOSED");
    assertPrivateDirectory(this.directory);
    const expected = Buffer.from(`${JSON.stringify(this.#writer.record)}\n`);
    for (const file of [this.#writer.lockPath, this.#writer.candidatePath]) {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 2 || (before.mode & 0o077) !== 0
        || before.uid !== this.#writerIdentity.uid || before.dev !== this.#writerIdentity.dev
        || before.ino !== this.#writerIdentity.ino || before.size !== expected.length) fail("WRITER_CHANGED");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = fs.fstatSync(fd), after = fs.lstatSync(file);
        if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev
          || !fs.readFileSync(fd).equals(expected)) fail("WRITER_CHANGED");
      } finally { fs.closeSync(fd); }
    }
  }
  #write(record) {
    this.#assertWriter(); validateRecord(record);
    try {
      atomicWritePrivateFile(path.join(this.directory, `${sha(record.operationId)}.json`),
        `${JSON.stringify({ record, checksum: digest(record) })}\n`, { trustedRoot: this.paths.trustedRoot });
      this.#assertWriter(); this.#records.set(record.operationId, record);
    } catch (error) { this.#failed = true; throw error; }
  }
  #status(record) {
    return Object.freeze({ version: 1, operationId: record.operationId, state: record.state,
      hasNativeThread: record.nativeThreadId !== null, needsVerification: record.state === "needs_verification",
      fullPluginUsable: false });
  }
  #matching(input) {
    const scope = scopeOf(input), record = this.#records.get(scope.operationId);
    if (record && (record.requestDigest !== scope.requestDigest || digest(record.owner) !== digest(scope.owner))) fail("SCOPE_MISMATCH");
    return record;
  }
  observe(input) {
    this.#assertWriter(); const record = this.#matching(input);
    return record ? this.#status(record) : Object.freeze({ version: 1, operationId: input.operationId,
      state: "not_found", hasNativeThread: false, needsVerification: false, fullPluginUsable: false });
  }
  prepare(input) {
    this.#assertWriter();
    if (!exact(input, ["operationId", "requestDigest", "owner", "installation", "planDigest"])) fail("INVALID");
    const scope = scopeOf({ operationId: input.operationId, requestDigest: input.requestDigest, owner: input.owner });
    const installation = installationOf(input.installation);
    if (!HASH.test(input.planDigest || "")) fail("INVALID");
    const capture = { ...scope, installation, planDigest: input.planDigest };
    const previous = this.#records.get(scope.operationId);
    if (previous) {
      if (identity(previous) !== identity(capture)) fail("SCOPE_MISMATCH");
      const existing = this.#byId.get(scope.operationId);
      if (previous.state !== "prepared" || !existing) fail("OBSERVE_ONLY");
      return existing;
    }
    const pending = [...this.#records.values()].filter(record => !TERMINAL.has(record.state));
    if (pending.length >= this.maxPending) fail("PENDING_LIMIT");
    // An unknown native job on this installed package/account cannot be hidden
    // by creating another Run or operation ID. Explicit reconciliation is future work.
    if (pending.some(record => record.owner.runtimeAccountId === scope.owner.runtimeAccountId
      && record.installation.installationId === installation.installationId)) fail("OWNER_BUSY");
    const time = this.now();
    const record = { version: 1, ...capture, state: "prepared", nativeThreadId: null, scanId: null,
      createdAt: time, updatedAt: time, revision: 1, errorCode: null };
    this.#write(record);
    const handle = Object.freeze({ version: 1, kind: "codex-security-durable-native-job" });
    this.#handles.set(handle, { operationId: scope.operationId, identity: identity(record) });
    this.#byId.set(scope.operationId, handle); return handle;
  }
  #record(handle) {
    this.#assertWriter(); const capture = this.#handles.get(handle);
    const record = capture && this.#records.get(capture.operationId);
    if (!record || identity(record) !== capture.identity) fail("HANDLE_INVALID");
    return record;
  }
  assertHandle(handle, state) {
    const record = this.#record(handle);
    if (state !== undefined && record.state !== state) fail("STATE_INVALID");
    return this.#status(record);
  }
  #transition(handle, from, patch) {
    const record = this.#record(handle);
    if (!from.includes(record.state)) fail("STATE_INVALID");
    this.#write({ ...record, ...patch, updatedAt: Math.max(record.updatedAt + 1, this.now()), revision: record.revision + 1 });
    return this.#status(this.#records.get(record.operationId));
  }
  markStarting(handle) { return this.#transition(handle, ["prepared"], { state: "starting" }); }
  bindNativeThread(handle, nativeThreadId) {
    if (!text(nativeThreadId, 512)) fail("INVALID");
    return this.#transition(handle, ["starting"], { state: "native_ready", nativeThreadId });
  }
  markUncertain(handle, errorCode = "NATIVE_OUTCOME_UNKNOWN") {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(errorCode)) fail("INVALID");
    return this.#transition(handle, ["prepared", "starting", "native_ready", "needs_verification"], { state: "needs_verification", errorCode });
  }
  failUnsent(handle) { return this.#transition(handle, ["prepared"], { state: "failed_unsent", errorCode: "FAILED_BEFORE_NATIVE_START" }); }
  closeMetadata(handle) { return this.#transition(handle, ["native_ready"], { state: "metadata_closed", errorCode: null }); }
  close() {
    if (!this.#writer) return false;
    this.#open = false; this.#byId.clear(); this.#handles = new WeakMap();
    const writer = this.#writer; this.#writer = null; writer.release(); return true;
  }
}

module.exports = { CodexSecurityNativeJobStore, CODEX_SECURITY_NATIVE_JOB_OWNER_FIELDS: OWNER_FIELDS,
  CODEX_SECURITY_NATIVE_JOB_INSTALL_FIELDS: INSTALL_FIELDS };
