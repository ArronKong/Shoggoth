import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const state = window as any;
const keys = { openclaw: "agent:main:main", hermes: "agent:hermes-plan:main", native: "agent:shoggoth-plan:main" };
const now = Date.now();
const sessions = Object.entries(keys).map(([backend, key], index) => ({
  key, agentId: key.split(":")[1], agentName: backend === "native" ? "原生计划" : backend,
  backendId: backend === "native" ? "shoggoth" : backend, updatedAt: now - index,
}));
const plan = [
  { content: "探活模型与备份配置", status: "completed" },
  { content: "完成批量切换", status: "completed" },
  { content: "解释同步任务", status: "completed" },
  { content: "修复通知投递", status: "pending" },
  { content: "处理剩余任务", status: "pending" },
  { content: "重建日报素材", status: "pending" },
  { content: "校验并汇报", status: "pending" },
];
let card: any = { sessionKey: keys.openclaw, revision: 18, updatedAt: now,
  markdown: "## 🔧 Cron 模型切换到 mimo + 投递链修复\n\n独立计划区中的说明。\n\n| 项目 | 状态 |\n|---|---|\n| 配置检查 | 已完成 |\n| 通知投递 | 待处理 |\n\n```sh\nnpm run check\n```\n\n"
    + Array.from({ length: 12 }, (_, i) => `- 核对项目 ${i + 1}：完整内容可以滚动查看。`).join("\n"),
  steps: plan.map((entry) => ({ step: entry.content, status: entry.status })),
};
const initialCard = structuredClone(card);
const history: Record<string, any[]> = Object.fromEntries(Object.values(keys).map((key) => [key, [
  { id: `${key}:u`, role: "user", content: "检查配置并整理结果。", timestamp: now - 10000 },
  { id: `${key}:old-plan`, role: "assistant", content: [{ type: "plan", planEntries: [{ content: "历史计划不应混进消息流", status: "completed" }] }], timestamp: now - 9900 },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `${key}:a${i}`, role: "assistant",
    content: `检查结果 ${i + 1}：普通消息保持原有内容与顺序。\n\n这一段用于验证展开计划后，最后一条消息仍可滚动到可见区域。`,
    timestamp: now - 9000 + i * 100 })),
]]));
history[keys.hermes] = [{ id: "hermes-u", role: "user", content: "开始工作。" }];
history[keys.native].push({ id: "native-plan", role: "assistant", content: [
  { type: "plan", planEntries: [{ content: "原生历史步骤", status: "completed" }, { content: "原生待处理步骤", status: "pending" }] },
  { type: "text", text: "原生会话正文保留。" },
] });
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", keys.openclaw);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
state.requests = [];
const ready = { type: "event", event: "gateway.ready", payload: {
  protocol: 4, server: { version: "2026.8.1" },
  features: { methods: ["progressCard.get"], events: ["progressCard.changed"], capabilities: [] },
  auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  policy: { maxPayload: 1048576, maxBufferedBytes: 1048576 },
} };
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { state.socket = this; state.socketCount = (state.socketCount ?? 0) + 1; setTimeout(() => { this.onopen?.(); this.emit(ready); }, 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    state.requests.push(request);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: sessions.map((session) => ({ id: session.agentId, name: session.agentName, backendId: session.backendId })) }
      : request.method === "chat.history" ? { messages: history[request.params.sessionKey] ?? [] }
      : request.method === "progressCard.get" ? { card: request.params.sessionKey === keys.openclaw ? card : null } : {};
    const reply = () => this.emit({ type: "res", id: request.id, ok: true, payload });
    if (request.method === "chat.history" && state.holdHistoryFor === request.params.sessionKey) {
      state.holdHistoryFor = null;
      state.delayedHistoryReply = reply;
    } else if (request.method === "progressCard.get" && state.holdProgressRead) {
      state.holdProgressRead = false;
      state.delayedProgressReply = reply;
    } else setTimeout(reply, 0);
    if (request.method === "chat.send") {
      history[request.params.sessionKey].push({ id: "send-user", role: "user", content: request.params.message });
      setTimeout(() => this.emit({ type: "event", event: "chat", payload: {
        sessionKey: request.params.sessionKey, runId: "fixture-run", state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "新回复正在生成。" }] },
      } }), 20);
    }
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const path = String(url);
  const payload = path.includes("/__api/status") ? { backends: ["openclaw", "hermes", "shoggoth"].map((id) => ({ id, connected: true })) }
    : path.includes("/__api/backends") ? { backends: [] }
    : path.includes("runtime-models") ? { selection: { bindingId: "fixture", runtime: "codex", model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false }, models: [], runtimes: [] }
    : path.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason); });
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
  await pause();
};
const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); };
const dock = () => document.querySelector<HTMLElement>("[data-chat-plan-dock]")!;
const toggle = () => dock().querySelector<HTMLButtonElement>("button")!;
const thread = () => document.querySelector<HTMLElement>(".chat-thread")!;
let activeFixtureSession: keyof typeof keys = "openclaw";
const openSession = async (backend: keyof typeof keys) => {
  if (activeFixtureSession === backend) return;
  location.hash = `/chat?session=${encodeURIComponent(keys[backend])}&backend=${backend === "native" ? "shoggoth" : backend}`;
  await wait(() => location.hash === "#/chat" && state.requests.at(-1), "session navigation");
  await pause(180);
  activeFixtureSession = backend;
};
const ensureNoInlinePlan = () => {
  check(!thread().querySelector("[data-chat-plan-dock], .chat-plan"), "the message stream has no plan card");
  check(!thread().textContent?.includes("历史计划不应混进消息流"), "plan-only history leaves no plan text or timeline entry");
};
const geometry = () => {
  const root = document.querySelector<HTMLElement>('[data-testid="immersive-chat"]');
  const composer = (root ?? document).querySelector<HTMLElement>("[data-chat-composer]")!;
  const p = dock().getBoundingClientRect(), c = composer.getBoundingClientRect();
  check(p.bottom <= c.top + 1 && c.top - p.bottom <= 12, "plan attaches directly above the input");
  check(Math.abs(p.left - c.left) < 2 && Math.abs(p.width - c.width) < 2, "plan/input widths and left edges match");
  check(c.bottom <= innerHeight && p.top > 100, "expanded plan/input stay inside the viewport");
  const body = dock().querySelector<HTMLElement>(".chat-plan-dock__body")!;
  check(dock().scrollWidth <= dock().clientWidth + 2 && body.scrollWidth <= body.clientWidth + 2, "long content does not overflow the plan horizontally");
  return { planTop: Math.round(p.top), planHeight: Math.round(p.height), composerTop: Math.round(c.top), composerBottom: Math.round(c.bottom) };
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

state.preparePlanFixture = async () => {
  await wait(() => dock()?.dataset.progressRevision === "18" && thread()?.textContent?.includes("检查结果 10"), "durable plan and history");
  check(toggle().getAttribute("aria-expanded") === "false", "default collapsed");
  check(dock().textContent?.includes("3/7"), "completed count");
  check(thread().querySelectorAll(".chat-bubble").length === 11, "plan-only history has no ghost bubble");
  ensureNoInlinePlan();
  const closed = geometry();
  toggle().click();
  await wait(() => toggle().getAttribute("aria-expanded") === "true", "expand");
  const expanded = geometry();
  check(expanded.planHeight > closed.planHeight + 24, "expansion shows a bounded body");
  const body = dock().querySelector<HTMLElement>(".chat-plan-dock__body")!;
  check(body.scrollHeight > body.clientHeight, "long plans scroll within the dock");
  check(body.querySelector(".chat-md .code-block-copy"), "plan Markdown retains the shared code block controls");
  thread().scrollTop = thread().scrollHeight;
  await pause(80);
  const last = thread().querySelectorAll(".chat-bubble").item(10).getBoundingClientRect();
  check(last.bottom < dock().getBoundingClientRect().top, "latest reply can be read above the expanded plan");
  const header = document.querySelector(".chat-topdock")!.getBoundingClientRect();
  const style = getComputedStyle(thread());
  const visibleTop = Math.max(header.bottom, thread().getBoundingClientRect().top
    + parseFloat(style.getPropertyValue("--chat-fade-top")) + parseFloat(style.getPropertyValue("--chat-fade")));
  check(last.bottom - Math.max(last.top, visibleTop) >= Math.min(last.height, 48), "expanded plan leaves at least two readable lines below the header");
  const beforeScroll = dock().getBoundingClientRect().top;
  thread().scrollTop = 0;
  await pause(80);
  check(Math.abs(dock().getBoundingClientRect().top - beforeScroll) < 1, "plan remains attached while history scrolls");
  state.geometryResult = { closed, expanded };
  return state.geometryResult;
};

state.runPlanFixture = async () => {
  const geometryResult = state.geometryResult ?? await state.preparePlanFixture();
  const input = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "说明新的问题");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause(80);
  document.querySelector<HTMLButtonElement>('[data-send-entry="composerButton"]')!.click();
  await wait(() => state.requests.some((request: any) => request.method === "chat.send"), "send new message");
  await wait(() => thread().textContent?.includes("新回复正在生成"), "streaming reply");
  check(state.requests.find((request: any) => request.method === "chat.send").params.message === "说明新的问题", "plan is not added to chat.send");
  check(toggle().getAttribute("aria-expanded") === "true", "streaming updates preserve expansion");
  ensureNoInlinePlan();
  const answer = { id: "new-answer", role: "assistant", content: "新的回复已经完成。" };
  history[keys.openclaw].push(answer);
  state.holdHistoryFor = keys.openclaw;
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: keys.openclaw, runId: "fixture-run", state: "final", message: answer } });
  await wait(() => thread().textContent?.includes(answer.content), "final response");
  await wait(() => state.delayedHistoryReply, "hold final history refresh");
  card = null;
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: null } });
  await wait(() => !dock(), "cleared progress cannot fall back to the settled live snapshot");
  state.delayedHistoryReply();
  card = structuredClone(initialCard);
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: 18 } });
  await wait(() => dock()?.dataset.progressRevision === "18", "new progress after a clear");
  await openSession("hermes");
  check(!dock(), "another session must not inherit the OpenClaw plan");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: keys.hermes, runId: "hermes-run", state: "plan",
    plan: [{ content: "Hermes 正在验证", status: "in_progress" }, { content: "Hermes 后续步骤", status: "pending" }] } });
  await wait(() => dock()?.textContent?.includes("Hermes 正在验证"), "ACP live plan");
  check(toggle().getAttribute("aria-expanded") === "false", "expansion is session scoped");
  ensureNoInlinePlan();
  check(!thread().textContent?.includes("Hermes 正在验证"), "live timeline has no duplicate plan");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: keys.hermes, state: "plan", plan: [] } });
  await wait(() => !dock(), "explicit empty plan");
  await openSession("native");
  await wait(() => dock()?.textContent?.includes("原生待处理步骤"), "native history plan");
  check(thread().textContent?.includes("原生会话正文保留"), "mixed plan/text message preserves text");
  check(!thread().textContent?.includes("原生历史步骤"), "native plan stays out of the thread");
  history[keys.native].push({ id: "native-clear", role: "assistant", content: [{ type: "plan", planEntries: [] }], errorMessage: "计划已清空，执行已停止。" });
  await openSession("hermes");
  await openSession("native");
  await wait(() => !dock(), "an empty history snapshot retires the previous plan");
  check(thread().textContent?.includes("原生会话正文保留"), "empty history plan preserves the reply");
  check(thread().textContent?.includes("计划已清空，执行已停止。"), "empty history plan preserves the terminal error");
  await openSession("openclaw");
  await wait(() => dock()?.dataset.progressRevision === "18", "restore persistent plan");
  check(toggle().getAttribute("aria-expanded") === "true", "switching back restores expansion");
  card = { ...card, revision: 19, steps: card.steps.map((step: any, index: number) => ({ ...step, status: index === 3 ? "in_progress" : step.status })) };
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: 19 } });
  await wait(() => dock()?.dataset.progressRevision === "19", "progress update");
  check(toggle().getAttribute("aria-expanded") === "true", "revision change does not collapse the plan");
  const expanded = geometry();
  if (innerWidth >= 1000) {
    Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"] [data-chat-plan-dock]'), "immersive plan");
    check(document.querySelectorAll("[data-chat-plan-dock]").length === 1, "one shared visible dock");
    check(toggle().getAttribute("aria-expanded") === "true", "mode switch preserves expansion");
    const root = document.querySelector<HTMLElement>('[data-testid="immersive-chat"]')!;
    const immersiveGeometry = geometry();
    toggle().click();
    await wait(() => toggle().getAttribute("aria-expanded") === "false", "immersive collapse");
    geometry();
    root.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
    await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "exit immersive");
    check(toggle().getAttribute("aria-expanded") === "false", "collapse persists across modes");
    state.immersiveGeometry = immersiveGeometry;
  }
  const sockets = state.socketCount;
  state.socket.readyState = 3;
  state.socket.onclose?.();
  await wait(() => state.socketCount > sockets && dock()?.dataset.progressRevision === "19", "reconnect restores the plan");
  ensureNoInlinePlan();
  // A cleared card and a late read cannot revive a previous revision.
  state.holdProgressRead = true;
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: 19 } });
  await wait(() => state.delayedProgressReply, "hold progress read");
  card = null;
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: null } });
  await wait(() => !dock(), "clear progress card");
  state.delayedProgressReply();
  await pause(100);
  check(!dock(), "late progress read cannot restore a cleared card");
  ensureNoInlinePlan();
  return { passed: true, ...geometryResult, updated: expanded, immersive: state.immersiveGeometry ?? null,
    checks: "persistent / ACP / native, history, send, stream, empty clear, session and mode isolation, revision, reconnect, late read, geometry" };
};

state.previewPlanDock = async (immersive: boolean, expanded: boolean) => {
  card = structuredClone(initialCard);
  await openSession("openclaw");
  state.socket.emit({ type: "event", event: "progressCard.changed", payload: { sessionKey: keys.openclaw, revision: 18 } });
  await wait(() => dock(), "preview plan");
  if (immersive) {
    Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"] [data-chat-plan-dock]'), "preview immersive");
  }
  if ((toggle().getAttribute("aria-expanded") === "true") !== expanded) toggle().click();
  await pause(150);
  return geometry();
};
