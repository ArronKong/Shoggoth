#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { McpOAuthClient } = require("../app/agent-service/mcp-oauth-client");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { validateConnectorResult } = require("../app/core/connector-dto");
const { deviceProfile } = require("../app/agent-service/mcp-device-authorization");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const DEVICE = "device-private-canary", ACCESS = "access-private-canary", REFRESH = "refresh-private-canary";
function fixture(responses = []) {
  let now = 1000, pending;
  const delays = [], requests = [], values = new Map(), events = [];
  const record = { id: "github", enabled: true, source: { kind: "registry", registryName: "io.github.github/github-mcp-server", version: "1" }, transport: { kind: "remote", protocol: "streamable-http", url: "https://api.githubcopilot.com/mcp/" }, auth: { kind: "oauth-dcr" }, secretRef: null, updatedAt: 1 };
  const store = { revision: 1, getPrivate: () => record, get: () => record, update({ patch }) { Object.assign(record, patch); this.revision++; } };
  const secrets = new McpConnectorSecrets({ secretStore: { get: async id => values.get(id) ?? null, put: async (id, value) => values.set(id, value), delete: async id => values.delete(id) } });
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const oauth = new McpOAuthClient({ store, secrets, now: () => now, onChange: e => events.push(e),
    deviceSleep: (delay, signal) => new Promise((resolve, reject) => { delays.push(delay); const abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); pending = () => { signal.removeEventListener("abort", abort); now += delay; resolve(); }; }),
    fetch: async (input, init = {}) => {
      const url = String(input); requests.push({ url, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
      if (url.includes(".well-known/oauth-authorization-server")) return json({ issuer: "https://github.com/login/oauth", device_authorization_endpoint: "https://github.com/login/device/code", token_endpoint: "https://github.com/login/oauth/access_token", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"] });
      if (url === "https://github.com/login/device/code") return json({ device_code: DEVICE, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
      if (url === "https://github.com/login/oauth/access_token") { const response = responses.shift(); return typeof response === "function" ? response() : json(response || { error: "authorization_pending", error_description: ACCESS }); }
      throw Error("Unexpected endpoint");
    } });
  return { oauth, record, store, secrets, requests, events, delays, json,
    tick: async () => { assert.ok(pending); const resolve = pending; pending = null; resolve(); await flush(); },
    expire: () => { now += 901000; }, values };
}
test("device grants share opaque-token validation through initial login and refresh", async () => {
  const access=`user:grant:${ACCESS}`, refresh=`user:grant:${REFRESH}`, renewed=`user:grant:renewed-${ACCESS}`;
  const f=fixture([{access_token:access,refresh_token:refresh,token_type:"bearer",expires_in:3600},
    {access_token:renewed,refresh_token:refresh,token_type:"Bearer",expires_in:3600}]);
  try {
    const start=await f.oauth.start("github");await f.tick();
    assert.equal(f.oauth.get(start.signInId).status,"authorized");
    assert.equal((await f.oauth.authorization("github")).Authorization,`Bearer ${access}`);
    assert.equal((await f.oauth.authorization("github",{forceRefresh:true})).Authorization,`Bearer ${renewed}`);
    assert.equal(f.requests.at(-1).body.refresh_token,refresh);
    assert.equal(JSON.stringify(f.events).includes(ACCESS),false);
  }finally{await f.oauth.close();}
});
test("official GitHub device login displays only the user code, respects pending/slow_down, persists encrypted credentials", async () => {
  const f = fixture([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }]);
  try {
    const started = await f.oauth.start("github");
    assert.equal(started.flow, "device"); assert.equal(started.userCode, "ABCD-EFGH"); assert.equal(started.authorizationUrl, "https://github.com/login/device"); assert.equal(started.redirectUri, null);
    assert.equal(started.installationUrl, "https://github.com/apps/shoggoth-desktop/installations/new");
    validateConnectorResult("connector.mcp.signin.start", started);
    assert.equal(JSON.stringify(started).includes(DEVICE), false);
    assert.equal(f.requests[1].body.client_id, "Iv23liggYIvEK3Fvs4Pz"); assert.equal(f.requests[1].body.scope, "offline_access");
    await f.tick(); await f.tick(); await f.tick();
    assert.deepEqual(f.delays, [5000, 5000, 10000]);
    const complete = f.oauth.get(started.signInId); assert.equal(complete.status, "authorized"); assert.equal(complete.userCode, null);
    assert.equal(f.record.auth.kind, "oauth-client"); assert.equal(f.record.secretRef, "mcp-connector:github");
    const saved = await f.secrets.read("github"); assert.equal(saved.oauthToken.access_token, ACCESS); assert.equal(saved.oauthToken.refresh_token, REFRESH);
    assert.equal((await f.oauth.authorization("github")).Authorization, `Bearer ${ACCESS}`);
    assert.equal(JSON.stringify(f.events).includes(DEVICE), false); assert.equal(JSON.stringify(f.events).includes(ACCESS), false);
    assert.throws(() => validateConnectorResult("connector.mcp.signin.get", { ...complete, deviceCode: DEVICE }));
  } finally { await f.oauth.close(); }
});
test("device refusal, local expiry and cancellation stop polling and never save credentials", async () => {
  for (const mode of ["denied", "expiry", "cancel"]) {
    const f = fixture([{ error: "access_denied", error_description: ACCESS }]);
    try {
      const start = await f.oauth.start("github");
      if (mode === "expiry") f.expire();
      if (mode === "cancel") f.oauth.cancel(start.signInId); else await f.tick();
      await flush();
      const status = f.oauth.get(start.signInId);
      assert.equal(status.status, mode === "expiry" ? "expired" : mode === "cancel" ? "cancelled" : "failed");
      assert.equal(status.errorCode, mode === "expiry" ? "MCP_OAUTH_EXPIRED" : mode === "cancel" ? null : "MCP_OAUTH_DENIED");
      assert.equal(status.userCode, null); assert.equal(await f.secrets.read("github"), null);
      assert.equal(JSON.stringify(status).includes(ACCESS), false);
    } finally { await f.oauth.close(); }
  }
});
test("late device token cannot cross cancellation or a changed registry/resource binding", async () => {
  for (const change of ["cancel", "url", "source"]) {
    let release;
    const f = fixture([() => new Promise(resolve => { release = () => resolve(f.json({ access_token: ACCESS, token_type: "bearer" })); })]);
    try {
      const start = await f.oauth.start("github"); await f.tick(); assert.ok(release);
      if (change === "cancel") f.oauth.cancel(start.signInId);
      if (change === "url") f.record.transport = { ...f.record.transport, url: "https://other.example/mcp" };
      if (change === "source") f.record.source = { kind: "custom" };
      release(); await flush(); assert.equal(await f.secrets.read("github"), null);
      assert.notEqual(f.oauth.get(start.signInId).status, "authorized");
    } finally { await f.oauth.close(); }
  }
});
test("device refresh needs no shared secret, rotates once, survives Service restart and rejects a changed binding", async () => {
  const f = fixture([{ access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }, { access_token: "rotated-access", token_type: "bearer", expires_in: 28800, refresh_token: "rotated-refresh" }]);
  try {
    await f.oauth.start("github"); await f.tick();
    f.oauth.open(); // Service restart drops pending sessions, encrypted authorization remains.
    const headers = await Promise.all(Array.from({ length: 8 }, () => f.oauth.authorization("github", { forceRefresh: true })));
    assert.ok(headers.every(h => h.Authorization === "Bearer rotated-access"));
    const refreshes = f.requests.filter(r => r.body?.grant_type === "refresh_token"); assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].body.client_secret, undefined); assert.equal(refreshes[0].body.refresh_token, REFRESH);
    f.record.source = { kind: "custom" };
    await assert.rejects(f.oauth.authorization("github", { forceRefresh: true }));
    assert.equal(f.requests.filter(r => r.body?.grant_type === "refresh_token").length, 1);
  } finally { await f.oauth.close(); }
});
test("only the pinned official Registry resource gets the shipped client; custom OAuth remains user-owned", async () => {
  const f = fixture();
  try {
    assert.ok(deviceProfile(f.record));
    assert.equal(deviceProfile({ ...f.record, source: { kind: "custom" } }), null);
    assert.equal(deviceProfile({ ...f.record, transport: { ...f.record.transport, url: "https://other.example/mcp" } }), null);
    assert.equal(deviceProfile(f.record, { client_id: "explicit-user-client" }), null);
    const fetch = f.oauth.fetch;
    f.oauth.fetch = async (input, init) => String(input).includes(".well-known/") ? f.json({ issuer: "https://github.com/login/oauth", token_endpoint: "https://other.example/token" }) : fetch(input, init);
    await assert.rejects(f.oauth.start("github"), { code: "MCP_OAUTH_CLIENT_CHANGED" });
    assert.equal(f.requests.length, 0, "changed issuer endpoints are rejected before sending a device/client request");
  } finally { await f.oauth.close(); }
});
test("cancellation during encrypted commit removes the late token without enabling the connector", async () => {
  const f = fixture([{ access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }]);
  let release, block = true;
  const put = f.secrets.secretStore.put;
  f.secrets.secretStore.put = async (...args) => { if (block) { block = false; await new Promise(resolve => { release = resolve; }); } return put(...args); };
  try {
    const start = await f.oauth.start("github"); await f.tick(); assert.ok(release);
    f.oauth.cancel(start.signInId); release(); await flush();
    assert.equal(f.oauth.get(start.signInId).status, "cancelled"); assert.equal((await f.secrets.read("github")).oauthToken, undefined);
    assert.equal(f.record.secretRef, null); assert.equal(f.record.auth.kind, "oauth-dcr");
  } finally { await f.oauth.close(); }
});
test("losing discovery metadata cannot turn a first-party token into an unbound bearer credential", async () => {
  const f = fixture([{ access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }]);
  try {
    await f.oauth.start("github"); await f.tick(); await f.secrets.write("github", { oauthDiscovery: null });
    f.record.transport = { ...f.record.transport, url: "https://other.example/mcp" };
    await assert.rejects(f.oauth.authorization("github"), { code: "MCP_OAUTH_CLIENT_CHANGED" });
  } finally { await f.oauth.close(); }
});
test("a concurrent read-only status check does not invalidate a successful token refresh", async () => {
  const f = fixture([{ access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }, () => {
    f.record.updatedAt++;
    return f.json({ access_token: "fresh-after-check", token_type: "bearer", expires_in: 28800, refresh_token: "fresh-refresh-after-check" });
  }]);
  f.store.getPrivate = () => structuredClone(f.record);
  try {
    await f.oauth.start("github"); await f.tick();
    assert.equal((await f.oauth.authorization("github", { forceRefresh: true })).Authorization, "Bearer fresh-after-check");
    assert.equal((await f.secrets.read("github")).oauthToken.access_token, "fresh-after-check");
  } finally { await f.oauth.close(); }
});
test("transient refresh failures preserve encrypted credentials and never report a sign-out", async () => {
  for (const mode of ["network", "server", "throttled"]) {
    const f = fixture([{ access_token: ACCESS, token_type: "bearer", expires_in: 28800, refresh_token: REFRESH }, () => {
      if (mode === "network") throw Error(ACCESS);
      return new Response(JSON.stringify({ error: "server_error", error_description: REFRESH }), { status: mode === "server" ? 503 : 429 });
    }]);
    try {
      await f.oauth.start("github"); await f.tick();
      await assert.rejects(f.oauth.authorization("github", { forceRefresh: true }), error => error.code === "MCP_SERVER_CONNECTION_FAILED" && !error.message.includes(ACCESS));
      assert.equal((await f.secrets.read("github")).oauthToken.refresh_token, REFRESH);
      assert.equal(f.events.some(e => e.status === "signedOut"), false);
      assert.equal(f.requests.filter(r => r.body?.grant_type === "refresh_token").length, 1, "no automatic replay of a refresh POST");
    } finally { await f.oauth.close(); }
  }
});
