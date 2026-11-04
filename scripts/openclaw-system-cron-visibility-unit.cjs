"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawBackend, normalizeOpenClawCronJob } = require("../app/core/openclaw-backend");
const { isOpenClawSystemCronJob } = require("../app/core/openclaw-cron-visibility");
const { collectActivities } = require("../app/core/dashboard-activity");

const dreamToken = "__openclaw_memory_core_short_term_promotion_dream__";
const job = (id, extra = {}) => ({ id, name: id, enabled: true,
  schedule: { kind: "cron", expr: "0 3 * * *" }, payload: { kind: "agentTurn", message: "Report" }, ...extra });
const systemJobs = [
  job("dream", { name: "Renamed memory maintenance", declarationKey: "memory-core:memory-dreaming-promotion" }),
  job("legacy-dream", { payload: { kind: "agentTurn", message: dreamToken } }),
  job("legacy-event", { payload: { kind: "systemEvent", text: dreamToken } }),
  job("light", { payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" } }),
  job("rem", { payload: { kind: "agentTurn", message: "__openclaw_memory_core_rem_sleep__" } }),
  job("heartbeat", { payload: { kind: "heartbeat" } }),
  job("review", { payload: { kind: "skillCollectionReview" }, enabled: false }),
  job("declared-heartbeat", { declarationKey: "heartbeat:main" }),
  job("declared-review", { declarationKey: "skill-collection-review:main" }),
];
const userJobs = [
  job("user", { name: "Memory Dreaming Promotion", delivery: { mode: "none" } }),
  job("user-event", { payload: { kind: "systemEvent", text: "Remember to send the report" } }),
  job("user-heartbeat", { name: "heartbeat metrics", wakeMode: "next-heartbeat" }),
  job("imported-user", { declarationKey: "heartbeat-task:main:daily-report" }),
  job("declared-user", { declarationKey: "user:memory-report" }),
  job("adapted-user", { description: "[managed-by=memory-core.short-term-promotion]", payload: { kind: "agentTurn", message: "A custom user report" } }),
];

function fixture({ jobs = [...systemJobs, ...userJobs], pages = [], tasks = [] } = {}) {
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:1" });
  backend._connect = async () => {};
  backend.getRecentKanbanActivities = async () => ({ supported: true, items: [] });
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "cron.list") {
      const offset = params.offset || 0;
      const rows = jobs.slice(offset, offset + params.limit);
      const next = offset + rows.length;
      return { jobs: structuredClone(rows), total: jobs.length, offset, limit: params.limit,
        snapshotRevision: "fixture:stable", hasMore: next < jobs.length, nextOffset: next < jobs.length ? next : null };
    }
    if (method === "cron.runs") return pages[Math.floor((params.offset || 0) / 200)] || { entries: [], hasMore: false };
    if (method === "tasks.list") return { tasks: structuredClone(tasks) };
    throw new Error(`Unexpected RPC: ${method}`);
  };
  return { backend, calls, jobs };
}
const run = (jobId, ts, extra = {}) => ({ jobId, ts, runAtMs: ts - 1, status: "ok",
  jobName: "Memory Dreaming Promotion", summary: "NO_REPLY", sessionKey: `agent:main:cron:${jobId}:run:r-${ts}`, ...extra });

test("system classification uses reserved ownership/payloads; user names and quiet jobs remain user jobs", () => {
  for (const row of systemJobs) {
    assert.equal(isOpenClawSystemCronJob(row), true, row.id);
    assert.equal(normalizeOpenClawCronJob(row).systemManaged, true, row.id);
  }
  for (const row of userJobs) {
    assert.equal(isOpenClawSystemCronJob(row), false, row.id);
    assert.equal(normalizeOpenClawCronJob(row).systemManaged, false, row.id);
  }
});

test("the raw management inventory and per-job run history remain available without scheduler writes", async () => {
  const f = fixture({ pages: [{ entries: [run("dream", 100)], hasMore: false }] });
  const before = JSON.stringify(f.jobs);
  assert.equal((await f.backend.getCronJobs()).length, f.jobs.length);
  assert.equal((await f.backend.getCronRuns("openclaw:dream")).runs.length, 1);
  assert.equal(JSON.stringify(f.jobs), before);
  assert.ok(f.calls.every(call => ["cron.list", "cron.runs"].includes(call.method)));
});

test("Dashboard filters system runs before page limits, activity totals and success/failure counts", async () => {
  const f = fixture({ pages: [
    { entries: Array.from({ length: 200 }, (_, index) => run("dream", 1000 - index, { status: "error" })), hasMore: true, nextOffset: 200 },
    { entries: [run("legacy-dream", 700), run("review", 600), run("user", 500), run("deleted-user", 400, { status: "error" })], hasMore: false },
  ] });
  const result = await f.backend.getRecentCronRuns({ sinceMs: 100, limit: 2 });
  assert.deepEqual(result.runs.map(row => row.jobId), ["openclaw:user", "openclaw:deleted-user"]);
  assert.equal(result.truncated, undefined, "hidden maintenance must not consume the user page limit");
  assert.equal(result.runs[0].summary, "NO_REPLY", "quiet user jobs cannot be mistaken for system jobs");
  const dashboard = await collectActivities({ backends: [f.backend], sinceMs: 100 });
  assert.equal(dashboard.entries.length, 2);
  assert.equal(dashboard.runStats.total.total, 2);
  assert.deepEqual(dashboard.taskStats.total, { ok: 1, error: 1 });
  assert.deepEqual(dashboard.degradedSources, []);
});

test("system ownership is read across the full inventory and visible-only limits still truncate correctly", async () => {
  const f = fixture({ jobs: [...Array.from({ length: 200 }, (_, index) => job(`ordinary-${index}`)), systemJobs[0]],
    pages: [{ entries: [run("dream", 500), run("ordinary-0", 400), run("ordinary-1", 300)], hasMore: false }] });
  const result = await f.backend.getRecentCronRuns({ limit: 1 });
  assert.deepEqual(f.calls.filter(call => call.method === "cron.list").map(call => call.params.offset), [0, 200]);
  assert.deepEqual(result.runs.map(row => row.jobId), ["openclaw:ordinary-0"]);
  assert.equal(result.truncated, true);
});

test("running system Cron tasks are hidden while user Cron and ordinary chats stay visible", async () => {
  const f = fixture({ tasks: [
    { id: "dream-run", sessionKey: "agent:main:cron:dream:run:active" },
    { id: "review-run", sessionKey: "agent:main:cron:review" },
    { id: "user-run", title: "Memory Dreaming Promotion", sessionKey: "agent:main:cron:user:run:active" },
    { id: "chat", sessionKey: "agent:main:chat" },
  ] });
  assert.deepEqual((await f.backend.getRunningWork()).items.map(row => row.id), ["user-run", "chat"]);
  assert.ok(f.calls.every(call => ["cron.list", "tasks.list"].includes(call.method)));
});

test("ordinary live work does not request the Cron inventory", async () => {
  const f = fixture({ tasks: [{ id: "chat", sessionKey: "agent:main:chat" }] });
  assert.equal((await f.backend.getRunningWork()).items.length, 1);
  assert.deepEqual(f.calls.map(call => call.method), ["tasks.list"]);
});

test("unavailable ownership is reported as degraded instead of showing unclassified system history", async () => {
  const f = fixture();
  f.backend.getCronJobs = async () => { throw new Error("fixture inventory unavailable"); };
  const result = await f.backend.getRecentCronRuns();
  assert.deepEqual(result, { runs: [], reason: "unavailable" });
});

test("a Gateway switch cannot apply the previous Gateway's system job ids to new runs", async () => {
  for (const method of ["getRecentCronRuns", "getRunningWork"]) {
    const f = fixture({ pages: [{ entries: [run("user", 500)], hasMore: false }],
      tasks: [{ id: "user-run", sessionKey: "agent:main:cron:user:run:active" }] });
    let url = "ws://127.0.0.1:1";
    f.backend._getUpstreamUrl = () => url;
    const readJobs = f.backend.getCronJobs.bind(f.backend);
    f.backend.getCronJobs = async options => {
      const jobs = await readJobs(options);
      url = "ws://127.0.0.1:2";
      return jobs;
    };
    const result = await f.backend[method]();
    assert.deepEqual(result.runs || result.items, []);
    assert.ok(result.reason);
  }
});
