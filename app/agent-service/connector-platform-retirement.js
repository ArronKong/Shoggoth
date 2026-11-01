"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWritePrivateFile, openExistingPrivateFile, preparePrivateParent,
  readPrivateFile, recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { serviceError, assertPrivateDirectory } = require("./security");

// An evidence marker, never an importer. Old packages, credentials, audit
// journals and active-memory remain opaque bytes. No legacy SQLite is opened.
const BASENAMES = ["catalog.sqlite", "external-selection-dispatch.sqlite",
  "external-provenance.sqlite", "external-approval-journal.sqlite"];
const SNAPSHOT_GENERATION = "open-connector-platform-v1";
function invalid() { return serviceError("CONNECTOR_RETIREMENT_INVALID", "旧插件保留凭证无法验证"); }
function snapshotFailed() { return serviceError("CONNECTOR_UPGRADE_SNAPSHOT_FAILED", "升级前快照未完成或无法验证，已保留原数据；请检查可用空间及备份状态后重启"); }
function fileEvidence(target) {
  if (!statIfExists(fs, target)) return null;
  const fd = openExistingPrivateFile(target, fs.constants.O_RDONLY);
  try {
    const before = fs.fstatSync(fd), hash = crypto.createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > 1024 ** 3) throw invalid();
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (count <= 0) throw invalid();
      hash.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(target);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key] || before[key] !== current[key])) throw invalid();
    return { bytes: before.size, sha256: hash.digest("hex") };
  } finally { fs.closeSync(fd); }
}
function validateSnapshotReference(reference) {
  if (!reference || Object.keys(reference).sort().join(",") !== "backupId,checksum,generationId,rootDigest"
    || reference.generationId !== SNAPSHOT_GENERATION || reference.backupId !== `upgrade-${SNAPSHOT_GENERATION}`
    || !/^[a-f0-9]{64}$/u.test(reference.rootDigest) || !/^[a-f0-9]{64}$/u.test(reference.checksum)) throw snapshotFailed();
}
function hasLegacyPayload(paths, files) {
  if (files.length) return true;
  const root = paths.pluginsDir || path.join(paths.stateDir, "plugins");
  // active-memory is deliberately absent: it belongs to independent memory.
  for (const name of ["packages", "data", "staging", "plugin-rollback"]) {
    const target = path.join(root, name), stat = statIfExists(fs, target);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length)) return true;
  }
  return Boolean(statIfExists(fs, path.join(root, "oauth-providers.json")));
}
function markLegacyPluginPlatformRetired(paths, options = {}) {
  const target = path.join(paths.connectorsDir || path.join(paths.stateDir, "connectors"), "legacy-platform-retired-v1.json");
  const legacyRoot = paths.pluginsDir || path.join(paths.stateDir, "plugins");
  if (statIfExists(fs, legacyRoot)) {
    try { assertPrivateDirectory(legacyRoot); } catch { throw invalid(); }
  }
  preparePrivateParent(target, paths.trustedRoot);
  if (recoverInterruptedPrivateFile(target, { trustedRoot: paths.trustedRoot }) === "uncertain") throw invalid();
  if (statIfExists(fs, target)) {
    let receipt;
    try { receipt = JSON.parse(readPrivateFile(target, { maxBytes: 16 * 1024 })); } catch { throw invalid(); }
    if (receipt?.version === 1) throw snapshotFailed();
    if (receipt?.version !== 2 || Object.keys(receipt).sort().join(",") !== "files,legacyDataPreserved,legacyExecution,platform,recordedAt,upgradeSnapshot,version"
      || !Number.isSafeInteger(receipt.recordedAt) || receipt.recordedAt < 0
      || receipt.platform !== "open-connector" || receipt.legacyExecution !== false
      || receipt.legacyDataPreserved !== true || !Array.isArray(receipt.files) || receipt.files.length > 12
      || receipt.files.some(file => !BASENAMES.some(name => file.path === `plugins/${name}`
        || file.path === `plugins/${name}-wal` || file.path === `plugins/${name}-shm`)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw invalid();
    // This is a committed cutover receipt. Its snapshot was fully verified
    // before this atomic write. The archive is not an execution dependency:
    // ordinary authority restores do not recursively copy prior backup sets.
    // Any later attempt to restore the archive verifies its payload again.
    if (receipt.upgradeSnapshot !== null) validateSnapshotReference(receipt.upgradeSnapshot);
    else if (hasLegacyPayload(paths, receipt.files)) throw snapshotFailed();
    return receipt;
  }
  const files = [];
  for (const name of BASENAMES) for (const suffix of ["", "-wal", "-shm"]) {
    const relative = `plugins/${name}${suffix}`, evidence = fileEvidence(path.join(paths.stateDir, relative));
    if (evidence) files.push({ path: relative, ...evidence });
  }
  let upgradeSnapshot = null;
  if (hasLegacyPayload(paths, files)) {
    try {
      const snapshot = require("./upgrade-snapshot").createUpgradeSnapshot({ paths,
        generationId: SNAPSHOT_GENERATION, activeServiceLock: options.activeServiceLock || null,
        checkpoint: options.checkpoint });
      upgradeSnapshot = { generationId: SNAPSHOT_GENERATION, backupId: snapshot.manifest.backupId,
        rootDigest: snapshot.manifest.authorityRootDigest, checksum: snapshot.manifest.checksum };
    } catch { throw snapshotFailed(); }
  }
  const receipt = { version: 2, platform: "open-connector", legacyExecution: false,
    legacyDataPreserved: true, recordedAt: Date.now(), files, upgradeSnapshot };
  try {
    options.checkpoint?.("before-retirement-commit");
    atomicWritePrivateFile(target, `${JSON.stringify(receipt)}\n`, { trustedRoot: paths.trustedRoot });
  } catch { throw snapshotFailed(); }
  return receipt;
}
module.exports = { markLegacyPluginPlatformRetired, CONNECTOR_UPGRADE_SNAPSHOT_GENERATION: SNAPSHOT_GENERATION };
