"use strict";

const { ENDPOINT } = require("./plugin-cloudflare-bearer-verifier");

const SOURCE_IDENTITY = "bundled:cloudflare";
const REVIEWED_TOOLS = Object.freeze(["docs", "search", "execute"]);

function cloudflareToolAccess(records, toolName) {
  const allowed = records?.installation?.sourceIdentity === SOURCE_IDENTITY
    && records?.connection?.endpointIdentity === ENDPOINT
    && /^cloudflare-token:[a-f0-9]{32}$/u.test(records.connection.principalIdentity || "")
    && REVIEWED_TOOLS.includes(toolName);
  return Object.freeze({ allowed, requiresEachCall: allowed && toolName === "execute" });
}

module.exports = { SOURCE_IDENTITY, REVIEWED_TOOLS, cloudflareToolAccess };
