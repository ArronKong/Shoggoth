"use strict";
const { serviceError } = require("./security");
const { validatedQuerySecrets } = require("./mcp-transport-utils");
const TOP_KEYS = new Set(["env", "headers", "query", "oauthClient", "oauthToken", "oauthDiscovery", "oauthCodeVerifier"]);
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
const fail = (code = "MCP_SECRET_INVALID") => { throw serviceError(code, code); };
function refFor(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) fail();
  return `mcp-connector:${id}`;
}
function normalizeRef(value) {
  if (typeof value === "string" && value.startsWith("mcp-connector:")) { refFor(value.slice(14)); return value; }
  return refFor(value);
}
function validateSecrets(value) {
  if (!plain(value) || Object.keys(value).some(k => !TOP_KEYS.has(k))) fail();
  let count = 0;
  const visit = (v, depth = 0) => {
    if (++count > 4096 || depth > 16) fail();
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v === "string") { if (!v.isWellFormed() || v.includes("\0")) fail(); return; }
    if (!plain(v) && !Array.isArray(v)) fail();
    for (const k of Object.keys(v)) { if (["__proto__", "constructor", "prototype"].includes(k)) fail(); const descriptor=Object.getOwnPropertyDescriptor(v,k);if(!descriptor?.enumerable||!Object.hasOwn(descriptor,"value"))fail();visit(descriptor.value, depth + 1); }
  };
  visit(value);
  const serialized=JSON.stringify(value);
  if(Buffer.byteLength(serialized)>60*1024)fail();
  if (value.query !== undefined && value.query !== null) validatedQuerySecrets(value.query);
  for (const key of ["env", "headers"]) if (value[key] !== undefined && value[key] !== null) {
    if (!plain(value[key]) || Object.keys(value[key]).length > 64) fail();
    for (const [name, text] of Object.entries(value[key])) {
      const validName = key === "env" ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name);
      if (!validName || typeof text !== "string" || !text.isWellFormed() || text.includes("\0") || Buffer.byteLength(text) > 32 * 1024
        || key === "headers" && /[\r\n]/u.test(text)) fail();
      if (key === "env" && /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|PATH$|HOME$|SHELL$|ENV$|BASH_ENV$|PYTHONPATH$|PYTHONHOME$)/u.test(name)) fail();
      if (key === "headers" && /^(?:host|content-length|transfer-encoding|connection|cookie|set-cookie)$/iu.test(name)) fail();
    }
  }
  return JSON.parse(serialized);
}
class McpConnectorSecrets {
  constructor({ secretStore } = {}) { if (!secretStore?.get || !secretStore?.put || !secretStore?.delete) throw new TypeError("EncryptedSecretStore required"); this.secretStore = secretStore; this.queues = new Map(); }
  refFor(id) { return refFor(id); }
  async get(refOrId) {
    if (refOrId === null || refOrId === undefined) return null;
    const ref = normalizeRef(refOrId);
    let raw;
    try { raw = await this.secretStore.get(ref); } catch { fail("MCP_CREDENTIALS_LOCKED"); }
    if (raw === null) return null;
    try { return validateSecrets(JSON.parse(raw)); } catch { fail("MCP_CREDENTIALS_LOCKED"); }
  }
  async read(id) { return this.get(id); }
  async set(refOrId, value) {
    const ref = normalizeRef(refOrId), verified = validateSecrets(value);
    try { await this.secretStore.put(ref, JSON.stringify(verified), { kind: "mcp-oauth" }); } catch { fail("MCP_CREDENTIALS_LOCKED"); }
    return ref;
  }
  async write(id, patch) {
    const ref = normalizeRef(id), verified = validateSecrets(patch);
    const previous = this.queues.get(ref) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.get(ref) || {};
      const next = { ...current, ...verified };
      for (const map of ["env", "headers", "query"]) if (verified[map] && current[map]) next[map] = { ...current[map], ...verified[map] };
      for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
      return this.set(ref, next);
    });
    this.queues.set(ref, operation);
    try { return await operation; } finally { if (this.queues.get(ref) === operation) this.queues.delete(ref); }
  }
  async remove(refOrId) { try { return await this.secretStore.delete(normalizeRef(refOrId)); } catch { fail("MCP_CREDENTIALS_LOCKED"); } }
}
module.exports = { McpConnectorSecrets, refFor, validateSecrets };
