"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const P = require("./memory-provider-owner-protocol.cjs");
const { TurnMemo } = require("./turn-memo");
const PREFIX = "memory-provider-credential-";
const KIND = "external-provider-api-key";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const FP = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["completed", "cancelled"]);
const PHASES = new Set(["reserved", "credential_ready", "published", "retired", "completed", "cancelled"]);
const authorities = new WeakMap();
const stoppedAuthorities = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function createMemoryOwnerManagementAuthority(assertCurrent) {
  if (typeof assertCurrent !== "function") throw new TypeError("An authenticated Service assertion is required");
  const authority = Object.freeze({}); authorities.set(authority, assertCurrent); return authority;
}
function createMemoryOwnerStoppedLeaseAuthority(assertStopped) {
  if (typeof assertStopped !== "function") throw new TypeError("A verified stopped owner assertion is required");
  const authority = Object.freeze({}); stoppedAuthorities.set(authority, assertStopped); return authority;
}
// This is a trusted startup resource operation, never a public RPC parameter.
// The authority must hold the Service's exclusive stopped-recovery lease for
// this complete synchronous action, and prove the exact physical writer dead.
// The controller cannot manufacture that cross-process Service authority.
// No recursive recovery marker is created. Unknown/live evidence is retained.
function recoverStoppedMemoryOwnerCatalogLock({ stateDir, trustedRoot, privateFiles, authorizeStoppedOwner }) {
  P.need(path.isAbsolute(stateDir) && path.isAbsolute(trustedRoot) && typeof authorizeStoppedOwner === "function", "MEMORY_OWNER_FORBIDDEN");
  const lockPath = path.join(stateDir, "memory-provider-owners.json.lock");
  privateFiles.preparePrivateParent(lockPath, trustedRoot);
  let fd;
  try {
    // A crash immediately after exclusive link publication can leave exactly
    // two links: the published lock and its one prepared identity file.
    const before = fs.lstatSync(lockPath);
    P.need(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o077) === 0
      && (typeof process.getuid !== "function" || before.uid === process.getuid()) && [1, 2].includes(before.nlink), "MEMORY_OWNER_STORAGE_UNSAFE");
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const opened = fs.fstatSync(fd);
    P.need(opened.dev === before.dev && opened.ino === before.ino && opened.size <= 4096, "MEMORY_OWNER_STORAGE_CHANGED");
    const bytes = fs.readFileSync(fd);
    const info = P.record(JSON.parse(bytes.toString("utf8")), {
      version: value => { P.need(value === 1); return value; }, pid: value => { P.need(Number.isSafeInteger(value) && value > 1); return value; },
      startedAt: P.integer, token: value => { P.need(typeof value === "string" && FP.test(value)); return value; },
    }, ["version", "pid", "startedAt", "token"]);
    const assertion = stoppedAuthorities.get(authorizeStoppedOwner(info)); P.need(assertion && assertion() === true, "MEMORY_OWNER_FORBIDDEN");
    if (before.nlink === 2) {
      const preparedPath = `${lockPath}.lease-${info.pid}-${info.startedAt}-${info.token}`;
      const prepared = fs.lstatSync(preparedPath);
      P.need(prepared.dev === before.dev && prepared.ino === before.ino && prepared.nlink === 2 && prepared.isFile()
        && !prepared.isSymbolicLink() && (prepared.mode & 0o077) === 0, "MEMORY_OWNER_STORAGE_CHANGED");
      P.need(assertion() === true, "MEMORY_OWNER_FORBIDDEN"); fs.unlinkSync(preparedPath);
    }
    const current = privateFiles.validatePrivateStat(fs.lstatSync(lockPath), lockPath);
    P.need(current.dev === before.dev && current.ino === before.ino && hash(privateFiles.readPrivateFile(lockPath)) === hash(bytes), "MEMORY_OWNER_STORAGE_CHANGED");
    P.need(assertion() === true, "MEMORY_OWNER_FORBIDDEN"); fs.unlinkSync(lockPath); privateFiles.fsyncPrivateParent(stateDir); return true;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function publishWriteProof(target, bytes, { paths, privateFiles, owner }) {
  const proofPath = `${target}.owner-write-${crypto.randomUUID()}.json`, preparedPath = `${proofPath}.prepared`;
  const existing = fs.existsSync(target) ? fs.lstatSync(target) : null;
  const proof = { version: 1, owner, relativeTarget: path.relative(paths.stateDir, target),
    before: existing ? { dev: existing.dev, ino: existing.ino, hash: hash(privateFiles.readPrivateFile(target)) } : null,
    directory: { dev: fs.lstatSync(path.dirname(target)).dev, ino: fs.lstatSync(path.dirname(target)).ino },
    tempName: `${path.basename(target)}.owner-tmp-${crypto.randomUUID()}`, after: bytes.toString("base64"), afterHash: hash(bytes) };
  const fd = fs.openSync(preparedPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(proof)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.linkSync(preparedPath, proofPath); fs.unlinkSync(preparedPath); privateFiles.fsyncPrivateParent(path.dirname(target));
  return { proofPath, tempPath: path.join(path.dirname(target), proof.tempName) };
}
function publishBackupReservation(proofPath, backupName, privateFiles) {
  const target = `${proofPath}.backup.json`, prepared = `${target}.prepared`;
  const value = Buffer.from(`${JSON.stringify({ version: 1, proofHash: hash(privateFiles.readPrivateFile(proofPath)), backupName })}\n`);
  const fd = fs.openSync(prepared, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(prepared, target); fs.unlinkSync(prepared); privateFiles.fsyncPrivateParent(path.dirname(target)); return target;
}
// Only immutable write proofs reserved by the verified stopped catalog lease
// authorize cleanup. Arbitrary fixed .tmp/backup files are never adopted.
function recoverStoppedMemoryOwnerCatalogFiles({ stateDir, trustedRoot, privateFiles, authorizeStoppedOwner }) {
  P.need(path.isAbsolute(stateDir) && path.isAbsolute(trustedRoot) && typeof authorizeStoppedOwner === "function", "MEMORY_OWNER_FORBIDDEN");
  const roots = [stateDir], receiptDir = path.join(stateDir, "memory-provider-owner-receipts");
  privateFiles.preparePrivateParent(path.join(stateDir, "memory-provider-owners.json"), trustedRoot);
  privateFiles.validateDirectoryStat(fs.lstatSync(stateDir), stateDir);
  if (fs.existsSync(receiptDir)) { privateFiles.validateDirectoryStat(fs.lstatSync(receiptDir), receiptDir); roots.push(receiptDir); }
  let recovered = 0;
  for (const directory of roots) for (const name of fs.readdirSync(directory)) {
    if (!/\.owner-write-[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const proofPath = path.join(directory, name), pin = fs.lstatSync(proofPath);
    P.need(pin.isFile() && !pin.isSymbolicLink() && (pin.mode & 0o077) === 0 && [1, 2].includes(pin.nlink)
      && (typeof process.getuid !== "function" || pin.uid === process.getuid()) && pin.size <= 2 * 1048576, "MEMORY_OWNER_STORAGE_UNSAFE");
    const fd = fs.openSync(proofPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let raw;
    try { const opened = fs.fstatSync(fd); P.need(opened.dev === pin.dev && opened.ino === pin.ino, "MEMORY_OWNER_STORAGE_CHANGED"); raw = fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
    const proof = P.record(JSON.parse(raw.toString("utf8")), { version: value => { P.need(value === 1); return value; },
      owner: value => P.record(value, { version: value => { P.need(value === 1); return value; }, pid: P.integer, startedAt: P.integer,
        token: value => { P.need(FP.test(value)); return value; } }, ["version", "pid", "startedAt", "token"]),
      relativeTarget: value => { P.need(value === "memory-provider-owners.json" || /^memory-provider-owner-receipts\/[a-f0-9]{64}\.json$/u.test(value)); return value; },
      before: value => nullable(value, value => P.record(value, { dev: P.integer, ino: P.integer, hash: value => { P.need(FP.test(value)); return value; } }, ["dev", "ino", "hash"])),
      directory: value => P.record(value, { dev: P.integer, ino: P.integer }, ["dev", "ino"]),
      tempName: value => { P.need(typeof value === "string" && !value.includes(path.sep)); return value; },
      after: value => { P.need(typeof value === "string" && value.length <= 1500000); return value; }, afterHash: value => { P.need(FP.test(value)); return value; },
    }, ["version", "owner", "relativeTarget", "before", "directory", "tempName", "after", "afterHash"]);
    const assertion = stoppedAuthorities.get(authorizeStoppedOwner(proof.owner)); P.need(assertion && assertion() === true, "MEMORY_OWNER_FORBIDDEN");
    const target = path.join(stateDir, proof.relativeTarget), parent = path.dirname(target), basename = path.basename(target);
    P.need(proofPath.startsWith(`${target}.owner-write-`) && new RegExp(`^${basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.owner-tmp-[a-f0-9-]{36}$`, "u").test(proof.tempName), "MEMORY_OWNER_STORAGE_UNSAFE");
    const parentPin = privateFiles.validateDirectoryStat(fs.lstatSync(parent), parent);
    P.need(parentPin.dev === proof.directory.dev && parentPin.ino === proof.directory.ino, "MEMORY_OWNER_STORAGE_CHANGED");
    const after = Buffer.from(proof.after, "base64"); P.need(after.toString("base64") === proof.after && hash(after) === proof.afterHash, "MEMORY_OWNER_STORAGE_UNSAFE");
    // Also validate the intended published bytes as the exact private schema.
    const data = JSON.parse(after.toString("utf8"));
    if (basename === "memory-provider-owners.json") validateLedger(data);
    else P.validateResult(P.METHODS[1], { ...data, phase: data.status === "cancelled" ? "cancelled" : "completed", current: false });
    P.need(!fs.existsSync(`${target}.tmp`), "MEMORY_OWNER_RECOVERY_REQUIRED");
    const backupNames = fs.readdirSync(parent).filter(entry => entry.startsWith(`${basename}.backup-`));
    P.need(backupNames.length <= 1, "MEMORY_OWNER_RECOVERY_REQUIRED");
    const backupReservationPath = `${proofPath}.backup.json`;
    let backupReservation = null, backupReservationPin = null;
    if (fs.existsSync(backupReservationPath)) {
      backupReservationPin = fs.lstatSync(backupReservationPath);
      P.need(backupReservationPin.isFile() && !backupReservationPin.isSymbolicLink() && [1, 2].includes(backupReservationPin.nlink)
        && (backupReservationPin.mode & 0o077) === 0, "MEMORY_OWNER_STORAGE_UNSAFE");
      const fd = fs.openSync(backupReservationPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let bytes;
      try { const opened = fs.fstatSync(fd); P.need(opened.dev === backupReservationPin.dev && opened.ino === backupReservationPin.ino, "MEMORY_OWNER_STORAGE_CHANGED"); bytes = fs.readFileSync(fd); }
      finally { fs.closeSync(fd); }
      backupReservation = P.record(JSON.parse(bytes.toString("utf8")), { version: value => { P.need(value === 1); return value; },
        proofHash: value => { P.need(value === hash(raw)); return value; },
        backupName: value => { P.need(typeof value === "string" && !value.includes(path.sep)
          && value.startsWith(`${basename}.backup-${proof.owner.pid}-`)); return value; } }, ["version", "proofHash", "backupName"]);
    }
    const current = fs.existsSync(target) ? fs.lstatSync(target) : null;
    let currentHash = null;
    if (current) {
      P.need(current.isFile() && !current.isSymbolicLink() && (current.mode & 0o077) === 0 && [1, 2].includes(current.nlink), "MEMORY_OWNER_STORAGE_UNSAFE");
      const currentFd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { const actual = fs.fstatSync(currentFd); P.need(actual.dev === current.dev && actual.ino === current.ino, "MEMORY_OWNER_STORAGE_CHANGED"); currentHash = hash(fs.readFileSync(currentFd)); }
      finally { fs.closeSync(currentFd); }
    }
    const beforeMatches = proof.before ? current && current.dev === proof.before.dev && current.ino === proof.before.ino && currentHash === proof.before.hash : current === null;
    P.need(beforeMatches || currentHash === proof.afterHash, "MEMORY_OWNER_STORAGE_CHANGED");
    const cleanup = [];
    if (backupNames.length) {
      const backupPath = path.join(parent, backupNames[0]), stat = fs.lstatSync(backupPath);
      P.need(proof.before && backupReservation && backupReservation.backupName === backupNames[0]
        && /^.+\.backup-[1-9][0-9]*-[a-f0-9]{16}$/u.test(backupNames[0]) && stat.isFile() && !stat.isSymbolicLink()
        && (stat.mode & 0o077) === 0 && stat.dev === proof.before.dev && stat.ino === proof.before.ino
        && (beforeMatches ? stat.nlink === 2 && current.nlink === 2 : stat.nlink === 1), "MEMORY_OWNER_STORAGE_CHANGED");
      const backupFd = fs.openSync(backupPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { P.need(hash(fs.readFileSync(backupFd)) === proof.before.hash, "MEMORY_OWNER_STORAGE_CHANGED"); } finally { fs.closeSync(backupFd); }
      cleanup.push([backupPath, stat]);
    } else P.need(!current || current.nlink === 1, "MEMORY_OWNER_STORAGE_CHANGED");
    const tempPath = path.join(parent, proof.tempName);
    if (fs.existsSync(tempPath)) { const stat = privateFiles.validatePrivateStat(fs.lstatSync(tempPath), tempPath), content = privateFiles.readPrivateFile(tempPath, { maxBytes: 1048576 });
      P.need(content.length <= after.length && content.equals(after.subarray(0, content.length)), "MEMORY_OWNER_STORAGE_CHANGED"); cleanup.push([tempPath, stat]); }
    if (pin.nlink === 2) { const preparedPath = `${proofPath}.prepared`, prepared = fs.lstatSync(preparedPath);
      P.need(prepared.dev === pin.dev && prepared.ino === pin.ino && prepared.nlink === 2, "MEMORY_OWNER_STORAGE_CHANGED"); cleanup.push([preparedPath, prepared]); }
    if (backupReservationPin) {
      if (backupReservationPin.nlink === 2) { const preparedPath = `${backupReservationPath}.prepared`, prepared = fs.lstatSync(preparedPath);
        P.need(prepared.dev === backupReservationPin.dev && prepared.ino === backupReservationPin.ino && prepared.nlink === 2, "MEMORY_OWNER_STORAGE_CHANGED"); cleanup.push([preparedPath, prepared]); }
      cleanup.push([backupReservationPath, backupReservationPin]);
    }
    cleanup.push([proofPath, pin]);
    // All evidence is inspected before any deletion; every mutation rechecks
    // the exact stopped lease and pinned inode. A recovery crash is repeatable.
    for (const [file, identity] of cleanup) { P.need(assertion() === true, "MEMORY_OWNER_FORBIDDEN"); const stat = fs.lstatSync(file);
      P.need(stat.dev === identity.dev && stat.ino === identity.ino, "MEMORY_OWNER_STORAGE_CHANGED"); fs.unlinkSync(file); }
    privateFiles.fsyncPrivateParent(parent); recovered += 1;
  }
  return recovered;
}
function frozen(value) {
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value))) {
    for (const child of Object.values(value)) frozen(child); Object.freeze(value);
  } return value;
}
function credentialRef(value) { P.need(typeof value === "string" && value.startsWith(PREFIX) && UUID.test(value.slice(PREFIX.length))); return value; }
function nullable(value, validate) { return value === null ? null : validate(value); }
function validateRow(value) {
  const result = P.record(value, {
    ownerRef: P.id, label: entry => { P.need(typeof entry === "string" && entry.length > 0 && entry.length <= 128); return entry; },
    scope: P.scope, providerId: P.id, api: entry => { P.need(["openai-completions", "openai-responses", "google-generative-ai"].includes(entry)); return entry; },
    baseUrl: P.endpoint, headers: P.headers, revision: P.integer,
    status: entry => { P.need(["active", "revoked"].includes(entry)); return entry; },
    credentialRef: entry => nullable(entry, credentialRef), credentialKind: entry => { P.need(entry === null || entry === KIND); return entry; },
    credentialFingerprint: entry => nullable(entry, current => { P.need(typeof current === "string" && FP.test(current)); return current; }),
    createdAt: P.integer, updatedAt: P.integer, lastOperationId: P.id,
  }, ["ownerRef", "label", "scope", "providerId", "api", "baseUrl", "headers", "revision", "status", "credentialRef", "credentialKind", "credentialFingerprint", "createdAt", "updatedAt", "lastOperationId"]);
  P.need((result.credentialRef === null) === (result.credentialKind === null)
    && (result.credentialRef !== null || result.credentialFingerprint === null)
    && (result.status !== "revoked" || result.credentialRef === null)); return result;
}
function validateLedger(value) {
  const result = P.record(value, {
    version: entry => { P.need(entry === 1); return entry; }, ledgerRevision: P.integer, catalogRevision: P.integer,
    idempotencyKey: entry => { P.need(typeof entry === "string" && FP.test(entry)); return entry; },
    owners: entry => {
      P.need(entry && Object.getPrototypeOf(entry) === Object.prototype && Reflect.ownKeys(entry).length <= 128);
      const rows = {}; for (const key of Reflect.ownKeys(entry)) { P.id(key); rows[key] = validateRow(P.ownValue(entry, key)); P.need(rows[key].ownerRef === key
        && (rows[key].credentialRef === null || rows[key].credentialFingerprint !== null)); } return frozen(rows);
    },
    operations: entry => {
      P.need(entry && Object.getPrototypeOf(entry) === Object.prototype && Reflect.ownKeys(entry).length <= 1024);
      const rows = {};
      for (const key of Reflect.ownKeys(entry)) {
        P.id(key);
        const operation = P.ownValue(entry, key);
        const item = P.record(operation, {
          operationId: P.id, requestDigest: value => { P.need(typeof value === "string" && FP.test(value)); return value; },
          request: value => { value = P.capture(value); const request = P.mutation({ ...value, ...(value.secretAction === "set" ? { secret: "__validation_only__" } : {}) });
            const { secret, ...publicRequest } = request; return frozen(publicRequest); },
          ownerRef: P.id, before: value => nullable(value, validateRow), after: validateRow,
          phase: value => { P.need(PHASES.has(value)); return value; },
          candidateRef: value => nullable(value, credentialRef), candidateFingerprint: value => nullable(value, value => { P.need(FP.test(value)); return value; }),
          cleanupRef: value => nullable(value, credentialRef), cleanupFingerprint: value => nullable(value, value => { P.need(FP.test(value)); return value; }),
          publishedCatalogRevision: value => nullable(value, P.integer), createdAt: P.integer,
          outcome: value => { P.need(value === "apply" || value === "cancel"); return value; },
          receipt: value => nullable(value, current => P.record(current, { operationId: P.id, ownerRef: P.id,
            catalogRevision: P.integer, ownerRevision: P.integer, status: value => { P.need(["active", "revoked", "cancelled"].includes(value)); return value; },
            cleanupComplete: value => { P.need(value === true); return true; } }, ["operationId", "ownerRef", "catalogRevision", "ownerRevision", "status", "cleanupComplete"])),
        }, ["operationId", "requestDigest", "request", "ownerRef", "before", "after", "phase", "candidateRef", "candidateFingerprint", "cleanupRef", "cleanupFingerprint", "publishedCatalogRevision", "createdAt", "outcome", "receipt"]);
        P.need(item.operationId === key && item.request.operationId === key && item.after.ownerRef === item.ownerRef
          && (!item.before || item.before.ownerRef === item.ownerRef)
          && (item.cleanupRef === null) === (item.cleanupFingerprint === null)
          && (item.candidateRef !== null || item.candidateFingerprint === null)
          && (TERMINAL.has(item.phase) === (item.receipt !== null)));
        rows[key] = item;
      }
      return frozen(rows);
    },
  }, ["version", "ledgerRevision", "catalogRevision", "idempotencyKey", "owners", "operations"]);
  const seen = new Set();
  for (const operation of Object.values(result.operations)) if (operation.candidateRef !== null) {
    P.need(!seen.has(operation.candidateRef)); seen.add(operation.candidateRef);
  }
  for (const owner of Object.values(result.owners)) P.need(Object.hasOwn(result.operations, owner.lastOperationId));
  return result;
}

class MemoryProviderOwnerController {
  #physicalChecks = new TurnMemo();

  constructor({ paths, secretStore, privateFiles, authorizeManagement, assertServiceCurrent, assertProfileCurrent,
    getProfileIds, getConfig, retireOwners, now = Date.now, randomUUID = crypto.randomUUID, fault = () => {}, leaseFault = () => {} } = {}) {
    if (!paths?.stateDir || !path.isAbsolute(paths.stateDir) || !paths.trustedRoot || !path.isAbsolute(paths.trustedRoot) || !secretStore || !privateFiles
      || [authorizeManagement, assertServiceCurrent, assertProfileCurrent, getProfileIds, getConfig, retireOwners, now, randomUUID, fault, leaseFault].some(value => typeof value !== "function")
      || ["listMetadata", "getCredentialFingerprint", "getCredentialRevision", "get", "putIfRevision", "withPlaintextMatcher"].some(name => typeof secretStore[name] !== "function")
      || ["atomicWritePrivateFile", "readPrivateFile", "preparePrivateParent", "validateDirectoryStat", "validatePrivateStat"].some(name => typeof privateFiles[name] !== "function")) {
      throw new TypeError("Explicit private catalog resources are required");
    }
    this.paths = paths; this.secretStore = secretStore; this.privateFiles = privateFiles;
    this.authorizeManagement = authorizeManagement; this.assertServiceCurrent = assertServiceCurrent; this.assertProfileCurrent = assertProfileCurrent;
    this.getProfileIds = getProfileIds; this.getConfig = getConfig; this.retireOwners = retireOwners; this.now = now; this.randomUUID = randomUUID; this.fault = fault; this.leaseFault = leaseFault;
    this.file = path.join(paths.stateDir, "memory-provider-owners.json"); this.lockPath = `${this.file}.lock`;
    this.receiptsDir = path.join(paths.stateDir, "memory-provider-owner-receipts"); this.lock = null;
    this.opened = false; this.closing = false; this.poisoned = false; this.queue = Promise.resolve(); this.lifetime = new AbortController();
    for (const name of ["resolveOwner", "projectProviderMetadata", "close"]) this[name] = this[name].bind(this);
  }
  open() {
    P.need(!this.opened && !this.closing, "MEMORY_OWNER_CONFLICT");
    this.privateFiles.preparePrivateParent(this.file, this.paths.trustedRoot);
    this.parentIdentity = fs.lstatSync(this.paths.stateDir);
    this.#assertNoArtifacts(this.file); this.#assertNoArtifacts(this.lockPath);
    let fd, preparedPath, preparedIdentity, linked = false;
    try {
      const info = { version: 1, pid: process.pid, startedAt: this.now(), token: crypto.randomBytes(32).toString("hex") }; P.integer(info.startedAt);
      const token = JSON.stringify(info); preparedPath = `${this.lockPath}.lease-${info.pid}-${info.startedAt}-${info.token}`;
      fd = fs.openSync(preparedPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      preparedIdentity = fs.fstatSync(fd); this.leaseFault("lease-created");
      fs.writeFileSync(fd, token); fs.fsyncSync(fd); this.leaseFault("lease-prepared");
      fs.linkSync(preparedPath, this.lockPath); linked = true; this.leaseFault("lease-linked");
      fs.unlinkSync(preparedPath); this.privateFiles.fsyncPrivateParent(this.paths.stateDir);
      this.lock = { fd, identity: fs.fstatSync(fd), token };
      this.#load();
      this.privateFiles.preparePrivateParent(path.join(this.receiptsDir, "probe"), this.paths.trustedRoot);
      this.receiptIdentity = fs.lstatSync(this.receiptsDir);
      this.opened = true;
    } catch (error) {
      if (this.lock) this.#releaseLock();
      else if (fd !== undefined) {
        fs.closeSync(fd);
        if (!linked && preparedIdentity && fs.existsSync(preparedPath)) {
          const current = fs.lstatSync(preparedPath);
          if (current.dev === preparedIdentity.dev && current.ino === preparedIdentity.ino && current.nlink === 1) fs.unlinkSync(preparedPath);
        }
      }
      if (error?.code === "EEXIST") P.fail("MEMORY_OWNER_CONFLICT");
      if (error?.code?.startsWith("MEMORY_OWNER_")) throw error;
      P.fail("MEMORY_OWNER_STORAGE_UNSAFE");
    }
    return this;
  }
  #assertNoArtifacts(target) {
    const parent = path.dirname(target), basename = path.basename(target);
    P.need(!fs.readdirSync(parent).some(name => name === `${basename}.tmp` || name.startsWith(`${basename}.backup-`)
      || name.startsWith(`${basename}.owner-write-`) && name.endsWith(".json")), "MEMORY_OWNER_RECOVERY_REQUIRED");
  }
  #load() {
    try {
      const bytes = this.privateFiles.readPrivateFile(this.file, { maxBytes: 1048576 });
      this.ledger = validateLedger(JSON.parse(bytes.toString("utf8"))); this.diskHash = hash(bytes);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.ledger = validateLedger({ version: 1, ledgerRevision: 0, catalogRevision: 0,
        idempotencyKey: crypto.randomBytes(32).toString("hex"), owners: {}, operations: {} }); this.diskHash = null;
    }
    this.diskIdentity = fs.existsSync(this.file) ? fs.lstatSync(this.file) : null;
  }
  // Every memory config read projects owner metadata through this check. Run
  // it once per turn for the current lock and ledger identity; a write here
  // installs a new identity/hash and so reruns it.
  #assertPhysical() {
    const key = JSON.stringify([this.parentIdentity?.dev, this.parentIdentity?.ino, this.lock?.identity.dev,
      this.lock?.identity.ino, this.lock?.token, this.diskHash, this.diskIdentity?.dev, this.diskIdentity?.ino]);
    this.#physicalChecks.get(key, () => { this.#assertPhysicalNow(); return true; });
  }
  #assertPhysicalNow() {
    const parent = this.privateFiles.validateDirectoryStat(fs.lstatSync(this.paths.stateDir), this.paths.stateDir);
    P.need(parent.dev === this.parentIdentity.dev && parent.ino === this.parentIdentity.ino, "MEMORY_OWNER_STORAGE_CHANGED");
    const locked = this.privateFiles.validatePrivateStat(fs.lstatSync(this.lockPath), this.lockPath);
    P.need(this.lock && locked.dev === this.lock.identity.dev && locked.ino === this.lock.identity.ino
      && fs.readFileSync(this.lockPath, "utf8") === this.lock.token, "MEMORY_OWNER_STORAGE_CHANGED");
    this.#assertNoArtifacts(this.file);
    if (this.diskHash === null) P.need(!fs.existsSync(this.file), "MEMORY_OWNER_STORAGE_CHANGED");
    else {
      const current = fs.lstatSync(this.file);
      P.need(current.dev === this.diskIdentity.dev && current.ino === this.diskIdentity.ino, "MEMORY_OWNER_STORAGE_CHANGED");
      P.need(hash(this.privateFiles.readPrivateFile(this.file, { maxBytes: 1048576 })) === this.diskHash, "MEMORY_OWNER_STORAGE_CHANGED");
    }
  }
  #check(assertion) {
    if (this.secretStore.commitUncertain === true && !this.poisoned) {
      this.#withdrawSecretAuthority({ code: "SECRET_COMMIT_UNCERTAIN" });
      // Synchronous metadata admission cannot await a physical join. Withdraw
      // now and retain the one retirement promise for async mutations/close.
      void this.#joinPoisonRetirement().catch(() => {});
    }
    P.need(this.opened && !this.closing && !this.poisoned && this.assertServiceCurrent() === true, "MEMORY_OWNER_RETIRED");
    if (assertion) P.need(assertion() === true, "MEMORY_OWNER_FORBIDDEN"); this.#assertPhysical();
  }
  #authorize(scope, context) {
    const authority = this.authorizeManagement(scope, context), assertion = authorities.get(authority);
    P.need(assertion, "MEMORY_OWNER_FORBIDDEN"); this.#check(assertion);
    if (scope.kind === "profile") P.need(this.assertProfileCurrent(scope.profileId) === true, "MEMORY_OWNER_FORBIDDEN");
    return () => { this.#check(assertion); if (scope.kind === "profile") P.need(this.assertProfileCurrent(scope.profileId) === true, "MEMORY_OWNER_FORBIDDEN"); return true; };
  }
  #persist(next, assertion) {
    this.#check(assertion); next.ledgerRevision = this.ledger.ledgerRevision + 1;
    const validated = validateLedger(next), bytes = Buffer.from(`${JSON.stringify(validated)}\n`);
    this.#checkContextCapacity(validated);
    P.need(bytes.length <= 1048576, "MEMORY_OWNER_CAPACITY");
    try { this.#writeOwned(this.file, bytes, this.diskIdentity); }
    catch (error) { this.poisoned = true; P.fail(error?.code === "PRIVATE_FILE_COMPARE_FAILED" ? "MEMORY_OWNER_STORAGE_CHANGED" : "MEMORY_OWNER_UNCERTAIN"); }
    this.ledger = validated; this.diskHash = hash(bytes); this.diskIdentity = fs.lstatSync(this.file);
  }
  #enqueue(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  #writeOwned(target, bytes, expectedIdentity) {
    const { proofPath, tempPath } = publishWriteProof(target, bytes, { paths: this.paths, privateFiles: this.privateFiles, owner: JSON.parse(this.lock.token) });
    let reservationPath = null;
    const trackedFs = new Proxy(fs, { get: (object, key) => key === "linkSync" ? (from, to) => {
      if (from === target && String(to).startsWith(`${target}.backup-`)) reservationPath = publishBackupReservation(proofPath, path.basename(to), this.privateFiles);
      return object.linkSync(from, to);
    } : object[key] });
    this.privateFiles.atomicWritePrivateFile(target, bytes, { trustedRoot: this.paths.trustedRoot, tempPath,
      fs: trackedFs, ...(expectedIdentity ? { expectedIdentity } : {}) });
    if (reservationPath) { this.privateFiles.validatePrivateStat(fs.lstatSync(reservationPath), reservationPath); fs.unlinkSync(reservationPath); }
    this.privateFiles.validatePrivateStat(fs.lstatSync(proofPath), proofPath); fs.unlinkSync(proofPath); this.privateFiles.fsyncPrivateParent(path.dirname(target));
  }
  #digest(request) { return crypto.createHmac("sha256", Buffer.from(this.ledger.idempotencyKey, "hex")).update(JSON.stringify(request)).digest("hex"); }
  #credential(ref, fingerprint = undefined) {
    const matches = this.secretStore.listMetadata().filter(entry => entry.credentialRef === ref);
    const actual = this.secretStore.getCredentialFingerprint(ref);
    P.need(matches.length === 1 && matches[0].kind === KIND && typeof actual === "string" && FP.test(actual)
      && (fingerprint === undefined || actual === fingerprint), "MEMORY_OWNER_CREDENTIAL_CHANGED"); return actual;
  }
  #publicSafe(request, effectiveMetadata) {
    const { secret, ...publicRequest } = request;
    const strings = [];
    const collect = value => { if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { strings.push(key); collect(child); } };
    collect(publicRequest); if (effectiveMetadata) collect(effectiveMetadata);
    if (secret !== undefined) {
      for (const row of Object.values(this.ledger.owners)) { collect(P.metadata(row)); collect(row.headers); }
      for (const operation of Object.values(this.ledger.operations)) collect(operation.request);
    }
    P.need(secret === undefined || !strings.some(value => value.includes(secret)), "MEMORY_OWNER_INVALID");
    P.need(this.secretStore.withPlaintextMatcher(matches => !strings.some(matches)) === true, "MEMORY_OWNER_INVALID");
  }
  context(value = {}, context) {
    const { profileId } = P.record(value, { profileId: P.id });
    const selected = profileId === undefined ? { kind: "global" } : { kind: "profile", profileId: P.id(profileId) };
    this.#authorize(selected, context);
    return P.validateResult(P.METHODS[0], this.#contextDTO(this.ledger, selected));
  }
  #contextDTO(ledger, selected) {
    return { catalogRevision: ledger.catalogRevision,
      owners: Object.values(ledger.owners).filter(row => row.scope.kind === "global" || selected.kind === "profile" && row.scope.profileId === selected.profileId).map(P.metadata),
      pendingOperations: Object.values(ledger.operations).filter(operation => !TERMINAL.has(operation.phase)
        && (operation.after.scope.kind === "global" || selected.kind === "profile" && operation.after.scope.profileId === selected.profileId))
        .map(operation => ({ operationId: operation.operationId, ownerRef: operation.ownerRef, phase: operation.phase })) };
  }
  #checkContextCapacity(next) {
    const anticipated = clone(next);
    for (const operation of Object.values(anticipated.operations)) if (!TERMINAL.has(operation.phase) && operation.outcome === "apply") anticipated.owners[operation.ownerRef] = operation.after;
    const budgeted = clone(next), futurePublishes = Object.values(next.operations).filter(operation => operation.outcome === "apply"
      && ["reserved", "credential_ready"].includes(operation.phase)).length;
    budgeted.catalogRevision += futurePublishes; anticipated.catalogRevision = budgeted.catalogRevision;
    // Reserve the longest pending DTO now, including digit growth, so an
    // accepted reservation can reach its remaining durable phases.
    for (const view of [budgeted, anticipated]) for (const operation of Object.values(view.operations)) if (!TERMINAL.has(operation.phase)) operation.phase = "credential_ready";
    const profiles = new Set(Object.values(anticipated.owners).filter(row => row.scope.kind === "profile").map(row => row.scope.profileId));
    try {
      P.validateResult(P.METHODS[0], this.#contextDTO(budgeted, { kind: "global" }));
      P.validateResult(P.METHODS[0], this.#contextDTO(anticipated, { kind: "global" }));
      for (const profileId of profiles) {
        P.validateResult(P.METHODS[0], this.#contextDTO(budgeted, { kind: "profile", profileId }));
        P.validateResult(P.METHODS[0], this.#contextDTO(anticipated, { kind: "profile", profileId }));
      }
    } catch { P.fail("MEMORY_OWNER_CAPACITY"); }
  }
  apply(value, context) {
    let request; try { request = P.mutation(value); } catch { return Promise.reject(Object.assign(new Error(P.PUBLIC_MESSAGES.MEMORY_OWNER_INVALID), { code: "MEMORY_OWNER_INVALID" })); }
    return this.#enqueue(async () => {
      try {
        this.#check();
        const existing = this.ledger.operations[request.operationId];
        if (existing) {
          const assertion = this.#authorize(existing.after.scope, context);
          P.need(this.#digest(request) === existing.requestDigest, "MEMORY_OWNER_CONFLICT");
          return await this.#advance(existing.operationId, assertion, request.secret);
        }
        const before = request.action === "create" ? null : this.ledger.owners[request.ownerRef];
        P.need(request.action === "create" || before, "MEMORY_OWNER_CONFLICT");
        const selectedScope = before?.scope || request.scope, assertion = this.#authorize(selectedScope, context);
        P.need(request.expectedCatalogRevision === this.ledger.catalogRevision
          && (before === null || before.revision === request.expectedOwnerRevision && before.status === "active"), "MEMORY_OWNER_CONFLICT");
        P.need(!Object.values(this.ledger.operations).some(operation => operation.ownerRef === before?.ownerRef && !TERMINAL.has(operation.phase)), "MEMORY_OWNER_RECOVERY_REQUIRED");
        P.need(Object.keys(this.ledger.operations).length < 1024 && (before || Object.keys(this.ledger.owners).length < 128), "MEMORY_OWNER_CAPACITY");
        this.#publicSafe(request);
        if (before?.credentialRef) this.#credential(before.credentialRef, before.credentialFingerprint);
        const preserving = request.secretAction === "preserve";
        P.need(!preserving || request.baseUrl === before.baseUrl, "MEMORY_OWNER_FORBIDDEN");
        const ownerRef = before?.ownerRef || `memory-owner-${this.randomUUID()}`; P.id(ownerRef);
        P.need(before || !this.ledger.owners[ownerRef] && !Object.values(this.ledger.operations).some(item => item.ownerRef === ownerRef), "MEMORY_OWNER_CONFLICT");
        const candidateRef = request.secretAction === "set" ? `${PREFIX}${this.randomUUID()}` : null;
        if (candidateRef) { credentialRef(candidateRef); P.need(this.secretStore.getCredentialFingerprint(candidateRef) === null
          && !Object.values(this.ledger.operations).some(operation => operation.candidateRef === candidateRef), "MEMORY_OWNER_CONFLICT"); }
        const time = this.now(); P.integer(time);
        const after = { ownerRef, label: request.label ?? before.label, scope: selectedScope,
          providerId: request.providerId ?? before.providerId, api: request.api ?? P.builtinApis[request.providerId] ?? before?.api,
          baseUrl: request.baseUrl ?? before.baseUrl, headers: request.headers ?? before?.headers ?? {},
          revision: (before?.revision ?? 0) + 1, status: request.action === "revoke" ? "revoked" : "active",
          credentialRef: preserving ? before.credentialRef : candidateRef, credentialKind: preserving ? before.credentialKind : candidateRef ? KIND : null,
          credentialFingerprint: preserving ? before.credentialFingerprint : null,
          createdAt: before?.createdAt ?? time, updatedAt: time, lastOperationId: request.operationId };
        this.#publicSafe(request, P.metadata(after)); this.#publicSafe(request, after.headers);
        const { secret, ...publicRequest } = request;
        const operation = { operationId: request.operationId, requestDigest: this.#digest(request), request: publicRequest,
          ownerRef, before, after, phase: "reserved", candidateRef, candidateFingerprint: null,
          cleanupRef: before?.credentialRef && !preserving ? before.credentialRef : null,
          cleanupFingerprint: before?.credentialRef && !preserving ? before.credentialFingerprint : null,
          publishedCatalogRevision: null, createdAt: time, outcome: "apply", receipt: null };
        const next = clone(this.ledger); next.operations[request.operationId] = operation; this.#persist(next, assertion);
        await this.#fault("catalog-reserved", operation); return await this.#advance(request.operationId, assertion, secret);
      } catch (error) { this.#withdrawSecretAuthority(error); await this.#joinPoisonRetirement(); throw this.#safeError(error); } finally { request = null; }
    });
  }
  #safeError(error) {
    const mapped = error?.code === "SECRET_COMMIT_UNCERTAIN" ? "MEMORY_OWNER_UNCERTAIN"
      : error?.code === "SECRET_REVISION_CONFLICT" ? "MEMORY_OWNER_CREDENTIAL_CHANGED"
        : error?.code === "credentials_locked" ? "MEMORY_OWNER_RECOVERY_REQUIRED"
          : Object.hasOwn(P.PUBLIC_MESSAGES, error?.code) ? error.code : "MEMORY_OWNER_RECOVERY_REQUIRED";
    const dto = P.publicError({ code: mapped }); return Object.assign(new Error(dto.message), { code: dto.code });
  }
  #withdrawSecretAuthority(error) {
    if (["SECRET_COMMIT_UNCERTAIN", "credentials_locked"].includes(error?.code) || this.secretStore.commitUncertain === true) {
      this.poisoned = true;
      this.lifetime.abort();
    }
  }
  async #joinPoisonRetirement() {
    if (!this.poisoned) return;
    if (!this.poisonRetirement) {
      this.lifetime.abort();
      this.poisonRetirement = Promise.resolve().then(() => this.retireOwners(frozen({ ownerRefs: Object.keys(this.ledger.owners),
        agentIds: this.getProfileIds().map(P.id), catalogRevision: this.ledger.catalogRevision, reason: "uncertain", signal: this.lifetime.signal })));
    }
    try { await this.poisonRetirement; } catch { P.fail("MEMORY_OWNER_RETIRE_FAILED"); }
  }
  async #fault(stage, operation) { await this.fault(stage, frozen({ operationId: operation.operationId, ownerRef: operation.ownerRef, phase: operation.phase })); }
  async #reassertCandidate(operation, secret, assertion) {
    P.need(typeof secret === "string" && this.#digest({ ...operation.request, secret }) === operation.requestDigest, "MEMORY_OWNER_RECOVERY_REQUIRED");
    const current = this.secretStore.getCredentialFingerprint(operation.candidateRef);
    if (current === null) {
      assertion(); await this.secretStore.putIfRevision(operation.candidateRef, secret, { kind: KIND }, null);
      await this.#fault("catalog-credential-put", operation); assertion();
    } else {
      const fingerprint = this.#credential(operation.candidateRef);
      const actual = await this.secretStore.get(operation.candidateRef); assertion();
      const a = Buffer.from(secret), b = typeof actual === "string" ? Buffer.from(actual) : Buffer.alloc(0);
      try { P.need(a.length === b.length && crypto.timingSafeEqual(a, b), "MEMORY_OWNER_CREDENTIAL_CHANGED"); }
      finally { a.fill(0); b.fill(0); }
      this.#credential(operation.candidateRef, fingerprint);
    }
    return this.#credential(operation.candidateRef);
  }
  async #advance(operationId, assertion, secret) {
    assertion(); let operation = this.ledger.operations[operationId];
    if (TERMINAL.has(operation.phase)) return this.#terminal(operation);
    if (operation.phase === "reserved") {
      const candidateFingerprint = operation.candidateRef ? await this.#reassertCandidate(operation, secret, assertion) : null;
      const next = clone(this.ledger), item = next.operations[operationId];
      item.candidateFingerprint = candidateFingerprint; item.after.credentialFingerprint = candidateFingerprint ?? item.after.credentialFingerprint;
      item.phase = "credential_ready"; this.#persist(next, assertion); operation = this.ledger.operations[operationId];
      await this.#fault("catalog-credential-ready", operation);
    }
    if (operation.phase === "credential_ready") {
      if (operation.candidateRef && operation.outcome === "apply") this.#credential(operation.candidateRef, operation.candidateFingerprint);
      const before = this.ledger.owners[operation.ownerRef] ?? null;
      P.need(equal(before, operation.before), "MEMORY_OWNER_CONFLICT");
      if (before?.credentialRef) this.#credential(before.credentialRef, before.credentialFingerprint);
      const next = clone(this.ledger), item = next.operations[operationId];
      if (item.outcome === "apply") { next.owners[item.ownerRef] = item.after; next.catalogRevision += 1; }
      item.publishedCatalogRevision = next.catalogRevision; item.phase = "published"; this.#persist(next, assertion);
      operation = this.ledger.operations[operationId]; await this.#fault("catalog-published", operation);
    }
    if (operation.phase === "published") {
      this.#assertAfter(operation);
      assertion(); const agentIds = this.#affectedProfiles(operation);
      try { await this.retireOwners(frozen({ ownerRefs: [operation.ownerRef], agentIds, catalogRevision: this.ledger.catalogRevision,
        reason: operation.outcome === "cancel" ? "cancel" : operation.request.action, signal: this.lifetime.signal })); }
      catch { P.fail("MEMORY_OWNER_RETIRE_FAILED"); }
      assertion(); this.#assertAfter(operation); const next = clone(this.ledger); next.operations[operationId].phase = "retired"; this.#persist(next, assertion);
      operation = this.ledger.operations[operationId]; await this.#fault("catalog-retired", operation);
    }
    if (operation.phase === "retired") {
      this.#assertAfter(operation);
      if (operation.cleanupRef) await this.#cleanup(operation, assertion);
      operation = this.ledger.operations[operationId]; this.#assertAfter(operation); await this.#fault("catalog-cleaned", operation);
      assertion(); this.#assertAfter(operation);
      const next = clone(this.ledger), item = next.operations[operationId];
      item.phase = item.outcome === "cancel" ? "cancelled" : "completed";
      item.receipt = { operationId, ownerRef: item.ownerRef, catalogRevision: item.publishedCatalogRevision,
        ownerRevision: item.after.revision, status: item.outcome === "cancel" ? "cancelled" : item.after.status, cleanupComplete: true };
      this.#persist(next, assertion); operation = this.ledger.operations[operationId]; await this.#fault("catalog-completed", operation);
    }
    return this.#terminal(operation);
  }
  #affectedProfiles(operation) {
    const profiles = this.getProfileIds(); P.need(Array.isArray(profiles) && profiles.length <= 256, "MEMORY_OWNER_FORBIDDEN");
    return Object.freeze(profiles.filter(agentId => {
      P.id(agentId); if (operation.after.scope.kind === "profile" && operation.after.scope.profileId !== agentId) return false;
      return Object.values(P.effectiveRefs(this.getConfig(agentId), agentId)).includes(operation.ownerRef);
    }));
  }
  #assertAfter(operation) {
    if (operation.outcome === "cancel") return;
    P.need(equal(this.ledger.owners[operation.ownerRef], operation.after), "MEMORY_OWNER_CONFLICT");
    if (operation.after.credentialRef) this.#credential(operation.after.credentialRef, operation.after.credentialFingerprint);
  }
  async #cleanup(operation, assertion) {
    const ref = operation.cleanupRef;
    P.need(!Object.values(this.ledger.owners).some(owner => owner.credentialRef === ref)
      && !Object.values(this.ledger.operations).some(item => item.operationId !== operation.operationId && !TERMINAL.has(item.phase)
        && (item.candidateRef === ref || item.cleanupRef === ref || item.before?.credentialRef === ref)), "MEMORY_OWNER_RECOVERY_REQUIRED");
    const fingerprint = this.secretStore.getCredentialFingerprint(ref);
    if (fingerprint !== null) {
      this.#credential(ref, operation.cleanupFingerprint);
      P.need(typeof this.secretStore.deleteIfFingerprint === "function", "MEMORY_OWNER_CLEANUP_PENDING");
      assertion();
      const retained = operation.outcome === "apply" && operation.after.credentialRef
        ? [{ credentialRef: operation.after.credentialRef, kind: KIND, fingerprint: operation.after.credentialFingerprint }] : [];
      try { await this.secretStore.deleteIfFingerprint(ref, { kind: KIND, fingerprint: operation.cleanupFingerprint, retained }); }
      catch (error) {
        if (["SECRET_COMMIT_UNCERTAIN", "credentials_locked"].includes(error?.code) || this.secretStore.commitUncertain === true) throw error;
        if (error?.code === "SECRET_REVISION_CONFLICT") P.fail("MEMORY_OWNER_CREDENTIAL_CHANGED"); P.fail("MEMORY_OWNER_CLEANUP_PENDING");
      }
      assertion(); P.need(this.secretStore.getCredentialFingerprint(ref) === null, "MEMORY_OWNER_CREDENTIAL_CHANGED");
    }
    const next = clone(this.ledger); next.operations[operation.operationId].cleanupRef = null;
    next.operations[operation.operationId].cleanupFingerprint = null; this.#persist(next, assertion);
  }
  #terminal(operation) {
    P.need(TERMINAL.has(operation.phase) && operation.receipt, "MEMORY_OWNER_RECOVERY_REQUIRED");
    const receiptPath = path.join(this.receiptsDir, `${hash(operation.operationId)}.json`), bytes = Buffer.from(`${JSON.stringify(operation.receipt)}\n`);
    const directory = this.privateFiles.validateDirectoryStat(fs.lstatSync(this.receiptsDir), this.receiptsDir);
    P.need(directory.dev === this.receiptIdentity.dev && directory.ino === this.receiptIdentity.ino, "MEMORY_OWNER_STORAGE_CHANGED");
    this.#assertNoArtifacts(receiptPath);
    if (fs.existsSync(receiptPath)) P.need(hash(this.privateFiles.readPrivateFile(receiptPath)) === hash(bytes), "MEMORY_OWNER_STORAGE_CHANGED");
    else this.#writeOwned(receiptPath, bytes, null);
    const current = this.ledger.owners[operation.ownerRef];
    if (operation.outcome === "apply" && current?.lastOperationId === operation.operationId) this.#assertAfter(operation);
    return P.validateResult(P.METHODS[1], { ...operation.receipt, phase: operation.phase,
      current: operation.outcome === "apply" && !!current && current.lastOperationId === operation.operationId && current.revision === operation.after.revision });
  }
  recover(value, context) {
    const request = P.recovery(value);
    return this.#enqueue(async () => {
      try {
        this.#check(); let operation = this.ledger.operations[request.operationId]; P.need(operation, "MEMORY_OWNER_RECOVERY_REQUIRED");
        const assertion = this.#authorize(operation.after.scope, context);
        if (request.mode === "resume") return await this.#advance(operation.operationId, assertion, request.secret);
        P.need(!["published", "retired", "completed"].includes(operation.phase), "MEMORY_OWNER_RECOVERY_REQUIRED");
        if (operation.phase === "cancelled") return this.#terminal(operation);
        if (operation.candidateRef && !operation.candidateFingerprint) {
          const current = this.secretStore.getCredentialFingerprint(operation.candidateRef);
          if (current !== null) {
            const fingerprint = await this.#reassertCandidate(operation, request.secret, assertion);
            const next = clone(this.ledger), item = next.operations[operation.operationId];
            item.candidateFingerprint = fingerprint; item.after.credentialFingerprint = fingerprint; this.#persist(next, assertion);
            operation = this.ledger.operations[operation.operationId];
          }
        }
        const next = clone(this.ledger), item = next.operations[operation.operationId];
        item.outcome = "cancel"; item.cleanupRef = item.candidateFingerprint ? item.candidateRef : null;
        item.cleanupFingerprint = item.candidateFingerprint; item.phase = "credential_ready"; this.#persist(next, assertion);
        return await this.#advance(operation.operationId, assertion, request.secret);
      } catch (error) { this.#withdrawSecretAuthority(error); await this.#joinPoisonRetirement(); throw this.#safeError(error); }
    });
  }
  resolveOwner({ agentId, providerId, ownerRef }) {
    this.#check(); P.id(agentId); P.id(providerId); P.id(ownerRef);
    P.need(this.assertProfileCurrent(agentId) === true && this.getProfileIds().includes(agentId), "MEMORY_OWNER_FORBIDDEN");
    P.need(P.effectiveRefs(this.getConfig(agentId), agentId)[providerId] === ownerRef, "MEMORY_OWNER_FORBIDDEN");
    const row = this.ledger.owners[ownerRef]; if (!row || row.status === "revoked") return null;
    P.need(row.providerId === providerId && (row.scope.kind === "global" || row.scope.profileId === agentId), "MEMORY_OWNER_FORBIDDEN");
    if (row.credentialRef) this.#credential(row.credentialRef, row.credentialFingerprint);
    return frozen({ ownerRef, profileId: agentId, providerId, baseUrl: row.baseUrl, revision: row.revision,
      credentialRef: row.credentialRef, credentialKind: row.credentialKind, headers: row.headers });
  }
  projectProviderMetadata(agentId, cfg = this.getConfig(agentId)) {
    this.#check(); P.need(this.assertProfileCurrent(agentId) === true, "MEMORY_OWNER_FORBIDDEN");
    cfg = P.capture(cfg);
    const refs = P.effectiveRefs(cfg, agentId), models = P.ownValue(cfg, "models") ?? {}, providers = P.ownValue(models, "providers") ?? {};
    const projected = { ...providers };
    for (const [providerId, ownerRef] of Object.entries(refs)) {
      const view = this.resolveOwner({ agentId, providerId, ownerRef }); if (!view) continue;
      const row = this.ledger.owners[ownerRef]; P.need(providerId !== "llama-cpp", "MEMORY_OWNER_FORBIDDEN");
      projected[providerId] = { api: row.api, baseUrl: row.baseUrl };
    }
    return frozen(clone({ ...cfg, models: { ...models, providers: projected } }));
  }
  #releaseLock() {
    const lock = this.lock; if (!lock) return;
    let failure;
    try { const current = fs.lstatSync(this.lockPath);
      P.need(current.dev === lock.identity.dev && current.ino === lock.identity.ino && fs.readFileSync(this.lockPath, "utf8") === lock.token,
        "MEMORY_OWNER_STORAGE_CHANGED"); fs.unlinkSync(this.lockPath); this.privateFiles.fsyncPrivateParent(this.paths.stateDir); }
    catch (error) { failure = error; }
    finally { fs.closeSync(lock.fd); this.lock = null; }
    if (failure) throw failure;
  }
  close() {
    if (!this.closePromise) {
      this.closing = true; this.lifetime.abort();
      this.closePromise = (async () => {
        await this.queue; let failure;
        try { await this.#joinPoisonRetirement(); } catch (error) { failure = error; }
        this.opened = false; this.#releaseLock(); if (failure) throw failure;
      })();
    }
    return this.closePromise;
  }
}
module.exports = { MemoryProviderOwnerController, createMemoryOwnerManagementAuthority, createMemoryOwnerStoppedLeaseAuthority,
  recoverStoppedMemoryOwnerCatalogLock, recoverStoppedMemoryOwnerCatalogFiles, validateLedger, PREFIX, KIND };
