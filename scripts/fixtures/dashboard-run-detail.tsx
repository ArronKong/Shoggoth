// Production Dashboard/Modal, with isolated deterministic API responses only.
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import DashboardPage from "../../app/manage-ui/src/pages/DashboardPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const state = window as any, options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN", theme = options.get("theme") || "light";
const now = Date.now(), startedAt = now - 42_000;
const runId = "preview-task", title = "Tibo 额度重置监测";
let stage = options.get("state") === "completed" ? 4 : 0, outage = false, detailReads = 0, summaryReads = 0;
const resultText = "### 监测结果\n\n官方公告与生效时区已核对，本次监测已完成。\n\n- **公告来源**：已核对\n- **生效时间**：已完成时区换算\n\n这是一条用于查看界面效果的示例任务。";
const events: any[] = [
  { type: "status", status: "running" },
  { type: "performance.stage" },
  { type: "text.delta", delta: "我会先核对官方公告，", segmentId: "intro" },
  { type: "text", text: "我会先核对官方公告，再确认额度重置的具体时间。", phase: "commentary", segmentId: "intro" },
  { type: "tool.start", toolCallId: "search", tool: { name: "web_search", displayArgs: { activityTitle: "查找 Tibo 的官方额度重置公告", query: "Tibo Codex quota reset official" } } },
  { type: "tool.result", toolCallId: "search", tool: { name: "web_search", status: "completed", resultSummary: "已找到官方说明和相关公告。" } },
  { type: "text", text: "已找到相关公告，正在核对生效日期和时区。", phase: "commentary", segmentId: "progress" },
  { type: "tool.start", toolCallId: "read", tool: { name: "web_fetch", displayArgs: { activityTitle: "核对公告中的生效日期与时区", url: "https://example.com/announcement" } } },
  { type: "tool.result", toolCallId: "read", tool: { name: "web_fetch", status: "completed", resultSummary: "时间和适用范围已核对。" } },
  { type: "text", text: "核对完成，正在整理监测结论。", phase: "commentary", segmentId: "summary" },
  { type: "text.delta", delta: resultText.slice(0, 20) },
  { type: "text.delta", delta: resultText.slice(20) },
].map((event, index) => ({ ...event, seq: index + 1 }));
const detail = () => ({ id: `shoggoth:${runId}`, backendId: "shoggoth", runId, source: "cron", title, runtime: "Grok",
  status: stage === 4 ? "completed" : stage === 5 ? "failed" : "running", agentId: "preview-grok", startedAt,
  finishedAt: stage >= 4 ? now + 20_000 : undefined, error: stage === 5 ? "公告暂时无法读取，请稍后重试。" : undefined,
  events: events.slice(0, stage === 0 ? 5 : stage === 1 ? 8 : stage === 2 ? 11 : 12), artifacts: [] });
const running = () => stage >= 4 ? [] : [{ id: `shoggoth:${runId}`, backendId: "shoggoth", runId, kind: "cron", title, agentId: "preview-grok", status: "running", startedAt }];
const resultRun = () => ({ backendId: "shoggoth", jobId: "shoggoth:preview-job", jobName: title, runId,
  agentId: "preview-grok", sessionKey: "preview-session", startedAt, finishedAt: now + 20_000,
  status: "ok", completionStatus: "succeeded", durationMs: 62_000, summary: resultText });
const summary = () => ({ generatedAt: Date.now(), sinceMs: now - 60_000,
  status: [{ id: "shoggoth", name: "Shoggoth", connected: true, info: {} }], runs: stage >= 4 ? [resultRun()] : [],
  running: [{ backend: "shoggoth", supported: true, items: running() }], approvals: [],
  usage: [{ backend: "shoggoth", today: { totalCost: 0.86, totalTokens: 640_000 }, yesterday: { totalCost: 1.2, totalTokens: 820_000 }, availability: "complete" }],
  artifacts: [], activityPage: { items: stage >= 4 ? [{ id: `cron:shoggoth:preview-job:run:${runId}`, kind: "cron", backendId: "shoggoth",
    occurredAt: now + 20_000, severity: "success", title, agentId: "preview-grok", summary: resultText, run: resultRun() }] : [], hasMore: false, degradedSources: [] },
  taskStats: { total: { ok: 8, error: 1 }, byKind: {}, byAgent: [{ agentId: "preview-grok", backendId: "shoggoth", ok: 3, error: 0 }], complete: true },
});
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") throw Error("Fixture forbids writes");
  const p = new URL(String(url), "http://fixture");
  let value: any = {};
  if (p.pathname === "/__api/dashboard") { summaryReads++; value = { summary: summary() }; }
  else if (p.pathname === "/__api/dashboard/live") value = { generatedAt: now, running: summary().running, approvals: [] };
  else if (p.pathname === "/__api/dashboard/activities") value = summary().activityPage;
  else if (p.pathname === "/__api/cron" && p.searchParams.get("action") === "delivery") value = { ...resultRun(), fullText: resultText };
  else if (p.pathname.startsWith("/__api/dashboard/runs/")) {
    detailReads++;
    if (outage) return new Response("{}", { status: 503 });
    value = detail();
  } else if (p.pathname === "/__api/config") value = { config: { disabledBackends: ["openclaw", "hermes"], locale: language } };
  else if (p.pathname === "/__api/backends") value = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (p.pathname === "/__api/agents") value = { agents: [{ id: "preview-grok", name: "Grok", backendId: "shoggoth" }] };
  else if (p.pathname === "/__api/usage") value = { series: null };
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
localStorage.clear();
await i18n.changeLanguage(language);
document.documentElement.dataset.theme = theme;
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><DashboardPage /></UiProvider></HashRouter>);
const wait = async (check: () => unknown, label: string) => {
  const end = performance.now() + 8_000;
  while (!check()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > end) throw Error(label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
const body = () => document.querySelector<HTMLElement>('[role="dialog"]')?.innerText || "";
state.openFixture = async () => {
  await wait(() => document.querySelector(`[data-run-id="${runId}"] [data-dashboard-status-header]`), "Task row missing");
  document.querySelector<HTMLButtonElement>(`[data-run-id="${runId}"] [data-dashboard-status-header]`)!.click();
  await wait(() => body().includes(title) && body().includes("查找 Tibo"), "Run dialog did not load");
};
state.openResultFixture = async () => {
  const close = document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${i18n.t("common.close")}"]`);
  close?.click();
  await wait(() => !document.querySelector('[role="dialog"]'), "Execution dialog did not close");
  await wait(() => document.querySelector('.dash-feed .dash-run'), "Completed result card missing");
  document.querySelector<HTMLButtonElement>('.dash-feed .dash-run')!.click();
  await wait(() => body().includes("监测结果") && body().includes(i18n.t("dashboard.openInCron")), "Existing result dialog did not open");
};
state.runFixture = async () => {
  await state.openFixture();
  const first = body();
  if (/performance\.stage|text\.delta|tool\.start|shoggoth:preview-task/.test(first)) throw Error("Raw protocol leaked into the UI");
  if (!first.includes("Grok") || !first.includes(i18n.t("dashboardRun.status.running"))) throw Error("Task identity/status missing");
  if (!first.includes("我会先核对官方公告")) throw Error("Public progress missing");
  const beforeReplyReads = summaryReads;
  stage = 3;
  await wait(() => body().includes("核对完成，正在整理监测结论"), "Public activity did not update while open");
  if (body().includes("监测结果") || document.querySelector('[role="dialog"] .chat-md')) throw Error("Reply/result body leaked into execution dialog");
  if (summaryReads !== beforeReplyReads || document.querySelector('.dash-feed .dash-run')) throw Error("Reply text was mistaken for task completion");
  const publicNotes = body().match(/我会先核对官方公告/g) || [];
  if (publicNotes.length !== 1) throw Error("Commentary duplicated");
  outage = true;
  await wait(() => body().includes(i18n.t("dashboardRun.stale")), "Read failure not visible");
  if (!body().includes("核对完成，正在整理监测结论")) throw Error("Read failure erased public activity");
  outage = false; stage = 4;
  await wait(() => [...document.querySelectorAll('[role="dialog"] [role="status"]')]
    .some(element => element.textContent === i18n.t("dashboardRun.status.completed")), "Completion did not update");
  await wait(() => document.querySelector('.dash-feed .dash-run') && !document.querySelector(`[data-run-id="${runId}"]`), "Completion did not refresh the existing card");
  if (body().includes("监测结果") || document.querySelector('[role="dialog"] .chat-md')) throw Error("Completed result appended to execution dialog");
  const finishedSummaryReads = summaryReads;
  const finishedReads = detailReads;
  await new Promise(resolve => setTimeout(resolve, 2200));
  if (detailReads !== finishedReads) throw Error("Terminal run keeps polling");
  if (summaryReads !== finishedSummaryReads) throw Error("Completion refresh keeps repeating");
  if (document.documentElement.scrollWidth > window.innerWidth + 1) throw Error("Page overflows horizontally");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  if (dialog.scrollWidth > dialog.clientWidth + 1) throw Error("Dialog overflows horizontally");
  await state.openResultFixture();
  if (document.querySelectorAll('[role="dialog"] .cron-delivery-md h3').length !== 1) throw Error("Existing result Markdown missing");
  if (body().includes(i18n.t("turnLab.processLabel"))) throw Error("Execution activity leaked into result dialog");
  if (!body().includes(i18n.t("cron.askInChat"))) throw Error("Existing result follow-up action missing");
  return { language, theme, publicProgress: true, liveUpdate: true, separateResultCard: true, separateResultDialog: true,
    replyDoesNotCompleteRun: true, markdown: true, failureRetention: true, terminalStopsPolling: true, reads: detailReads };
};
if (!options.has("test")) {
  const bar = document.createElement("div");
  bar.setAttribute("style", "position:fixed;z-index:1;top:14px;right:28px;display:flex;align-items:center;gap:12px;font:12px system-ui;color:var(--ui-text-2)");
  bar.innerHTML = '<span>界面预览 · 示例任务</span><button class="btn-subtle btn-sm">执行中</button><button class="btn-subtle btn-sm">已完成</button>';
  bar.querySelectorAll("button")[0].onclick = () => { location.search = ""; };
  bar.querySelectorAll("button")[1].onclick = () => { location.search = "?state=completed"; };
  document.body.append(bar);
  if (stage === 4) void state.openResultFixture();
  else state.openFixture().then(() => {
    setTimeout(() => { stage = 1; }, 5000);
    setTimeout(() => { stage = 2; }, 10000);
    setTimeout(() => { stage = 3; }, 15000);
  });
}
