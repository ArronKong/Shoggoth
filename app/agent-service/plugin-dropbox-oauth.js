"use strict";

const crypto = require("node:crypto");
const { PluginMcpClient } = require("./plugin-mcp-client");
const { serviceError } = require("./security");

// Dropbox documents a separate app-key route for MCP clients outside its
// trusted DCR list. These values are pinned by Service, not by the package.
const SERVER = "https://mcp.dropbox.com/mcp";
const ISSUER = "https://www.dropbox.com/";
const AUTHORIZATION = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const IDENTITY = "https://api.dropboxapi.com/2/users/get_current_account";
const RESOURCE_METADATA = "https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp";
const ROOT_RESOURCE_METADATA = "https://mcp.dropbox.com/.well-known/oauth-protected-resource";
const AUTHORIZATION_METADATA = "https://www.dropbox.com/.well-known/oauth-authorization-server";
const METADATA_URLS = Object.freeze([RESOURCE_METADATA, ROOT_RESOURCE_METADATA,
  AUTHORIZATION_METADATA]);
const SCOPES = Object.freeze(["files.metadata.read", "files.content.read",
  "files.content.write", "sharing.write", "account_info.read", "sharing.read",
  "file_requests.read", "file_requests.write"]);
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SECRET_REF = /^plugin-dropbox-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const TOKEN_VALUE = /^[A-Za-z0-9\-._~+/]+=*$/u;
const ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{8,128}$/u;
const fail = () => { throw serviceError("CONNECTION_AUTH_REQUIRED", "Dropbox MCP 账号或端点未验证"); };

function isDropboxMcpHost(value) {
  try { return new URL(value).hostname === "mcp.dropbox.com"; } catch { return false; }
}
function validDropboxClientSecret(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 512
    && /^[\x21-\x7e]+$/u.test(value);
}
function validDropboxProviderConfig(value) {
  if (!isDropboxMcpHost(value?.serverUrl)) return true;
  const redirect = typeof value.redirectUrl === "string" && CALLBACK.exec(value.redirectUrl);
  return value.id === "dropbox" && value.name === "Dropbox"
    && value.serverUrl === SERVER && value.issuer === ISSUER
    && value.audience === SERVER && value.authorizationEndpoint === AUTHORIZATION
    && value.tokenEndpoint === TOKEN && CLIENT_ID.test(value.clientId)
    && SECRET_REF.test(value.clientSecretRef)
    && redirect && Number(redirect[1]) >= 1024 && Number(redirect[1]) <= 65535
    && Array.isArray(value.scopes) && value.scopes.length === SCOPES.length
    && SCOPES.every(scope => value.scopes.includes(scope))
    && Array.isArray(value.metadataUrls) && value.metadataUrls.length === METADATA_URLS.length
    && METADATA_URLS.every(url => value.metadataUrls.includes(url))
    && value.identity?.url === IDENTITY && value.identity?.subjectField === "account_id";
}
function validDropboxProtocolProvider(value, registeredClientId) {
  return value?.protocol === "dropbox-mcp" && value.serverUrl === SERVER
    && validDropboxProviderConfig({
    ...value, identity: { url: IDENTITY, subjectField: "account_id" },
  }) && value.clientId === registeredClientId && value.clientId !== null
    && Array.isArray(value.identityUrls) && value.identityUrls.length === 1
    && value.identityUrls[0] === IDENTITY && value.verifyPrincipal === verifyDropboxPrincipal;
}

async function verifyDropboxPrincipal({ accessToken, issuer, fetchImpl }) {
  if (issuer !== ISSUER || !TOKEN_VALUE.test(accessToken || "")
    || typeof fetchImpl !== "function") fail();
  const response = await fetchImpl(IDENTITY, { method: "POST", headers: {
    Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!response.ok) fail();
  let account;
  try { account = await response.json(); } catch { fail(); }
  if (!ACCOUNT_ID.test(account?.account_id || "") || account?.disabled === true) fail();
  // A Dropbox API token alone is not proof that the remote MCP resource will
  // accept it. Probe the exact MCP endpoint before a Connection becomes ready.
  const principal = `oauth:dropbox:${crypto.createHash("sha256")
    .update(JSON.stringify([ISSUER, account.account_id])).digest("hex")}`;
  const credentialProvider = async () => ({ accessToken, principalIdentity: principal,
    authRevision: 1 });
  credentialProvider.assertCurrent = () => {};
  const client = await PluginMcpClient.connectHttp({ url: SERVER, fetchImpl,
    connectionId: "dropbox-mcp-auth-probe", principalIdentity: principal,
    authRevision: 1, credentialProvider,
    authorizeEgress: () => fail(), timeoutMs: 5_000 });
  await client.close();
  return principal;
}

module.exports = { SERVER, ISSUER, AUTHORIZATION, TOKEN, IDENTITY,
  RESOURCE_METADATA, ROOT_RESOURCE_METADATA, AUTHORIZATION_METADATA,
  METADATA_URLS, SCOPES, CLIENT_ID, validDropboxClientSecret,
  isDropboxMcpHost, validDropboxProviderConfig,
  validDropboxProtocolProvider, verifyDropboxPrincipal };
