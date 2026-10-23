"use strict";
// App-private credential contract. Physical owner data never grants authority:
// Service must independently verify it and mint its own capability.
const path = require("node:path");
const { plain, capture, HASH, OP, fail } = require("./managed-openclaw-model-policy");
const OWNER_KEYS = Object.freeze(["version", "backendId", "operationId", "requestDigest", "pid", "startIdentity", "nonce", "generation",
  "runtimeRoot", "runtimeTreeSha256", "dataRoot", "interpreterPath", "entryPath", "expiresAt"]);
function exact(value, keys) { return plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function credentialOwner(value) {
  if (!exact(value, OWNER_KEYS) || value.version !== 1 || value.backendId !== "openclaw"
    || typeof value.operationId !== "string" || !OP.test(value.operationId) || typeof value.requestDigest !== "string" || !HASH.test(value.requestDigest)
    || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || typeof value.startIdentity !== "string" || !value.startIdentity || value.startIdentity.length > 256 || /[\x00\r\n]/u.test(value.startIdentity)
    || typeof value.nonce !== "string" || !HASH.test(value.nonce) || typeof value.generation !== "string" || !OP.test(value.generation)
    || typeof value.runtimeTreeSha256 !== "string" || !HASH.test(value.runtimeTreeSha256)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300000) {
    throw fail("MANAGED_MODEL_CREDENTIAL_OWNER_INVALID");
  }
  for (const key of ["runtimeRoot", "dataRoot", "interpreterPath", "entryPath"]) {
    const target = value[key];
    if (typeof target !== "string" || !path.isAbsolute(target) || path.normalize(target) !== target
      || Buffer.byteLength(target) > 4096 || /[\x00\r\n]/u.test(target)) throw fail("MANAGED_MODEL_CREDENTIAL_OWNER_INVALID");
  }
  if (value.entryPath !== path.join(value.runtimeRoot, "openclaw.mjs")) throw fail("MANAGED_MODEL_CREDENTIAL_OWNER_INVALID");
  // The pinned Node interpreter can be outside the immutable npm runtime.
  return capture(value);
}
module.exports = { OWNER_KEYS, credentialOwner };
