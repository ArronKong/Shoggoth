#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { RemoteMcpClient } = require("../app/agent-service/native-mcp-client-manager");
const { connectorPublicError } = require("../app/core/connector-errors");

const endpoint = "https://mcp.fixture.test/mcp";
function fixture({ auth = "none", deniedMethod = "initialize", status = 403, challenge, url = endpoint, headers = {},
  deniedBody = "provider-private-canary", contentType = "text/plain" } = {}) {
  const requests = [], authorizations = [], notices = [];
  const client = new RemoteMcpClient({ id: "access-denied-fixture", auth: { kind: auth }, transport: { kind: "remote", protocol: "streamable-http", url } }, {
    readinessTimeoutMs: 1000,
    headers,
    oauth: {
      authorization: async (id, options) => { authorizations.push({ id, options }); return { Authorization: "Bearer fixture-private-token" }; },
      noteUnauthorized: async (id, response) => { notices.push({ id, status: response.status }); },
    },
    fetch: async (_url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(init.body); requests.push(message.method);
      if (message.method === deniedMethod) return new Response(deniedBody, { status, headers: { "Content-Type": contentType,
        ...(challenge === undefined ? {} : { "WWW-Authenticate": challenge }) } });
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "read_fixture", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "fixture result" }] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return { client, requests, authorizations, notices };
}

test("anonymous 403 without an authorization challenge reports denied access without OAuth or transport retries", async () => {
  for (const challenge of [undefined, "", "   "]) {
    const f = fixture({ challenge });
    try {
      await assert.rejects(f.client.listTools(), error => {
        assert.equal(error.code, "MCP_SERVER_ACCESS_DENIED");
        assert.equal(error.message.includes("provider-private-canary"), false);
        return true;
      });
      assert.deepEqual(f.requests, ["initialize"]);
      assert.equal(f.authorizations.length, 0); assert.equal(f.notices.length, 0);
    } finally { await f.client.close(); }
  }
});

test("a challenge-free 403 preserves an existing OAuth session without refresh or unauthorized discovery", async () => {
  const f = fixture({ auth: "oauth-dcr" });
  try {
    await assert.rejects(f.client.listTools(), { code: "MCP_SERVER_ACCESS_DENIED" });
    assert.equal(f.authorizations.length, 1); assert.equal(f.authorizations[0].options, undefined);
    assert.equal(f.notices.length, 0); assert.deepEqual(f.requests, ["initialize"]);
  } finally { await f.client.close(); }
});

test("401 and explicit 403 authorization challenges retain the existing sign-in path", async () => {
  for (const options of [{ status: 401 }, { status: 403, challenge: 'Bearer error="insufficient_scope", scope="read"' }]) {
    const f = fixture(options);
    try {
      await assert.rejects(f.client.listTools(), { code: "MCP_AUTH_REQUIRED" });
      assert.equal(f.notices.length, 1); assert.equal(f.authorizations.length, 0);
      assert.deepEqual(f.requests, ["initialize"]);
    } finally { await f.client.close(); }
  }
});

test("403 while listing tools is denied access and does not publish a usable inventory", async () => {
  const f = fixture({ deniedMethod: "tools/list" });
  try {
    await assert.rejects(f.client.listTools(), { code: "MCP_SERVER_ACCESS_DENIED" });
    assert.equal(f.requests.filter(value => value === "tools/list").length, 1);
    assert.equal(f.notices.length, 0);
  } finally { await f.client.close(); }
});

test("business calls receiving 403 retain unknown-result status and are never replayed", async () => {
  for (const challenge of [undefined, 'Bearer error="insufficient_scope"']) {
    const f = fixture({ deniedMethod: "tools/call", challenge });
    try {
      await assert.rejects(f.client.callTool("read_fixture", {}), { code: "MCP_SERVER_RESULT_UNKNOWN" });
      assert.equal(f.requests.filter(value => value === "tools/call").length, 1);
      assert.equal(f.authorizations.length, 0);
    } finally { await f.client.close(); }
  }
});

test("the public denied-access error uses fixed wording without provider response content", () => {
  const result = connectorPublicError({ code: "MCP_SERVER_ACCESS_DENIED", message: "provider-private-canary" });
  assert.equal(result.code, "MCP_SERVER_ACCESS_DENIED");
  assert.equal(result.message.includes("403"), true);
  assert.equal(JSON.stringify(result).includes("provider-private-canary"), false);
});

const eastmoney = { url: "https://mxapi.eastmoney.com/mxds/mcp", auth: "headers", headers: { em_api_key: "fixture-private-key" },
  contentType: "application/json;charset=UTF-8", deniedBody: JSON.stringify({ error: "密钥不存在，请联系业务人员处理", detail: "provider-private-canary" }) };

test("Eastmoney's explicit key-not-found 403 identifies a rejected API key without OAuth or retries", async () => {
  for (const deniedMethod of ["initialize", "tools/list"]) {
    const f = fixture({ ...eastmoney, deniedMethod });
    try {
      await assert.rejects(f.client.listTools(), error => {
        assert.equal(error.code, "MCP_API_KEY_INVALID");
        assert.equal(error.message.includes("provider-private-canary"), false);
        assert.equal(error.message.includes("fixture-private-key"), false);
        return true;
      });
      assert.equal(f.requests.filter(method => method === deniedMethod).length, 1);
      assert.equal(f.authorizations.length, 0); assert.equal(f.notices.length, 0);
      assert.equal(f.client.headers.em_api_key, "fixture-private-key", "a rejection never discards the saved credential");
    } finally { await f.client.close(); }
  }
});

test("the key-not-found classification requires the exact provider, API-key auth and bounded JSON signature", async () => {
  for (const patch of [{ url: endpoint }, { url: `${eastmoney.url}/other` }, { url: `${eastmoney.url}?other=1` },
    { auth: "none" }, { headers: {} }, { contentType: "text/plain" }, { deniedBody: "not JSON" },
    { deniedBody: JSON.stringify({ error: "other access restriction" }) },
    { deniedBody: JSON.stringify({ error: ["密钥不存在，请联系业务人员处理"] }) },
    { deniedBody: JSON.stringify({ error: "密钥不存在，请联系业务人员处理", padding: "x".repeat(256 * 1024) }) }]) {
    const f = fixture({ ...eastmoney, ...patch });
    try {
      await assert.rejects(f.client.listTools(), { code: "MCP_SERVER_ACCESS_DENIED" });
      assert.deepEqual(f.requests, ["initialize"]); assert.equal(f.notices.length, 0);
    } finally { await f.client.close(); }
  }
});

test("Eastmoney authorization challenges retain their sign-in contract, and dispatched calls remain unknown", async () => {
  const challenged = fixture({ ...eastmoney, challenge: 'Bearer error="insufficient_scope"' });
  try {
    await assert.rejects(challenged.client.listTools(), { code: "MCP_AUTH_REQUIRED" });
    assert.equal(challenged.notices.length, 1);
  } finally { await challenged.client.close(); }
  const business = fixture({ ...eastmoney, deniedMethod: "tools/call" });
  try {
    await assert.rejects(business.client.callTool("read_fixture", {}), { code: "MCP_SERVER_RESULT_UNKNOWN" });
    assert.equal(business.requests.filter(method => method === "tools/call").length, 1);
    assert.equal(business.notices.length, 0);
  } finally { await business.client.close(); }
});

test("the rejected-key public error gives an actionable MCP-key reason and never exposes server text", () => {
  const result = connectorPublicError({ code: "MCP_API_KEY_INVALID", message: "provider-private-canary" });
  assert.equal(result.code, "MCP_API_KEY_INVALID");
  assert.match(result.message, /API Key/u); assert.match(result.message, /MCP/u);
  assert.equal(JSON.stringify(result).includes("provider-private-canary"), false);
});
