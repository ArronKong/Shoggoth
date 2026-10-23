"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { SOURCE_IDENTITY: SLACK_SOURCE, COMPONENT_NAME: SLACK_COMPONENT } =
  require("./plugin-slack-official-sidecar");
const { SERVER: SLACK_SERVER, AUDIENCE: SLACK_AUDIENCE } =
  require("./plugin-slack-oauth");
const { SOURCE_IDENTITY: LOVABLE_SOURCE, COMPONENT_NAME: LOVABLE_COMPONENT,
  SERVER: LOVABLE_SERVER } = require("./plugin-lovable-official-sidecar");
const { SOURCE_IDENTITY: HIGGSFIELD_SOURCE, COMPONENT_NAME: HIGGSFIELD_COMPONENT,
  SERVER: HIGGSFIELD_SERVER } = require("./plugin-higgsfield-official-overlay");
const { SERVER: DROPBOX_SERVER } = require("./plugin-dropbox-oauth");
const { ENDPOINT: CLOUDFLARE_ENDPOINT } = require("./plugin-cloudflare-bearer-verifier");

const { LEGACY_COMPONENT, FULL_COMPONENT } = require("./plugin-slack-access-policy");

const ENTRIES = Object.freeze([
  { kind: "slack", source: SLACK_SOURCE, component: SLACK_COMPONENT,
    endpoint: SLACK_SERVER, audience: SLACK_AUDIENCE,
    components: Object.freeze([LEGACY_COMPONENT, FULL_COMPONENT]) },
  { kind: "lovable", source: LOVABLE_SOURCE, component: LOVABLE_COMPONENT,
    endpoint: LOVABLE_SERVER, audience: LOVABLE_SERVER },
  { kind: "higgsfield", source: HIGGSFIELD_SOURCE, component: HIGGSFIELD_COMPONENT,
    endpoint: HIGGSFIELD_SERVER, audience: HIGGSFIELD_SERVER },
  { kind: "dropbox", source: "bundled:dropbox", component: "dropbox",
    endpoint: DROPBOX_SERVER, audience: null, providerAudience: DROPBOX_SERVER },
  { kind: "cloudflare", source: "bundled:cloudflare", component: "cloudflare-api",
    endpoint: CLOUDFLARE_ENDPOINT, audience: null, auth: "bearer" },
]);
const canonical = value => {
  try { return new URL(value).href; } catch { return null; }
};
function reservedEndpointKind(value) {
  const entry = ENTRIES.find(item => canonical(item.endpoint) === canonical(value));
  return entry?.kind ?? null;
}

// An official endpoint is reserved to its source-pinned independent sidecar.
// A local package declaring the same URL/resource cannot inherit the trusted
// OAuth provider or bypass the sidecar's tool allowlist.
function assertReservedOfficialEndpoint({ sourceIdentity, componentName,
  serverUrl, oauthResource, provider = null } = {}, code = "CONNECTION_IDENTITY_CHANGED") {
  const entry = ENTRIES.find(item => item.source === sourceIdentity
    || canonical(item.endpoint) === canonical(serverUrl)
    || (item.audience !== null && item.audience === oauthResource));
  if (!entry) return null;
  if (sourceIdentity !== entry.source || !(entry.components || [entry.component]).includes(componentName)
    || serverUrl !== entry.endpoint || oauthResource !== entry.audience
    || (provider && (entry.auth === "bearer"
      || provider.serverUrl !== canonical(entry.endpoint)
      || provider.audience !== (entry.providerAudience || entry.audience)
      || (entry.kind === "slack"
        ? provider.protocol !== "slack-mcp" || provider.id !== "slack"
        : entry.kind === "dropbox"
          ? provider.protocol !== "dropbox-mcp" || provider.id !== "dropbox"
          : entry.kind === "higgsfield"
            ? provider.protocol !== "higgsfield-mcp" || provider.id !== "higgsfield-official"
            : provider.id !== "lovable-official")))) {
    throw serviceError(code, "官方 MCP 端点仅允许来源固定的独立侧车");
  }
  return entry.kind;
}

function registrationDigest(provider) {
  return crypto.createHash("sha256").update(JSON.stringify([
    provider.id, provider.serverUrl, provider.issuer, provider.audience,
    provider.authorizationEndpoint, provider.tokenEndpoint, provider.clientId,
    provider.redirectUrl, provider.scopes,
  ])).digest("hex");
}
function bindOfficialPrincipal(provider, principal) {
  const kind = reservedEndpointKind(provider.serverUrl);
  if (!kind) return principal;
  if (kind === "cloudflare") {
    throw serviceError("CONNECTION_AUTH_REQUIRED", "Cloudflare 固定端点仅接受已验证的用户 API Token");
  }
  const match = new RegExp(`^oauth:${kind}:([a-f0-9]{64})$`, "u").exec(principal);
  if (!match) throw serviceError("CONNECTION_AUTH_REQUIRED", "官方 MCP 账号主体无效");
  return `oauth:${kind}:${registrationDigest(provider)}:${match[1]}`;
}
function principalMatchesRegistration(provider, principal) {
  const kind = reservedEndpointKind(provider.serverUrl);
  if (kind === "cloudflare") return false;
  if (!kind || typeof principal !== "string") return false;
  return new RegExp(`^oauth:${kind}:${registrationDigest(provider)}:[a-f0-9]{64}$`, "u")
    .test(principal);
}

module.exports = { assertReservedOfficialEndpoint, reservedEndpointKind,
  bindOfficialPrincipal, principalMatchesRegistration };
