import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

const scope = window as any;
const query = new URLSearchParams(location.search);
const backendId = query.get("backend") || "openclaw";
const immersive = query.get("immersive") === "1";
const key = "agent:fixture:main", otherKey = "agent:other:main";
const now = Date.now();
const sessions = [key, otherKey].map((key, index) => ({ key, agentId: index ? "other" : "fixture",
  backendId, agentName: index ? "另一条对话" : "实时动态 · 隔离测试", updatedAt: now - index }));
const message = (id: string, role: string, content: unknown) => ({ id, role, content, timestamp: now });
let history = [message("u1", "user", "检查任务进展")];
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
void i18n.changeLanguage("zh-CN");
document.documentElement.dataset.theme = query.get("theme") || "light";

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { scope.fixtureSocket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(event: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type: "event", event, payload }) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: sessions.map(s => ({ id: s.agentId, name: s.agentName, backendId })) };
    if (frame.method === "models.list") payload = { models: [] };
    if (frame.method === "chat.history") payload = { messages: frame.params.sessionKey === key ? history : [message("other", "user", "另一条对话")],
      hasMore: false, nextCursor: null, sourceId: frame.params.sessionKey };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async input => {
  const url = new URL(String(input), location.origin);
  let payload: unknown = {};
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true, catalogRevision: "a".repeat(64), items: [], nextCursor: null } };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: [{ id: backendId, connected: true, info: { readyAgentIds: ["fixture", "other"] } }] };
  if (url.pathname === "/__api/backends") payload = { backends: [{ id: backendId, surfaces: { chat: true } }] };
  if (url.pathname === "/__api/models") payload = { models: [] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false, maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId, cacheScope: "timeline-modal-fixture" };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const expect = (value: unknown, label: string) => { if (!value) throw Error(label); };
const surface = () => document.querySelector('[data-testid="immersive-chat"]') ?? document.querySelector(".chat-thread")!;
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find(element => element.getClientRects().length && element.textContent?.includes("助理实时动态"));
const zoom = async () => {
  const button = () => [...surface().querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .filter(element => element.getClientRects().length)
    .find(element => element.getAttribute("aria-label") === i18n.t("turnLab.processLargeView"));
  await wait(() => button(), "zoom button"); button()!.click();
  await wait(dialog, "timeline modal");
};
const tool = (phase: string, id: string, extra: object = {}, runId = "run-one") => scope.fixtureSocket.emit("session.tool", {
  sessionKey: key, runId, data: { toolCallId: id, name: "exec", phase, ...extra },
});
const chat = (state: string, extra: object = {}, runId = "run-one") => scope.fixtureSocket.emit("chat", { sessionKey: key, runId, state, ...extra });
const close = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !dialog(), "close modal");
};

scope.runTimelineModalFixture = async () => {
  await wait(() => surface()?.textContent?.includes("检查任务进展") && scope.fixtureSocket?.onmessage, "chat ready");
  tool("start", "first", { args: { command: "printf live-first", activityTitle: "检查第一项" } });
  await zoom();
  const firstRow = dialog()!.querySelector<HTMLLIElement>("li")!;
  firstRow.querySelector<HTMLButtonElement>("button")!.click();
  tool("update", "first", { partialResult: "打开弹窗后的实时输出" });
  await wait(() => surface().textContent?.includes("检查第一项"), "inline process still visible");
  await wait(() => dialog()?.textContent?.includes("打开弹窗后的实时输出"), "open modal receives partial tool output");
  expect(dialog()!.querySelector('[data-status="running"]'), "modal exposes running status");
  expect(firstRow === dialog()!.querySelector("li"), "updates preserve row identity and expanded details");

  chat("thinking", { thinking: "弹窗打开后追加的思考" });
  await wait(() => dialog()?.textContent?.includes("弹窗打开后追加的思考"), "thinking updates");
  chat("interim", { message: { role: "assistant", content: [
    { type: "text", text: "弹窗打开后公开进展", activity: true, segmentId: "progress-one" },
  ] } });
  await wait(() => dialog()?.textContent?.includes("弹窗打开后公开进展"), "public commentary updates");
  tool("start", "second", { args: { command: "printf live-second", activityTitle: "检查第二项" } });
  await wait(() => dialog()?.textContent?.includes("检查第二项"), "new tool appears without reopening");
  tool("result", "first", { result: "第一项最终输出", durationS: 1.25 });
  tool("result", "second", { result: "第二项失败", isError: true, durationS: 2.5 });
  await wait(() => dialog()?.textContent?.includes("第一项最终输出") && dialog()?.querySelector('[data-st="error"]'), "tool result and failure update");
  expect(dialog()!.textContent?.includes("1.3s"), "completed duration updates");

  // Exceed the modal viewport and check that new rows scroll its own timeline.
  await Promise.all(dialog()!.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  for (let i = 0; i < 18; i++) tool("start", `extra-${i}`, { args: { command: `printf extra-${i}`, activityTitle: `后续步骤 ${i}` } });
  await wait(() => dialog()?.textContent?.includes("后续步骤 17"), "all later steps appear");
  const timeline = dialog()!.querySelector<HTMLElement>('[data-status="running"]')!;
  await wait(() => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 2, "modal follows latest step");
  expect(timeline.scrollHeight > timeline.clientHeight, "follow assertion exercises actual overflow");
  history = [...history, message("final-one", "assistant", "第一轮完成")];
  chat("final", { message: { role: "assistant", content: "第一轮完成" } });
  await wait(() => dialog()?.querySelector('[data-status="done"]'), "completion while open");
  const finishedText = dialog()!.textContent;
  expect(!dialog()!.querySelector('[data-running="1"]'), "completion clears running step animations");

  // Reducer step IDs restart each turn; a new run must not replace the selected one.
  tool("start", "first", { args: { command: "printf next-turn", activityTitle: "下一轮独立步骤" } }, "run-two");
  await wait(() => surface().textContent?.includes("下一轮独立步骤"), "next round appears inline");
  expect(dialog()!.textContent === finishedText, "open completed round is not replaced by the next round");
  await close(); await zoom();
  await wait(() => dialog()?.textContent?.includes("下一轮独立步骤"), "reopening selects the new round");
  chat("error", { errorMessage: "当前轮次失败" }, "run-two");
  await wait(() => dialog()?.querySelector('[data-status="error"]'), "run error updates modal");
  expect(dialog()!.textContent?.includes("当前轮次失败"), "run error message is visible");
  await close();

  tool("start", "third", { args: { command: "printf interrupted", activityTitle: "等待中断的步骤" } }, "run-three");
  await zoom();
  chat("aborted", { errorMessage: "用户停止本轮" }, "run-three");
  await wait(() => dialog()?.querySelector('[data-st="aborted"]'), "abort updates modal");
  window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: otherKey }));
  await wait(() => !dialog(), "session switch closes the previous timeline");
  expect(scope.fixtureErrors.length === 0, `browser errors: ${scope.fixtureErrors}`);
  return { backendId, immersive, liveUpdates: true, terminalStates: ["done", "error", "aborted"], nextTurnIsolated: true, sessionSwitch: true };
};
scope.previewTimelineModal = async () => {
  await wait(() => surface()?.textContent?.includes("检查任务进展"), "preview ready");
  tool("start", "preview", { args: { command: "printf preview", activityTitle: "读取项目配置" } });
  await zoom();
  let count = 0;
  scope.previewTimer = setInterval(() => {
    count++;
    tool("result", count === 1 ? "preview" : `preview-${count - 1}`, { result: `检查 ${count} 完成`, durationS: 0.8 });
    tool("start", `preview-${count}`, { args: { command: `printf check-${count}`, activityTitle: `继续检查项目文件 ${count}` } });
    if (count === 8) {
      clearInterval(scope.previewTimer);
      tool("result", `preview-${count}`, { result: "全部检查完成", durationS: 0.8 });
      chat("final", { message: { role: "assistant", content: "检查完成" } });
    }
  }, 1800);
};

createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
