"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");

for (const id of ['shoggoth', 'grok-build', 'claude-code', 'deepseek-harness', 'antigravity', 'pi', 'openclaw', 'hermes']) {
  test(`${id}: readiness blocks cold/recovering/disabled/mismatched executors before a run is created`, async () => {
    const registry = new BackendRegistry();
    let connected = false, disabled = false, readyAgentIds = ['selected'], starts = 0;
    class Backend extends AgentBackend {
      get id() { return id; }
      get name() { return id; }
      getInspirationCapabilities() { return { execute: true }; }
      async getStatus() { return { connected, disabled, info: { readyAgentIds } }; }
      async listAgents() { return [{ id: 'selected' }]; }
      async startInspiration() { starts++; return { ok: true }; }
    }
    registry.register(new Backend());
    const input = { backendId: id, agentId: 'selected' };
    assert.deepEqual(await registry.getInspirationExecutorReadiness(input), { ready: false });
    await assert.rejects(registry.startInspiration('idea', input), { code: 'INSPIRATION_UNAVAILABLE' });
    assert.equal((await registry.getInspirationAgents()).agents[0].capabilities.execute, false);
    connected = true; readyAgentIds = ['another'];
    await assert.rejects(registry.startInspiration('idea', input), { code: 'INSPIRATION_UNAVAILABLE' });
    assert.equal(starts, 0);
    readyAgentIds = ['selected'];
    assert.deepEqual(await registry.getInspirationExecutorReadiness(input), { ready: true });
    await registry.startInspiration('idea', input);
    assert.equal(starts, 1);
    disabled = true;
    assert.deepEqual(await registry.getInspirationExecutorReadiness(input), { ready: false });
    disabled = false;
    connected = false;
    assert.deepEqual(await registry.getInspirationExecutorReadiness(input), { ready: false });
    assert.deepEqual(await registry.getInspirationExecutorReadiness({ ...input, backendId: 'missing' }), { ready: false });
  });
}

function ownerFixture() {
  const owner = Object.create(ShoggothBackend.prototype);
  Object.assign(owner, { backendId: "shoggoth", _state: "started", _profilesByAgent: new Map(), _generation: 7 });
  const calls = [];
  owner._call = async (method, params) => {
    calls.push({ method, params });
    if (method === "service.status") return { healthy: true, pendingCommandsLocked: false, mcpCredentialsLocked: false };
    return { idea: { latestExecution: { profileId: null, backendId: params.backendId,
      agentId: params.agentId, sessionKey: params.backendId === "openclaw"
        ? "agent:main:inspiration:opaque/key" : "hermes-default:opaque/key" } } };
  };
  owner._syncFederationTargetSession = () => assert.fail("External execution must not sync a native profile Session");
  return { owner, calls };
}

test('Agent dock ranks every Agent by durable history with stable ties and bounded Service batches', async () => {
  const registry = new BackendRegistry();
  class RosterBackend extends AgentBackend {
    constructor(id, count) { super(); this.backendId = id; this.count = count; }
    get id() { return this.backendId; }
    get name() { return this.backendId; }
    async listAgents() { return Array.from({ length: this.count }, (_, index) => ({ id: `agent-${index}` })); }
  }
  registry.register(new RosterBackend('native', 61));
  registry.register(new RosterBackend('other', 2));
  const broken = new RosterBackend('broken', 1);
  broken.listAgents = async () => { throw new Error('Offline'); }; registry.register(broken);
  const { owner } = ownerFixture();
  const batches = [];
  owner._call = async (method, { agents }) => {
    assert.equal(method, 'inspiration.agent-stats'); batches.push(agents);
    return { agents: agents.map(agent => ({ ...agent, executionCount: agent.backendId === 'other' ? 3 : agent.agentId === 'agent-60' ? 10 : 0 })) };
  };
  registry.setInspirationOwner(owner);
  const before = await registry.getInspirationAgents();
  const dock = await registry.getInspirationAgentDock();
  assert.deepEqual(batches.map(batch => batch.length), [50, 13]);
  assert.equal(dock.agents.length, 63);
  assert.deepEqual(dock.agents.slice(0, 4).map(agent => [agent.backendId, agent.id, agent.executionCount]),
    [['native', 'agent-60', 10], ['other', 'agent-0', 3], ['other', 'agent-1', 3], ['native', 'agent-0', 0]]);
  assert.equal(dock.agents[0].capabilities.execute, false, 'unsupported Agents remain visible');
  assert.deepEqual(await registry.getInspirationAgents(), before, 'dock preference never changes the default Agent roster');
  owner._call = async () => { throw new Error('History unavailable'); };
  await assert.rejects(registry.getInspirationAgentDock(), /History unavailable/);
});

for (const Backend of [OpenClawBackend, HermesBackend]) {
  test(`${Backend.name}: explicit owner routes to service and preserves the upstream Session key`, async () => {
    const backend = Object.create(Backend.prototype);
    backend.listAgents = async () => [{ id: "selected-agent", name: "Selected" }];
    backend.getStatus = async () => ({ connected: true, info: { readyAgentIds: ["selected-agent"] } });
    const { owner, calls } = ownerFixture();
    const registry = new BackendRegistry();
    assert.equal(backend.getInspirationCapabilities().execute, false);
    if (backend.id === "openclaw") { registry.register(backend); registry.setInspirationOwner(owner); }
    else { registry.setInspirationOwner(owner); registry.register(backend); }
    const input = { backendId: backend.id, agentId: "selected-agent", workspace: null, operationId: "operation" };
    assert.equal((await registry.getInspirationAgents()).agents[0].capabilities.execute, true);
    const result = await registry.startInspiration("idea", input);
    assert.deepEqual(calls, [{ method: "service.status", params: {} },
      { method: "inspiration.start", params: { ...input, id: "idea" } }]);
    const execution = result.idea.latestExecution;
    const href = new URL(execution.sessionHref, "https://fixture.invalid");
    assert.equal(href.searchParams.get("backend"), backend.id);
    assert.equal(href.searchParams.get("session"), execution.sessionKey);

    backend.getStatus = async () => ({ connected: true, info: { readyAgentIds: ["another-agent"] } });
    assert.equal((await registry.getInspirationAgents()).agents[0].capabilities.reason, "backend-unavailable");
    await assert.rejects(registry.startInspiration("idea", input), { code: "INSPIRATION_UNAVAILABLE" });
    backend.getStatus = async () => ({ connected: false, info: {} });
    assert.equal((await registry.getInspirationAgents()).agents[0].capabilities.execute, false);
    await assert.rejects(registry.startInspiration("idea", input), { code: "INSPIRATION_UNAVAILABLE" });
    assert.equal(calls.length, 2);
    registry.setInspirationOwner(null);
    assert.equal(backend.getInspirationCapabilities().execute, false);
  });
}

test("Owner injection never enables unrelated backends and respects service availability", async () => {
  class OtherBackend extends AgentBackend { get id() { return "other"; } }
  const backend = new OtherBackend();
  const { owner, calls } = ownerFixture();
  const registry = new BackendRegistry();
  registry.setInspirationOwner(owner);
  registry.register(backend);
  assert.equal(backend._inspirationOwner, null);
  backend.setInspirationOwner(owner);
  assert.equal(backend.getInspirationCapabilities().execute, false);
  await assert.rejects(backend.startInspiration("idea", { backendId: "other" }), { code: "INSPIRATION_UNSUPPORTED" });
  await assert.rejects(owner.startExternalInspiration("idea", { backendId: "other" }), { code: "INSPIRATION_UNSUPPORTED" });
  const external = Object.create(OpenClawBackend.prototype);
  external.setInspirationOwner(owner);
  const availableCall = owner._call;
  owner._state = "stopped";
  assert.equal(external.getInspirationCapabilities().execute, true);
  await external.startInspiration("idea", { backendId: "openclaw", agentId: "main" });
  assert.equal(owner._state, "stopped", "external execution must not reconnect the Shoggoth agent backend");
  for (const status of [
    { healthy: false, pendingCommandsLocked: false, mcpCredentialsLocked: false },
    { healthy: true, pendingCommandsLocked: true, mcpCredentialsLocked: false },
  ]) {
    owner._call = async (method) => { assert.equal(method, "service.status"); return status; };
    await assert.rejects(external.startInspiration("idea", { backendId: "openclaw" }), { code: "INSPIRATION_UNAVAILABLE" });
  }
  owner._call = (method, params) => method === "service.status"
    ? Promise.resolve({ healthy: true, pendingCommandsLocked: false, mcpCredentialsLocked: true })
    : availableCall(method, params);
  await external.startInspiration("idea", { backendId: "openclaw", agentId: "main" });
  assert.equal(calls.filter(({ method }) => method === "inspiration.start").length, 2);
});

test("Native execution retains Profile binding, Session prefix, and sync", async () => {
  const { owner } = ownerFixture();
  const profile = { id: "native-profile", agentId: "shoggoth-main" };
  const sessionKey = "b1dc5c34-0a70-4c37-802e-a11489a26073"; // gitleaks:allow -- synthetic test fixture; not a usable credential
  owner._profilesByAgent.set(profile.agentId, profile);
  owner._call = async () => ({ idea: { latestExecution: { profileId: profile.id,
    backendId: "shoggoth", agentId: profile.agentId, sessionKey } } });
  const synced = [];
  owner._syncFederationTargetSession = async (...args) => { synced.push(args); };
  owner.getStatus = async () => ({ connected: true, info: { readyAgentIds: [profile.agentId] } });
  const registry = new BackendRegistry();
  registry.register(owner);
  const result = await registry.startInspiration("idea", { backendId: "shoggoth", agentId: profile.agentId });
  assert.equal(new URL(result.idea.latestExecution.sessionHref, "https://fixture.invalid").searchParams.get("session"),
    `agent:${profile.agentId}:${sessionKey}`);
  assert.deepEqual(synced, [[{ profileId: profile.id, sessionKey }, 7]]);
  await assert.rejects(owner.startInspiration("idea", { backendId: "shoggoth", agentId: "missing" }),
    { code: "INSPIRATION_UNSUPPORTED" });
});

test("External preparation may omit Session and workspace, but cannot return a different owner", async () => {
  const { owner } = ownerFixture();
  const input = { backendId: "hermes", agentId: "hermes-agent" };
  const execution = { ...input, profileId: null, sessionKey: null, workspace: null, status: "starting" };
  owner._call = async (method) => method === "service.status"
    ? { healthy: true, pendingCommandsLocked: false, mcpCredentialsLocked: false }
    : { idea: { latestExecution: { ...execution } } };
  const result = await owner.startExternalInspiration("idea", input);
  assert.equal(result.idea.latestExecution.sessionHref, null);
  execution.agentId = "another-agent";
  await assert.rejects(owner.startExternalInspiration("idea", input), { code: "INSPIRATION_BINDING_INVALID" });
  execution.agentId = input.agentId;
  execution.profileId = "native-profile";
  await assert.rejects(owner.startExternalInspiration("idea", input), { code: "INSPIRATION_BINDING_INVALID" });
});

test("All inspiration projections decorate external and native Session links consistently", async () => {
  const { owner } = ownerFixture();
  const records = ["openclaw", "hermes", "codex"].map((backendId) => ({ backendId,
    agentId: `${backendId}-main`, sessionKey: `${backendId}:opaque` }));
  owner._call = async () => ({ idea: { latestExecution: records[0] },
    items: records.map((latestExecution) => ({ latestExecution })), executions: [...records, { sessionKey: null }] });
  const result = await owner._inspirationCall("inspiration.executions", {});
  assert.equal(result.idea.latestExecution.sessionHref, result.executions[0].sessionHref);
  for (let index = 0; index < records.length; index++) {
    assert.equal(result.items[index].latestExecution.sessionHref, result.executions[index].sessionHref);
    const expected = index < 2 ? records[index].sessionKey : `agent:codex-main:${records[index].sessionKey}`;
    assert.equal(new URL(result.executions[index].sessionHref, "https://fixture.invalid").searchParams.get("session"), expected);
  }
  assert.equal(result.executions[3].sessionHref, null);
});
