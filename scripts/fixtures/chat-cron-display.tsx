import { createChatReadStateFixture } from "./chat-read-state";
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { runPageRefresh } from "../../app/manage-ui/src/lib/page-refresh";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __PROCESS_HISTORY__: any[];
declare const __QUOTA_HISTORY__: { key: string; messages: any[] };
const state = window as any, options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN", immersive = options.get("mode") === "immersive";
const now = Date.now(), since = now - 600_000;
const cases = [
  { backendId: "hermes", agentId: "hermes-owl", name: "Owl", key: "agent:hermes-owl:cron_fixture" },
  { backendId: "openclaw", agentId: "claw-fixture", name: "OpenClaw", key: "agent:claw-fixture:main" },
  { backendId: "shoggoth", agentId: "native-fixture", name: "Native", key: "agent:native-fixture:cron-fixture" },
  { backendId: "hermes", agentId: "hermes-pages", name: "Paged", key: "agent:hermes-pages:cron_pages" },
  { backendId: "hermes", agentId: "hermes-late", name: "Late", key: "agent:hermes-late:cron_late" },
  { backendId: "hermes", agentId: "hermes-reader", name: "Reader", key: "agent:hermes-reader:main" },
  { backendId: "openclaw", agentId: "claw-legacy", name: "Legacy", key: "agent:claw-legacy:cron:legacy" },
  { backendId: "openclaw", agentId: "claw-prompt-only", name: "Scheduled", key: "agent:claw-prompt-only:cron:pending" },
  { backendId: "hermes", agentId: "hermes-background", name: "Background", key: "agent:hermes-background:main" },
  { backendId: "hermes", agentId: "hermes-quota", name: "Daily News", key: __QUOTA_HISTORY__.key },
];
const sessions = cases.map(row => ({ ...row, agentName: row.name, kind: row.key.endsWith(":main") ? "main" : "cron", updatedAt: now - 10000 }));
const histories = new Map<string, any[]>(), requests: any[] = [];
const longBody = (tag: string) => `# ${tag}_BEGIN\n\n` + Array.from({ length: 38 }, (_, i) =>
  `### 阅读段落 ${i + 1}\n\n这是隔离的长报告，用来检查未读消息是否从正文开头显示。Content remains available in full.\n\n`).join("") + `${tag}_END`;
const message = (id: string, role: string, text: string, timestamp: number, extra = {}) =>
  ({ id, role, content: [{ type: "text", text }], timestamp, ...extra });
const hermesSource = { historySource: "hermes" };
for (const row of cases.filter((_, index) => index < 3 || index === 6)) {
  const source = row.backendId === "hermes" ? hermesSource
    : row.name === "Legacy" ? {}
    : row.backendId === "openclaw" ? { __openclaw: { runId: "fixture-openclaw-cron" } }
    : { shoggoth: { source: "cron", runId: "native-cron-1", nativeUiVersion: 1 } };
  const prompt = row.backendId === "hermes" ? "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Fixture.] HIDDEN_CRON_PROMPT"
    : row.backendId === "openclaw" ? "HIDDEN_CRON_PROMPT: scheduled reminder in a shared main session" : "HIDDEN_CRON_PROMPT";
  const inputExtra = row.backendId === "openclaw"
    ? { ...source, ...(row.name === "OpenClaw" ? { __openclaw: { turnBoundary: true } } : {}),
      provenance: { kind: "internal_system", sourceTool: "cron" } } : source;
  const rows = [
    message(row.agentId + "-old", "assistant", "Previously read report", since - 1000, source),
    message(row.agentId + "-input", row.name === "OpenClaw" ? "assistant" : "user", prompt, since + 1000, inputExtra),
    { id: row.agentId + "-tool", role: "assistant", timestamp: since + 2000, ...source,
      content: [{ type: "toolCall", id: "slow-search", toolName: "web_search", arguments: { query: "fixture" } }] },
    { id: row.agentId + "-result", role: "toolResult", timestamp: since + 152000, ...source,
      toolCallId: "slow-search", toolName: "web_search", content: [{ type: "text", text: "Fixture search result" }] },
    message(row.agentId + "-reply", "assistant", longBody(row.name), since + (row.name === "Legacy" ? 153000 : 310000), source),
  ];
  if (row.backendId === "hermes") rows.push(
    message("continuation-input", "user", "[System: The previous response was cut off by a network error mid-stream. Continue exactly where you left off.]", since + 310001,
      { ...source, automation: "continuation" }),
    { id: "continued-tool", role: "assistant", timestamp: since + 315000, ...source,
      content: [{ type: "toolCall", id: "verify", toolName: "web_search", arguments: { query: "continue" } }] },
    { id: "continued-result", role: "toolResult", timestamp: since + 320000, ...source,
      toolCallId: "verify", toolName: "web_search", content: [{ type: "text", text: "Continuation result" }] },
    message("continued-reply", "assistant", "Owl_LATEST_CONTINUATION\n\nThe entire continuation remains visible.", since + 390000, source),
  );
  histories.set(row.key, rows);
}
histories.set(cases[3].key, Array.from({ length: 72 }, (_, i) => message(`paged-${i}`, "assistant",
  `PAGED_${String(i).padStart(3, "0")}\n\n` + "Unread page content. ".repeat(18), since + (i - 1) * 2000, hermesSource)));
histories.set(cases[4].key, [message("late-input", "user",
  "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Fixture.] HIDDEN_CRON_PROMPT", since + 5000, hermesSource)]);
histories.set(cases[5].key, [message("reader-old", "assistant", "Reader history", since - 1000, hermesSource)]);
histories.set(cases[7].key, [message("projected-input-only", "assistant", "HIDDEN_CRON_PROMPT: no output has arrived", since + 5000,
  { provenance: { kind: "internal_system", sourceTool: "cron" }, __openclaw: { turnBoundary: true } })]);
histories.set(cases[8].key, __PROCESS_HISTORY__);
histories.set(__QUOTA_HISTORY__.key, __QUOTA_HISTORY__.messages);
let writes = 0;
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen: any; onmessage: any;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const request = JSON.parse(raw); requests.push(request);
    if (["chat.send", "sessions.patch", "sessions.delete", "sessions.reset"].includes(request.method)) {
      writes++; throw Error("Unexpected external write");
    }
    let payload: any = {};
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    if (request.method === "agents.list") payload = { agents: cases.map(row => ({ id: row.agentId, backendId: row.backendId, name: row.name })) };
    if (request.method === "chat.history" || request.method === "sessions.get") {
      const key = request.params.sessionKey || request.params.key;
      const all = histories.get(key) || [];
      const end = request.params.cursor ? Number(request.params.cursor) : all.length;
      const begin = request.params.page ? Math.max(0, end - 25) : 0;
      payload = { messages: all.slice(begin, end), hasMore: begin > 0, nextCursor: begin > 0 ? String(begin) : null, sourceId: "fixture-" + key };
    }
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), request.params?.page ? 80 : 5);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
const readStateFixture = createChatReadStateFixture(since);
state.fetch = async (input: unknown, init: RequestInit = {}) => {
  const readState = readStateFixture(input, init);
  if (readState) return readState;
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected external write"); }
  const url = new URL(String(input), "http://fixture"); let payload: unknown = {};
  if (url.pathname === "/__api/group-chats") payload = { groups: [], enabled: false };
  else if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(({ id }) => ({
    id, connected: true, info: { readyAgentIds: cases.filter(row => row.backendId === id).map(row => row.agentId) },
  })) };
  else if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (url.pathname === "/__api/models") payload = { catalogRevision: "a".repeat(64), models: [] };
  else if (/^\/__api\/agents\/[^/]+\/models$/.test(url.pathname)) payload = { models: [], defaultModel: null };
  else if (url.pathname === "/__api/agents") payload = { agents: cases.map(row => ({ id: row.agentId, name: row.name, backendId: row.backendId })) };
  else if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false, steer: false };
  else if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: url.searchParams.get("backend"), cacheScope: "cron-display-fixture" };
  else if (url.pathname === "/__api/plugins/selection-readiness") payload = { version: 1, supported: false };
  else if (url.pathname.includes("/archive")) payload = { archive: { supported: true, segments: [] } };
  else if (url.pathname.includes("runtime-models")) payload = { selection: { canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false }, models: [], runtimes: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason?.stack || event.reason); });
localStorage.clear();
Object.defineProperty(document, "hasFocus", { value: () => true });
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", cases[5].key);
localStorage.setItem("shoggoth.chat.sessionUnread.v2", JSON.stringify({ since, read: {}, replies: {} }));
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
document.documentElement.dataset.theme = language === "en" ? "dark" : "light";
void i18n.changeLanguage(language);
const select = (key: string) => window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const thread = () => document.querySelector<HTMLElement>(immersive ? "[data-glass-clip]" : ".chat-thread")!;
const wait = async (fn: () => unknown, label: string) => {
  const end = Date.now() + 10000;
  while (!fn()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > end) throw Error(label); await pause(); }
  await frame();
};
const rowFor = (agent: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-aside__list > button")).find(row => row.title === agent);
const readState = () => JSON.parse(localStorage.getItem("shoggoth.chat.sessionUnread.v3")!);
const visibleStart = (tag: string) => {
  const heading = Array.from(thread().querySelectorAll<HTMLElement>("h1, h2, p")).find(node => node.textContent?.startsWith(tag));
  check(heading, "missing start " + tag);
  const rect = heading!.getBoundingClientRect(), bounds = thread().getBoundingClientRect();
  const dock = immersive ? null : document.querySelector(".chat-topdock")?.getBoundingClientRect();
  check(rect.top >= Math.max(bounds.top, dock?.bottom ?? 0) - 3 && rect.top < bounds.bottom - 120,
    `unread start ${tag} outside visible viewport: ${JSON.stringify({ top: rect.top, viewport: bounds.top, bottom: bounds.bottom, dock: dock?.bottom, scrollTop: thread().scrollTop })}`);
  return Math.round(rect.top);
};
state.runCronDisplayFixture = async () => {
  await wait(() => !!rowFor(cases[0].agentId) && thread()?.textContent?.includes("Reader history"), "initial view");
  await wait(() => rowFor(cases[0].agentId)?.textContent?.includes("OwlLATESTCONTINUATION"), "latest assistant preview");
  check(!rowFor(cases[4].agentId)?.textContent?.includes("IMPORTANT"), "scheduler prompt leaked into list");
  await wait(() => requests.some(request => request.method === "chat.history" && request.params.sessionKey === cases[7].key), "probe projected input-only session");
  await pause(150);
  check(!rowFor(cases[7].agentId)?.textContent?.includes("HIDDEN_CRON_PROMPT"), "projected Cron input leaked into list preview");
  check(!readState().replies[cases[7].key], "projected Cron input created a false unread reply");
  const result: any[] = [];
  for (const row of cases.filter((_, index) => index < 3 || index === 6)) {
    select(row.key);
    await wait(() => thread()?.textContent?.includes(row.name + "_END"), row.name + " full history");
    await pause(150); await frame();
    check(!thread().textContent?.includes("HIDDEN_CRON_PROMPT"), row.name + " scheduler input was rendered");
    check(!thread().textContent?.includes("previous response was cut off"), "continuation injection was rendered");
    const top = visibleStart(row.name + "_BEGIN");
    const activities = Array.from(thread().querySelectorAll<HTMLButtonElement>(
      `button[aria-haspopup="dialog"][aria-label="${i18n.t("turnLab.processOpen")}"]`));
    check(activities.length === 1, row.name + " task rendered " + activities.length + " activity shortcuts");
    check(!thread().querySelector("[data-chat-process]"), row.name + " task duplicated its activity in the message flow");
    if (!immersive) check(thread().querySelectorAll(".chat-group.is-tool").length === 0, row.name + " orphan tool result escaped process");
    if (row.backendId === "hermes") check(thread().textContent?.includes("Owl_LATEST_CONTINUATION"), "continuation output missing");
    await wait(() => readState().read[row.key] >= since + (row.name === "Legacy" ? 153000 : 310000), row.name + " read acknowledgement");
    const position = thread().scrollTop;
    await runPageRefresh("/chat"); await pause(400); await frame();
    check(Math.abs(thread().scrollTop - position) < 5, row.name + " refresh pulled the reader to the end");
    activities[0].click();
    await wait(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]:not([inert])');
      if (!dialog) return false;
      const r = dialog.getBoundingClientRect();
      return dialog.contains(document.elementFromPoint(r.left + r.width / 2, Math.max(r.top + 20, 20)));
    }, row.name + " activity dialog is visible");
    const activityDialog = document.querySelector<HTMLElement>('[role="dialog"]:not([inert])')!;
    const tool = activityDialog.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    check(tool, row.name + " activity lacks its tool"); tool!.click();
    await wait(() => activityDialog.textContent?.includes("Fixture search result"), row.name + " tool result missing from activity details");
    document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${i18n.t("common.close")}"]`)!.click();
    await wait(() => !document.querySelector('[role="dialog"]:not([inert])'), row.name + " process large view did not close");
    result.push({ backend: row.backendId, name: row.name, hiddenPrompt: true, startTop: top, activityShortcuts: activities.length,
      activityDetails: true, fullText: true, refreshStable: true });
  }
  select(cases[3].key);
  await wait(() => thread()?.textContent?.includes("PAGED_002"), "unread boundary beyond initial 50 messages");
  await pause(180); visibleStart("PAGED_002");
  check(thread().textContent?.includes("PAGED_071"), "paging lost latest replies");
  result.push({ pagedUnread: true, first: "PAGED_002", latest: "PAGED_071" });
  select(cases[5].key); await wait(() => thread()?.textContent?.includes("Reader history"), "switch away");
  histories.get(cases[4].key)!.push(message("late-reply", "assistant", "LATE_FINISHED_REPORT", now + 1000, hermesSource));
  sessions[4].updatedAt = now + 1000;
  await runPageRefresh("/chat");
  await wait(() => rowFor(cases[4].agentId)?.textContent?.includes("LATEFINISHEDREPORT"), "finished Cron did not refresh preview");
  select(cases[0].key); await wait(() => thread()?.textContent?.includes("Owl_LATEST_CONTINUATION"), "already-read reopen");
  // The cached transcript can appear before the delayed canonical response.
  // Check the landing after that response commits, as on the first open above.
  await wait(() => document.querySelector<HTMLElement>(".chat-thread")?.dataset.historyLoaded === "true",
    "already-read canonical history committed");
  await pause(180);
  check(thread().scrollHeight - thread().scrollTop - thread().clientHeight < 8, "already-read history should open at its tail");
  histories.get(cases[0].key)!.push(message("human-followup", "user", "HUMAN_FOLLOWUP: explain this Cron report", now + 2000, hermesSource));
  sessions[0].updatedAt = now + 2000; await runPageRefresh("/chat");
  await wait(() => thread().textContent?.includes("HUMAN_FOLLOWUP"), "manual follow-up hidden in a Cron session");
  select(cases[1].key);
  await wait(() => thread()?.textContent?.includes("OpenClaw_END"), "projected Cron result reopened");
  histories.get(cases[1].key)!.push(message("openclaw-human-followup", "user", "OPENCLAW_HUMAN_FOLLOWUP: explain this Cron report", now + 3000));
  sessions[1].updatedAt = now + 3000; await runPageRefresh("/chat");
  await wait(() => thread().textContent?.includes("OPENCLAW_HUMAN_FOLLOWUP"), "manual OpenClaw follow-up hidden after projected Cron input");
  const processLabel = language === "en" ? "Background command ended" : "后台命令已结束";
  const checkProcessNotice = async () => {
    await wait(() => thread()?.textContent?.includes("PROCESS_FOLLOWUP"), "background follow-up visible");
    await wait(() => thread()?.textContent?.includes(processLabel), "localized background notification");
    const notice = Array.from(thread().querySelectorAll<HTMLElement>("[title]"))
      .filter(node => node.textContent === processLabel);
    check(notice.length === 1, "one system notice, without duplicates");
    check(notice[0].title === __PROCESS_HISTORY__[1].content[0].text, "original notification is available on hover");
    check(!notice[0].closest(".is-user, .is-error"), "notification is neither a user bubble nor an error bubble");
    check((thread().textContent?.match(/IMPORTANT: Background process/g) || []).length === 1,
      "only the identical human message renders its text as a chat bubble");
    check(!thread().textContent?.includes(i18n.t("chat.modelSwitchedNotice")), "completion is not labeled as a model switch");
  };
  select(cases[8].key); await checkProcessNotice();
  await runPageRefresh("/chat"); await pause(200); await checkProcessNotice();
  select(cases[5].key); await wait(() => thread()?.textContent?.includes("Reader history"), "leave background session");
  select(cases[8].key); await checkProcessNotice();
  select(__QUOTA_HISTORY__.key);
  const quotaText = language === "en" ? "OpenRouter’s daily quota for free models is exhausted" : "OpenRouter 免费模型的当日额度已用完";
  await wait(() => thread()?.textContent?.includes(quotaText), "localized daily quota in the Cron chat");
  check(thread().textContent?.includes("HTTP 429"), "the provider status should remain visible");
  check(!thread().textContent?.includes("Your request was not processed"), "generic failure masked the cause");
  check(!thread().textContent?.includes("HIDDEN_CRON_PROMPT"), "scheduler prompt leaked into the chat");
  check(!Array.from(thread().querySelectorAll<HTMLButtonElement>("button")).some(button => button.title === i18n.t("chat.retry")),
    "a scheduled failure must not offer to resend its scheduler prompt");
  check(writes === 0, "fixture made external mutations");
  return { mode: immersive ? "immersive" : "normal", language, result, projectedInputPreviewHidden: true,
    projectedInputNoUnread: true, previewRefresh: true, manualFollowup: true, backgroundNotice: true, dailyQuota: true, writes };
};
state.cronFixture = { cases, select, requests };
