"use strict";
const { setTimeout: sleep } = require("node:timers/promises");
const { serviceError } = require("./security");
const { validOAuthToken: token } = require("./mcp-transport-utils");
const profiles = require("./data/mcp-oauth-providers.json");
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const error = code => serviceError(code, "连接器设备授权未完成，请重新登录");
const seconds = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
function deviceProfile(record, client) {
  // This allowlist ships with the application. Registry data cannot choose an
  // OAuth client, issuer or credential recipient. Custom clients stay explicit.
  return profiles.find(p => record?.enabled && record.source?.kind === "registry"
    && record.source.registryName === p.registryName && record.transport?.kind === "remote"
    && record.transport.protocol === "streamable-http" && record.transport.url === p.serverUrl
    && (!client || client.shoggothProfileId === p.id && client.client_id === p.clientId && client.issuer === p.issuer)) || null;
}
function tokens(value, now) {
  if (!token(value?.access_token) || String(value.token_type).toLowerCase() !== "bearer"
    || !seconds(value.expires_in, 365 * 86400) || value.refresh_token !== undefined && !token(value.refresh_token)
    || value.refresh_token_expires_in !== undefined && !seconds(value.refresh_token_expires_in, 366 * 86400)) throw error("MCP_OAUTH_FAILED");
  return { access_token: value.access_token, token_type: "Bearer", expires_in: value.expires_in, expiresAt: now + value.expires_in * 1000,
    ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}),
    ...(value.refresh_token_expires_in ? { refresh_token_expires_in: value.refresh_token_expires_in, refreshExpiresAt: now + value.refresh_token_expires_in * 1000 } : {}) };
}
class McpDeviceAuthorization {
  constructor({ fetch, now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }) }) { Object.assign(this, { fetch, now, wait }); }
  async request(url, fields, signal) {
    const response = await this.fetch(url, { ...(fields ? { method: "POST", body: new URLSearchParams(fields).toString() } : {}),
      headers: { Accept: "application/json", ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, signal });
    if (response.status === 429 || response.status >= 500) { void response.body?.cancel().catch(() => {}); throw error("MCP_SERVER_CONNECTION_FAILED"); }
    let value; try { value = await response.json(); } catch { throw error("MCP_OAUTH_FAILED"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || !response.ok && !value.error) throw error("MCP_OAUTH_FAILED");
    return value;
  }
  async start(profile, signal) {
    const metadata = await this.request(profile.metadataUrl, null, signal);
    if (metadata.issuer !== profile.issuer || metadata.device_authorization_endpoint !== profile.deviceAuthorizationEndpoint
      || metadata.token_endpoint !== profile.tokenEndpoint || !metadata.grant_types_supported?.includes(DEVICE_GRANT)) throw error("MCP_OAUTH_CLIENT_CHANGED");
    const grant = await this.request(profile.deviceAuthorizationEndpoint, { client_id: profile.clientId, scope: profile.scope }, signal);
    if (typeof grant.device_code !== "string" || !/^[A-Za-z0-9._~-]{1,1024}$/u.test(grant.device_code)
      || typeof grant.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/u.test(grant.user_code)
      || grant.verification_uri !== profile.verificationUri || !seconds(grant.expires_in, 3600)
      || grant.interval !== undefined && !seconds(grant.interval, 1800)) throw error("MCP_OAUTH_FAILED");
    return { deviceCode: grant.device_code, userCode: grant.user_code, expiresAt: this.now() + grant.expires_in * 1000, interval: (grant.interval ?? 5) * 1000 };
  }
  async authorize(profile, grant, signal) {
    let interval = grant.interval;
    while (!signal.aborted) {
      if (this.now() >= grant.expiresAt) throw error("MCP_OAUTH_EXPIRED");
      await this.wait(Math.min(interval, grant.expiresAt - this.now()), signal);
      if (signal.aborted) throw error("MCP_OAUTH_CANCELLED");
      if (this.now() >= grant.expiresAt) throw error("MCP_OAUTH_EXPIRED");
      const value = await this.request(profile.tokenEndpoint, { client_id: profile.clientId, device_code: grant.deviceCode, grant_type: DEVICE_GRANT }, signal);
      if (value.error === "authorization_pending") continue;
      if (value.error === "slow_down") { interval = Math.max(interval + 5000, seconds(value.interval, 3600) ? value.interval * 1000 : 0); continue; }
      if (["expired_token", "token_expired"].includes(value.error)) throw error("MCP_OAUTH_EXPIRED");
      if (value.error === "access_denied") throw error("MCP_OAUTH_DENIED");
      if (value.error) throw error("MCP_OAUTH_FAILED");
      return tokens(value, this.now());
    }
    throw error("MCP_OAUTH_CANCELLED");
  }
  async refresh(profile, saved) {
    if (!token(saved.refresh_token) || saved.refreshExpiresAt <= this.now()) throw error("MCP_AUTH_REQUIRED");
    const value = await this.request(profile.tokenEndpoint, { client_id: profile.clientId, grant_type: "refresh_token", refresh_token: saved.refresh_token });
    if (value.error) throw error("MCP_AUTH_REQUIRED");
    return tokens(value, this.now());
  }
}
module.exports = { McpDeviceAuthorization, deviceProfile };
