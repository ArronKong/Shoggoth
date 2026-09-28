"use strict";

const { checkResourceAllowed } = require("@modelcontextprotocol/client");

// These are the three frozen, independent Workspace MCP endpoints. A private
// Desktop client registration may authorize one of them, but the source
// client IDs, secrets, callback port, and union of scopes are never authority.
const PREFIX = "https://www.googleapis.com/auth/";
const PRODUCTS = Object.freeze({
  "https://gmailmcp.googleapis.com/mcp/v1": Object.freeze({ id: "gmail",
    scopes: Object.freeze(["https://mail.google.com/", `${PREFIX}gmail.modify`,
      `${PREFIX}gmail.compose`, `${PREFIX}gmail.readonly`, `${PREFIX}gmail.metadata`]) }),
  "https://calendarmcp.googleapis.com/mcp/v1": Object.freeze({ id: "google-calendar",
    scopes: Object.freeze(["calendar", "calendar.acls", "calendar.calendarlist",
      "calendar.calendarlist.readonly", "calendar.calendars", "calendar.calendars.readonly",
      "calendar.events", "calendar.events.freebusy", "calendar.events.readonly",
      "calendar.freebusy", "calendar.readonly", "calendar.settings.readonly"].map(scope => PREFIX + scope)) }),
  "https://drivemcp.googleapis.com/mcp/v1": Object.freeze({ id: "google-drive",
    scopes: Object.freeze([`${PREFIX}drive`, `${PREFIX}drive.readonly`, `${PREFIX}drive.file`]) }),
});
const GOOGLE_MCP_HOSTS = new Set(Object.keys(PRODUCTS).map(endpoint => new URL(endpoint).host));
const OIDC_METADATA = "https://accounts.google.com/.well-known/openid-configuration";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

function validGoogleWorkspaceProvider(item) {
  let endpoint;
  try { endpoint = new URL(item.serverUrl); } catch { return false; }
  if (!GOOGLE_MCP_HOSTS.has(endpoint.host)) return true;
  const product = PRODUCTS[item.serverUrl];
  if (!product || item.id !== product.id
    || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(item.clientId)
    || !["https://accounts.google.com", "https://accounts.google.com/"].includes(item.issuer)
    || item.authorizationEndpoint !== "https://accounts.google.com/o/oauth2/v2/auth"
    || item.tokenEndpoint !== "https://oauth2.googleapis.com/token"
    || item.redirectUrl !== undefined
    || item.identity?.url !== USERINFO || item.identity?.subjectField !== "sub"
    || !Array.isArray(item.scopes) || !item.scopes.includes("openid")
    || !item.scopes.includes("profile") || !item.scopes.some(scope => product.scopes.includes(scope))
    || item.scopes.some(scope => !["openid", "profile", ...product.scopes].includes(scope))
    || !Array.isArray(item.metadataUrls) || !item.metadataUrls.includes(OIDC_METADATA)) return false;
  try {
    const audience = new URL(item.audience);
    if (audience.origin !== endpoint.origin || audience.username || audience.password
      || audience.search || audience.hash
      || !checkResourceAllowed({ requestedResource: item.serverUrl,
        configuredResource: item.audience })) return false;
    const resourceMetadata = [`${endpoint.origin}/.well-known/oauth-protected-resource/mcp/v1`,
      `${endpoint.origin}/.well-known/oauth-protected-resource`];
    const allowed = new Set([...resourceMetadata,
      "https://accounts.google.com/.well-known/oauth-authorization-server", OIDC_METADATA]);
    return item.metadataUrls.some(raw => resourceMetadata.includes(raw))
      && item.metadataUrls.every(raw => allowed.has(raw));
  } catch { return false; }
}

module.exports = { PRODUCTS, OIDC_METADATA, USERINFO, validGoogleWorkspaceProvider };
