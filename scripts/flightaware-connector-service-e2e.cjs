"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs");
const { startFlightawareAcceptance } = require("./fixtures/flightaware-app-acceptance.cjs");
const { validateConnectorResult } = require("../app/core/connector-dto");
const { KEY_FIELD, METERED_FIELD, METERED_ENABLED, METERED_DISABLED, METERED_MARKER } = require("../app/agent-service/flightaware-mcp-launch");
const preset = require("../app/agent-service/data/mcp-featured-presets.json").find(item => item.id === "flightaware");
const KEY = "fixture-aeroapi-key";
async function smoke() {
  const acceptance = await startFlightawareAcceptance();
  const { fixture: f, python } = acceptance;
  const rest = async (route, body, status = 200, origin = f.url) => {
    const response = await fetch(`${f.url}/__api/connectors/mcp/${route}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    assert.equal(response.status, status, JSON.stringify(data)); assert.equal(JSON.stringify(data).includes(KEY), false); return data;
  };
  try {
    let state = await rest("list"); assert.equal(state.servers.length, 0); assert.equal(python.calls().length, 0);
    const request = { source: { kind: "custom" }, name: preset.name, option: preset.transport, expectedRevision: state.revision };
    await rest("add", request, 403, "https://untrusted.example"); assert.equal(python.calls().length, 0);
    let result = await rest("add", request); validateConnectorResult("connector.mcp.add", result);
    const id = result.server.id; assert.equal(result.server.status, "needsSetup"); assert.equal(result.server.recommendationId, "flightaware"); assert.equal(python.calls().length, 0);
    result = await rest("credentials", { id, fields: { env: { [KEY_FIELD]: "fixture-unauthorized" } }, expectedRevision: result.revision }); assert.equal(result.server.status, "signedOut");
    result = await rest("credentials", { id, fields: { env: { [KEY_FIELD]: KEY } }, expectedRevision: result.revision }); assert.equal(result.server.status, "ready"); assert.equal(result.server.lastCheck.toolCount, 20);
    assert.ok(python.calls().every(c => c.path === "/aeroapi/account/usage"));
    const input = { ident: "UAL123", date: "2026-11-01" }, manager = f.service.nativeMcpClientManager;
    let count = python.calls().length;
    assert.equal(JSON.parse((await manager.callTool(id, "flightaware_get_flight", input)).content[0].text).error.code, "FLIGHTAWARE_METERED_DISABLED"); assert.equal(python.calls().length, count);
    result = await rest("credentials", { id, fields: { env: { [METERED_FIELD]: METERED_ENABLED } }, expectedRevision: result.revision }); assert.ok(result.server.setup.configuredFields.includes(METERED_MARKER));
    const data = await manager.callTool(id, "flightaware_get_flight", input); assert.equal(JSON.parse(data.content[0].text).flights[0].ident, "UAL123"); assert.equal(JSON.parse(data.content[0].text).flights[0].cancelled, false); assert.equal(JSON.stringify(data).includes(KEY), false);
    const image = await manager.callTool(id, "flightaware_get_map", { flight_id: "UAL123-1793232000-airline-0001" }); assert.equal(image.content[0].type, "image"); assert.equal(image.content[0].mimeType, "image/png");
    result = await rest("credentials", { id, fields: { env: { [METERED_FIELD]: METERED_DISABLED } }, expectedRevision: result.revision }); count = python.calls().length;
    assert.equal(JSON.parse((await manager.callTool(id, "flightaware_get_flight", input)).content[0].text).error.code, "FLIGHTAWARE_METERED_DISABLED"); assert.equal(python.calls().length, count);
    for (const file of [f.paths.encryptedSecretsPath, f.paths.nativeMcpRegistryPath, f.service.mcpConnectorController.requestsPath].filter(Boolean)) if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8").includes(KEY), false);
    const profile = f.service.productStore.listAgentProfiles()[0];
    assert.ok(f.service.mcpConnectorController.available(profile.id).some(s => s.id === id));
    result = await rest("agents", { id, disabledProfileIds: [profile.id], expectedRevision: result.revision });
    assert.ok(!f.service.mcpConnectorController.available(profile.id).some(s => s.id === id));
    await rest("credentials", { id, fields: { env: { [METERED_FIELD]: METERED_ENABLED } }, expectedRevision: 1 }, 409);
    await rest("remove", { id, expectedRevision: result.revision }); state = await rest("list"); assert.equal(state.servers.length, 0);
    assert.ok(python.calls().every(c => c.method === "GET"));
    console.log(JSON.stringify({ passed: true, actualService: true, actualBackend: true, actualRest: true, actualStdioBridge: true, actualBundledPythonCli: true, meteredOffByDefault: true, explicitPermissionRevoked: true, syntheticRequests: python.calls().length, realProviderCalls: 0, realUserCredentials: 0 }));
  } finally { await acceptance.close(); }
}
if (require.main === module) smoke().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { smoke };
