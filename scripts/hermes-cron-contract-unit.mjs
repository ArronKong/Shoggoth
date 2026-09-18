#!/usr/bin/env node
// Contract unit: HermesBackend cron 调用 vs 官方 web_server.py（2026-07-12 核实）：
//   GET  /api/cron/jobs         默认 ?profile=all = 全机聚合 → 必须按 ?profile=<own>
//                               查询，否则每个 dashboard 返回同一份全局列表（CRON-001 1→N 幽灵）。
//   POST /api/cron/jobs         CronJobCreate 一次性接受 script/no_agent/skills/…（CRON-004）；
//                               ?profile= 决定归属 home（不传恒落 default）。
//   PUT/POST/DELETE …/{id}      ?profile= 置顶属主，避免服务端全机扫描。
//   GET  …/{id}/runs            真实 per-run 历史（行=会话，无 per-run status，CRON-002）。
// 运行：node scripts/hermes-cron-contract-unit.mjs

import { createServer } from "node:http";
import { HermesBackend } from "../app/core/hermes-backend.js";

// 假 Hermes dashboard：记录每个请求；routes 按 "<METHOD> <pathname>" 覆盖响应，
// routes.default 兜底，最终兜底 200 {}。
function fakeDash(routes = {}) {
  const captured = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const rec = {
        method: req.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : null,
      };
      captured.push(rec);
      const handler = routes[`${req.method} ${url.pathname}`] || routes.default;
      const out = handler ? handler(rec) : { code: 200, json: {} };
      res.writeHead(out.code, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    captured,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

function makeBackend(dashes) {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  for (const [profile, d] of Object.entries(dashes)) {
    be.dashboards.set(profile, { profile, baseUrl: d.baseUrl, token: "tok" });
    be.profileById.set(`hermes-${profile}`, profile);
  }
  return be;
}

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };
const J = (id, name = id) => ({ id, name, schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true });

// ---- CRON-001a: 每个 dashboard 只查自己的 ?profile=<name> ----
{
  const dDefault = await fakeDash({
    "GET /api/cron/jobs": ({ query }) => ({
      code: 200,
      json: query.profile === "default" ? [J("aaa", "job-a")] : [J("aaa", "job-a"), J("bbb", "job-b")],
    }),
  });
  const dBull = await fakeDash({
    "GET /api/cron/jobs": ({ query }) => ({
      code: 200,
      json: query.profile === "bull" ? [J("bbb", "job-b")] : [J("aaa", "job-a"), J("bbb", "job-b")],
    }),
  });
  const be = makeBackend({ default: dDefault, bull: dBull });
  const jobs = await be.getCronJobs();
  check("list 向 default 查 profile=default", dDefault.captured.some((c) => c.query.profile === "default"));
  check("list 向 bull 查 profile=bull", dBull.captured.some((c) => c.query.profile === "bull"));
  check("无幽灵：共 2 条", jobs.length === 2);
  check("owner 前缀正确", jobs.some((j) => j.id === "hermes-default:aaa") && jobs.some((j) => j.id === "hermes-bull:bbb"));
  await dDefault.close(); await dBull.close();
}

// ---- CRON-001b: 旧版 dashboard 忽略 ?profile=（都回全机聚合）→ 去重兜底 ----
{
  const globalList = [J("aaa"), J("bbb")];
  const mk = () => fakeDash({ "GET /api/cron/jobs": () => ({ code: 200, json: globalList }) });
  const d1 = await mk(); const d2 = await mk(); const d3 = await mk();
  const be = makeBackend({ default: d1, bull: d2, horse: d3 });
  const jobs = await be.getCronJobs();
  check("旧版兜底：去重到 2 条（不再 1→3）", jobs.length === 2);
  const raws = new Set(jobs.map((j) => j.id.slice(j.id.indexOf(":") + 1)));
  check("旧版兜底：两个 raw id 都在", raws.has("aaa") && raws.has("bbb"));
  await d1.close(); await d2.close(); await d3.close();
}

// ---- CRON-001c: 变更操作把 ?profile= 置顶到属主（避免全机扫描/误判） ----
{
  const dash = await fakeDash({ default: () => ({ code: 200, json: J("ccc") }) });
  const be = makeBackend({ bull: dash });
  await be.updateCronJob("hermes-bull:ccc", { name: "c2" });
  await be.updateCronJob("hermes-bull:ccc", { enabled: false });
  await be.runCronJob("hermes-bull:ccc");
  await be.deleteCronJob("hermes-bull:ccc");
  const ops = dash.captured.filter((c) => c.path.startsWith("/api/cron/jobs/ccc"));
  check("job 操作至少 5 个请求（PUT/GET 回读/pause/trigger/DELETE）", ops.length >= 5);
  check("每个 job 操作都带 profile=bull", ops.length > 0 && ops.every((c) => c.query.profile === "bull"));
  await dash.close();
}

// ---- CRON-004: 纯脚本(no_agent)任务一次 POST 创建成功，script 必须在首次请求里 ----
{
  const jobJson = { ...J("sss", "script-job"), script: "/tmp/x.sh", no_agent: true };
  const dash = await fakeDash({
    // 模拟官方校验：首次 POST 里 prompt/skills/script 至少一个，否则 400。
    "POST /api/cron/jobs": ({ body }) =>
      body.script || body.prompt || (Array.isArray(body.skills) && body.skills.length)
        ? { code: 200, json: jobJson }
        : { code: 400, json: { detail: "agent cron jobs require a prompt, skill, or script" } },
    default: () => ({ code: 200, json: jobJson }),
  });
  const be = makeBackend({ default: dash });
  const job = await be.createCronJob({
    agentId: "hermes-default", name: "script-job",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    prompt: "", script: "/tmp/x.sh", noAgent: true, deliver: "local",
    skills: [], contextFrom: [], enabledToolsets: [],
  });
  check("纯脚本创建成功", !!job && job.id === "hermes-default:sss");
  const post = dash.captured.find((c) => c.method === "POST" && c.path === "/api/cron/jobs");
  check("首次 POST 带 script/no_agent", !!post && post.body.script === "/tmp/x.sh" && post.body.no_agent === true);
  check("首次 POST 带 ?profile= 归属", !!post && post.query.profile === "default");
  check("create 支持的字段不再二阶段 PUT", !dash.captured.some((c) => c.method === "PUT"));
  await dash.close();
}

// ---- CRON-004b: repeat 官方 create 不收 → 仍走创建后 PUT ----
{
  const dash = await fakeDash({ default: () => ({ code: 200, json: J("rrr") }) });
  const be = makeBackend({ default: dash });
  await be.createCronJob({
    agentId: "hermes-default", name: "r",
    schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "p", repeat: 3,
  });
  const put = dash.captured.find((c) => c.method === "PUT" && c.path === "/api/cron/jobs/rrr");
  check("repeat 走创建后 PUT", !!put && put.body?.updates?.repeat?.times === 3);
  check("repeat PUT 也带 profile", !!put && put.query.profile === "default");
  await dash.close();
}

// ---- CRON-002: 详情历史 = /runs 真实多条；job last_* 只叠加到最新一条 ----
{
  const T = 1783900800000;
  const sec = (ms) => Math.floor(ms / 1000);
  const job = { ...J("hhh"), last_run_at: new Date(T + 7200e3).toISOString(), last_status: "error", last_error: "boom" };
  const runRows = { runs: [
    { id: "cron_hhh_1", started_at: sec(T), ended_at: sec(T + 60e3), preview: "第一次" },
    { id: "cron_hhh_2", started_at: sec(T + 3600e3), ended_at: sec(T + 3660e3), preview: "第二次" },
    { id: "cron_hhh_3", started_at: sec(T + 7200e3), ended_at: sec(T + 7260e3), preview: "第三次" },
  ] };
  const dash = await fakeDash({
    "GET /api/cron/jobs/hhh": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/hhh/runs": () => ({ code: 200, json: runRows }),
  });
  const be = makeBackend({ default: dash });
  const r = await be.getCronRuns("hermes-default:hhh");
  check("真实 runs 全量返回（不再合成 1 条）", r.runs.length === 3);
  check("按开始时间倒序", r.runs.length === 3 && r.runs[0].summary === "第三次" && r.runs[2].summary === "第一次");
  check("run id 保留为 sessionKey", r.runs.length === 3 && r.runs[0].sessionKey === "cron_hhh_3");
  check("job last_* 叠加到最新一条", r.runs.length === 3 && r.runs[0].status === "error" && r.runs[0].error === "boom");
  check("旧行不发明 status", r.runs.length === 3 && r.runs[1].status === undefined && r.runs[2].status === undefined);
  check("runs 请求带 profile", dash.captured.some((c) => c.path === "/api/cron/jobs/hhh/runs" && c.query.profile === "default"));
  const filtered = await be.getCronRuns("hermes-default:hhh", { status: "error" });
  check("status 过滤生效", filtered.runs.length === 1 && filtered.runs[0].summary === "第三次");
  const limited = await be.getCronRuns("hermes-default:hhh", { limit: 2 });
  check("limit 生效", limited.runs.length === 2);
  await dash.close();
}

// ---- CRON-002c: 成功运行通过 session messages 恢复完整最终产出 ----
{
  const T = 1783900800000;
  const job = { ...J("delivery"), last_run_at: new Date(T + 60e3).toISOString(), last_status: "ok" };
  const dash = await fakeDash({
    "GET /api/cron/jobs/delivery": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/delivery/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_delivery_1", started_at: T / 1000, ended_at: (T + 60e3) / 1000, preview: "定时任务提示词" },
    ] } }),
    "GET /api/sessions/cron_delivery_1/messages": () => ({ code: 200, json: { messages: [
      { role: "user", content: "请生成日报" },
      { role: "assistant", content: "正在收集资料" },
      { role: "tool", content: "搜索结果", tool_name: "web_search" },
      { role: "assistant", content: "# 完整日报\n\n这是最终产出。" },
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const delivery = await be.getCronLatestDelivery("hermes-default:delivery", T);
  check("成功运行返回 transcript 来源", delivery.source === "transcript");
  check("成功运行返回最后一条 assistant 文本", delivery.fullText === "# 完整日报\n\n这是最终产出。");
  check("delivery 透出 sessionKey", delivery.sessionKey === "cron_delivery_1");
  check("delivery 保留运行元数据", delivery.status === "ok" && delivery.durationMs === 60e3);
  check("messages 请求命中对应 session", dash.captured.some((c) => c.path === "/api/sessions/cron_delivery_1/messages"));
  await dash.close();
}

// ---- CRON-002d: transcript 不可用时保留运行状态并安全降级 ----
{
  const T = 1783900800000;
  const job = { ...J("missing-output"), last_run_at: new Date(T).toISOString(), last_status: "ok" };
  const dash = await fakeDash({
    "GET /api/cron/jobs/missing-output": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/missing-output/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_missing_output_1", started_at: T / 1000, ended_at: (T + 10e3) / 1000 },
    ] } }),
    "GET /api/sessions/cron_missing_output_1/messages": () => ({ code: 404, json: { detail: "not found" } }),
  });
  const be = makeBackend({ default: dash });
  const delivery = await be.getCronLatestDelivery("hermes-default:missing-output", T);
  check("transcript 404 安全降级", delivery.source === "none" && delivery.fullText === null);
  check("transcript 404 仍保留运行状态", delivery.status === "ok" && delivery.sessionKey === "cron_missing_output_1");
  await dash.close();
}

// ---- CRON-002e: 失败运行不把中间 assistant 文本误报为最终产出 ----
{
  const T = 1783900800000;
  const job = { ...J("failed-output"), last_run_at: new Date(T).toISOString(), last_status: "error", last_error: "model failed" };
  const dash = await fakeDash({
    "GET /api/cron/jobs/failed-output": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/failed-output/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_failed_output_1", started_at: T / 1000, ended_at: (T + 10e3) / 1000 },
    ] } }),
    "GET /api/sessions/cron_failed_output_1/messages": () => ({ code: 200, json: { messages: [
      { role: "assistant", content: "仍在处理中" },
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const delivery = await be.getCronLatestDelivery("hermes-default:failed-output", T);
  check("失败运行不展示中间文本", delivery.source === "none" && delivery.fullText === null && delivery.error === "model failed");
  check("失败运行不请求 transcript", !dash.captured.some((c) => c.path === "/api/sessions/cron_failed_output_1/messages"));
  await dash.close();
}

// ---- CRON-002f: Hermes session messages → Agent Trajectory ----
{
  const T = 1783900800000;
  const longOutput = "x".repeat(4100);
  const dash = await fakeDash({
    "GET /api/sessions/cron_trajectory_1/messages": () => ({ code: 200, json: { messages: [
      { role: "assistant", display_kind: "hidden", timestamp: T / 1000, reasoning_content: "不能显示" },
      {
        role: "assistant",
        timestamp: T / 1000,
        reasoning_content: "先分析任务",
        reasoning: "重复思考不应出现",
        content: "准备调用工具",
        tool_calls: [
          { id: "call-1", function: { name: "web_search", arguments: "{\"query\":\"AI\"}" } },
          { id: "call-2", function: { name: "web_extract", arguments: "not-json" } },
        ],
      },
      {
        role: "tool",
        timestamp: T / 1000 + 2.5,
        tool_call_id: "call-1",
        tool_name: "web_search",
        content: longOutput,
      },
      {
        role: "tool",
        timestamp: T + 4000,
        tool_call_id: "call-2",
        tool_name: "web_extract",
        content: "{\"status\":\"error\"}",
        is_error: true,
      },
      { role: "assistant", timestamp: T / 1000 + 5, content: "最终回复" },
      null,
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const trajectory = await be.getCronRunTrajectory("hermes-default:trajectory", { sessionKey: "cron_trajectory_1" });
  check("Hermes trajectory 标记 supported", trajectory.supported === true);
  check("trajectory 保持消息与分段顺序", trajectory.parts.map((p) => p.type).join(",") === "thinking,toolCall,toolCall,text,toolResult,toolResult,text");
  check("thinking 优先 reasoning_content 且不重复", trajectory.parts[0]?.text === "先分析任务" && !trajectory.parts.some((p) => p.text === "重复思考不应出现"));
  check("tool call 参数 JSON 解析", trajectory.parts[1]?.toolCallId === "call-1" && trajectory.parts[1]?.toolName === "web_search" && trajectory.parts[1]?.toolArgs?.query === "AI");
  check("坏 tool args 安全省略", trajectory.parts[2]?.toolCallId === "call-2" && trajectory.parts[2]?.toolArgs === undefined);
  check("tool result 精确保留配对 id", trajectory.parts[4]?.toolCallId === "call-1" && trajectory.parts[5]?.toolCallId === "call-2");
  check("秒级时间戳统一转毫秒", trajectory.parts[0]?.ts === T && trajectory.parts[4]?.ts === T + 2500 && trajectory.parts[5]?.ts === T + 4000);
  check("长工具结果按 OpenClaw 上限截断", trajectory.parts[4]?.text?.length === 4000);
  check("工具错误标记保留", trajectory.parts[5]?.isError === true);
  check("hidden 与坏消息跳过", trajectory.parts.every((p) => p.text !== "不能显示"));
  check("trajectory 请求带属主 profile", dash.captured.some((c) => c.path === "/api/sessions/cron_trajectory_1/messages" && c.query.profile === "default"));
  await dash.close();
}

// ---- CRON-002g: trajectory 无 session / 旧版 404 / 空消息安全降级 ----
{
  const dash = await fakeDash({
    "GET /api/sessions/missing/messages": () => ({ code: 404, json: { detail: "not found" } }),
    "GET /api/sessions/empty/messages": () => ({ code: 200, json: { messages: [] } }),
  });
  const be = makeBackend({ default: dash });
  const noSession = await be.getCronRunTrajectory("hermes-default:trajectory", {});
  const missing = await be.getCronRunTrajectory("hermes-default:trajectory", { sessionKey: "missing" });
  const empty = await be.getCronRunTrajectory("hermes-default:trajectory", { sessionKey: "empty" });
  check("trajectory 缺 sessionKey 静默降级", noSession.supported === false && noSession.reason === "no-session" && noSession.parts.length === 0);
  check("trajectory 404 静默降级", missing.supported === false && missing.reason === "no-transcript" && missing.parts.length === 0);
  check("trajectory 空消息静默降级", empty.supported === false && empty.reason === "empty" && empty.parts.length === 0);
  check("缺 sessionKey 不发 HTTP", !dash.captured.some((c) => c.path.includes("undefined")));
  await dash.close();
}

// ---- CRON-002b: 旧版 dashboard 无 /runs（404）→ 退回 last_* 合成单条 ----
{
  const T = 1783900800000;
  const job = { ...J("old1"), last_run_at: new Date(T).toISOString(), last_status: "ok" };
  const dash = await fakeDash({
    "GET /api/cron/jobs/old1": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/old1/runs": () => ({ code: 404, json: { detail: "not found" } }),
  });
  const be = makeBackend({ default: dash });
  const r = await be.getCronRuns("hermes-default:old1");
  check("旧版 404 → 合成单条", r.runs.length === 1 && r.runs[0].status === "ok");
  await dash.close();
}

// ---- CRON-002h: /runs 200 空行也要暴露 execution-backed last_* ----
// 模型预检/no-agent 脚本可在 SessionDB 行创建前失败：Hermes execution ledger
// 有失败、job.last_* 已更新，但 dashboard 的 session-backed /runs 合法返回 []。
{
  const T = 1783900800000;
  const job = {
    ...J("empty-failed"),
    last_run_at: new Date(T).toISOString(),
    last_status: "error",
    last_error: "model preflight failed",
    last_delivery_error: "delivery unavailable",
  };
  const dash = await fakeDash({
    "GET /api/cron/jobs/empty-failed": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/empty-failed/runs": () => ({ code: 200, json: { runs: [] } }),
  });
  const be = makeBackend({ default: dash });
  const detail = await be.getCronRuns("hermes-default:empty-failed");
  check(
    "200 空 runs → 合成 last_* 失败记录",
    detail.runs.length === 1 && detail.runs[0].startedAt === T
      && detail.runs[0].status === "error" && detail.runs[0].error === "model preflight failed"
      && detail.runs[0].synthesized === true && detail.runs[0].sessionKey === undefined,
  );
  const filtered = await be.getCronRuns("hermes-default:empty-failed", { status: "error", limit: 1 });
  check("200 空 runs 合成行继续支持过滤/limit", filtered.runs.length === 1);
  const filteredOut = await be.getCronRuns("hermes-default:empty-failed", { status: "ok" });
  check("200 空 runs 合成行 status 过滤可排除", filteredOut.runs.length === 0);
  await dash.close();
}

// ---- CRON-002j: 最新 execution 无 session 时不能把 last_* 贴到旧 run ----
{
  const T = 1783900800000;
  const job = {
    ...J("stale-run"),
    last_run_at: new Date(T + 120e3).toISOString(),
    last_status: "error",
    last_error: "latest failed before session",
  };
  const dash = await fakeDash({
    "GET /api/cron/jobs/stale-run": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/stale-run/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_stale_run_old", started_at: (T - 60e3) / 1000, ended_at: T / 1000, preview: "older run" },
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const detail = await be.getCronRuns("hermes-default:stale-run");
  check(
    "详情最新无 session 失败单独合成且旧 run 不背锅",
    detail.runs.length === 2
      && detail.runs[0].synthesized === true && detail.runs[0].status === "error"
      && detail.runs[0].error === "latest failed before session"
      && detail.runs[1].sessionKey === "cron_stale_run_old" && detail.runs[1].status === undefined,
  );
  await dash.close();
}

// ---- CRON-002k: ended_at=NULL 的残留 session 不能无限吸收未来结果 ----
{
  const T = 1783900800000;
  const job = {
    ...J("open-stale"),
    last_run_at: new Date(T + 120e3).toISOString(),
    last_status: "error",
    last_error: "later preflight failure",
  };
  const dash = await fakeDash({
    "GET /api/cron/jobs/open-stale": () => ({ code: 200, json: job }),
    "GET /api/cron/jobs/open-stale/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_open_stale_old", started_at: (T - 60e3) / 1000, ended_at: null },
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const detail = await be.getCronRuns("hermes-default:open-stale");
  check(
    "NULL-ended 残留行不吸收未来 last_*",
    detail.runs.length === 2
      && detail.runs[0].synthesized === true && detail.runs[0].error === "later preflight failure"
      && detail.runs[1].sessionKey === "cron_open_stale_old" && detail.runs[1].status === undefined,
  );
  await dash.close();
}

// ---- CRON-002l: execution ledger 跨越慢投递，仍能精确归属真实 session ----
{
  const T = 1783900800000;
  const job = {
    ...J("slow-delivery"),
    last_run_at: new Date(T + 600e3).toISOString(),
    last_status: "error",
    last_error: "delivery finished late",
    latest_execution: {
      status: "failed",
      claimed_at: new Date(T).toISOString(),
      started_at: new Date(T + 1000).toISOString(),
      finished_at: new Date(T + 600e3).toISOString(),
    },
  };
  const detailJob = { ...job };
  delete detailJob.latest_execution;
  const runRows = { runs: [
    { id: "cron_slow_delivery_1", started_at: (T + 5000) / 1000, ended_at: (T + 60e3) / 1000 },
  ] };
  const dash = await fakeDash({
    "GET /api/cron/jobs": () => ({ code: 200, json: [job] }),
    // Hermes 0.20.4 的 get_job 不注入 latest_execution；只有 list_jobs 注入。
    "GET /api/cron/jobs/slow-delivery": () => ({ code: 200, json: detailJob }),
    "GET /api/cron/jobs/slow-delivery/runs": () => ({ code: 200, json: runRows }),
  });
  const be = makeBackend({ default: dash });
  const detail = await be.getCronRuns("hermes-default:slow-delivery");
  check(
    "详情用 execution 区间归属慢投递，不重复合成",
    detail.runs.length === 1 && detail.runs[0].sessionKey === "cron_slow_delivery_1" // gitleaks:allow -- synthetic test fixture; not a usable credential
      && detail.runs[0].status === "error" && detail.runs[0].error === "delivery finished late",
  );
  const recent = await be.getRecentCronRuns({ sinceMs: T, limit: 10 });
  check(
    "recent 保留 execution 区间并归属同一 session",
    recent.runs.length === 1 && recent.runs[0].sessionKey === "cron_slow_delivery_1" // gitleaks:allow -- synthetic test fixture; not a usable credential
      && recent.runs[0].status === "error" && recent.runs[0].synthesized !== true,
  );
  await dash.close();
}

// ---- CRON-002m: session 可晚于 execution 很久关闭，身份仍由 started_at 归属 ----
{
  const T = 1783900800000;
  const job = {
    ...J("late-close"),
    last_run_at: new Date(T + 60e3).toISOString(),
    last_status: "ok",
    latest_execution: {
      status: "completed",
      claimed_at: new Date(T).toISOString(),
      started_at: new Date(T + 1000).toISOString(),
      finished_at: new Date(T + 60e3).toISOString(),
    },
  };
  const dash = await fakeDash({
    "GET /api/cron/jobs": () => ({ code: 200, json: [job] }),
    "GET /api/cron/jobs/late-close/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_late_close_1", started_at: (T + 5000) / 1000, ended_at: (T + 12 * 3600e3) / 1000 },
    ] } }),
  });
  const be = makeBackend({ default: dash });
  const recent = await be.getRecentCronRuns({ sinceMs: T, limit: 10 });
  check(
    "execution 区间按 session started_at 归属，晚关闭不重复合成",
    recent.runs.length === 1 && recent.runs[0].sessionKey === "cron_late_close_1"
      && recent.runs[0].status === "ok" && recent.runs[0].synthesized !== true,
  );
  await dash.close();
}

// ---- CRON-002n: 相邻 ledger-only execution 不得继承上一轮 last_* ----
{
  const T = 1783900800000;
  const job = {
    ...J("adjacent-ledger"),
    last_run_at: new Date(T).toISOString(),
    last_status: "ok",
    latest_execution: {
      status: "failed",
      claimed_at: new Date(T + 30e3).toISOString(),
      started_at: new Date(T + 30e3).toISOString(),
      finished_at: new Date(T + 31e3).toISOString(),
    },
  };
  const rows = { runs: [
    { id: "cron_adjacent_previous", started_at: (T - 60e3) / 1000, ended_at: T / 1000 },
  ] };
  const dash = await fakeDash({
    "GET /api/cron/jobs": () => ({ code: 200, json: [job] }),
    "GET /api/cron/jobs/adjacent-ledger/runs": () => ({ code: 200, json: rows }),
  });
  const be = makeBackend({ default: dash });
  const recent = await be.getRecentCronRuns({ sinceMs: T - 120e3, limit: 10 });
  check(
    "相邻 <60s 新 execution 不继承前一轮状态",
    recent.runs.length === 1 && recent.runs[0].sessionKey === "cron_adjacent_previous"
      && recent.runs[0].status === "ok" && recent.runs[0].synthesized !== true
      && !recent.runs.some((run) => run.startedAt === T + 30e3),
  );
  await dash.close();
}

// ---- CRON-002i: Dashboard recent 同步覆盖 200 空行，真实行不重复 ----
{
  const T = 1783900800000;
  const empty = {
    ...J("recent-empty", "recent-empty"),
    last_run_at: new Date(T + 2000).toISOString(),
    last_status: "error",
    last_error: "failed before session",
  };
  const real = {
    ...J("recent-real", "recent-real"),
    last_run_at: new Date(T + 4000).toISOString(),
    last_status: "error",
    last_error: "real session failed",
  };
  const stale = {
    ...J("recent-stale", "recent-stale"),
    last_run_at: new Date(T + 120e3).toISOString(),
    last_status: "error",
    last_error: "new failure without session",
  };
  const never = { ...J("recent-never", "recent-never"), last_run_at: null, last_status: null };
  const dash = await fakeDash({
    "GET /api/cron/jobs": () => ({ code: 200, json: [empty, real, stale, never] }),
    "GET /api/cron/jobs/recent-empty/runs": () => ({ code: 200, json: { runs: [] } }),
    "GET /api/cron/jobs/recent-real/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_recent_real_1", started_at: (T + 3000) / 1000, ended_at: (T + 4000) / 1000 },
    ] } }),
    "GET /api/cron/jobs/recent-stale/runs": () => ({ code: 200, json: { runs: [
      { id: "cron_recent_stale_old", started_at: T / 1000, ended_at: (T + 1000) / 1000 },
    ] } }),
    "GET /api/cron/jobs/recent-never/runs": () => ({ code: 200, json: { runs: [] } }),
  });
  const be = makeBackend({ default: dash });
  const recent = await be.getRecentCronRuns({ sinceMs: T, limit: 10 });
  const emptyRun = recent.runs.find((run) => run.jobId === "hermes-default:recent-empty");
  const realRuns = recent.runs.filter((run) => run.jobId === "hermes-default:recent-real");
  const staleRuns = recent.runs.filter((run) => run.jobId === "hermes-default:recent-stale");
  check(
    "recent 200 空 runs → 合成一条 execution 结果",
    emptyRun?.synthesized === true && emptyRun.status === "error" && emptyRun.error === "failed before session",
  );
  check(
    "recent 真实 session 行不重复合成",
    realRuns.length === 1 && realRuns[0].sessionKey === "cron_recent_real_1" && realRuns[0].synthesized !== true,
  );
  check(
    "recent 最新无 session 失败不污染旧 session",
    staleRuns.length === 2
      && staleRuns[0].synthesized === true && staleRuns[0].status === "error"
      && staleRuns[0].error === "new failure without session"
      && staleRuns[1].sessionKey === "cron_recent_stale_old" && staleRuns[1].status === undefined,
  );
  check("recent 无 last_* 的空任务仍不发明记录", recent.runs.length === 4);
  check("recent 出现合成记录时标 latestOnly", recent.latestOnly === true);
  await dash.close();
}

await done();

async function done() {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`RESULT ${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
}
