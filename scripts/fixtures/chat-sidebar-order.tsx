import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { readChatUnread } from "../../app/manage-ui/src/lib/chatUnread";
import { runPageRefresh } from "../../app/manage-ui/src/lib/page-refresh";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Production ChatPage, isolated synthetic transports and browser storage.
const state = window as any;
const options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN";
const scenario = options.get("scenario") || "mixed";
const queued = scenario.startsWith("queued-");
const steering = scenario.startsWith("steering-");
const sending = scenario.startsWith("sending-") || steering;
const betaBackend = steering || queued ? "shoggoth" : sending ? scenario.split("-")[1] : "hermes";
const immersive = scenario.endsWith("-immersive");
const now = Date.now();
const minute = 60_000;
const alpha = "order-alpha", beta = betaBackend + "-order-beta";
const mainKey = "agent:" + alpha + ":main";
const oldKey = "agent:" + alpha + ":old";
const cronKey = "agent:" + alpha + ":cron:fixture:run:1";
const betaKey = "agent:" + beta + ":main";
const internalKey = "agent:order-internal:main";
const session = (key: string, agentId: string, name: string, age: number, kind = "main") =>
  ({ key, agentId, agentName: name, backendId: agentId === beta ? betaBackend : "openclaw",
    label: key === oldKey ? "Old session" : key === mainKey ? "Latest session" : undefined,
    updatedAt: now - age * minute, kind });
const sessions = [
  session(mainKey, alpha, "Alpha", 5), session(oldKey, alpha, "Alpha", 90),
  session(cronKey, alpha, "Alpha", 0, "cron"), session(betaKey, beta, "Beta", 20),
  session(internalKey, "order-internal", "Internal member", 0),
];
if (queued) sessions.push(session(betaKey + "-other", beta, "Beta", 25));
const agents = [alpha, beta, "order-internal"].map(id => ({
  id, name: id === alpha ? "Alpha" : id === beta ? "Beta" : "Internal member",
  backendId: id === beta ? betaBackend : "openclaw",
}));
const histories = new Map(sessions.map(row => [row.key, [{
  id: row.key + ":reply", role: "assistant", content: "History for " + row.key, timestamp: row.updatedAt,
}]]));
const makeGroup = (id: string, name: string, age: number, empty = false) => ({
  ownerScope: "sidebar-order-fixture-owner",
  group: { id, name, purpose: "", status: "active", createdAt: now - (empty ? age : 120) * minute,
    // Metadata is newer than the actual message; it must not determine ranking.
    updatedAt: now, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: empty ? 0 : 1 },
  members: [
    { id: "a", backendId: "openclaw", agentId: alpha, displayName: "Alpha", handle: "a", state: "active" },
    { id: "b", backendId: "hermes", agentId: beta, displayName: "Beta", handle: "b", state: "active" },
  ],
  discussion: null, activeTurns: [], queuedMemberIds: [], tasks: [], pendingInteractions: [],
  internalSessionKeys: [internalKey],
  lastMessage: empty ? null : { id: id + ":message", groupId: id, seq: 1, threadId: "main",
    author: { kind: "user" }, body: "Last message in " + name, createdAt: now - age * minute,
    mentions: { memberIds: [], broadcast: false, unresolved: [] } },
});
// The group id intentionally equals an agent id to exercise React key isolation.
let groups = [makeGroup(alpha, "Group recent", 10), makeGroup("older", "Group older", 30),
  makeGroup("empty", "Group empty", 40, true)];
let enabled = scenario === "mixed" || scenario === "unread" || scenario === "unread-baseline", writes = 0;
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(label);
    await pause();
  }
};
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const sent: Array<{ sessionKey: string; message: string }> = [];
const steered: Array<{ sessionKey: string; message: string }> = [];
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: any; onmessage: any;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw);
    if (sending && request.method === "chat.send") {
      writes++;
      sent.push(request.params);
      // Keep the turn running without final/session.message/history refreshes.
      setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload: { status: "started" } }), 0);
      return;
    }
    if (steering && request.method === "chat.steer") {
      writes++;
      steered.push(request.params);
      setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload: {} }), 0);
      return;
    }
    if (["chat.send", "sessions.patch", "sessions.delete", "sessions.reset"].includes(request.method)) {
      writes++; throw Error("Unexpected Agent write: " + request.method);
    }
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents }
      : request.method === "chat.history" || request.method === "sessions.get"
        ? { messages: histories.get(request.params?.sessionKey || request.params?.key) || [],
          hasMore: false, nextCursor: null, sourceId: "fixture-" + (request.params?.sessionKey || request.params?.key) } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (input: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected API write: " + input); }
  const url = new URL(String(input), "http://fixture");
  let payload: unknown = {};
  if (url.pathname === "/__api/group-chats") payload = { groups, enabled };
  else if (url.pathname === "/__api/group-chats/detail") payload = groups.find(g => g.group.id === url.searchParams.get("id"));
  else if (url.pathname === "/__api/group-chats/messages") payload = { messages: [], hasMore: false };
  else if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(({ id }) => ({
    id, connected: true, info: { readyAgentIds: agents.filter(a => a.backendId === id).map(a => a.id) },
  })) };
  else if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (url.pathname === "/__api/agents") payload = { agents };
  else if (url.pathname === "/__api/chat/capabilities") payload = {
    attachments: { image: false, pdf: false, file: false }, slash: false, steer: steering,
  };
  else if (url.pathname === "/__api/chat/cache-scope") payload = {
    backendId: url.searchParams.get("backend"), cacheScope: "sidebar-order-fixture",
  };
  else if (url.pathname === "/__api/plugins/selection-readiness") payload = { version: 1, supported: false };
  else if (url.pathname.includes("/archive")) payload = { archive: { supported: true, segments: [] } };
  else if (url.pathname.includes("runtime-models")) payload = { selection: { canSwitch: false, candidates: [] },
    capabilities: { attachments: { image: false, pdf: false, file: false }, slash: false, steer: steering }, models: [], runtimes: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
localStorage.clear();
let focused = true;
if (scenario.startsWith("unread")) {
  Object.defineProperty(document, "hasFocus", { value: () => focused });
  sessions.find(s => s.key === mainKey)!.label = "A long conversation title about planning, follow-ups and scheduled reminders that must leave space for the unread badge";
  localStorage.setItem("shoggoth.chat.sessionUnread.v2", JSON.stringify({ since: now - minute, baseline: {}, read: {}, replies: {} }));
}
if (scenario === "unread-running") Object.assign(sessions.find(s => s.key === cronKey)!, { hasActiveRun: true, status: "running" });
if (scenario === "unread-baseline") {
  localStorage.removeItem("shoggoth.chat.sessionUnread.v2");
  localStorage.setItem("shoggoth.chat.readAt.v1", JSON.stringify({ [alpha]: now - 100 * minute }));
  localStorage.setItem("shoggoth.chat.sessionUnread.v1", JSON.stringify({ since: now - 120 * minute,
    baseline: { [alpha]: now - 100 * minute }, read: {},
    replies: Object.fromEntries(sessions.map(s => [s.key, s.updatedAt])) }));
  // Match the real app bootstrap, which runs before the first visit to Chat.
  readChatUnread(localStorage, now);
}
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.activity.v2", JSON.stringify(Object.fromEntries(sessions.map(s => [s.key, s.updatedAt]))));
const initialKey = scenario === "restored" ? betaKey : mainKey;
localStorage.setItem("shoggoth.chat.lastActive.v1", initialKey);
if (scenario === "restored") localStorage.setItem("shoggoth.chat.chosenSessions.v2", JSON.stringify({ [alpha]: oldKey }));
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
document.documentElement.dataset.theme = language === "en" ? "dark" : "light";
void i18n.changeLanguage(language);
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-aside__list > button"));
const names = () => rows().map(row => row.querySelector(".chat-agent__name")?.textContent);
const directOrder = ["Alpha", "Beta"];
const mixedOrder = ["Alpha", "Group recent", "Beta", "Group older", "Group empty"];
const expectOrder = (expected: string[], label: string) =>
  check(JSON.stringify(names()) === JSON.stringify(expected), label + ": " + JSON.stringify(names()));
const select = async (key: string) => {
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => document.querySelector('.session-menu button[title="' + key + '"]'), "session menu did not open");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + key + '"]')!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + key), "session history did not load");
};
createRoot(document.getElementById("root")!).render(
  <HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>,
);
state.runSidebarOrderFixture = async () => {
  if (queued) return runQueuedFixture();
  if (sending) return runSendingFixture();
  if (scenario.startsWith("events-")) return runActivityEventFixture();
  if (scenario === "unread") return runUnreadFixture();
  if (scenario === "unread-running") return runUnreadRunningFixture();
  if (scenario === "unread-baseline") return runUnreadBaselineFixture();
  const selections: { stage: string; selected: string }[] = [];
  const expectSelection = (expected: string, stage: string) => {
    const selected = rows().filter(row => row.classList.contains("is-active")).map(row => row.title);
    check(selected.length === 1 && selected[0] === expected,
      stage + " must select only " + expected + ": " + JSON.stringify(selected));
    selections.push({ stage, selected: expected });
  };
  await wait(() => rows().length === (enabled ? 5 : 2)
    && document.querySelector(".chat-thread")?.textContent?.includes("History for " + initialKey), "sidebar did not load");
  await pause(150);
  const expected = enabled ? mixedOrder : directOrder;
  expectOrder(expected, "initial message ordering");
  expectSelection(scenario === "restored" ? beta : alpha, "initial selection");
  check(document.querySelectorAll(".chat-aside__list > :not(button)").length === 0, "group/direct section headings remain");
  if (scenario === "restored") {
    rows().find(row => row.title === alpha)!.click();
    await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "latest task must override restored old session");
    expectOrder(expected, "latest task must keep agent position");
    expectSelection(alpha, "latest task overrides restored selection");
  }
  const original = rows().find(row => row.title === alpha);
  const observed: string[][] = [];
  const observer = new MutationObserver(() => observed.push(names() as string[]));
  observer.observe(document.querySelector(".chat-aside__list")!, { childList: true });
  for (const key of [oldKey, cronKey, mainKey, oldKey]) {
    await select(key); await pause(100);
    expectOrder(expected, "selecting " + key + " must keep agent position");
    expectSelection(alpha, "selecting " + key);
    check(rows().find(row => row.title === alpha) === original, "selection remounted the agent row");
  }
  observer.disconnect();
  check(observed.every(order => JSON.stringify(order) === JSON.stringify(expected)), "session switch transiently reordered rows");
  document.querySelector<HTMLButtonElement>('.chat-aside__list > button[title="' + beta + '"]')!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + betaKey), "Beta did not open");
  expectOrder(expected, "leaving selected old session");
  expectSelection(beta, "switching to another agent");
  document.querySelector<HTMLButtonElement>('.chat-aside__list > button[title="' + alpha + '"]')!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "Agent click must reopen the latest result after reading it");
  expectOrder(expected, "reopening latest result");
  expectSelection(alpha, "reopening latest result");
  if (scenario === "mixed") {
    rows().find(row => row.title === "Group recent")!.click();
    await wait(() => document.querySelector('.chat-header [class*="headerName"]')?.textContent === "Group recent", "group did not open");
    expectOrder(mixedOrder, "opening a group");
    expectSelection("Group recent", "opening a group from a direct chat");
    rows().find(row => row.title === "Group older")!.click();
    await wait(() => document.querySelector('.chat-header [class*="headerName"]')?.textContent === "Group older", "second group did not open");
    expectSelection("Group older", "switching between groups");
    rows().find(row => row.title === alpha)!.click();
    await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "latest direct result did not reopen");
    await wait(() => document.querySelector(".chat-thread")?.closest<HTMLElement>(".chat-conv")?.style.display !== "none", "direct chat remains hidden");
    expectSelection(alpha, "returning to the same direct session");
    rows().find(row => row.title === "Group recent")!.click();
    await wait(() => document.querySelector('.chat-header [class*="headerName"]')?.textContent === "Group recent", "group did not reopen");
    rows().find(row => row.title === beta)!.click();
    await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + betaKey), "other direct chat did not open");
    expectSelection(beta, "returning to another agent from a group");
    rows().find(row => row.title === alpha)!.click();
    await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "latest direct result was lost");
    groups[1].lastMessage!.createdAt = Date.now();
    state.socket.emit({ type: "event", event: "group.changed", payload: { groupId: "older" } });
    await wait(() => names()[0] === "Group older", "new group message did not move to top");
    expectOrder(["Group older", "Alpha", "Group recent", "Beta", "Group empty"], "new group message ordering");
    const message = { id: "new-beta", role: "assistant", content: "New real reply", timestamp: Date.now() };
    histories.set(betaKey, [message]);
    state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: betaKey, runId: "fixture-run",
      state: "final", message } });
    await wait(() => names()[0] === "Beta", "new direct message did not move to top");
    expectOrder(["Beta", "Group older", "Alpha", "Group recent", "Group empty"], "new direct message ordering");
    expectSelection(alpha, "incoming messages keep the current selection");
    rows().find(row => row.title === "Group recent")!.click();
    await wait(() => document.querySelector('.chat-header [class*="headerName"]')?.textContent === "Group recent", "group did not open before disabling groups");
    expectSelection("Group recent", "group selection before feature disable");
    enabled = false; await runPageRefresh("/chat");
    await wait(() => rows().length === 2, "disabled groups remain visible");
    expectOrder(["Beta", "Alpha"], "disabled group ordering");
    expectSelection(alpha, "hidden groups restore the direct selection");
    enabled = true; await runPageRefresh("/chat");
    await wait(() => rows().length === 5, "re-enabled groups did not return");
    expectOrder(["Beta", "Group older", "Alpha", "Group recent", "Group empty"], "re-enabled group ordering");
    expectSelection("Group recent", "re-enabled active group");
    rows().find(row => row.title === alpha)!.click();
    await wait(() => document.querySelector(".chat-thread")?.closest<HTMLElement>(".chat-conv")?.style.display !== "none", "direct chat did not reopen after feature enable");
    expectSelection(alpha, "returning from the re-enabled group");
    // Equal message times must remain stable across metadata/list-order refreshes.
    const tiedAt = histories.get(mainKey)![0].timestamp;
    groups[0].lastMessage!.createdAt = tiedAt;
    groups[1].lastMessage!.createdAt = tiedAt;
    await runPageRefresh("/chat"); await pause(100);
    const tiedOrder = ["Beta", "Alpha", "Group older", "Group recent", "Group empty"];
    expectOrder(tiedOrder, "equal message times");
    groups = groups.slice().reverse();
    await runPageRefresh("/chat"); await pause(100);
    expectOrder(tiedOrder, "metadata/list order must not reorder equal message times");
  }
  check(writes === 0, "sorting required a remote write");
  return { scenario, language, order: names(), selections, writes, passed: true };
};

async function runSendingFixture() {
  await wait(() => rows().length === 2 && document.querySelector(".chat-thread")?.textContent?.includes("History for " + mainKey), "sidebar did not load");
  expectOrder(directOrder, "cached activity ordering");
  rows().find(row => row.title === beta)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + betaKey), "older Agent did not open");
  expectOrder(directOrder, "opening an older Agent must not promote it");
  const input = () => Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea"))
    .find(element => element.getClientRects().length > 0 && !element.disabled);
  await wait(input, "composer missing");
  const text = "Improve the dark gummy bears";
  const sentAt = Date.now();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input()!.dispatchEvent(new Event("input", { bubbles: true }));
  const button = () => document.querySelector<HTMLButtonElement>(`[data-send-entry="${immersive ? "immersiveButton" : "composerButton"}"]`);
  await wait(() => button() && !button()!.disabled, "send button unavailable");
  button()!.click();
  await wait(() => sent.length === 1, "message not sent");
  check(sent[0].sessionKey === betaKey && sent[0].message === text, "wrong send target");
  await wait(() => names()[0] === "Beta", "a sent user message must promote its Agent before the reply completes");
  const activity = JSON.parse(localStorage.getItem("shoggoth.chat.activity.v2")!);
  check(activity[betaKey] >= sentAt, "sent activity must survive reload");
  check(document.querySelector(".chat-stop"), "regression must be verified while the turn is still running");
  check(rows().filter(row => row.classList.contains("is-active")).length === 1, "sending must keep a single selected Agent");
  if (steering) {
    state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: betaKey, state: "status", statusKind: "running" } });
    await pause(30);
    state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: mainKey,
      message: { role: "user", content: "A newer incoming message", timestamp: Date.now() } } });
    await wait(() => names()[0] === "Alpha", "new incoming message must overtake the earlier send");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), "Keep the shadows soft");
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
    await pause(30);
    check(!button(), "send action must stay hidden while the stop action is shown");
    input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(() => steered.length === 1 && names()[0] === "Beta", "accepted steering must advance activity during the same turn");
    check(steered[0].sessionKey === betaKey, "steering changed the target session");
  }
  if (!immersive) {
    rows().find(row => row.title === alpha)!.click();
    await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + (steering ? mainKey : cronKey)), "other Agent did not open");
    expectOrder(["Beta", "Alpha"], "leaving the running Agent must retain its new position");
    await select(oldKey);
    expectOrder(["Beta", "Alpha"], "selecting an old session must not change the new activity order");
  }
  check(writes === (steering ? 2 : 1), "each user action must send exactly once");
  return { scenario, language, backend: betaBackend, order: names(), writes, passed: true };
}

async function runActivityEventFixture() {
  await wait(() => rows().length === 2 && document.querySelector(".chat-thread")?.textContent?.includes("History for " + mainKey), "sidebar did not load");
  await pause(150);
  const emit = (message: unknown) => state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: betaKey, message } });
  const readActivity = () => JSON.parse(localStorage.getItem("shoggoth.chat.activity.v2")!)[betaKey];
  const before = readActivity();
  for (const message of [
    { role: "assistant", content: "HEARTBEAT_OK", timestamp: Date.now() },
    { role: "assistant", content: "Connection error", stopReason: "error", timestamp: Date.now() },
    { role: "toolResult", content: "Tool finished", timestamp: Date.now() },
    { role: "assistant", content: [{ type: "toolCall", id: "fixture", name: "read_file", arguments: {} }], timestamp: Date.now() },
    { role: "user", content: "An old replay", timestamp: now - 90 * minute },
  ]) {
    emit(message); await pause(40);
    expectOrder(directOrder, "noise or old replay must not promote an Agent");
    check(readActivity() === before, "noise or old replay advanced persisted real activity");
  }
  const timestamp = Date.now();
  emit({ role: scenario === "events-user" ? "user" : "assistant", content: "A real new message",
    timestamp: scenario === "events-string-time" ? new Date(timestamp).toISOString() : timestamp });
  await wait(() => names()[0] === "Beta", "real pushed message must advance Agent activity");
  check(readActivity() === timestamp, "pushed activity must use its original message timestamp");
  emit({ role: "user", content: "A delayed replay", timestamp: now - 90 * minute });
  await pause(40);
  check(readActivity() === timestamp, "late replay rolled activity back");
  check(rows().find(row => row.title === alpha)?.classList.contains("is-active"), "incoming activity changed the selected Agent");
  check(writes === 0, "incoming activity must not write to a backend");
  return { scenario, language, order: names(), writes, passed: true };
}

async function runUnreadFixture() {
  const stages: string[] = [];
  const badge = () => rows().find(row => row.title === alpha)?.querySelector('[role="img"]');
  const menuBadge = (key: string) => document.querySelector('.session-menu button[title="' + key + '"] [role="img"]');
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + mainKey), "main history missing");
  await wait(badge, "offline cron reply must mark even the active Agent unread");
  const trigger = document.querySelector<HTMLButtonElement>(".chat-session-select")!;
  const triggerDot = trigger.querySelector<HTMLElement>('[role="img"]')!;
  const triggerRect = trigger.getBoundingClientRect(), dotRect = triggerDot.getBoundingClientRect();
  check(dotRect.width >= 7 && dotRect.right <= triggerRect.right + 1 && dotRect.left >= triggerRect.left,
    "long selected titles must leave the unread indicator visible");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => menuBadge(cronKey), "cron session must show an unread dot");
  stages.push("offline cron: Agent + session badges");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + oldKey + '"]')!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + oldKey), "old history missing");
  check(badge(), "opening another session must preserve cron unread");
  stages.push("same Agent / different session preserves unread");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "Agent click must open unread cron");
  await wait(() => !badge(), "viewing the cron result must clear its unread dot");
  stages.push("Agent click opens exact unread session and marks only displayed reply read");
  await select(oldKey);
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey), "read Cron must remain the latest Agent target");
  check(!badge(), "reopening a read result must not restore unread");
  stages.push("Agent click returns to latest Cron even after its badge clears");
  // An active session receiving a reply while the window is unfocused stays unread.
  focused = false;
  const fresh = { id: "unfocused", role: "assistant", content: "Reminder while unfocused", timestamp: Date.now() };
  histories.set(cronKey, [fresh]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: cronKey, state: "final", message: fresh } });
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(fresh.content), "fresh reply missing");
  await wait(() => JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!).replies[cronKey] === fresh.timestamp,
    "unfocused current session must preserve its unread watermark");
  check(!badge(), "the open session must not show a dot even before read acknowledgement");
  focused = true; window.dispatchEvent(new Event("focus"));
  await wait(() => !badge(), "focusing the displayed result must mark it read");
  stages.push("open session hides its dot while unfocused; focus acknowledges the displayed result");
  location.hash = "/cron"; await pause(100);
  const offPage = { id: "off-page", role: "assistant", content: "Reminder behind the Cron page", timestamp: Date.now() };
  histories.set(cronKey, [offPage]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: cronKey, state: "final", message: offPage } });
  await wait(badge, "inactive Chat route must retain unread");
  await pause(100); check(badge(), "mounted hidden Chat page must not mark unread as read");
  location.hash = "/chat";
  await wait(() => !badge(), "returning to the displayed Chat result must mark it read");
  stages.push("hidden Chat route cannot acknowledge messages");
  await select(mainKey);
  const secondKey = "agent:" + alpha + ":00000000-0000-4000-8000-000000000002";
  const second = session(secondKey, alpha, "Alpha", 0, "cron");
  second.updatedAt = Date.now();
  const reply = { id: "second", role: "assistant", content: "Second cron reminder", timestamp: second.updatedAt };
  histories.set(secondKey, [reply]); sessions.push(second);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: secondKey, state: "final", message: { ...reply, timestamp: reply.timestamp + 60_000, shoggoth: { source: "cron" } } } });
  state.socket.emit({ type: "event", event: "sessions.changed", payload: {} });
  await wait(badge, "live native UUID cron must mark Agent unread");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => menuBadge(secondKey), "new native cron session must show unread");
  check(!menuBadge(cronKey), "reading one reminder must not be undone by a new reminder");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + mainKey + '"]')!.click();
  stages.push("live UUID cron is discovered and independently unread");
  const persisted = JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!);
  check(persisted.replies[secondKey] > (persisted.read[secondKey] || persisted.since), "live unread must persist");
  // Reading a failed/empty history cannot acknowledge an unread message.
  histories.set(secondKey, []);
  rows().find(row => row.title === alpha)!.click();
  await wait(() => localStorage.getItem("shoggoth.chat.lastActive.v1") === secondKey,
    "empty-history session must finish opening before checking its badge");
  await pause(200);
  check(!badge(), "an open session must hide its dot even while history is empty");
  const emptyRead = JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!);
  check(emptyRead.replies[secondKey] > (emptyRead.read[secondKey] || emptyRead.since), "empty history must not acknowledge an unseen reply");
  histories.set(secondKey, [reply]);
  await select(mainKey);
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(reply.content), "second result missing");
  await wait(() => !badge(), "second reply not marked read");
  stages.push("empty history preserves unread until result is visible");
  const canonicalRead = JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!);
  check(canonicalRead.read[secondKey] === reply.timestamp && canonicalRead.replies[secondKey] === reply.timestamp,
    "proxy emission timestamp must not become a permanent/future unread or read watermark");
  stages.push("proxy timestamps newer than canonical history never poison read/unread watermarks");
  rows().find(row => row.title === "Group recent")!.click();
  await wait(() => document.querySelector('.chat-header [class*="headerName"]')?.textContent === "Group recent", "group missing");
  const hiddenReply = { ...reply, id: "hidden-direct", content: "Reply behind the group view", timestamp: Date.now() };
  histories.set(secondKey, [hiddenReply]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: secondKey, state: "final", message: hiddenReply } });
  await wait(badge, "direct session hidden by a group must remain unread");
  await pause(100); check(badge(), "hidden direct history must not clear unread");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => !badge(), "returning to direct reply must mark it read");
  stages.push("group view does not acknowledge the hidden direct session");
  await select(mainKey);
  const untimed = { ...reply, id: "untimed", timestamp: Date.now(), content: "Canonical result of an untimed final" };
  histories.set(secondKey, [untimed]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: secondKey, state: "final", message: untimed.content } });
  await wait(badge, "final without timestamp must recover canonical reply");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(untimed.content), "untimed history missing");
  await wait(() => !badge(), "untimed final must not leave a permanent unread badge");
  stages.push("untimed final uses canonical timestamp and can be marked read");
  await select(mainKey);
  const pairAt = Date.now();
  for (const [key, content, at] of [[cronKey, "Earlier unread Cron", pairAt], [secondKey, "Latest unread Cron", pairAt + 1]] as const) {
    const message = { id: content, role: "assistant", content, timestamp: at };
    histories.set(key, [message]);
    state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, state: "final", message } });
  }
  await wait(badge, "two pending Cron replies must be unread");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("Latest unread Cron"), "newest unread result must open first");
  check(badge(), "earlier unread Cron must retain Agent badge after reading the latest");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("Earlier unread Cron"), "remaining unread result must open next");
  await wait(() => !badge(), "both viewed results should clear Agent badge");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("Latest unread Cron"), "no unread must return to latest result");
  stages.push("multiple Cron replies retain independent badges and newest-first navigation");
  const noiseKey = "agent:" + alpha + ":cron:heartbeat";
  const noise = session(noiseKey, alpha, "Alpha", 0, "cron"); noise.updatedAt = Date.now();
  histories.set(noiseKey, [{ id: "noise", role: "assistant", content: "HEARTBEAT_OK", timestamp: noise.updatedAt }]);
  sessions.push(noise);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: noiseKey, state: "final", message: histories.get(noiseKey)![0] } });
  state.socket.emit({ type: "event", event: "sessions.changed", payload: {} });
  await pause(350);
  check(!badge(), "heartbeat acknowledgement must not mark unread");
  stages.push("heartbeat filtering");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: "agent:" + alpha + ":cron:ghost:run:1",
    state: "final", message: { role: "assistant", content: "Unlisted result", timestamp: Date.now() } } });
  await pause(350); check(!badge(), "unlisted broadcasts must not create phantom unread");
  stages.push("uncatalogued cron broadcasts do not create phantom badges");
  const channelKey = "agent:" + alpha + ":telegram:group:fixture";
  const channel = session(channelKey, alpha, "Alpha", 0, "channel"); channel.updatedAt = Date.now();
  const channelMessage = { id: "channel", role: "user", content: "Incoming channel message", timestamp: channel.updatedAt };
  sessions.push(channel); histories.set(channelKey, [channelMessage]);
  state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: channelKey, message: channelMessage } });
  state.socket.emit({ type: "event", event: "sessions.changed", payload: {} });
  await wait(badge, "incoming channel messages must retain unread support");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(channelMessage.content), "channel history missing");
  await wait(() => !badge(), "viewing the incoming channel message must clear unread");
  stages.push("incoming channel messages retain unread support");
  check(writes === 0, "unread display must not write to an Agent");
  // Leave a fresh reminder visible for screenshot/manual inspection.
  await select(mainKey);
  const last = { ...reply, id: "last", timestamp: Date.now(), content: "Reminder ready to read" };
  histories.set(secondKey, [last]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: secondKey, state: "final", message: last } });
  await wait(badge, "final badge missing");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => menuBadge(secondKey), "final session badge missing");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + mainKey + '"]')!.click();
  // Retained immersive entry can be hidden by product policy; exercise its real handler.
  document.querySelector<HTMLButtonElement>('[data-testid="chat-immersive-enter"]')!.click();
  await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "immersive view missing");
  const immersive = document.querySelector('[data-testid="immersive-chat"]')!;
  const identity = immersive.querySelector<HTMLButtonElement>('button[class*="identity"]')!;
  check(identity.querySelector('[role="img"]'), "immersive header must show unread"); identity.click();
  await wait(() => immersive.querySelector('button[title="' + secondKey + '"] [role="img"]'), "immersive session must show unread");
  stages.push("immersive header and session badges share the same unread state");
  return { scenario, language, stages, writes, passed: true };
}

async function runUnreadRunningFixture() {
  const stages: string[] = [];
  const badge = () => rows().find(row => row.title === alpha)?.querySelector('[role="img"]');
  const stored = () => JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!);
  const emit = (key: string, status: string, message?: unknown) => state.socket.emit({ type: "event", event: "chat",
    payload: { sessionKey: key, state: status, message } });
  const change = () => state.socket.emit({ type: "event", event: "sessions.changed", payload: {} });
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + mainKey), "main history missing");
  await pause(350);
  check(!badge() && !stored().replies[cronKey], "a running session from the initial list must not publish partial history as unread");
  stages.push("initial running metadata suppresses partial history");

  const result = { id: "completed", role: "assistant", content: "Completed background result", timestamp: Date.now() };
  histories.set(cronKey, [result]);
  // Keep updatedAt unchanged: ending a run must still cause its deferred probe.
  Object.assign(sessions.find(s => s.key === cronKey)!, { hasActiveRun: false, status: "completed" }); change();
  await wait(badge, "a completed background result must produce a dot");
  check(stored().replies[cronKey] === result.timestamp, "completion must use the canonical timestamp");
  stages.push("completion without a timestamp revision triggers unread discovery");

  const repeated = { ...result, id: "completed-again", content: "Another completed result", timestamp: Date.now() };
  Object.assign(sessions.find(s => s.key === cronKey)!, { hasActiveRun: true, status: "running" }); change();
  await wait(() => !badge(), "a running list update must hide an earlier unread result");
  histories.set(cronKey, [repeated]);
  Object.assign(sessions.find(s => s.key === cronKey)!, { hasActiveRun: false, status: "completed" }); change();
  await wait(() => stored().replies[cronKey] === repeated.timestamp, "an already-probed session must be rechecked after completion without a new timestamp");
  stages.push("repeated runs invalidate the old history probe even with an unchanged list timestamp");

  state.socket.emit({ type: "event", event: "session.tool", payload: { sessionKey: cronKey,
    data: { toolCallId: "unread-tool", name: "read_file", phase: "start", args: { path: "fixture.txt" } } } });
  await wait(() => !badge(), "a new running turn must hide an existing unread dot");
  const partial = { ...result, id: "partial", content: "Intermediate progress", timestamp: Date.now() };
  emit(cronKey, "interim", partial);
  histories.set(cronKey, [partial]); change(); await pause(350);
  check(!badge() && stored().replies[cronKey] === repeated.timestamp, "streaming and history refresh cannot advance unread");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => document.querySelector('.session-menu button[title="' + cronKey + '"]'), "session menu missing");
  check(!document.querySelector('.session-menu [role="img"]'), "running sessions must stay quiet in the session picker");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + mainKey + '"]')!.click();
  stages.push("tool starts and interim replies hide cached dots and defer partial-history watermarks");

  const final = { ...result, id: "final", content: "Final background result", timestamp: Date.now() };
  histories.set(cronKey, [final]); emit(cronKey, "final", final);
  await wait(badge, "final result must restore the background notification");
  focused = false; rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(final.content), "completed result missing");
  check(!badge() && !document.querySelector('.chat-session-select [role="img"]'), "open result must hide list and header dots immediately");
  await select(mainKey);
  await wait(badge, "an unfocused view must not silently acknowledge unread content");
  focused = true; rows().find(row => row.title === alpha)!.click();
  await wait(() => stored().read[cronKey] === final.timestamp, "focused result must be acknowledged");
  stages.push("open view hides dots while preserving safe read acknowledgement");

  emit(cronKey, "delta", { role: "assistant", content: "Foreground progress" });
  const foreground = { ...final, id: "foreground", content: "Foreground final result", timestamp: Date.now() };
  histories.set(cronKey, [foreground]); emit(cronKey, "final", foreground);
  await wait(() => stored().read[cronKey] === foreground.timestamp, "foreground result was not acknowledged");
  check(!badge(), "foreground completion must remain quiet");
  await select(mainKey); check(!badge(), "leaving a read foreground result must not resurrect its dot");
  stages.push("foreground completion remains read after switching away");

  emit(cronKey, "delta", { role: "assistant", content: "Working in the background" });
  document.querySelector<HTMLButtonElement>('[data-testid="chat-immersive-enter"]')!.click();
  await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "immersive view missing");
  const identity = () => document.querySelector<HTMLButtonElement>('[data-testid="immersive-chat"] button[class*="identity"]')!;
  check(!identity().querySelector('[role="img"]'), "immersive header must hide running dots");
  const last = { ...final, id: "immersive", content: "Immersive background result", timestamp: Date.now() };
  histories.set(cronKey, [last]); emit(cronKey, "final", last);
  await wait(() => identity().querySelector('[role="img"]'), "immersive completion must show unread");
  identity().click();
  await wait(() => document.querySelector('[data-testid="immersive-chat"] button[title="' + cronKey + '"] [role="img"]'), "immersive session unread missing");
  focused = false;
  document.querySelector<HTMLButtonElement>('[data-testid="immersive-chat"] button[title="' + cronKey + '"]')!.click();
  await wait(() => !identity().querySelector('[role="img"]'), "immersive open session must immediately hide its dot");
  check(writes === 0, "unread display must never write to an Agent");
  stages.push("immersive mode shares running, completed and open-session behavior");
  return { scenario, language, stages, writes, passed: true };
}

async function runUnreadBaselineFixture() {
  const stages: string[] = [];
  const badge = () => rows().find(row => row.title === alpha)?.querySelector('[role="img"]');
  await wait(() => rows().length === 5
    && document.querySelector(".chat-thread")?.textContent?.includes("History for " + mainKey), "historical chats missing");
  await pause(200);
  check(!rows().some(row => row.querySelector('[role="img"]')), "install must not light old Agent/Cron dots");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => document.querySelector('.session-menu button[title="' + cronKey + '"]'), "old Cron entry missing");
  check(!document.querySelector('.session-menu [role="img"]'), "install must not light old session dots");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + mainKey + '"]')!.click();
  check(JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v2")!).since === now,
    "first Chat mount must retain the app-start cutoff");
  stages.push("v1 cached dots and old ordinary/Cron history stay quiet without opening each chat");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + cronKey),
    "historical latest Cron result must remain the Agent click target");
  check(!badge(), "opening historical results must keep old badges suppressed");
  await select(mainKey);
  stages.push("Agent click still opens the latest historical Cron result without a badge");

  // A late catalog revision / broadcast still cannot turn old history into new mail.
  sessions.find(s => s.key === cronKey)!.updatedAt = Date.now();
  state.socket.emit({ type: "event", event: "sessions.changed", payload: {} });
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: cronKey, state: "final",
    message: histories.get(cronKey)![0] } });
  await pause(250); check(!badge(), "late old-history discovery cannot restore a badge");
  stages.push("late scans and old result broadcasts respect the fixed cutoff");

  const fresh = { id: "after-install", role: "assistant", content: "Fresh reminder after installation", timestamp: Date.now() };
  histories.set(cronKey, [fresh]);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: cronKey, state: "final", message: fresh } });
  await wait(badge, "new Cron results must still mark Agent unread");
  await select(oldKey);
  check(badge(), "opening an old session must not clear the new reminder");
  document.querySelector<HTMLButtonElement>(".chat-session-select")!.click();
  await wait(() => document.querySelector('.session-menu button[title="' + cronKey + '"] [role="img"]'), "new reminder session dot missing");
  document.querySelector<HTMLButtonElement>('.session-menu button[title="' + oldKey + '"]')!.click();
  stages.push("new results still light Agent/session dots and remain independent of old sessions");
  rows().find(row => row.title === alpha)!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(fresh.content), "newest unread result did not open");
  await wait(() => !badge(), "viewing the new reminder must clear its badge");
  const saved = readChatUnread(localStorage, now + minute);
  check(saved.since === now && saved.read[cronKey] === fresh.timestamp, "read/cutoff state must survive reload");
  check(writes === 0, "unread migration must not write to any Agent or backend");
  stages.push("new reminder opens and clears normally; persisted cutoff/read survive reload");
  return { scenario, language, stages, writes, passed: true };
}


async function runQueuedFixture() {
  await wait(() => rows().length === 2 && state.socket, "sidebar did not load");
  const row = () => rows().find(item => item.title === beta)!;
  row().click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("History for " + betaKey), "queued session did not open");
  const emit = (key: string, runId: string, kind: string) => state.socket.emit({ type: "event", event: "chat", payload: {
    sessionKey: key, runId, state: kind === "failed" ? "error" : "status", statusKind: kind,
    ...(kind === "queued" ? { reason: "RUNTIME_HOST_CAPACITY", queuedAt: Date.now() } : {}),
    ...(kind === "failed" ? { errorCode: "RUNTIME_PERMISSION_POLICY_CONFLICT", errorMessage: "Fixture permission conflict" } : {}),
  } });
  const text = () => row().querySelector(".chat-agent__subtext")?.textContent;
  const queueLabel = i18n.t("chat.liveStatus.queued"), runningLabel = i18n.t("chat.liveStatus.running");
  emit(betaKey, "queue-one", "queued");
  await wait(() => text() === queueLabel, "queued Agent was incorrectly shown as typing");
  check(!row().querySelector('.chat-agent__subtext [aria-hidden="true"]'), "queued Agent must not animate typing");
  if (!immersive) check(document.querySelector(".chat-status--queued")?.textContent === queueLabel, "header must show the queue");
  emit(betaKey + "-other", "running-neighbor", "running");
  await wait(() => text()?.includes(runningLabel), "another running session must take precedence over a queued session");
  emit(betaKey + "-other", "running-neighbor", "failed");
  await wait(() => text() === queueLabel, "remaining queued session must not stay typing after its neighbor ends");
  emit(betaKey, "queue-one", "failed");
  await wait(() => !text()?.includes(queueLabel) && !text()?.includes(runningLabel), "failed preparation left a stale activity indicator");
  check(writes === 0, "observing queue transitions must not send or retry a message");
  // Leave the preview on the state whose label changed.
  emit(betaKey, "queue-preview", "queued");
  await wait(() => text() === queueLabel, "queue preview did not settle");
  return { scenario, language, result: "PASS", checks: ["queued label", "running sibling priority", "terminal clears activity", "no replay"], writes };
}
