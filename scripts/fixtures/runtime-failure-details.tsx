import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { IdeaDetail } from "../../app/manage-ui/src/pages/InspirationThread";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __ERROR_FIXTURE__: { key: string; cases: { frame: any; history: any; execution: any; activity: any; expected: Record<string, string> }[] };
const { key, cases } = __ERROR_FIXTURE__;
const state = window as any;
const query = new URLSearchParams(location.search);
const sample = cases[Number(query.get("case") || 0)];
const fromHistory = query.get("history") === "1";
const language = query.get("language") === "en" ? "en" : "zh-CN";
const user = { id: "user-1", role: "user", content: "检查这次任务失败的原因", timestamp: 100 };
const sessions = [{ key, agentId: "shoggoth-default", agentName: "Antigravity", backendId: "shoggoth", updatedAt: Date.now() }];
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage(language);
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "shoggoth-default", name: "Antigravity", backendId: "shoggoth" }] }
      : request.method === "chat.history" ? { messages: fromHistory ? [user, sample.history] : [user],
        ...(request.params?.page ? { hasMore: false, nextCursor: null, sourceId: key } : {}) } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  const payload = pathname.includes("/__api/inspirations/activity?") ? sample.activity
    : pathname.includes("/__api/inspirations/executions?") ? { executions: [sample.execution], total: 1, hasMore: false, nextCursor: null }
    : pathname.includes("/__api/inspirations/detail?") ? { idea: { id: 'error-idea', body: '想做一个实时新闻页面', title: null,
      revision: 1, favorite: false, archivedAt: null, acceptedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
      status: 'failed', paperTone: 0, latestExecution: sample.execution } }
    : /\/__api\/inspirations\/(?:agents|idle-agents)$/.test(pathname) ? { agents: [{ id: 'shoggoth-default', name: 'Shoggoth',
      backendId: 'shoggoth', backendName: 'Shoggoth', capabilities: { execute: true, session: true, respond: true, cancel: true, reason: null } }] }
    : pathname.includes("/__api/status") ? { backends: [{ id: "shoggoth", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("/__api/connectors/mcp/requests") ? { items: [] }
    : pathname.includes("runtime-models") ? { selection: { bindingId: "fixture", runtime: "antigravity", model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`${label}: ${document.body.innerText.slice(-1600)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function Fixture() {
  const [inspiration, setInspiration] = useState(false);
  state.openInspiration = () => setInspiration(true);
  return <><ChatPage />{inspiration && <IdeaDetail id="error-idea" onClose={() => setInspiration(false)} onChange={async () => {}} />}</>;
}
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><NavigationGuardProvider>
  <ScrollbarProvider /><Fixture />
</NavigationGuardProvider></UiProvider></HashRouter>);
state.runFixture = async () => {
  await wait(() => document.querySelector(".chat-thread .chat-bubble")?.textContent?.trim() === user.content, "initial history");
  await new Promise(resolve => setTimeout(resolve, 200));
  if (!fromHistory) state.socket.emit(sample.frame);
  await wait(() => document.querySelector(".chat-bubble.is-error"), "terminal error");
  const bubble = document.querySelector<HTMLElement>(".chat-bubble.is-error")!;
  if (bubble.textContent !== sample.expected[language]) throw Error(`Error details changed (${language}): ${bubble.textContent}`);
  if (document.querySelectorAll(".chat-bubble.is-error").length !== 1) throw Error("Duplicate terminal error");
  if (bubble.scrollWidth > bubble.clientWidth + 2) throw Error("Error details overflow the bubble");
  state.openInspiration();
  const inspirationError = () => document.querySelector<HTMLElement>('[data-inspiration-round] [class*="runFailureText"]');
  await wait(() => inspirationError()?.textContent === sample.expected[language], "matching inspiration error with folded trajectory");
  const error = inspirationError()!;
  const actions = error.closest('p')!.parentElement!.querySelectorAll('button');
  if (actions.length !== 1 || actions[0].textContent !== i18n.t('inspiration.thread.switchAgent')) {
    throw Error('The failed round should only offer Switch Agent');
  }
  if (error.scrollWidth > error.clientWidth + 2) throw Error("Inspiration error details overflow the card");
  if (getComputedStyle(error.querySelector('span')!).whiteSpace !== 'pre-wrap') throw Error("Inspiration error line breaks lost");
  const otherLanguage = language === "en" ? "zh-CN" : "en";
  await i18n.changeLanguage(otherLanguage);
  await wait(() => bubble.textContent === sample.expected[otherLanguage] && error.textContent === sample.expected[otherLanguage], "live language switch");
  await i18n.changeLanguage(language);
  await wait(() => bubble.textContent === sample.expected[language] && error.textContent === sample.expected[language], "restore language");
  return { fromHistory, languageSwitch: true, text: bubble.textContent, inspiration: error.textContent };
};
