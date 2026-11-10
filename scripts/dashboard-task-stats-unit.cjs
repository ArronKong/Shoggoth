"use strict";
const assert = require("node:assert/strict");
const { computeTaskStats, collectActivities, buildActivityPage } = require("../app/core/dashboard-activity");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

(async () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({ id: `cron-${i}`, kind: "cron", backendId: "native",
    agentId: `agent-${i % 10}`, occurredAt: 100 + i, run: { runId: `run-${i}`, status: "ok" } }));
  const idea = (status, id = status) => ({ id: `idea-${id}`, kind: "inspiration", backendId: "native", agentId: "other",
    occurredAt: 200, inspiration: { runId: id, status } });
  const task = (action, id = action) => ({ id: `task-${id}`, kind: "kanban", backendId: "native", agentId: "other",
    occurredAt: 200, kanban: { taskId: id, action } });
  entries.push(idea("completed"), idea("failed"), idea("running"), idea("queued"), idea("canceled"),
    task("created"), task("moved"), task("completed"), task("failed"), task("blocked"),
    { ...task("completed"), id: "duplicate-completion-event" },
    { ...idea("completed"), backendId: "second" },
    { ...task("completed", "yesterday"), occurredAt: 99 },
    { id: "health", kind: "health", occurredAt: 200, severity: "success" });
  const stats = computeTaskStats(entries, { sinceMs: 100 });
  assert.deepEqual(stats.total, { ok: 153, error: 2 });
  assert.deepEqual(stats.byKind.kanban, { ok: 1, error: 1 });
  assert.deepEqual(stats.byAgent.find(row => row.backendId === "native" && row.agentId === "other"),
    { backendId: "native", agentId: "other", ok: 2, error: 2 });
  assert.equal(buildActivityPage(entries).items.length, 100);
  assert.equal(computeTaskStats(entries, { degradedSources: [{ source: "kanban", reason: "error" }] }).complete, false);

  const native = Object.create(ShoggothBackend.prototype);
  native.backendId = "native";
  native._assertDomainReady = () => {};
  native._profilesById = new Map([1, 2].map(i => [`p${i}`, { id: `p${i}`, agentId: `a${i}` }]));
  native._dashboardProfiles = async () => [...native._profilesById.values()];
  native._listBoardsForProfile = async profile => [{ id: `b${profile.id}` }];
  native._assertDomainAggregate = () => ({ bytes: 0, items: 0 });
  native._domainPage = async (method, params) => method === "kanban.card.list"
    ? [{ id: `c${params.boardId}`, title: "Archived completed task", boardId: params.boardId,
      profileId: params.boardId.slice(1), archivedAt: 300, updatedAt: 300, completion: { at: 200 } }]
    : [{ id: `r${params.cardId}`, profileId: params.cardId.slice(2), status: "failed", finishedAt: 150 }];
  const activities = await native.getRecentKanbanActivities({ sinceMs: 100 });
  assert.equal(activities.items.length, 4);
  assert.deepEqual(computeTaskStats(activities.items).total, { ok: 2, error: 2 });

  const overnight = { id: "overnight", profileId: "p1", source: "cron", sourceId: "job",
    createdAt: 80, startedAt: 90, finishedAt: 101, status: "completed", resultSummary: "report" };
  const silent = { ...overnight, id: "silent", finishedAt: 110 };
  const calls = [];
  let legacy = false;
  native._page = async (method, params) => {
    assert.equal(method, "run.list");
    calls.push(params.scope ? "scoped" : params.profileId);
    if (params.scope) {
      assert.deepEqual(params.scope, { backendId: "native", source: "cron", sinceMs: 100 });
      if (legacy) throw Object.assign(Error("Legacy Service"), { code: "INVALID_PARAMS" });
      return [overnight, silent];
    }
    return params.profileId === "p1" ? [overnight, silent,
      { ...overnight, id: "past", finishedAt: 99 },
      { ...overnight, id: "chat", source: "chat" }] : [];
  };
  native._domainPage = async (method, params) => {
    assert.equal(method, "cron.job.list");
    calls.push(`jobs:${params.profileId}`);
    return [{ id: "job", name: "Overnight report" }];
  };
  native._cronRunsForJob = async (jobId, profile) => {
    assert.equal(jobId, "job");
    assert.equal(profile.id, "p1");
    return [{ run: silent, createdAt: silent.createdAt, cronOutput: { disposition: "silent", reason: "no-output" } }];
  };
  const current = await native.getRecentCronRuns({ sinceMs: 100 });
  assert.deepEqual(calls.splice(0), ["scoped", "jobs:p1"]);
  assert.deepEqual(current.runs.map(row => row.runId), ["silent", "overnight"]);
  assert.equal(current.runs[0].outputDisposition, "silent");
  assert.equal(current.runs[1].summary, "report");
  assert.equal(current.runs[1].jobName, "Overnight report");
  legacy = true;
  assert.deepEqual(await native.getRecentCronRuns({ sinceMs: 100 }), current);
  assert.deepEqual(calls.sort(), ["jobs:p1", "p1", "p2", "scoped"], "Legacy fallback keeps the same visible runs");
  console.log("PASS Dashboard full terminal totals, distinct tasks, all native Agents and archived task completions");
})().catch(error => { console.error(error); process.exitCode = 1; });
