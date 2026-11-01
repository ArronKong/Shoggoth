"use strict";
const crypto = require("node:crypto");
const { authorizeAdapter } = require("./external-host-pairing");
const { validIdentity } = require("./external-host-identity");
const { serviceError } = require("./security");
const fail = () => { throw serviceError("SECRET_MODEL_IDENTITY_UNAVAILABLE", "模型输入的会话归属无法确认"); };

// The user explicitly authorized this local-only OpenClaw/Hermes boundary.
// The lease cannot resolve credentials or select/forward to a model endpoint.
class ExternalModelProjection {
  constructor({ paths, gateway, getOwner, assertHostCurrent, authorize = authorizeAdapter }) {
    Object.assign(this, { paths, gateway, getOwner, assertHostCurrent, authorize });
    this.leases = new Map(); this.closed = false;
  }
  validate(params) {
    if (this.closed || !params || Object.keys(params).sort().join(",") !== "credentialToken,identity"
      || !validIdentity(params.identity) || !this.authorize(this.paths, params.identity.backendId, params.credentialToken)) fail();
    this.assertHostCurrent(params.identity);
  }
  key(identity) { return crypto.createHash("sha256").update(JSON.stringify(Object.keys(identity).sort().map(key => [key, identity[key]]))).digest("hex"); }
  async handle(method, params) {
    this.validate(params); const key = this.key(params.identity);
    if (method === "mcp.external.model.release") {
      const lease = this.leases.get(key); this.leases.delete(key); clearTimeout(lease?.timer); lease?.route?.close();
      return { released: true };
    }
    if (method !== "mcp.external.model.bind" || this.leases.has(key) || this.leases.size >= 512) fail();
    const identity = Object.freeze({ ...params.identity }), token = params.credentialToken;
    const owner = await this.getOwner({ backendId: identity.backendId, agentId: identity.agentId, sessionKey: identity.sessionId });
    this.validate(params);
    if (!owner?.profileId || !owner?.sessionKey || owner.backendId !== identity.backendId || owner.agentId !== identity.agentId) fail();
    if (this.leases.has(key) || this.leases.size >= 512) fail();
    const expected = Object.freeze({ profileId: owner.profileId, sessionId: owner.sessionKey });
    const lease = { route: null, timer: null }; this.leases.set(key, lease);
    const assertCurrent = () => { this.validate({ identity, credentialToken: token }); if (this.leases.get(key) !== lease) fail(); };
    try {
      lease.route = await this.gateway.bindLocal({ scope: expected, assertCurrent, validateRequest: async () => {
        assertCurrent();
        const current = await this.getOwner({ backendId: identity.backendId, agentId: identity.agentId, sessionKey: identity.sessionId });
        if (current?.profileId !== expected.profileId || current?.sessionKey !== expected.sessionId
          || current?.backendId !== identity.backendId || current?.agentId !== identity.agentId) fail();
        assertCurrent();
      } });
      assertCurrent();
      lease.timer = setTimeout(() => {
        if (this.leases.get(key) !== lease) return;
        this.leases.delete(key); lease.route.close();
      }, 120_000); lease.timer.unref?.();
      return { version: 1, endpoint: lease.route.baseUrl };
    } catch (error) { if (this.leases.get(key) === lease) this.leases.delete(key); lease.route?.close(); throw error; }
  }
  close() { this.closed = true; for (const lease of this.leases.values()) { clearTimeout(lease.timer); lease.route?.close(); } this.leases.clear(); }
  reset() { if (this.leases.size) fail(); this.closed = false; }
}
module.exports = { ExternalModelProjection };
