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
  console.log("PASS Dashboard full terminal totals, distinct tasks, all native Agents and archived task completions");
})().catch(error => { console.error(error); process.exitCode = 1; });
