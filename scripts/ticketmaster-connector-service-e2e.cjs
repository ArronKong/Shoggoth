"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs");
const { startTicketmasterAcceptance } = require("./fixtures/ticketmaster-app-acceptance.cjs");
const { validateConnectorResult } = require("../app/core/connector-dto");
const preset = require("../app/agent-service/data/mcp-featured-presets.json").find(item => item.id === "ticketmaster");
const KEY = "fixture-consumer-key";

async function smoke() {
  const acceptance = await startTicketmasterAcceptance();
  const { fixture: f, python } = acceptance;
  const rest = async (route, body, status = 200, origin = f.url) => {
    const response = await fetch(`${f.url}/__api/connectors/mcp/${route}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    assert.equal(response.status, status, JSON.stringify(data));
    assert.equal(JSON.stringify(data).includes(KEY), false, "public REST must not reveal the key"); return data;
  };
  try {
    let state = await rest("list"); assert.equal(state.servers.length, 0); assert.equal(python.calls().length, 0);
    const request = { source: { kind: "custom" }, name: preset.name, option: preset.transport, fields: { env: { TICKETMASTER_API_KEY: KEY } }, expectedRevision: state.revision };
    await rest("add", request, 403, "https://untrusted.example"); assert.equal(python.calls().length, 0);
    let added = await rest("add", { ...request, fields: { env: { TICKETMASTER_API_KEY: "fixture-unauthorized" } } });
    validateConnectorResult("connector.mcp.add", added); assert.equal(added.server.status, "signedOut"); assert.equal(added.server.lastCheck.errorCode, "MCP_AUTH_REQUIRED");
    const id = added.server.id;
    added = await rest("credentials", { id, fields: request.fields, expectedRevision: added.revision });
    assert.equal(added.server.id, id); assert.equal(added.server.status, "ready"); assert.equal(added.server.lastCheck.toolCount, 5);
    assert.equal(added.server.recommendationId, "ticketmaster"); assert.equal(python.calls().length, 2);
    state = await rest("list"); assert.equal(state.servers.length, 1);
    const profile = f.service.productStore.listAgentProfiles()[0];
    assert.ok(f.service.mcpConnectorController.available(profile.id).some(server => server.id === id));
    const data = await f.service.nativeMcpClientManager.callTool(id, "ticketmaster_search_events", { classification_name: "Music", start_date: "2026-10-29", end_date: "2026-11-27", sort: "date,asc", size: 5 });
    const result = JSON.parse(data.content[0].text); assert.equal(result._embedded.events[0].name, "Fixture Concert");
    assert.equal(result._embedded.events[0].images[0].width, 1024); assert.equal(JSON.stringify(data).includes(KEY), false);
    assert.equal(python.calls().length, 3);
    for (const file of [f.paths.encryptedSecretsPath, f.paths.nativeMcpRegistryPath, f.service.mcpConnectorController.requestsPath].filter(Boolean)) {
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8").includes(KEY), false, "credential found in " + file);
    }
    const excluded = await rest("agents", { id, disabledProfileIds: [profile.id], expectedRevision: state.revision });
    assert.equal(f.service.mcpConnectorController.available(profile.id).some(server => server.id === id), false);
    await rest("credentials", { id, fields: request.fields, expectedRevision: 1 }, 409);
    await rest("remove", { id, expectedRevision: excluded.revision });
    state = await rest("list"); assert.equal(state.servers.length, 0);
    assert.ok(python.calls().every(call => call.method === "GET" && call.path.startsWith("/discovery/v2/")));
    console.log(JSON.stringify({ passed: true, actualService: true, actualBackend: true, actualRest: true, actualStdioBridge: true, actualBundledPythonCli: true, syntheticDiscoveryRequests: python.calls().length, realProviderCalls: 0, realUserCredentials: 0 }));
  } finally { await acceptance.close(); }
}

if (require.main === module) smoke().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { smoke };
