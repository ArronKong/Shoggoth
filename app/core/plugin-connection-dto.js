"use strict";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const id = value => typeof value === "string" && ID.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === "string" && value.isWellFormed() && Buffer.byteLength(value) <= 256;
const positive = value => Number.isSafeInteger(value) && value > 0;
const disposition = value => ["none", "retained_encrypted_unusable"].includes(value);
const reason = value => value === null || (typeof value === "string" && /^[A-Z][A-Z_]{1,127}$/u.test(value));
const fail = () => { throw new TypeError("Invalid plugin disconnect response"); };
function receipt(value) {
  if (!exact(value, ["kind", "profileId", "bindingId", "revision", "connectionId", "affectedBindings",
    "credentialDisposition", "cleanupStatus", "reasonCode"]) || value.kind !== "mcp-disconnect"
    || !["profileId", "bindingId", "connectionId"].every(key => id(value[key])) || !positive(value.revision)
    || !positive(value.affectedBindings) || value.affectedBindings > 1024 || !disposition(value.credentialDisposition)
    || !["complete", "pending"].includes(value.cleanupStatus) || !reason(value.reasonCode)
    || (value.cleanupStatus === "complete" && value.reasonCode !== null)) fail();
}
function validatePluginConnectionResult(method, value) {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 12 * 1024) fail();
  if (method === "plugins.connections.prepare") {
    if (!exact(value, ["challenge", "expiresAt", "summary"]) || !id(value.challenge)
      || !positive(value.expiresAt)) fail();
    const summary = value.summary;
    if (!exact(summary, ["action", "agent", "package", "capability", "affectedBindings", "credentialDisposition"])
      || summary.action !== "mcp-disconnect" || !["agent", "package", "capability"].every(key => text(summary[key]))
      || !positive(summary.affectedBindings) || summary.affectedBindings > 1024 || !disposition(summary.credentialDisposition)) fail();
  } else if (method === "plugins.connections.commit") {
    if (!exact(value, ["canceled", "receipt"]) || typeof value.canceled !== "boolean") fail();
    if (value.canceled) { if (value.receipt !== null) fail(); } else receipt(value.receipt);
  } else if (method === "plugins.connections.operation") {
    if (!exact(value, ["operationId", "found", "phase", "receipt", "reasonCode"]) || !id(value.operationId)
      || typeof value.found !== "boolean" || ![null, "completed", "outcome_unknown"].includes(value.phase)
      || !reason(value.reasonCode) || (!value.found && (value.phase !== null || value.receipt !== null || value.reasonCode !== null))
      || (value.phase === "completed" && value.receipt === null)
      || (value.phase === "outcome_unknown" && value.receipt !== null)) fail();
    if (value.receipt !== null) receipt(value.receipt);
  } else fail();
  return structuredClone(value);
}
module.exports = { validatePluginConnectionResult };
