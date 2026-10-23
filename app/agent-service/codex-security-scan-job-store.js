"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, serviceError } = require("./security");

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE = "bundled:codex-security";
const SOURCE_DIGEST = "8d32d2544f37f8cc8f43df98216b2a505e6f71d9628c555086039daf1062e9fb";
const TOOL_TIMEOUT_MS = 349_200_000;
const START_TOOLS = new Set(["start_codex_security_scan", "start_codex_security_deep_scan",
  "start_codex_security_standard_scan", "start_codex_security_prompt_only_scan"]);
const READ_TOOLS = new Set(["get_codex_security_scan", "open_codex_security_workspace"]);
const STATES = new Set(["prepared", "send_started", "acknowledged", "running", "complete", "failed", "canceled", "not_sent", "needs_verification"]);
const TERMINAL = new Set(["complete", "failed", "canceled", "not_sent"]);
const CANCEL_STATES = new Set(["prepared", "send_started", "confirmed", "not_sent", "needs_verification"]);
const OWNER_FIELDS = ["runId", "profileId", "runtimeProfileId", "runtimeAccountId", "nativeThreadId", "nativeTurnId", "accountGeneration", "workspace"];
const INSTALL_FIELDS = ["installationId", "releaseDigest", "descriptorDigest", "sourceIdentity", "sourceDigest"];
const CAP_FIELDS = ["bindingId", "bindingRevision", "connectionId", "authRevision", "principalIdentity", "toolIdentity", "contractDigest", "catalogRevision", "grantEpoch", "grantRevision"];
const RECORD_FIELDS = ["version", "operationId", "requestDigest", "owner", "installation", "capability", "toolName", "sourceSessionId",
  "state", "scanId", "deadlineAt", "cancel", "createdAt", "updatedAt", "revision", "errorCode"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha(JSON.stringify(value));
const fail = code => { throw serviceError("CODEX_SECURITY_SCAN_JOB_" + code, "原扫描任务记录已变化、未确认或只能观察"); };
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });
const text = (value, max = 512) => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;
const time = value => Number.isSafeInteger(value) && value >= 0;
function validateOwner(value) {
  if (!exact(value, OWNER_FIELDS) || OWNER_FIELDS.slice(0, 6).some(key => !ID.test(value[key] || ""))
    || !revision(value.accountGeneration) || !text(value.workspace, 4096) || !path.isAbsolute(value.workspace)) fail("INVALID");
}
function validateInstallation(value) {
  if (!exact(value, INSTALL_FIELDS) || !ID.test(value.installationId || "")
    || !HASH.test(value.releaseDigest || "") || !HASH.test(value.descriptorDigest || "")
    || value.sourceIdentity !== SOURCE || value.sourceDigest !== SOURCE_DIGEST) fail("INVALID");
}
function validateCapability(value) {
  if (!exact(value, CAP_FIELDS) || ["bindingId", "connectionId"].some(key => !ID.test(value[key] || ""))
    || !text(value.principalIdentity) || !text(value.toolIdentity) || !HASH.test(value.contractDigest || "")
    || !text(value.catalogRevision, 128) || ["bindingRevision", "authRevision", "grantEpoch", "grantRevision"].some(key => !revision(value[key]))) fail("INVALID");
}
function identity(value) {
  return digest({ operationId: value.operationId, requestDigest: value.requestDigest, owner: value.owner,
    installation: value.installation, capability: value.capability, toolName: value.toolName, sourceSessionId: value.sourceSessionId });
}
function validateRecord(value) {
  if (!exact(value, RECORD_FIELDS) || value.version !== 1 || !ID.test(value.operationId || "")
    || !HASH.test(value.requestDigest || "") || !START_TOOLS.has(value.toolName) || !STATES.has(value.state)
    || (value.scanId !== null && !UUID.test(value.scanId)) || (value.sourceSessionId !== null && !UUID.test(value.sourceSessionId))
    || !time(value.createdAt) || !time(value.updatedAt) || value.updatedAt < value.createdAt || !revision(value.revision)
    || (value.deadlineAt !== null && (!time(value.deadlineAt) || value.deadlineAt < value.createdAt))
    || (value.errorCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value.errorCode))
    || (["prepared", "not_sent"].includes(value.state) && (value.scanId !== null || value.deadlineAt !== null))
    || (["acknowledged", "running", "complete", "failed", "canceled"].includes(value.state) && value.scanId === null)) fail("CORRUPT");
  validateOwner(value.owner); validateInstallation(value.installation); validateCapability(value.capability);
  if (value.cancel !== null && (!exact(value.cancel, ["operationId", "requestDigest", "state", "createdAt", "updatedAt"])
    || value.scanId === null || !ID.test(value.cancel.operationId || "") || !HASH.test(value.cancel.requestDigest || "")
    || !CANCEL_STATES.has(value.cancel.state) || !time(value.cancel.createdAt) || !time(value.cancel.updatedAt)
    || value.cancel.updatedAt < value.cancel.createdAt || (value.cancel.state === "confirmed" && value.state !== "canceled"))) fail("CORRUPT");
  return value;
}
function originalScanObservation(result) {
  // Inspect plain JSON without executing getters/toJSON or trusting human text.
  // Only the original structured scan/workspace state proves completion.
  let nodes = 0, bytes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 50_000 || depth > 40) fail("RESPONSE_INVALID");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) fail("RESPONSE_INVALID"); return; }
    if (typeof value === "string") { bytes += Buffer.byteLength(value); if (!value.isWellFormed() || bytes > 4 * 1024 * 1024) fail("RESPONSE_INVALID"); return; }
    if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail("RESPONSE_INVALID");
    if (Array.isArray(value) && value.length > 50_000) fail("RESPONSE_INVALID");
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1) fail("RESPONSE_INVALID");
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) fail("RESPONSE_INVALID");
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, "value")) fail("RESPONSE_INVALID");
      bytes += Buffer.byteLength(key); if (bytes > 4 * 1024 * 1024) fail("RESPONSE_INVALID");
      visit(field.value, depth + 1);
    }
  };
  visit(result);
  if (!result || typeof result !== "object" || result.isError === true
    || !Array.isArray(result.content) || !result.structuredContent || typeof result.structuredContent !== "object") fail("RESPONSE_INVALID");
  const structured = result.structuredContent;
  const scan = structured.scan && typeof structured.scan === "object" ? structured.scan : null;
  const workspace = structured.workspace && typeof structured.workspace === "object" ? structured.workspace : null;
  const values = [scan?.scanId, workspace?.results?.scanId, structured.scanId].filter(value => value !== undefined && value !== null);
  if (values.length === 0 || values.some(value => typeof value !== "string" || !UUID.test(value)) || new Set(values).size !== 1) fail("RESPONSE_INVALID");
  const statuses = [scan?.progress?.status, scan?.status, workspace?.results?.progress?.status].filter(value => value !== undefined && value !== null);
  const actual = statuses.filter(value => ["running", "complete", "failed", "canceled"].includes(value));
  if (statuses.some(value => typeof value !== "string") || new Set(actual).size > 1) fail("RESPONSE_INVALID");
  if (workspace?.id !== undefined && (typeof workspace.id !== "string" || !UUID.test(workspace.id))) fail("RESPONSE_INVALID");
  return { scanId: values[0], state: actual[0] || "acknowledged", workspaceId: workspace?.id || null };
}

// This store records effects and observations. Handles never grant native/MCP
// permission, and there is intentionally no retry/start-process implementation.
class CodexSecurityScanJobStore {
  #records = new Map(); #handles = new WeakMap(); #byId = new Map();
  #writer = null; #writerIdentity = null; #open = false; #failed = false;
  constructor({ paths, maxPending = 64, maxRecords = 4096, now = Date.now } = {}) {
    if (!paths?.trustedRoot || !path.isAbsolute(paths.trustedRoot) || !path.isAbsolute(paths.stateDir || "")
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024
      || !Number.isSafeInteger(maxRecords) || maxRecords < maxPending || maxRecords > 100_000 || typeof now !== "function") throw new TypeError("Scan job store requires private Service paths");
    this.paths = Object.freeze({ trustedRoot: path.resolve(paths.trustedRoot), stateDir: path.resolve(paths.stateDir) });
    this.directory = path.join(this.paths.stateDir, "codex-security-scan-jobs");
    this.maxPending = maxPending; this.maxRecords = maxRecords; this.now = now;
  }
  #time(previous = 0) { const value = this.now(); if (!time(value)) fail("INVALID_TIME"); return Math.max(previous, value); }
  open() {
    if (this.#open) return this;
    if (this.#failed) fail("WRITE_UNCERTAIN");
    ensurePrivateDirectoryTree(this.directory, this.paths.trustedRoot);
    this.#writer = acquirePrivateWriterLease({ trustedRoot: this.paths.trustedRoot, lockPath: path.join(this.directory, "writer.lock") });
    this.#writerIdentity = fs.lstatSync(this.#writer.lockPath);
    try {
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[a-f0-9]{64}\.json(?:\.tmp|\.backup-[1-9][0-9]*-[a-f0-9]{16})?$/u.test(name)) {
          if (recoverInterruptedPrivateFile(path.join(this.directory, name.slice(0, 69)), { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail("WRITE_UNCERTAIN");
        } else if (name !== "writer.lock" && name !== this.#writer.record.candidateBasename) fail("CORRUPT");
      }
      this.#open = true;
      for (const name of fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        if (this.#records.size >= this.maxRecords) fail("RECORD_LIMIT");
        const value = JSON.parse(readPrivateFile(path.join(this.directory, name), { maxBytes: 32 * 1024 }));
        if (!exact(value, ["record", "checksum"]) || digest(value.record) !== value.checksum) fail("CORRUPT");
        const record = validateRecord(value.record);
        if (name !== sha(record.operationId) + ".json" || this.#records.has(record.operationId)) fail("CORRUPT");
        this.#records.set(record.operationId, record);
      }
      for (const record of [...this.#records.values()]) if (!TERMINAL.has(record.state) && (record.state !== "needs_verification"
        || ["prepared", "send_started"].includes(record.cancel?.state))) {
        this.#write({ ...record, state: "needs_verification", errorCode: "SERVICE_RESTART_OBSERVE_ONLY",
          cancel: record.cancel && ["prepared", "send_started"].includes(record.cancel.state)
            ? { ...record.cancel, state: "needs_verification", updatedAt: this.#time(record.cancel.updatedAt) } : record.cancel,
          updatedAt: this.#time(record.updatedAt), revision: record.revision + 1 });
      }
      return this;
    } catch (error) { this.#open = false; this.#records.clear(); this.#writer.release(); this.#writer = null; throw error; }
  }
  #assertWriter() {
    if (!this.#open || !this.#writer || this.#failed) fail(this.#failed ? "WRITE_UNCERTAIN" : "CLOSED");
    assertPrivateDirectory(this.directory);
    const expected = Buffer.from(JSON.stringify(this.#writer.record) + "\n");
    for (const file of [this.#writer.lockPath, this.#writer.candidatePath]) {
      const before = fs.lstatSync(file), identity = this.#writerIdentity;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 2 || (before.mode & 0o077) !== 0
        || before.uid !== identity.uid || before.dev !== identity.dev || before.ino !== identity.ino || before.size !== expected.length) fail("WRITER_CHANGED");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { const opened = fs.fstatSync(fd), after = fs.lstatSync(file);
        if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev
          || !fs.readFileSync(fd).equals(expected)) fail("WRITER_CHANGED");
      } finally { fs.closeSync(fd); }
    }
  }
  #write(record) {
    this.#assertWriter(); validateRecord(record);
    try {
      atomicWritePrivateFile(path.join(this.directory, sha(record.operationId) + ".json"),
        JSON.stringify({ record, checksum: digest(record) }) + "\n", { trustedRoot: this.paths.trustedRoot });
      this.#assertWriter(); this.#records.set(record.operationId, record);
    } catch (error) { this.#failed = true; throw error; }
  }
  #scope(input) {
    if (!exact(input, ["operationId", "requestDigest", "runtimeAccountId", "installationId", "principalIdentity"])
      || !ID.test(input.operationId || "") || !HASH.test(input.requestDigest || "") || !ID.test(input.runtimeAccountId || "")
      || !ID.test(input.installationId || "") || !text(input.principalIdentity)) fail("INVALID");
    const record = this.#records.get(input.operationId);
    if (record && (record.requestDigest !== input.requestDigest || record.owner.runtimeAccountId !== input.runtimeAccountId
      || record.installation.installationId !== input.installationId || record.capability.principalIdentity !== input.principalIdentity)) fail("SCOPE_MISMATCH");
    return record;
  }
  #status(record) {
    return Object.freeze({ version: 1, operationId: record.operationId, state: record.state,
      scanId: record.scanId, deadlineAt: record.deadlineAt, revision: record.revision,
      cancellation: record.cancel?.state || "not_requested", needsVerification: record.state === "needs_verification"
        || record.cancel?.state === "needs_verification", fullPluginUsable: false });
  }
  observe(input) { this.#assertWriter(); const record = this.#scope(input); return record ? this.#status(record) : null; }
  prepare(input) {
    this.#assertWriter();
    if (!exact(input, ["operationId", "requestDigest", "owner", "installation", "capability", "toolName", "sourceSessionId"])
      || !ID.test(input.operationId || "") || !HASH.test(input.requestDigest || "") || !START_TOOLS.has(input.toolName)
      || (input.sourceSessionId !== null && !UUID.test(input.sourceSessionId))) fail("INVALID");
    validateOwner(input.owner); validateInstallation(input.installation); validateCapability(input.capability);
    const capture = structuredClone(input), previous = this.#records.get(input.operationId);
    if (previous) {
      if (identity(previous) !== identity(capture)) fail("SCOPE_MISMATCH");
      const handle = this.#byId.get(input.operationId);
      if (previous.state !== "prepared" || !handle) fail("OBSERVE_ONLY"); return handle;
    }
    const pending = [...this.#records.values()].filter(record => !TERMINAL.has(record.state));
    if (this.#records.size >= this.maxRecords) fail("RECORD_LIMIT");
    if (pending.length >= this.maxPending) fail("PENDING_LIMIT");
    if (pending.some(record => record.owner.runtimeAccountId === capture.owner.runtimeAccountId
      && record.installation.installationId === capture.installation.installationId)) fail("OWNER_BUSY");
    const now = this.#time();
    const record = { version: 1, ...capture, state: "prepared", scanId: null, deadlineAt: null, cancel: null,
      createdAt: now, updatedAt: now, revision: 1, errorCode: null };
    this.#write(record);
    return this.#handle(record, true);
  }
  #handle(record, writable) {
    const handle = Object.freeze({ version: 1, kind: "codex-security-original-scan-record" });
    this.#handles.set(handle, { operationId: record.operationId, identity: identity(record), writable });
    if (writable) this.#byId.set(record.operationId, handle); return handle;
  }
  resumeObservation(input) {
    this.#assertWriter(); const record = this.#scope(input);
    if (!record) fail("NOT_FOUND"); return this.#handle(record, false);
  }
  #record(handle, writable = false) {
    this.#assertWriter(); const captured = this.#handles.get(handle), record = captured && this.#records.get(captured.operationId);
    if (!record || captured.identity !== identity(record) || (writable && !captured.writable)) fail("HANDLE_INVALID"); return record;
  }
  #patch(handle, patch, writable = false) {
    const record = this.#record(handle, writable);
    const next = { ...record, ...patch, updatedAt: this.#time(record.updatedAt), revision: record.revision + 1 };
    this.#write(next); return this.#status(next);
  }
  markSendStarted(handle) {
    const record = this.#record(handle, true); if (record.state !== "prepared") fail("OBSERVE_ONLY");
    const deadlineAt = this.#time() + TOOL_TIMEOUT_MS;
    if (!time(deadlineAt)) fail("INVALID_TIME");
    return this.#patch(handle, { state: "send_started", deadlineAt }, true);
  }
  failUnsent(handle) {
    const record = this.#record(handle, true); if (record.state !== "prepared") fail("STATE_INVALID");
    return this.#patch(handle, { state: "not_sent", errorCode: "REJECTED_BEFORE_NATIVE_SEND" }, true);
  }
  markUnknown(handle, errorCode = "NATIVE_SCAN_OUTCOME_UNKNOWN") {
    const record = this.#record(handle); if (TERMINAL.has(record.state) || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(errorCode)) fail("STATE_INVALID");
    return this.#patch(handle, { state: "needs_verification", errorCode });
  }
  #assertUniqueScan(record, scanId) {
    if ([...this.#records.values()].some(other => other.operationId !== record.operationId
      && other.scanId === scanId && other.owner.runtimeAccountId === record.owner.runtimeAccountId
      && other.installation.installationId === record.installation.installationId)) fail("SCAN_ALREADY_RECORDED");
  }
  bindOriginalAcknowledgement(handle, result) {
    const record = this.#record(handle, true); if (record.state !== "send_started") fail("STATE_INVALID");
    const observation = originalScanObservation(result);
    if (record.sourceSessionId !== null && observation.workspaceId !== record.sourceSessionId) fail("SCAN_CHANGED");
    this.#assertUniqueScan(record, observation.scanId);
    return this.#patch(handle, { scanId: observation.scanId, state: observation.state, errorCode: null }, true);
  }
  recordOriginalObservation(handle, input) {
    const record = this.#record(handle);
    if (!exact(input, ["toolName", "result"]) || !READ_TOOLS.has(input.toolName)) fail("OBSERVATION_REQUIRED");
    const observation = originalScanObservation(input.result);
    if (input.toolName === "open_codex_security_workspace"
      && (record.sourceSessionId === null || observation.workspaceId !== record.sourceSessionId)) fail("SCAN_CHANGED");
    if (record.scanId === null) {
      if (record.state !== "needs_verification" || record.deadlineAt === null
        || input.toolName !== "open_codex_security_workspace") fail("OBSERVATION_REQUIRED");
      this.#assertUniqueScan(record, observation.scanId);
    } else if (observation.scanId !== record.scanId || (TERMINAL.has(record.state) && observation.state !== record.state)) fail("SCAN_CHANGED");
    if (!TERMINAL.has(observation.state) && record.deadlineAt !== null && this.#time() >= record.deadlineAt) {
      return this.#patch(handle, { scanId: observation.scanId, state: "needs_verification", errorCode: "ORIGINAL_DEADLINE_EXPIRED" });
    }
    // An acknowledgement without progress cannot regress a running scan or
    // resolve an unknown outcome. It only supplies the original identity.
    const state = observation.state === "acknowledged" && ["running", "needs_verification"].includes(record.state)
      ? record.state : observation.state;
    const cancel = observation.state === "canceled" && record.cancel
      && ["send_started", "needs_verification"].includes(record.cancel.state)
      ? { ...record.cancel, state: "confirmed", updatedAt: this.#time(record.cancel.updatedAt) } : record.cancel;
    return this.#patch(handle, { scanId: observation.scanId, state, cancel,
      errorCode: state === "needs_verification" ? record.errorCode : null });
  }
  findOriginalScan(input) {
    this.#assertWriter();
    if (!exact(input, ["scanId", "runtimeAccountId", "installationId", "principalIdentity"])
      || !UUID.test(input.scanId || "") || !ID.test(input.runtimeAccountId || "")
      || !ID.test(input.installationId || "") || !text(input.principalIdentity)) fail("INVALID");
    const record = [...this.#records.values()].find(item => item.scanId === input.scanId
      && item.owner.runtimeAccountId === input.runtimeAccountId && item.installation.installationId === input.installationId);
    if (record?.capability.principalIdentity !== input.principalIdentity && record) fail("SCOPE_MISMATCH");
    return record ? this.#handle(record, false) : null;
  }
  describe(handle) { return this.#status(this.#record(handle)); }
  prepareCancel(handle, { operationId, requestDigest } = {}) {
    const record = this.#record(handle);
    if (!ID.test(operationId || "") || !HASH.test(requestDigest || "") || record.scanId === null || TERMINAL.has(record.state)) fail("STATE_INVALID");
    if (record.cancel) {
      if (record.cancel.operationId !== operationId || record.cancel.requestDigest !== requestDigest) fail("CANCEL_ALREADY_RECORDED");
      return this.#status(record);
    }
    const now = this.#time(); return this.#patch(handle, { cancel: { operationId, requestDigest, state: "prepared", createdAt: now, updatedAt: now } });
  }
  markCancelSendStarted(handle, operationId) {
    const record = this.#record(handle);
    if (record.cancel?.operationId !== operationId || record.cancel.state !== "prepared" || TERMINAL.has(record.state)) fail("OBSERVE_ONLY");
    return this.#patch(handle, { cancel: { ...record.cancel, state: "send_started", updatedAt: this.#time(record.cancel.updatedAt) } });
  }
  markCancelUnknown(handle, operationId) {
    const record = this.#record(handle);
    if (record.cancel?.operationId !== operationId || record.cancel.state !== "send_started") fail("STATE_INVALID");
    return this.#patch(handle, { state: "needs_verification", errorCode: "NATIVE_CANCEL_OUTCOME_UNKNOWN",
      cancel: { ...record.cancel, state: "needs_verification", updatedAt: this.#time(record.cancel.updatedAt) } });
  }
  failCancelUnsent(handle, operationId) {
    const record = this.#record(handle);
    if (record.cancel?.operationId !== operationId || record.cancel.state !== "prepared") fail("STATE_INVALID");
    return this.#patch(handle, { cancel: { ...record.cancel, state: "not_sent", updatedAt: this.#time(record.cancel.updatedAt) } });
  }
  close() {
    if (!this.#writer) return false;
    this.#open = false; this.#byId.clear(); this.#handles = new WeakMap();
    const writer = this.#writer; this.#writer = null; writer.release(); return true;
  }
}
module.exports = { CodexSecurityScanJobStore, originalScanObservation, CODEX_SECURITY_SCAN_TOOL_TIMEOUT_MS: TOOL_TIMEOUT_MS };
