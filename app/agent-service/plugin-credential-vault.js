"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;
const CREDENTIAL_PREFIX = "plugin-oauth-";
const RECORD_VERSION = 1;
const MAX_TOKEN_BYTES = 16_384;
const MAX_SCOPES = 128;

function fail(code = "CONNECTION_AUTH_REQUIRED", message = "插件凭据不可用") {
  throw serviceError(code, message);
}
function validText(value, limit) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= limit;
}
function validPrincipal(value) {
  return validText(value, 1024) && !/[\x00-\x1F\x7F]/u.test(value);
}
function validToken(value) {
  return validText(value, MAX_TOKEN_BYTES) && TOKEN.test(value);
}
function validScopes(scopes) {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= MAX_SCOPES
    && scopes.every((scope) => validText(scope, 256) && SCOPE.test(scope))
    && new Set(scopes).size === scopes.length;
}
function exactKeys(value, names) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
}
function assertIssuer(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!validText(value, 2048)
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.hash || url.search) fail();
  return url.href;
}
function decodeRecord(raw) {
  let record;
  try { record = JSON.parse(raw); } catch { fail(); }
  if (!exactKeys(record, ["version", "connectionId", "endpointIdentity", "issuer",
    "audience", "accessToken", "refreshToken", "scopes", "expiresAt",
    "principalIdentity", "authRevision"])
    || record.version !== RECORD_VERSION || typeof record.connectionId !== "string"
    || !ID.test(record.connectionId)
    || !validText(record.endpointIdentity, 2048)
    || assertIssuer(record.issuer) !== record.issuer
    || (record.audience !== null && !validText(record.audience, 2048))
    || !validToken(record.accessToken)
    || (record.refreshToken !== null && !validToken(record.refreshToken))
    || !validScopes(record.scopes)
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0
    || (record.principalIdentity !== null && !validPrincipal(record.principalIdentity))
    || (record.authRevision !== null
      && (!Number.isSafeInteger(record.authRevision) || record.authRevision < 1))
    || (record.principalIdentity === null) !== (record.authRevision === null)) fail();
  return record;
}
function newPluginCredentialRef() {
  return `${CREDENTIAL_PREFIX}${crypto.randomUUID()}`;
}
function parseTokens(tokens, allowedScopes, now, previousRefreshToken = null) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)
    || !validToken(tokens.access_token)
    || (tokens.refresh_token !== undefined && !validToken(tokens.refresh_token))
    || !/^Bearer$/iu.test(tokens.token_type)
    || !Number.isSafeInteger(tokens.expires_in)
    || tokens.expires_in < 1 || tokens.expires_in > 7 * 24 * 60 * 60
    || (tokens.scope !== undefined
      && (typeof tokens.scope !== "string" || tokens.scope.length > 16_384))
    || !validScopes(allowedScopes)
    || !Number.isSafeInteger(now) || now < 0) fail();
  const scopes = (tokens.scope ?? allowedScopes.join(" ")).split(" ").filter(Boolean);
  const expiresAt = now + tokens.expires_in * 1000;
  if (!validScopes(scopes) || scopes.some((scope) => !allowedScopes.includes(scope))
    || !Number.isSafeInteger(expiresAt)) fail();
  return { accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefreshToken, scopes, expiresAt };
}

// Isolated Service primitive. The pending Connection owns a unique opaque
// secret ref before a token is written. Only a trusted principal verifier can
// turn the pending encrypted record into a ready Connection; management DTOs
// never contain the token or refresh token.
class PluginCredentialVault {
  #store;
  #secrets;
  #verifyPrincipal;
  #refreshTokens;
  #invalidateToolCatalog;
  #now;
  #refreshes = new Map();

  constructor({ store, secretStore, verifyPrincipal, refreshTokens = null,
    invalidateToolCatalog = null, now = Date.now } = {}) {
    if (typeof store?.getConnectionAuth !== "function"
      || typeof store?.setConnectionIdentity !== "function"
      || typeof secretStore?.get !== "function"
      || typeof secretStore?.putIfRevision !== "function"
      || typeof secretStore?.getCredentialRevision !== "function"
      || typeof verifyPrincipal !== "function"
      || (refreshTokens !== null && typeof refreshTokens !== "function")
      || (invalidateToolCatalog !== null && typeof invalidateToolCatalog !== "function")
      || typeof now !== "function") {
      throw new TypeError("PluginCredentialVault requires PluginStore, EncryptedSecretStore and principal verifier");
    }
    this.#store = store;
    this.#secrets = secretStore;
    this.#verifyPrincipal = verifyPrincipal;
    this.#refreshTokens = refreshTokens;
    this.#invalidateToolCatalog = invalidateToolCatalog;
    this.#now = now;
  }

  #pending(connectionId, expectedRevision) {
    if (typeof connectionId !== "string" || !ID.test(connectionId)
      || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1) fail();
    const connection = this.#store.getConnectionAuth(connectionId);
    if (!connection || connection.state !== "pending"
      || connection.revision !== expectedRevision
      || !validText(connection.endpointIdentity, 2048)
      || typeof connection.credentialRef !== "string"
      || !connection.credentialRef.startsWith(CREDENTIAL_PREFIX)) {
      fail("CONNECTION_IDENTITY_CHANGED", "连接已变化或不是待核验状态");
    }
    return connection;
  }

  async storePendingOAuthTokens({ connectionId, expectedRevision, tokens,
    issuer, audience = null, requestedScopes } = {}) {
    const connection = this.#pending(connectionId, expectedRevision);
    if (this.#secrets.getCredentialRevision(connection.credentialRef) !== null
      || (audience !== null && !validText(audience, 2048))) fail();
    const parsed = parseTokens(tokens, requestedScopes, this.#now());
    const record = { version: RECORD_VERSION, connectionId,
      endpointIdentity: connection.endpointIdentity, issuer: assertIssuer(issuer),
      audience, ...parsed,
      principalIdentity: null, authRevision: null };
    await this.#secrets.putIfRevision(connection.credentialRef, JSON.stringify(record),
      { kind: "mcp-oauth" }, null);
    const current = this.#pending(connectionId, expectedRevision);
    if (current.credentialRef !== connection.credentialRef
      || current.endpointIdentity !== connection.endpointIdentity) {
      fail("CONNECTION_IDENTITY_CHANGED", "凭据写入期间连接已变化");
    }
    return Object.freeze({ connectionId, status: "credential_stored_unverified" });
  }

  async verifyAndActivate({ connectionId, expectedRevision } = {}) {
    const connection = this.#pending(connectionId, expectedRevision);
    const secretRevision = this.#secrets.getCredentialRevision(connection.credentialRef);
    if (secretRevision === null) fail();
    const record = decodeRecord(await this.#secrets.get(connection.credentialRef));
    if (record.connectionId !== connectionId
      || record.endpointIdentity !== connection.endpointIdentity
      || record.expiresAt <= this.#now()) fail("CONNECTION_IDENTITY_CHANGED", "凭据与连接不一致或已过期");
    const principalIdentity = await this.#verifyPrincipal({
      connectionId, endpointIdentity: record.endpointIdentity,
      issuer: record.issuer, audience: record.audience,
      accessToken: record.accessToken, scopes: Object.freeze([...record.scopes]),
    });
    if (!validPrincipal(principalIdentity)) fail("CONNECTION_AUTH_REQUIRED", "账号主体未核验");
    const current = this.#pending(connectionId, expectedRevision);
    if (current.credentialRef !== connection.credentialRef
      || current.endpointIdentity !== record.endpointIdentity
      || this.#secrets.getCredentialRevision(connection.credentialRef) !== secretRevision) {
      fail("CONNECTION_IDENTITY_CHANGED", "账号核验期间连接或凭据已变化");
    }
    const authRevision = current.authRevision + 1;
    if (!Number.isSafeInteger(authRevision)) fail();
    if (record.principalIdentity !== null
      && (record.principalIdentity !== principalIdentity || record.authRevision !== authRevision)) {
      fail("CONNECTION_IDENTITY_CHANGED", "已核验账号与当前连接不一致");
    }
    const stored = await this.#secrets.putIfRevision(connection.credentialRef, JSON.stringify({
      ...record, principalIdentity, authRevision,
    }), { kind: "mcp-oauth" }, secretRevision);
    if (this.#secrets.getCredentialRevision(connection.credentialRef) !== stored.revision) fail();
    const beforeCommit = this.#pending(connectionId, expectedRevision);
    if (beforeCommit.credentialRef !== connection.credentialRef
      || beforeCommit.endpointIdentity !== record.endpointIdentity) {
      fail("CONNECTION_IDENTITY_CHANGED", "账号提交前连接已变化");
    }
    const activated = this.#store.setConnectionIdentity({ connectionId, principalIdentity,
      state: "ready", expectedRevision });
    if (activated.authRevision !== authRevision || activated.credentialRef !== undefined) {
      fail("CONNECTION_IDENTITY_CHANGED", "连接认证提交结果不一致");
    }
    return activated;
  }

  async readCredential(connectionId) {
    if (typeof connectionId !== "string" || !ID.test(connectionId)) fail();
    const connection = this.#store.getConnectionAuth(connectionId);
    if (!connection || connection.state !== "ready" || !connection.principalIdentity
      || typeof connection.credentialRef !== "string"
      || !connection.credentialRef.startsWith(CREDENTIAL_PREFIX)) return null;
    const secretRevision = this.#secrets.getCredentialRevision(connection.credentialRef);
    if (secretRevision === null) return null;
    const record = decodeRecord(await this.#secrets.get(connection.credentialRef));
    const current = this.#store.getConnectionAuth(connectionId);
    if (this.#secrets.getCredentialRevision(connection.credentialRef) !== secretRevision
      || !current || current.state !== "ready"
      || current.revision !== connection.revision
      || current.credentialRef !== connection.credentialRef
      || current.endpointIdentity !== record.endpointIdentity
      || current.principalIdentity !== record.principalIdentity
      || current.authRevision !== record.authRevision
      || record.connectionId !== connectionId) {
      fail("CONNECTION_IDENTITY_CHANGED", "凭据读取期间连接身份已变化");
    }
    return { accessToken: record.accessToken,
      principalIdentity: record.principalIdentity,
      authRevision: record.authRevision,
      endpointIdentity: record.endpointIdentity,
      issuer: record.issuer, audience: record.audience,
      scopes: [...record.scopes], expiresAt: record.expiresAt };
  }

  // A refresh may rotate the token without changing the Connection's account
  // generation. The provider callback must use this record's issuer/resource;
  // the new access token is independently checked against the old principal.
  refreshCredential({ connectionId, principalIdentity, authRevision,
    endpointIdentity } = {}) {
    if (!this.#refreshTokens || typeof connectionId !== "string" || !ID.test(connectionId)
      || !validPrincipal(principalIdentity)
      || !Number.isSafeInteger(authRevision) || authRevision < 1
      || !validText(endpointIdentity, 2048)) fail();
    const expected = { connectionId, principalIdentity, authRevision, endpointIdentity };
    const current = this.#store.getConnectionAuth(connectionId);
    if (!current || current.state !== "ready"
      || current.principalIdentity !== principalIdentity
      || current.authRevision !== authRevision
      || current.endpointIdentity !== endpointIdentity) {
      fail("CONNECTION_IDENTITY_CHANGED", "刷新期间连接身份已变化");
    }
    const active = this.#refreshes.get(connectionId);
    if (active) {
      if (Object.entries(expected).some(([key, value]) => active.expected[key] !== value)) {
        fail("CONNECTION_IDENTITY_CHANGED", "刷新期间连接身份已变化");
      }
      return active.promise;
    }
    // A rotated or narrower token can change tools/list without changing the
    // account generation. Invalidate before the first async credential write.
    const invalidated = this.#invalidateToolCatalog?.(connectionId);
    if (invalidated && typeof invalidated.then === "function") {
      fail("CONNECTION_AUTH_REQUIRED", "插件工具目录失效回调必须同步完成");
    }
    const promise = Promise.resolve().then(() => this.#doRefresh(expected));
    this.#refreshes.set(connectionId, { expected, promise });
    void promise.finally(() => {
      if (this.#refreshes.get(connectionId)?.promise === promise) {
        this.#refreshes.delete(connectionId);
      }
    }).catch(() => {});
    return promise;
  }

  async #doRefresh(expected) {
    const { connectionId, principalIdentity, authRevision, endpointIdentity } = expected;
    const assertConnection = () => {
      const current = this.#store.getConnectionAuth(connectionId);
      if (!current || current.state !== "ready"
        || current.principalIdentity !== principalIdentity
        || current.authRevision !== authRevision
        || current.endpointIdentity !== endpointIdentity
        || typeof current.credentialRef !== "string"
        || !current.credentialRef.startsWith(CREDENTIAL_PREFIX)) {
        fail("CONNECTION_IDENTITY_CHANGED", "刷新期间连接身份已变化");
      }
      return current;
    };
    const connection = assertConnection();
    const secretRevision = this.#secrets.getCredentialRevision(connection.credentialRef);
    if (secretRevision === null) fail();
    const record = decodeRecord(await this.#secrets.get(connection.credentialRef));
    if (assertConnection().revision !== connection.revision
      || this.#secrets.getCredentialRevision(connection.credentialRef) !== secretRevision
      || record.connectionId !== connectionId
      || record.endpointIdentity !== endpointIdentity
      || record.principalIdentity !== principalIdentity
      || record.authRevision !== authRevision
      || !record.refreshToken) {
      fail("CONNECTION_IDENTITY_CHANGED", "刷新凭据与连接身份不一致");
    }
    const response = await this.#refreshTokens({ connectionId, endpointIdentity,
      issuer: record.issuer, audience: record.audience,
      refreshToken: record.refreshToken, scopes: Object.freeze([...record.scopes]) });
    const parsed = parseTokens(response, record.scopes, this.#now(), record.refreshToken);
    const refreshedPrincipal = await this.#verifyPrincipal({ connectionId,
      endpointIdentity, issuer: record.issuer, audience: record.audience,
      accessToken: parsed.accessToken, scopes: Object.freeze([...parsed.scopes]) });
    if (!validPrincipal(refreshedPrincipal)) fail("CONNECTION_AUTH_REQUIRED", "刷新账号主体未核验");
    const current = assertConnection();
    if (current.revision !== connection.revision
      || current.credentialRef !== connection.credentialRef
      || this.#secrets.getCredentialRevision(connection.credentialRef) !== secretRevision) {
      fail("CONNECTION_IDENTITY_CHANGED", "刷新期间连接或凭据已变化");
    }
    if (refreshedPrincipal !== principalIdentity) {
      this.#store.setConnectionIdentity({ connectionId,
        principalIdentity: refreshedPrincipal, state: "disconnected",
        expectedRevision: connection.revision });
      fail("CONNECTION_IDENTITY_CHANGED", "刷新结果属于其他账号，连接已断开");
    }
    const stored = await this.#secrets.putIfRevision(connection.credentialRef, JSON.stringify({
      ...record, ...parsed,
    }), { kind: "mcp-oauth" }, secretRevision);
    // A discovery started with the old token during refresh must also be
    // rejected, even if it completes after the rotated secret is committed.
    const invalidated = this.#invalidateToolCatalog?.(connectionId);
    if (invalidated && typeof invalidated.then === "function") {
      fail("CONNECTION_AUTH_REQUIRED", "插件工具目录失效回调必须同步完成");
    }
    const after = assertConnection();
    if (after.revision !== connection.revision
      || after.credentialRef !== connection.credentialRef
      || this.#secrets.getCredentialRevision(connection.credentialRef) !== stored.revision) {
      fail("CONNECTION_IDENTITY_CHANGED", "刷新提交后连接身份已变化");
    }
    return Object.freeze({ connectionId, status: "refreshed", authRevision,
      scopes: Object.freeze([...parsed.scopes]) });
  }
}

module.exports = { PluginCredentialVault, newPluginCredentialRef };
