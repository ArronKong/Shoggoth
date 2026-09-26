"use strict";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const id = v => typeof v === "string" && ID.test(v);
const text = (v, max = 256) => typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) <= max;
const time = v => Number.isSafeInteger(v) && v >= 0;
const fail = () => { throw new TypeError("Invalid plugin OAuth response"); };
function validatePluginOAuthResult(method, value) {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) fail();
  if (method === "plugins.oauth.prepare") {
    const summary = value.summary;
    if (!exact(value, ["challenge", "expiresAt", "summary"]) || !id(value.challenge) || !time(value.expiresAt)
      || !exact(summary, ["action", "agent", "package", "capability", "provider", "scopes", "reconnect"])
      || summary.action !== "oauth-connect" || typeof summary.reconnect !== "boolean"
      || !["agent", "package", "capability", "provider"].every(key => text(summary[key]))
      || !Array.isArray(summary.scopes) || !summary.scopes.length || summary.scopes.length > 32
      || summary.scopes.some(scope => !text(scope) || !scope)) fail();
  } else if (method === "plugins.oauth.commit") {
    if (!exact(value, ["canceled", "flow"]) || typeof value.canceled !== "boolean") fail();
    if (value.canceled) { if (value.flow !== null) fail(); }
    else {
      const flow = value.flow;
      if (!exact(flow, ["flowId", "status", "expiresAt", "authorizationUrl"]) || !id(flow.flowId)
        || flow.status !== "pending" || !time(flow.expiresAt) || !text(flow.authorizationUrl, 8192)) fail();
      const url = new URL(flow.authorizationUrl);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
        || url.username || url.password || url.hash) fail();
    }
  } else if (["plugins.oauth.status", "plugins.oauth.cancel"].includes(method)) {
    if (!exact(value, ["flowId", "status", "expiresAt", "reasonCode", "bindingId", "receipt"])
      || !id(value.flowId) || !time(value.expiresAt)
      || !["starting", "pending", "exchanging", "ready", "failed", "canceled", "expired"].includes(value.status)
      || (value.reasonCode !== null && (!text(value.reasonCode, 128) || !/^[A-Z][A-Z_]+$/u.test(value.reasonCode)))
      || (value.bindingId !== null && !id(value.bindingId))) fail();
    if (value.receipt !== null) {
      const item = value.receipt;
      if (!exact(item, ["kind", "profileId", "bindingId", "toolIdentity", "revision"])
        || item.kind !== "mcp-connect" || !id(item.profileId) || item.bindingId !== value.bindingId
        || !id(item.bindingId) || item.toolIdentity !== null || !time(item.revision) || item.revision < 1) fail();
    }
    if (value.status === "ready" && (!value.receipt || !value.bindingId)) fail();
  } else fail();
  return structuredClone(value);
}
module.exports = { validatePluginOAuthResult };
