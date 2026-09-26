"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadIdleInspirationAgents } = require("../app/core/inspiration-presence");
const { HermesBackend } = require("../app/core/hermes-backend");

const agentsFor = (backendId) => ["a", "b", "c"].map(id => ({ id, name: id, backendId, capabilities: { execute: true } }));
function fixture(backendId, backend) {
  const agents = agentsFor(backendId);
  const registry = {
    getInspirationAgents: async () => ({ agents }),
    listInspirations: async () => ({ items: [], hasMore: false }),
    _activeGet: () => backend,
  };
  return { agents, registry, idle: async () => (await loadIdleInspirationAgents(registry)).agents.map(agent => agent.id) };
}

test("native idle excludes every active state, chat and pre-dispatch inspiration", async () => {
  let runs = [];
  const backend = { _assertDomainReady() {}, _page: async (_method, { status }) => {
    assert.notEqual(status, null, 'never scan historical work for a greeting');
    return runs.filter(run => run.status === status);
  }, _activeBySession: new Map(),
    _profilesByAgent: new Map(["a", "b", "c"].map(id => [id, { id, enabled: true }])) };
  const f = fixture("shoggoth", backend);
  for (const status of ["queued", "starting", "running", "waiting_input", "waiting_approval"]) {
    runs = [{ profileId: "a", status, source: "chat" }, { profileId: "c", status: "completed" }];
    assert.deepEqual(await f.idle(), ["b", "c"], status);
  }
  backend._activeBySession.set("chat", { status: "starting", run: { profileId: "b" } });
  f.registry.listInspirations = async () => ({ items: [{ status: "unknown", latestExecution: { backendId: "shoggoth", agentId: "c" } }], hasMore: false });
  assert.deepEqual(await f.idle(), []);
  backend._page = async () => { throw new Error("Partial scan"); };
  assert.deepEqual(await f.idle(), []);
});

test("OpenClaw follows task pages and requires explicit idle session evidence", async () => {
  let partial = false;
  const backend = { _connect: async () => {}, request: async (method, input) => {
    if (method === "tasks.list") return input.cursor
      ? { tasks: [{ agentId: "b", status: "queued" }] }
      : { tasks: [{ agentId: "a", status: "completed" }], nextCursor: "next" };
    return { sessions: [{ key: `agent:${input.agentId}:main`, hasActiveRun: input.agentId === "c" ? undefined : false }], hasMore: partial };
  } };
  const f = fixture("openclaw", backend);
  assert.deepEqual(await f.idle(), ["a"]);
  partial = true;
  assert.deepEqual(await f.idle(), []);
  backend.request = async () => ({ tasks: [{ status: "running" }] });
  assert.deepEqual(await f.idle(), [], "unattributed active work is not proof of idle");
});

test("Hermes checks all active sessions, local queued sends, and incomplete discovery", async () => {
  let partial = false;
  const sockets = new Map(["a", "b", "c"].map(profile => [profile, {
    generation: 1, request: async () => ({ sessions: [{ id: profile, session_key: "main", status: profile === "b" ? "working" : "idle" }], truncated: partial }),
  }]));
  const backend = { profileById: new Map(["a", "b", "c"].map(id => [id, id])),
    dashboards: new Map(["a", "b", "c"].map(id => [id, {}])), gwSockets: sockets,
    _gwSocket: profile => sockets.get(profile), sendQueues: new Map([["c", Promise.resolve()]]), gwTurns: new Map(),
    _sessionTarget: profile => ({ profile }),
  };
  const f = fixture("hermes", backend);
  assert.deepEqual(await f.idle(), ["a"]);
  backend.sendQueues.clear();
  assert.deepEqual(await f.idle(), ["a", "c"]);
  partial = true;
  assert.deepEqual(await f.idle(), []);
});

test("Hermes queue stays busy across consecutive sends, then clears only its settled tail", async () => {
  const resolves = [];
  const backend = { _lifecycleGeneration: 1, sendQueues: new Map(),
    _sendMessageInner: () => new Promise(resolve => resolves.push(resolve)) };
  const enqueue = () => HermesBackend.prototype._enqueueMessage.call(backend, "session", "hello");
  const first = enqueue();
  const second = enqueue();
  await Promise.resolve();
  assert.equal(resolves.length, 1);
  resolves.shift()();
  await first;
  await Promise.resolve();
  assert.equal(backend.sendQueues.size, 1);
  resolves.shift()();
  await second;
  await Promise.resolve();
  assert.equal(backend.sendQueues.size, 0);
});

test("no enabled executor or unavailable inspiration authority produces no chatter", async () => {
  const f = fixture("unsupported", {});
  assert.deepEqual(await f.idle(), []);
  f.registry.listInspirations = async () => { throw new Error("Offline"); };
  assert.deepEqual(await f.idle(), []);
});
