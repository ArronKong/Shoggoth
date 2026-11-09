import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __STEERING_HISTORY__: Record<string, any>;
const state = window as any, options = new URLSearchParams(location.search);
const immersive = options.get("immersive") === "1", language = options.get("language") || "zh-CN";
const chatSurface = immersive ? '[data-testid="immersive-chat"]' : ".chat-thread";
const key = "agent:shoggoth-default:steering-preview", runId = "steering-preview-run";
const manual = options.get("manual") === "1", now = Date.now();
const sessions = [{ key, agentId: "shoggoth-default", agentName: "Shoggoth", backendId: "shoggoth", updatedAt: now,
  title: "停止后保留动态演示", model: "mimo-v2.6-pro", modelProvider: "preview", permissionMode: "full-access" }];
const seed = __STEERING_HISTORY__;
const userText = seed.user.content[0].text;
let history: any[] = sessionStorage.getItem("stopped-history") ? JSON.parse(sessionStorage.getItem("stopped-history")!) : [seed.user];
let stopped = !!sessionStorage.getItem("stopped-history"), begun = false, guided = false;
state.requests = [];
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); check(Date.now() < deadline, `Timeout: ${label}`); await pause(10); }
};
const visible = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)].filter(node => !!node.getClientRects().length);
const activityNodes = <T extends HTMLElement>(selector: string) => visible<T>(selector)
  .filter(node => node.closest(chatSurface));
const stopButton = () => visible<HTMLButtonElement>("button").find(button => button.title === i18n.t("chat.stopGenerating")
  && (!immersive || !!button.closest('[data-testid="immersive-chat"]')));
const chat = (status: string, extra: any = {}) => state.socket.emit({ type: "event", event: "chat",
  payload: { sessionKey: key, backendId: "shoggoth", runId, state: status, ...extra } });
const activity = (statusKind: string) => chat("status", { statusKind });
const emitTool = (index: number) => {
  for (const phase of ["start", "result"]) state.socket.emit({ type: "event", event: "session.tool", payload: {
    sessionKey: key, runId, data: { toolCallId: `call-${index}`, name: "web_search", phase,
      args: seed[`call${index}`].content[0].arguments, result: phase === "result" ? "Synthetic links found" : undefined,
      durationS: phase === "result" ? 1 : undefined } } });
  history.push(seed[`call${index}`], seed[`result${index}`]);
};
const emitThought = async (index: number) => {
  chat("thinking", { thinking: seed[`thought${index}`].content[0].thinking });
  history.push(seed[`thought${index}`]); await pause(30);
};
const nativeText = (message: any) => ({
  role: "assistant", content: message.content.map(({ type, text, activity, segmentId }: any) => ({ type, text, activity, segmentId })),
  timestamp: message.timestamp, shoggoth: { nativeUiVersion: 1, displayId: `native-run:${runId}`, runId },
});
const note = (index: number) => {
  const message = seed[`note${index}`];
  chat("interim", { message: nativeText(message) });
  history.push(message);
};
state.beginRun = async () => {
  if (begun || stopped) return;
  begun = true; activity("running");
  await emitThought(1); note(1); emitTool(1);
  activity("compacting"); await pause(40); activity("compacted"); history.push(seed.compact1);
  await emitThought(2); note(2);
  activity("compacting");
};
const resumeAfterGuide = async () => {
  await pause(manual ? 1300 : 80); if (stopped) return;
  activity("compacted"); history.push(seed.compact2);
  await emitThought(3); if (stopped) return;
  note(3); emitTool(2);
  chat("delta", { message: nativeText(seed.partial) });
  state.afterGuide = true;
};
class FixtureSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw); state.requests.push(request);
    if (request.method === "chat.steer") {
      guided = true; history.push({ ...seed.steer, content: request.params.message });
      setTimeout(() => {
        this.emit({ type: "res", id: request.id, ok: true, payload: { accepted: true, runId, turnId: "preview-turn" } });
        void resumeAfterGuide();
      }, 60); return;
    }
    if (request.method === "chat.abort") {
      stopped = true;
      if (state.afterGuide) history.push(seed.partial); // Service freezes an already published partial before its terminal receipt.
      sessionStorage.setItem("stopped-history", JSON.stringify(history));
      this.emit({ type: "res", id: request.id, ok: true, payload: {} });
      const partial = state.afterGuide ? seed.partial : { content: [{ type: "text", text: "" }], timestamp: Date.now() };
      setTimeout(() => chat("aborted", { message: nativeText(partial) }), 30); return;
    }
    if (stopped && request.method === "chat.history") state.stoppedHistoryReads = (state.stoppedHistoryReads || 0) + 1;
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "shoggoth-default", name: "Shoggoth", backendId: "shoggoth" }] }
      : request.method === "chat.history" ? { messages: history, hasMore: false, nextCursor: null, sourceId: key }
      : request.method === "chat.session.active" ? { run: stopped ? null : { id: runId, status: "running" } } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const route = String(url);
  const payload = route.includes("/__api/status") ? { backends: [{ id: "shoggoth", connected: true, info: { readyAgentIds: ["shoggoth-default"] } }] }
    : route.includes("/__api/backends") ? { backends: [{ id: "shoggoth", surfaces: { agentHarness: true, chat: true } }] }
    : route.includes("/__api/chat/capabilities") ? { attachments: {}, slash: false, steer: true }
    : route.includes("runtime-models") ? { selection: { bindingId: "preview", runtime: "codex", canSwitch: false, candidates: [] },
      capabilities: { attachments: {}, slash: false, steer: true }, models: [], runtimes: [] }
    : route.includes("/archive") ? { archive: { supported: true, segments: [] } } : { items: [], servers: [], groups: [], internalSessions: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
void i18n.changeLanguage(language); document.documentElement.setAttribute("data-theme", options.get("theme") || "light");
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

const inspectActivity = async (live: boolean) => {
  const selector = live ? '[data-chat-activity-preview][data-status="running"]' : `[aria-label="${i18n.t("turnLab.processOpen")}"]`;
  await wait(() => !!stopButton() === live && activityNodes(selector).length > 0, "conversation and activity entry");
  const triggers = activityNodes(selector);
  check(triggers.length === 1, `expected one activity entry, received ${triggers.length}`);
  check(!activityNodes("[data-chat-process]").length, "the thread does not duplicate the activity entry");
  triggers[0].click();
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  await wait(() => dialog()?.querySelectorAll("[data-st]").length === 7, "all seven activities in the dialog");
  const summary = dialog()!.getAttribute("aria-describedby");
  check(summary && document.getElementById(summary)?.textContent?.includes(i18n.t("turnLab.processSummary", { steps: 7, tools: 2 })),
    "summary matches the activity rows");
  const rows = <T extends HTMLElement>(selector: string) => Array.from(dialog()!.querySelectorAll<T>(selector));
  const thoughts = rows('[data-progress="1"]').map(node => node.getAttribute("title"));
  for (const index of [1, 2, 3]) check(thoughts.includes(seed[`thought${index}`].content[0].thinking), `public thought ${index} survives stop/history`);
  const tools = rows('[data-action="1"]'); check(tools.length === 2, "both completed tools survive once");
  check(!rows('[data-st="running"]').length, "stopped activity cannot keep a running row");
  const compacted = rows("[data-st]").filter(chip => chip.closest("button")?.textContent?.includes(i18n.t("chat.compactedCtx")));
  check(compacted.length === 2, "both compaction receipts remain in the card");
  // Offscreen bubbles use content-visibility: auto and can be omitted by innerText.
  const thread = document.querySelector(chatSurface)?.textContent || "";
  const bubbles = [userText, seed.note1.content[0].text, seed.note2.content[0].text,
    seed.steer.content[0].text, seed.note3.content[0].text, seed.partial.content[0].text];
  let previous = -1;
  for (const bubble of bubbles) {
    const at = thread.indexOf(bubble);
    check(at > previous && thread.indexOf(bubble, at + bubble.length) < 0, `bubble survives once in order: ${bubble}`);
    previous = at;
  }
  return { cards: triggers.length, steps: 7, thoughts: thoughts.length, tools: tools.length,
    compactions: compacted.length, bubbles: bubbles.length, immersive, width: innerWidth, language };
};
state.inspectStopped = () => inspectActivity(false);
state.runFixture = async () => {
  await wait(() => document.body.textContent?.includes(userText) && state.socket, "initial conversation");
  await pause(200); await state.beginRun(); await pause(100);
  const previews = () => activityNodes("[data-chat-activity-preview]");
  const previewBeforeGuide = previews()[0];
  check(previewBeforeGuide && previews().length === 1, "one activity preview before steering");
  const input = visible<HTMLTextAreaElement>("textarea").find(node => immersive
    ? !!node.closest('[data-testid="immersive-chat"]') : node.classList.contains("chat-composer__input"))!;
  check(input, "visible composer");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, seed.steer.content[0].text);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause(30);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  await wait(() => guided, "a running turn must steer during compaction instead of queueing the message");
  await wait(() => document.querySelector(chatSurface)?.textContent?.includes(seed.steer.content[0].text), "accepted steering bubble");
  check(!document.querySelector(".chat-toast--success"), "accepted steering appears without a success toast");
  await wait(() => state.afterGuide, "continued native activity");
  const firstNote = [...document.querySelector(chatSurface)!.querySelectorAll("p")]
    .find(node => node.textContent?.includes(seed.note1.content[0].text));
  check(previews().length === 1 && previews()[0] === previewBeforeGuide
    && firstNote && (previewBeforeGuide.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING),
  "steering updates the original activity preview above the first assistant note");
  const beforeStop = await inspectActivity(true);
  document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${i18n.t("common.close")}"]`)!.click();
  await wait(() => !document.querySelector('[role="dialog"]'), "close the details before stopping");
  check(state.requests.filter((request: any) => request.method === "chat.steer").length === 1, "one exact steering request");
  check(!state.requests.some((request: any) => request.method === "chat.send"), "steering never sends a second run");
  stopButton()?.click();
  await wait(() => state.requests.some((request: any) => request.method === "chat.abort"), "actual stop control");
  await wait(() => state.stoppedHistoryReads > 0, "terminal canonical history");
  await pause(150);
  const afterStop = await state.inspectStopped();
  check(JSON.stringify(beforeStop) === JSON.stringify(afterStop), "the activity card and its bubbles survive Stop");
  return afterStop;
};
if (manual && !stopped) state.previewReady = wait(() => document.body.textContent?.includes(userText), "preview conversation")
  .then(() => state.beginRun()).then(() => wait(() => stopButton(), "preview ready for steering"));
