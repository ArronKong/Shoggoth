"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { HermesBackend } = require("../app/core/hermes-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

function hermes() {
  const backend = Object.create(HermesBackend.prototype);
  const mapping = { profile: "default", runtimeId: "runtime-1", storedId: "stored-1", generation: 1 };
  const snapshot = { sessions: [{ id: "runtime-1", session_key: "stored-1" }] };
  const socket = { generation: 1, request: async method => { assert.equal(method, "session.active_list"); return snapshot; } };
  Object.assign(backend, { _sessionRowsComplete: true, _lifecycleGeneration: 1,
    agents: [{ id: "hermes-default" }], profileById: new Map([["hermes-default", "default"]]),
    sessionRows: [], dashboards: new Map(), gwRuntimeByKey: new Map([["agent:hermes-default:stored-1", mapping]]),
    gwSockets: new Map([["default", socket]]) });
  return { backend, mapping, snapshot, socket };
}
test("new Hermes session uses current native identity before the chat-list refresh", async () => {
  const { backend, snapshot } = hermes();
  const owner = { sessionKey: "agent:hermes-default:stored-1" };
  for (const sessionId of ["stored-1", "runtime-1", owner.sessionKey]) {
    assert.deepEqual(await backend.resolveModelProjectionSession({ agentId: "hermes-default", sessionId }), owner);
  }
  assert.equal(await backend.resolveModelProjectionSession({ agentId: "other", sessionId: "stored-1" }), null);
  snapshot.sessions[0].id = "foreign";
  assert.equal(await backend.resolveModelProjectionSession({ agentId: "hermes-default", sessionId: "stored-1" }), null);
});
test("Hermes native compression retains the original product scope", async () => {
  const { backend, snapshot } = hermes();
  snapshot.sessions[0].session_key = "rotated-1";
  for (const sessionId of ["stored-1", "runtime-1", "rotated-1", "agent:hermes-default:stored-1"]) {
    assert.deepEqual(await backend.resolveModelProjectionSession({ agentId: "hermes-default", sessionId }),
      { sessionKey: "agent:hermes-default:stored-1" });
  }
});
test("Hermes historical and derived sessions need an exact current profile record", async () => {
  const { backend } = hermes(); backend.gwRuntimeByKey.clear(); backend.gwSockets.clear();
  const dash = {}; backend.dashboards.set("default", dash);
  const row = { id: "existing-1", profile: "default", profile_name: null };
  backend._settingsGet = async (actual, url) => { assert.equal(actual, dash); assert.equal(url, "/api/sessions/existing-1?profile=default"); return row; };
  const params = { agentId: "hermes-default", sessionId: "agent:hermes-default:existing-1" };
  assert.deepEqual(await backend.resolveModelProjectionSession(params), { sessionKey: params.sessionId });
  row.id = "existing-prefix-match"; assert.equal(await backend.resolveModelProjectionSession(params), null);
  row.id = "existing-1"; row.profile_name = "other"; assert.equal(await backend.resolveModelProjectionSession(params), null);
  row.profile_name = null; backend._settingsGet = async () => { backend._lifecycleGeneration++; return row; };
  assert.equal(await backend.resolveModelProjectionSession(params), null);
});
test("Hermes owner rejects ambiguous, stale and replaced in-flight mappings", async () => {
  const params = { agentId: "hermes-default", sessionId: "stored-1" };
  for (const change of [
    ({ snapshot }) => snapshot.sessions.push({ id: "duplicate", session_key: "stored-1" }),
    ({ socket }) => { socket.generation++; },
    ({ backend, socket, snapshot }) => { socket.request = async () => { backend._lifecycleGeneration++; return snapshot; }; },
    ({ backend, socket, mapping, snapshot }) => { socket.request = async () => { backend.gwRuntimeByKey.set("agent:hermes-default:stored-1", { ...mapping }); return snapshot; }; },
  ]) { const f = hermes(); change(f); assert.equal(await f.backend.resolveModelProjectionSession(params), null); }
});
test("OpenClaw derived model scopes remain separate from direct connector authorization", async () => {
  const backend = Object.create(OpenClawBackend.prototype);
  const row = { key: "agent:alice:cron:owned", sessionId: "physical-a", kind: "cron" };
  Object.assign(backend, { _ready: true, _stopGeneration: 1, _ws: {}, _connect: async () => {},
    request: async method => method === "agents.list" ? { agents: [{ id: "alice" }] } : { sessions: [row] } });
  const params = { agentId: "alice", sessionId: "physical-a" };
  assert.deepEqual(await backend.resolveModelProjectionSession(params), { sessionKey: row.key });
  assert.equal(await backend.resolveMcpConnectionSession(params), null);
  row.key = "agent:bob:cron:owned";
  assert.equal(await backend.resolveModelProjectionSession(params), null);
});
