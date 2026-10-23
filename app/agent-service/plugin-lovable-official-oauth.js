"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PluginMcpClient } = require("./plugin-mcp-client");
const { serviceError } = require("./security");
const { SERVER } = require("./plugin-lovable-official-sidecar");

const RESOURCE = SERVER;
const ISSUER = "https://lovable.dev/oauth";
const RESOURCE_METADATA = `${SERVER}/.well-known/oauth-protected-resource`;
const AUTH_METADATA = "https://lovable.dev/.well-known/oauth-authorization-server/oauth";
const AUTHORIZATION_ENDPOINT = "https://lovable.dev/oauth/authorize";
const TOKEN_ENDPOINT = "https://lovable.dev/oauth/token";
const REGISTRATION_ENDPOINT = "https://lovable.dev/oauth/register";
const REGISTRATION_FILE = "lovable-registered-client.json";
const SCOPES = Object.freeze(["workspaces:read"]);
const PUBLIC_SAMPLE_CLIENT_ID = "6d465f583e1e4ce5801b1616f735670c";
const CALLBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;

function fail() {
  throw serviceError("CONNECTION_AUTH_REQUIRED", "Lovable 官方 MCP 注册或账号身份未通过验证");
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
  if (url.origin !== "https://lovable.dev" || !url.pathname.startsWith("/oauth/")
    || url.username || url.password || url.search || url.hash || url.href !== value) fail();
  return value;
}
function validClientId(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= 512
    && !/[\x00-\x20\x7f]/u.test(value) && !value.startsWith("asdk_app_")
    && value !== PUBLIC_SAMPLE_CLIENT_ID;
}
function assertLovableRegistration(value) {
  const keys = ["version", "method", "resource", "issuer", "clientId", "redirectUrl",
    "scopes", "authorizationEndpoint", "tokenEndpoint", "registrationEndpoint"];
  if (!exact(value, keys) || value.version !== 1 || value.method !== "local-dcr"
    || value.resource !== RESOURCE || value.issuer !== ISSUER
    || !validClientId(value.clientId) || !validCallback(value.redirectUrl)
    || !Array.isArray(value.scopes) || value.scopes.length !== 1
    || value.scopes[0] !== SCOPES[0]) fail();
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

async function discoverLovableRegistration({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") fail();
  const get = async url => readJsonResponse(await fetchImpl(url, {
    method: "GET", headers: { Accept: "application/json" }, redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }));
  const resource = await get(RESOURCE_METADATA);
  if (resource.resource !== RESOURCE || !Array.isArray(resource.authorization_servers)
    || resource.authorization_servers.length !== 1
    || resource.authorization_servers[0] !== ISSUER
    || !Array.isArray(resource.scopes_supported)
    || !resource.scopes_supported.includes(SCOPES[0])) fail();
  const authorization = await get(AUTH_METADATA);
  if (authorization.issuer !== ISSUER
    || !Array.isArray(authorization.response_types_supported)
    || !authorization.response_types_supported.includes("code")
    || !Array.isArray(authorization.grant_types_supported)
    || !authorization.grant_types_supported.includes("authorization_code")
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
  return Object.freeze(endpoints);
}

// No sample or Codex client ID is used. The only accepted registration is an
// actual DCR response from the discovered, pinned Lovable authorization server.
async function registerLocalLovableClient({ redirectUrl, fetchImpl = globalThis.fetch,
  beforeRegistration = null } = {}) {
  if (!validCallback(redirectUrl) || typeof fetchImpl !== "function"
    || (beforeRegistration !== null && typeof beforeRegistration !== "function")) fail();
  const endpoints = await discoverLovableRegistration({ fetchImpl });
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
    || !Array.isArray(receipt.response_types) || !receipt.response_types.includes("code")
    || receipt.token_endpoint_auth_method !== "none") fail();
  return assertLovableRegistration({ version: 1, method: "local-dcr",
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

function saveLovableRegistration(paths, registration) {
  const verified = assertLovableRegistration(registration);
  const file = registrationPath(paths);
  // First registration only. Replacing a registered client must be an explicit
  // Service operation that revokes old grants and advances the auth epoch.
  fs.writeFileSync(file, `${JSON.stringify(verified, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  return file;
}

function loadLovableRegistration(paths) {
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
    return assertLovableRegistration(JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, size))));
  } catch (error) { if (error?.code === "ENOENT") return null; fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function principalFromGetMe(result) {
  if (!isPlain(result) || result.isError === true || result.resultType === "input_required") fail();
  let data = result.structuredContent;
  if (data === undefined) {
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1
      || content[0]?.type !== "text" || typeof content[0].text !== "string"
      || Buffer.byteLength(content[0].text, "utf8") > 64 * 1024) fail();
    try { data = JSON.parse(content[0].text); } catch { fail(); }
  }
  if (!isPlain(data)) fail();
  const top = data.id;
  const nested = isPlain(data.user) ? data.user.id : undefined;
  if (top !== undefined && nested !== undefined && top !== nested) fail();
  const id = top ?? nested;
  if (typeof id !== "string" || id.length < 1 || id.length > 256
    || !/^[A-Za-z0-9._:-]+$/u.test(id)) fail();
  return `oauth:lovable:${crypto.createHash("sha256")
    .update(JSON.stringify([ISSUER, id])).digest("hex")}`;
}

// A short-lived, read-only Service probe. It never creates a general MCP
// Connection or a grant; callers must commit only after this returns a stable
// principal and the original OAuth resource/issuer/scope still match.
async function verifyLovablePrincipal({ accessToken, issuer, audience, scopes,
  fetchImpl = globalThis.fetch, assertCurrent } = {}) {
  if (issuer !== ISSUER || audience !== RESOURCE
    || !Array.isArray(scopes) || scopes.length !== SCOPES.length
    || scopes[0] !== SCOPES[0] || typeof accessToken !== "string"
    || !accessToken || accessToken.length > 16_384 || !TOKEN.test(accessToken)
    || typeof fetchImpl !== "function" || typeof assertCurrent !== "function"
    || assertCurrent() !== true) fail();
  const probeIdentity = `lovable-probe:${crypto.randomUUID()}`;
  const credentialProvider = async () => ({ accessToken,
    principalIdentity: probeIdentity, authRevision: 1 });
  credentialProvider.assertCurrent = () => { if (assertCurrent() !== true) fail(); };
  const connection = await PluginMcpClient.connectHttp({ url: SERVER, fetchImpl,
    connectionId: crypto.randomUUID(), principalIdentity: probeIdentity,
    authRevision: 1, credentialProvider, authorizeEgress: ({ toolName, arguments: args }) =>
      toolName === "get_me" && isPlain(args) && Object.keys(args).length === 0
      && assertCurrent() === true,
    versionMode: "legacy", timeoutMs: 10_000 });
  try {
    const tools = await connection.listTools();
    const me = tools.find(tool => tool.name === "get_me");
    if (!me || !isPlain(me.inputSchema) || me.inputSchema.type !== "object"
      || (Array.isArray(me.inputSchema.required) && me.inputSchema.required.length > 0)
      || assertCurrent() !== true) fail();
    const result = await connection.callTool("get_me", {}, { purpose: "identity-probe" },
      { assertCurrent });
    if (assertCurrent() !== true) fail();
    return principalFromGetMe(result);
  } finally { await connection.close(); }
}

function trustedLovableProvider(registration, { mcpFetchImpl = globalThis.fetch,
  assertCurrent } = {}) {
  const config = assertLovableRegistration(registration);
  if (typeof mcpFetchImpl !== "function" || typeof assertCurrent !== "function") fail();
  return {
    id: "lovable-official", name: "Lovable official MCP",
    serverUrl: SERVER, issuer: ISSUER, audience: RESOURCE,
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint, clientId: config.clientId,
    scopes: [...SCOPES], metadataUrls: [RESOURCE_METADATA, AUTH_METADATA],
    identityUrls: [], redirectUrl: config.redirectUrl,
    assertCurrent,
    verifyPrincipal: input => verifyLovablePrincipal({ ...input,
      fetchImpl: mcpFetchImpl, assertCurrent }),
  };
}

module.exports = { SERVER, RESOURCE, ISSUER, RESOURCE_METADATA, AUTH_METADATA,
  AUTHORIZATION_ENDPOINT, TOKEN_ENDPOINT, REGISTRATION_ENDPOINT,
  REGISTRATION_FILE, SCOPES, assertLovableRegistration,
  discoverLovableRegistration, registerLocalLovableClient,
  saveLovableRegistration, loadLovableRegistration, principalFromGetMe,
  verifyLovablePrincipal, trustedLovableProvider };
