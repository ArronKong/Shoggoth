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

// The actual ChatPage, with all transports confined to synthetic records.
const state = window as any;
const alpha = { id: "capsule-shrimp", name: "虾长老", backendId: "openclaw" };
const beta = { id: "hermes-lotus", name: "莲叶", backendId: "hermes" };
const agents = [alpha, beta];
const sessions = [alpha, beta].map((agent, index) => ({ key: `agent:${agent.id}:main`,
  agentId: agent.id, agentName: agent.name, backendId: agent.backendId, updatedAt: Date.now() - index * 60_000 }));
const requests: string[] = [];
const writes: string[] = [];
const soulText = "# 我是谁\n\n我是虾长老，喜欢把复杂的事情讲清楚，也喜欢陪你把想法变成作品。\n\n## 我的工作方式\n\n- 先理解你的意图，再开始行动。\n- 认真核对细节，保留每一步有用的成果。\n- 遇到不确定的地方，坦诚说明。";
const idea = (id: string, body: string, archived = false) => ({ id, body, title: null, revision: 1,
  favorite: false, attachments: [], archivedAt: archived ? Date.now() : null, acceptedAt: null,
  createdAt: Date.now(), updatedAt: Date.now(), status: "completed", latestExecution: null });
const notes = [idea("capsule-note-1", "把清晨散步的声音，做成一张有温度的海报。"),
  idea("capsule-note-2", "给每周的复盘留一页空白，记录那些还没有答案的想法。")];
Object.assign(notes[1], { attachments: [{ id: "capsule-attachment", name: "设计参考.pdf",
  mimeType: "application/pdf", size: 256, textOffset: 0 }] });
const archived = idea("capsule-archived", "已经归档的旅行灵感。", true);
state.failCron = false;
state.longSoul = false;
state.deferSoul = false;
state.unsafeSoul = false;
state.requests = requests;
state.writes = writes;
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", sessions[0].key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
document.documentElement.dataset.theme = "light";
void i18n.changeLanguage("zh-CN");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(raw: string) {
    const request = JSON.parse(raw);
    if (["chat.send", "sessions.patch", "sessions.delete", "sessions.reset"].includes(request.method)) {
      writes.push(request.method);
      throw Error("This fixture must not mutate or send to an Agent");
    }
    const current = sessions.find(session => session.key === request.params?.sessionKey) || sessions[0];
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents }
        : request.method === "chat.history" ? { messages: [
          { id: "user", role: "user", content: "整理一下今天的想法。", timestamp: Date.now() - 60_000 },
          { id: "assistant", role: "assistant", content: `${current.agentName}：原有笔记都整理好了。点击顶部胶囊，可以查看我的资料、Cron 任务和灵感便签。`, timestamp: Date.now() },
        ] } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (!url.pathname.startsWith("/__api")) return realFetch(input, init);
  requests.push(url.pathname + url.search);
  if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url.pathname}`);
  let payload: unknown = {};
  if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(({ id }) => ({
    id, connected: true, info: { readyAgentIds: agents.filter(agent => agent.backendId === id).map(agent => agent.id) },
  })) };
  if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  if (url.pathname === "/__api/agents") payload = { agents };
  if (url.pathname.startsWith("/__api/agents/")) {
    const agent = agents.find(value => url.pathname.includes(value.id))!;
    if (url.pathname.endsWith("/file")) {
      if (url.searchParams.get("file") !== "SOUL.md") throw Error("Only SOUL should be loaded");
      if (agent.id === alpha.id && state.deferSoul) {
        state.deferSoul = false;
        await new Promise<void>(resolve => { state.releaseSoul = resolve; });
      }
      const content = state.longSoul ? Array(20).fill(soulText).join("\n\n") : soulText;
      payload = { file: { name: "SOUL.md", content: agent.id === alpha.id ? content
        + (state.unsafeSoul ? "\n\n<script>window.fixtureUnsafe = true;</script>" : "") : "", missing: agent.id === beta.id } };
    } else payload = { agent: { ...agent, files: [{ name: "SOUL.md" }] } };
  }
  if (url.pathname === "/__api/cron/jobs") {
    if (state.failCron) return new Response(JSON.stringify({ error: "Cron fixture unavailable" }), { status: 503 });
    payload = { jobs: [
      { id: "capsule-daily", backendId: alpha.backendId, agentId: alpha.id, name: "每天早上的灵感整理",
        description: "把昨晚留下的零散想法整理成一份清晰的创作清单。", enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *" }, scheduleDisplay: "每天 09:00",
        nextRunAt: Date.now() + 86_400_000, lastRunAt: Date.now() - 3_600_000, lastStatus: "ok" },
      { id: "capsule-weekly", backendId: alpha.backendId, agentId: alpha.id, name: "周末阅读回顾",
        prompt: "回顾这一周收藏的文章和灵感。", enabled: false,
        schedule: { kind: "cron", expr: "0 18 * * 0" }, scheduleDisplay: "每周日 18:00" },
      { id: "foreign-agent", backendId: alpha.backendId, agentId: "someone-else", name: "其他 Agent 的任务", enabled: true },
      { id: "foreign-backend", backendId: beta.backendId, agentId: alpha.id, name: "其他后端的同名 Agent 任务", enabled: true },
    ] };
  }
  if (url.pathname === "/__api/inspirations/agents") payload = { agents: agents.map(agent => ({ ...agent,
    backendName: agent.backendId, capabilities: { execute: true, session: true, respond: true, cancel: true, reason: null } })) };
  if (url.pathname === "/__api/inspirations") {
    const isAlpha = url.searchParams.get("agentId") === alpha.id && url.searchParams.get("backendId") === alpha.backendId;
    const isArchived = url.searchParams.get("filter") === "archived";
    const more = url.searchParams.has("cursor");
    payload = !isAlpha ? { items: [], total: 0, hasMore: false, nextCursor: null }
      : isArchived ? { items: [archived], total: 1, hasMore: false, nextCursor: null }
        : { items: more ? [notes[1]] : [notes[0]], total: 2, hasMore: !more, nextCursor: more ? null : "capsule-next" };
  }
  if (url.pathname === "/__api/inspirations/detail") payload = { idea: [...notes, archived].find(value => value.id === url.searchParams.get("id")) };
  if (url.pathname === "/__api/inspirations/executions") payload = { executions: [], total: 0, hasMore: false, nextCursor: null };
  if (url.pathname.endsWith("/artifacts")) payload = { supported: true, total: 0, items: [] };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  if (url.pathname === "/__api/chat/capabilities") payload = { slash: false, attachments: {} };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: url.searchParams.get("backend"), cacheScope: "capsule-fixture" };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 240));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const header = () => document.querySelector<HTMLElement>(".chat-header")!;
const region = () => document.getElementById("chat-agent-panel")!;
const tools = () => Array.from(header().querySelectorAll<HTMLButtonElement>(".chat-header__tools > button:not([hidden])"));
const clickPanel = (kind: string) => {
  if (kind === "profile") header().querySelector<HTMLButtonElement>(".chat-header__name")!.click();
  else tools()[kind === "cron" ? 1 : 2].click();
};
const switchAgent = async (agent: typeof alpha) => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".chat-agent"))
    .find(value => value.textContent?.includes(agent.name))!;
  row.click();
  await wait(() => header().querySelector(".chat-header__name")?.textContent === agent.name, `switch to ${agent.name}`);
};
const closePanel = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => region().getAttribute("aria-hidden") === "true", "panel closed");
  await settle();
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.prepareCapsuleShot = async (kind: string, theme = "light") => {
  document.documentElement.dataset.theme = theme;
  await switchAgent(alpha);
  await closePanel();
  clickPanel(kind);
  await wait(() => kind === "profile" ? region().textContent?.includes("我的工作方式")
    : kind === "cron" ? region().textContent?.includes("每天早上的灵感整理")
      : region().querySelector("[data-inspiration-id]"), "shot data");
  await settle();
};
state.runCapsuleFixture = async () => {
  await wait(() => header() && document.querySelector(".chat-thread .chat-bubble"), "ChatPage ready");
  check(tools().length === 3, "exactly three visible actions");
  check(tools().map(button => button.title).join("|") === [i18n.t("chat.artifactsTitle"), i18n.t("chat.agentPanelCron"), i18n.t("agents.tabInspiration")].join("|"), "artifact / Cron / Spark Notes order");
  check(!requests.some(url => /SOUL|\/__api\/cron|\/__api\/inspirations\?/.test(url)), "panels load on demand");
  await settle();
  const collapsedHeight = header().getBoundingClientRect().height;
  state.unsafeSoul = true;
  clickPanel("profile");
  await wait(() => region().textContent?.includes("我的工作方式"), "SOUL loaded");
  await wait(() => header().getBoundingClientRect().height > collapsedHeight + 100, "capsule expansion layout settled");
  check(header().getBoundingClientRect().height > collapsedHeight + 100, "the original capsule extends downward");
  check(region().querySelector(".chat-header__avatar"), "expanded profile includes avatar");
  check(!region().querySelector("script") && !state.fixtureUnsafe, "SOUL uses safe Markdown");
  state.unsafeSoul = false;
  header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!.click();
  await wait(() => region().getAttribute("aria-hidden") === "true", "avatar toggles profile closed");
  check(region().hasAttribute("inert"), "closed content is not focusable");
  await settle();
  check(Math.abs(header().getBoundingClientRect().height - collapsedHeight) < 2, "capsule returns to its original height");
  clickPanel("cron");
  await wait(() => region().querySelectorAll("a[href^='#/cron']").length === 2, "scoped Cron jobs");
  check(!region().textContent?.includes("其他"), "other Agent/backend jobs are excluded");
  check(region().textContent?.includes("下次"), "next scheduled time is shown");
  const cronRequest = new URL(requests.find(url => url.startsWith("/__api/cron/jobs?"))!, location.origin);
  check(cronRequest.searchParams.get("backend") === alpha.backendId && cronRequest.searchParams.get("agentIds") === alpha.id, "Cron request carries backend and Agent");
  clickPanel("inspiration");
  await wait(() => region().querySelector("[data-inspiration-id='capsule-note-1']"), "Agent notes loaded");
  check(!region().querySelector("a[href^='#/cron']"), "only one view is displayed");
  const loadMore = Array.from(region().querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === i18n.t("dashboard.loadMore"))!;
  loadMore.click();
  await wait(() => region().querySelectorAll("[data-inspiration-id]").length === 2, "notes pagination");
  const attachmentNote = region().querySelector<HTMLDetailsElement>("[data-inspiration-id='capsule-note-2']")!;
  attachmentNote.querySelector<HTMLElement>("summary")!.click();
  check(Array.from(attachmentNote.querySelectorAll("a")).some(link => link.textContent?.includes("设计参考.pdf")
    && link.href.includes("id=capsule-note-2")), "note attachments retain their detail link");
  attachmentNote.querySelector<HTMLElement>("summary")!.click();
  check(requests.filter(url => url.startsWith("/__api/inspirations?")).every(url => {
    const params = new URL(url, location.origin).searchParams;
    return params.get("backendId") === alpha.backendId && params.get("agentId") === alpha.id;
  }), "every notes page carries the Agent scope");
  const firstNote = region().querySelector<HTMLDetailsElement>("[data-inspiration-id='capsule-note-1']")!;
  firstNote.querySelector<HTMLElement>("summary")!.click();
  check(firstNote.open && firstNote.querySelector("[data-note-content]")?.textContent?.includes(notes[0].body), "note details expand inside the capsule");
  check(firstNote.querySelector("a")?.href.includes("id=capsule-note-1"), "the note links to its existing detail page");
  firstNote.querySelector<HTMLElement>("summary")!.click();
  check(!firstNote.open && header().dataset.agentPanel === "inspiration", "closing a note keeps the capsule expanded");
  const archiveTab = Array.from(region().querySelectorAll<HTMLButtonElement>("[role='tab']"))
    .find(button => button.textContent?.includes(i18n.t("inspiration.filters.archived")))!;
  archiveTab.click();
  await wait(() => region().querySelector("[data-inspiration-id='capsule-archived']"), "archived notes filter");
  await closePanel();
  check(document.activeElement === tools()[2], "Escape returns focus to the trigger");
  clickPanel("profile");
  await settle();
  tools()[0].click();
  await wait(() => document.querySelector(".chat-artifacts-popover"), "artifacts retained");
  check(region().getAttribute("aria-hidden") === "true", "artifacts close the expanded view");
  clickPanel("cron");
  await wait(() => !document.querySelector(".chat-artifacts-popover"), "Cron closes artifacts");
  document.querySelector(".chat-thread")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await wait(() => region().getAttribute("aria-hidden") === "true", "outside click closes the capsule");
  await settle();
  state.deferSoul = true;
  clickPanel("profile");
  await wait(() => state.releaseSoul, "delayed SOUL refresh");
  await switchAgent(beta);
  check(region().getAttribute("aria-hidden") === "true", "Agent switch closes the panel immediately");
  clickPanel("profile");
  await wait(() => region().textContent?.includes(i18n.t("chat.agentSoulEmpty")), "missing SOUL state");
  state.releaseSoul();
  await settle();
  check(!region().textContent?.includes("虾长老"), "old SOUL response cannot populate the new Agent");
  clickPanel("cron");
  await wait(() => region().textContent?.includes(i18n.t("chat.panelCronEmpty")), "empty Cron state");
  state.failCron = true;
  region().querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.refresh")}']`)!.click();
  await wait(() => region().querySelector("[role='alert']"), "Cron request failure is visible");
  state.failCron = false;
  region().querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.refresh")}']`)!.click();
  await wait(() => !region().querySelector("[role='alert']"), "Cron retry recovers");
  clickPanel("inspiration");
  await wait(() => region().textContent?.includes(i18n.t("agents.inspirationEmpty")), "empty notes state");
  await closePanel();
  await switchAgent(alpha);
  state.longSoul = true;
  clickPanel("profile");
  await wait(() => (region().querySelector(".chat-md")?.textContent?.length || 0) > 1000, "long SOUL loaded");
  await settle();
  const scrollArea = region().firstElementChild!.firstElementChild as HTMLElement;
  check(scrollArea.scrollHeight > scrollArea.clientHeight, "long profile scrolls inside the capsule");
  scrollArea.scrollTop = 100;
  check(scrollArea.scrollTop === 100, "profile scrolling is available");
  state.longSoul = false;
  region().querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.refresh")}']`)!.click();
  await wait(() => (region().querySelector(".chat-md")?.textContent?.length || 0) < 1000, "profile refreshed");
  await closePanel();
  check(writes.length === 0, "reviewing these views does not mutate or execute Agent work");
  return { passed: true, checks: "three actions, on-demand loading, capsule height, avatar/name toggles, safe SOUL, Agent/backend Cron scope, notes pagination/detail, Escape focus, artifacts, outside click, late response isolation, empty states, retry", writes: writes.length };
};
