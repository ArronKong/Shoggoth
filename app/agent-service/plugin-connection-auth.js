"use strict";

const { serviceError } = require("./security");

const MAX_TOKEN_LENGTH = 16_384;
const MAX_SCOPES = 128;
const DEFAULT_MIN_VALIDITY_MS = 30_000;

function fail(code, message) { throw serviceError(code, message); }
function validText(value, max = 2048) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function validScopes(value) {
  return Array.isArray(value) && value.length <= MAX_SCOPES
    && value.every((scope) => validText(scope, 256))
    && new Set(value).size === value.length;
}

// A trusted Service adapter supplies Connection metadata and private credentials.
// The refresh callback must update that private source before it resolves. This
// class never persists or returns a credential through a management DTO.
class PluginConnectionAuth {
  #getConnection;
  #readCredential;
  #refreshCredential;
  #now;
  #minValidityMs;
  #refreshes = new Map();

  constructor({ getConnection, readCredential, refreshCredential = null,
    now = Date.now, minValidityMs = DEFAULT_MIN_VALIDITY_MS } = {}) {
    if (typeof getConnection !== "function" || typeof readCredential !== "function"
      || (refreshCredential !== null && typeof refreshCredential !== "function")
      || typeof now !== "function" || !Number.isSafeInteger(minValidityMs)
      || minValidityMs < 0 || minValidityMs > 300_000) {
      throw new TypeError("PluginConnectionAuth requires trusted Connection and credential readers");
    }
    this.#getConnection = getConnection;
    this.#readCredential = readCredential;
    this.#refreshCredential = refreshCredential;
    this.#now = now;
    this.#minValidityMs = minValidityMs;
  }

  credentialProvider({ connectionId, principalIdentity, authRevision,
    endpointIdentity, issuer = null, audience = null, requiredScopes = [] }) {
    if (!validText(connectionId, 128) || !validText(principalIdentity, 1024)
      || !Number.isSafeInteger(authRevision) || authRevision < 1
      || !validText(endpointIdentity) || (issuer !== null && !validText(issuer))
      || (audience !== null && !validText(audience)) || !validScopes(requiredScopes)) {
      fail("CONNECTION_AUTH_REQUIRED", "MCP 连接认证上下文无效");
    }
    const expected = Object.freeze({ connectionId, principalIdentity,
      authRevision, endpointIdentity, issuer, audience,
      requiredScopes: Object.freeze([...requiredScopes]) });
    const provider = async () => {
      this.#assertConnection(expected);
      let credential = await this.#readCredential(connectionId);
      this.#assertConnection(expected);
      this.#assertCredential(expected, credential);
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0) {
        fail("CONNECTION_AUTH_REQUIRED", "MCP 认证时钟无效");
      }
      if (credential.expiresAt <= now + this.#minValidityMs) {
        if (!this.#refreshCredential) fail("CONNECTION_AUTH_REQUIRED", "MCP 凭据已过期");
        let refresh = this.#refreshes.get(connectionId);
        if (!refresh) {
          refresh = Promise.resolve().then(() => this.#refreshCredential({
            connectionId, principalIdentity, authRevision, endpointIdentity,
          }));
          this.#refreshes.set(connectionId, refresh);
          void refresh.finally(() => {
            if (this.#refreshes.get(connectionId) === refresh) this.#refreshes.delete(connectionId);
          }).catch(() => {});
        }
        await refresh;
        this.#assertConnection(expected);
        credential = await this.#readCredential(connectionId);
        this.#assertConnection(expected);
        this.#assertCredential(expected, credential);
        if (credential.expiresAt <= this.#now() + this.#minValidityMs) {
          fail("CONNECTION_AUTH_REQUIRED", "MCP 凭据刷新后仍不可用");
        }
      }
      // The Connection may have been revoked or switched during async secret
      // reading / refresh. Recheck immediately before handing a token to SDK.
      this.#assertConnection(expected);
      return { accessToken: credential.accessToken, principalIdentity,
        authRevision };
    };
    provider.assertCurrent = () => this.#assertConnection(expected);
    return provider;
  }

  #assertConnection(expected) {
    const connection = this.#getConnection(expected.connectionId);
    if (!connection || connection.connectionId !== expected.connectionId
      || connection.state !== "ready"
      || connection.principalIdentity !== expected.principalIdentity
      || connection.authRevision !== expected.authRevision
      || connection.endpointIdentity !== expected.endpointIdentity) {
      fail("CONNECTION_IDENTITY_CHANGED", "MCP 连接身份或认证代次已变化");
    }
  }

  #assertCredential(expected, credential) {
    if (!credential || credential.principalIdentity !== expected.principalIdentity
      || credential.authRevision !== expected.authRevision
      || credential.endpointIdentity !== expected.endpointIdentity
      || (expected.issuer !== null && credential.issuer !== expected.issuer)
      || (expected.audience !== null && credential.audience !== expected.audience)) {
      fail("CONNECTION_IDENTITY_CHANGED", "MCP 凭据与连接身份不一致");
    }
    if (!validScopes(credential.scopes)
      || expected.requiredScopes.some((scope) => !credential.scopes.includes(scope))) {
      fail("CONNECTION_SCOPE_CHANGED", "MCP 凭据缺少已授权 scope");
    }
    if (!validText(credential.accessToken, MAX_TOKEN_LENGTH)
      || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(credential.accessToken)
      || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt < 0) {
      fail("CONNECTION_AUTH_REQUIRED", "MCP 凭据不可用");
    }
  }
}

module.exports = { PluginConnectionAuth };
