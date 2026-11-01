"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMcpFetch } = require("../app/agent-service/mcp-http-fetch");
test("MCP requests use the configured proxy without changing TLS or disclosing credentials", async () => {
  const requests = [], agents = [];
  class Agent { constructor(options) { agents.push(options); } }
  const fetch = createMcpFetch({ env: { HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "internal.example" }, Agent,
    fetch: async (url, options) => { requests.push({ url, options }); return new Response("{}"); } });
  const signal = AbortSignal.timeout(1000), headers = { Authorization: "Bearer fixture-value" };
  await fetch("https://github.com/login/oauth/access_token", { method: "POST", body: "grant_type=refresh_token", headers, signal, redirect: "manual" });
  assert.equal(agents.length, 1); assert.equal(agents[0].httpsProxy, "http://127.0.0.1:7897");
  assert.equal(agents[0].requestTls, undefined); assert.equal(agents[0].proxyTls, undefined);
  assert.ok(requests[0].options.dispatcher instanceof Agent); assert.equal(requests[0].options.headers, headers); assert.equal(requests[0].options.signal, signal);
  assert.equal(requests[0].options.redirect, "manual");
  await fetch("https://api.githubcopilot.com/mcp/", {}); assert.equal(agents.length, 1);
});
test("loopback and unconfigured clients stay direct; explicit test transports stay injectable", async () => {
  const requests = []; class Agent { constructor() { throw Error("must not create proxy"); } }
  const fetch = createMcpFetch({ env: { HTTPS_PROXY: "http://127.0.0.1:7897" }, Agent, fetch: async (_url, init) => requests.push(init) });
  for (const url of ["http://127.0.0.1:8080/mcp", "http://localhost:8080/mcp", "http://[::1]:8080/mcp"]) await fetch(url, {});
  const direct = createMcpFetch({ env: {}, Agent, fetch: async (_url, init) => requests.push(init) }); await direct("https://example.test/mcp", {});
  assert.ok(requests.every(r => r.dispatcher === undefined));
});
test("proxy conflicts and embedded secrets fail safely without silently bypassing the proxy", async () => {
  for (const env of [{ HTTPS_PROXY: "http://secret@proxy.test" }, { HTTPS_PROXY: "http://one.test", https_proxy: "http://two.test" }]) {
    let sent = false;
    const fetch = createMcpFetch({ env, fetch: async () => { sent = true; } });
    await assert.rejects(fetch("https://github.com/login/oauth/access_token", {}), error => error.code === "MCP_SERVER_CONNECTION_FAILED" && !error.message.includes("secret"));
    assert.equal(sent, false);
  }
});
