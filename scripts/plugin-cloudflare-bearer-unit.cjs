"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ENDPOINT, VERIFY_URL, verifyCloudflareBearer } =
  require("../app/agent-service/plugin-cloudflare-bearer-verifier");
const { cloudflareToolAccess } =
  require("../app/agent-service/plugin-cloudflare-access-policy");
const { assertReservedOfficialEndpoint } =
  require("../app/agent-service/plugin-reserved-official-endpoints");
const { PluginMcpConnectionManager } =
  require("../app/agent-service/plugin-mcp-connection-manager");
const { componentId } = require("../app/agent-service/plugin-component-catalog");

const token = "cfut_fixture-token";
const id = "100bf38cc8393103870917dd535e0628";
const identity = `cloudflare-token:${id}`;

function fixture({ status = "active", tools = ["search", "execute"],
  success = true } = {}) {
  const requests = [];
  let closed = false;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ success, result: { id, status } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  const connectMcp = async options => {
    assert.equal(options.url, ENDPOINT);
    assert.equal(options.principalIdentity, identity);
    assert.equal((await options.credentialProvider()).accessToken, token);
    assert.throws(() => options.authorizeEgress(), { code: "CONNECTION_AUTH_REQUIRED" });
    return { listTools: async () => tools.map(name => ({ name })),
      close: async () => { closed = true; } };
  };
  return { fetchImpl, connectMcp, requests, get closed() { return closed; } };
}

test("Cloudflare bearer validates the user token and probes the fixed MCP tool contract", async () => {
  const f = fixture();
  assert.equal(await verifyCloudflareBearer(token, f), identity);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, VERIFY_URL);
  assert.equal(f.requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(f.requests[0].init.redirect, "error");
  assert.equal(f.closed, true);
});

test("Cloudflare bearer rejects inactive tokens and incomplete MCP tools", async () => {
  const inactive = fixture({ status: "disabled" });
  await assert.rejects(verifyCloudflareBearer(token, inactive),
    { code: "CONNECTION_AUTH_REQUIRED" });
  assert.equal(inactive.closed, false);
  const missing = fixture({ tools: ["search"] });
  await assert.rejects(verifyCloudflareBearer(token, missing),
    { code: "CONNECTION_AUTH_REQUIRED" });
  assert.equal(missing.closed, true);
});

test("Cloudflare bearer rejects malformed and oversized credentials without network access", async () => {
  const f = fixture();
  await assert.rejects(verifyCloudflareBearer("bad token", f),
    { code: "CONNECTION_AUTH_REQUIRED" });
  await assert.rejects(verifyCloudflareBearer("x".repeat(16_385), f),
    { code: "CONNECTION_AUTH_REQUIRED" });
  await assert.rejects(verifyCloudflareBearer("cfat_account-owned-token", f),
    { code: "CONNECTION_AUTH_REQUIRED" });
  await assert.rejects(verifyCloudflareBearer("cfk_global-key", f),
    { code: "CONNECTION_AUTH_REQUIRED" });
  assert.equal(f.requests.length, 0);
});

test("Cloudflare bearer suppresses remote errors and token text", async () => {
  const f = fixture();
  f.connectMcp = async () => { throw new Error(`remote failure ${token}`); };
  await assert.rejects(verifyCloudflareBearer(token, f), error =>
    error.code === "CONNECTION_AUTH_REQUIRED" && !error.message.includes(token));
});

test("Cloudflare only admits reviewed tools and requires approval for code execution", () => {
  const records = { installation: { sourceIdentity: "bundled:cloudflare" },
    connection: { endpointIdentity: ENDPOINT, principalIdentity: identity } };
  assert.deepEqual(cloudflareToolAccess(records, "search"),
    { allowed: true, requiresEachCall: false });
  assert.deepEqual(cloudflareToolAccess(records, "execute"),
    { allowed: true, requiresEachCall: true });
  assert.equal(cloudflareToolAccess(records, "unreviewed_tool").allowed, false);
  assert.equal(cloudflareToolAccess({ ...records,
    installation: { sourceIdentity: "directory:impersonator" } }, "execute").allowed, false);
});

test("Cloudflare endpoint rejects package impersonation and generic OAuth", () => {
  const pinned = { sourceIdentity: "bundled:cloudflare", componentName: "cloudflare-api",
    serverUrl: ENDPOINT, oauthResource: null };
  assert.equal(assertReservedOfficialEndpoint(pinned), "cloudflare");
  assert.throws(() => assertReservedOfficialEndpoint({ ...pinned,
    sourceIdentity: "local:impersonator" }), { code: "CONNECTION_IDENTITY_CHANGED" });
  assert.throws(() => assertReservedOfficialEndpoint({ ...pinned,
    provider: { id: "impersonator", serverUrl: ENDPOINT } }),
  { code: "CONNECTION_IDENTITY_CHANGED" });
});

test("Cloudflare Service transport hides and rejects unreviewed remote tools", async () => {
  const installationId = "cloudflare-fixture";
  const selectedId = componentId(installationId, "mcp-server", "cloudflare-api");
  const installation = { installationId, sourceIdentity: "bundled:cloudflare",
    releaseDigest: "a".repeat(64), desiredState: "enabled", revision: 1 };
  const binding = { bindingId: "cloudflare-binding", componentId: selectedId,
    connectionId: "cloudflare-connection", enabled: true, revision: 1 };
  const connection = { connectionId: binding.connectionId, installationId,
    componentId: selectedId, endpointIdentity: ENDPOINT,
    principalIdentity: identity, authRevision: 1, state: "ready" };
  const store = {
    paths: { pluginDataDir: "/unused/cloudflare-test-data",
      pluginPackagesDir: "/unused/cloudflare-test-packages" },
    getInstallation: () => installation,
    getRelease: () => ({ components: { mcpServers: [{ name: "cloudflare-api",
      descriptorDigest: "b".repeat(64) }] } }),
    hasPendingInstallationDisable: () => false,
    getConnection: () => connection,
    getBinding: () => binding,
    getAuthorityIncarnation: () => 1,
  };
  const calls = [];
  const handle = { getProtocol: () => "2025-03-26",
    listTools: async () => ["search", "execute", "unreviewed_tool", "docs"].map(name => ({ name })),
    callTool: async name => { calls.push(name); return { ok: true }; },
    readAppResource: async () => ({ ok: true }), release: async () => {} };
  const manager = new PluginMcpConnectionManager({ store,
    resolver: { inspectMcpServer: () => ({ name: "cloudflare-api",
      transport: "streamable-http", spec: { url: ENDPOINT }, oauthResource: null }),
    inspectMcpDependency: () => null },
    pool: { acquireHttp: async () => handle },
    auth: { credentialProvider: () => Object.assign(async () => ({ accessToken: token }),
      { assertCurrent: () => {} }) },
  });
  const client = await manager.acquire({ installation, binding, connection });
  assert.deepEqual((await client.listTools()).map(tool => tool.name),
    ["search", "execute", "docs"]);
  assert.throws(() => client.callTool("unreviewed_tool", {}), { code: "CAPABILITY_FORBIDDEN" });
  assert.deepEqual(calls, []);
  await client.callTool("search", {});
  assert.deepEqual(calls, ["search"]);
  await client.release();
});
