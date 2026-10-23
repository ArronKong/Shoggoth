"use strict";
const path = require("node:path");
const { createAuthResolver } = require("./core/device-auth");
// Shared by the desktop Backend and chat broker. Managed Gateway credentials
// remain server-side and never replace the user's persisted connection token.
function createManagedOpenClawProductAuth({ host, legacyResolver, credentialsDir, dataRoot, getGatewayGeneration = null } = {}) {
  if (!host || typeof host.isManaged !== "function" || typeof host.getEndpoint !== "function"
    || !legacyResolver || !path.isAbsolute(credentialsDir || "") || !path.isAbsolute(dataRoot || "")
    || (getGatewayGeneration !== null && typeof getGatewayGeneration !== "function")) {
    throw new TypeError("Invalid managed OpenClaw authentication composition");
  }
  const unavailable = () => { throw Object.assign(new Error("App 管理的 OpenClaw 尚未通过启动验证"), {
    code: "MANAGED_HOST_ENDPOINT_UNVERIFIED", status: 503,
  }); };
  function endpoint(url) {
    const value = host.getEndpoint();
    if (!value || typeof value.token !== "string" || !value.token
      || typeof value.url !== "string" || (url && url !== value.url)) unavailable();
    return value;
  }
  const managed = createAuthResolver({ credentialsDir, strictPrivateFiles: true,
    operatorIdentityDir: path.join(dataRoot, "state", "identity"),
    localGatewayConfigPath: path.join(dataRoot, "openclaw.json"),
    getConfig: () => { const value = endpoint(); return { gatewayUrl: value.url, token: value.token }; },
  });
  function resolver(url) { if (!host.isManaged()) return legacyResolver; endpoint(url); return managed; }
  return Object.freeze({
    ...(getGatewayGeneration ? { getGatewayGeneration } : {}),
    getGatewayUrl: () => host.isManaged() ? host.getEndpoint()?.url || "" : legacyResolver.getGatewayUrl(),
    resolveConnectAuth: url => resolver(url).resolveConnectAuth(url),
    resolveConnectAuthAsync: async url => resolver(url).resolveConnectAuthAsync(url),
    storeDeviceToken: (token, issuedAt, url) => resolver(url).storeDeviceToken(token, issuedAt, url),
    clearDeviceToken: url => resolver(url).clearDeviceToken(url),
  });
}
module.exports = { createManagedOpenClawProductAuth };
