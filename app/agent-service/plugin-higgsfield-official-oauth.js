"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");
const { SERVER } = require("./plugin-higgsfield-official-overlay");
const { fsyncPrivateParent, writeFully } = require("./private-file");

const RESOURCE = SERVER;
const ISSUER = "https://clerk.higgsfield.ai/";
const SECONDARY_ISSUER = "https://fnf-device-auth.higgsfield.ai/";
const RESOURCE_METADATA = "https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp";
const AUTH_METADATA = "https://clerk.higgsfield.ai/.well-known/oauth-authorization-server";
const OIDC_METADATA = "https://clerk.higgsfield.ai/.well-known/openid-configuration";
const AUTHORIZATION_ENDPOINT = "https://clerk.higgsfield.ai/oauth/authorize";
const TOKEN_ENDPOINT = "https://clerk.higgsfield.ai/oauth/token";
const REGISTRATION_ENDPOINT = "https://clerk.higgsfield.ai/oauth/register";
const USERINFO_ENDPOINT = "https://clerk.higgsfield.ai/oauth/userinfo";
const REGISTRATION_FILE = "higgsfield-registered-client.json";
const SCOPES = Object.freeze(["openid", "email", "offline_access"]);

const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const ISSUED_PROVIDERS = new WeakSet();

function fail() {
  throw serviceError("CONNECTION_AUTH_REQUIRED", "Higgsfield 官方 MCP 注册或账号身份未通过验证");
}
function isPlain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  return isPlain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function validCallback(value) {
  const match = typeof value === "string" && CALLBACK.exec(value);
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535
    && new URL(value).href === value);
}
function asEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.origin !== "https://clerk.higgsfield.ai" || !url.pathname.startsWith("/oauth/")
    || url.username || url.password || url.search || url.hash || url.href !== value) fail();
  return value;
}
function validClientId(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= 512
    && !/[\x00-\x20\x7f]/u.test(value);
}
function assertHiggsfieldRegistration(value) {
  const keys = ["version", "method", "resource", "issuer", "clientId", "redirectUrl",
    "scopes", "authorizationEndpoint", "tokenEndpoint", "registrationEndpoint"];
  if (!exact(value, keys) || value.version !== 1 || value.method !== "local-dcr"
    || value.resource !== RESOURCE || value.issuer !== ISSUER
    || !validClientId(value.clientId) || !validCallback(value.redirectUrl)
    || !Array.isArray(value.scopes) || JSON.stringify(value.scopes) !== JSON.stringify(SCOPES)) fail();
  asEndpoint(value.authorizationEndpoint);
  asEndpoint(value.tokenEndpoint);
  asEndpoint(value.registrationEndpoint);
  if (value.authorizationEndpoint !== AUTHORIZATION_ENDPOINT
    || value.tokenEndpoint !== TOKEN_ENDPOINT
    || value.registrationEndpoint !== REGISTRATION_ENDPOINT) fail();
  if (new Set([value.authorizationEndpoint, value.tokenEndpoint,
    value.registrationEndpoint]).size !== 3) fail();
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) });
}

async function readJsonResponse(response) {
  if (!(response instanceof Response) || !response.ok || response.status >= 300) fail();
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > 32 * 1024)) fail();
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  try {
    if (reader) while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 32 * 1024) fail();
      chunks.push(Buffer.from(item.value));
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks)));
    if (!isPlain(value)) fail();
    return value;
  } catch { fail(); }
  finally { await reader?.cancel().catch(() => {}); }
}

async function discoverHiggsfieldRegistration({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") fail();
  const get = async url => readJsonResponse(await fetchImpl(url, {
    method: "GET", headers: { Accept: "application/json" }, redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }));
  const resource = await get(RESOURCE_METADATA);
  if (resource.resource !== RESOURCE || !Array.isArray(resource.authorization_servers)
    || resource.authorization_servers.length !== 2
    || new URL(resource.authorization_servers[0]).href !== ISSUER
    || new URL(resource.authorization_servers[1]).href !== SECONDARY_ISSUER
    || !Array.isArray(resource.scopes_supported)
    || SCOPES.some(scope => !resource.scopes_supported.includes(scope))) fail();
  const authorization = await get(AUTH_METADATA);
  if (new URL(authorization.issuer).href !== ISSUER
    || !Array.isArray(authorization.response_types_supported)
    || !authorization.response_types_supported.includes("code")
    || !Array.isArray(authorization.grant_types_supported)
    || !authorization.grant_types_supported.includes("authorization_code")
    || !authorization.grant_types_supported.includes("refresh_token")
    || !Array.isArray(authorization.code_challenge_methods_supported)
    || !authorization.code_challenge_methods_supported.includes("S256")
    || !Array.isArray(authorization.token_endpoint_auth_methods_supported)
    || !authorization.token_endpoint_auth_methods_supported.includes("none")) fail();
  const endpoints = {
    authorizationEndpoint: asEndpoint(authorization.authorization_endpoint),
    tokenEndpoint: asEndpoint(authorization.token_endpoint),
    registrationEndpoint: asEndpoint(authorization.registration_endpoint),
  };
  if (new Set(Object.values(endpoints)).size !== 3) fail();
  if (endpoints.authorizationEndpoint !== AUTHORIZATION_ENDPOINT
    || endpoints.tokenEndpoint !== TOKEN_ENDPOINT
    || endpoints.registrationEndpoint !== REGISTRATION_ENDPOINT) fail();
  const oidc = await get(OIDC_METADATA);
  if (new URL(oidc.issuer).href !== ISSUER
    || oidc.authorization_endpoint !== AUTHORIZATION_ENDPOINT
    || oidc.token_endpoint !== TOKEN_ENDPOINT
    || oidc.userinfo_endpoint !== USERINFO_ENDPOINT) fail();
  return Object.freeze(endpoints);
}

// No sample or Codex client ID is used. The only accepted registration is an
// actual DCR response from the discovered, pinned Higgsfield authorization server.
async function registerLocalHiggsfieldClient({ redirectUrl, fetchImpl = globalThis.fetch,
  beforeRegistration = null } = {}) {
  if (!validCallback(redirectUrl) || typeof fetchImpl !== "function"
    || (beforeRegistration !== null && typeof beforeRegistration !== "function")) fail();
  const endpoints = await discoverHiggsfieldRegistration({ fetchImpl });
  const request = {
    client_name: "Shoggoth (local)", redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none",
    scope: SCOPES.join(" "),
  };
  // The caller durably records the uncertain-outcome state after metadata
  // validation but before the first remote write. A failed record stops egress.
  if (beforeRegistration) await beforeRegistration();
  const response = await fetchImpl(endpoints.registrationEndpoint, {
    method: "POST", headers: { Accept: "application/json",
      "Content-Type": "application/json" }, body: JSON.stringify(request),
    redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  const receipt = await readJsonResponse(response);
  if (!validClientId(receipt.client_id) || Object.hasOwn(receipt, "client_secret")
    || !Array.isArray(receipt.redirect_uris) || receipt.redirect_uris.length !== 1
    || receipt.redirect_uris[0] !== redirectUrl
    || !Array.isArray(receipt.grant_types)
    || !receipt.grant_types.includes("authorization_code")
    || !receipt.grant_types.includes("refresh_token")
    || !Array.isArray(receipt.response_types) || !receipt.response_types.includes("code")
    || receipt.token_endpoint_auth_method !== "none"
    || (receipt.scope !== undefined && (typeof receipt.scope !== "string"
      || new Set(receipt.scope.split(" ")).size !== SCOPES.length
      || SCOPES.some(scope => !receipt.scope.split(" ").includes(scope))))) fail();
  return assertHiggsfieldRegistration({ version: 1, method: "local-dcr",
    resource: RESOURCE, issuer: ISSUER, clientId: receipt.client_id,
    redirectUrl, scopes: [...SCOPES], ...endpoints });
}

function registrationPath(paths) {
  if (typeof paths?.pluginsDir !== "string" || !path.isAbsolute(paths.pluginsDir)) fail();
  const parent = fs.lstatSync(paths.pluginsDir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
    || (typeof process.getuid === "function" && parent.uid !== process.getuid())) fail();
  return path.join(paths.pluginsDir, REGISTRATION_FILE);
}

function saveHiggsfieldRegistration(paths, registration) {
  const verified = assertHiggsfieldRegistration(registration);
  const file = registrationPath(paths);
  // First registration only. Replacing a registered client must be an explicit
  // Service operation that revokes old grants and advances the auth epoch.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    writeFully(fs, fd, `${JSON.stringify(verified, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // link is no-replace and atomic. A crash before unlink leaves a hard-linked
  // receipt with nlink > 1, which load rejects until an operator reviews it.
  fs.linkSync(temporary, file);
  fsyncPrivateParent(paths.pluginsDir);
  fs.unlinkSync(temporary);
  fsyncPrivateParent(paths.pluginsDir);
  return file;
}

function loadHiggsfieldRegistration(paths) {
  let file;
  try { file = registrationPath(paths); }
  catch (error) { if (error?.code === "ENOENT") return null; fail(); }
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) || stat.size > 8 * 1024
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail();
    const bytes = Buffer.alloc(8 * 1024 + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== stat.size || size > 8 * 1024) fail();
    return assertHiggsfieldRegistration(JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, size))));
  } catch (error) { if (error?.code === "ENOENT") return null; fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function principalFromUserinfo(data) {
  if (!isPlain(data)) fail();
  const id = data.sub;
  if (typeof id !== "string" || id.length < 1 || id.length > 256
    || !/^[A-Za-z0-9._:-]+$/u.test(id)) fail();
  return `oauth:higgsfield:${crypto.createHash("sha256")
    .update(JSON.stringify([ISSUER, id])).digest("hex")}`;
}

// A short-lived, read-only Service probe. It never creates a general MCP
// Connection or a grant; callers must commit only after this returns a stable
// principal and the original OAuth resource/issuer/scope still match.
async function verifyHiggsfieldPrincipal({ accessToken, issuer, audience, scopes,
  fetchImpl = globalThis.fetch, assertCurrent } = {}) {
  if (issuer !== ISSUER || audience !== RESOURCE
    || !Array.isArray(scopes) || !scopes.includes("openid")
    || scopes.some(scope => !SCOPES.includes(scope))
    || new Set(scopes).size !== scopes.length || typeof accessToken !== "string"
    || !accessToken || accessToken.length > 16_384 || !TOKEN.test(accessToken)
    || typeof fetchImpl !== "function" || typeof assertCurrent !== "function"
    || assertCurrent() !== true) fail();
  const response = await fetchImpl(USERINFO_ENDPOINT, { method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const data = await readJsonResponse(response);
  if (assertCurrent() !== true) fail();
  return principalFromUserinfo(data);
}

function trustedHiggsfieldProvider(registration, { assertCurrent } = {}) {
  const config = assertHiggsfieldRegistration(registration);
  if (typeof assertCurrent !== "function") fail();
  const provider = Object.freeze({
    id: "higgsfield-official", name: "Higgsfield official MCP",
    serverUrl: SERVER, issuer: ISSUER, audience: RESOURCE,
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint, clientId: config.clientId,
    scopes: Object.freeze([...SCOPES]),
    metadataUrls: Object.freeze([RESOURCE_METADATA, AUTH_METADATA, OIDC_METADATA]),
    identityUrls: Object.freeze([USERINFO_ENDPOINT]), redirectUrl: config.redirectUrl,
    protocol: "higgsfield-mcp",
    assertCurrent,
    verifyPrincipal: input => verifyHiggsfieldPrincipal({ ...input, assertCurrent }),
  });
  ISSUED_PROVIDERS.add(provider);
  return provider;
}

function validHiggsfieldProtocolProvider(value, registeredClientId) {
  const callback = typeof value?.redirectUrl === "string" && CALLBACK.exec(value.redirectUrl);
  return ISSUED_PROVIDERS.has(value) && value?.protocol === "higgsfield-mcp"
    && value.id === "higgsfield-official"
    && value.serverUrl === SERVER && value.issuer === ISSUER && value.audience === RESOURCE
    && value.authorizationEndpoint === AUTHORIZATION_ENDPOINT
    && value.tokenEndpoint === TOKEN_ENDPOINT && value.clientId === registeredClientId
    && validClientId(registeredClientId) && callback && Number(callback[1]) >= 1024
    && Number(callback[1]) <= 65535 && value.allowLoopback !== true
    && JSON.stringify(value.scopes) === JSON.stringify(SCOPES)
    && JSON.stringify(value.metadataUrls) === JSON.stringify([RESOURCE_METADATA, AUTH_METADATA, OIDC_METADATA])
    && JSON.stringify(value.identityUrls) === JSON.stringify([USERINFO_ENDPOINT])
    && typeof value.verifyPrincipal === "function" && typeof value.assertCurrent === "function";
}

module.exports = { SERVER, RESOURCE, ISSUER, SECONDARY_ISSUER, RESOURCE_METADATA, AUTH_METADATA,
  OIDC_METADATA, AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, REGISTRATION_ENDPOINT, USERINFO_ENDPOINT,
  REGISTRATION_FILE, SCOPES, assertHiggsfieldRegistration,
  discoverHiggsfieldRegistration, registerLocalHiggsfieldClient,
  saveHiggsfieldRegistration, loadHiggsfieldRegistration, principalFromUserinfo,
  verifyHiggsfieldPrincipal, trustedHiggsfieldProvider, validHiggsfieldProtocolProvider };
