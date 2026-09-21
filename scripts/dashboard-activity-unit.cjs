"use strict";

// 统一活动流纯数据层单测（TDD 先行）。夹具全部照抄真实 payload 结构：
// - OpenClaw workboard 事件：runtime-api.d.ts 的 WorkboardEvent/WorkboardRunAttempt
//   （kind 词表无 started/completed/failed/blocked/restored——完成=moved→done、
//    失败=attempt_updated+attempts[runId].status==="failed"、恢复=unarchived）
// - Hermes kanban 事件：task_events 行 {id,task_id,run_id,kind,payload,created_at(秒)}
// - cron 行：既有统一 DashboardRunEntry（openclaw status=ok|error|skipped；hermes 无 status）
// 运行：node scripts/dashboard-activity-unit.cjs

const assert = require("node:assert/strict");
const {
  cronRunToActivity,
  workboardCardToActivities,
  hermesKanbanEventToActivity,
  healthEventToActivity,
  denoiseKanban,
  encodeCursor,
  decodeCursor,
  buildActivityPage,
  computeRunStats,
  collectActivities,
} = require("../app/core/dashboard-activity");

const T0 = 1783900800000; // 假定本地零点（毫秒）

// ---------- cron ----------

function testCronSeverityMapping() {
  const mk = (status) => cronRunToActivity({
    backendId: "openclaw", jobId: "openclaw:j1", jobName: "巡检", startedAt: T0 + 1000,
    status, summary: "done",
  });
  assert.equal(mk("ok").severity, "success");
  assert.equal(mk("error").severity, "error");
  assert.equal(mk("skipped").severity, "warning");
  // Hermes 真实 run 行无 status 字段 → 中性 info（「已运行」）
  assert.equal(mk(undefined).severity, "info");
}

function testCronActivityShape() {
  const run = {
    backendId: "hermes", jobId: "hermes-default:5ec8", jobName: "早报", agentId: "hermes-default",
    startedAt: T0 + 5000, finishedAt: T0 + 9000, status: "ok", summary: "sent",
  };
  const a = cronRunToActivity(run);
  assert.equal(a.kind, "cron");
  assert.equal(a.backendId, "hermes");
  assert.equal(a.occurredAt, T0 + 9000);
  assert.equal(a.title, "早报");
  assert.equal(a.agentId, "hermes-default");
  assert.equal(a.run.jobId, "hermes-default:5ec8"); // 原 run 完整携带（Drawer 依赖）
  // id 稳定且可区分
  assert.equal(a.id, cronRunToActivity(run).id);
  const b = cronRunToActivity({ ...run, startedAt: T0 + 6000 });
  assert.notEqual(a.id, b.id);
}

// ---------- OpenClaw workboard ----------

const OC_CARD = {
  id: "c-42", title: "部署监控", status: "done", position: 1,
  createdAt: T0 + 1000, updatedAt: T0 + 90000,
  events: [
    { id: "e-created", kind: "created", at: T0 + 1000, toStatus: "todo" },
    { id: "e-heartbeat", kind: "heartbeat", at: T0 + 1500 },
    { id: "e-start", kind: "attempt_started", at: T0 + 10000, runId: "r-1" },
    { id: "e-fail", kind: "attempt_updated", at: T0 + 20000, runId: "r-1" },
    { id: "e-move-block", kind: "moved", at: T0 + 30000, fromStatus: "running", toStatus: "blocked" },
    { id: "e-move-done", kind: "moved", at: T0 + 60000, fromStatus: "review", toStatus: "done" },
    { id: "e-arch", kind: "archived", at: T0 + 80000 },
    { id: "e-unarch", kind: "unarchived", at: T0 + 90000 },
    { id: "e-old", kind: "moved", at: T0 - 5000, fromStatus: "todo", toStatus: "running" }, // 昨天 → 过滤
  ],
  metadata: {
    failureCount: 1,
    attempts: [{ id: "a-1", status: "failed", startedAt: T0 + 10000, endedAt: T0 + 20000, runId: "r-1", error: "boom" }],
  },
};

function testWorkboardRealVocabMapping() {
  const acts = workboardCardToActivities(OC_CARD, { sinceMs: T0, backendId: "openclaw" });
  const byAction = Object.fromEntries(acts.map((a) => [a.kanban.action, a]));
  assert.ok(byAction.created, "created 事件应映射");
  assert.equal(byAction.created.severity, "info");
  assert.ok(byAction.started, "attempt_started → started");
  assert.equal(byAction.failed.severity, "error", "attempt_updated+attempts.failed → failed/error");
  assert.equal(byAction.failed.summary, "boom");
  assert.equal(byAction.blocked.severity, "warning", "moved→blocked = 阻塞");
  assert.equal(byAction.completed.severity, "success", "moved→done = 完成");
  assert.equal(byAction.completed.kanban.fromStatus, "review");
  assert.ok(byAction.archived && byAction.restored, "archived/unarchived → archived/restored");
  // heartbeat 噪声与 sinceMs 之前的事件都不产出
  assert.ok(!acts.some((a) => a.occurredAt < T0), "昨天事件被过滤");
  assert.equal(acts.length, 7);
  // 全部携带 taskId/title；id 含事件 uuid 稳定
  for (const a of acts) {
    assert.equal(a.kind, "kanban");
    assert.equal(a.kanban.taskId, "c-42");
    assert.equal(a.title, "部署监控");
  }
  assert.notEqual(byAction.created.id, byAction.completed.id);
}

function testWorkboardAttemptUpdatedWithoutFailureIgnored() {
  const card = {
    ...OC_CARD,
    events: [{ id: "e1", kind: "attempt_updated", at: T0 + 100, runId: "r-9" }],
    metadata: { attempts: [{ id: "a", status: "succeeded", startedAt: T0, runId: "r-9" }] },
  };
  const acts = workboardCardToActivities(card, { sinceMs: T0, backendId: "openclaw" });
  assert.equal(acts.length, 0, "非 failed 的 attempt_updated 是进度噪声，不产出");
}

// ---------- Hermes kanban ----------

function testHermesKanbanRealVocabMapping() {
  const titleByTaskId = new Map([["t_7a63", "写周报"]]);
  const mk = (kind, id = 2001) => hermesKanbanEventToActivity(
    { id, task_id: "t_7a63", run_id: null, kind, payload: "{}", created_at: 1783900805 }, // 真实行：秒
    { profile: "default", backendId: "hermes", titleByTaskId, agentId: "hermes-default" },
  );
  assert.equal(mk("created").kanban.action, "created");
  assert.equal(mk("claimed").kanban.action, "started");
  assert.equal(mk("spawned").kanban.action, "started");
  assert.equal(mk("promoted").kanban.action, "moved");
  assert.equal(mk("blocked").severity, "warning");
  assert.equal(mk("done").severity, "success");
  assert.equal(mk("completed").severity, "success");
  assert.equal(mk("gave_up").severity, "error");
  assert.equal(mk("timed_out").severity, "error");
  assert.equal(mk("archived").kanban.action, "archived");
  assert.equal(mk("deleted").kanban.action, "deleted");
  assert.equal(mk("heartbeat"), null, "噪声 kind 忽略");
  assert.equal(mk("commented"), null);
  // created_at 秒 → occurredAt 毫秒
  assert.equal(mk("created").occurredAt, 1783900805000);
  assert.equal(mk("created").title, "写周报");
  // 查不到标题（已删任务）→ 空 title 由上层兜底
  const gone = hermesKanbanEventToActivity(
    { id: 2002, task_id: "t_gone", run_id: null, kind: "created", payload: "{}", created_at: 1783900805 },
    { profile: "default", backendId: "hermes", titleByTaskId, agentId: "hermes-default" },
  );
  assert.equal(gone.title, "");
  assert.equal(gone.kanban.taskId, "t_gone");
  // id 含 profile 与事件自增 id
  assert.notEqual(mk("created", 2001).id, mk("created", 2003).id);
}

// ---------- health ----------

function testHealthEventMapping() {
  const down = healthEventToActivity({
    targetType: "profile-dashboard", targetId: "hermes:bull", backendId: "hermes",
    state: "disconnected", at: T0 + 100, reason: "exit 1", detectedAfterRestart: true,
  });
  assert.equal(down.kind, "health");
  assert.equal(down.severity, "error");
  assert.equal(down.health.detectedAfterRestart, true);
  assert.equal(down.health.targetId, "hermes:bull");
  const up = healthEventToActivity({ targetType: "gateway", targetId: "openclaw", backendId: "openclaw", state: "connected", at: T0 + 200 });
  assert.equal(up.severity, "success");
}

// ---------- 降噪 ----------

function mkKanban(over) {
  return Object.assign({
    id: `kanban:openclaw:c1:${Math.random()}`, backendId: "openclaw", kind: "kanban",
    occurredAt: T0 + 1000, severity: "info", title: "t",
    kanban: { taskId: "c1", action: "moved", fromStatus: "todo", toStatus: "running" },
  }, over);
}

function testDenoiseTerminalOverridesGeneric() {
  const generic = mkKanban({ id: "k1", occurredAt: T0 + 1000 });
  const terminal = mkKanban({ id: "k2", occurredAt: T0 + 2200, severity: "success", kanban: { taskId: "c1", action: "completed", toStatus: "done" } });
  const out = denoiseKanban([generic, terminal]);
  assert.deepEqual(out.map((e) => e.id), ["k2"], "2s 内终态覆盖同任务泛化迁移");
}

function testDenoiseCreateOverridesInitialStatus() {
  const created = mkKanban({ id: "k1", occurredAt: T0 + 1000, kanban: { taskId: "c1", action: "created", toStatus: "todo" } });
  const initMove = mkKanban({ id: "k2", occurredAt: T0 + 1500 });
  const out = denoiseKanban([created, initMove]);
  assert.deepEqual(out.map((e) => e.id), ["k1"], "创建覆盖 2s 内初始状态设置");
}

function testDenoiseKeepsDistinctTransitions() {
  const a = mkKanban({ id: "k1", occurredAt: T0 + 1000 });
  const b = mkKanban({ id: "k2", occurredAt: T0 + 8000, kanban: { taskId: "c1", action: "moved", fromStatus: "running", toStatus: "review" } });
  const c = mkKanban({ id: "k3", occurredAt: T0 + 8500, kanban: { taskId: "OTHER", action: "completed", toStatus: "done" }, severity: "success" });
  const out = denoiseKanban([a, b, c]);
  assert.equal(out.length, 3, ">2s 的迁移与不同任务互不影响");
}

function testDenoiseDeterministic() {
  const items = [
    mkKanban({ id: "k1", occurredAt: T0 + 1000 }),
    mkKanban({ id: "k2", occurredAt: T0 + 2200, severity: "success", kanban: { taskId: "c1", action: "completed", toStatus: "done" } }),
  ];
  const once = denoiseKanban(items.slice());
  const twice = denoiseKanban(items.slice().reverse());
  assert.deepEqual(once.map((e) => e.id).sort(), twice.map((e) => e.id).sort(), "输入顺序不影响结果");
}

// ---------- 游标 + 分页 ----------

function mkEntry(occurredAt, id, over = {}) {
  return Object.assign({
    id, backendId: "openclaw", kind: "cron", occurredAt, severity: "info", title: "x",
    run: { jobId: "openclaw:j" },
  }, over);
}

function testCursorRoundtrip() {
  const c = encodeCursor({ occurredAt: T0 + 5, id: "abc:1" });
  assert.equal(typeof c, "string");
  assert.deepEqual(decodeCursor(c), { occurredAt: T0 + 5, id: "abc:1" });
  assert.equal(decodeCursor("not-a-cursor!!!"), null);
  assert.equal(decodeCursor(""), null);
}

function testPageSortsDescAndPaginatesStably() {
  // 三条同毫秒 + 两条不同毫秒；id 倒序决定同毫秒顺序
  const entries = [
    mkEntry(T0 + 100, "a"), mkEntry(T0 + 200, "b1"), mkEntry(T0 + 200, "b2"),
    mkEntry(T0 + 200, "b3"), mkEntry(T0 + 300, "c"),
  ];
  const p1 = buildActivityPage(entries, { limit: 2 });
  assert.deepEqual(p1.items.map((e) => e.id), ["c", "b3"]);
  assert.equal(p1.hasMore, true);
  const p2 = buildActivityPage(entries, { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((e) => e.id), ["b2", "b1"], "同毫秒跨页不重不漏");
  const p3 = buildActivityPage(entries, { limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.items.map((e) => e.id), ["a"]);
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextCursor, undefined);
}

function testPageFilters() {
  const entries = [
    mkEntry(T0 + 1, "e1"),
    mkEntry(T0 + 2, "e2", { backendId: "hermes" }),
    mkEntry(T0 + 3, "e3", { kind: "kanban", kanban: { taskId: "t", action: "created" } }),
    mkEntry(T0 + 4, "e4", { kind: "health", health: { targetId: "openclaw", state: "connected" } }),
  ];
  assert.deepEqual(buildActivityPage(entries, { backend: "hermes" }).items.map((e) => e.id), ["e2"]);
  assert.deepEqual(buildActivityPage(entries, { kind: "kanban" }).items.map((e) => e.id), ["e3"]);
  assert.deepEqual(buildActivityPage(entries, { kind: "health" }).items.map((e) => e.id), ["e4"]);
}

function testPageRejectsInvalidInput() {
  assert.throws(() => buildActivityPage([], { kind: "nope" }), /kind/);
  assert.throws(() => buildActivityPage([], { cursor: "garbage!!" }), /cursor/);
}

function testPageDedupesById() {
  const dup = mkEntry(T0 + 1, "same");
  const page = buildActivityPage([dup, { ...dup }], {});
  assert.equal(page.items.length, 1);
}

// ---------- runStats ----------

function testComputeRunStats() {
  const runs = [
    { backendId: "openclaw", status: "ok" }, { backendId: "openclaw", status: "ok" },
    { backendId: "openclaw", status: "error" }, { backendId: "openclaw", status: "skipped" },
    { backendId: "hermes" }, // 无 status
  ];
  const s = computeRunStats(runs);
  assert.equal(s.total.total, 5);
  assert.equal(s.total.ok, 2);
  assert.equal(s.total.error, 1);
  assert.equal(s.total.skipped, 1);
  assert.equal(s.total.other, 1);
  const oc = s.byBackend.find((b) => b.backend === "openclaw");
  assert.deepEqual({ ok: oc.ok, error: oc.error }, { ok: 2, error: 1 });
}

// ---------- collectActivities（fail-soft + 降级标记） ----------

function fakeBackend(id, impl) {
  return Object.assign({ id }, impl);
}

async function testCollectFailSoftAndDegrades() {
  const backends = [
    fakeBackend("openclaw", {
      // 真实契约：getRecentCronRuns 返回 {runs}（backend-registry 消费 .runs）
      getRecentCronRuns: async () => ({ runs: [{ backendId: "openclaw", jobId: "openclaw:j", startedAt: T0 + 1, status: "ok" }] }),
      getRecentKanbanActivities: async () => { throw new Error("rpc down"); },
    }),
    fakeBackend("hermes", {
      // 旧版 404 → 覆盖实现显式 latestOnly（行本身也带 synthesized）
      getRecentCronRuns: async () => ({ latestOnly: true, runs: [{ backendId: "hermes", jobId: "hermes-default:x", startedAt: T0 + 2, synthesized: true }] }),
      getRecentKanbanActivities: async () => ({ supported: true, truncated: true, items: [
        mkKanban({ id: "hk1", backendId: "hermes", occurredAt: T0 + 3 }),
      ] }),
    }),
  ];
  const res = await collectActivities({ backends, sinceMs: T0, healthEvents: [
    { targetType: "gateway", targetId: "openclaw", backendId: "openclaw", state: "disconnected", at: T0 + 4 },
  ] });
  // 三类都在，单源失败不拖垮
  assert.ok(res.entries.some((e) => e.kind === "cron" && e.backendId === "openclaw"));
  assert.ok(res.entries.some((e) => e.kind === "kanban" && e.backendId === "hermes"));
  assert.ok(res.entries.some((e) => e.kind === "health"));
  const reasons = res.degradedSources.map((d) => `${d.backend}/${d.source}:${d.reason}`).sort();
  assert.ok(reasons.includes("openclaw/kanban:error"), `kanban 抛错→error 降级, got ${reasons}`);
  assert.ok(reasons.includes("hermes/cron:latest-only"), "synthesized→latest-only");
  assert.ok(reasons.includes("hermes/kanban:truncated"), "truncated 透传");
  // runStats 基于全量 cron
  assert.equal(res.runStats.total.total, 2);
  assert.equal(res.runs.length, 2, "聚合结果保留 cron 原始行，供 Dashboard 首屏复用，避免重复拉取");
}

async function testCollectHonorsMaxPerSource() {
  const many = Array.from({ length: 5 }, (_, i) => ({ backendId: "openclaw", jobId: `openclaw:j${i}`, startedAt: T0 + i, status: "ok" }));
  const backends = [fakeBackend("openclaw", {
    getRecentCronRuns: async () => ({ runs: many }),
    getRecentKanbanActivities: async () => ({ supported: false, reason: "unsupported", items: [] }),
  })];
  const res = await collectActivities({ backends, sinceMs: T0, healthEvents: [], maxPerSource: 3 });
  assert.equal(res.entries.filter((e) => e.kind === "cron").length, 3);
  assert.equal(res.runs.length, 3, "runs 与 maxPerSource 使用同一截断口径");
  assert.ok(res.degradedSources.some((d) => d.backend === "openclaw" && d.source === "cron" && d.reason === "truncated"),
    "触顶 → truncated 显式降级");
  // unsupported 的来源不进降级列表（本来就不支持 ≠ 降级）
  assert.ok(!res.degradedSources.some((d) => d.source === "kanban"));
}

async function testCollectHidesOnlySystemHeartbeatRuns() {
  const heartbeatRuns = [
    { status: "ok", summary: "heartbeat wake requested" },
    { status: "ok", summary: "heartbeat completed" },
    { status: "ok", summary: "heartbeat task completed" },
    { status: "error", error: "heartbeat failed: agent-runner-failure" },
    { status: "error", summary: "heartbeat failed: agent-runner-failure" },
    { status: "skipped", error: "heartbeat skipped: active-hours" },
  ].map((result, i) => ({ backendId: "openclaw", jobId: `openclaw:hb-${i}`, jobName: "heartbeat-vincent", startedAt: T0 + i, ...result }));
  const ordinaryRuns = [
    { backendId: "openclaw", jobId: "openclaw:user", jobName: "heartbeat-report", startedAt: T0 + 10, status: "ok", summary: "service is healthy" },
    { backendId: "openclaw", jobId: "openclaw:report", startedAt: T0 + 11, status: "error", error: "daily report failed" },
    { backendId: "openclaw", jobId: "openclaw:mention", startedAt: T0 + 12, status: "ok", summary: "Investigated heartbeat failed: agent-runner-failure" },
  ];
  const runs = [...heartbeatRuns, ...ordinaryRuns];
  const backend = fakeBackend("openclaw", {
    getRecentCronRuns: async () => ({ runs }),
    getRecentKanbanActivities: async () => ({ supported: false, reason: "unsupported", items: [] }),
  });
  const res = await collectActivities({ backends: [backend], sinceMs: T0 });
  assert.deepEqual(res.entries.map((e) => e.run.jobId), ordinaryRuns.map((r) => r.jobId), "隐藏 heartbeat 的成功、失败、跳过记录，保留普通任务");
  const page = buildActivityPage(res.entries, { kind: "cron", backend: "openclaw", limit: 1 });
  assert.equal(page.items[0].run.jobId, "openclaw:mention");
  assert.equal(buildActivityPage(res.entries, { kind: "cron", cursor: page.nextCursor }).items.length, 2, "筛选与翻页均不带回 heartbeat");
  assert.equal(res.runs.length, runs.length, "原始运行数据仍保留");
  assert.equal(res.runStats.total.total, runs.length, "原始运行统计口径保持不变");

  const hermes = fakeBackend("hermes", {
    getRecentCronRuns: async () => ({ runs: [{ ...heartbeatRuns[3], backendId: "hermes", jobId: "hermes:user" }] }),
  });
  const otherBackend = await collectActivities({ backends: [hermes], sinceMs: T0 });
  assert.equal(otherBackend.entries.length, 1, "OpenClaw 系统摘要规则不误伤其他后端任务");
}

async function testCollectFetchesIndependentSourcesConcurrently() {
  let cronStarted = false;
  let kanbanStarted = false;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const markStarted = (source) => {
    if (source === "cron") cronStarted = true;
    if (source === "kanban") kanbanStarted = true;
    if (cronStarted && kanbanStarted) release();
  };
  const backend = fakeBackend("openclaw", {
    getRecentCronRuns: async () => {
      markStarted("cron");
      await bothStarted;
      return { runs: [] };
    },
    getRecentKanbanActivities: async () => {
      markStarted("kanban");
      await bothStarted;
      return { supported: true, items: [] };
    },
  });
  await Promise.race([
    collectActivities({ backends: [backend], sinceMs: T0 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cron/kanban 来源被串行执行")), 500)),
  ]);
  assert.equal(cronStarted && kanbanStarted, true);
}

// ---------- runner ----------

const tests = [
  testCronSeverityMapping, testCronActivityShape,
  testWorkboardRealVocabMapping, testWorkboardAttemptUpdatedWithoutFailureIgnored,
  testHermesKanbanRealVocabMapping, testHealthEventMapping,
  testDenoiseTerminalOverridesGeneric, testDenoiseCreateOverridesInitialStatus,
  testDenoiseKeepsDistinctTransitions, testDenoiseDeterministic,
  testCursorRoundtrip, testPageSortsDescAndPaginatesStably, testPageFilters,
  testPageRejectsInvalidInput, testPageDedupesById, testComputeRunStats,
  testCollectFailSoftAndDegrades, testCollectHonorsMaxPerSource,
  testCollectHidesOnlySystemHeartbeatRuns,
  testCollectFetchesIndependentSourcesConcurrently,
];

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`  ✅ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${t.name}: ${e.message}`);
    }
  }
  console.log(failed ? `FAILED ${failed}/${tests.length}` : `PASS ${tests.length}/${tests.length}`);
  process.exit(failed ? 1 : 0);
})();
