"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PluginMcpClient } = require("../app/agent-service/plugin-mcp-client");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");
const { PluginDataScopeLeaseManager } = require("../app/agent-service/plugin-data-scope-lease");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { handle } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");

async function localServer(version, { redirect = false, noCallResponse = false,
  oversizedCall = false, sseCall = false, accounts = null, delayCallMs = 0,
  inputRequired = false } = {}) {
  const state = { calls: 0, methods: [], principals: [], rejectedAuth: 0 };
  const server = http.createServer(async (request, response) => {
    if (redirect) { response.writeHead(302, { location: "https://example.com/mcp" }); response.end(); return; }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(request.method === "GET" ? 405 : 404); response.end(); return;
    }
    const account = accounts?.get(request.headers.authorization);
    if (accounts && !account) {
      state.rejectedAuth += 1;
      response.writeHead(401, { "www-authenticate": "Bearer" }); response.end(); return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 300_000) { response.writeHead(413); response.end(); return; }
    }
    const message = JSON.parse(body);
    state.methods.push(message.method);
    if (noCallResponse && message.method === "tools/call") return;
    const result = inputRequired && message.method === "tools/call"
      ? message.params?.requestState === "fixture-state"
        && message.params?.inputResponses?.prompt?.action === "accept"
        ? { jsonrpc: "2.0", id: message.id, result: { resultType: "complete",
          content: [{ type: "text", text: message.params.inputResponses.prompt.content.name }],
          structuredContent: { echoed: message.params.inputResponses.prompt.content.name },
          isError: false } }
        : { jsonrpc: "2.0", id: message.id, result: { resultType: "input_required",
          inputRequests: { prompt: { method: "elicitation/create",
            params: { mode: "form", message: "Choose a name",
              requestedSchema: { type: "object", properties: { name: { type: "string" } },
                required: ["name"] } } } }, requestState: "fixture-state" } }
      : handle(message, version, state);
    if (inputRequired && message.method === "tools/call") state.calls += 1;
    if (oversizedCall && message.method === "tools/call") {
      result.result.structuredContent.payload = "x".repeat(300_000);
    }
    if (result && account && message.method === "tools/call") {
      state.principals.push(account);
      result.result.structuredContent.account = account;
    }
    if (!result) { response.writeHead(202); response.end(); return; }
    if (delayCallMs && message.method === "tools/call") {
      await new Promise((resolve) => setTimeout(resolve, delayCallMs));
    }
    if (sseCall && message.method === "tools/call") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-mcp-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), trustedRoot: temp });
  const dataScope = { leaseManager: new PluginDataScopeLeaseManager({ paths }),
    installationId: "b".repeat(64), scopeId: "c".repeat(64) };
  try {
  const fixture = path.resolve(__dirname, "fixtures/plugins/mcp-sdk-fixture.cjs");
  for (const version of ["2024-11-05", "2025-11-25"]) {
    let admissions = 0;
    let allowed = false;
    const connection = await PluginMcpClient.connectStdio({ command: process.execPath,
      args: [fixture, version], cwd: __dirname, env: { PATH: process.env.PATH },
      connectionId: `stdio-${version}`, principalIdentity: "fixture-account",
      authorizeEgress: () => { admissions += 1; return allowed; }, timeoutMs: 3000,
      dataScope });
    try {
      assert.deepEqual(connection.getProtocol(), { era: "legacy", version });
      assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["echo"]);
      await assert.rejects(connection.callTool("echo", { value: "denied" }, { runId: "fixture-run" }),
        (error) => error.code === "CAPABILITY_FORBIDDEN");
      allowed = true;
      const result = await connection.callTool("echo", { value: version }, { runId: "fixture-run" });
      assert.equal(result.structuredContent.echoed, version);
      assert.equal(admissions, 2);
      const concurrent = await Promise.all([
        connection.callTool("echo", { value: "agent-a" }, { runId: "agent-a" }),
        connection.callTool("echo", { value: "agent-b" }, { runId: "agent-b" }),
      ]);
      assert.deepEqual(concurrent.map((item) => item.structuredContent.echoed),
        ["agent-a", "agent-b"]);
      assert.equal(admissions, 4);
    } finally { await connection.close(); }
  }
  const interactive = await PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture, "2025-11-25", "elicit"], cwd: __dirname,
    env: { PATH: process.env.PATH }, connectionId: "stdio-elicit",
    principalIdentity: "fixture-account", authorizeEgress: () => true,
    timeoutMs: 3000, dataScope });
  try {
    await interactive.listTools();
    const prompts = [];
    const answered = await interactive.callTool("echo", { value: "__elicit__" },
      { runId: "fixture-run" }, { onElicitation: async request => {
        prompts.push(request);
        return { action: "accept", content: { name: "fixture-user" } };
      } });
    assert.equal(answered.structuredContent.echoed, "fixture-user");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].method, "elicitation/create");
    assert.equal(prompts[0].params.requestedSchema.properties.name.type, "string");
    const cancelled = await interactive.callTool("echo", { value: "__elicit__" },
      { runId: "fixture-run" });
    assert.equal(cancelled.structuredContent.echoed, "cancelled",
      "a call without a trusted Run callback never receives user input");
  } finally { await interactive.close(); }
  const pluginRoot = path.join(temp, "plugin-root");
  fs.mkdirSync(pluginRoot, { mode: 0o700 });
  await assert.rejects(PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture, "2025-11-25"], cwd: temp, pluginRoot,
    env: { PATH: process.env.PATH }, connectionId: "stdio-escaped-cwd",
    principalIdentity: "fixture-account", authorizeEgress: () => {}, timeoutMs: 3000,
    dataScope }), (error) => error.code === "MCP_SERVER_START_FAILED");
  await assert.rejects(PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture, "2025-11-25", "${UNKNOWN}"], cwd: "${PLUGIN_DATA}", pluginRoot,
    env: { PATH: process.env.PATH }, connectionId: "stdio-unknown-template",
    principalIdentity: "fixture-account", authorizeEgress: () => {}, timeoutMs: 3000,
    dataScope }), (error) => error.code === "MCP_SERVER_START_FAILED");
  const templated = await PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture, "2025-11-25", "${PLUGIN_ROOT}/marker", "${PLUGIN_DATA}/marker"],
    cwd: "${PLUGIN_DATA}", pluginRoot,
    env: { PATH: process.env.PATH, FIXTURE_ROOT_REF: "${PLUGIN_ROOT}/marker" },
    connectionId: "stdio-templated", principalIdentity: "fixture-account",
    authorizeEgress: () => {}, timeoutMs: 3000, dataScope });
  try {
    const scope = (await templated.callTool("echo", { value: "__scope__" },
      { runId: "fixture-run" })).structuredContent.scope;
    assert.equal(scope.pluginRoot, fs.realpathSync(pluginRoot));
    assert.equal(scope.cwd, scope.pluginData);
    assert.equal(scope.arg3, `${scope.pluginRoot}/marker`);
    assert.equal(scope.arg4, `${scope.pluginData}/marker`);
    assert.equal(scope.envRootRef, `${scope.pluginRoot}/marker`);
  } finally { await templated.close(); }
  let catalogNotices = 0;
  let admissionsAfterNotice = 0;
  const notifying = await PluginMcpClient.connectStdio({ command: process.execPath,
    args: [fixture, "2025-11-25", "notify"], cwd: __dirname,
    env: { PATH: process.env.PATH }, connectionId: "stdio-notify",
    principalIdentity: "fixture-account",
    authorizeEgress: () => { admissionsAfterNotice += 1; },
    onToolsChanged: () => { catalogNotices += 1; }, timeoutMs: 3000,
    dataScope });
  try {
    assert.equal((await notifying.listTools())[0].description, "Echo fixture input");
    await notifying.callTool("echo", { value: "first" }, { runId: "fixture-run" });
    assert.equal(catalogNotices, 1);
    await assert.rejects(notifying.callTool("echo", { value: "blocked" },
      { runId: "fixture-run" }),
    (error) => error.code === "TOOL_CONTRACT_CHANGED");
    assert.equal(admissionsAfterNotice, 1);
    assert.equal((await notifying.listTools())[0].description, "Echo fixture input 1");
    await notifying.callTool("echo", { value: "second" }, { runId: "fixture-run" });
    assert.equal(catalogNotices, 2);
    assert.equal(admissionsAfterNotice, 2);
  } finally { await notifying.close(); }
  for (const version of ["2025-11-25", "2026-07-28"]) {
    const fixtureServer = await localServer(version);
    let allowed = false;
    let admissions = 0;
    const connection = await PluginMcpClient.connectHttp({ url: fixtureServer.url,
      allowLoopback: true, connectionId: `http-${version}`, principalIdentity: "fixture-account",
      authorizeEgress: () => {
        admissions += 1;
        if (!allowed) { const error = new Error("denied"); error.code = "GRANT_REVOKED"; throw error; }
      }, timeoutMs: 3000 });
    try {
      assert.deepEqual(connection.getProtocol(), {
        era: version === "2026-07-28" ? "modern" : "legacy", version,
      });
      assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["echo"]);
      await assert.rejects(connection.callTool("echo", { value: "denied" }, { runId: "fixture-run" }),
        (error) => error.code === "GRANT_REVOKED");
      assert.equal(fixtureServer.state.calls, 0);
      allowed = true;
      const result = await connection.callTool("echo", { value: "allowed" }, { runId: "fixture-run" });
      assert.equal(result.structuredContent.echoed, "allowed");
      assert.equal(fixtureServer.state.calls, 1);
      assert.equal(admissions, 2);
    } finally { await connection.close(); await fixtureServer.close(); }
  }
  const modernInputServer = await localServer("2026-07-28", { inputRequired: true });
  const modernInput = await PluginMcpClient.connectHttp({ url: modernInputServer.url,
    allowLoopback: true, connectionId: "http-modern-input",
    principalIdentity: "fixture-account", authorizeEgress: () => true, timeoutMs: 3000 });
  try {
    await modernInput.listTools();
    let prompted = 0;
    const resumed = await modernInput.callTool("echo", { value: "needs-input" },
      { runId: "fixture-run" }, { onElicitation: async () => {
        prompted += 1;
        return { action: "accept", content: { name: "modern-user" } };
      }, assertCurrent: () => true });
    assert.equal(resumed.structuredContent.echoed, "modern-user");
    assert.equal(prompted, 1);
    assert.equal(modernInputServer.state.calls, 2, "one accepted form resumes only the original tool call");
    let stillAllowed = true;
    await assert.rejects(modernInput.callTool("echo", { value: "revoked" },
      { runId: "fixture-run" }, { onElicitation: async () => {
        stillAllowed = false;
        return { action: "accept", content: { name: "not-sent" } };
      }, assertCurrent: () => stillAllowed }), error => error.code === "CALL_OUTCOME_UNKNOWN");
    assert.equal(modernInputServer.state.calls, 3,
      "revocation while the form is open prevents the resumed egress");
    await assert.rejects(modernInput.callTool("echo", { value: "no-run" },
      { runId: "fixture-run" }), error => error.code === "CALL_OUTCOME_UNKNOWN");
    assert.equal(modernInputServer.state.calls, 4,
      "a modern input_required result without a trusted callback cannot retry");
    await assert.rejects(modernInput.callTool("echo", { value: "cancelled" },
      { runId: "fixture-run" }, { onElicitation: async () => ({ action: "cancel" }),
        assertCurrent: () => true }), error => error.code === "CALL_OUTCOME_UNKNOWN");
    assert.equal(modernInputServer.state.calls, 5,
      "cancelled form input cannot trigger a second tool send");
  } finally { await modernInput.close(); await modernInputServer.close(); }
  const queuedServer = await localServer("2025-11-25", { delayCallMs: 120 });
  let queueAllowed = true;
  const queuedClient = await PluginMcpClient.connectHttp({ url: queuedServer.url,
    allowLoopback: true, connectionId: "http-queued", principalIdentity: "fixture-account",
    authorizeEgress: () => {
      if (!queueAllowed) {
        const failure = new Error("revoked while queued");
        failure.code = "GRANT_REVOKED";
        throw failure;
      }
    }, timeoutMs: 3000 });
  try {
    const first = queuedClient.callTool("echo", { value: "first" }, { runId: "first" });
    const second = queuedClient.callTool("echo", { value: "second" }, { runId: "second" });
    const deadline = Date.now() + 1000;
    while (queuedServer.state.calls < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(queuedServer.state.calls, 1);
    queueAllowed = false;
    assert.equal((await first).structuredContent.echoed, "first");
    await assert.rejects(second, (error) => error.code === "GRANT_REVOKED");
    assert.equal(queuedServer.state.calls, 1);
    queueAllowed = true;
    const batch = await Promise.allSettled(Array.from({ length: 18 }, (_, index) =>
      queuedClient.callTool("echo", { value: `queued-${index}` }, { runId: "batch" })));
    assert.equal(batch.filter((result) => result.status === "fulfilled").length, 17);
    assert.equal(batch.filter((result) => result.status === "rejected"
      && result.reason.code === "PLUGIN_CONNECTION_BUSY").length, 1);
    assert.equal(queuedServer.state.calls, 18);
  } finally { await queuedClient.close(); await queuedServer.close(); }
  const accounts = new Map([["Bearer fixture-token-a", "account-a"],
    ["Bearer fixture-token-a-rotated", "account-a"],
    ["Bearer fixture-token-b", "account-b"]]);
  const authenticated = await localServer("2025-11-25", { accounts });
  const expiresAt = Date.now() + 120_000;
  const first = { accessToken: "fixture-token-a", principalIdentity: "account-a",
    authRevision: 1, endpointIdentity: authenticated.url,
    scopes: ["issues:read"], expiresAt };
  const second = { accessToken: "fixture-token-b", principalIdentity: "account-b",
    authRevision: 1, endpointIdentity: authenticated.url,
    scopes: ["issues:read"], expiresAt };
  const connections = new Map(["a", "b"].map((suffix) => [`connection-${suffix}`,
    { connectionId: `connection-${suffix}`, principalIdentity: `account-${suffix}`,
      endpointIdentity: authenticated.url, authRevision: 1, state: "ready" }]));
  const credentials = new Map([["connection-a", first], ["connection-b", second]]);
  const auth = new PluginConnectionAuth({
    getConnection: (id) => connections.get(id),
    readCredential: async (id) => credentials.get(id),
  });
  const baseProviderA = auth.credentialProvider({ connectionId: "connection-a",
    principalIdentity: "account-a", authRevision: 1,
    endpointIdentity: authenticated.url, requiredScopes: ["issues:read"] });
  let switchBeforeFetch = false;
  const providerA = async () => {
    const credential = await baseProviderA();
    if (switchBeforeFetch) connections.set("connection-a", {
      ...connections.get("connection-a"), principalIdentity: "account-b", authRevision: 2,
    });
    return credential;
  };
  providerA.assertCurrent = baseProviderA.assertCurrent;
  const clientA = await PluginMcpClient.connectHttp({ url: authenticated.url,
    allowLoopback: true, connectionId: "connection-a", principalIdentity: "account-a",
    authRevision: 1, credentialProvider: providerA,
    authorizeEgress: () => true, timeoutMs: 3000 });
  const clientB = await PluginMcpClient.connectHttp({ url: authenticated.url,
    allowLoopback: true, connectionId: "connection-b", principalIdentity: "account-b",
    authRevision: 1, credentialProvider: auth.credentialProvider({
      connectionId: "connection-b", principalIdentity: "account-b", authRevision: 1,
      endpointIdentity: authenticated.url, requiredScopes: ["issues:read"] }),
    authorizeEgress: () => true, timeoutMs: 3000 });
  try {
    const resultA = await clientA.callTool("echo", { value: "private-a" }, { runId: "a" });
    const resultB = await clientB.callTool("echo", { value: "private-b" }, { runId: "b" });
    assert.equal(resultA.structuredContent.account, "account-a");
    assert.equal(resultB.structuredContent.account, "account-b");
    assert.deepEqual(authenticated.state.principals, ["account-a", "account-b"]);
    first.accessToken = "fixture-token-a-rotated";
    const rotated = await clientA.callTool("echo", { value: "rotated" }, { runId: "a" });
    assert.equal(rotated.structuredContent.account, "account-a");
    first.scopes = [];
    await assert.rejects(clientA.callTool("echo", { value: "scope-lost" }, { runId: "a" }),
      (error) => error.code === "CONNECTION_SCOPE_CHANGED");
    first.scopes = ["issues:read"];
    const callsBeforeMismatch = authenticated.state.calls;
    first.accessToken = "fixture-token-b";
    first.principalIdentity = "account-b";
    await assert.rejects(clientA.callTool("echo", { value: "wrong-account" }, { runId: "a" }),
      (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
    assert.equal(authenticated.state.calls, callsBeforeMismatch);
    first.principalIdentity = "account-a";
    first.accessToken = "invalid-fixture-token";
    await assert.rejects(clientA.callTool("echo", { value: "unauthorized" }, { runId: "a" }),
      (error) => error.code === "CALL_OUTCOME_UNKNOWN");
    assert.equal(authenticated.state.rejectedAuth, 1);
    assert.equal(authenticated.state.calls, callsBeforeMismatch);
    first.accessToken = "fixture-token-a-rotated";
    switchBeforeFetch = true;
    await assert.rejects(clientA.callTool("echo", { value: "identity-race" }, { runId: "a" }),
      (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
    assert.equal(authenticated.state.calls, callsBeforeMismatch);
    switchBeforeFetch = false;
    connections.set("connection-a", { ...connections.get("connection-a"),
      principalIdentity: "account-a", authRevision: 1 });
  } finally {
    await clientA.close(); await clientB.close(); await authenticated.close();
  }
  const redirect = await localServer("2025-11-25", { redirect: true });
  try {
    await assert.rejects(PluginMcpClient.connectHttp({ url: redirect.url, allowLoopback: true,
      connectionId: "redirect", principalIdentity: "fixture-account", authorizeEgress: () => {} }),
    );
    assert.equal(redirect.state.calls, 0);
  } finally { await redirect.close(); }
  const oversized = await localServer("2025-11-25", { oversizedCall: true });
  const limited = await PluginMcpClient.connectHttp({ url: oversized.url,
    allowLoopback: true, connectionId: "oversized", principalIdentity: "fixture-account",
    authorizeEgress: () => true, timeoutMs: 3000 });
  try {
    await assert.rejects(limited.callTool("echo", { value: "large" }, { runId: "fixture" }),
      (error) => error.code === "CALL_OUTCOME_UNKNOWN");
    assert.equal(oversized.state.calls, 1);
  } finally { await limited.close(); await oversized.close(); }
  const streamed = await localServer("2025-11-25", { sseCall: true });
  const streamingClient = await PluginMcpClient.connectHttp({ url: streamed.url,
    allowLoopback: true, connectionId: "streamed", principalIdentity: "fixture-account",
    authorizeEgress: () => true, timeoutMs: 3000 });
  try {
    const result = await streamingClient.callTool("echo", { value: "streamed" },
      { runId: "fixture" });
    assert.equal(result.structuredContent.echoed, "streamed");
    assert.equal(streamed.state.calls, 1);
  } finally { await streamingClient.close(); await streamed.close(); }
  await assert.rejects(PluginMcpClient.connectHttp({ url: "http://example.com/mcp",
    connectionId: "external", principalIdentity: "fixture-account", authorizeEgress: () => {} }),
  (error) => error.code === "MCP_SERVER_URL_INVALID");
  await assert.rejects(PluginMcpClient.connectHttp({ url: "https://example.com/mcp",
    connectionId: "unguarded", principalIdentity: "account-a", authRevision: 1,
    credentialProvider: async () => first, authorizeEgress: () => {} }),
  (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  console.log("plugin MCP SDK local fixture: PASS");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
