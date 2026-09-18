#!/usr/bin/env node
// CRON-005: cron job id 含 "/" 时必须无损到达后端。
// 根因：client 把 encodeURIComponent(id) 放 path，server 对整个 pathname
// decodeURIComponent → %2F 还原成分隔符，segs 断裂 → 404。
// 修法（报告建议原文）："job ID 改用 ?id=；服务端先按 URL 结构路由，再对单个参数解码"
//   a. handleApiRequest 从原始 URL 取 pathname、split 后逐段 decode（path 形式也修好）
//   b. cron/jobs 路由支持 ?id=&action= 形式（照抄 tasks 路由），client 切换过去
// 运行：node scripts/cron-id-routing-unit.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { startStaticServer } = require("../app/static-server.js");

const calls = [];
const fakeBackend = {
  id: "openclaw",
  createCronJob: async (spec) => { calls.push(["create", spec]); return { id: "openclaw:new", backendId: "openclaw" }; },
  updateCronJob: async (id, patch) => { calls.push(["update", id, patch]); return { id, backendId: "openclaw" }; },
  deleteCronJob: async (id) => { calls.push(["delete", id]); },
  runCronJob: async (id) => { calls.push(["run", id]); return { id }; },
  getCronRuns: async (id, options) => { calls.push(["runs", id, options]); return { runs: [] }; },
  getCronLatestDelivery: async (id, at) => { calls.push(["delivery", id, at]); return { source: "none" }; },
};
const registry = {
  backends: new Map([["openclaw", fakeBackend]]),
  getBackend: (id) => (id === "openclaw" && !registry.disabled ? fakeBackend : null),
  disabled: false,
  routeByCronId: (id) => (String(id).startsWith("openclaw:") ? fakeBackend : null),
  resolveResourceOwner: async (kind, id) => (
    kind === "cron" && String(id).startsWith("openclaw:") ? fakeBackend : null
  ),
  aggregateCronJobs: async () => [],
};
const { url, close } = await startStaticServer(0, { registry });

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };
const SLASH_ID = "openclaw:a/b"; // OpenClaw 真实 id 含 "/"
const enc = encodeURIComponent(SLASH_ID);
const req = (method, path, body) =>
  fetch(`${url}${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

// 新 query 形式（client 今后走这条）
{
  calls.length = 0;
  registry.disabled = true;
  const r = await req("POST", "/__api/cron/jobs", { backendId: "openclaw", name: "blocked" });
  check("disabled backend 的 cron create → 400", r.status === 400);
  check("disabled backend 的 cron create → 零 mutation", !calls.some((c) => c[0] === "create"));
  registry.disabled = false;
}
{
  calls.length = 0;
  const r = await req("POST", "/__api/cron/jobs", { backendId: "openclaw", name: "allowed" });
  check("active backend 的 cron create → 200", r.status === 200);
  check("active backend 的 cron create → 精确 mutation", calls.some((c) => c[0] === "create" && c[1].name === "allowed"));
}
{
  calls.length = 0;
  const r = await req("GET", `/__api/cron/jobs?id=${enc}&action=runs`);
  check("query 形式 runs → 200", r.status === 200);
  check("query 形式 runs → id 无损", calls.some((c) => c[0] === "runs" && c[1] === SLASH_ID));
}
{
  calls.length = 0;
  const r = await req("PUT", `/__api/cron/jobs?id=${enc}`, { enabled: false });
  check("query 形式 PUT → 200", r.status === 200);
  check("query 形式 PUT → id 无损", calls.some((c) => c[0] === "update" && c[1] === SLASH_ID));
}
{
  calls.length = 0;
  const r = await req("POST", `/__api/cron/jobs?id=${enc}&action=run`, { mode: "force" });
  check("query 形式 trigger → 200", r.status === 200);
  check("query 形式 trigger → id 无损", calls.some((c) => c[0] === "run" && c[1] === SLASH_ID));
}
{
  calls.length = 0;
  const r = await req("DELETE", `/__api/cron/jobs?id=${enc}`);
  check("query 形式 DELETE → 200", r.status === 200);
  check("query 形式 DELETE → id 无损", calls.some((c) => c[0] === "delete" && c[1] === SLASH_ID));
}
// 旧 path 形式（逐段解码后同样无损——QA final-probe 用的就是这条）
{
  calls.length = 0;
  const r = await req("GET", `/__api/cron/jobs/${enc}/runs`);
  check("path 形式 runs → 200（%2F 不再断段）", r.status === 200);
  check("path 形式 runs → id 无损", calls.some((c) => c[0] === "runs" && c[1] === SLASH_ID));
}
// 不含斜杠的常规 id 在两种形式下不回归
{
  calls.length = 0;
  const r = await req("GET", `/__api/cron/jobs/${encodeURIComponent("openclaw:plain")}/runs`);
  check("常规 id path 形式不回归", r.status === 200 && calls.some((c) => c[1] === "openclaw:plain"));
}

await close();
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
