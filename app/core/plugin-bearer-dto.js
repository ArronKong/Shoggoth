"use strict";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === "string" && value.isWellFormed()
  && Buffer.byteLength(value, "utf8") <= 256;
const fail = () => { throw new TypeError("Invalid plugin bearer response"); };

function validatePluginBearerResult(method, value) {
  if (!value || Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024) fail();
  if (method === "plugins.bearer.prepare") {
    const summary = value.summary;
    if (!exact(value, ["challenge", "expiresAt", "summary"])
      || typeof value.challenge !== "string" || !ID.test(value.challenge)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
      || !exact(summary, ["action", "agent", "package", "capability", "provider", "reconnect"])
      || summary.action !== "bearer-connect" || summary.provider !== "GitHub"
      || typeof summary.reconnect !== "boolean"
      || !["agent", "package", "capability"].every(key => text(summary[key]))) fail();
  } else if (method === "plugins.bearer.commit") {
    if (!exact(value, ["canceled", "receipt"]) || typeof value.canceled !== "boolean") fail();
    if (value.canceled) { if (value.receipt !== null) fail(); }
    else {
      const receipt = value.receipt;
      if (!exact(receipt, ["kind", "profileId", "bindingId", "toolIdentity", "revision"])
        || receipt.kind !== "mcp-connect" || receipt.toolIdentity !== null
        || !["profileId", "bindingId"].every(key =>
          typeof receipt[key] === "string" && ID.test(receipt[key]))
        || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) fail();
    }
  } else fail();
  return structuredClone(value);
}

module.exports = { validatePluginBearerResult };
