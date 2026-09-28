"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const BACKENDS = new Set(["openclaw", "hermes"]);
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_ACTIVE = 128;
const OPEN_TTL_MS = 60_000;
const CLAIMED_TTL_MS = 135_000;

function fail(code = "EXTERNAL_PLUGIN_LEASE_INVALID") {
  throw serviceError(code, "外部插件执行授权无效或已过期");
}

function validId(value, maxBytes = 256) {
  return typeof value === "string" && OPAQUE.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || !BACKENDS.has(value.backendId)
    || !validId(value.instanceId, 128) || !validId(value.agentId, 128)
    || !validId(value.sessionId, 256) || !validId(value.toolCallId, 256)) return false;
  if (value.backendId === "openclaw") {
    return Object.keys(value).sort().join(",") ===
      "agentId,backendId,instanceId,runId,sessionId,toolCallId"
      && validId(value.runId, 256);
  }
  return Object.keys(value).sort().join(",") ===
    "agentId,backendId,instanceId,sessionId,taskId,toolCallId,turnId"
    && validId(value.taskId, 256) && validId(value.turnId, 256);
}

function validToken(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  try { return bytes.length === 32 && bytes.toString("base64url") === value; }
  finally { bytes.fill(0); }
}

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

// Only a trusted host adapter may submit this identity. The model never sees
// the pairing credential or lease. Every operation consumes a distinct lease,
// so concurrent calls cannot borrow one another's agent/session/call identity.
class ExternalPluginLeaseManager {
  #now;
  #randomBytes;
  #authorizeAdapter;
  #leases = new Map();

  constructor({ authorizeAdapter, now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    if (typeof authorizeAdapter !== "function" || typeof now !== "function"
      || typeof randomBytes !== "function") throw new TypeError("ExternalPluginLeaseManager 配置无效");
    this.#authorizeAdapter = authorizeAdapter;
    this.#now = now;
    this.#randomBytes = randomBytes;
  }

  async issue({ credentialToken, identity }, capture = null) {
    if (!validToken(credentialToken) || !validIdentity(identity)) fail();
    const authorized = await this.#authorizeAdapter(identity.backendId, credentialToken, identity);
    if (authorized !== true) fail();
    const snapshot = typeof capture === "function" ? capture() : null;
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0
      || now > Number.MAX_SAFE_INTEGER - CLAIMED_TTL_MS) fail();
    this.#purge(now);
    if (this.#leases.size >= MAX_ACTIVE) fail("EXTERNAL_PLUGIN_LEASE_BUSY");
    const bytes = this.#randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
      fail();
    }
    let token;
    try { token = bytes.toString("base64url"); } finally { bytes.fill(0); }
    if (!validToken(token) || this.#leases.has(digest(token))) fail();
    const lease = { identity: Object.freeze({ ...identity }), expiresAt: now + OPEN_TTL_MS,
      snapshot, used: false, canceled: false, controller: new AbortController() };
    this.#leases.set(digest(token), lease);
    return { token, expiresAt: lease.expiresAt };
  }

  claim({ token, identity }) {
    const lease = this.#current(token, identity);
    if (lease.used) fail();
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0
      || now > Number.MAX_SAFE_INTEGER - CLAIMED_TTL_MS) fail();
    lease.used = true;
    // Opening must be followed promptly by a single operation. A claimed
    // tool call may then run for the host's 120-second transport timeout.
    lease.expiresAt = now + CLAIMED_TTL_MS;
    return Object.freeze({ identity: lease.identity, snapshot: lease.snapshot,
      signal: lease.controller.signal,
      assertCurrent: () => this.#assertLeaseCurrent(lease) });
  }

  cancel({ token, identity }) {
    const lease = this.#current(token, identity);
    lease.canceled = true;
    lease.controller.abort();
    this.#leases.delete(digest(token));
  }

  finish({ token, identity }) {
    const lease = this.#current(token, identity);
    if (!lease.used) fail();
    lease.canceled = true;
    this.#leases.delete(digest(token));
  }

  #current(token, identity) {
    if (!validToken(token) || !validIdentity(identity)) fail();
    const lease = this.#leases.get(digest(token));
    if (!lease || Object.keys(lease.identity).some(key => lease.identity[key] !== identity[key])) fail();
    this.#assertLeaseCurrent(lease);
    return lease;
  }

  #assertLeaseCurrent(lease) {
    if (lease.canceled || lease.controller.signal.aborted || lease.expiresAt <= this.#now()) fail();
  }

  #purge(now) {
    for (const [key, lease] of this.#leases) {
      if (lease.expiresAt <= now || lease.canceled) {
        lease.controller.abort();
        this.#leases.delete(key);
      }
    }
  }

  clear() {
    for (const lease of this.#leases.values()) {
      lease.canceled = true;
      lease.controller.abort();
    }
    this.#leases.clear();
  }
}

module.exports = { ExternalPluginLeaseManager, validIdentity, validToken };
