"use strict";

// Actual REST -> coordinator -> native adapter; synthetic Gateway transport,
// fresh HOME/journal, no installed backend or user credential access.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createOpenClawModelChange } = require("../app/core/openclaw-model-change");
const { ModelChangeCoordinator } = require("../app/core/model-change-coordinator");
const { createModelChangeJournal } = require("../app/core/model-change-journal");
const { startStaticServer } = require("../app/static-server");

test("Provider REST saves and clears all target Agents, and rejects a conflicting scope before writing", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-unified-key-rest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], config = { models: { providers: {} }, agents: { entries: { main: {}, other: {} } } };
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:9" });
  backend._connect = async () => {};
  backend.hasGatewayMethod = () => true;
  backend.request = async (method, params) => {
    if (method === "config.get") return { valid: true, hash: "synthetic-config-revision", parsed: structuredClone(config) };
    if (method === "models.list") return { models: [] };
    calls.push({ method, agentId: params.agentId, credentialType: params.credentialType });
    if (method === "models.authSetApiKey") return { provider: params.provider, profileId: `${params.provider}:manual` };
    if (method === "models.authLogout") return { provider: params.provider, removedProfiles: [`${params.provider}:manual`] };
    throw Error("unexpected isolated Gateway method");
  };
  backend.attachModelChangeAdapter(createOpenClawModelChange({ backend, configurationMode: "native-config" }));
  const registry = new BackendRegistry(); registry.register(backend);
  const coordinator = new ModelChangeCoordinator({ registry, journal: createModelChangeJournal(path.join(root, "journal.json")) });
  coordinator.markReady();
  const server = await startStaticServer(0, { registry, modelChangeCoordinator: coordinator, homeDir: root, userDataRoot: root,
    configStore: { read: () => ({ disabledBackends: [] }), write() {} } });
  t.after(() => server.close());
  const put = async body => {
    const response = await fetch(server.url + "/__api/models/config?backend=openclaw", { method: "PUT",
      headers: { "Content-Type": "application/json", Origin: new URL(server.url).origin }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const saved = await put({ providerKey: "groq", apiKey: "synthetic-rest-key", credentialScope: "provider", operationId: "rest-unified-save" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, "applied");
  assert.deepEqual(calls, [
    { method: "models.authSetApiKey", agentId: "main", credentialType: undefined },
    { method: "models.authSetApiKey", agentId: "other", credentialType: undefined },
  ]);
  calls.length = 0;
  const cleared = await put({ providerKey: "groq", clearApiKey: true, credentialScope: "provider", operationId: "rest-unified-clear" });
  assert.equal(cleared.body.status, "applied");
  assert.deepEqual(calls, [
    { method: "models.authLogout", agentId: "main", credentialType: "api_key" },
    { method: "models.authLogout", agentId: "other", credentialType: "api_key" },
  ]);
  calls.length = 0;
  const invalid = await put({ providerKey: "groq", apiKey: "synthetic-rest-key", credentialScope: "provider", agentId: "other", operationId: "rest-conflicting-scope" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "conflicting_fields");
  assert.deepEqual(calls, []);
  assert.deepEqual(config.models.providers, {});
});
