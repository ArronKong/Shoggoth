#!/usr/bin/env node
// Contract unit: HermesBackend 的 kanban 写调用必须匹配当前官方 plugin_api.py
// （2026-07-12 按 ~/.hermes/hermes-agent 源码核实）：
//   POST /tasks/{id}/reassign  body ReassignBody {profile, reclaim_first, reason?}
//                              —— 旧 {assignee, reclaim} 键被上游静默忽略，等效
//                              profile=None = 解除指派（KAN-002 的反向操作）。
//   POST /tasks/{id}/reclaim   body ReclaimBody 必需（不带 JSON body 一律 422，KAN-003）。
// 运行：node scripts/hermes-kanban-contract-unit.mjs

import { createServer } from "node:http";
import { HermesBackend } from "../app/core/hermes-backend.js";

// 假 kanban dashboard：记录每个请求，一律 200 {}（readback GET 回一个最小 task）。
const captured = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    captured.push({ method: req.method, url: req.url, contentType: req.headers["content-type"] || "", raw });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && req.url.includes("/api/plugins/kanban/board")) {
      res.end(JSON.stringify({ columns: [], tenants: [], assignees: [] }));
      return;
    }
    if (req.method === "GET" && req.url.includes("/api/plugins/kanban/diagnostics")) {
      res.end(JSON.stringify([
        { task_id: "t9", task_title: "跑偏的任务", task_status: "running", task_assignee: "bull",
          diagnostics: [{ severity: "critical", message: "worker hallucinating card ids" }] },
      ]));
      return;
    }
    if (req.method === "GET" && req.url.includes("/tasks/")) {
      res.end(JSON.stringify({ task: { id: "t1", title: "after", status: "todo" } }));
      return;
    }
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
be.dashboards.set("default", { profile: "default", baseUrl, token: "tok" });

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };
const bodyOf = (e) => (e && e.raw ? JSON.parse(e.raw) : null);

// 1. reassign → {profile, reclaim_first}，不带旧键
{
  captured.length = 0;
  await be.reassignTask("t1", "bull", true);
  const e = captured.find((c) => c.url.endsWith("/api/plugins/kanban/tasks/t1/reassign"));
  const b = bodyOf(e);
  check("reassign 打到 /reassign", !!e);
  check("reassign 用 profile 字段", b && b.profile === "bull");
  check("reassign 用 reclaim_first 字段", b && b.reclaim_first === true);
  check("reassign 不再发旧键 assignee/reclaim", b && !("assignee" in b) && !("reclaim" in b));
}

// 2. 空 assignee = 显式解除指派（profile:null 是官方语义，保持）
{
  captured.length = 0;
  await be.reassignTask("t1", "", false);
  const b = bodyOf(captured.find((c) => c.url.endsWith("/reassign")));
  check("reassign 空值 → profile null", b && b.profile === null);
  check("reassign 空值 → reclaim_first false", b && b.reclaim_first === false);
}

// 3. reclaim 必须带可解析的 JSON body
{
  captured.length = 0;
  await be.reclaimTask("t1");
  const e = captured.find((c) => c.url.endsWith("/api/plugins/kanban/tasks/t1/reclaim"));
  check("reclaim 打到 /reclaim", !!e);
  check("reclaim 带 JSON content-type", !!e && e.contentType.includes("application/json"));
  check("reclaim body 可解析为对象", !!e && typeof bodyOf(e) === "object" && bodyOf(e) !== null);
}

// 4. updateTask 拒绝 create-only 字段（KAN-001：官方 UpdateTaskBody 没有它们，
//    上游 pydantic 静默丢弃 → 200 但没更新。必须响亮报错，且不发请求。）
for (const patch of [{ tenant: "acme" }, { skills: ["a"] }, { goalMode: true }, { goalMaxTurns: 5 }]) {
  const key = Object.keys(patch)[0];
  captured.length = 0;
  let err = null;
  try { await be.updateTask("t1", patch); } catch (e) { err = e; }
  check(`updateTask 拒绝 ${key}`, !!err && /仅创建时可设置/.test(err.message));
  check(`updateTask(${key}) 不发任何上游请求`, captured.length === 0);
}

// 5. updateTask 只转发官方支持的键（title/body/assignee/priority/status）
{
  captured.length = 0;
  await be.updateTask("t1", { title: "a", body: "b", assignee: "c", priority: 2, column: "done" });
  const e = captured.find((c) => c.method === "PATCH" && c.url.endsWith("/api/plugins/kanban/tasks/t1"));
  const b = bodyOf(e);
  check("updateTask PATCH /tasks/{id}", !!e);
  check("updateTask body 精确 = 官方键", !!b && JSON.stringify(b) === JSON.stringify({ title: "a", body: "b", assignee: "c", priority: 2, status: "done" }));
}

// 6. board 上下文贯穿（KAN-005/006）：带 opts.board 的操作，上游 URL 必须带 ?board=。
//    官方全部 task 端点接受 board Query；不传时落 current board，非当前板的
//    详情/写操作就会 404/串板。
{
  const opsWithBoard = [
    ["getTask", () => be.getTask("t1", { board: "b2" })],
    ["updateTask", () => be.updateTask("t1", { title: "x" }, { board: "b2" })],
    ["moveTask", () => be.moveTask("t1", "done", 0, { board: "b2" })],
    ["archiveTask", () => be.archiveTask("t1", true, { board: "b2" })],
    ["addTaskComment", () => be.addTaskComment("t1", "hi", "dashboard", { board: "b2" })],
    ["taskAction", () => be.taskAction("t1", "specify", { board: "b2" })],
    ["getTaskLog", () => be.getTaskLog("t1", { board: "b2" })],
    ["addTaskLink", () => be.addTaskLink("t1", "t2", { board: "b2" })],
    ["removeTaskLink", () => be.removeTaskLink("t1", "t2", { board: "b2" })],
    ["reassignTask", () => be.reassignTask("t1", "bull", false, { board: "b2" })],
    ["reclaimTask", () => be.reclaimTask("t1", { board: "b2" })],
  ];
  for (const [name, run] of opsWithBoard) {
    captured.length = 0;
    try { await run(); } catch { /* fake 响应形状即可，错误不重要 */ }
    const hit = captured.find((c) => c.url.includes("/api/plugins/kanban/"));
    check(`${name} 携带 board=b2`, !!hit && /[?&]board=b2(&|$)/.test(hit.url));
  }
  // 不带 opts 时不加 board（current board 语义不变）
  captured.length = 0;
  await be.getTask("t1");
  const bare = captured.find((c) => c.url.includes("/tasks/t1"));
  check("无 opts 时不加 board", !!bare && !bare.url.includes("board="));
}

// 7. KAN-004: capabilities 声明直接可设状态白名单。官方 update_task 只接受
//    triage/todo/ready/scheduled/blocked/done/archived；running 显式 400、
//    review 是 unknown status —— UI 据此禁用非法拖放/快捷移动目标。
{
  const board = await be.getTaskBoard({});
  const mt = board?.capabilities?.moveTargets;
  check("capabilities.moveTargets 存在", Array.isArray(mt));
  check(
    "moveTargets = 官方 PATCH 白名单",
    Array.isArray(mt) && JSON.stringify([...mt].sort()) ===
      JSON.stringify(["archived", "blocked", "done", "ready", "scheduled", "todo", "triage"]),
  );
  check("moveTargets 不含 running/review", Array.isArray(mt) && !mt.includes("running") && !mt.includes("review"));
}

// 8. GAP-001/KAN-007: 官方已有真 DELETE /tasks/{id}，deleteTask 不再伪装成
//    PATCH archived（否则详情页两个"归档"按钮语义撞车）。
{
  captured.length = 0;
  await be.deleteTask("t1", { board: "b2" });
  const del = captured.find((c) => c.method === "DELETE" && c.url.includes("/tasks/t1"));
  check("deleteTask 用 DELETE 动词", !!del);
  check("deleteTask 带 board", !!del && /[?&]board=b2(&|$)/.test(del.url));
  check("deleteTask 不再 PATCH archived", !captured.some((c) => c.method === "PATCH"));
}
// caps.hardDelete 声明（UI 删除按钮语义依据）
{
  const board = await be.getTaskBoard({});
  check("capabilities.hardDelete = true", board?.capabilities?.hardDelete === true);
}

// 9. GAP-002: 官方 GET /diagnostics 暴露为管理面契约（capability 早就声明了
//    diagnostics:true，但板级列表一直没有路由）。
{
  captured.length = 0;
  const rows = await be.getTaskDiagnostics({ board: "b2", severity: "critical" });
  const hit = captured.find((c) => c.url.includes("/api/plugins/kanban/diagnostics"));
  check("diagnostics 打官方端点", !!hit);
  check("diagnostics 透传 board+severity", !!hit && /[?&]board=b2(&|$)/.test(hit.url) && /[?&]severity=critical(&|$)/.test(hit.url));
  check("diagnostics 行归一化", Array.isArray(rows) && rows.length === 1 && rows[0].taskId === "t9" && rows[0].diagnostics[0].severity === "critical");
}

await new Promise((r) => server.close(r));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
