import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const state = window as any, query = new URLSearchParams(location.search);
const backend = query.get("backend") || "hermes", language = query.get("language") || "zh-CN";
const owl = `${backend}-typing-owl`, reader = `${backend}-typing-reader`, scheduled = `${backend}-typing-scheduled`;
const cronKey = `agent:${owl}:cron_report`, mainKey = `agent:${owl}:main`, readerKey = `agent:${reader}:main`;
const scheduledKey = `agent:${scheduled}:cron_report`, now = Date.now();
const sessions = [
  { key: cronKey, agentId: owl, agentName: "Owl", kind: "cron", backendId: backend, updatedAt: now - 1000 },
  { key: mainKey, agentId: owl, agentName: "Owl", kind: "main", backendId: backend, updatedAt: now - 3000 },
  { key: readerKey, agentId: reader, agentName: "Reader", kind: "main", backendId: backend, updatedAt: now - 4000 },
  { key: scheduledKey, agentId: scheduled, agentName: "Scheduled", kind: "cron", backendId: backend, updatedAt: now - 5000 },
];
const history = new Map(sessions.map(row => [row.key, [
  { role: "assistant", content: `Saved report for ${row.agentName}`, timestamp: row.updatedAt },
]] as [string, any[]]));
const requests: any[] = [], checks: string[] = [];
let socket: FixtureSocket, currentRun = { id: "", key: "", status: "completed" }, rejectNext = false, aborts = 0;
const emit = (key: string, payload: any) => socket.emit({ type: "event", event: "chat", payload: {
  sessionKey: key, runId: currentRun.id || "background-run", ...payload,
} });
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any;
  constructor() { socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw); requests.push(request);
    let payload: any = {}, ok = true, error: any;
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    else if (request.method === "agents.list") payload = { agents: sessions.map(row => ({
      id: row.agentId, name: row.agentName, backendId: backend,
    })).filter((row, index, rows) => rows.findIndex(other => other.id === row.id) === index) };
    else if (request.method === "chat.history") payload = { messages: history.get(request.params.sessionKey) || [],
      hasMore: false, nextCursor: null, sourceId: `typing-${request.params.sessionKey}` };
    else if (request.method === "chat.send") {
      currentRun = { id: request.params.idempotencyKey, key: request.params.sessionKey, status: "running" };
      if (rejectNext) {
        rejectNext = false; currentRun.status = "failed"; ok = false;
        error = { code: "UNAVAILABLE", message: "Fixture send rejected", admissionAccepted: false, requestNotSent: true };
      } else {
        history.get(currentRun.key)!.push({ role: "user", content: request.params.message, timestamp: Date.now(),
          idempotencyKey: `${currentRun.id}:user` });
        payload = { status: "started", runId: currentRun.id };
      }
    } else if (request.method === "chat.steer") {
      history.get(currentRun.key)!.push({ role: "user", content: request.params.message, timestamp: Date.now() });
      payload = { accepted: true };
    } else if (request.method === "chat.operation.get") payload = { status: "found", stateAuthority: "native-service",
      admissionAccepted: true, run: { id: currentRun.id, status: currentRun.status } };
    else if (request.method === "chat.abort") {
      aborts++; currentRun.status = "canceled";
      setTimeout(() => emit(currentRun.key, { state: "aborted" }), 15);
    } else if (["sessions.delete", "sessions.reset", "sessions.patch"].includes(request.method)) {
      throw Error(`Unexpected fixture mutation: ${request.method}`);
    }
    setTimeout(() => this.emit({ type: "res", id: request.id, ok, payload, ...(error ? { error } : {}) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (input: unknown, init: RequestInit = {}) => {
  const url = new URL(String(input), location.href); let payload: any = {};
  if (url.pathname === "/__api/chat/secrets/prepare") {
    const body = JSON.parse(String(init.body)); payload = { text: body.text, references: [], version: 1 };
  } else if (init.method && init.method !== "GET") throw Error(`Unexpected fixture write: ${url.pathname}`);
  else if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(row => ({
    id: row.id, connected: true, info: { readyAgentIds: [owl, reader, scheduled] },
  })) };
  else if (url.pathname === "/__api/group-chats") payload = { groups: [], enabled: false, internalSessions: [] };
  else if (url.pathname === "/__api/connectors/mcp/requests") payload = { items: [] };
  else if (url.pathname === "/__api/models") payload = { models: [], catalogRevision: "a".repeat(64) };
  else if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, steer: true, slash: false };
  else if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: backend, cacheScope: "agent-typing-fixture" };
  else if (url.pathname === "/__api/plugins/selection-readiness") payload = { version: 1, supported: false };
  else if (url.pathname === "/__api/chat/slash") payload = { supported: false, commands: [] };
  else if (url.pathname.endsWith("/runtime-models")) payload = { selection: { canSwitch: false, candidates: [] },
    models: [], runtimes: [], capabilities: { attachments: {}, steer: true, slash: false } };
  else if (url.pathname.endsWith("/archive")) payload = { archive: { supported: true, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason?.stack || event.reason); });
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", cronKey);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
localStorage.setItem("shoggoth.chat.sessionUnread.v2", JSON.stringify({ since: now - 10000, read: {},
  replies: { [cronKey]: now - 1000, [scheduledKey]: now - 5000 } }));
void i18n.changeLanguage(language);
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timeout: ${label}`);
    await pause();
  }
};
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); checks.push(label); };
const rowFor = (agent = owl) => document.querySelector<HTMLButtonElement>(`.chat-aside__list button[title="${agent}"]`);
const typing = (agent = owl) => rowFor(agent)?.querySelector(".chat-agent__subtext > span")?.textContent === i18n.t("chat.liveStatus.running");
const stop = () => document.querySelector<HTMLButtonElement>(".chat-stop");
const select = async (key: string) => {
  window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
  await pause(150);
};
const ask = async (text: string, method = "chat.send") => {
  const previous = requests.filter(request => request.method === method).length;
  const input = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(() => requests.filter(request => request.method === method).length > previous, "user question sent");
  await pause();
};
const finish = async (text: string) => {
  currentRun.status = "completed";
  const message = { role: "assistant", content: text, timestamp: Date.now() };
  history.get(currentRun.key)!.push(message);
  emit(currentRun.key, { state: "final", message });
  await wait(() => !stop() && !typing(), "completed reply clears typing");
};
state.runAgentTypingFixture = async () => {
  await wait(() => rowFor() && rowFor(scheduled) && document.querySelector(".chat-thread")?.textContent?.includes("Saved report for Owl"), "initial Cron report");
  await pause(300);
  await ask("Please explain this report.");
  check(!!stop() && typing(), "A user question in a Cron session shows Agent typing before the first token");
  emit(cronKey, { state: "status", statusKind: "queued" });
  await pause();
  check(!!stop() && !typing(), "Queued admission keeps the existing ordinary list preview");
  emit(cronKey, { state: "status", statusKind: "running" });
  emit(cronKey, { state: "delta", message: { role: "assistant", content: "Streaming explanation, first part" } });
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("Streaming explanation"), "first streamed token");
  check(typing(), "Agent typing stays visible while the reply streams");
  emit(cronKey, { state: "prompt", prompt: { kind: "approval", requestId: "typing-approval",
    command: "read fixture report", description: "Fixture approval" } });
  await wait(() => rowFor()?.querySelector(".chat-agent__subtext")?.textContent === i18n.t("chat.liveStatus.approval"), "Cron follow-up approval");
  check(!typing(), "A user follow-up approval takes precedence over typing in a Cron session");
  emit(cronKey, { state: "promptExpire", requestId: "typing-approval" });
  emit(cronKey, { state: "status", statusKind: "running" });
  await wait(() => typing(), "typing resumes after approval expires");
  await select(mainKey);
  check(!stop() && typing(), "Switching to another session of the same Agent preserves its typing state");
  await select(readerKey);
  emit(cronKey, { state: "delta", message: { role: "assistant", content: "Streaming explanation, second part" } });
  await pause();
  check(!stop() && typing(), "Switching to another Agent preserves the original Agent typing state");
  await select(cronKey);
  check(!!stop() && typing(), "Returning to the Cron conversation restores its running composer");
  await finish("The complete explanation.");
  await wait(() => rowFor()?.querySelector(".chat-agent__subtext")?.textContent?.includes("The complete explanation."), "final message preview");
  check(!typing(), "Completion replaces Agent typing with the final message preview");
  for (const key of [cronKey, scheduledKey]) {
    emit(key, { state: "status", statusKind: "running" }); await pause();
    check(!typing() && !typing(scheduled), "An automatic background run does not inherit a previous user turn or require a normal sibling session");
    emit(key, { state: "status", statusKind: "idle" }); await pause();
  }
  currentRun = { id: "background-steered-by-user", key: cronKey, status: "running" };
  emit(cronKey, { state: "status", statusKind: "running" }); await pause();
  check(!typing(), "An automatic run stays quiet before user steering");
  await ask("Consider this detail while preparing the report.", "chat.steer");
  check(typing(), "A successful user steer promotes the current background turn to Agent typing");
  await select(readerKey);
  check(typing(), "A user-steered background turn remains visible after switching Agents");
  await select(cronKey);
  await finish("Report with the user's additional detail.");
  await ask("A question that will fail.");
  check(typing(), "A second question starts a fresh typing state");
  currentRun.status = "failed";
  emit(cronKey, { state: "error", errorMessage: "Fixture execution failed" });
  await wait(() => !stop() && !typing(), "execution error clears typing");
  check(true, "An execution error clears Agent typing");
  await ask("A question that I will stop.");
  check(typing(), "Typing is restored for another user question");
  stop()!.click();
  await wait(() => aborts === 1 && !stop() && !typing(), "Stop clears typing");
  check(true, "Stopping the reply clears Agent typing through chat.abort");
  rejectNext = true;
  await ask("A question that is rejected before execution.");
  await wait(() => !stop() && !typing(), "send rejection clears typing");
  check(true, "A rejected send leaves no typing state");
  await select(mainKey);
  await ask("An ordinary chat question.");
  check(typing(), "Ordinary chat still shows Agent typing");
  await finish("Ordinary chat completed.");
  check(requests.filter(request => request.method === "chat.send").length === 5, "Only the five explicit fixture questions were sent");
  check(requests.filter(request => request.method === "chat.steer").length === 1, "Only the explicit fixture steer was sent");
  return { backend, language, passed: true, checks, liveProvider: false };
};
