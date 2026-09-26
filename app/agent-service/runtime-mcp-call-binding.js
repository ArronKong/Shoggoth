"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { pluginToolContractDigest } = require("./plugin-tool-contract");

const META = "shoggoth/runtime-call-binding";
const MESSAGE = "Shoggoth internal Runtime call binding v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
function fail() { throw serviceError("MCP_SESSION_INVALID", "mcp_session_invalid"); }
function checkLive(assertCurrent) {
  const value = assertCurrent();
  if (value === false || (value && typeof value.then === "function")) fail();
}
function fingerprint(name, args, confirmation = false) {
  if (typeof name !== "string" || !name || name.length > 64 || !plain(args)
    || typeof confirmation !== "boolean") fail();
  const json = JSON.stringify(args);
  if (Buffer.byteLength(json) > 256 * 1024) fail();
  return pluginToolContractDigest({ name, arguments: args, confirmation });
}
function sessionIdentity(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) fail();
  return crypto.createHash("sha256").update(token).digest("hex");
}
function bindingElicitation({ callId, name, arguments: args, confirmation = false, sessionToken }) {
  if (typeof callId !== "string" || !UUID.test(callId)) fail();
  return { mode: "form", message: MESSAGE,
    requestedSchema: { type: "object", properties: {} },
    _meta: { [META]: { version: 1, callId, name, sessionIdentity: sessionIdentity(sessionToken),
      fingerprint: fingerprint(name, args, confirmation) } } };
}
function parseBindingElicitation(params) {
  if (params?._meta?.[META] === undefined && params?.message !== MESSAGE) return null;
  const proof = params?._meta?.[META];
  if (!plain(params) || params.serverName !== "shoggoth" || params.mode !== "form"
    || params.message !== MESSAGE || !exact(params._meta, [META])
    || !exact(params.requestedSchema, ["type", "properties"])
    || params.requestedSchema.type !== "object" || !exact(params.requestedSchema.properties, [])
    || !exact(proof, ["version", "callId", "name", "fingerprint", "sessionIdentity"])
    || proof.version !== 1 || typeof proof.callId !== "string" || !UUID.test(proof.callId)
    || typeof proof.name !== "string" || !proof.name || proof.name.length > 64
    || typeof proof.fingerprint !== "string" || !HASH.test(proof.fingerprint)
    || typeof proof.sessionIdentity !== "string" || !HASH.test(proof.sessionIdentity)) fail();
  return Object.freeze({ ...proof });
}

// Only the Coordinator may register these after routing a native Codex
// elicitation to an exact assigned host/thread/turn. Model RPC cannot register.
class RuntimeMcpCallBindings {
  #pending = new Map();
  #used = new Map();
  constructor({ now = Date.now, ttlMs = 60_000, maxPending = 256 } = {}) {
    if (typeof now !== "function" || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) throw new TypeError("Invalid Runtime binding options");
    Object.assign(this, { now, ttlMs, maxPending });
  }
  #sweep() {
    const now = this.now();
    for (const [id, record] of this.#pending) if (record.expiresAt <= now) this.#pending.delete(id);
    return now;
  }
  register({ proof, runId, profileId, runtimeProfileId, runtimeAccountId, assertCurrent }) {
    const now = this.#sweep();
    const previous = this.#pending.get(proof?.callId);
    if (!proof || typeof proof.callId !== "string" || !UUID.test(proof.callId)
      || typeof proof.fingerprint !== "string" || !HASH.test(proof.fingerprint)
      || typeof proof.sessionIdentity !== "string" || !HASH.test(proof.sessionIdentity)
      || [runId, profileId, runtimeProfileId, runtimeAccountId].some(value => typeof value !== "string" || !value)
      || typeof assertCurrent !== "function" || this.#used.has(proof.callId)
      || (!previous && this.#pending.size >= this.maxPending) || this.#used.size >= 4096) fail();
    // Authentication can rotate before consume. Only the same trusted native
    // call may rebind its still-pending proof; consumed IDs never re-enter.
    if (previous) {
      if (previous.sessionIdentity === proof.sessionIdentity || previous.name !== proof.name
        || previous.fingerprint !== proof.fingerprint || previous.runId !== runId
        || previous.profileId !== profileId || previous.runtimeProfileId !== runtimeProfileId
        || previous.runtimeAccountId !== runtimeAccountId) fail();
      checkLive(previous.assertCurrent);
    }
    checkLive(assertCurrent);
    this.#pending.set(proof.callId, { ...proof, runId, profileId, runtimeProfileId,
      runtimeAccountId, assertCurrent, expiresAt: previous?.expiresAt ?? now + this.ttlMs });
  }
  consume({ callId, name, arguments: args, confirmation = false, profileId, runtimeProfileId, runtimeAccountId, sessionToken }) {
    this.#sweep();
    const record = this.#pending.get(callId);
    if (!record || this.#used.size >= 4096 || record.name !== name || record.profileId !== profileId
      || record.runtimeProfileId !== runtimeProfileId || record.runtimeAccountId !== runtimeAccountId
      || record.sessionIdentity !== sessionIdentity(sessionToken)
      || record.fingerprint !== fingerprint(name, args, confirmation)) fail();
    this.#pending.delete(callId);
    // This tombstone belongs to the Run, not the short proof TTL. A token
    // refresh after expiry must never revive an already-consumed call ID.
    this.#used.set(callId, record.runId);
    checkLive(record.assertCurrent);
    return { runId: record.runId, assertCurrent: record.assertCurrent };
  }
  releaseRun(runId) {
    for (const [id, record] of this.#pending) if (record.runId === runId) {
      this.#pending.delete(id);
    }
    for (const [id, owner] of this.#used) if (owner === runId) this.#used.delete(id);
  }
  clear() { this.#pending.clear(); this.#used.clear(); }
}

module.exports = { RuntimeMcpCallBindings, bindingElicitation, parseBindingElicitation };
