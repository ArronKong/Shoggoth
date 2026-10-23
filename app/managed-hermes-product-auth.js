"use strict";
// Server-only HTTP/WS credential view. Never forward this object, its return
// values, URLs, or headers to the renderer/public host status endpoint.
const HASH = /^[a-f0-9]{64}$/u;
const fail = () => { throw Object.assign(new Error("MANAGED_HERMES_ENDPOINT_UNVERIFIED"), {
  code: "MANAGED_HERMES_ENDPOINT_UNVERIFIED", status: 503,
}); };
function createManagedHermesProductAuth({ host, legacyResolver = null } = {}) {
  if (!host || typeof host.isManaged !== "function" || typeof host.getEndpoint !== "function"
    || (legacyResolver !== null && typeof legacyResolver !== "function")) {
    throw new TypeError("Invalid managed Hermes authentication composition");
  }
  function resolveEndpoint() {
    const managed = host.isManaged();
    const value = managed ? host.getEndpoint() : legacyResolver?.();
    if (!value || typeof value.baseUrl !== "string" || typeof value.token !== "string") fail();
    let url; try { url = new URL(value.baseUrl); } catch { fail(); }
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)
      || (url.pathname !== "/" && url.pathname !== "")) fail();
    if (managed && (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(value.baseUrl) || !HASH.test(value.token)
      || !value.identity || !Number.isSafeInteger(value.identity.pid) || value.identity.pid <= 1
      || !HASH.test(value.identity.nonce) || typeof value.identity.startIdentity !== "string" || !value.identity.startIdentity)) fail();
    // No endpoint/token is cached; withdrawal or generation changes are observed
    // on every call and cannot fall back to a user's ordinary Hermes server.
    return Object.freeze({ ...value, ...(value.identity ? { identity: Object.freeze({ ...value.identity }) } : {}) });
  }
  function endpointFor(requestUrl) {
    const endpoint = resolveEndpoint();
    if (requestUrl !== undefined && requestUrl !== null) {
      let request; try { request = new URL(requestUrl); } catch { fail(); }
      const base = new URL(endpoint.baseUrl);
      if (request.origin !== base.origin || request.username || request.password || request.hash) fail();
    }
    return endpoint;
  }
  return Object.freeze({ resolveEndpoint,
    getHttpHeaders(requestUrl) {
      const endpoint = endpointFor(requestUrl);
      return Object.freeze(endpoint.token ? { Authorization: "Bearer " + endpoint.token } : {});
    },
    getWebSocketUrl(baseUrl) {
      const endpoint = endpointFor(baseUrl);
      const url = new URL("/api/ws", endpoint.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (endpoint.token) url.searchParams.set("token", endpoint.token);
      return url.href;
    },
  });
}
module.exports = { createManagedHermesProductAuth };
