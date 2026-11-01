"use strict";

const fs = require("node:fs"), path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");
const { RESOURCE, readJson } = require("./shop-mcp-client");
const CLIENT_ID = "5c733ab2-1903-400a-891e-7ba20c09e2a3";
const DEVICE_URL = "https://accounts.shop.app/oauth/device", TOKEN_URL = "https://accounts.shop.app/oauth/token";
const fail = (code = "OFFICIAL_SKILL_AUTH_FAILED") => { throw Object.assign(new Error(code), { code }); };
const secret = value => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\u0000-\u0020\u007f]/u.test(value);

// This private file belongs to the connector's device authorization, never the
// model or Skill. No credential crosses the public account-result DTO.
function createShopAuth({ root, home, fetch, now = Date.now }) {
  const file = path.join(home, "shop-account.json");
  function load() {
    if (!fs.existsSync(file)) return { schemaVersion: 1, token: null, pending: null };
    let value; try { value = JSON.parse(readPrivateFile(file, { maxBytes: 64 * 1024 })); } catch { fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
    if (value?.schemaVersion !== 1 || !Object.hasOwn(value, "token") || !Object.hasOwn(value, "pending")
      || value.token && (!secret(value.token.accessToken) || value.token.expiresAt !== null && !Number.isFinite(value.token.expiresAt))
      || value.pending && (!secret(value.pending.deviceCode) || !secret(value.pending.userCode)
        || !validOfficialVerificationUrl("shop", value.pending.verificationUrl) || !Number.isFinite(value.pending.expiresAt)
        || !Number.isFinite(value.pending.nextPollAt) || !Number.isFinite(value.pending.intervalMs) || value.pending.intervalMs < 1000)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return value;
  }
  const save = state => atomicWritePrivateFile(file, JSON.stringify(state), { trustedRoot: root });
  async function post(url, fields, signal) {
    let response;
    try { response = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(fields).toString(), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) }); }
    catch (error) { if (signal?.aborted) throw error; fail(); }
    const value = await readJson(response);
    signal?.throwIfAborted();
    if (!response.ok && typeof value?.error !== "string") fail();
    return value;
  }
  const publicPending = state => ({ state: "authorizing", verificationUrl: state.pending.verificationUrl, userCode: state.pending.userCode });
  return {
    getToken() { const state = load(); return state.token && (state.token.expiresAt === null || state.token.expiresAt > now()) ? state.token.accessToken : null; },
    invalidate() { const state = load(); state.token = null; save(state); },
    logout() { load(); if (fs.existsSync(file)) fs.unlinkSync(file); },
    async start(signal) {
      const value = await post(DEVICE_URL, { client_id: CLIENT_ID, resource: RESOURCE, scope: "openid email personal_agent", device_name: "Shoggoth" }, signal);
      const url = value.verification_uri_complete || value.verification_uri;
      if (!secret(value.device_code) || !secret(value.user_code) || !validOfficialVerificationUrl("shop", url)
        || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400
        || value.interval !== undefined && (!Number.isFinite(value.interval) || value.interval < 1 || value.interval > 3600)) fail();
      const intervalMs = (value.interval || 5) * 1000;
      const state = { schemaVersion: 1, token: null, pending: { deviceCode: value.device_code, userCode: value.user_code,
        verificationUrl: url, expiresAt: now() + value.expires_in * 1000, intervalMs, nextPollAt: now() + intervalMs } };
      save(state); return publicPending(state);
    },
    async poll(signal) {
      const state = load(); if (!state.pending) return null;
      if (state.pending.expiresAt <= now()) { state.pending = null; save(state); return { state: "signedOut", errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }; }
      if (state.pending.nextPollAt > now()) return publicPending(state);
      // Persist the rate fence before sending. A restarted process cannot poll
      // more frequently, nor silently restart denied or expired consent.
      state.pending.nextPollAt = now() + state.pending.intervalMs; save(state);
      const value = await post(TOKEN_URL, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: state.pending.deviceCode }, signal);
      if (["authorization_pending", "slow_down"].includes(value.error)) {
        if (value.error === "slow_down") { state.pending.intervalMs += 5000; state.pending.nextPollAt = now() + state.pending.intervalMs; save(state); }
        return publicPending(state);
      }
      if (value.error) { state.pending = null; save(state); return { state: "signedOut", errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }; }
      if (!secret(value.access_token) || String(value.token_type).toLowerCase() !== "bearer"
        || value.expires_in !== undefined && (!Number.isFinite(value.expires_in) || value.expires_in <= 0)) fail();
      state.token = { accessToken: value.access_token, expiresAt: value.expires_in === undefined ? null : now() + value.expires_in * 1000 };
      state.pending = null; save(state); return null;
    },
  };
}
module.exports = { createShopAuth, CLIENT_ID, DEVICE_URL, TOKEN_URL };
