"use strict";

const assert = require("node:assert/strict");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");

async function main() {
  let now = 1_000_000;
  const endpointIdentity = "https://fixture.example/mcp";
  const connections = new Map();
  const credentials = new Map();
  for (const suffix of ["a", "b"]) {
    const connectionId = `connection-${suffix}`;
    connections.set(connectionId, { connectionId, state: "ready",
      principalIdentity: `account-${suffix}`, authRevision: 1, endpointIdentity });
    credentials.set(connectionId, { accessToken: `fixture-token-${suffix}`,
      principalIdentity: `account-${suffix}`, authRevision: 1, endpointIdentity,
      issuer: "https://fixture.example", audience: "fixture-api",
      scopes: ["issues:read", "issues:write"], expiresAt: now + 120_000 });
  }
  let refreshes = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const auth = new PluginConnectionAuth({
    getConnection: (id) => connections.get(id),
    readCredential: async (id) => credentials.get(id),
    async refreshCredential({ connectionId }) {
      refreshes += 1;
      await refreshGate;
      const old = credentials.get(connectionId);
      credentials.set(connectionId, { ...old, accessToken: "rotated-a",
        expiresAt: now + 120_000 });
    },
    now: () => now,
  });
  const providerA = auth.credentialProvider({ connectionId: "connection-a",
    principalIdentity: "account-a", authRevision: 1, endpointIdentity,
    issuer: "https://fixture.example", audience: "fixture-api",
    requiredScopes: ["issues:read"] });
  const providerB = auth.credentialProvider({ connectionId: "connection-b",
    principalIdentity: "account-b", authRevision: 1, endpointIdentity,
    requiredScopes: ["issues:read"] });
  assert.equal((await providerA()).accessToken, "fixture-token-a");
  assert.equal((await providerB()).accessToken, "fixture-token-b");

  credentials.set("connection-a", { ...credentials.get("connection-a"),
    expiresAt: now + 20_000 });
  const firstRefresh = providerA();
  const secondRefresh = providerA();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  releaseRefresh();
  assert.equal((await firstRefresh).accessToken, "rotated-a");
  assert.equal((await secondRefresh).accessToken, "rotated-a");
  assert.equal(refreshes, 1);
  assert.equal((await providerB()).accessToken, "fixture-token-b");

  credentials.set("connection-a", { ...credentials.get("connection-a"),
    scopes: ["issues:write"] });
  await assert.rejects(providerA(), (error) => error.code === "CONNECTION_SCOPE_CHANGED");
  credentials.set("connection-a", { ...credentials.get("connection-a"),
    scopes: ["issues:read", "issues:write"], issuer: "https://other.example" });
  await assert.rejects(providerA(), (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  credentials.set("connection-a", { ...credentials.get("connection-a"),
    issuer: "https://fixture.example", accessToken: "bad\r\ntoken" });
  await assert.rejects(providerA(), (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  credentials.set("connection-a", { ...credentials.get("connection-a"),
    accessToken: "rotated-a" });
  connections.set("connection-a", { ...connections.get("connection-a"),
    principalIdentity: "account-b", authRevision: 2 });
  await assert.rejects(providerA(), (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal((await providerB()).accessToken, "fixture-token-b");

  const noRefresh = new PluginConnectionAuth({ getConnection: (id) => connections.get(id),
    readCredential: async (id) => credentials.get(id), now: () => now });
  credentials.set("connection-b", { ...credentials.get("connection-b"),
    expiresAt: now + 1 });
  await assert.rejects(noRefresh.credentialProvider({ connectionId: "connection-b",
    principalIdentity: "account-b", authRevision: 1, endpointIdentity })(),
  (error) => error.code === "CONNECTION_AUTH_REQUIRED");

  let releaseLateRefresh;
  const lateGate = new Promise((resolve) => { releaseLateRefresh = resolve; });
  const lateAuth = new PluginConnectionAuth({
    getConnection: (id) => connections.get(id),
    readCredential: async (id) => credentials.get(id),
    refreshCredential: async () => { await lateGate; },
    now: () => now,
  });
  const pending = lateAuth.credentialProvider({ connectionId: "connection-b",
    principalIdentity: "account-b", authRevision: 1, endpointIdentity })();
  await new Promise((resolve) => setImmediate(resolve));
  connections.set("connection-b", { ...connections.get("connection-b"),
    state: "disconnected", authRevision: 2 });
  releaseLateRefresh();
  await assert.rejects(pending, (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  console.log("plugin connection auth local fixture: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
