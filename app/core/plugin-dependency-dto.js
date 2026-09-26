"use strict";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, HASH = /^[a-f0-9]{64}$/u;
const id = v => typeof v === "string" && ID.test(v);
const text = (v, max) => typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) <= max;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const fail = () => { throw new TypeError("Invalid plugin dependency response"); };
function receipt(v) {
  if (!exact(v, ["installationId", "componentId", "status", "revision", "operationId", "interpreter", "version"])
    || !id(v.installationId) || !text(v.componentId, 64) || !HASH.test(v.componentId)
    || !["missing", "ready", "stale", "changed", "revoked"].includes(v.status)
    || !Number.isSafeInteger(v.revision) || v.revision < 0 || (v.operationId !== null && !id(v.operationId))
    || !["node", "python"].includes(v.interpreter) || (v.version !== null && !text(v.version, 64))) fail();
}
function validatePluginDependencyResult(method, value) {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 12 * 1024) fail();
  if (method === "plugins.dependencies.preview") {
    if (!exact(value, ["challenge", "expiresAt", "summary"]) || !id(value.challenge)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) fail();
    const summary = value.summary;
    if (!exact(summary, ["action", "package", "capability", "interpreter", "executablePath", "sha256"])
      || !["dependency-prepare", "dependency-revoke"].includes(summary.action)
      || !text(summary.package, 256) || !text(summary.capability, 256)
      || !["node", "python"].includes(summary.interpreter)
      || (summary.executablePath !== null && !text(summary.executablePath, 4096))
      || (summary.sha256 !== null && (!text(summary.sha256, 64) || !HASH.test(summary.sha256)))) fail();
  } else if (method === "plugins.dependencies.commit") {
    if (!exact(value, ["canceled", "receipt"]) || typeof value.canceled !== "boolean") fail();
    if (value.canceled) { if (value.receipt !== null) fail(); } else receipt(value.receipt);
  } else if (method === "plugins.dependencies.status") receipt(value);
  else if (method === "plugins.dependencies.operation") {
    if (!exact(value, ["operationId", "found", "phase", "receipt", "reasonCode"]) || !id(value.operationId)
      || typeof value.found !== "boolean" || ![null, "probing", "completed", "failed", "outcome_unknown"].includes(value.phase)
      || (value.reasonCode !== null && (!text(value.reasonCode, 128) || !/^[A-Z][A-Z_]+$/u.test(value.reasonCode)))) fail();
    if (value.receipt !== null) receipt(value.receipt);
    if ((!value.found && (value.phase !== null || value.receipt !== null || value.reasonCode !== null))
      || (value.phase === "completed" && value.receipt === null)) fail();
  }
  else fail();
  return structuredClone(value);
}
module.exports = { validatePluginDependencyResult };
