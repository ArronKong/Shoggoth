"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { fixture } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const { inspirationExecutionToActivity, collectActivities, buildActivityPage } = require("../app/core/dashboard-activity");
const { BackendRegistry } = require("../app/core/backend-registry");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { validateInspirationServiceResult } = require("../app/agent-service/inspiration-service-protocol");

test("Inspiration history uses bounded pages across backends and every execution round", async (t) => {
  const f = await fixture(t);
  let clock = 100;
  f.store.now = () => clock;
  const older = await f.create("昨天的灵感");
  const prepare = (idea, backendId) => f.store.prepareExternalExecution({ id: idea.id,
    expectedRevision: idea.revision, operationId: randomUUID(), backendId, agentId: "same-agent",
    workspace: null, instruction: "" }, () => true);
  prepare(older, "hermes");
  clock = 200;
  const idea = await f.create("新的灵感".repeat(300));
  const firstRun = prepare(idea, "openclaw");
  f.store.failPreparation(firstRun.id, "INSPIRATION_START_FAILED");
  prepare(f.store.get(idea.id), "hermes");
  const query = { sinceMs: 200, cursor: null, limit: 1 };
  const first = await f.call("activities", query);
  assert.equal(first.total, 2);
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal([...first.items[0].title].length, 80);
  assert.equal(first.items[0].ideaId, idea.id);
  const second = await f.call("activities", { ...query, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.backendId)), new Set(["openclaw", "hermes"]));
  assert.equal((await f.call("activities", { ...query, sinceMs: 202 })).items.length, 0);
  assert.equal(f.host.turnStarts, 0, "history reads never start a Runtime");
  for (const patch of [{ sinceMs: -1 }, { sinceMs: NaN }, { limit: 51 }, { cursor: "bad" }]) {
    await assert.rejects(f.call("activities", { ...query, ...patch }), { code: "INSPIRATION_INVALID" });
  }
  for (const patch of [{ status: "saved" }, { ideaId: "wrong" }, { createdAt: -1 }, { unexpected: true }]) {
    assert.throws(() => validateInspirationServiceResult("inspiration.activities",
      { ...first, items: [{ ...first.items[0], ...patch }] }), { code: "INSPIRATION_RESPONSE_INVALID" });
  }
});

const execution = (id, backendId = "native", status = "completed") => ({ id, backendId, status,
  ideaId: "idea", runId: `run-${id}`, agentId: "agent", createdAt: 100, title: "灵感标题", summary: "本轮成果" });

test("Inspiration status updates preserve row identity and map severity", () => {
  const row = inspirationExecutionToActivity(execution("execution"));
  for (const [status, severity] of Object.entries({ completed: "success", failed: "error", running: "info",
    queued: "info", starting: "info", waiting_input: "warning", waiting_approval: "warning",
    canceled: "warning", interrupted: "warning", skipped: "warning", unknown: "warning" })) {
    const update = inspirationExecutionToActivity(execution("execution", "native", status));
    assert.equal(update.id, row.id);
    assert.equal(update.severity, severity);
    assert.equal(update.inspiration.status, status);
  }
  assert.equal(buildActivityPage([row], { kind: "inspiration" }).items[0], row);
  assert.deepEqual(buildActivityPage([row], { kind: "cron" }).items, []);
});

test("Dashboard queries the shared owner once, filters disconnected backends and isolates failures", async () => {
  const registry = new BackendRegistry();
  const backend = id => ({ id, getAgents: () => [],
    getRecentCronRuns: async () => ({ runs: [{ backendId: id, jobId: "cron", startedAt: 100, status: "ok" }] }),
    getRecentKanbanActivities: async () => ({ supported: false, items: [] }) });
  registry.register(backend("native")); registry.register(backend("other"));
  registry.setDisabledBackendsProvider(() => ["other"]);
  const owner = Object.create(ShoggothBackend.prototype);
  owner.backendId = "native";
  const calls = [];
  owner._call = async (method, params) => {
    calls.push({ method, params });
    return { items: [execution("one"), execution("two", "other")], hasMore: false, nextCursor: null };
  };
  registry.setInspirationOwner(owner);
  const page = await registry.getDashboardActivityPage({ sinceMs: 0, kind: "inspiration" });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].backendId, "native");
  await registry.getDashboardActivityPage({ sinceMs: 0 });
  assert.deepEqual(calls, [{ method: "inspiration.activities", params: { sinceMs: 0, cursor: null, limit: 50 } }]);
  owner._call = async () => { throw new Error("Service offline"); };
  const degraded = await collectActivities({ backends: [backend("native")], sinceMs: 0, inspirationOwner: owner });
  assert.equal(degraded.entries.length, 1);
  assert.equal(degraded.entries[0].kind, "cron");
  assert.deepEqual(degraded.degradedSources, [{ backend: "native", source: "inspiration", reason: "error" }]);
});

test("Owner walks bounded Service pages and reports truncation", async () => {
  const owner = Object.create(ShoggothBackend.prototype);
  const calls = [];
  owner._call = async (_method, params) => {
    calls.push(params);
    return { items: Array.from({ length: params.limit }, (_, i) => execution(`${calls.length}-${i}`)),
      hasMore: true, nextCursor: `cursor-${calls.length}` };
  };
  const result = await owner.getRecentInspirationActivities({ sinceMs: 100, limit: 52 });
  assert.deepEqual(calls, [{ sinceMs: 100, limit: 50, cursor: null }, { sinceMs: 100, limit: 2, cursor: "cursor-1" }]);
  assert.equal(result.items.length, 52);
  assert.equal(result.truncated, true);
});


test("an Inspiration started yesterday and finished today enters today's terminal totals", async t => {
  const f = await fixture(t);
  let clock = 100;
  f.store.now = () => clock;
  const idea = await f.create("跨日灵感");
  const execution = f.store.prepareExternalExecution({ id: idea.id, expectedRevision: idea.revision,
    operationId: randomUUID(), backendId: "hermes", agentId: "same-agent", workspace: null, instruction: "" }, () => true);
  clock = 300;
  f.store.failPreparation(execution.id, "INSPIRATION_START_FAILED");
  const result = await f.call("activities", { sinceMs: 200, cursor: null, limit: 50 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].createdAt, 100);
  assert.equal(result.items[0].finishedAt, 300);
  assert.equal(inspirationExecutionToActivity(result.items[0]).occurredAt, 300);
});
