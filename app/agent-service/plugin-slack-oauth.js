"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

// Protocol boundary for the independent, local-only Slack public-search
// sidecar. A user-owned internal Slack App must be registered separately and
// approved by the workspace; the frozen Codex client ID is never authority.
const SERVER = "https://mcp.slack.com/mcp";
const ISSUER = "https://mcp.slack.com";
const AUDIENCE = "https://mcp.slack.com";
const AUTHORIZATION = "https://slack.com/oauth/v2_user/authorize";
const TOKEN = "https://slack.com/api/oauth.v2.user.access";
const AUTH_TEST = "https://slack.com/api/auth.test";
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource`;
const AUTHORIZATION_METADATA = `${ISSUER}/.well-known/oauth-authorization-server`;
const METADATA_URLS = Object.freeze([
  `${ISSUER}/.well-known/oauth-protected-resource/mcp`,
  RESOURCE_METADATA, AUTHORIZATION_METADATA,
]);
const SCOPES = new Set([
  "canvases:read", "canvases:write", "channels:history", "channels:read", "channels:write",
  "chat:write", "emoji:read", "files:read", "files:write", "groups:history",
  "groups:read", "groups:write", "im:history", "im:read", "im:write",
  "lists:read", "lists:write", "mpim:history", "mpim:read", "mpim:write",
  "reactions:read", "reactions:write", "search:read.files", "search:read.im",
  "search:read.mpim", "search:read.private", "search:read.public",
  "search:read.users", "users:read", "users:read.email",
]);
const SLACK_ID = /^[A-Z][A-Z0-9]{1,31}$/u;
const CLIENT_ID = /^[0-9]{3,20}\.[0-9]{3,20}$/u;
// Slack's PKCE guide explicitly documents `localhost` desktop redirects.
// Only the trusted Slack OAuth listener may accept this localhost spelling;
// generic MCP loopback endpoints remain prohibited.
const LOOPBACK_CALLBACK = /^http:\/\/localhost:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const TOKEN_VALUE = /^[A-Za-z0-9\-._~+/]+=*$/u;

function fail() {
  throw serviceError("CONNECTION_AUTH_REQUIRED", "Slack OAuth 响应无效或账号身份无法验证");
}
function own(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function isSlackMcpHost(value) {
  try { return new URL(value).hostname === "mcp.slack.com"; }
  catch { return false; }
}
function validSlackUserScopes(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= SCOPES.size
    && new Set(value).size === value.length && value.every(scope => SCOPES.has(scope));
}
function validSlackProtocolProvider(value, registeredClientId) {
  const callback = value?.redirectUrl === undefined ? null
    : typeof value.redirectUrl === "string" && LOOPBACK_CALLBACK.exec(value.redirectUrl);
  return value?.protocol === "slack-mcp" && value.id === "slack"
    && value.serverUrl === SERVER && value.issuer === ISSUER
    && value.audience === AUDIENCE && value.authorizationEndpoint === AUTHORIZATION
    && value.tokenEndpoint === TOKEN && value.identityUrls?.length === 1
    && value.identityUrls[0] === AUTH_TEST
    && (value.redirectUrl === undefined || (callback && Number(callback[1]) >= 1024
      && Number(callback[1]) <= 65535))
    && value.allowLoopback !== true && value.verifyPrincipal === verifySlackPrincipal
    && CLIENT_ID.test(registeredClientId || "")
    && value.clientId === registeredClientId
    && validSlackUserScopes(value.scopes)
    && Array.isArray(value.metadataUrls)
    && value.metadataUrls.length === METADATA_URLS.length
    && METADATA_URLS.every(url => value.metadataUrls.includes(url));
}
function normalizedSlackTokenResponse(body, allowedScopes) {
  let value;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { fail(); }
  if (!own(value) || value.ok !== true || value.token_type !== "user"
    || typeof value.access_token !== "string" || value.access_token.length > 16_384
    || !TOKEN_VALUE.test(value.access_token)
    || typeof value.refresh_token !== "string" || value.refresh_token.length > 16_384
    || !TOKEN_VALUE.test(value.refresh_token)
    || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1
    || value.expires_in > 7 * 24 * 60 * 60
    || !own(value.authed_user) || !SLACK_ID.test(value.authed_user.id)
    || !own(value.team) || !SLACK_ID.test(value.team.id)
    || typeof value.authed_user.scope !== "string") fail();
  const granted = value.authed_user.scope.split(",");
  if (!Array.isArray(allowedScopes) || granted.length !== allowedScopes.length
    || new Set(granted).size !== granted.length
    || granted.some(scope => !allowedScopes.includes(scope))
    || (value.scope !== undefined && value.scope !== value.authed_user.scope)) fail();
  // Slack's API describes a user token; MCP transports send that opaque token
  // in an HTTP Bearer header. Normalize only after checking Slack's success
  // flag, token kind, exact granted scopes and rotating-token fields.
  return { access_token: value.access_token, refresh_token: value.refresh_token,
    expires_in: value.expires_in, token_type: "Bearer", scope: granted.join(" ") };
}
async function verifySlackPrincipal({ accessToken, issuer, fetchImpl }) {
  if (issuer !== `${ISSUER}/` || typeof accessToken !== "string" || !accessToken
    || accessToken.length > 16_384 || !TOKEN_VALUE.test(accessToken)
    || typeof fetchImpl !== "function") fail();
  const response = await fetchImpl(AUTH_TEST, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
  if (!response.ok) fail();
  let identity;
  try { identity = await response.json(); }
  catch { fail(); }
  if (!own(identity) || identity.ok !== true || !SLACK_ID.test(identity.team_id)
    || !SLACK_ID.test(identity.user_id) || Object.hasOwn(identity, "bot_id")) fail();
  return `oauth:slack:${crypto.createHash("sha256")
    .update(JSON.stringify([issuer, identity.team_id, identity.user_id])).digest("hex")}`;
}

module.exports = { SERVER, ISSUER, AUDIENCE, AUTHORIZATION, TOKEN, AUTH_TEST,
  RESOURCE_METADATA, AUTHORIZATION_METADATA, METADATA_URLS, isSlackMcpHost,
  CLIENT_ID, LOOPBACK_CALLBACK, validSlackUserScopes, validSlackProtocolProvider,
  normalizedSlackTokenResponse, verifySlackPrincipal };
