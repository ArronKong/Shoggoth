#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpOAuthClient } = require("../app/agent-service/mcp-oauth-client");
const { McpOAuthCallback } = require("../app/agent-service/mcp-oauth-callback");
const { McpConnectorSecrets } = require("../app/agent-service/mcp-connector-secrets");
const { startFixture, CANARY } = require("./fixtures/mcp-connector-http-fixture.cjs");
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function memorySecrets() {
  const values = new Map();
  const secretStore = { get: async id => values.get(id) ?? null, put: async (id, raw) => values.set(id, raw), delete: async id => values.delete(id) };
  return new McpConnectorSecrets({ secretStore });
}
async function freePort() { const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
function remote(id, url, auth = "none", protocol = "streamable-http") { return { id, name: id, enabled: true, secretRef: null, transport: { kind: "remote", protocol, url }, auth: { kind: auth }, updatedAt: 1 }; }
function storeOf(...items) { const map = new Map(items.map(item => [item.id, item])); return { revision:1, get: id => map.get(id), getPrivate: id => map.get(id), map, update({id,patch}){map.set(id,{...map.get(id),...patch});this.revision++;} }; }
async function login(oauth, id, { badState = false } = {}) {
  const start = await oauth.start(id); assert.equal(start.status, "pending");
  const authURL = new URL(start.authorizationUrl);
  assert.equal(authURL.searchParams.get("code_challenge_method"), "S256"); assert.ok(authURL.searchParams.get("resource"));
  if (badState) { const bad = new URL(start.redirectUri); bad.searchParams.set("state", "forged"); bad.searchParams.set("code", "fake"); assert.equal((await fetch(bad)).status, 400); assert.equal(oauth.get(start.signInId).status, "pending"); }
  const response = await fetch(authURL, { redirect: "manual" }); const callback = response.headers.get("location");
  assert.equal((await fetch(callback)).status, 200); assert.equal(oauth.get(start.signInId).status, "authorized");
  assert.equal((await fetch(callback)).status, 400);
  return start;
}
test("HTTP negotiation, remote tool invocation, bounded responses, redirects and secret headers", async () => {
  const fixture = await startFixture(); const secrets = memorySecrets(); const store = storeOf(remote("public", `${fixture.origin}/public`), remote("huge", `${fixture.origin}/huge`), remote("redirect", `${fixture.origin}/redirect`));
  const manager = new NativeMcpClientManager({ store, secrets });
  try {
    await secrets.write("public", { headers: { "X-Api-Key": CANARY } }); store.update({id:"public",patch:{secretRef:"mcp-connector:public"}});
    assert.equal((await manager.listTools("public"))[0].name, "echo");
    assert.deepEqual(await manager.callTool("public", "echo", { value: "working" }), { content: [{ type: "text", text: "working" }] });
    assert.equal(fixture.state.requests.some(request => request.method === "server/discover"), false, "legacy peers retain the original handshake");
    assert.deepEqual(await manager.callTool("public", "echo", { value: CANARY }), { content: [{ type: "text", text: "[REDACTED]" }] });
    await assert.rejects(manager.listTools("huge"), e => e.code === "MCP_SERVER_RESPONSE_TOO_LARGE");
    await assert.rejects(manager.listTools("redirect"), e => e.code === "MCP_SERVER_URL_INVALID");
  } finally { await manager.close(); await fixture.close(); }
});
test("explicit modern-only peers negotiate once and retain the no-replay boundary", async () => {
  const fixture = await startFixture(); fixture.state.modernVersions = ["2026-07-28"];
  const store = storeOf(remote("modern", `${fixture.origin}/public`), remote("modern-lost", `${fixture.origin}/disconnect`));
  const manager = new NativeMcpClientManager({ store });
  try {
    assert.equal((await manager.listTools("modern"))[0].name, "echo");
    assert.deepEqual(fixture.state.requests.map(request => request.method), ["initialize", "server/discover", "tools/list"]);
    for (const request of fixture.state.requests.slice(1)) assert.equal(request.protocolVersion, "2026-07-28");
    assert.equal((await manager.callTool("modern", "echo", { value: "modern" })).content[0].text, "modern");
    await assert.rejects(manager.callTool("modern-lost", "echo", { value: "uncertain" }), { code: "MCP_SERVER_RESULT_UNKNOWN" });
    assert.equal(fixture.state.calls, 2, "a disconnected business call is sent only once");
    assert.equal(fixture.state.requests.filter(request => request.method === "server/discover").length, 2, "one negotiation per connection");
    assert.equal(fixture.state.sseAttempts, 0);
  } finally { await manager.close(); await fixture.close(); }
});
test("unknown or malformed version offers and failed discovery do not loop or downgrade", async () => {
  for (const [versions, rejectDiscovery, expectedDiscovery] of [
    [["2099-01-01"], false, 0],
    [["2026-07-28", null], false, 0],
    [["2026-07-28"], true, 1],
  ]) {
    const fixture = await startFixture(); fixture.state.modernVersions = versions; fixture.state.rejectDiscovery = rejectDiscovery;
    const manager = new NativeMcpClientManager({ store: storeOf(remote("version", `${fixture.origin}/public`)) });
    try {
      await assert.rejects(manager.listTools("version"), { code: "MCP_SERVER_CONNECTION_FAILED" });
      assert.equal(fixture.state.requests.filter(request => request.method === "initialize").length, 1);
      assert.equal(fixture.state.requests.filter(request => request.method === "server/discover").length, expectedDiscovery);
      assert.equal(fixture.state.requests.some(request => request.method === "tools/list"), false);
      assert.equal(fixture.state.sseAttempts, 0); assert.equal(fixture.state.calls, 0);
    } finally { await manager.close(); await fixture.close(); }
  }
});
test("Streamable HTTP falls back only on first negotiation 400/404/405", async () => {
  const fixture = await startFixture(); const store = storeOf(remote("sse", `${fixture.origin}/sse`)); const manager = new NativeMcpClientManager({ store });
  try { for (const status of [400, 404, 405]) { fixture.state.firstPostStatus = status; assert.equal((await manager.probe(store.get("sse")))[0].name, "echo"); } assert.equal(fixture.state.sseAttempts, 3); }
  finally { await manager.close(); await fixture.close(); }
});
test("OAuth DCR, PKCE, resource, state forgery/replay, refresh serialization and rejection", async () => {
  const fixture = await startFixture(); const secrets = memorySecrets(); const store = storeOf(remote("oauth", `${fixture.origin}/mcp`, "oauth-dcr"));
  const changes = []; const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value) });
  const manager = new NativeMcpClientManager({ store, secrets, oauth });
  try {
    await assert.rejects(manager.listTools("oauth"), e => e.code === "MCP_AUTH_REQUIRED");
    const start = await login(oauth, "oauth", { badState: true });
    assert.equal(fixture.state.registrations.length, 1); assert.equal(fixture.state.exchanges.length, 1);
    assert.ok(!JSON.stringify(start).includes(CANARY)); assert.ok(!JSON.stringify(changes).includes(CANARY));
    assert.equal((await manager.listTools("oauth"))[0].name, "echo");
    await Promise.all(Array.from({ length: 8 }, () => oauth.authorization("oauth", { forceRefresh: true })));
    assert.equal(fixture.state.refreshes, 1);
    fixture.state.token = "server-now-requires-fresh-token";
    assert.equal((await manager.listTools("oauth"))[0].name, "echo"); assert.equal(fixture.state.refreshes, 2);
    fixture.state.refreshDenied = true;
    await assert.rejects(oauth.authorization("oauth", { forceRefresh: true }), e => e.code === "MCP_AUTH_REQUIRED");
    assert.equal((await secrets.read("oauth")).oauthToken, undefined);
  } finally { await manager.close(); await oauth.close(); await fixture.close(); }
});
test("Opaque OAuth tokens survive callback, saved authorization, refresh and MCP negotiation", async () => {
  // Workers OAuth Provider issues userId:grantId:secret, not a base64/JWT-only token.
  const accessToken = `fixture-user:fixture-grant:${CANARY}`, refreshedToken = `fixture-user:fixture-grant:refreshed-${CANARY}`;
  const fixture = await startFixture({ accessToken, refreshAccessToken: refreshedToken });
  const secrets = memorySecrets(), store = storeOf(remote("opaque", `${fixture.origin}/mcp`, "oauth-dcr")), changes = [];
  const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value) });
  const manager = new NativeMcpClientManager({ store, secrets, oauth });
  try {
    const start = await login(oauth, "opaque", { badState: true });
    assert.equal(fixture.state.exchanges.length, 1);
    assert.equal((await secrets.read("opaque")).oauthToken.access_token, accessToken);
    assert.equal((await oauth.authorization("opaque")).Authorization, `Bearer ${accessToken}`);
    assert.equal((await manager.listTools("opaque"))[0].name, "echo");
    await oauth.close(); oauth.open();
    assert.equal((await oauth.authorization("opaque")).Authorization, `Bearer ${accessToken}`);
    await manager.closeServer("opaque");
    assert.equal((await oauth.authorization("opaque", { forceRefresh: true })).Authorization, `Bearer ${refreshedToken}`);
    assert.equal(fixture.state.refreshes, 1);
    assert.equal(fixture.state.refreshRequests[0].refresh_token, "fixture-refresh");
    fixture.state.echoTokenInTools = true;
    assert.equal((await manager.listTools("opaque"))[0].description, "[REDACTED]");
    assert.equal((await secrets.read("opaque")).oauthToken.access_token, refreshedToken);
    for (const value of [start, changes]) {
      assert.equal(JSON.stringify(value).includes(accessToken), false);
      assert.equal(JSON.stringify(value).includes(refreshedToken), false);
    }
  } finally { await manager.close(); await oauth.close(); await fixture.close(); }
});
test("OAuth rejects whitespace, controls, non-ASCII and oversized tokens before persistence or dispatch", async () => {
  const invalidTokens = ["", " leading", "trailing ", "has space", "has\ttab", "token\r\nX-Injected: value", "token\0nul", "token\x7fdel", "token-é", "x".repeat(16385)];
  for (const accessToken of invalidTokens) {
    const fixture = await startFixture({ accessToken }), secrets = memorySecrets(), store = storeOf(remote("invalid", `${fixture.origin}/mcp`, "oauth-dcr"));
    const changes = [], oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value) });
    try {
      const start = await oauth.start("invalid"), redirect = await fetch(start.authorizationUrl, { redirect: "manual" });
      const response = await fetch(redirect.headers.get("location"));
      assert.equal(response.status, 400); assert.equal((await response.text()).includes("X-Injected"), false);
      assert.equal(oauth.get(start.signInId).status, "failed");
      assert.ok(["MCP_SERVER_RESPONSE_INVALID", "MCP_OAUTH_FAILED"].includes(oauth.get(start.signInId).errorCode));
      assert.equal(await secrets.read("invalid"), null); assert.equal(store.get("invalid").secretRef, null);
      assert.equal(fixture.state.exchanges.length, 1); assert.equal(JSON.stringify(changes).includes("X-Injected"), false);
    } finally { await oauth.close(); await fixture.close(); }
  }
  const fixture = await startFixture(), secrets = memorySecrets(), store = storeOf(remote("saved-invalid", `${fixture.origin}/mcp`, "oauth-dcr"));
  const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort() });
  try {
    await login(oauth, "saved-invalid");
    const saved = await secrets.read("saved-invalid");
    await secrets.write("saved-invalid", { oauthToken: { ...saved.oauthToken, access_token: "token\r\nX-Injected: value" } });
    await assert.rejects(oauth.authorization("saved-invalid"), { code: "MCP_AUTH_REQUIRED" });
    assert.equal(fixture.state.refreshes, 0);
    await secrets.write("saved-invalid", { oauthToken: saved.oauthToken });
    fixture.state.refreshAccessToken = "token\r\nX-Injected: value";
    await assert.rejects(oauth.authorization("saved-invalid", { forceRefresh: true }), { code: "MCP_AUTH_REQUIRED" });
    assert.equal(fixture.state.refreshes, 1); assert.equal((await secrets.read("saved-invalid")).oauthToken, undefined);
  } finally { await oauth.close(); await fixture.close(); }
});
test("OAuth callback preserves safe network and vault failures and still rejects a changed issuer", async () => {
  for (const [mode, expectedCode] of [["network", "MCP_SERVER_CONNECTION_FAILED"], ["vault", "MCP_CREDENTIALS_LOCKED"], ["issuer", "MCP_OAUTH_FAILED"]]) {
    const fixture = await startFixture(), secrets = memorySecrets(), store = storeOf(remote("failure", `${fixture.origin}/mcp`, "oauth-dcr")), changes = [];
    const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value), fetch: async (input, init) => {
      if (mode === "network" && new URL(input).pathname === "/token") throw Error(CANARY);
      return fetch(input, init);
    } });
    try {
      const start = await oauth.start("failure"), redirect = await fetch(start.authorizationUrl, { redirect: "manual" });
      const callback = new URL(redirect.headers.get("location"));
      if (mode === "issuer") callback.searchParams.set("iss", "https://untrusted.example");
      if (mode === "vault") secrets.write = async () => { throw Object.assign(Error(CANARY), { code: "MCP_CREDENTIALS_LOCKED" }); };
      const response = await fetch(callback); assert.equal(response.status, 400);
      assert.equal((await response.text()).includes(CANARY), false);
      assert.equal(oauth.get(start.signInId).errorCode, expectedCode); assert.equal(changes.at(-1).errorCode, expectedCode);
      assert.equal(JSON.stringify(changes).includes(CANARY), false); assert.equal(await secrets.read("failure"), null);
      assert.equal(fixture.state.exchanges.length, mode === "vault" ? 1 : 0);
    } finally { await oauth.close(); await fixture.close(); }
  }
});
test("Pre-registered client bypasses DCR, cancellation rejects late callbacks, callback port collision", async () => {
  const fixture = await startFixture(); const secrets = memorySecrets(); const store = storeOf(remote("registered", `${fixture.origin}/mcp`, "oauth-client"));
  store.update({id:"registered",patch:{secretRef:"mcp-connector:registered"}});
  await secrets.write("registered", { oauthClient: { clientId: "registered-id", clientSecret: CANARY } });
  const port = await freePort(); const oauth = new McpOAuthClient({ store, secrets, callbackPort: port });
  try {
    await login(oauth, "registered"); assert.equal(fixture.state.registrations.length, 0);
    const next = await oauth.start("registered"); const response = await fetch(next.authorizationUrl, { redirect: "manual" });
    assert.equal(oauth.cancel(next.signInId), true); assert.equal((await fetch(response.headers.get("location"))).status, 400); assert.equal(oauth.get(next.signInId).status, "cancelled");
    const collision = new McpOAuthCallback({ port });
    await assert.rejects(collision.start(), e => e.code === "MCP_OAUTH_CALLBACK_UNAVAILABLE"); await collision.close();
  } finally { await oauth.close(); await fixture.close(); }
});
test("Home Assistant style public URL client uses browser OAuth without registration or a client secret", async () => {
  const fixture = await startFixture(), secrets = memorySecrets(), store = storeOf(remote("home-instance", `${fixture.origin}/mcp`, "oauth-client"));
  const port = await freePort(), clientId = `http://127.0.0.1:${port}`, exchanges = [];
  await secrets.write("home-instance", { oauthClient: { clientId } });
  store.update({ id: "home-instance", patch: { secretRef: "mcp-connector:home-instance" } });
  const oauth = new McpOAuthClient({ store, secrets, callbackPort: port, fetch: async (input, init) => {
    if (new URL(input).pathname === "/token") exchanges.push({ body: String(init.body), authorization: new Headers(init.headers).get("authorization") });
    const response = await fetch(input, init);
    if (new URL(input).pathname === "/.well-known/oauth-authorization-server") {
      const metadata = await response.json(); delete metadata.registration_endpoint;
      return new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } });
    }
    return response;
  } });
  try {
    const start = await login(oauth, "home-instance");
    assert.equal(new URL(start.authorizationUrl).searchParams.get("client_id"), clientId);
    assert.equal(new URL(start.redirectUri).origin, clientId);
    assert.equal(fixture.state.registrations.length, 0); assert.equal(exchanges.length, 1);
    assert.equal(new URLSearchParams(exchanges[0].body).get("client_id"), clientId);
    assert.equal(new URLSearchParams(exchanges[0].body).has("client_secret"), false); assert.equal(exchanges[0].authorization, null);
  } finally { await oauth.close(); await fixture.close(); }
});
test("OAuth client registration rejection keeps a fixed public reason without provider secrets", async () => {
  const fixture = await startFixture(), secrets = memorySecrets(), store = storeOf(remote("rejected-client", `${fixture.origin}/mcp`, "oauth-dcr"));
  const changes = [], submissions = [];
  const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value), fetch: async (input, init) => {
    if (new URL(input).pathname === "/register") {
      submissions.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: "invalid_client_metadata", error_description: CANARY }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  } });
  try {
    const { connectorPublicError } = require("../app/core/connector-errors");
    await assert.rejects(oauth.start("rejected-client"), error => {
      assert.equal(error.code, "MCP_OAUTH_REGISTRATION_DENIED");
      assert.equal(connectorPublicError(error).code, error.code);
      assert.equal(error.message.includes(CANARY), false);
      return true;
    });
    assert.equal(submissions.length, 1); assert.equal(submissions[0].client_name, "Shoggoth");
    assert.equal(changes.at(-1).errorCode, "MCP_OAUTH_REGISTRATION_DENIED");
    assert.equal(oauth.get(changes.at(-1).signInId).authorizationUrl, null);
    assert.equal(JSON.stringify(changes).includes(CANARY), false);
    assert.equal(await secrets.read("rejected-client"), null);
  } finally { await oauth.close(); await fixture.close(); }
});
test("OAuth without dynamic registration requests a client and recovers with a supplied client", async () => {
  const fixture = await startFixture(), secrets = memorySecrets(), store = storeOf(remote("manual-client", `${fixture.origin}/mcp`, "oauth-dcr"));
  const changes = [];
  const oauth = new McpOAuthClient({ store, secrets, callbackPort: await freePort(), onChange: value => changes.push(value), fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(input).pathname === "/.well-known/oauth-authorization-server") {
      const metadata = await response.json(); delete metadata.registration_endpoint;
      return new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } });
    }
    return response;
  } });
  const manager = new NativeMcpClientManager({ store, secrets, oauth });
  try {
    await assert.rejects(oauth.start("manual-client"), { code: "MCP_OAUTH_CLIENT_REQUIRED" });
    assert.equal(changes.at(-1).errorCode, "MCP_OAUTH_CLIENT_REQUIRED");
    assert.equal(fixture.state.registrations.length, 0); assert.equal(await secrets.read("manual-client"), null);
    await secrets.write("manual-client", { oauthClient: { clientId: "registered-id", clientSecret: CANARY } });
    store.update({ id: "manual-client", patch: { auth: { kind: "oauth-client" }, secretRef: "mcp-connector:manual-client" } });
    await login(oauth, "manual-client", { badState: true });
    assert.equal((await manager.listTools("manual-client"))[0].name, "echo");
    assert.equal(fixture.state.registrations.length, 0); assert.equal(fixture.state.exchanges.length, 1);
    assert.equal(JSON.stringify(changes).includes(CANARY), false);
  } finally { await manager.close(); await oauth.close(); await fixture.close(); }
});
test("tools/call disconnect and 401 are never replayed, independent connectors continue", async () => {
  const fixture = await startFixture(); const store = storeOf(remote("disconnect", `${fixture.origin}/disconnect`), remote("rejected", `${fixture.origin}/rejected`), remote("public", `${fixture.origin}/public`));
  const manager = new NativeMcpClientManager({ store });
  try {
    await manager.listTools("disconnect"); const before = fixture.state.calls;
    await assert.rejects(manager.callTool("disconnect", "echo", {}), e => e.code === "MCP_SERVER_RESULT_UNKNOWN"); assert.equal(fixture.state.calls, before + 1);
    await manager.listTools("rejected"); await assert.rejects(manager.callTool("rejected", "echo", {}), e => e.code === "MCP_SERVER_RESULT_UNKNOWN"); assert.equal(fixture.state.rejectedCalls, 1);
    assert.equal((await manager.listTools("public"))[0].name, "echo");
  } finally { await manager.close(); await fixture.close(); }
});
test("stdio injects secrets only in child environment, startup timeout reaps process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sgh-mcp-runtime-")); const file = path.join(root, "fixture.cjs");
  fs.writeFileSync(file, `const readline=require('node:readline');const r=readline.createInterface({input:process.stdin});r.on('line',line=>{let m=JSON.parse(line);if(!m.id)return;let result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.FIXTURE_SECRET}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))});`);
  const record = { id: "stdio", enabled: true, secretRef: "mcp-connector:stdio", transport: { kind: "stdio-command", command: process.execPath, args: [file], cwd: root }, updatedAt: 1 };
  const secrets = memorySecrets(); await secrets.write("stdio", { env: { FIXTURE_SECRET: CANARY } });
  const pids = []; const { spawn } = require("node:child_process"); const manager = new NativeMcpClientManager({ store: storeOf(record), secrets, readinessTimeoutMs: 80, spawn: (command, args, options) => { assert.ok(!JSON.stringify(args).includes(CANARY)); assert.equal(options.env.FIXTURE_SECRET, CANARY); const child = spawn(command, args, options); pids.push(child.pid); return child; } });
  try {
    assert.equal((await manager.listTools("stdio"))[0].name, "echo"); assert.equal((await manager.callTool("stdio", "echo", {})).content[0].text, "[REDACTED]");
    await manager.closeServer("stdio"); fs.writeFileSync(file, "setInterval(()=>{},1000)");
    await assert.rejects(manager.probe(record), e => e.code === "MCP_SERVER_TIMEOUT");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === "ESRCH");
  } finally { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("restore drops old vault reference, missing referenced secrets fail closed and manager reopens", async () => {
  const fixture=await startFixture(),secrets=memorySecrets(),record=remote("restored",`${fixture.origin}/public`),store=storeOf(record);
  await secrets.write("restored",{headers:{"X-Api-Key":CANARY}});
  let sentSecret=false;
  const manager=new NativeMcpClientManager({store,secrets,fetch:(input,init)=>{if(new Headers(init.headers).has("X-Api-Key"))sentSecret=true;return fetch(input,init);}});
  try{
    await manager.listTools("restored");assert.equal(sentSecret,false);
    await manager.close();manager.open();assert.equal((await manager.listTools("restored"))[0].name,"echo");
    await manager.closeServer("restored");store.update({id:"restored",patch:{secretRef:"mcp-connector:missing"}});
    await assert.rejects(manager.listTools("restored"),e=>e.code==="MCP_CREDENTIALS_LOCKED");
  }finally{await manager.close();await fixture.close();}
});
test("cancelServer waits delayed exchange without orphan token; OAuth same-instance reopen clears prior state", async () => {
  const fixture=await startFixture(),secrets=memorySecrets(),record=remote("cancelled",`${fixture.origin}/mcp`,"oauth-dcr"),store=storeOf(record);
  const oauth=new McpOAuthClient({store,secrets,callbackPort:await freePort()});let release;
  try{
    const start=await oauth.start("cancelled");
    fixture.state.exchangeWait=new Promise(resolve=>{release=resolve;});
    const redirect=await fetch(start.authorizationUrl,{redirect:"manual"});const callback=fetch(redirect.headers.get("location"));
    while(fixture.state.exchanges.length===0)await new Promise(setImmediate);
    let finished=false;const cancelling=oauth.cancelServer("cancelled").then(()=>{finished=true;});await new Promise(setImmediate);assert.equal(finished,false);
    release();await cancelling;assert.equal((await callback).status,400);assert.equal(oauth.get(start.signInId).status,"cancelled");assert.equal(await secrets.read("cancelled"),null);assert.equal(store.get("cancelled").secretRef,null);
    await oauth.close();oauth.open();fixture.state.exchangeWait=null;
    await assert.rejects(async()=>oauth.get(start.signInId),e=>e.code==="MCP_OAUTH_SESSION_NOT_FOUND");
    const reopened=await login(oauth,"cancelled");assert.equal(oauth.get(reopened.signInId).status,"authorized");assert.equal(store.get("cancelled").secretRef,"mcp-connector:cancelled");
  }finally{release?.();await oauth.close();await fixture.close();}
});
test("short secrets cannot reach argv; results mask both old child credentials and refreshed probe tokens", async () => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"sgh-mcp-secret-boundary-")));let manager,oauth,fixture;
  try{
    const file=path.join(root,"server.cjs");
    fs.writeFileSync(file,`const readline=require("node:readline");readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{tools:{}}}:m.method==="tools/list"?{tools:[{name:"echo",inputSchema:{type:"object"}}]}:{content:[{type:"text",text:process.env.FIXTURE_SECRET}]};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});`);
    const secrets=memorySecrets(),record={id:"rotation",enabled:true,secretRef:"mcp-connector:rotation",transport:{kind:"stdio-command",command:process.execPath,args:[file],cwd:root},updatedAt:1};
    const store=storeOf(record);let spawned=0;
    await secrets.write("rotation",{env:{FIXTURE_SECRET:"xy"}});
    manager=new NativeMcpClientManager({store,secrets,spawn(){spawned++;throw Error("argv rejection must precede spawn");}});
    await assert.rejects(manager.probe({...record,transport:{...record.transport,args:[file,"xy"]}}),error=>error.code==="MCP_SECRET_INVALID");assert.equal(spawned,0);await manager.close();
    await secrets.write("rotation",{env:{FIXTURE_SECRET:"old-child-secret"}});manager=new NativeMcpClientManager({store,secrets});await manager.listTools("rotation");
    await secrets.write("rotation",{env:{FIXTURE_SECRET:"new-child-secret"}});
    assert.equal((await manager.callTool("rotation","echo",{})).content[0].text,"[REDACTED]");await manager.close();manager=null;
    fixture=await startFixture();const oauthRecord=remote("probe-refresh",`${fixture.origin}/mcp`,"oauth-dcr"),oauthStore=storeOf(oauthRecord);
    oauth=new McpOAuthClient({store:oauthStore,secrets,callbackPort:await freePort()});await login(oauth,"probe-refresh");
    const saved=await secrets.read("probe-refresh");await secrets.write("probe-refresh",{oauthToken:{...saved.oauthToken,expiresAt:0}});fixture.state.echoTokenInTools=true;
    manager=new NativeMcpClientManager({store:oauthStore,secrets,oauth});const tools=await manager.probe(oauthStore.get("probe-refresh"));
    assert.equal(fixture.state.refreshes,1);assert.equal(tools[0].description,"[REDACTED]");assert.equal(JSON.stringify(tools).includes(fixture.state.token),false);
  }finally{await manager?.close();await oauth?.close();await fixture?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test("Chrome default launch keeps one private durable profile per connector and restores session cookies", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgh-mcp-chrome-profile-")));
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { McpPackageLauncher } = require("../app/agent-service/mcp-package-launcher");
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "app-data"), trustedRoot: root });
  const record = { id: "chrome-one", enabled: true, transport: { kind: "stdio-package", registryType: "npm", identifier: "chrome-devtools-mcp", version: "1.12.0", packageArgs: ["--no-usage-statistics", "--no-performance-crux"] } };
  const store = storeOf(record, { ...record, id: "chrome-two" }); store.paths = paths;
  const packageLauncher = new McpPackageLauncher({ resolveRuntime: () => process.execPath });
  let manager;
  try {
    const original = JSON.stringify(record);
    manager = new NativeMcpClientManager({ store, packageLauncher });
    const client = await manager._clientFor(record.id);
    const profile = path.join(paths.userDataRoot, "mcp-browser-profiles", record.id);
    assert.ok(client.spec.args.includes(`--user-data-dir=${profile}`));
    assert.ok(client.spec.args.includes("--chrome-arg=--restore-last-session"));
    assert.ok(client.spec.args.includes("--isolated=false"));
    assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
    assert.equal(profile.startsWith(paths.stateDir + path.sep), false, "browser credentials stay outside authority backup/restore");
    fs.writeFileSync(path.join(profile, "fixture-state"), "preserved");
    const probeClient = await manager._create(record);
    assert.deepEqual(probeClient.spec.args, client.spec.args, "readiness and tool launches use the same profile");
    await probeClient.close(); await manager.close();
    manager = new NativeMcpClientManager({ store, packageLauncher });
    const restarted = await manager._clientFor(record.id);
    assert.deepEqual(restarted.spec.args, client.spec.args);
    assert.equal(fs.readFileSync(path.join(profile, "fixture-state"), "utf8"), "preserved");
    const other = await manager._clientFor("chrome-two");
    assert.ok(other.spec.args.includes(`--user-data-dir=${path.join(paths.userDataRoot, "mcp-browser-profiles", "chrome-two")}`));
    assert.equal(JSON.stringify(record), original, "derived launch flags never rewrite the saved connector");
  } finally { await manager?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("Chrome explicit profiles, temporary/remote modes and other packages keep their launch settings", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgh-mcp-chrome-explicit-")));
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { McpPackageLauncher } = require("../app/agent-service/mcp-package-launcher");
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "app-data"), trustedRoot: root });
  const packageLauncher = new McpPackageLauncher({ resolveRuntime: () => process.execPath });
  const base = { id: "chrome-explicit", enabled: true, transport: { kind: "stdio-package", registryType: "npm", identifier: "chrome-devtools-mcp", version: "1.12.0", packageArgs: [] } };
  const modes = [["--isolated"], ["--isolated=false"], ["--user-data-dir=/explicit"], ["--userDataDir", "/explicit"], ["--autoConnect"], ["--auto-connect=true"], ["--browser-url=http://127.0.0.1:9222"], ["-u", "http://127.0.0.1:9222"], ["-uhttp://127.0.0.1:9222"], ["--wsEndpoint=ws://127.0.0.1:9222"], ["-wws://127.0.0.1:9222"], ["--config", "/explicit.json"], ["--channel=beta"], ["--executablePath=/explicit/chrome"], ["-e/explicit/chrome"], ["--chrome-arg=--incognito"]];
  try {
    for (const packageArgs of modes) {
      const record = { ...base, transport: { ...base.transport, packageArgs } };
      const store = storeOf(record); store.paths = paths;
      const manager = new NativeMcpClientManager({ store, packageLauncher });
      try { assert.deepEqual((await manager._clientFor(record.id)).spec, await packageLauncher.prepare(record.transport)); }
      finally { await manager.close(); }
    }
    for (const record of [
      { ...base, transport: { ...base.transport, identifier: "other-mcp" } },
      { ...base, transport: { kind: "stdio-command", command: process.execPath, args: ["/explicit/chrome-devtools-mcp.js"], cwd: root } },
    ]) {
      const store = storeOf(record); store.paths = paths;
      const manager = new NativeMcpClientManager({ store, packageLauncher });
      try { assert.deepEqual((await manager._clientFor(record.id)).spec.args, record.transport.args || ["--yes", "other-mcp@1.12.0"]); }
      finally { await manager.close(); }
    }
    assert.equal(fs.existsSync(path.join(paths.userDataRoot, "mcp-browser-profiles")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("Chrome managed profiles reject symlink traversal before preparing or spawning a package", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgh-mcp-chrome-symlink-")));
  const userDataRoot = path.join(root, "app-data"); fs.mkdirSync(userDataRoot);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgh-mcp-chrome-outside-")));
  fs.symlinkSync(outside, path.join(userDataRoot, "mcp-browser-profiles"));
  const record = { id: "chrome-unsafe", enabled: true, transport: { kind: "stdio-package", registryType: "npm", identifier: "chrome-devtools-mcp", version: "1.12.0", packageArgs: [] } };
  const store = storeOf(record); store.paths = { userDataRoot, trustedRoot: root };
  let prepared = 0;
  const manager = new NativeMcpClientManager({ store, packageLauncher: { prepare() { prepared++; throw Error("unsafe path reached launcher"); } } });
  try {
    await assert.rejects(manager._clientFor(record.id), { code: "UNSAFE_SYMLINK" });
    assert.equal(prepared, 0); assert.deepEqual(fs.readdirSync(outside), []);
  } finally { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
(async () => { let failed = 0; for (const [name, fn] of tests) { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}`, error); } } if (failed) process.exitCode = 1; })();
