import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const state = window as any, query = new URLSearchParams(location.search);
const language = query.get("language") || "zh-CN", now = Date.now();
const live = [
  { id: "main", name: "Current OpenClaw", backendId: "openclaw" },
  { id: "hermes-test", name: "Current Hermes", backendId: "hermes" },
  { id: "shoggoth-test", name: "Current Shoggoth", backendId: "shoggoth" },
];
const ghost = { id: "qa-agent-913", name: "Qa-agent-913", backendId: "openclaw" };
const keyOf = (id: string) => `agent:${id}:main`;
const sessions = [...live, ghost].map(row => ({ key: keyOf(row.id), agentId: row.id, agentName: row.name,
  backendId: row.backendId, updatedAt: now, lastMessagePreview: "Retained history" }));
const retainedSessions = JSON.stringify(sessions);
let mode = "hold", roster = live, rosterReads = 0, writes = 0;
let held: (() => void)[] = [];
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected write " + url); }
  const pathname = String(url);
  let payload: unknown = {};
  if (pathname.includes("/__api/status")) payload = { backends: live.map(row => ({ id: row.backendId, connected: true,
    info: { readyAgentIds: [row.id] } })) };
  else if (pathname.includes("/__api/group-chats")) payload = { groups: [], enabled: false };
  else if (pathname.includes("/__api/backends")) payload = { backends: [] };
  else if (pathname.includes("/archive")) payload = { archive: { supported: true, segments: [] } };
  else if (pathname.includes("runtime-models")) payload = { selection: { canSwitch: false, candidates: [] }, capabilities: {}, models: [], runtimes: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any; onclose: any;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    if (["chat.send", "sessions.delete", "sessions.reset", "agents.delete"].includes(request.method)) { writes++; throw Error("Unexpected mutation"); }
    let payload: unknown = {}, ok = true;
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    if (request.method === "chat.history") payload = { messages: [{ role: "user", content: "Retained history: QA_PDF_TOKEN_913", timestamp: now }] };
    if (request.method === "agents.list") {
      rosterReads++;
      payload = mode === "partial" ? { agents: live.slice(1), degradedBackends: ["openclaw"] }
        : mode === "malformed" ? {} : { agents: [...roster] };
      ok = mode !== "failure";
    }
    const reply = () => this.emit({ type: "res", id: request.id, ok, payload, ...(!ok && { error: { message: "Roster temporarily unavailable" } }) });
    if (request.method === "agents.list" && mode === "hold") held.push(reply);
    else setTimeout(reply, request.method === "sessions.list" && mode === "roster-first" ? 60 : 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", keyOf(ghost.id));
void i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", language === "en" ? "dark" : "light");
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const wait = async (check: () => unknown, label: string) => {
  const deadline = Date.now() + 6000;
  while (!check()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > deadline) throw Error(label); await pause(); }
};
const ids = () => [...document.querySelectorAll<HTMLButtonElement>(".chat-aside__list button[title]")].map(row => row.title).sort();
const sameIds = (expected: string[]) => JSON.stringify(ids()) === JSON.stringify([...expected].sort());
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); results.push(label); };
const results: string[] = [];
const refresh = async (nextMode: string) => {
  mode = nextMode;
  const before = rosterReads;
  state.socket.emit({ type: "event", event: "agents.changed", payload: {} });
  await wait(() => rosterReads > before, "refresh did not read roster");
  await pause(); await pause();
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.runRosterFixture = async () => {
  await wait(() => held.length && document.querySelector(".chat-thread")?.textContent?.includes("QA_PDF_TOKEN_913"), "cached history must load before roster");
  check(sameIds([...live, ghost].map(row => row.id)), "Unknown roster preserves cached entries");
  mode = "full"; held.splice(0).forEach(reply => reply());
  await wait(() => sameIds(live.map(row => row.id)), "confirmed roster must hide Qa-agent-913");
  check(true, "Confirmed roster removes ghost from Agent list");
  check(!!document.querySelector(".chat-thread")?.textContent?.includes("QA_PDF_TOKEN_913"), "Removed Agent history remains readable");
  check(document.querySelector(".chat-aside__head")?.textContent?.includes("3"), "Agent count is three current members");
  await refresh("failure"); check(sameIds(live.map(row => row.id)), "Failed roster read preserves known members");
  await refresh("malformed"); check(sameIds(live.map(row => row.id)), "Malformed roster is not an empty roster");
  await refresh("partial"); check(sameIds(live.map(row => row.id)), "Partial backend outage preserves members without resurrecting ghost");
  roster = live.slice(1); await refresh("full");
  await wait(() => sameIds(roster.map(row => row.id)), "removed current Agent still visible");
  check(true, "Confirmed removal updates Agent list");
  // The old request has a full roster; a newer complete response wins even when
  // the older reply arrives last (the same ordering as reconnect/refresh races).
  roster = live; await refresh("hold");
  roster = []; await refresh("full");
  await wait(() => ids().length === 0, "authoritative empty roster should hide all entries");
  held.splice(0).forEach(reply => reply()); await pause(); await pause();
  check(ids().length === 0, "Delayed old roster cannot undo a newer empty roster");
  roster = live; await refresh("roster-first");
  await wait(() => sameIds(live.map(row => row.id)), "recovery should restore current members");
  check(true, "Recovery works when roster arrives before sessions");
  check(JSON.stringify(sessions) === retainedSessions, "Canonical session fixture unchanged");
  check(JSON.parse(localStorage.getItem("shoggoth.chat.sessions.v1") || "[]").some((row: any) => row.key === keyOf(ghost.id)), "Old session remains in history cache");
  check(writes === 0, "Zero Agent/session mutations or model sends");
  return { language, passed: true, checks: results, currentAgents: ids(), rosterReads, writes };
};
document.getElementById("run")!.onclick = async () => {
  const output = document.getElementById("result")!;
  try { output.textContent = JSON.stringify(await state.runRosterFixture(), null, 2); }
  catch (error) { output.textContent = String(error); }
};
