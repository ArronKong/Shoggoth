import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import CronPage from "../../app/manage-ui/src/pages/CronPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Render the real page, forms, API client, and modal. All API requests and
// mutations stay in memory; this preview cannot schedule a real task.
const backendIds = ["shoggoth", "hermes", "codex", "claude-code", "grok-build", "deepseek-harness", "openclaw", "antigravity"];
const backends = FALLBACK_BACKEND_DESCRIPTORS.filter(({ id }) => backendIds.includes(id));
const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
let sequence = 0;
let jobs: Record<string, any>[] = ["openclaw", "hermes", "codex"].map((backendId, index) => ({
  id: `preview-${backendId}`, backendId, agentId: `${backendId}-agent`,
  name: ["每日项目简报", "每周资料整理", "项目巡检"][index],
  prompt: "整理项目进展，列出待办和需要关注的问题。", enabled: false,
  schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Shanghai" },
  ...(backendId === "openclaw" ? {
    payload: { kind: "agentTurn", message: "整理项目进展，列出待办和需要关注的问题。", thinking: "high", timeoutSeconds: 180 },
    sessionTarget: "isolated", wakeMode: "next-heartbeat", delivery: { mode: "none" },
    failureAlert: { after: 3, cooldownMs: 3600000, mode: "announce", channel: "telegram", to: "preview-channel" },
  } : backendId === "hermes" ? {
    deliver: "local", workdir: "/tmp/preview-project", skills: ["research"], repeat: { times: 5 },
  } : {
    backendDetails: { raw: { workspace: "/tmp/preview-project", misfirePolicy: "all-bounded", maxCatchUp: 3, overlapPolicy: "queue", threadPolicy: "continue", threadId: "preview-thread" } },
  }),
}));
if (new URLSearchParams(location.search).has("list-style")) {
  jobs = [
    { id: "preview-once", backendId: "deepseek-harness", name: "今天的天气", schedule: { kind: "at", at: "2026-09-18T01:46:00.000Z" }, lastStatus: "ok" },
    { id: "preview-interval", backendId: "shoggoth", name: "项目巡检", schedule: { kind: "every", everyMs: 1800000 }, lastStatus: "ok" },
    { id: "preview-weekdays", backendId: "codex", name: "每日项目简报", schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Shanghai" }, lastStatus: "ok" },
  ].map((job) => ({ ...job, enabled: false, deliver: "chat", rawCapabilities: ["native", `schedule:${job.schedule.kind}`, "misfire:latest", "overlap:skip", "thread:new"] }));
}
if (new URLSearchParams(location.search).has("heartbeat")) {
  jobs.push({
    id: "preview-heartbeat", backendId: "openclaw", agentId: "openclaw-agent",
    name: "heartbeat-vincent", enabled: true,
    schedule: { kind: "every", everyMs: 1800000 },
    nextRunAt: Date.now() + 60000, lastStatus: "error",
    payload: { kind: "heartbeat" }, backendDetails: { capabilityTags: ["heartbeat"] },
    actions: { edit: false, toggle: false, delete: false, run: true, reason: "system-managed" },
  });
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const method = init?.method || "GET";
  if (method !== "GET") {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push({ method, path: url.pathname, body });
    document.getElementById("cron-preview-requests")!.textContent = JSON.stringify(requests, null, 2);
    if (method === "POST" && url.pathname === "/__api/cron/jobs") {
      const job = { ...body, id: `preview-created-${++sequence}`, backendDetails: { raw: body } };
      jobs.push(job);
      return response({ job });
    }
    if (method === "PUT" && url.pathname === "/__api/cron/jobs") {
      const id = url.searchParams.get("id");
      jobs = jobs.map((job) => job.id === id ? { ...job, ...body, backendDetails: { raw: { ...job.backendDetails?.raw, ...body } } } : job);
      return response({ job: jobs.find((job) => job.id === id) });
    }
    return response({ error: "Action unavailable in preview" }, 501);
  }
  if (url.pathname === "/__api/config") return response({ config: { locale: "zh-CN", theme: "light", disabledBackends: [] } });
  if (url.pathname === "/__api/backends") return response({ backends });
  if (url.pathname === "/__api/agents") {
    const backendId = url.searchParams.get("backend") || "openclaw";
    const names = backendId === "hermes" ? ["default", "bull", "horse", "coder", "owl", "travel"] : ["项目助理", "资料助理"];
    return response({ agents: names.map((name, index) => ({ id: index === 0 ? `${backendId}-agent` : `${backendId}-${name}`, name, backendId })) });
  }
  if (url.pathname === "/__api/models") {
    const backendId = url.searchParams.get("backend");
    return response({ backendId, catalogRevision: "a".repeat(64), models: [{ id: "preview-model", name: "预览模型", provider: "preview", backendId }] });
  }
  if (url.pathname === "/__api/cron/jobs") {
    if (url.searchParams.get("action") === "detail") return response({ job: jobs.find((job) => job.id === url.searchParams.get("id")) });
    if (url.searchParams.get("action") === "runs") return response({ runs: [] });
    return response({ jobs });
  }
  return response({ error: "Unavailable in isolated preview" }, 501);
};
await applyConfiguredLocale(new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh-CN");
createRoot(document.getElementById("root")!).render(<React.StrictMode><HashRouter><UiProvider>
  <aside style={{ padding: "16px 32px", fontSize: 12, color: "var(--ui-text-3)" }}>Cron 创建流程 · 隔离预览，保存仅保留在当前页面</aside>
  <main style={{ padding: "0 32px 32px" }}><CronPage /></main>
  <details style={{ margin: "0 32px 32px", fontSize: 12 }}><summary>预览提交记录</summary><pre id="cron-preview-requests">[]</pre></details>
</UiProvider></HashRouter></React.StrictMode>);
