#!/usr/bin/env node
"use strict";
// Actual REST -> Service -> native Runtime stdin -> loopback mock model, plus
// helper/capability binding -> actual HTTP/stdio MCP -> model/local projections.
// Every account, home, provider and credential is an isolated fixture.
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), path = require("node:path"), crypto = require("node:crypto");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { startFixture, CANARY } = require("./fixtures/mcp-connector-http-fixture.cjs");
const { until } = require("./mcp-connector-agent-lanes-e2e.cjs");
const { authenticateMcpSession, createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const { requestService } = require("../app/agent-service/client");
const uuid = () => crypto.randomUUID();
async function main() {
  const requests = [], model = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text)); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{}');
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}`;
  const provider = await startFixture(); let f, helper, auth;
  try {
    f = await startInspirationFixture({ groupControlledRuntime: true, isolatedHome: true, modelCaptureUrl: modelUrl,
      serviceOptions: { prewarmMcpAuth: false, autoSparkNotes: false, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
    const rest = async (url, body) => {
      const response = await fetch(f.url + "/__api/" + url, body === undefined ? {} : { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const connector = await rest("connectors/mcp/add", { source: { kind: "custom" }, name: "Secret mediated echo", option: { kind: "remote", protocol: "streamable-http", url: provider.origin + "/mcp" },
      fields: { headers: { Authorization: `Bearer ${CANARY}` } }, expectedRevision: (await rest("connectors/mcp/list")).revision });
    assert.equal(connector.server.status, "ready");
    const created = await f.ipc("agent.create", { operationId: uuid(), backendId: "shoggoth", name: "Credential fixture", defaultCwd: null, createdAt: Date.now() });
    const profile = f.service.productStore.getAgentProfile(created.profile.id);
    const session = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() })).session;
    const owner = { backendId: "shoggoth", agentId: profile.id, sessionKey: session.sessionKey };
    await f.backend._refreshManagedProfiles();
    const gatewayKey = `agent:${profile.agentId}:${session.sessionKey}`;
    const uiPrepared = await rest("chat/secrets/prepare", { sessionKey: gatewayKey, operationId: uuid(), text: "Password: ui-contract-fixture" });
    assert.equal(uiPrepared.references.length, 1);
    assert((await rest("chat/secrets/list", { sessionKey: gatewayKey })).items.some(item => item.reference === uiPrepared.references[0].reference));
    assert.deepEqual((await rest("chat/secrets/results", { sessionKey: gatewayKey })).items, []);
    assert.equal((await rest("chat/secrets/capabilities", { sessionKey: gatewayKey })).nativeTools, false);
    assert.equal((await rest("chat/secrets/revoke", { sessionKey: gatewayKey, reference: uiPrepared.references[0].reference })).revoked, 1);
    const raw = "Open a new page. 密码是 123456，订单号：666777";
    const operationId = uuid();
    const prepared = await f.ipc("chat.secret.prepare", { ...owner, operationId, text: raw, selections: [] });
    assert.equal(prepared.references.length, 1); assert(!prepared.text.includes("123456"));
    assert(prepared.text.includes("666777"));
    const ref = prepared.references[0].reference;
    const sent = await f.ipc("chat.send", { operationId, sessionKey: session.sessionKey, prompt: prepared.text, createdAt: Date.now() });
    const context = await until(() => f.service.workRunCoordinator.runContexts.get(sent.run.id), value => value?.turnId, "credential turn");
    await until(() => requests, value => value.some(request => request.method === "turn/start"), "mock model request");
    assert(!JSON.stringify(requests).includes("123456")); assert(JSON.stringify(requests).includes(ref));
    assert(!JSON.stringify(requests).includes(CANARY));
    const control = async (action, params) => {
      const id = uuid(), dir = path.join(f.root, "group-control"), responseFile = path.join(dir, id + ".response.json");
      fs.writeFileSync(path.join(dir, id + ".request.json"), JSON.stringify({ id, action, threadId: context.threadId, turnId: context.turnId, params }), { mode: 0o600 });
      const response = await until(() => { try { return JSON.parse(fs.readFileSync(responseFile)); } catch { return null; } }, Boolean, action);
      assert.equal(response.error, undefined); return response.result;
    };
    auth = await authenticateMcpSession({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
    helper = createMcpStdioHandler({ paths: f.paths, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
      sessionToken: auth.token, bindRuntimeCalls: true, requestService });
    await helper({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "secret-mediation", version: "1" } } });
    const call = async (value, serverId = connector.server.id) => {
      const reply = await helper({ jsonrpc: "2.0", id: uuid(), method: "tools/call", params: { name: "mcp_server_call", arguments: { serverId, toolName: "echo", arguments: { value } } } }, {
        requestClient: async (_, params) => params._meta?.["shoggoth/runtime-call-binding"] ? control("binding", params) : { action: "accept", content: { confirm_product_action: "确认执行" } },
      });
      const result = reply.result.structuredContent; assert.equal(result.error, undefined, JSON.stringify(result)); return result;
    };
    const output = await call(`echo ${ref}`);
    assert.equal(provider.state.requests.filter(item => item.method === "tools/call").at(-1).params.arguments.value, "echo 123456");
    assert.equal(output.operationStatus, "completed"); assert(!JSON.stringify(output).includes("123456")); assert(JSON.stringify(output).includes(ref));
    await fetch(modelUrl, { method: "POST", body: JSON.stringify({ toolResult: output }) });
    const original = await f.ipc("chat.secret.result", { ...owner, receiptId: output.receiptId });
    assert((await rest("chat/secrets/results", { sessionKey: gatewayKey })).items.some(item => item.receiptId === output.receiptId));
    const httpRead = await fetch(f.url + "/__api/chat/secrets/result", { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey: gatewayKey, receiptId: output.receiptId }) });
    assert.equal(httpRead.status, 403);
    assert.equal((await f.registry.chatSecretRequest("result", { sessionKey: gatewayKey, receiptId: output.receiptId })).result.content[0].text, "echo 123456");
    assert.equal(original.status, "completed"); assert.equal(original.result.content[0].text, "echo 123456");
    assert.equal(provider.state.calls, 1);
    await f.ipc("chat.secret.result", { ...owner, receiptId: output.receiptId }); assert.equal(provider.state.calls, 1);
    // The transport auth remains in its existing long-term store, never the
    // temporary vault. An auth echo is withheld without failing the operation.
    const echoed = await call(CANARY).catch(error => ({ expectedInputRejection: error }));
    assert(echoed.expectedInputRejection, "raw long-term key cannot be supplied by the model");
    const foreign = (await f.ipc("chat.session.create", { operationId: uuid(), profileId: profile.id, workspace: f.paths.defaultWorkspaceDir, createdAt: Date.now() })).session;
    await assert.rejects(f.ipc("chat.secret.result", { ...owner, sessionKey: foreign.sessionKey, receiptId: output.receiptId }));
    await f.ipc("chat.secret.revoke", { ...owner, reference: ref });
    assert.equal((await f.ipc("chat.secret.list", owner)).items.length, 0);
    await control("complete"); await f.service.workRunCoordinator.waitForTerminal(sent.run.id);
    const history = await f.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
    assert(!JSON.stringify(history).includes("123456")); assert(history.messages.length > 0);
    assert(!JSON.stringify(requests).includes("123456")); assert(!JSON.stringify(requests).includes(CANARY));
    console.log(JSON.stringify({ pass: true, mockModelRequests: requests.length, actualMcpCalls: provider.state.calls,
      input: "redacted-before-model", execution: "received-original", localResult: "original-without-replay", foreignScope: "denied", history: "retained", providerAuth: "unchanged" }));
  } finally {
    await helper?.close(); auth?.close?.(); await f?.close(); await provider.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
