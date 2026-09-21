"use strict";

// 切片2：契约默认实现 + 双后端活动数据源单测（TDD 先行）。
// 桩打在既有内部惯用法上：OpenClaw = this._connect()/this.request(method,params,timeout)；
// Hermes = 新增 this._httpGetJson(url, token)（包一层模块级 httpGet，可注入）。
// 运行：node scripts/dashboard-backends-unit.cjs

const assert = require("node:assert/strict");
const { AgentBackend } = require("../app/core/agent-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");

const T0 = 1783900800000; // 本地零点（毫秒）；对应秒 1783900800

// ---------- A. 契约默认实现 ----------

class StubBackend extends AgentBackend {
  get id() { return "stub"; }
  async getStatus() { return { id: "stub", name: "Stub", connected: false, info: { error: "unreachable" } }; }
}

async function testContractDefaults() {
  const b = new StubBackend();
  const k = await b.getRecentKanbanActivities({ sinceMs: 0 });
  assert.equal(k.supported, false);
  assert.equal(k.reason, "unsupported");
  assert.deepEqual(k.items, []);
  assert.equal(await b.resolveArtifactPreview("/tmp/x.png"), null);
}

async function testDefaultHealthTargetsFromStatus() {
  const b = new StubBackend();
  const targets = await b.getHealthTargets();
  assert.equal(targets.length, 1);
  assert.deepEqual(
    { type: targets[0].targetType, id: targets[0].targetId, state: targets[0].state },
    { type: "backend", id: "stub", state: "disconnected" },
  );
  b.getStatus = async () => ({ id: "stub", name: "Stub", connected: true, info: {} });
  const up = await b.getHealthTargets();
  assert.equal(up[0].state, "connected");
}

// ---------- B. OpenClaw cron 全天回溯（scope:all + offset 分页） ----------

function ocEntry(ts, i, over = {}) {
  // 真实 CronRunLogEntry 形状（cron.d.ts）：ts 必填毫秒、action:"finished"
  return Object.assign({
    ts, jobId: `j${i}`, action: "finished", status: "ok", summary: `run ${i}`,
    sessionKey: `agent:main:cron:${i}`, jobName: `任务${i}`,
  }, over);
}

function mkOcBackend(pages) {
  const b = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:1" });
  b._connect = async () => {};
  b.calls = [];
  b.request = async (method, params) => {
    b.calls.push({ method, params });
    if (method === "cron.runs") {
      const idx = Math.floor((params.offset || 0) / 200);
      return pages[idx] || { entries: [], hasMore: false, nextOffset: null };
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  return b;
}

async function testOcPagesUntilMidnightBoundary() {
  const page0 = { entries: Array.from({ length: 200 }, (_, i) => ocEntry(T0 + 100000 - i * 10, i)), hasMore: true, nextOffset: 200 };
  const page1 = { entries: [ocEntry(T0 + 5, 200), ocEntry(T0 - 100, 201)], hasMore: true, nextOffset: 400 };
  const b = mkOcBackend([page0, page1]);
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(b.calls.length, 2, "跨过零点后不再翻页");
  assert.deepEqual(b.calls.map((c) => c.params.offset || 0), [0, 200]);
  assert.equal(b.calls[0].params.scope, "all");
  assert.equal(b.calls[0].params.sortDir, "desc");
  assert.equal(r.runs.length, 201, "零点之前的行不进结果");
  assert.ok(r.runs.every((x) => x.startedAt >= T0));
  assert.ok(!r.truncated, "自然到边界 ≠ 截断");
  // 映射保持既有统一形状
  assert.equal(r.runs[0].backendId, "openclaw");
  assert.ok(r.runs[0].jobId.startsWith("openclaw:"));
  assert.equal(r.runs[0].status, "ok");
}

async function testOcLimitTruncates() {
  const page0 = { entries: Array.from({ length: 10 }, (_, i) => ocEntry(T0 + 1000 - i, i)), hasMore: true, nextOffset: 200 };
  const b = mkOcBackend([page0]);
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5 });
  assert.equal(r.runs.length, 5);
  assert.equal(r.truncated, true, "到 limit 时还有今天的行 → truncated");
  assert.equal(b.calls.length, 1, "到 limit 就停，不再翻页");
}

async function testOcStopsWhenNoMore() {
  const page0 = { entries: [ocEntry(T0 + 50, 0)], hasMore: false, nextOffset: null };
  const b = mkOcBackend([page0]);
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(r.runs.length, 1);
  assert.equal(b.calls.length, 1);
  assert.ok(!r.truncated);
}

async function testOcRpcFailureIsFailSoft() {
  const b = mkOcBackend([]);
  b.request = async () => { throw new Error("gateway down"); };
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 100 });
  assert.deepEqual(r.runs, []);
}

// ---------- C. OpenClaw workboard 活动源 ----------

async function testOcKanbanActivities() {
  const card = {
    id: "c-1", title: "发布", status: "done", agentId: "main",
    events: [
      { id: "e1", kind: "created", at: T0 + 1000, toStatus: "todo" },
      { id: "e2", kind: "moved", at: T0 + 5000, fromStatus: "review", toStatus: "done" },
      { id: "e3", kind: "heartbeat", at: T0 + 6000 },
    ],
    metadata: {},
  };
  const b = mkOcBackend([]);
  b.request = async (method) => {
    assert.equal(method, "workboard.cards.list");
    return { cards: [card], statuses: [] };
  };
  const r = await b.getRecentKanbanActivities({ sinceMs: T0 });
  assert.equal(r.supported, true);
  assert.equal(r.items.length, 2);
  const done = r.items.find((x) => x.kanban.action === "completed");
  assert.equal(done.severity, "success");
  assert.equal(done.kanban.taskId, "c-1");
  assert.equal(done.agentId, "main");
}

async function testOcKanbanUnavailableOnRpcFailure() {
  const b = mkOcBackend([]);
  b.request = async () => { throw new Error("no workboard"); };
  const r = await b.getRecentKanbanActivities({ sinceMs: T0 });
  assert.equal(r.supported, false);
  assert.equal(r.reason, "unavailable");
  assert.deepEqual(r.items, []);
}

// ---------- D. Hermes cron runs 覆盖 ----------

function mkHermes({ jobs, runsByLocalId = {}, messagesBySessionId = {}, status = 200 }) {
  const b = new HermesBackend({});
  b._readCronExecutionHistory = async () => { throw new Error("fixture without local ledger"); };
  b.dashboards = new Map([
    ["default", { baseUrl: "http://127.0.0.1:9119", token: "tok1" }],
    ["bull", { baseUrl: "http://127.0.0.1:9120", token: "tok2" }],
  ]);
  b.profileById = new Map([["hermes-default", "default"], ["hermes-bull", "bull"]]);
  b.getCronJobs = async () => jobs;
  b.calls = [];
  b._httpGetJson = async (url, token) => {
    b.calls.push({ url, token });
    const sessionMatch = /\/api\/sessions\/([^/]+)\/messages/.exec(url);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      return Object.hasOwn(messagesBySessionId, sessionId)
        ? { status: 200, json: { messages: messagesBySessionId[sessionId] } }
        : { status: 404, json: null };
    }
    if (status !== 200) return { status, json: null };
    const m = /\/api\/cron\/jobs\/([^/]+)\/runs/.exec(url);
    const localId = m ? decodeURIComponent(m[1]) : "";
    return { status: 200, json: { runs: runsByLocalId[localId] || [], limit: 100 } };
  };
  return b;
}

const H_JOB = {
  id: "hermes-default:5ec8", backendId: "hermes", name: "早报", agentId: "hermes-default",
  lastRunAt: T0 + 50000, lastStatus: "error", lastError: "boom",
};

async function testHermesRunsRealRowsSecondsAndMerge() {
  // 真实 runs 行 = sessions 行：started_at 秒、无 status/output
  const rows = [
    { id: "cron_5ec8_1783900850", started_at: 1783900850, ended_at: 1783900860, preview: "sent" },
    { id: "cron_5ec8_1783900810", started_at: 1783900810, ended_at: null, preview: "hi" },
  ];
  const b = mkHermes({ jobs: [H_JOB], runsByLocalId: { "5ec8": rows } });
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(r.runs.length, 2);
  assert.ok(b.calls[0].url.includes("/api/cron/jobs/5ec8/runs"), `localId 去前缀: ${b.calls[0].url}`);
  assert.ok(b.calls[0].url.includes("limit=100"));
  assert.equal(b.calls[0].token, "tok1", "用对应 dashboard 的 token");
  const [newest, older] = r.runs;
  assert.equal(newest.startedAt, 1783900850000, "秒 → 毫秒");
  assert.equal(newest.finishedAt, 1783900860000);
  assert.equal(newest.status, "error", "最新一条合并 job.lastStatus（防止比 synthesized 行退化）");
  assert.equal(newest.error, "boom");
  assert.equal(older.status, undefined, "历史行无状态 → 中性");
  assert.equal(newest.jobId, "hermes-default:5ec8", "对外仍是统一 id");
  assert.equal(newest.jobName, "早报");
  assert.ok(!newest.synthesized);
  assert.ok(!r.latestOnly);
}

async function testHermesDashboardUsesFinalAssistantAsSummaryAndCachesIt() {
  const sessionId = "cron_5ec8_success";
  const prompt = "[IMPORTANT: You are running as a scheduled cron job. DELIVER...]";
  const final = `# 今日摘要\n\n${"真实产出".repeat(500)}`;
  const job = { ...H_JOB, lastStatus: "ok", lastError: undefined };
  const b = mkHermes({
    jobs: [job],
    runsByLocalId: { "5ec8": [
      { id: sessionId, started_at: 1783900850, ended_at: 1783900860, preview: prompt },
    ] },
    messagesBySessionId: { [sessionId]: [
      { role: "user", content: prompt },
      { role: "assistant", content: "中间进度" },
      { role: "assistant", content: final },
    ] },
  });

  const first = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(first.runs[0].summary, final.slice(0, 2000), "Dashboard 摘要取最后一条 assistant 并按统一上限裁剪");
  assert.ok(!first.runs[0].summary.includes("[IMPORTANT:"), "调度输入不得作为产出摘要");

  const second = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(second.runs[0].summary, final.slice(0, 2000));
  const messageCalls = b.calls.filter((c) => c.url.includes(`/api/sessions/${sessionId}/messages`));
  assert.equal(messageCalls.length, 1, "已完成 run 的摘要跨 Dashboard 刷新复用缓存");
  assert.ok(messageCalls[0].url.includes("profile=default"), "messages 请求带 run 属主 profile");
}

async function testHermesDashboardNeverFallsBackToPromptPreview() {
  const prompt = "[IMPORTANT: You are running as a scheduled cron job. DELIVER...]";
  const failed = mkHermes({
    jobs: [H_JOB],
    runsByLocalId: { "5ec8": [
      { id: "cron_5ec8_failed", started_at: 1783900850, ended_at: 1783900860, preview: prompt },
    ] },
    messagesBySessionId: { cron_5ec8_failed: [{ role: "assistant", content: "未完成的中间文本" }] },
  });
  const failedResult = await failed.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(failedResult.runs[0].summary, undefined, "失败 run 不展示中间文本或输入 preview");
  assert.equal(failedResult.runs[0].error, "boom", "失败行保留真实错误供活动流显示");
  assert.equal(failed.calls.filter((c) => c.url.includes("/messages")).length, 0, "已知失败 run 不请求转录");

  const successJob = { ...H_JOB, lastStatus: "ok", lastError: undefined };
  const unavailable = mkHermes({
    jobs: [successJob],
    runsByLocalId: { "5ec8": [
      { id: "cron_5ec8_missing", started_at: 1783900850, ended_at: 1783900860, preview: prompt },
    ] },
  });
  const unavailableResult = await unavailable.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(unavailableResult.runs[0].summary, undefined, "转录不可用时留空，不回退输入 preview");
}

async function testHermesDashboardCapsSummaryFanoutAtFirstHundred() {
  const jobs = [
    { ...H_JOB, id: "hermes-default:a", name: "A", lastRunAt: undefined, lastStatus: undefined, lastError: undefined },
    { ...H_JOB, id: "hermes-default:b", name: "B", lastRunAt: undefined, lastStatus: undefined, lastError: undefined },
  ];
  const rows = (prefix, offset) => Array.from({ length: 80 }, (_, index) => ({
    id: `${prefix}-${index}`,
    started_at: T0 / 1000 + offset + index,
    ended_at: T0 / 1000 + offset + index + 1,
    preview: "[IMPORTANT: scheduled input]",
  }));
  const b = mkHermes({
    jobs,
    runsByLocalId: { a: rows("a", 100), b: rows("b", 1000) },
  });
  let summaryRows = null;
  b._fillCronRunSummaries = async (runs) => { summaryRows = runs; };
  const result = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(result.runs.length, 160, "全量 runs 仍保留");
  assert.equal(summaryRows.length, 100, "仅最近 100 条补转录摘要");
  assert.ok(result.runs.every((run) => run.summary === undefined), "未补摘要的行也不得泄漏 prompt preview");
}

async function testHermes404FallsBackSynthesizedLatestOnly() {
  const b = mkHermes({ jobs: [H_JOB], status: 404 });
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(r.latestOnly, true, "旧版 404 → latest-only");
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].synthesized, true);
  assert.equal(r.runs[0].startedAt, T0 + 50000);
  assert.equal(r.runs[0].status, "error");
}

async function testHermesFullPageMarksTruncated() {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `cron_5ec8_${i}`, started_at: 1783900800 + i, ended_at: null, preview: "",
  }));
  const b = mkHermes({ jobs: [H_JOB], runsByLocalId: { "5ec8": rows } });
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(r.truncated, true, "整页 100 条且最旧仍在今天 → truncated");
}

async function testHermesFiltersYesterdayRows() {
  const rows = [
    { id: "a", started_at: 1783900805, ended_at: null },
    { id: "b", started_at: 1783900800 - 60, ended_at: null }, // 昨天
  ];
  const jobWithoutLastRun = { ...H_JOB, lastRunAt: undefined, lastStatus: undefined, lastError: undefined };
  const b = mkHermes({ jobs: [jobWithoutLastRun], runsByLocalId: { "5ec8": rows } });
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.equal(r.runs.length, 1);
  assert.ok(!r.truncated, "被 sinceMs 过滤掉 ≠ 截断");
}

async function testHermesUnknownProfileSkipped() {
  const orphan = { ...H_JOB, id: "hermes-ghost:x", agentId: "hermes-ghost" };
  const b = mkHermes({ jobs: [orphan] });
  const r = await b.getRecentCronRuns({ sinceMs: T0, limit: 5000 });
  assert.deepEqual(r.runs, [], "找不到 dashboard 的 job 静默跳过");
}

// ---------- E. Hermes kanban WS 短连 drain（事件回放只有 WebSocket） ----------

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const pathMod = require("node:path");
const { WebSocketServer } = require("ws");
const { BackendRegistry } = require("../app/core/backend-registry");
const { createDashboardJournal } = require("../app/core/dashboard-journal");

function tmpJournalFile() {
  return pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "shoggoth-dbu-")), "journal.json");
}

const SEC = (ms) => Math.floor(ms / 1000);
// 真实 task_events 行：{id,task_id,run_id,kind,payload,created_at(秒)}
const K_ROWS = [
  { id: 1, task_id: "t1", run_id: null, kind: "created", created_at: SEC(T0) - 3600 }, // 昨天
  { id: 2, task_id: "t1", run_id: null, kind: "claimed", created_at: SEC(T0) + 2 },
  { id: 3, task_id: "t1", run_id: null, kind: "done", created_at: SEC(T0) + 3 },
];
const K_BOARD = { columns: [{ id: "todo", tasks: [{ id: "t1", title: "写周报" }] }], latest_event_id: 3 };

async function withKanbanWs(onConn, fn) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/api/plugins/kanban/events" });
  const state = { connections: 0, port: 0 };
  wss.on("connection", (ws, req) => { state.connections++; onConn(ws, req); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port;
  try {
    return await fn(state);
  } finally {
    try { wss.close(); } catch { /* closing */ }
    try { server.close(); } catch { /* closing */ }
  }
}

function mkHermesKanban({ port, journal, board = K_BOARD, boardStatus = 200 }) {
  const b = new HermesBackend({});
  b.dashboards = new Map([["default", { baseUrl: `http://127.0.0.1:${port}`, token: "tok", port }]]);
  b.profileById = new Map([["hermes-default", "default"]]);
  if (journal) b.attachDashboardJournal(journal);
  b._kanbanDrainDeadlineMs = 400;
  b._httpGetJson = async (url) => {
    if (url.includes("/api/plugins/kanban/board")) return { status: boardStatus, json: board };
    return { status: 500, json: null };
  };
  return b;
}

async function testHermesKanbanColdDrainAndSkipWhenCaughtUp() {
  await withKanbanWs((ws, req) => {
    const u = new URL(req.url, "http://x");
    assert.equal(u.searchParams.get("token"), "tok", "WS 带 token 参数");
    const since = Number(u.searchParams.get("since") || "0");
    ws.send(JSON.stringify({ events: K_ROWS.filter((r) => r.id > since), cursor: 3 }));
  }, async (srv) => {
    const journal = createDashboardJournal(tmpJournalFile());
    const b = mkHermesKanban({ port: srv.port, journal });
    const r = await b.getRecentKanbanActivities({ sinceMs: T0 });
    assert.equal(r.supported, true);
    const actions = r.items.map((x) => x.kanban.action).sort();
    assert.deepEqual(actions, ["completed", "started"], "昨天的行被当天过滤 + 真实词表映射");
    assert.equal(r.items[0].title, "写周报", "标题从 /board 快照补齐");
    assert.equal(journal.getKanbanCursor("hermes:default"), 3, "cursor 持久化");
    assert.ok(!r.truncated);
    const r2 = await b.getRecentKanbanActivities({ sinceMs: T0 });
    assert.equal(srv.connections, 1, "cursor 已追平 latest → 不再连 WS");
    assert.equal(r2.items.length, 2, "留存事件仍完整");
  });
}

async function testHermesKanbanSurvivesRestart() {
  await withKanbanWs((ws, req) => {
    const since = Number(new URL(req.url, "http://x").searchParams.get("since") || "0");
    ws.send(JSON.stringify({ events: K_ROWS.filter((r) => r.id > since), cursor: 3 }));
  }, async (srv) => {
    const file = tmpJournalFile();
    const b1 = mkHermesKanban({ port: srv.port, journal: createDashboardJournal(file) });
    await b1.getRecentKanbanActivities({ sinceMs: T0 });
    assert.equal(srv.connections, 1);
    const b2 = mkHermesKanban({ port: srv.port, journal: createDashboardJournal(file) });
    const r = await b2.getRecentKanbanActivities({ sinceMs: T0 });
    assert.equal(srv.connections, 1, "重启后 cursor=latest → 无需回放");
    assert.equal(r.items.length, 2, "当天事件从 journal 恢复");
  });
}

async function testHermesKanbanPluginDisabled() {
  const b = mkHermesKanban({ port: 1, journal: null, boardStatus: 404 });
  const r = await b.getRecentKanbanActivities({ sinceMs: T0 });
  assert.equal(r.supported, false);
  assert.equal(r.reason, "unsupported", "kanban 插件可禁用 → unsupported");
}

async function testHermesKanbanDrainDeadlineTruncates() {
  await withKanbanWs((ws) => {
    ws.send(JSON.stringify({ events: [K_ROWS[1]], cursor: 2 })); // 停在 2 < latest 3，然后沉默
  }, async (srv) => {
    const journal = createDashboardJournal(tmpJournalFile());
    const b = mkHermesKanban({ port: srv.port, journal });
    const r = await b.getRecentKanbanActivities({ sinceMs: T0 });
    assert.equal(r.truncated, true, "deadline 未追平 → truncated（不吊死 45s 轮询）");
    assert.equal(r.items.length, 1, "已收部分照常返回");
    assert.equal(journal.getKanbanCursor("hermes:default"), 2, "部分 cursor 也持久化");
  });
}

// ---------- F. Hermes 健康目标 + registry 采样 ----------

async function testHermesHealthTargets() {
  const b = new HermesBackend({});
  b._getDashboardStatusRows = async () => [
    { profile: "bull", connected: false },
    { profile: "default", connected: true },
  ];
  const t = await b.getHealthTargets();
  const byId = Object.fromEntries(t.map((x) => [x.targetId, x.state]));
  assert.equal(byId["hermes"], "connected", "整体=任一 profile 连通");
  assert.equal(byId["hermes:default"], "connected");
  assert.equal(byId["hermes:bull"], "disconnected");
  assert.ok(t.every((x) => x.backendId === "hermes"));
  b._startingAt = Date.now();
  const st = await b.getHealthTargets();
  assert.ok(st.every((x) => x.state === "unknown"), "启动窗（R130）不产出确定态");
}

async function testRegistrySamplerFailSoft() {
  class Down extends AgentBackend {
    get id() { return "down"; }
    async getStatus() { return { id: "down", name: "d", connected: false, info: { error: "unreachable" } }; }
  }
  class Boom extends AgentBackend {
    get id() { return "boom"; }
    async getHealthTargets() { throw new Error("boom"); }
  }
  const registry = new BackendRegistry();
  registry.register(new Down());
  registry.register(new Boom());
  const journal = createDashboardJournal(tmpJournalFile());
  registry.attachDashboardJournal(journal);
  assert.equal(registry.backends.get("down")._dashboardJournal, journal, "journal 下发到后端");
  await registry.sampleDashboardHealthOnce();
  await registry.sampleDashboardHealthOnce();
  const ev = journal.getHealthEvents();
  assert.equal(ev.length, 1, "断连记录一条；抛错后端不拖垮（铁律 4）");
  assert.equal(ev[0].targetId, "down");
  assert.equal(ev[0].backendId, "down");
}

// ---------- G. 当天文件：sinceMs 过滤 + Hermes 扫描 + 预览重验证 ----------

function mkArtifactFixture() {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "shoggoth-art-"));
  const midnight = new Date().setHours(0, 0, 0, 0);
  return { dir, midnight, yesterday: new Date(midnight - 3600_000), today: new Date(midnight + 3600_000) };
}

function writeFileAt(p, mtime) {
  fs.mkdirSync(pathMod.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x", "utf8");
  fs.utimesSync(p, mtime, mtime);
}

async function testOcArtifactsSinceMsFilter() {
  const { dir, midnight, yesterday, today } = mkArtifactFixture();
  writeFileAt(pathMod.join(dir, "workspace", "today.png"), today);
  writeFileAt(pathMod.join(dir, "workspace", "old.md"), yesterday);
  const prev = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = dir;
  try {
    const b = new OpenClawBackend({});
    b._configSnapshot = async () => { throw new Error("offline"); }; // 只用固定根，避免连真网关
    const r = await b.getRecentArtifacts({ limit: 20, sinceMs: midnight });
    assert.equal(r.supported, true);
    assert.deepEqual(r.items.map((x) => x.name), ["today.png"], "mtime < 本地零点的文件被过滤");
    const all = await b.getRecentArtifacts({ limit: 20, sinceMs: 0 });
    assert.equal(all.items.length, 2, "sinceMs=0 仍取全部（smoke 离线确定性）");
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = prev;
  }
}

async function testOcPreviewValidation() {
  const { dir, today } = mkArtifactFixture();
  writeFileAt(pathMod.join(dir, "workspace", "pic.png"), today);
  writeFileAt(pathMod.join(dir, "workspace", "note.md"), today);
  const outside = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "shoggoth-out-")), "evil.png");
  writeFileAt(outside, today);
  fs.symlinkSync(outside, pathMod.join(dir, "workspace", "link.png"));
  const prev = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = dir;
  try {
    const b = new OpenClawBackend({});
    b._configSnapshot = async () => { throw new Error("offline"); };
    const okRes = await b.resolveArtifactPreview(pathMod.join(dir, "workspace", "pic.png"));
    assert.ok(okRes && okRes.absPath.endsWith("pic.png"), "根内图片 → absPath");
    assert.equal(await b.resolveArtifactPreview(outside), null, "根外路径拒绝");
    assert.equal(await b.resolveArtifactPreview(pathMod.join(dir, "workspace", "note.md")), null, "非图片拒绝");
    assert.equal(await b.resolveArtifactPreview(pathMod.join(dir, "workspace", "link.png")), null, "symlink 逃逸拒绝");
    assert.equal(await b.resolveArtifactPreview(""), null);
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = prev;
  }
}

function mkHermesArtifacts(dir, { mode = "local" } = {}) {
  const b = new HermesBackend({ getConfig: () => ({ hermesMode: mode, hermesRemotes: [] }) });
  b.dashboards = new Map([["default", { baseUrl: "http://127.0.0.1:1", token: "t" }], ["bull", { baseUrl: "http://127.0.0.1:2", token: "t" }]]);
  b.profileById = new Map([["hermes-default", "default"], ["hermes-bull", "bull"]]);
  b.getCronJobs = async () => [];
  b._httpGetJson = async () => ({ status: 404, json: null }); // kanban 缺席 → 忽略
  return b;
}

async function testHermesArtifactsScan() {
  const { dir, midnight, yesterday, today } = mkArtifactFixture();
  writeFileAt(pathMod.join(dir, "output", "报告.png"), today);
  writeFileAt(pathMod.join(dir, "cron", "output", "daily.md"), today);
  writeFileAt(pathMod.join(dir, "images", "old.png"), yesterday);
  writeFileAt(pathMod.join(dir, "profiles", "bull", "cache", "images", "chart.jpg"), today);
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  try {
    const b = mkHermesArtifacts(dir);
    const r = await b.getRecentArtifacts({ limit: 20, sinceMs: midnight });
    assert.equal(r.supported, true);
    const names = r.items.map((x) => x.name).sort();
    assert.deepEqual(names, ["chart.jpg", "daily.md", "报告.png"], `今日文件（含命名 profile），got ${names}`);
    const bullItem = r.items.find((x) => x.name === "chart.jpg");
    assert.equal(bullItem.agentId, "hermes-bull", "命名 profile 归因到对应 agent");
    // 远程模式 → reason:"remote"
    const remote = mkHermesArtifacts(dir, { mode: "remote" });
    const rr = await remote.getRecentArtifacts({ limit: 20, sinceMs: midnight });
    assert.equal(rr.supported, false);
    assert.equal(rr.reason, "remote");
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev;
  }
}

async function testHermesPreviewValidation() {
  const { dir, today } = mkArtifactFixture();
  writeFileAt(pathMod.join(dir, "output", "pic.png"), today);
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  try {
    const b = mkHermesArtifacts(dir);
    const okRes = await b.resolveArtifactPreview(pathMod.join(dir, "output", "pic.png"));
    assert.ok(okRes && okRes.absPath.endsWith("pic.png"));
    assert.equal(await b.resolveArtifactPreview("/etc/hosts"), null, "根外拒绝");
    assert.equal(await b.resolveArtifactPreview(pathMod.join(dir, "output", "nope.png")), null, "不存在拒绝");
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev;
  }
}

// ---------- runner ----------

const tests = [
  testContractDefaults, testDefaultHealthTargetsFromStatus,
  testOcPagesUntilMidnightBoundary, testOcLimitTruncates, testOcStopsWhenNoMore,
  testOcRpcFailureIsFailSoft, testOcKanbanActivities, testOcKanbanUnavailableOnRpcFailure,
  testHermesRunsRealRowsSecondsAndMerge, testHermes404FallsBackSynthesizedLatestOnly,
  testHermesDashboardUsesFinalAssistantAsSummaryAndCachesIt,
  testHermesDashboardNeverFallsBackToPromptPreview,
  testHermesDashboardCapsSummaryFanoutAtFirstHundred,
  testHermesFullPageMarksTruncated, testHermesFiltersYesterdayRows, testHermesUnknownProfileSkipped,
  testHermesKanbanColdDrainAndSkipWhenCaughtUp, testHermesKanbanSurvivesRestart,
  testHermesKanbanPluginDisabled, testHermesKanbanDrainDeadlineTruncates,
  testHermesHealthTargets, testRegistrySamplerFailSoft,
  testOcArtifactsSinceMsFilter, testOcPreviewValidation,
  testHermesArtifactsScan, testHermesPreviewValidation,
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
