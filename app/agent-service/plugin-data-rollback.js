"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDirectoryTree, assertPrivateDirectory, serviceError } = require("./security");
const { previewPluginDirectory } = require("./plugin-package-parser");

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 32768;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (code = "PLUGIN_DATA_CHANGED") => { throw serviceError(code, "插件数据维护未完成；保持停用并核对同一操作回执"); };
const isId = value => typeof value === "string" && ID.test(value);
const isHash = value => typeof value === "string" && HASH.test(value);
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const statOrNull = target => { try { return fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
function syncDirectory(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function owned(stat) {
  if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && stat.nlink !== 1) || (stat.mode & 0o7000)
    || (process.getuid && stat.uid !== process.getuid())) fail("PLUGIN_DATA_PATH_INVALID");
}
function readFile(target, expected) {
  const before = fs.lstatSync(target); owned(before);
  if (!before.isFile() || before.size > MAX_FILE_BYTES) fail("PLUGIN_DATA_LIMIT");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameStat(before, fs.fstatSync(fd))) fail();
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== before.size || !sameStat(before, fs.lstatSync(target))
      || (expected && (expected.size !== bytes.length || expected.sha256 !== sha(bytes)
        || expected.mode !== (before.mode & 0o777)))) fail();
    return bytes;
  } finally { fs.closeSync(fd); }
}
function scanTree(root) {
  const entries = [];
  let byteLength = 0;
  const rootStat = statOrNull(root);
  if (rootStat && !rootStat.isDirectory()) fail("PLUGIN_DATA_PATH_INVALID");
  function visit(relative, depth) {
    if (depth > 16 || entries.length >= MAX_ENTRIES) fail("PLUGIN_DATA_LIMIT");
    const absolute = relative ? path.join(root, ...relative.split("/")) : root;
    const before = fs.lstatSync(absolute); owned(before);
    if (before.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: before.mode & 0o777 });
      const children = fs.readdirSync(absolute).sort();
      for (const child of children) {
        if (!child.isWellFormed() || /[\\\x00-\x1f\x7f]/u.test(child)
          || child === "." || child === ".." || Buffer.byteLength(child) > 255) fail("PLUGIN_DATA_PATH_INVALID");
        visit(relative ? `${relative}/${child}` : child, depth + 1);
      }
      if (!sameStat(before, fs.lstatSync(absolute))) fail();
    } else {
      if (before.size > MAX_FILE_BYTES || byteLength + before.size > MAX_BYTES) fail("PLUGIN_DATA_LIMIT");
      const bytes = readFile(absolute);
      byteLength += bytes.length;
      entries.push({ path: relative, type: "file", mode: before.mode & 0o777,
        size: bytes.length, sha256: sha(bytes) });
    }
  }
  if (rootStat) visit("", 0);
  return { exists: rootStat !== null, entries, byteLength,
    fileCount: entries.filter(entry => entry.type === "file").length,
    digest: sha(JSON.stringify({ exists: rootStat !== null, entries })) };
}
function writeFile(target, bytes, mode = 0o600) {
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function completeStagedFile(target, bytes, mode) {
  const stat = statOrNull(target);
  if (!stat) { writeFile(target, bytes, mode); return; }
  const existing = readFile(target);
  if (existing.length > bytes.length || !existing.equals(bytes.subarray(0, existing.length))) fail("PLUGIN_DATA_STAGING_UNRESOLVED");
  if (existing.length === bytes.length && (stat.mode & 0o777) === mode) return;
  // Only a verified prefix in this operation's private staging copy can be
  // completed after a power loss. Published snapshots and retained data never
  // use this helper; unexpected bytes stay untouched and fenced.
  const fd = fs.openSync(target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameStat(stat, fs.fstatSync(fd))) fail();
    fs.writeFileSync(fd, bytes); fs.ftruncateSync(fd, bytes.length); fs.fchmodSync(fd, mode); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function copyTree(source, destination, expected) {
  if (scanTree(source).digest !== expected.digest) fail();
  const current = scanTree(destination);
  if (current.exists) for (const entry of current.entries) {
    if (!expected.entries.some(value => value.path === entry.path && value.type === entry.type)) fail("PLUGIN_DATA_STAGING_UNRESOLVED");
  }
  if (!expected.exists) return;
  const directories = [];
  for (const entry of expected.entries) {
    const target = entry.path ? path.join(destination, ...entry.path.split("/")) : destination;
    if (entry.type === "directory") {
      if (!statOrNull(target)) fs.mkdirSync(target, { mode: 0o700 });
      directories.push([target, entry.mode]);
    } else completeStagedFile(target, readFile(path.join(source, ...entry.path.split("/")), entry), entry.mode);
  }
  for (const [directory, mode] of directories.reverse()) { fs.chmodSync(directory, mode); syncDirectory(directory); }
  if (scanTree(source).digest !== expected.digest || scanTree(destination).digest !== expected.digest) fail();
}
function reserveCapacity(root, additionalBytes, additionalEntries) {
  let bytes = 0, entries = 0;
  const pending = [root];
  while (pending.length) {
    const item = pending.pop();
    const stat = fs.lstatSync(item); owned(stat);
    if (++entries + additionalEntries > MAX_ARCHIVE_ENTRIES) fail("PLUGIN_DATA_LIMIT");
    if (stat.isDirectory()) for (const name of fs.readdirSync(item)) pending.push(path.join(item, name));
    else bytes += stat.size;
    if (bytes + additionalBytes > MAX_ARCHIVE_BYTES) fail("PLUGIN_DATA_LIMIT");
  }
}
function addDigest(value) { return { ...value, previewDigest: sha(JSON.stringify(value)) }; }
function checkPreview(preview, fields) {
  if (!preview || Object.getPrototypeOf(preview) !== Object.prototype
    || Object.keys(preview).length !== fields.length + 1 || !isHash(preview.previewDigest)
    || fields.some(field => !Object.hasOwn(preview, field))) fail("PLUGIN_OPERATION_INVALID");
  const pinned = Object.fromEntries(fields.map(field => [field, preview[field]]));
  if (sha(JSON.stringify(pinned)) !== preview.previewDigest) fail("PLUGIN_DATA_PREVIEW_CHANGED");
  return pinned;
}
const BASE_FIELDS = ["installationId", "expectedRevision", "sourceIdentity", "fromDigest", "authorityIncarnation"];
const CODE_FIELDS = [...BASE_FIELDS, "targetDigest", "currentDataDigest", "dataState"];
const RESTORE_FIELDS = [...BASE_FIELDS, "snapshotId", "snapshotDigest", "snapshotReleaseDigest", "snapshotDataDigest",
  "currentDataDigest", "currentByteLength", "snapshotByteLength", "rollbackOperationId", "dataLossRequired"];

// Only a Service-owned instance may call this core. drainInstallation must be
// the live pool's exclusive drain, not a caller assertion. The existing Service
// single-writer lock is still required. No package code is executed here.
class PluginDataRollback {
  constructor({ store, drainInstallation, onPhase = null } = {}) {
    if (typeof store?.beginInstallationMaintenance !== "function" || typeof drainInstallation !== "function") {
      throw new TypeError("PluginDataRollback requires PluginStore and an exclusive pool drain");
    }
    this.store = store;
    this.paths = store.paths;
    this.root = this.paths.pluginRollbackDir || path.join(this.paths.pluginsDir, "rollback");
    if (!["rollback", "plugin-rollback"].some(name => path.resolve(this.root) === path.join(path.resolve(this.paths.pluginsDir), name))) {
      throw new TypeError("Plugin rollback storage must remain under the private plugin root");
    }
    this.drainInstallation = drainInstallation;
    this.onPhase = onPhase;
  }

  _roots() {
    for (const root of [this.paths.pluginDataDir, this.root, path.join(this.root, "snapshots"),
      path.join(this.root, "replaced"), path.join(this.root, "staging")]) {
      ensurePrivateDirectoryTree(root, this.paths.trustedRoot);
      assertPrivateDirectory(root);
    }
  }
  _dataPath(installationId) { if (!isId(installationId)) fail("PLUGIN_OPERATION_INVALID"); return path.join(this.paths.pluginDataDir, installationId); }
  _pin({ installationId, expectedRevision }) {
    if (!isId(installationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("PLUGIN_OPERATION_INVALID");
    const current = this.store.getInstallation(installationId);
    if (!current || current.revision !== expectedRevision) fail("REVISION_CONFLICT");
    return { installationId, expectedRevision, sourceIdentity: current.sourceIdentity,
      fromDigest: current.releaseDigest, authorityIncarnation: this.store.getAuthorityIncarnation() };
  }
  _package(pin, digest) {
    if (!isHash(digest) || !this.store.getRelease(pin.sourceIdentity, digest)) fail("PLUGIN_RELEASE_INVALID");
    const root = path.join(this.paths.pluginPackagesDir, digest);
    for (const directory of [this.paths.pluginsDir, this.paths.pluginPackagesDir, root]) assertPrivateDirectory(directory);
    const value = previewPluginDirectory(fs.realpathSync(root));
    if (!value.installable || value.contentDigest !== digest) fail("PACKAGE_CHANGED");
  }
  _existing(operationId, kind, fingerprint) {
    if (!isId(operationId)) fail("PLUGIN_OPERATION_INVALID");
    const operation = this.store.getOperation(operationId);
    if (!operation) return null;
    // begin also verifies the private fingerprint and outcome_unknown barrier.
    return this.store.beginInstallationMaintenance({ operationId, fingerprint, kind,
      request: operation.result?.request || {} });
  }
  async _drained(pin, allowed = []) {
    this.store.assertInstallationMaintenance(pin, allowed);
    await this.drainInstallation(pin.installationId);
    this.store.assertInstallationMaintenance(pin, allowed);
    this._roots();
  }
  _snapshot(snapshotId, snapshotDigest) {
    if (!isHash(snapshotId) || !isHash(snapshotDigest)) fail("PLUGIN_DATA_SNAPSHOT_INVALID");
    this._roots();
    const directory = path.join(this.root, "snapshots", snapshotId);
    assertPrivateDirectory(directory);
    const bytes = readFile(path.join(directory, "manifest.json"));
    if (bytes.length > 1024 * 1024 || sha(bytes) !== snapshotDigest) fail("PLUGIN_DATA_SNAPSHOT_CHANGED");
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("PLUGIN_DATA_SNAPSHOT_CHANGED"); }
    const data = scanTree(path.join(directory, "data"));
    if (manifest.version !== 1 || manifest.snapshotId !== snapshotId
      || manifest.authorityIncarnation !== this.store.getAuthorityIncarnation()
      || data.digest !== manifest.data?.digest || data.byteLength !== manifest.data?.byteLength
      || JSON.stringify(data) !== JSON.stringify(manifest.data)) fail("PLUGIN_DATA_SNAPSHOT_CHANGED");
    return { manifest, data, directory };
  }

  list({ installationId } = {}) {
    if (!isId(installationId)) fail("PLUGIN_OPERATION_INVALID");
    const installation = this.store.getInstallation(installationId);
    if (!installation || installation.desiredState === "uninstalled") fail("PLUGIN_INSTALLATION_INVALID");
    this._roots();
    const releases = this.store.listReleasesForInstallation(installationId);
    if (releases.length > 64) fail("PLUGIN_DATA_LIMIT");
    const snapshots = [];
    let unavailableSnapshots = 0;
    const ids = fs.readdirSync(path.join(this.root, "snapshots"));
    if (ids.length > 128) fail("PLUGIN_DATA_LIMIT");
    for (const snapshotId of ids.sort()) {
      if (!isHash(snapshotId)) fail("PLUGIN_DATA_SNAPSHOT_CHANGED");
      const directory = path.join(this.root, "snapshots", snapshotId);
      assertPrivateDirectory(directory);
      const bytes = readFile(path.join(directory, "manifest.json"));
      let manifest;
      try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("PLUGIN_DATA_SNAPSHOT_CHANGED"); }
      if (manifest.installationId !== installationId) continue;
      if (manifest.authorityIncarnation !== this.store.getAuthorityIncarnation()) { unavailableSnapshots++; continue; }
      const snapshotDigest = sha(bytes);
      const snapshot = this._snapshot(snapshotId, snapshotDigest);
      if (snapshot.manifest.sourceIdentity !== installation.sourceIdentity) fail("PLUGIN_DATA_SNAPSHOT_CHANGED");
      snapshots.push({ snapshotId, snapshotDigest, releaseDigest: manifest.releaseDigest,
        byteLength: manifest.data.byteLength, createdAt: manifest.createdAt });
    }
    return { installationId, revision: installation.revision, desiredState: installation.desiredState,
      codeDigest: installation.releaseDigest, releases, snapshots, unavailableSnapshots,
      pending: this.store.listInstallationMaintenance(installationId).map(operation => ({
        operationId: operation.operationId, action: ({ "data-snapshot": "snapshot", "code-rollback": "code", "data-restore": "restore" })[operation.kind] || "other",
        phase: operation.phase, state: operation.result?.receipt?.dataState || null })) };
  }

  async createSnapshot({ installationId, expectedRevision, operationId } = {}) {
    const fingerprint = sha(JSON.stringify(["data-snapshot", installationId, expectedRevision]));
    const existing = this._existing(operationId, "data-snapshot", fingerprint);
    if (existing?.result?.receipt) return existing.result.receipt;
    const pin = existing?.result?.request || this._pin({ installationId, expectedRevision });
    const operation = this.store.beginInstallationMaintenance({ operationId, fingerprint, kind: "data-snapshot", request: pin });
    await this._drained(pin, [operationId]);
    this._package(pin, pin.fromDigest);
    const snapshotId = sha(JSON.stringify([pin.authorityIncarnation, operationId]));
    const directory = path.join(this.root, "snapshots", snapshotId);
    const staging = path.join(this.root, "staging", snapshotId);
    let manifest, snapshotDigest;
    if (statOrNull(directory)) {
      const bytes = readFile(path.join(directory, "manifest.json"));
      snapshotDigest = sha(bytes);
      ({ manifest } = this._snapshot(snapshotId, snapshotDigest));
      if (manifest.installationId !== pin.installationId || manifest.sourceIdentity !== pin.sourceIdentity
        || manifest.releaseDigest !== pin.fromDigest || scanTree(this._dataPath(installationId)).digest !== manifest.data.digest) fail();
    } else {
      const data = scanTree(this._dataPath(installationId));
      manifest = { version: 1, snapshotId, installationId, sourceIdentity: pin.sourceIdentity,
        releaseDigest: pin.fromDigest, authorityIncarnation: pin.authorityIncarnation, createdAt: operation.createdAt, data };
      const bytes = Buffer.from(JSON.stringify(manifest)); snapshotDigest = sha(bytes);
      if (statOrNull(staging)) {
        assertPrivateDirectory(staging);
        const partial = scanTree(path.join(staging, "data"));
        reserveCapacity(this.root, Math.max(0, data.byteLength - partial.byteLength) + bytes.length,
          Math.max(0, data.entries.length - partial.entries.length) + 1);
        copyTree(this._dataPath(installationId), path.join(staging, "data"), data);
        completeStagedFile(path.join(staging, "manifest.json"), bytes, 0o600);
      } else {
        reserveCapacity(this.root, data.byteLength + bytes.length, data.entries.length + 2);
        fs.mkdirSync(staging, { mode: 0o700 });
        copyTree(this._dataPath(installationId), path.join(staging, "data"), data);
        writeFile(path.join(staging, "manifest.json"), bytes);
      }
      syncDirectory(staging);
      this.store.assertInstallationMaintenance(pin, [operationId]);
      if (scanTree(this._dataPath(installationId)).digest !== data.digest) fail();
      fs.renameSync(staging, directory); syncDirectory(path.dirname(directory));
      this.onPhase?.("snapshot-published", { operationId });
    }
    return this.store.finishInstallationMaintenance({ operationId, fingerprint, receipt: {
      snapshotId, snapshotDigest, sourceIdentity: pin.sourceIdentity, releaseDigest: pin.fromDigest,
      authorityIncarnation: pin.authorityIncarnation, createdAt: manifest.createdAt,
      dataDigest: manifest.data.digest, byteLength: manifest.data.byteLength, fileCount: manifest.data.fileCount,
      dataState: "snapshot_preserved", credentialsIncluded: false } });
  }

  async previewCodeRollback({ installationId, expectedRevision, targetDigest } = {}) {
    const pin = this._pin({ installationId, expectedRevision });
    await this._drained(pin);
    if (targetDigest === pin.fromDigest) fail("PLUGIN_RELEASE_INVALID");
    this._package(pin, pin.fromDigest); this._package(pin, targetDigest);
    if (!this.list({ installationId }).snapshots.some(snapshot => snapshot.releaseDigest === targetDigest)) {
      fail("PLUGIN_ROLLBACK_SNAPSHOT_REQUIRED");
    }
    return addDigest({ ...pin, targetDigest, currentDataDigest: scanTree(this._dataPath(installationId)).digest,
      dataState: "rollback_requires_data_restore" });
  }
  async rollbackCode({ preview, operationId } = {}) {
    const pin = checkPreview(preview, CODE_FIELDS);
    if (!isHash(pin.currentDataDigest) || pin.dataState !== "rollback_requires_data_restore") fail("PLUGIN_OPERATION_INVALID");
    const fingerprint = sha(JSON.stringify(["code-rollback", preview.previewDigest]));
    const existing = this._existing(operationId, "code-rollback", fingerprint);
    if (existing?.result?.receipt) return existing.result.receipt;
    await this._drained(pin, existing ? [operationId] : []);
    this._package(pin, pin.fromDigest); this._package(pin, pin.targetDigest);
    if (!this.list({ installationId: pin.installationId }).snapshots.some(snapshot => snapshot.releaseDigest === pin.targetDigest)) {
      fail("PLUGIN_ROLLBACK_SNAPSHOT_REQUIRED");
    }
    if (scanTree(this._dataPath(pin.installationId)).digest !== pin.currentDataDigest) fail();
    this.store.beginInstallationMaintenance({ operationId, fingerprint, kind: "code-rollback", request: pin });
    const result = this.store.finishInstallationMaintenance({ operationId, fingerprint, receipt: {
      fromDigest: pin.fromDigest, targetDigest: pin.targetDigest, sourceIdentity: pin.sourceIdentity,
      codeState: "rolled_back_disabled", dataState: "rollback_requires_data_restore",
      retainedDataDigest: pin.currentDataDigest, dataChanged: false } });
    this.onPhase?.("code-rollback-committed", { operationId });
    return result;
  }

  async previewDataRestore({ installationId, expectedRevision, snapshotId, snapshotDigest } = {}) {
    const pin = this._pin({ installationId, expectedRevision });
    const fences = this.store.listInstallationMaintenance(installationId);
    const rollback = fences.length === 1 && fences[0].kind === "code-rollback" && fences[0].phase === "committed"
      && fences[0].result?.receipt?.targetDigest === pin.fromDigest
      && fences[0].result?.receipt?.dataState === "rollback_requires_data_restore" ? fences[0] : null;
    await this._drained(pin, rollback ? [rollback.operationId] : []);
    this._package(pin, pin.fromDigest);
    const snapshot = this._snapshot(snapshotId, snapshotDigest);
    if (snapshot.manifest.installationId !== installationId || snapshot.manifest.sourceIdentity !== pin.sourceIdentity
      || snapshot.manifest.releaseDigest !== pin.fromDigest) fail("PLUGIN_DATA_SNAPSHOT_WRONG_RELEASE");
    const current = scanTree(this._dataPath(installationId));
    return addDigest({ ...pin, snapshotId, snapshotDigest, snapshotReleaseDigest: snapshot.manifest.releaseDigest,
      snapshotDataDigest: snapshot.data.digest, currentDataDigest: current.digest,
      currentByteLength: current.byteLength, snapshotByteLength: snapshot.data.byteLength,
      rollbackOperationId: rollback?.operationId || null, dataLossRequired: current.digest !== snapshot.data.digest });
  }

  async restoreData({ preview, operationId, approvedDataLoss = false } = {}) {
    const pin = checkPreview(preview, RESTORE_FIELDS);
    if (!isHash(pin.currentDataDigest) || !isHash(pin.snapshotDataDigest) || pin.snapshotReleaseDigest !== pin.fromDigest
      || typeof pin.dataLossRequired !== "boolean" || (pin.dataLossRequired && approvedDataLoss !== true)) {
      fail("PLUGIN_DATA_RESTORE_CONFIRMATION_REQUIRED");
    }
    const fingerprint = sha(JSON.stringify(["data-restore", preview.previewDigest]));
    const existing = this._existing(operationId, "data-restore", fingerprint);
    if (existing?.result?.receipt) return existing.result.receipt;
    const allowed = [operationId, ...(pin.rollbackOperationId ? [pin.rollbackOperationId] : [])];
    await this._drained(pin, existing ? allowed : allowed.filter(id => id !== operationId));
    this._package(pin, pin.fromDigest);
    const snapshot = this._snapshot(pin.snapshotId, pin.snapshotDigest);
    if (snapshot.manifest.installationId !== pin.installationId || snapshot.manifest.sourceIdentity !== pin.sourceIdentity
      || snapshot.manifest.releaseDigest !== pin.fromDigest || snapshot.data.digest !== pin.snapshotDataDigest) {
      fail("PLUGIN_DATA_SNAPSHOT_WRONG_RELEASE");
    }
    if (!existing && scanTree(this._dataPath(pin.installationId)).digest !== pin.currentDataDigest) fail();
    const op = this.store.beginInstallationMaintenance({ operationId, fingerprint, kind: "data-restore", request: pin });
    const transactionId = sha(JSON.stringify([pin.authorityIncarnation, operationId]));
    const staging = path.join(this.root, "staging", transactionId);
    const retained = path.join(this.root, "replaced", transactionId);
    const active = this._dataPath(pin.installationId);
    let progress = op.result.progress;
    if (!progress) {
      if (scanTree(active).digest !== pin.currentDataDigest || statOrNull(retained)) fail();
      if (statOrNull(staging)) {
        const partial = scanTree(staging);
        reserveCapacity(this.root, Math.max(0, snapshot.data.byteLength - partial.byteLength) + pin.currentByteLength,
          Math.max(0, snapshot.data.entries.length - partial.entries.length) + scanTree(active).entries.length + 2);
        copyTree(path.join(snapshot.directory, "data"), staging, snapshot.data);
      } else {
        reserveCapacity(this.root, snapshot.data.byteLength + pin.currentByteLength,
          snapshot.data.entries.length + scanTree(active).entries.length + 2);
        copyTree(path.join(snapshot.directory, "data"), staging, snapshot.data);
      }
      this.store.setInstallationMaintenanceProgress({ operationId, fingerprint, progress: "restore-staged" });
      progress = "restore-staged";
      this.onPhase?.("restore-staged", { operationId });
    }
    if (progress === "restore-staged") {
      if (scanTree(active).digest !== pin.currentDataDigest || scanTree(staging).digest !== snapshot.data.digest) fail();
      this.store.setInstallationMaintenanceProgress({ operationId, fingerprint, progress: "restore-swapping" });
      progress = "restore-swapping";
    }
    if (progress !== "restore-swapping") fail("PLUGIN_DATA_STAGING_UNRESOLVED");
    this.store.assertInstallationMaintenance(pin, allowed);
    // Exactly two names may change. The former data remains under replaced/;
    // no user directory, snapshot, receipt or uncertain call is deleted.
    if (!statOrNull(retained)) {
      if (scanTree(active).digest !== pin.currentDataDigest) fail();
      if (statOrNull(active)) fs.renameSync(active, retained);
      else { fs.mkdirSync(retained, { mode: 0o700 }); writeFile(path.join(retained, ".absent-data"), Buffer.from(pin.currentDataDigest)); }
      syncDirectory(path.dirname(active)); syncDirectory(path.dirname(retained));
      this.onPhase?.("restore-old-retained", { operationId });
    } else {
      const absent = path.join(retained, ".absent-data");
      const retainedDigest = statOrNull(absent) && fs.readdirSync(retained).length === 1
        ? readFile(absent).toString("utf8") : scanTree(retained).digest;
      if (retainedDigest !== pin.currentDataDigest) fail();
    }
    if (!statOrNull(active)) {
      if (snapshot.data.exists) {
        if (scanTree(staging).digest !== snapshot.data.digest) fail();
        fs.renameSync(staging, active); syncDirectory(path.dirname(active)); syncDirectory(path.dirname(staging));
      }
      this.onPhase?.("restore-data-published", { operationId });
    }
    if (scanTree(active).digest !== snapshot.data.digest) fail();
    return this.store.finishInstallationMaintenance({ operationId, fingerprint, receipt: {
      snapshotId: pin.snapshotId, snapshotDigest: pin.snapshotDigest, releaseDigest: pin.fromDigest,
      sourceIdentity: pin.sourceIdentity, dataState: "restored_from_snapshot", restoredDataDigest: snapshot.data.digest,
      replacedDataDigest: pin.currentDataDigest, retainedDataId: transactionId,
      dataLossAcknowledged: approvedDataLoss === true, rollbackOperationId: pin.rollbackOperationId } });
  }
}

module.exports = { PluginDataRollback, PLUGIN_ROLLBACK_LIMITS: Object.freeze({ maxBytes: MAX_BYTES,
  maxFileBytes: MAX_FILE_BYTES, maxEntries: MAX_ENTRIES, maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES }) };
