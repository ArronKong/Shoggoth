"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const SERVER = "https://mcp.zoom.us/mcp/meeting/streamable";
const ISSUER = "https://zoom.us/";
const AUTHORIZATION = "https://zoom.us/oauth/authorize";
const TOKEN = "https://zoom.us/oauth/token";
const IDENTITY = "https://api.zoom.us/v2/users/me";
const RESOURCE_METADATA = "https://mcp.zoom.us/.well-known/oauth-protected-resource/mcp/meeting/streamable";
const ROOT_RESOURCE_METADATA = "https://mcp.zoom.us/.well-known/oauth-protected-resource";
const AUTHORIZATION_METADATA = "https://zoom.us/.well-known/oauth-authorization-server";
const OIDC_METADATA = "https://zoom.us/.well-known/openid-configuration";
const METADATA_URLS = Object.freeze([RESOURCE_METADATA, ROOT_RESOURCE_METADATA,
  AUTHORIZATION_METADATA, OIDC_METADATA]);
const MEETING_SCOPES = Object.freeze(["meeting:read:search", "meeting:read:assets",
  "cloud_recording:read:list_user_recordings", "cloud_recording:read:content"]);
const IDENTITY_SCOPE = "user:read:user";
const CLIENT_ID = /^[A-Za-z0-9._-]{10,128}$/u;
const SECRET_REF = /^plugin-zoom-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PRINCIPAL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TOKEN_VALUE = /^[A-Za-z0-9\-._~+/]+=*$/u;
const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const fail = () => { throw serviceError("CONNECTION_AUTH_REQUIRED", "Zoom MCP 账号身份不可验证"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function isZoomMcpHost(value) {
  try { return new URL(value).hostname === "mcp.zoom.us"; } catch { return false; }
}
function validZoomProviderConfig(value) {
  if (!isZoomMcpHost(value?.serverUrl)) return true;
  const keys = ["id", "name", "serverUrl", "issuer", "audience", "authorizationEndpoint",
    "tokenEndpoint", "clientId", "clientSecretRef", "scopes", "metadataUrls", "identity", "redirectUrl"];
  const callback = typeof value.redirectUrl === "string" && CALLBACK.exec(value.redirectUrl);
  return exact(value, keys) && value.id === "zoom-meetings" && value.serverUrl === SERVER
    && value.issuer === ISSUER && value.audience === SERVER
    && value.authorizationEndpoint === AUTHORIZATION && value.tokenEndpoint === TOKEN
    && CLIENT_ID.test(value.clientId) && !value.clientId.startsWith("ZOOM_")
    && SECRET_REF.test(value.clientSecretRef)
    && callback && Number(callback[1]) >= 1024 && Number(callback[1]) <= 65535
    && Array.isArray(value.scopes) && value.scopes.includes(IDENTITY_SCOPE)
    && value.scopes.some(scope => MEETING_SCOPES.includes(scope))
    && value.scopes.every(scope => [IDENTITY_SCOPE, ...MEETING_SCOPES].includes(scope))
    && new Set(value.scopes).size === value.scopes.length
    && Array.isArray(value.metadataUrls)
    && value.metadataUrls.length === METADATA_URLS.length
    && METADATA_URLS.every(url => value.metadataUrls.includes(url))
    && exact(value.identity, ["url", "subjectField"])
    && value.identity.url === IDENTITY && value.identity.subjectField === "id";
}
function validZoomProtocolProvider(value, registeredClientId) {
  return value?.protocol === "zoom-mcp" && validZoomProviderConfig({
    id: value.id, name: value.name, serverUrl: value.serverUrl, issuer: value.issuer,
    audience: value.audience, authorizationEndpoint: value.authorizationEndpoint,
    tokenEndpoint: value.tokenEndpoint, clientId: value.clientId,
    clientSecretRef: value.clientSecretRef, scopes: value.scopes,
    metadataUrls: value.metadataUrls, identity: { url: IDENTITY, subjectField: "id" },
    redirectUrl: value.redirectUrl,
  }) && value.clientId === registeredClientId && value.clientId !== null
    && Array.isArray(value.identityUrls) && value.identityUrls.length === 1
    && value.identityUrls[0] === IDENTITY
    && value.verifyPrincipal === verifyZoomPrincipal;
}
function validZoomClientSecret(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 512
    && /^[\x21-\x7e]+$/u.test(value);
}
async function verifyZoomPrincipal({ accessToken, issuer, fetchImpl }) {
  if (issuer !== ISSUER || !TOKEN_VALUE.test(accessToken || "")
    || typeof fetchImpl !== "function") fail();
  const response = await fetchImpl(IDENTITY, { method: "GET", headers: {
    Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!response.ok) fail();
  let identity;
  try { identity = await response.json(); } catch { fail(); }
  if (!exact(identity, ["id", "account_id"]) && (!identity || typeof identity !== "object"
    || Array.isArray(identity) || Object.getPrototypeOf(identity) !== Object.prototype)) fail();
  if (!PRINCIPAL_ID.test(identity.id || "") || !PRINCIPAL_ID.test(identity.account_id || "")) fail();
  return `oauth:zoom-meetings:${crypto.createHash("sha256")
    .update(JSON.stringify([ISSUER, identity.account_id, identity.id])).digest("hex")}`;
}

module.exports = { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY, RESOURCE_METADATA,
  ROOT_RESOURCE_METADATA, AUTHORIZATION_METADATA, OIDC_METADATA, METADATA_URLS,
  MEETING_SCOPES, IDENTITY_SCOPE, isZoomMcpHost, validZoomProviderConfig,
  validZoomProtocolProvider, validZoomClientSecret, verifyZoomPrincipal };
