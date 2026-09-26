import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
const boundedStartedAt = Date.now();
const bounded = await boundedRegistry.getDashboardSummary({ sinceMs });
const boundedElapsed = Date.now() - boundedStartedAt;
assert.ok(boundedElapsed < 2_200, `慢 usage 不应阻塞首屏，实际 ${boundedElapsed}ms`);
assert.deepEqual(bounded.usage, [{ backend: "slow-usage", error: "pending" }]);
releaseSlowUsage({ totals: { totalTokens: 7, totalCost: 1 }, daily: [] });
await slowUsage;
const warmed = await boundedRegistry.getDashboardSummary({ sinceMs });
assert.equal(warmed.usage[0]?.today?.totalTokens, 7, "后台预热完成后下一轮 summary 返回权威 usage");

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
console.log("PASS dashboard summary concurrency, cron reuse, bounded usage and lightweight live-state isolation");
