import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import TurnProcess from "../../app/manage-ui/src/components/TurnTimeline/TurnProcess";
import { stepsFromParts } from "../../app/manage-ui/src/lib/turnTimeline";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const query = new URLSearchParams(location.search);
const previewMode = query.has("preview");
const backendId = query.get("backend") || "openclaw";
const immersive = query.get("immersive") === "1";
const key = "agent:fixture:main", otherKey = "agent:other:main";
const now = Date.now();
const sessions = [key, otherKey].map((key, index) => ({ key, agentId: index ? "other" : "fixture",
  backendId, agentName: index ? "另一条对话" : previewMode ? "分享会筹备助理" : "实时动态 · 隔离测试", updatedAt: now - index }));
const native = (runId?: string) => runId && backendId === "shoggoth"
  ? { shoggoth: { nativeUiVersion: 1, runId } } : {};
const message = (id: string, role: string, content: unknown, runId?: string) => ({ id, role, content, timestamp: now, ...native(runId) });
const historicalProgress = "历史阶段说明仍在聊天气泡";
const historicalReply = "已完成历史检查";
const commentaryOnly = "只有阶段说明的历史气泡";
const untimedReply = "没有时间戳的历史回复";
let history: (ReturnType<typeof message> & { idempotencyKey?: string })[] = [
  { ...message("history-user", "user", "检查历史展示"), timestamp: now - 30_000 },
  { ...message("history-process", "assistant", [
    { type: "text", text: historicalProgress, activity: true, segmentId: "history-progress" },
    { type: "thinking", thinking: "历史思考仍在实时动态" },
    { type: "toolCall", id: "history-tool", name: "exec", arguments: { command: "printf history", activityTitle: "历史工具仍可查看" } },
    { type: "toolResult", toolCallId: "history-tool", name: "exec", text: "历史工具结果" },
  ], "history-run"), timestamp: now - 24_000 },
  ...(backendId === "shoggoth" ? [{ ...message("history-steer", "user", "补充一项检查", "history-run"), timestamp: now - 18_000 }] : []),
  { ...message("history-reply", "assistant", historicalReply, "history-run"), timestamp: now - 10_000,
    ...(backendId === "shoggoth" ? { shoggoth: { nativeUiVersion: 1, runId: "history-run",
      turnTiming: { startedAt: now - 30_000, finishedAt: now - 8_000 } } } : {}) },
  message("commentary-user", "user", "检查只有说明的回合"),
  message("commentary-only", "assistant", [{ type: "text", text: commentaryOnly, activity: true, segmentId: "commentary-only" }]),
  message("u1", "user", "检查任务进展"),
];
const longReply = "上次的活动资料已归档。可以从这条回复打开完整的核对记录。";
const recoveredRun = "recovered-run";
const recoveredNote = "已核对配置，接下来继续检查。";
const recoveredTitle = "重连前已完成的检查";
const replayedTitle = "断线时正在执行的检查";
const continuedTitle = "重连后追加的检查";
if (query.has("recovered")) {
  history = [
    { ...message("recover-input", "user", "检查配置并继续核对。"), timestamp: now - 35_000 },
    { ...message("recover-process", "assistant", [
      { type: "toolCall", id: "saved", name: "exec", arguments: { activityTitle: recoveredTitle } },
      { type: "toolResult", toolCallId: "saved", name: "exec", text: "已保存的输出", durationS: 1.5 },
      { type: "toolCall", id: "replayed", name: "exec", arguments: { activityTitle: replayedTitle } },
      { type: "text", text: recoveredNote, activity: true, segmentId: "recover-note" },
    ], recoveredRun), timestamp: now - 15_000,
    ...(backendId === "openclaw" ? { __openclaw: { id: "recover-process", runId: recoveredRun } } : {}) },
  ];
}
if (previewMode) {
  const checks = Array.from({ length: 26 }, (_, index) => {
    const id = `archive-check-${index + 1}`;
    return [
      { type: "toolCall", id, name: "exec", arguments: { activityTitle: `核对资料清单第 ${index + 1} 项` } },
      { type: "toolResult", toolCallId: id, name: "exec", text: "资料齐全，已标记为通过。", durationS: 0.8 },
    ];
  }).flat();
  history = [
    { ...message("archive-request", "user", "把上次分享会的资料整理并归档。"), timestamp: now - 42_000 },
    message("archive-checks", "assistant", checks),
    message("archive-complete", "assistant", longReply),
  ];
}
const otherHistory = [
  message("other", "user", "另一条对话"),
  { id: "untimed", role: "assistant", content: [
    { type: "thinking", thinking: "历史步骤" }, { type: "text", text: untimedReply },
  ] },
];
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.error?.stack || event.message));
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
    if (frame.method === "chat.history" && scope.historyUnavailable) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "Fixture history is temporarily unavailable" } }) }), 0);
      return;
    }
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: sessions.map(s => ({ id: s.agentId, name: s.agentName, backendId })) };
    if (frame.method === "models.list") payload = { models: [] };
    if (frame.method === "chat.history") payload = { messages: frame.params.sessionKey === key ? history : otherHistory,
      hasMore: false, nextCursor: null, sourceId: frame.params.sessionKey };
    if (previewMode && frame.method === "chat.send" && frame.params.sessionKey === key) {
      const { idempotencyKey: runId, message: text } = frame.params;
      payload = { status: "started", runId };
      setTimeout(() => { void simulateReply(runId, text); }, 40);
    }
    if (previewMode && frame.method === "chat.abort" && frame.params.sessionKey === key && demoRunId) {
      const runId = demoRunId;
      demoRunId = null;
      payload = { ok: true, aborted: true };
      setTimeout(() => chat("aborted", {}, runId), 40);
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  let payload: unknown = {};
  if (url.pathname === "/__api/chat/secrets/prepare") {
    payload = { text: JSON.parse(String(init?.body)).text, references: [], version: 1 };
  }
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true, catalogRevision: "a".repeat(64), items: [], nextCursor: null } };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: [{ id: backendId, connected: true, info: { readyAgentIds: ["fixture", "other"] } }] };
  if (url.pathname === "/__api/backends") payload = { backends: [{ id: backendId, surfaces: { chat: true } }] };
  if (url.pathname === "/__api/models") payload = { models: [] };
  if (url.pathname === "/__api/group-chats") payload = { groups: [], enabled: false };
  if (url.pathname === "/__api/connectors/mcp/requests") payload = { items: [] };
  if (url.pathname.endsWith("/runtime-models")) payload = {
    selection: { bindingId: "fixture-binding", runtime: "codex", model: null, canSwitch: false, candidates: [] },
    capabilities: { attachments: {}, slash: false }, models: [], runtimes: [],
  };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false, maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId, cacheScope: `timeline-modal-fixture-${backendId}-${immersive}` };
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
const surface = () => document.querySelector(immersive ? '[data-testid="immersive-chat"]' : ".chat-thread")!;
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find(element => element.getClientRects().length && element.textContent?.includes("助理实时动态"));
const dialogSummary = () => {
  const id = dialog()?.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : undefined;
};
const dialogElapsed = () => {
  const value = dialog()?.querySelector<HTMLElement>("[data-turn-elapsed-ms]")?.dataset.turnElapsedMs;
  return value === undefined ? undefined : Number(value);
};
const checkModalAlignment = () => {
  const panel = dialog()!;
  const title = document.getElementById(panel.getAttribute("aria-labelledby")!)!;
  const close = panel.querySelector(`button[aria-label="${i18n.t("common.close")}"]`)!;
  const row = panel.querySelector("ol > li")!;
  const leadingIcon = row.querySelector("svg")!;
  const arrow = row.querySelector("button svg")!;
  const center = (element: Element) => {
    const { left, width } = element.getBoundingClientRect();
    return left + width / 2;
  };
  const leadingOffset = leadingIcon.getBoundingClientRect().left - title.getBoundingClientRect().left;
  const trailingOffset = center(arrow) - center(close);
  expect(Math.abs(leadingOffset) <= 1 && Math.abs(trailingOffset) <= 2,
    `activity icons align with the header (left ${leadingOffset}px, right ${trailingOffset}px)`);
};
const checkEdgeFade = async (viewport: HTMLElement, top: boolean, bottom: boolean) => {
  await wait(() => {
    const style = getComputedStyle(viewport);
    if (!top && !bottom) return style.maskImage === "none";
    return style.maskImage !== "none"
      && style.getPropertyValue("--fade-top").trim() === (top ? "24px" : "0px")
      && style.getPropertyValue("--fade-bottom").trim() === (bottom ? "24px" : "0px");
  }, `scroll fade (top: ${top}, bottom: ${bottom})`);
};
const activityPreviews = () => [...surface().querySelectorAll<HTMLElement>("[data-chat-activity-preview]")];
const loadingPreview = () => activityPreviews().find(preview => preview.dataset.status === "running");
const checkActivityAfterCommentary = (bubble: Element | null | undefined, commentary: string) => {
  const note = [...surface().querySelectorAll("p")]
    .find(node => !node.closest("[data-chat-activity-preview]") && node.textContent?.includes(commentary));
  expect(bubble && note && (note.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING)
    && note.getBoundingClientRect().bottom <= bubble.getBoundingClientRect().top,
  "the commentary appears above the live activity bubble");
};
const checkLivePreview = (preview: HTMLElement, commentary: string) => {
  const cards = activityPreviews();
  const bubble = preview.closest("[data-live-activity-bubble]");
  expect(cards.length === 1 && cards[0] === preview, "an interim must keep one activity bubble and its original DOM node");
  checkActivityAfterCommentary(bubble, commentary);
  expect(bubble?.contains(replyLoader()),
    "the active preview keeps one loader above its scrolling timeline");
};
const replyLoader = () => surface().querySelector(`[role="status"][aria-label="${i18n.t("chat.liveStatus.running")}"]`);
const shortcut = (text: string) => [...surface().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
  .find(button => button.getAttribute("aria-label") === i18n.t("turnLab.processOpen")
    && button.closest(".chat-group, [data-immersive-message]")?.textContent?.includes(text));
const checkFooterOrder = (button: HTMLButtonElement) => {
  const actions = [...button.parentElement!.querySelectorAll("button")];
  const copy = actions.findIndex(action => action.title === i18n.t(immersive ? "chat.copy" : "chat.copyAsMarkdown"));
  expect(copy > actions.indexOf(button), "the activity shortcut remains before copy");
  const quote = actions[copy + 1];
  expect(quote?.getAttribute("aria-label") === i18n.t("chat.quote"), "the quote shortcut follows copy");
  expect(!actions.some(action => action.title === i18n.t("chat.deleteLocal")), "completed reply actions hide delete");
  const activityStroke = getComputedStyle(button.querySelector("svg path")!);
  const copyStroke = getComputedStyle(actions[copy].querySelector("svg path")!);
  const quoteStroke = getComputedStyle(quote.querySelector("svg path")!);
  expect([activityStroke, copyStroke, quoteStroke].every(style => style.strokeWidth === "1px" && style.vectorEffect === "non-scaling-stroke"),
    "activity, copy and quote render at a fixed 1px stroke width");
};
const openLive = async (stepText: string) => {
  await wait(() => loadingPreview()?.textContent?.includes(stepText), `activity bubble: ${stepText}`);
  loadingPreview()!.click();
  await wait(dialog, "timeline modal");
};
const tool = (phase: string, id: string, extra: object = {}, runId = "run-one") => scope.fixtureSocket.emit("session.tool", {
  sessionKey: key, runId, data: { toolCallId: id, name: "exec", phase, ...extra },
});
const chat = (state: string, extra: object = {}, runId = "run-one") => scope.fixtureSocket.emit("chat", { sessionKey: key, runId, state, ...extra });
const recoveredFinal = "已完成恢复后的检查。";
scope.runRecoveredActivityFixture = async () => {
  const stopped = query.get("terminal") === "aborted";
  await wait(() => surface()?.textContent?.includes(recoveredNote), "history already contains the first part of the active turn");
  chat("accepted", { message: native(recoveredRun) }, recoveredRun);
  tool("result", "replayed", { result: "重连后收到的结果" }, recoveredRun);
  await wait(() => loadingPreview()?.textContent?.includes(replayedTitle), "the result-only replay retains the saved tool title");
  const preview = loadingPreview()!;
  checkLivePreview(preview, recoveredNote);
  expect(preview.textContent?.includes(recoveredTitle), "the bubble preserves steps received through history only");
  preview.click();
  await wait(dialog, "recovered activity dialog");
  const titles = () => Array.from(dialog()!.querySelectorAll("li button")).map(button => button.textContent ?? "");
  const checkRecovered = () => expect(titles().filter(title => title.includes(recoveredTitle)).length === 1
    && titles().filter(title => title.includes(replayedTitle)).length === 1, "the detail keeps the same history and replays each call only once");
  checkRecovered();
  tool("start", "continued", { args: { activityTitle: continuedTitle } }, recoveredRun);
  await wait(() => titles().some(title => title.includes(continuedTitle)), "the open dialog receives new live steps");
  checkRecovered();
  checkLivePreview(preview, recoveredNote);
  scope.historyUnavailable = true;
  if (stopped) chat("aborted", {}, recoveredRun);
  else chat("final", { message: message("recovered-final", "assistant", recoveredFinal, recoveredRun) }, recoveredRun);
  await wait(() => dialog()?.querySelector('[data-status="done"], [data-status="error"]') && !loadingPreview(), "terminal retires the recovered preview");
  checkRecovered();
  await close();
  const reply = stopped ? recoveredNote : recoveredFinal;
  await wait(() => shortcut(reply), "settled reply keeps an activity shortcut without a history read");
  shortcut(reply)!.click();
  await wait(dialog, "reopened recovered activity");
  checkRecovered();
  expect(titles().filter(title => title.includes(continuedTitle)).length === 1, "reopened detail keeps the final live step");
  return { backendId, immersive, terminal: stopped ? "aborted" : "final", recoveredHistory: true, keptOriginalBubble: true, sameDetails: true };
};
const close = async () => {
  dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.close")}"]`)!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(() => !dialog(), "close modal");
  expect(surface(), "closing the modal leaves the chat view open");
};

scope.runRenameRetryFixture = async () => {
  await wait(() => surface()?.textContent?.includes("检查任务进展") && scope.fixtureSocket?.onmessage, "chat ready");
  const runId = "rename-retry";
  const opening = "我会更新助理资料和身份设定。";
  const milestone = "名称已保存，正在读回核对。";
  const reply = "已改名为 Gemini。";
  const firstRetry = "重试改名第 1 次。";
  const lastRetry = "重试改名第 51 次。";
  const update = "mcp__shoggoth__agent_definition_update";
  const read = "mcp__shoggoth__agent_definition_read";
  const note = (id: string, text: string) => {
    const item = message(`event-${id}`, "assistant", [{ type: "text", activity: true, text, segmentId: id }], runId);
    history.push(item);
    chat("interim", { message: item }, runId);
  };
  const attempt = (id: string, name: string, activityTitle: string, isError: boolean) => {
    const args = { kind: "IDENTITY", activityTitle };
    const result = isError ? "缺少 newName" : "已完成";
    history.push(message(`start-${id}`, "assistant", [{ type: "toolCall", id, name, arguments: args }], runId),
      message(`result-${id}`, "toolResult", [{ type: "toolResult", toolCallId: id, name, text: result, is_error: isError }], runId));
    tool("start", id, { name, args }, runId);
    tool("result", id, { name, result, isError }, runId);
  };
  const threadHas = (text: string) => [...surface().querySelectorAll("p")]
    .some(node => !node.closest("[data-chat-activity-preview]") && node.textContent?.includes(text));
  const checkDetails = () => {
    const steps = [...dialog()!.querySelectorAll("li button")];
    expect(steps.filter(step => step.textContent?.includes("重试改名第 ")).length === 51, "all retry notes are available in activity");
    expect(!dialog()?.textContent?.includes(opening) && !dialog()?.textContent?.includes(milestone), "key notes appear only in the thread");
    expect(!threadHas(firstRetry) && !threadHas(lastRetry), "retry notes have no standalone bubble");
  };
  chat("accepted", { message: native(runId) }, runId);
  note("opening", opening);
  attempt("rename-first", update, "更新助理名称", true);
  await openLive("更新助理名称");
  note("retry-1", firstRetry);
  attempt("rename-retry-1", update, "重试更新助理名称", true);
  await wait(() => dialog()?.textContent?.includes(firstRetry), "an open dialog receives the retry note");
  expect(!threadHas(firstRetry), "a verified retry folds before the inline budget is exhausted");
  for (let i = 2; i <= 51; i += 1) {
    note(`retry-${i}`, `重试改名第 ${i} 次。`);
    attempt(`rename-retry-${i}`, update, "重试更新助理名称", i < 51);
  }
  note("milestone", milestone);
  attempt("verify", read, "读回身份设定", false);
  await wait(() => threadHas(milestone) && dialog()?.textContent?.includes(lastRetry), "live progress is split between chat and activity");
  checkDetails();
  const final = message("rename-final", "assistant", reply, runId);
  history.push(final);
  chat("final", { message: final }, runId);
  await wait(() => dialog()?.querySelector('[data-status="done"]') && !loadingPreview(), "the reply closes the live preview");
  checkDetails();
  await close();
  window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: otherKey }));
  await wait(() => threadHas(untimedReply), "left the session");
  window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
  await wait(() => shortcut(reply), "saved reply has the activity shortcut");
  expect(threadHas(opening) && threadHas(milestone) && threadHas(reply), "reloaded chat shows milestones and final reply");
  shortcut(reply)!.click();
  await wait(() => dialog()?.textContent?.includes(lastRetry), "saved retry notes are visible in activity");
  checkDetails();
  expect(scope.fixtureErrors.length === 0, `browser errors: ${scope.fixtureErrors}`);
  return { backendId, immersive, renameProgress: 53, retryNotesInActivity: 51, liveAndReloaded: true };
};

scope.runTimelineModalFixture = async () => {
  await wait(() => surface()?.textContent?.includes("检查任务进展") && scope.fixtureSocket?.onmessage, "chat ready");
  await wait(() => surface()?.textContent?.includes(historicalProgress) && surface()?.textContent?.includes(commentaryOnly), "historical progress bubbles remain");
  expect(!surface().querySelector("[data-chat-process]"), "settled replies use their footer instead of a separate activity card");
  const oldToggleTitles = ["chat.showTrajectory", "chat.hideTrajectory"].map(name => i18n.t(name));
  expect(![...document.querySelectorAll<HTMLButtonElement>("button[title]")].some(button => oldToggleTitles.includes(button.title)),
    "activity is always enabled without a composer toggle");
  const historyShortcut = shortcut(historicalReply);
  expect(historyShortcut, "historical reply can open the activity for its turn");
  expect(!shortcut(commentaryOnly) && !shortcut("检查任务进展"), "turns without visible activity have no shortcut");
  checkFooterOrder(historyShortcut!);
  historyShortcut!.focus();
  await wait(() => getComputedStyle(immersive ? historyShortcut!.parentElement! : historyShortcut!).opacity === "1",
    "keyboard focus reveals the activity icon");
  historyShortcut!.click();
  await wait(() => dialogSummary() === `2 步 · 1 工具 · ${backendId === "shoggoth" ? "22s" : "20s"}`,
    "history uses the saved Run interval or the input and reply timestamps");
  expect(dialog()?.textContent?.includes("历史工具仍可查看") && dialog()?.textContent?.includes("历史思考仍在实时动态"),
    "the historical shortcut selects its turn's tools and thinking");
  expect(!dialog()?.textContent?.includes(historicalProgress), "historical detail omits duplicate progress");
  checkModalAlignment();
  const shortTimeline = dialog()!.querySelector<HTMLElement>("[data-status]")!;
  await checkEdgeFade(shortTimeline, false, false);
  const subtitle = document.getElementById(dialog()!.getAttribute("aria-describedby")!)!;
  expect(Math.abs(shortTimeline.getBoundingClientRect().top - subtitle.getBoundingClientRect().bottom - 8) <= 1,
    "detail list uses the tighter gap beneath the summary");
  await close();

  // Cron and other non-chat callers use this shared component without filtering.
  const nonChatHost = document.createElement("div");
  document.body.append(nonChatHost);
  const nonChatRoot = createRoot(nonChatHost);
  nonChatRoot.render(<TurnProcess defaultOpen steps={stepsFromParts([
    { type: "text", text: "其他入口保留阶段说明", activity: true },
  ])} />);
  await wait(() => nonChatHost.textContent?.includes("其他入口保留阶段说明"), "shared process still renders commentary");
  nonChatRoot.unmount(); nonChatHost.remove();

  const acceptedAt = Date.now();
  chat("accepted");
  chat("delta", { message: { role: "assistant", content: "" } });
  await wait(() => replyLoader()?.querySelectorAll("circle").length === 2, "the reply starts with the two-ball loader");
  const waitingLoader = replyLoader();
  expect(!loadingPreview() && !shortcut("检查任务进展"), "there is no preview or standalone activity icon while waiting");
  chat("interim", { message: { role: "assistant", content: [
    { type: "text", text: "工具执行前的阶段说明", activity: true, segmentId: "progress-before-tools" },
  ], timestamp: Date.now(), ...native("run-one") } });
  await wait(() => surface().textContent?.includes("工具执行前的阶段说明"), "commentary-only live bubble remains");
  expect(!loadingPreview(), "commentary stays in its message, and does not start a loading preview");
  checkActivityAfterCommentary(waitingLoader?.closest("[data-live-activity-bubble]"), "工具执行前的阶段说明");
  tool("start", "first", { args: { command: "printf live-first", activityTitle: "检查第一项" } });
  await wait(() => loadingPreview()?.textContent?.includes("检查第一项"), "live activity appears in the loading bubble");
  expect(replyLoader() === waitingLoader, "the same two-ball loader stays mounted through expansion");
  expect(!shortcut("检查第一项"), "the loading bubble has no footer activity button");
  expect(!surface().querySelector("[data-chat-process]") && surface().querySelectorAll('[data-chat-activity-preview][data-status="running"]').length === 1,
    "the activity bubble is the single live activity surface in the thread");
  const trigger = loadingPreview()!;
  checkLivePreview(trigger, "工具执行前的阶段说明");
  expect(trigger.getAttribute("role") === "button" && trigger.getAttribute("aria-haspopup") === "dialog"
    && trigger.tabIndex === 0, "the preview is a focusable dialog trigger");
  trigger.querySelector("li")!.click();
  await wait(dialog, "clicking the activity inside the bubble opens the timeline modal");
  await close();
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  await wait(dialog, "keyboard opens the activity bubble");
  const firstRow = dialog()!.querySelector<HTMLLIElement>("li")!;
  firstRow.querySelector<HTMLButtonElement>("button")!.click();
  tool("update", "first", { partialResult: "打开弹窗后的实时输出" });
  await wait(() => loadingPreview()?.textContent?.includes("检查第一项"), "activity bubble still visible");
  await wait(() => dialog()?.textContent?.includes("打开弹窗后的实时输出"), "open modal receives partial tool output");
  expect(dialog()!.querySelector('[data-status="running"]'), "modal exposes running status");
  expect(firstRow === dialog()!.querySelector("li"), "updates preserve row identity and expanded details");

  chat("thinking", { thinking: "弹窗打开后追加的思考" });
  await wait(() => dialog()?.textContent?.includes("弹窗打开后追加的思考"), "thinking updates");
  chat("delta", { replyPhase: "commentary", message: { role: "assistant", content: "弹窗打开后公开" } });
  await wait(() => surface().textContent?.includes("弹窗打开后公开") && loadingPreview(), "streamed commentary keeps the live activity");
  checkLivePreview(trigger, "弹窗打开后公开");
  chat("interim", { message: { role: "assistant", content: [
    { type: "text", text: "弹窗打开后公开进展", activity: true, segmentId: "progress-one" },
  ], timestamp: Date.now(), ...native("run-one") } });
  await wait(() => surface().textContent?.includes("弹窗打开后公开进展"), "live commentary remains in chat bubbles");
  checkLivePreview(trigger, "弹窗打开后公开进展");
  expect(!dialog()?.textContent?.includes("弹窗打开后公开进展"), "live modal omits duplicate commentary");
  expect(!loadingPreview()?.textContent?.includes("弹窗打开后公开进展"), "live bubble omits duplicate commentary");
  await wait(() => dialogSummary()?.startsWith("2 步 · 1 工具 ·"), "live step count excludes commentary");
  tool("start", "second", { args: { command: "printf live-second", activityTitle: "检查第二项" } });
  await wait(() => dialog()?.textContent?.includes("检查第二项") && loadingPreview()?.textContent?.includes("检查第二项"),
    "a later tool updates the open dialog and the existing bubble");
  checkLivePreview(trigger, "弹窗打开后公开进展");
  tool("result", "first", { result: "第一项最终输出", durationS: 1.25 });
  tool("result", "second", { result: "第二项失败", isError: true, durationS: 2.5 });
  await wait(() => dialog()?.textContent?.includes("第一项最终输出") && dialog()?.querySelector('[data-st="error"]'), "tool result and failure update");
  expect(dialog()!.textContent?.includes("1.3s"), "completed duration updates");
  await wait(() => dialogSummary()?.startsWith("3 步 · 2 工具 · 1 错误 ·"), "live subtitle updates counts and errors");
  const elapsedWhileWorking = dialogElapsed()!;
  await wait(() => (dialogElapsed() ?? 0) >= elapsedWhileWorking + 800, "elapsed keeps running without a tool event");

  // Exceed the modal viewport and check that new rows scroll its own timeline.
  await Promise.all(dialog()!.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  for (let i = 0; i < 18; i++) tool("start", `extra-${i}`, { args: { command: `printf extra-${i}`, activityTitle: `后续步骤 ${i}` } });
  await wait(() => dialog()?.textContent?.includes("后续步骤 17"), "all later steps appear");
  const timeline = dialog()!.querySelector<HTMLElement>('[data-status="running"]')!;
  await wait(() => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 2, "modal follows latest step");
  expect(timeline.scrollHeight > timeline.clientHeight, "follow assertion exercises actual overflow");
  checkModalAlignment();
  await checkEdgeFade(timeline, true, false);
  timeline.scrollTop = 0;
  await checkEdgeFade(timeline, false, true);
  timeline.scrollTop = (timeline.scrollHeight - timeline.clientHeight) / 2;
  await checkEdgeFade(timeline, true, true);
  const preview = loadingPreview()!;
  const rows = preview.querySelectorAll("li");
  const rowHeight = rows[0].getBoundingClientRect().height;
  expect(rows.length > 3 && Math.abs(preview.clientHeight - rowHeight * 3) <= 1, "loading bubble has a three-row viewport");
  await wait(() => preview.scrollHeight - preview.scrollTop - preview.clientHeight < 2, "loading bubble follows the newest row");
  const bubble = preview.getBoundingClientRect();
  const row = rows[rows.length - 1];
  const leftInset = row.querySelector("svg")!.getBoundingClientRect().left - bubble.left;
  const rightInset = bubble.right - row.querySelector("[data-st]")!.getBoundingClientRect().right;
  expect(Math.abs(leftInset - rightInset) <= 3, `balanced insets (left ${leftInset}px, right ${rightInset}px)`);
  preview.scrollTop = 0;
  tool("update", "extra-0", { partialResult: "已有步骤的新输出" });
  await wait(() => preview.querySelector("li") !== null && preview.textContent?.includes(i18n.t("turnLab.updates", { count: 1 })), "preview reflects row updates");
  expect(loadingPreview() === preview && preview.scrollTop === 0, "an existing row update preserves the preview's reading position");
  tool("start", "extra-next", { args: { command: "printf newest", activityTitle: "最新追加步骤" } });
  await wait(() => preview.textContent?.includes("最新追加步骤") && preview.scrollHeight - preview.scrollTop - preview.clientHeight < 2,
    "a newly appended row scrolls the loading bubble back to the latest step");
  chat("delta", { replyPhase: "final_answer", message: { role: "assistant", content: "第一轮完成", ...native("run-one") } });
  await wait(() => surface().textContent?.includes("第一轮完成") && !activityPreviews().length, "first visible final output replaces live activity");
  expect(dialog()?.querySelector('[data-status="running"]') && !shortcut("第一轮完成"),
    "activity details remain live and the footer waits for the terminal event");
  chat("delta", { message: { role: "assistant", content: "第一轮完成。", ...native("run-one") } });
  await wait(() => surface().textContent?.includes("第一轮完成。") && !activityPreviews().length, "later unmarked deltas keep the final phase");
  history = [...history, message("settled-progress", "assistant", [
    { type: "text", text: "弹窗打开后公开进展", activity: true, segmentId: "progress-one" },
    { type: "thinking", thinking: "弹窗打开后追加的思考" },
    { type: "toolCall", id: "settled-tool", name: "exec", arguments: { activityTitle: "完成后的工具记录" } },
    { type: "toolResult", toolCallId: "settled-tool", name: "exec", text: "完成后的工具结果" },
  ], "run-one"), message("final-one", "assistant", "第一轮完成", "run-one")];
  const finishedAt = Date.now();
  chat("final", { message: { role: "assistant", content: "第一轮完成", ...native("run-one") } });
  await wait(() => dialog()?.querySelector('[data-status="done"]'), "completion while open");
  await wait(() => !loadingPreview(), "completion removes the loading preview");
  await wait(() => shortcut("第一轮完成"), "the completed reply has the activity icon in its footer");
  checkFooterOrder(shortcut("第一轮完成")!);
  const elapsedAtCompletion = dialogElapsed()!;
  expect(Math.abs(elapsedAtCompletion - (finishedAt - acceptedAt)) < 120, "elapsed covers acceptance through final completion");
  await pause(1100);
  expect(dialogElapsed() === elapsedAtCompletion, "completion freezes the elapsed timer");
  const finishedText = dialog()!.textContent;
  expect(!dialog()!.querySelector('[data-running="1"]'), "completion clears running step animations");
  expect(!dialog()!.textContent?.includes("弹窗打开后公开进展"), "completed modal continues to omit commentary");

  // Reducer step IDs restart each turn; a new run must not replace the selected one.
  tool("start", "first", { args: { command: "printf next-turn", activityTitle: "下一轮独立步骤" } }, "run-two");
  await wait(() => surface().textContent?.includes("下一轮独立步骤"), "next round appears inline");
  expect(dialog()!.textContent === finishedText, "open completed round is not replaced by the next round");
  await close(); await openLive("下一轮独立步骤");
  await wait(() => dialog()?.textContent?.includes("下一轮独立步骤"), "reopening selects the new round");
  chat("error", { errorMessage: "当前轮次失败" }, "run-two");
  await wait(() => dialog()?.querySelector('[data-status="error"]'), "run error updates modal");
  expect(dialog()!.textContent?.includes("当前轮次失败"), "run error message is visible");
  await close();

  tool("start", "third", { args: { command: "printf interrupted", activityTitle: "等待中断的步骤" } }, "run-three");
  await openLive("等待中断的步骤");
  chat("aborted", { errorMessage: "用户停止本轮" }, "run-three");
  await wait(() => dialog()?.querySelector('[data-st="aborted"]'), "abort updates modal");
  window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: otherKey }));
  await wait(() => !dialog(), "session switch closes the previous timeline");
  await wait(() => surface().textContent?.includes(untimedReply), "untimed reply is visible in the next session");
  expect(!shortcut(untimedReply), "the activity icon requires a visible timestamp");
  const untimedActivity = surface().querySelector<HTMLElement>('[data-chat-activity-preview][data-status="done"]');
  expect(untimedActivity, "history without a footer keeps a compact activity bubble");
  untimedActivity!.click();
  await wait(() => dialog()?.textContent?.includes("历史步骤"), "the compact history bubble still opens its details");
  expect(scope.fixtureErrors.length === 0, `browser errors: ${scope.fixtureErrors}`);
  return { backendId, immersive, liveUpdates: true, terminalStates: ["done", "error", "aborted"], nextTurnIsolated: true,
    sessionSwitch: true, chatCommentaryHidden: true, commentaryBubblesPreserved: true, sharedCommentaryPreserved: true,
    bubbleOpensDialog: true, continuousLoader: true, groupedFooterActions: true, loadingPreviewRows: 3, balancedInsets: true, edgeFade: true, noDuplicateCardOrToggle: true };
};
const sampleProgress = "我先核对需求和模板，再把剩下的安排整理成可执行的步骤。";
const samplePrompt = "帮我安排周五的团队分享会，给我一份可执行的议程。";
const sampleSteps = ["确认分享会目标与时长", "读取团队议程模板", "梳理分享主题和顺序",
  "分配每个环节的时间", "为提问和讨论预留缓冲", "核对议程和会前分工"];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let demoRunId: string | null = null;
const submittedRuns = new Set<string>();
async function simulateReply(runId: string, text: string) {
  if (submittedRuns.has(runId)) return;
  submittedRuns.add(runId);
  demoRunId = runId;
  history.push({ ...message(runId + "-user", "user", text), timestamp: Date.now(), idempotencyKey: runId + ":user" });
  chat("accepted", { backendId, agentId: "fixture" }, runId);
  await pause(1_050);
  if (demoRunId !== runId) return;

  const sample = /分享会|议程/.test(text);
  const steps = sample ? sampleSteps : ["梳理消息里的目标", "核对需要回答的问题",
    "整理已有信息", "拟定回复结构", "检查遗漏和约束", "整理成可执行的下一步"];
  const parts = [];
  for (const [index, activityTitle] of steps.entries()) {
    const id = `${runId}-tool-${index + 1}`;
    const args = { activityTitle };
    const durationS = [0.65, 0.55, 0.8, 0.6, 0.72, 0.52][index];
    tool("start", id, { args }, runId);
    parts.push({ type: "toolCall", id, name: "exec", arguments: args });
    await pause(durationS * 1_000);
    if (demoRunId !== runId) return;
    const output = `${activityTitle}，已完成。`;
    tool("result", id, { result: output, durationS }, runId);
    parts.push({ type: "toolResult", toolCallId: id, name: "exec", text: output, durationS });
    if (index === 1) {
      chat("delta", { replyPhase: "commentary", message: { role: "assistant", content: sampleProgress } }, runId);
      await pause(950);
      if (demoRunId !== runId) return;
      const note = { ...message(runId + "-progress", "assistant", [
        { type: "text", text: sampleProgress, activity: true, segmentId: runId + "-progress" },
      ]), timestamp: Date.now() };
      history.push(note);
      chat("interim", { message: note }, runId);
    }
  }
  const chunks = sample ? [
    "建议把周五的团队分享会安排为 **15:00–16:00**。\n\n",
    "| 时间 | 环节 |\n| --- | --- |\n| 15:00–15:05 | 主持人开场，说明目标 |\n",
    "| 15:05–15:35 | 三位同事各分享 10 分钟 |\n| 15:35–15:50 | 集中提问与讨论 |\n",
    "| 15:50–16:00 | 汇总结论，确认负责人和下一步 |\n\n",
    "**会前准备**：周四下班前收齐标题和材料，由主持人统一发议程与会议链接。",
  ] : [
    "我收到了你的消息。建议先把任务拆成三步。\n\n",
    "1. 明确需要交付的结果和截止时间。\n",
    "2. 列出已有信息，再补齐需要核对的部分。\n",
    "3. 汇总可直接执行的下一步，并给每项标注优先级。\n\n",
    "这条回复由本地预览模拟生成。",
  ];
  let content = "";
  for (const chunk of chunks) {
    await pause(260);
    if (demoRunId !== runId) return;
    content += chunk;
    chat("delta", { replyPhase: "final_answer", message: { role: "assistant", content } }, runId);
  }
  await pause(300);
  if (demoRunId !== runId) return;
  const assistant = { ...message(runId + "-reply", "assistant", [...parts, { type: "text", text: content }]), timestamp: Date.now() };
  history.push(assistant);
  demoRunId = null;
  chat("final", { message: { ...assistant, content } }, runId);
}

if (previewMode) {
  scope.previewReady = wait(() => surface()?.textContent?.includes(longReply) && scope.fixtureSocket?.onmessage, "preview ready");
  const input = () => document.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
  const sendButton = () => document.querySelector<HTMLButtonElement>('[data-send-entry="composerButton"]');
  const sendText = async (text: string) => {
    const composer = input();
    if (!composer || composer.disabled || demoRunId) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => sendButton() && !sendButton()!.disabled, "sample send button enabled");
    sendButton()!.click();
  };
  scope.previewSendSample = () => sendText(samplePrompt);
  scope.runConversationPreviewFixture = async () => {
    await scope.previewReady;
    const historyShortcut = shortcut(longReply)!;
    historyShortcut.click();
    await wait(() => dialogSummary() === "26 步 · 26 工具 · 42s", "preview seeds a scrollable detail example");
    await close();
    await scope.previewSendSample();
    await wait(() => surface().textContent?.includes(samplePrompt) && replyLoader()?.querySelectorAll("circle").length === 2,
      "sending from the actual composer shows the user bubble and two-ball loader");
    const waitingLoader = replyLoader()!;
    const bubble = waitingLoader.closest<HTMLElement>("[data-live-activity-bubble]")!;
    expect(bubble.getBoundingClientRect().width === 84, "the waiting bubble starts at its original width");
    await wait(() => loadingPreview()?.textContent?.includes(sampleSteps[0]), "mock provider sends its first activity");
    expect(replyLoader() === waitingLoader && bubble.contains(loadingPreview()!), "the same bubble and loader persist into the first activity");
    await wait(() => !bubble.getAnimations().length, "the bubble completes its expansion");
    const loaderTop = waitingLoader.querySelector("svg")!.getBoundingClientRect().top - bubble.getBoundingClientRect().top;
    expect(Math.abs(loaderTop - 14) < 0.1, "the expanded loader keeps the approved visual inset");
    const original = loadingPreview()!;
    await openLive(sampleSteps[0]);
    await wait(() => surface().textContent?.includes(sampleProgress) && loadingPreview()?.textContent?.includes(sampleSteps[2]),
      "the next tool arrives after the preview's commentary segment");
    checkLivePreview(original, sampleProgress);
    await wait(() => dialog()?.textContent?.includes(sampleSteps.at(-1)!), "an open dialog receives the remaining steps");
    await close();
    await wait(() => surface().querySelector(".chat-bubble.is-streaming")?.textContent?.includes("建议把周五"),
      "the actual message bubble streams Markdown");
    expect(!activityPreviews().length, "final streaming removes the only current activity bubble");
    const reply = "建议把周五的团队分享会安排为";
    await wait(() => shortcut(reply), "settled simulated reply shows the activity shortcut");
    checkFooterOrder(shortcut(reply)!);
    shortcut(reply)!.click();
    await wait(() => dialogSummary()?.startsWith("6 步 · 6 工具 ·") && (dialogElapsed() ?? 0) > 6000,
      "settled elapsed includes the startup, commentary and final response outside the tools");
    expect(!loadingPreview() && !replyLoader() && !surface().querySelector("[data-chat-process]"), "settled reply leaves only its footer shortcut");
    await close();
    const followUp = "请帮我拆解交付计划。";
    await sendText(followUp);
    await wait(() => surface().textContent?.includes(followUp) && replyLoader(), "a custom follow-up uses the same composer");
    await openLive("梳理消息里的目标");
    expect(!dialog()?.textContent?.includes(sampleSteps[0]), "the follow-up has its own activity");
    await close();
    const stop = document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.stopGenerating")}"]`)!;
    stop.click();
    await wait(() => !loadingPreview() && !replyLoader() && shortcut(reply), "stopping a follow-up leaves the prior reply available");
    expect(scope.fixtureErrors.length === 0, `browser errors: ${scope.fixtureErrors}`);
    return { interactivePreview: true, actualComposer: true, mockToolSteps: 6, streamingMarkdown: true, followUpAndStop: true };
  };
}

createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
