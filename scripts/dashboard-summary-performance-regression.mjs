import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { BackendRegistry } = require(path.join(scriptDir, "../app/core/backend-registry.js"));

const sinceMs = new Date().setHours(0, 0, 0, 0);
let cronCalls = 0;
let cronStarted = false;
let usageStarted = false;
let release;
const concurrentStart = new Promise((resolve) => { release = resolve; });
const markStarted = (kind) => {
  if (kind === "cron") cronStarted = true;
  if (kind === "usage") usageStarted = true;
  if (cronStarted && usageStarted) release();
};

const backend = {
  id: "stub",
  name: "Stub",
  getAgents: () => [],
  getStatus: async () => ({ id: "stub", name: "Stub", connected: true, info: {} }),
  getRecentCronRuns: async () => {
    cronCalls++;
    markStarted("cron");
    await concurrentStart;
    return { runs: [
      { backendId: "stub", jobId: "older", startedAt: sinceMs + 1, status: "error" },
      { backendId: "stub", jobId: "newer", startedAt: sinceMs + 2, status: "ok" },
    ] };
  },
  getRecentKanbanActivities: async () => ({ supported: false, reason: "unsupported", items: [] }),
  getRunningWork: async () => ({ supported: true, items: [] }),
  getPendingApprovals: async () => ({ supported: true, items: [] }),
  getRecentArtifacts: async () => ({ supported: true, items: [] }),
  getUsageSeries: async () => {
    markStarted("usage");
    await concurrentStart;
    return { totals: { totalTokens: 0, totalCost: 0 }, daily: [] };
  },
};

const registry = new BackendRegistry();
registry.register(backend);

const summary = await Promise.race([
  registry.getDashboardSummary({ sinceMs, runsLimit: 1 }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Dashboard 独立数据源未并发启动")), 500)),
]);

assert.equal(cronCalls, 1, "Dashboard summary 不应重复调用 getRecentCronRuns");
assert.equal(summary.runs.length, 1);
assert.equal(summary.runs[0].jobId, "newer", "复用的活动 runs 仍按时间倒序和 runsLimit 截断");
assert.equal(summary.runStats.total.total, 2, "KPI 仍基于当天全量 runs，而非首屏 runsLimit");
assert.equal(summary.activityPage.items.filter((item) => item.kind === "cron").length, 2);
assert.equal(cronStarted && usageStarted, true, "活动聚合应与 usage 等首屏 section 并发");

await registry.getDashboardSummary({ sinceMs, runsLimit: 1 });
assert.equal(cronCalls, 1, "30 秒活动缓存应被 summary 复用");

const fallbackRegistry = new BackendRegistry();
fallbackRegistry.register({
  ...backend,
  id: "fallback",
  getStatus: async () => ({ id: "fallback", name: "Fallback", connected: true, info: {} }),
  getRecentCronRuns: async () => ({ runs: [
    { backendId: "fallback", jobId: "fallback-run", startedAt: sinceMs + 3, status: "ok" },
  ] }),
});
fallbackRegistry.getDashboardActivityData = async () => { throw new Error("synthetic activity failure"); };
const fallback = await fallbackRegistry.getDashboardSummary({ sinceMs, runsLimit: 1 });
assert.equal(fallback.runs[0]?.jobId, "fallback-run", "活动层整体失败时 summary 回退到独立 cron 读取");
assert.equal(fallback.activityPage, undefined);

let releaseSlowUsage;
const slowUsage = new Promise((resolve) => { releaseSlowUsage = resolve; });
const boundedRegistry = new BackendRegistry();
boundedRegistry.register({
  ...backend,
  id: "slow-usage",
  getStatus: async () => ({ id: "slow-usage", name: "Slow usage", connected: true, info: {} }),
  getRecentCronRuns: async () => ({ runs: [] }),
  getUsageSeries: () => slowUsage,
});
mock.timers.enable({ apis: ["setTimeout"] });
try {
  let settled = false;
  const bounded = boundedRegistry.getDashboardSummary({ sinceMs }).then(value => { settled = true; return value; });
  mock.timers.tick(4_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "旧聚合接口应给慢用量保留 5 秒预算");
  mock.timers.tick(1);
  assert.deepEqual((await bounded).usage, [{ backend: "slow-usage", error: "pending" }]);
} finally {
  mock.timers.reset();
}
releaseSlowUsage({ totals: { totalTokens: 7, totalCost: 1 }, daily: [] });
await slowUsage;
const warmed = await boundedRegistry.getDashboardSummary({ sinceMs });
assert.equal(warmed.usage[0]?.today?.totalTokens, 7, "后台预热完成后下一轮 summary 返回权威 usage");

let finishUsage;
let finishFiles;
const heldUsage = new Promise(resolve => { finishUsage = resolve; });
const heldFiles = new Promise(resolve => { finishFiles = resolve; });
const isolated = new BackendRegistry();
const calls = [];
let latestJob = "old";
isolated.register({
  ...backend,
  getStatus: async () => { calls.push("status"); return new Promise(() => {}); },
  getRunningWork: async () => { calls.push("running"); return new Promise(() => {}); },
  getPendingApprovals: async () => { calls.push("approvals"); return new Promise(() => {}); },
  getRecentCronRuns: async () => {
    calls.push("cron");
    return { runs: [{ backendId: backend.id, jobId: latestJob, startedAt: sinceMs + 1, status: "ok" }] };
  },
  getUsageSeries: range => { calls.push(range); return heldUsage; },
  getRecentArtifacts: () => { calls.push("files"); return heldFiles; },
});
await isolated.getDashboardActivityPage({ sinceMs });
assert.deepEqual(calls.splice(0), ["cron"]);
latestJob = "new";
const usageSection = isolated.getDashboardSection("usage", { sinceMs });
const filesSection = isolated.getDashboardSection("artifacts", { sinceMs });
const [freshActivity, sameRead] = await Promise.all([
  isolated.getDashboardSection("activity", { sinceMs }),
  isolated.getDashboardSection("activity", { sinceMs }),
]);
assert.deepEqual(calls, ["today", "7d", "files", "cron"],
  "活动分区重读并共享在途计算，分区接口不探测状态、运行记录或审批");
assert.deepEqual(freshActivity.status, [{ id: backend.id, name: backend.name }]);
assert.equal(freshActivity.activityPage.items[0].run.jobId, "new");
assert.deepEqual(sameRead.activityPage.items, freshActivity.activityPage.items);
assert.equal(freshActivity.taskStats.total.ok, 1);
const firstPage = await isolated.getDashboardActivityPage({ sinceMs });
assert.deepEqual(firstPage.items, freshActivity.activityPage.items, "分页共享新首屏的活动快照");
assert.equal(calls.filter(value => value === "cron").length, 1);
const trend = { date: "2026-11-09", totalTokens: 13, totalCost: 1 };
finishUsage({ totals: { totalTokens: 19, totalCost: 2 }, daily: [trend] });
const metrics = await usageSection;
assert.equal(metrics.usage[0].today.totalTokens, 19, "文件未完成时仍可返回真实用量");
assert.deepEqual(metrics.trends, [{ daily: [trend] }]);
finishFiles({ supported: true, items: [] });
assert.equal((await filesSection).artifacts[0].supported, true);

const liveRegistry = new BackendRegistry();
const liveCalls = [];
const expensive = async () => { throw new Error('Live polling must not fetch history, usage or artifacts'); };
liveRegistry.register({ ...backend, id: 'live',
  getRecentCronRuns: expensive, getUsageSeries: expensive, getRecentArtifacts: expensive,
  getRunningWork: async () => { liveCalls.push('running'); return { supported: true, items: [{ id: 'live-run', kind: 'inspiration' }] }; },
  getPendingApprovals: async () => { liveCalls.push('approvals'); return { supported: true, items: [{ id: 'live-request', runId: 'live-run' }] }; },
});
const live = await liveRegistry.getDashboardLiveWork();
assert.deepEqual(liveCalls.sort(), ['approvals', 'running']);
assert.equal(live.running[0].backend, 'live');
assert.equal(live.running[0].items[0].id, 'live-run');
assert.equal(live.approvals[0].items[0].runId, 'live-run');
assert.ok(live.generatedAt > 0);
assert.equal(live.usage, undefined);
liveRegistry.register({ ...backend, id: 'failing', getRunningWork: async () => { throw new Error('synthetic live failure'); } });
const partialLive = await liveRegistry.getDashboardLiveWork();
assert.equal(partialLive.running.find(section => section.backend === 'failing').reason, 'error');
assert.equal(partialLive.running.find(section => section.backend === 'live').items.length, 1);
console.log("PASS dashboard summary, independent sections, activity freshness, usage trends and live-state isolation");
