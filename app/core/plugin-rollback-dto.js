"use strict";
const id = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const text = (v, limit) => typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) <= limit;
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const state = v => ["snapshot_preserved", "rollback_requires_data_restore", "restored_from_snapshot"].includes(v);
const phase = v => ["created", "committed", "completed", "outcome_unknown", "failed"].includes(v);
const fail = () => { throw new TypeError("Invalid plugin rollback response"); };
function receipt(v) {
  if (!exact(v, ["operationId", "installationId", "installationRevision", "action", "state", "releaseDigest",
    "snapshotId", "snapshotDigest", "dataDigest", "retainedDataId"]) || !id(v.operationId) || !id(v.installationId)
    || !integer(v.installationRevision, 1) || !["snapshot", "code", "restore"].includes(v.action) || !state(v.state)
    || !hash(v.releaseDigest) || !hash(v.dataDigest) || (v.snapshotId !== null && !hash(v.snapshotId))
    || (v.snapshotDigest !== null && !hash(v.snapshotDigest)) || (v.retainedDataId !== null && !hash(v.retainedDataId))) fail();
}
function validatePluginRollbackResult(method, value) {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) fail();
  if (method === "plugins.rollback.prepare") {
    if (!exact(value, ["challenge", "expiresAt", "summary"]) || !id(value.challenge) || !integer(value.expiresAt)) fail();
    const v = value.summary;
    if (!exact(v, ["action", "package", "fromDigest", "targetDigest", "snapshotId", "byteLength", "dataLossRequired"])
      || !["rollback-snapshot", "rollback-code", "rollback-restore", "rollback-retry"].includes(v.action)
      || !text(v.package, 256) || !hash(v.fromDigest) || !hash(v.targetDigest)
      || (v.snapshotId !== null && !hash(v.snapshotId)) || (v.byteLength !== null && !integer(v.byteLength))
      || typeof v.dataLossRequired !== "boolean") fail();
  } else if (method === "plugins.rollback.commit") {
    if (!exact(value, ["canceled", "receipt"]) || typeof value.canceled !== "boolean") fail();
    if (value.canceled) { if (value.receipt !== null) fail(); } else receipt(value.receipt);
  } else if (method === "plugins.rollback.operation") {
    if (!exact(value, ["operationId", "found", "phase", "receipt"]) || !id(value.operationId)
      || typeof value.found !== "boolean" || (value.phase !== null && !phase(value.phase))) fail();
    if (value.receipt !== null) receipt(value.receipt);
    if (!value.found && (value.phase !== null || value.receipt !== null)) fail();
  } else if (method === "plugins.rollback.list") {
    if (!exact(value, ["installationId", "revision", "desiredState", "codeDigest", "releases", "snapshots", "unavailableSnapshots", "pending"])
      || !id(value.installationId) || !integer(value.revision, 1) || !["enabled", "disabled"].includes(value.desiredState)
      || !hash(value.codeDigest) || !integer(value.unavailableSnapshots) || !Array.isArray(value.releases) || value.releases.length > 64
      || !Array.isArray(value.snapshots) || value.snapshots.length > 128 || !Array.isArray(value.pending) || value.pending.length > 32) fail();
    for (const v of value.releases) if (!exact(v, ["digest", "name", "version"]) || !hash(v.digest)
      || !text(v.name, 256) || (v.version !== null && !text(v.version, 256))) fail();
    for (const v of value.snapshots) if (!exact(v, ["snapshotId", "snapshotDigest", "releaseDigest", "byteLength", "createdAt"])
      || !hash(v.snapshotId) || !hash(v.snapshotDigest) || !hash(v.releaseDigest) || !integer(v.byteLength) || !integer(v.createdAt)) fail();
    for (const v of value.pending) if (!exact(v, ["operationId", "action", "phase", "state"])
      || !id(v.operationId) || !["snapshot", "code", "restore", "other"].includes(v.action) || !phase(v.phase)
      || (v.state !== null && !state(v.state))) fail();
  } else fail();
  return structuredClone(value);
}
module.exports = { validatePluginRollbackResult };
