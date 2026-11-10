"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");

function fixture() {
  const backend = Object.create(OpenClawBackend.prototype), calls = [];
  backend._connectionGeneration = 1;
  backend._connect = async () => {};
  backend.getAgent = async id => ({ id, model: `p/${id}` });
  backend.request = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "models.list", "reading a directory must never write a model or start a turn");
    assert.deepEqual(Object.keys(params).sort(), ["agentId", "view"]);
    assert.equal(params.view, "configured");
    return { models: [
      { id: params.agentId, name: `Model for ${params.agentId}`, provider: "p", available: true,
        contextWindow: 200000, reasoning: true, thinkingOptions: ["low", "high"], fast: false },
      { id: params.agentId, name: "Same ID on another endpoint", provider: "other", available: true },
      { id: "offline", name: "Offline model", provider: "p", available: false, unavailableReason: "missing-auth" },
    ] };
  };
  return { backend, calls };
}

test("Agent and Inspiration catalogs preserve scope, provider identity, unavailable rows and metadata", async () => {
  const { backend } = fixture();
  const agent = await backend.getAgentModels("a");
  assert.deepEqual(await backend.getInspirationModels("a"), agent);
  assert.equal(agent.models.length, 3);
  assert.equal(agent.defaultModel, "p/a");
  assert.deepEqual(agent.models.map(row => row.provider), ["p", "other", "p"]);
  assert.equal(agent.models[2].available, false);
  assert.equal(agent.models[2].unavailableReason, "missing-auth");
  assert.deepEqual(agent.models[0].thinkingOptions, ["low", "high"]);
  assert.equal(agent.models[0].fast, false);
  assert.equal((await backend.getAgentModels("b")).models[0].id, "b");
  const group = await backend.getGroupMemberModels("a");
  assert.equal(group.models.length, 2, "execution validation keeps rejecting unavailable choices");
  assert.deepEqual(Object.keys(group.models[0]).sort(), ["id", "name", "provider"], "retain the bounded federation DTO");
});

test("malformed or retired catalog reads fail instead of becoming an empty success", async () => {
  const { backend } = fixture();
  backend.request = async () => ({});
  await assert.rejects(backend.getAgentModels("a"), { code: "AGENT_MODEL_CATALOG_UNAVAILABLE" });
  backend.request = async () => { backend._connectionGeneration++; return { models: [] }; };
  await assert.rejects(backend.getAgentModels("a"), { code: "AGENT_MODEL_CATALOG_UNAVAILABLE" });
  await assert.rejects(backend.getGroupMemberModels("a"), { code: "GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE" });
});

test("Agent REST and Inspiration REST expose the same configured catalog; reads enforce active backend and GET", async t => {
  const { backend, calls } = fixture();
  const registry = new BackendRegistry();
  registry.register(backend);
  registry.setInspirationOwner({ startExternalInspiration() { assert.fail("read must not start an execution"); } });
  class Unsupported extends AgentBackend { get id() { return "other"; } get name() { return "Other"; } }
  registry.register(new Unsupported());
  let disabled = [];
  registry.setDisabledBackendsProvider(() => disabled);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startStaticServer(0, { registry, homeDir: root, userDataRoot: path.join(root, "ui") });
  t.after(() => server.close());
  const get = async route => {
    const response = await fetch(server.url + route);
    return { status: response.status, body: await response.json() };
  };
  const route = "/__api/agents/a/models?backend=openclaw";
  const agent = await get(route);
  assert.equal(agent.status, 200);
  assert.deepEqual(await get("/__api/inspirations/models?backendId=openclaw&agentId=a"), agent);
  assert.equal(agent.body.models.length, 3);
  assert.equal((await get("/__api/agents/b/models?backend=openclaw")).body.defaultModel, "p/b");
  const reads = calls.length;
  assert.equal((await fetch(server.url + route, { method: "POST", headers: { Origin: server.url } })).status, 405);
  assert.equal(calls.length, reads);
  assert.equal((await get("/__api/agents/a/models?backend=other")).status, 501);
  disabled = ["openclaw"];
  assert.equal((await get(route)).status, 400);
  assert.equal(calls.length, reads, "a disconnected backend must not be contacted");
  disabled = [];
  backend.request = async () => { throw new Error("private upstream detail"); };
  const failed = await get(route);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "AGENT_MODEL_CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(failed).includes("private upstream detail"), false);
});
