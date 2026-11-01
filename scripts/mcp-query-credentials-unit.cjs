#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { validatedQueryCredentials, querySecretVariants } = require("../app/agent-service/mcp-transport-utils");
const { validateConnectorParams, validateConnectorResult } = require("../app/core/connector-dto");

const ENDPOINT = "https://mcp.didichuxing.com/mcp-servers";
const SANDBOX = "https://mcp.didichuxing.com/mcp-servers-sandbox";
const CANARY = "query-canary:opaque+value/with&symbols=%?!'";
const ROTATED = "query-rotated:opaque+value/other&symbols=%?!'";
const transport = (url = ENDPOINT) => ({ kind: "remote", protocol: "streamable-http", url });
function broker() {
  const key = crypto.randomBytes(32);
  return {
    async encrypt(plaintext) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async decrypt(ciphertext) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}
async function fixture(t, behavior = {}, endpoint = ENDPOINT) {
  const root = fs.mkdtempSync("/private/tmp/shoggoth-query-credentials-");
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const cryptoBroker = broker();
  const encrypted = await new EncryptedSecretStore({ paths, cryptoBroker }).open();
  const secrets = new McpConnectorSecrets({ secretStore: encrypted });
  const store = new NativeMcpStore({ paths }).open();
  const requests = [];
  const fetch = async (input, init) => {
    const url = new URL(input), method = String(init.method || "GET").toUpperCase();
    const message = method === "POST" ? JSON.parse(init.body) : null;
    requests.push({ url: url.href, method, rpc: message?.method, redirect: init.redirect });
    assert.equal(url.origin, new URL(endpoint).origin);
    assert.ok([new URL(endpoint).pathname, ...(endpoint === ENDPOINT ? ["/mcp-servers-sandbox"] : [])].includes(url.pathname));
    assert.equal(init.redirect, "manual");
    const altered = await behavior.response?.({ url, method, message, init });
    if (altered) return altered;
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "offline-query-fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: url.href, inputSchema: { type: "object" } }] };
    else if (message.method === "tools/call") result = { content: [{ type: "text", text: [url.href, url.searchParams.get("key"), ...querySecretVariants({ key: url.searchParams.get("key") })].join("\n") }] };
    else throw new Error("Unexpected fixture MCP request");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  };
  const manager = new NativeMcpClientManager({ store, secrets, fetch, readinessTimeoutMs: 1000 });
  const controller = new McpConnectorController({ store, secrets, manager, paths, registry: {}, packageLauncher: {}, oauth: { async close() {} },
    assertSecretSafe(value) { assert.equal(encrypted.matchesPlaintext(value), false, "public config must not include registered secrets"); } }).open();
  t.after(async () => { await controller.close(); await manager.close(); store.close(); await encrypted.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (method, args) => validateConnectorResult(method, await controller.handle(method, validateConnectorParams(method, args)));
  const add = (overrides = {}) => call("connector.mcp.add", { source: { kind: "custom" }, name: "Query provider", option: transport(endpoint), fields: { query: { key: CANARY } }, expectedRevision: store.revision, ...overrides });
  return { root, paths, encrypted, cryptoBroker, secrets, store, manager, controller, requests, call, add };
}

test("query credentials accept opaque visible tokens only at fixed reviewed endpoints", async () => {
  for (const url of [ENDPOINT, SANDBOX]) assert.deepEqual(validatedQueryCredentials(transport(url), { key: CANARY }), { key: CANARY });
  for (const url of ["https://example.test/mcp", "https://mcp.caocaokeji.cn/mcp/api", "http://mcp.didichuxing.com/mcp-servers", `${ENDPOINT}/`, `${ENDPOINT}?key=x`, `${ENDPOINT}?debug=1`, `${ENDPOINT}#fragment`, "https://mcp.didichuxing.com:444/mcp-servers", "https://mcp.didichuxing.com/other", "https://mcp.didichuxing.com.evil.test/mcp-servers"]) {
    assert.throws(() => validatedQueryCredentials(transport(url), { key: CANARY }), { code: "MCP_SERVER_URL_INVALID" });
  }
  for (const query of [{ token: CANARY }, { key: CANARY, extra: "x" }, { key: "" }, { key: "has space" }, { key: "line\r\nbreak" }, { key: "non-ascii-密钥" }, { key: "x".repeat(16385) }]) {
    assert.throws(() => validatedQueryCredentials(transport(), query), { code: "MCP_SECRET_INVALID" });
  }
  assert.throws(() => validatedQueryCredentials({ ...transport(), protocol: "sse" }, { key: CANARY }), { code: "MCP_SERVER_URL_INVALID" });
  assert.throws(() => validatedQueryCredentials({ kind: "stdio-command" }, { key: CANARY }), { code: "MCP_SERVER_URL_INVALID" });
  assert.throws(() => validateConnectorParams("connector.mcp.credentials.update", { id: "x", expectedRevision: 1, fields: { query: { key: CANARY, token: CANARY } } }));
});

test("controller persists query only in ciphertext, injects at fetch, scrubs echoes and rotates by revision", async t => {
  const f = await fixture(t);
  const added = await f.add(), id = added.server.id;
  assert.equal(added.server.status, "ready");
  assert.equal(added.server.transport.url, ENDPOINT);
  assert.equal(added.server.auth.kind, "headers");
  assert.deepEqual(added.server.setup.configuredFields, ["query:key"]);
  assert.throws(() => validateConnectorResult("connector.mcp.add", { ...added, server: { ...added.server, transport: transport(`${ENDPOINT}?key=${encodeURIComponent(CANARY)}`) } }));
  assert.deepEqual((await f.secrets.read(id)).query, { key: CANARY });
  for (const value of querySecretVariants({ key: CANARY })) {
    assert.equal(f.encrypted.matchesPlaintext(`before ${value} after`), true);
    assert.equal(fs.readFileSync(f.paths.nativeMcpRegistryPath, "utf8").includes(value), false);
    assert.equal(fs.readFileSync(f.paths.encryptedSecretsPath, "utf8").includes(value), false);
    assert.equal(JSON.stringify(added).includes(value), false);
  }
  const tools = await f.manager.listTools(id);
  assert.match(tools[0].description, /\[REDACTED\]/u);
  const result = await f.manager.callTool(id, "echo", {});
  for (const value of querySecretVariants({ key: CANARY })) assert.equal(JSON.stringify(result).includes(value), false);
  assert.ok(f.requests.length > 0);
  for (const request of f.requests) assert.equal(new URL(request.url).searchParams.get("key"), CANARY);
  assert.equal(f.store.getPrivate(id).transport.url, ENDPOINT);
  const staleRevision = f.store.revision;
  const start = f.requests.length;
  const updated = await f.call("connector.mcp.credentials.update", { id, expectedRevision: staleRevision, fields: { query: { key: ROTATED } } });
  assert.equal(updated.server.status, "ready");
  const recentPosts = f.requests.slice(start).filter(request => request.method === "POST");
  assert.ok(recentPosts.length > 0);
  for (const request of recentPosts) assert.equal(new URL(request.url).searchParams.get("key"), ROTATED);
  await assert.rejects(f.call("connector.mcp.credentials.update", { id, expectedRevision: staleRevision, fields: { query: { key: CANARY } } }), { code: "MCP_REGISTRY_REVISION_CONFLICT" });
  assert.equal((await f.secrets.read(id)).query.key, ROTATED);
  assert.equal(f.encrypted.matchesPlaintext(CANARY), false);
  assert.equal(f.encrypted.matchesPlaintext(encodeURIComponent(ROTATED)), true);
  await f.manager.closeServer(id);
  f.store.close(); f.store.open();
  await f.encrypted.close(); await f.encrypted.open();
  assert.equal((await f.secrets.read(id)).query.key, ROTATED);
  assert.equal(f.store.get(id).transport.url, ENDPOINT);
});

test("query credential rebind and invalid replacement fail before changing the record or secret", async t => {
  const f = await fixture(t), { server: { id } } = await f.add();
  const before = f.store.revision;
  for (const option of [transport("https://example.test/mcp"), transport("https://mcp.didichuxing.com/unreviewed"), { ...transport(), protocol: "sse" }]) {
    await assert.rejects(f.call("connector.mcp.rebind", { id, option, expectedRevision: before }), { code: "MCP_SERVER_URL_INVALID" });
    assert.equal(f.store.revision, before);
  }
  await assert.rejects(f.call("connector.mcp.credentials.update", { id, fields: { query: { key: "bad\nvalue" } }, expectedRevision: before }), { code: "MCP_SECRET_INVALID" });
  await assert.rejects(f.call("connector.mcp.credentials.update", { id, fields: { oauthClient: { clientId: "bad-mix" } }, expectedRevision: before }), { code: "MCP_SECRET_INVALID" });
  assert.equal(f.store.revision, before);
  assert.equal((await f.secrets.read(id)).query.key, CANARY);
  const rebound = await f.call("connector.mcp.rebind", { id, option: transport(SANDBOX), expectedRevision: before });
  assert.equal(rebound.server.status, "ready");
  assert.equal(rebound.server.transport.url, SANDBOX);
  const other = await f.add({ name: "Other", option: transport("https://example.test/mcp"), fields: {} });
  const revision = f.store.revision;
  await assert.rejects(f.call("connector.mcp.credentials.update", { id: other.server.id, fields: { query: { key: ROTATED } }, expectedRevision: revision }), { code: "MCP_SERVER_URL_INVALID" });
  assert.equal(f.store.revision, revision);
  assert.equal(await f.secrets.read(other.server.id), null);
});

test("raw key URL import and add never persist or expose the credential", async t => {
  const f = await fixture(t);
  for (const name of ["key", "KEY", "%6b%65%79", "api_key", "access_token"]) {
    const url = `${ENDPOINT}?${name}=${encodeURIComponent(CANARY)}`;
    await assert.rejects(f.add({ option: transport(url), fields: {} }), { code: "MCP_SERVER_URL_INVALID" });
    const imported = await f.call("connector.mcp.import", { config: { mcpServers: { DiDi: { url, type: "streamablehttp" } } }, expectedRevision: f.store.revision });
    assert.deepEqual(imported.servers, []);
    assert.deepEqual(imported.errors, [{ name: "DiDi", errorCode: "MCP_SERVER_URL_INVALID" }]);
    assert.equal(JSON.stringify(imported).includes(CANARY), false);
  }
  assert.deepEqual(f.store.list().servers, []);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(f.paths.nativeMcpRegistryPath, "utf8").includes("canary"), false);
});

test("redirects, transport errors and auth failures keep query secrets private without retries", async t => {
  for (const mode of ["redirect-cross-origin", "redirect-same-origin", "network", "auth", "fallback"]) {
    await t.test(mode, async t => {
      const f = await fixture(t, { response({ message, url }) {
        if (message?.method !== "initialize") return null;
        if (mode.startsWith("redirect")) return new Response(null, { status: 307, headers: { location: mode.endsWith("cross-origin") ? `https://example.test/steal?key=${encodeURIComponent(CANARY)}` : `${ENDPOINT}/other?key=${encodeURIComponent(CANARY)}` } });
        if (mode === "network") throw Error(`network failed ${url.href}`);
        if (mode === "auth") return new Response(CANARY, { status: 401 });
        return new Response(CANARY, { status: 404 });
      } });
      const result = await f.add();
      assert.equal(result.server.status, mode === "auth" ? "signedOut" : "failed");
      assert.equal(result.server.auth.kind, "headers");
      assert.equal(JSON.stringify(result).includes(CANARY), false);
      assert.equal(f.requests.filter(request => request.rpc === "initialize").length, 1);
      assert.equal(f.requests.some(request => request.method === "GET"), false, "query auth must not fall back to an unreviewed SSE route");
      if (mode === "network") assert.equal(result.server.lastCheck.errorCode, "MCP_SERVER_CONNECTION_FAILED");
    });
  }
});

test("an uncertain business call with a query key is dispatched once and does not leak its URL", async t => {
  const f = await fixture(t, { response({ message, url }) { if (message?.method === "tools/call") throw Error(`lost response ${url.href}`); } });
  const { server: { id } } = await f.add();
  await assert.rejects(f.manager.callTool(id, "echo", {}), error => {
    assert.equal(error.code, "MCP_SERVER_RESULT_UNKNOWN");
    assert.equal(String(error.message).includes(CANARY), false);
    assert.equal(String(error.message).includes(encodeURIComponent(CANARY)), false);
    return true;
  });
  assert.equal(f.requests.filter(request => request.rpc === "tools/call").length, 1);
});
