import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import CronPage from "../../app/manage-ui/src/pages/CronPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const ownerId = "shoggoth-codex", profileId = "2c0d5a3e-7b91-4a6f-9d42-0d3a8c5f1e72";
const source = { origin: "codex-desktop", backendId: "shoggoth", ownerProfileId: profileId, ownerAgentId: ownerId,
  available: true, canCreate: true, reason: null, unavailable: [], timeZone: "Asia/Shanghai", clientRefreshRequired: true };
const requests: any[] = []; let sequence = 1;
const models = [{ id: "gpt-fixture", name: "预览模型", isDefault: true, thinkingOptions: ["low", "medium", "high"], thinkingDefault: "medium" },
  { id: "gpt-fast", name: "快速模型", isDefault: false, thinkingOptions: ["minimal", "low"], thinkingDefault: "low" }];
function task(name: string, kind = "cron", extra: any = {}): any {
  const id = `codex-automation:${"a".repeat(24)}:fixture-${sequence++}`;
  return { id, externalTaskId: id.split(":").at(-1), origin: "codex-desktop", backendId: "shoggoth", agentId: ownerId, ownerProfileId: profileId,
    revision: "a".repeat(64), name, prompt: "整理项目进展，列出待办和需要关注的问题。", enabled: false, state: "PAUSED",
    schedule: { kind: "rrule", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0;BYSECOND=0", tz: "Asia/Shanghai", anchorMs: Date.now() - 86400000 },
    model: "gpt-fixture", reasoningEffort: "high", actions: { edit: true, run: kind === "cron", toggle: true, delete: false },
    codex: { kind, cwd: "~", cwds: ["~"], executionEnvironment: "local", target: { type: "projectless" }, targetThreadId: kind === "heartbeat" ? "original-conversation" : null },
    runReason: kind === "heartbeat" ? "CODEX_AUTOMATION_RUN_UNSUPPORTED" : null, ...extra };
}
let jobs = [task("每天简报"), task("原会话跟进", "heartbeat")];
const history: any[] = Array.from({ length: 25 }, (_, i) => ({ runId: `codex:old-${i}`, executionOrigin: "codex-desktop", executionStatus: "unknown", completionStatus: "unknown",
  status: "unknown", reviewStatus: i ? "ARCHIVED" : "PENDING_REVIEW", startedAt: Date.now() - i * 3600000, summary: `原生结果 ${i + 1}` }));
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin), method = init?.method || "GET", id = url.searchParams.get("id"), action = url.searchParams.get("action");
  if (method !== "GET") {
    const body = JSON.parse(String(init?.body || "{}")); requests.push({ method, path: url.pathname, action, body });
    document.getElementById("codex-preview-requests")!.textContent = JSON.stringify(requests, null, 2);
    if (action === "run") { const run = { runId: `automation-preview-${sequence++}`, executionOrigin: "shoggoth", executionStatus: "completed", status: "ok", completionStatus: "succeeded",
      startedAt: Date.now(), finishedAt: Date.now(), model: jobs.find(j => j.id === id)?.model, reasoningEffort: jobs.find(j => j.id === id)?.reasoningEffort, workspace: "~/project" }; history.unshift(run); return response({ job: { ...run, status: "completed" } }); }
    if (action === "control") return response({ accepted: true, status: "interrupted" });
    if (method === "PUT") { const index = jobs.findIndex(j => j.id === id); jobs[index] = { ...jobs[index], ...body, ...(body.schedule ? { schedule: { ...body.schedule, tz: "Asia/Shanghai", anchorMs: jobs[index].createdAt || Date.now() } } : {}),
      state: body.enabled === undefined ? jobs[index].state : body.enabled ? "ACTIVE" : "PAUSED", revision: "b".repeat(64) }; return response({ job: jobs[index] }); }
    if (method === "POST") { const job = task(body.name, body.kind, { ...body, schedule: { ...body.schedule, tz: "Asia/Shanghai", anchorMs: Date.now() }, codex: { kind: body.kind, cwd: body.cwd, cwds: [body.cwd], target: { type: "projectless" }, executionEnvironment: body.executionEnvironment } }); jobs.push(job); return response({ job }); }
    return response({ error: "Unavailable" }, 400);
  }
  if (url.pathname === "/__api/config") return response({ config: { locale: "zh-CN", theme: "light", disabledBackends: [] } });
  if (url.pathname === "/__api/backends") return response({ backends: FALLBACK_BACKEND_DESCRIPTORS.filter(b => b.id === "shoggoth") });
  if (url.pathname === "/__api/agents") return response({ agents: [{ id: ownerId, name: "已改名的 Codex", backendId: "shoggoth", codexAutomationOwner: true },
    { id: "clone-codex", name: "Codex 副本", backendId: "shoggoth", codexAutomationOwner: false }] });
  if (url.pathname === "/__api/cron/codex") return response(source);
  if (url.pathname === "/__api/cron/codex/models") return response({ models, defaultModelId: "gpt-fixture" });
  if (url.pathname === "/__api/cron/jobs") {
    if (action === "detail") return response({ job: jobs.find(j => j.id === id) });
    if (action === "runs") { const offset = Number(url.searchParams.get("offset") || 0); return response({ runs: history.slice(offset, offset + 20), nextOffset: offset + 20 < history.length ? offset + 20 : null, sourceError: null }); }
    if (action === "result") { const metadata = history.find(r => r.runId === url.searchParams.get("runId")); return response({ ...metadata, available: true, outputComplete: true,
      fullText: "# 运行结果\n\nSHOGGOTH_AUTOMATION_CONNECTED\n\n" + "这是完整报告正文。\n\n".repeat(1600), contentLength: 18000, contentRevision: "c".repeat(64) }); }
    if (action === "delivery") return response({ available: false, supported: true });
    const agentIds = (url.searchParams.get("agentIds") || "").split(",").filter(Boolean); return response({ jobs: agentIds.length ? jobs.filter(j => agentIds.includes(j.agentId)) : jobs });
  }
  return response({ error: "Unavailable in isolated preview" }, 501);
};
await applyConfiguredLocale(new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh-CN");
createRoot(document.getElementById("root")!).render(<React.StrictMode><HashRouter><UiProvider>
  <aside style={{ padding: "16px 32px", fontSize: 12 }}>Codex 自动任务 · 隔离界面验证，数据只保留在当前页面</aside>
  <main style={{ padding: "0 32px 32px" }}><CronPage /></main>
  <details style={{ margin: 32 }}><summary>测试提交记录</summary><pre id="codex-preview-requests">[]</pre></details>
</UiProvider></HashRouter></React.StrictMode>);
