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
  return { agents, registry, idle: async () => (await loadIdleInspirationAgents(registry)).agents.map(agent => agent.id),
    presence: async () => {
      const result = await loadIdleInspirationAgents(registry);
      return { idle: result.agents.map(agent => agent.id), busy: result.busyAgents.map(agent => agent.id) };
    } };
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
    assert.deepEqual(await f.presence(), { idle: ["b", "c"], busy: ["a"] });
  }
  backend._activeBySession.set("chat", { status: "starting", run: { profileId: "b" } });
  f.registry.listInspirations = async () => ({ items: [{ status: "unknown", latestExecution: { backendId: "shoggoth", agentId: "c" } }], hasMore: false });
  assert.deepEqual(await f.idle(), []);
  assert.deepEqual(await f.presence(), { idle: [], busy: ["a", "b"] }, "unknown inspiration blocks idle without claiming busy");
  backend._page = async () => { throw new Error("Partial scan"); };
  assert.deepEqual(await f.presence(), { idle: [], busy: [] });
});

test("OpenClaw follows task pages and requires explicit idle session evidence", async () => {
  let partial = false;
  const backend = { _connect: async () => {}, hasGatewayMethod: () => true, request: async (method, input) => {
    if (method === "tasks.list") return input.cursor
      ? { tasks: [{ agentId: "b", status: "queued" }] }
      : { tasks: [{ agentId: "a", status: "completed" }], nextCursor: "next" };
    return { sessions: [{ key: `agent:${input.agentId}:main`, hasActiveRun: input.agentId === "c" ? undefined : false }], hasMore: partial };
  } };
  const f = fixture("openclaw", backend);
  assert.deepEqual(await f.idle(), ["a"]);
  assert.deepEqual(await f.presence(), { idle: ["a"], busy: ["b"] });
  partial = true;
  assert.deepEqual(await f.idle(), []);
  backend.request = async () => ({ tasks: [{ status: "running" }] });
  assert.deepEqual(await f.idle(), [], "unattributed active work is not proof of idle");
});

test("OpenClaw without tasks.list reads live sessions and never marks unknown agents busy", async () => {
  const calls = [];
  const backend = { _connect: async () => {}, hasGatewayMethod: method => method === "sessions.list",
    request: async (method, input) => {
      calls.push(method);
      assert.equal(method, "sessions.list", "do not call the removed ledger RPC");
      return { sessions: [{ key: `agent:${input.agentId}:main`, status: "running",
        hasActiveRun: { a: false, b: true }[input.agentId] }] };
    } };
  const f = fixture("openclaw", backend);
  assert.deepEqual(await f.presence(), { idle: ["a"], busy: ["b"] }, "explicit idle wins over stale running, missing evidence stays unknown");
  assert.equal(calls.length, 3);
  backend.hasGatewayMethod = () => false;
  assert.deepEqual(await f.presence(), { idle: [], busy: [] });
  assert.equal(calls.length, 3, "no unsupported session calls");
});

test("OpenClaw advertised ledger failure cannot become idle or a busy badge", async () => {
  const calls = [];
  const backend = { _connect: async () => {}, hasGatewayMethod: () => true, request: async method => {
    calls.push(method);
    throw new Error("unknown method: tasks.list");
  } };
  assert.deepEqual(await fixture("openclaw", backend).presence(), { idle: [], busy: [] });
  assert.deepEqual(calls, ["tasks.list"]);
});

test("OpenClaw legacy terminal tasks clear busy and unresolved task states remain unknown", async () => {
  let taskStatus = "cancelled";
  const backend = { _connect: async () => {}, hasGatewayMethod: () => true, request: async (method, input) => {
    if (method === "tasks.list") return { tasks: [{ agentId: "a", status: taskStatus }] };
    return { sessions: [{ key: `agent:${input.agentId}:main`, hasActiveRun: false }] };
  } };
  const f = fixture("openclaw", backend);
  for (taskStatus of ["completed", "failed", "cancelled", "timed_out", "canceled"]) {
    assert.deepEqual(await f.presence(), { idle: ["a", "b", "c"], busy: [] }, taskStatus);
  }
  taskStatus = "unknown";
  assert.deepEqual(await f.presence(), { idle: ["b", "c"], busy: [] });
});

test("OpenClaw incomplete or failed sessions stay unknown while explicit active rows remain busy", async () => {
  let result = {};
  const backend = { _connect: async () => {}, hasGatewayMethod: method => method === "sessions.list",
    request: async (_method, { agentId }) => {
      if (result instanceof Error) throw result;
      return { sessions: [{ key: `agent:${agentId}:main`, hasActiveRun: false }], ...result };
    } };
  const f = fixture("openclaw", backend);
  for (result of [{ hasMore: true }, { truncated: true }, { nextCursor: "next" }, { count: 2 },
    { sessions: null }, { sessions: [null] }, { sessions: [{ key: "agent:other:main", hasActiveRun: false }] },
    new Error("unavailable")]) {
    assert.deepEqual(await f.presence(), { idle: [], busy: [] });
  }
  backend.request = async (_method, { agentId }) => ({ hasMore: true,
    sessions: [{ key: `agent:${agentId}:main`, hasActiveRun: agentId === "b" }] });
  assert.deepEqual(await f.presence(), { idle: [], busy: ["b"] });
  backend.request = async (_method, { agentId }) => ({ sessions: Array.from({ length: 100 }, (_, i) => ({
    key: `agent:${agentId}:${i}`, hasActiveRun: false,
  })) });
  assert.deepEqual(await f.presence(), { idle: [], busy: [] }, "the row cap cannot prove idle");
  backend.request = async (_method, { agentId }) => ({ sessions: [{ key: `agent:${agentId}:main`, hasActiveRun: false,
    status: { a: "queued", b: "waiting_approval", c: "unknown" }[agentId] }] });
  assert.deepEqual(await f.presence(), { idle: [], busy: ["a", "b"] });
  backend.request = async () => ({ sessions: [] });
  assert.deepEqual(await f.presence(), { idle: ["a", "b", "c"], busy: [] });
});

test("OpenClaw presence does not survive a connection change during a read", async () => {
  const backend = { _connect: async () => {}, _connectionGeneration: 1, hasGatewayMethod: method => method === "sessions.list",
    request: async (_method, { agentId }) => {
      backend._connectionGeneration++;
      return { sessions: [{ key: `agent:${agentId}:main`, hasActiveRun: agentId === "a" }] };
    } };
  assert.deepEqual(await fixture("openclaw", backend).presence(), { idle: [], busy: [] });
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
  assert.deepEqual(await f.presence(), { idle: ["a"], busy: ["b", "c"] });
  backend.sendQueues.clear();
  assert.deepEqual(await f.idle(), ["a", "c"]);
  partial = true;
  assert.deepEqual(await f.presence(), { idle: [], busy: ["b"] });
  sockets.get("b").request = async () => { throw new Error("offline"); };
  assert.deepEqual(await f.presence(), { idle: [], busy: [] });
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
  assert.deepEqual(await f.presence(), { idle: [], busy: [] });
  f.registry.listInspirations = async () => { throw new Error("Offline"); };
  assert.deepEqual(await f.presence(), { idle: [], busy: [] });
});

test("confirmed inspiration work marks only its backend and agent busy", async () => {
  const agents = ["openclaw", "shoggoth", "hermes"].map(backendId => ({
    id: "shared", backendId, capabilities: { execute: true },
  }));
  const result = await loadIdleInspirationAgents({ getInspirationAgents: async () => ({ agents }), _activeGet: () => null,
    listInspirations: async () => ({ items: [
      { status: "running", latestExecution: { backendId: "openclaw", agentId: "shared" } },
      { status: "unknown", latestExecution: { backendId: "hermes", agentId: "shared" } },
    ], hasMore: false }),
  });
  assert.deepEqual(result, { agents: [], busyAgents: [agents[0]] });
});
