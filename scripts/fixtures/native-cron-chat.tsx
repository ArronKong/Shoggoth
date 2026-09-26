import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, Link } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import CronPage from "../../app/manage-ui/src/pages/CronPage";
import Notifier from "../../app/manage-ui/src/components/Notifier";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import { chatNotificationFor, type OpenTargetPayload } from "../../app/manage-ui/src/lib/notify";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// This data is exported by the real isolated Scheduler -> Service -> Backend
// acceptance test. The preview has no access to the user's application service.
const data = await (await fetch("/fixture-data.json")).json();
const state = window as any;
state.cronFixture = data;
state.fixtureErrors = [];
const key = data.delivery.sessionKey;
let openNotification: (payload: OpenTargetPayload) => void = () => {};
state.openclawDesktop = { onOpenTarget: (callback: typeof openNotification) => {
  openNotification = callback;
  return () => { openNotification = () => {}; };
} };
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(data.sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(raw: string) {
    const request = JSON.parse(raw);
    let payload: unknown = {};
    if (request.method === "sessions.list") payload = { sessions: data.sessions, hasMore: false };
    if (request.method === "agents.list") payload = { agents: data.agents };
    if (request.method === "chat.history") payload = request.params.sessionKey === key ? data.history : { messages: [] };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  if (init?.method && init.method !== "GET") return new Response("{}", { status: 501 });
  let result: unknown = {};
  if (url.pathname === "/__api/config") result = { config: { locale: "zh-CN", theme: "light", disabledBackends: [],
    notifications: { chat: true, cron: false, task: false } } };
  if (url.pathname === "/__api/status") result = { backends: [{ id: "shoggoth", connected: true,
    info: { readyAgentIds: data.agents.map((agent: { id: string }) => agent.id) } }] };
  if (url.pathname === "/__api/backends") result = { backends: FALLBACK_BACKEND_DESCRIPTORS.filter((item) => item.id === "shoggoth") };
  if (url.pathname === "/__api/chat/cache-scope") result = { backendId: "shoggoth", cacheScope: "native-cron-isolated-preview" };
  if (url.pathname === "/__api/agents") result = { agents: data.agents };
  if (url.pathname.endsWith("/archive")) result = { archive: { supported: false, segments: [] } };
  if (url.pathname === "/__api/cron/jobs") {
    const action = url.searchParams.get("action");
    result = action === "runs" ? data.runs : action === "detail" ? { job: data.jobDetail }
      : action === "delivery" ? data.delivery : action === "trajectory" ? data.trajectory : { jobs: data.jobs };
  }
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => state.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", (event) => state.fixtureErrors.push(String(event.reason)));
const nativeFinal = { role: "assistant", content: [{ type: "text", text: "我收到了啊" }], shoggoth: { source: "cron" } };
if (chatNotificationFor(nativeFinal, key) !== null) throw Error("Cron must respect its own notification preference");
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><Notifier />
  <nav style={{ height: 40, padding: "10px 24px", boxSizing: "border-box", display: "flex", gap: 24, fontSize: 12 }}>
    <span>原生 Cron · 隔离预览</span>
    <Link to={`/cron?job=${encodeURIComponent(data.jobs[0].id)}`}>查看测试任务</Link>
    <Link to={`/chat?backend=shoggoth&session=${encodeURIComponent(key)}`}>查看 Cron 会话</Link>
    <button onClick={() => openNotification({ category: "cron", target: { kind: "cron", backendId: "shoggoth", jobId: data.jobs[0].id } })}>模拟定时任务通知</button>
    <button onClick={() => openNotification({ category: "task", target: { kind: "task", backendId: "shoggoth", taskId: "fixture", sessionKey: key } })}>模拟任务 Session 通知</button>
  </nav>
  <main style={{ height: "calc(100vh - 40px)", padding: "0 24px", boxSizing: "border-box" }}>
    <Routes><Route path="/chat" element={<ChatPage />} /><Route path="/cron" element={<CronPage />} /></Routes>
  </main>
</UiProvider></HashRouter>);
