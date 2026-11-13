import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { MESSAGE_PINNING_ENABLED } from "../../app/manage-ui/src/pages/ChatMessageActions";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// The real ChatPage, CSS and Markdown pipeline, with in-memory transport only.
// Never connect to a user's gateway or send a provider request.
const state = window as any;
const shortKey = "agent:short:short";
const longKey = "agent:perf:long";
const shortHistory = [{ id: "short", role: "assistant", content: "Short conversation" }];
const fence = "```";
declare const __CHAT_PERF_WITH_TOOLS__: boolean;
// Exceed the shared Markdown LRU (200 entries): ordinary controls must not
// reparse a settled transcript when another message evicts its cached HTML.
const historyCount = 220;
const longHistory = Array.from({ length: historyCount }, (_, index) => ({
  id: `history-${index}`,
  role: index % 28 === 0 ? "user" : "assistant",
  timestamp: 1_700_000_000_000 + index * 120_000,
  content: [...(__CHAT_PERF_WITH_TOOLS__ && index % 28 !== 0 ? Array.from({ length: 4 }, (_, step) => ({
    type: "toolCall", name: "read", arguments: {
      path: `/fixture/message-${index}/step-${step}.json`,
      items: Array.from({ length: 100 }, (_, item) => ({ id: item, title: `Fixture item ${item}`, selected: item % 2 === 0 })),
    },
  })) : []), { type: "text", text: index === historyCount - 1 ? "Latest reply" :
    `## Message ${index}\n\n` + Array.from({ length: 8 }, (_, line) =>
      `Paragraph ${line}: **rendering** a long conversation with [safe links](https://example.com), lists and code.\n\n` +
      `- Read the history\n- Keep the scroll position\n\n${fence}js\nconst item${line} = { index: ${index}, value: "a long code sample" };\n${fence}\n`).join("\n") }],
}));
const sessions = [shortKey, longKey].map((key) => ({ key, backendId: "openclaw", agentId: key.split(":")[1], agentName: key === shortKey ? "Short chat" : "Long chat (220 messages)", updatedAt: 1_700_000_000_000 }));
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", shortKey);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
localStorage.setItem("shoggoth.chat.pinned." + longKey, JSON.stringify(["history-29"]));

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    let payload: unknown = {};
    if (request.method === "chat.send") {
      state.sent = request.params;
      payload = { runId: "fixture-run" };
    }
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    if (request.method === "agents.list") payload = { agents: sessions.map((row) => ({ id: row.agentId, name: row.agentName, backendId: row.backendId })) };
    if (request.method === "chat.history") {
      const messages = request.params.sessionKey === longKey ? longHistory : shortHistory;
      const end = request.params.cursor ? Number(request.params.cursor) : messages.length;
      const start = request.params.page ? Math.max(0, end - Math.min(request.params.limit ?? 100, 100)) : 0;
      payload = { messages: messages.slice(start, end), hasMore: start > 0,
        nextCursor: start > 0 ? String(start) : null, sourceId: `fixture:${request.params.sessionKey}` };
    }
    setTimeout(() => {
      if (request.method === "chat.history" && request.params.page && !request.params.cursor) {
        state.tailHistoryResponses = (state.tailHistoryResponses || 0) + 1;
      }
      this.emit({ type: "res", id: request.id, ok: true, payload });
    }, 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.includes("/__api/chat/secrets/prepare")) {
    const body = JSON.parse(String(init?.body));
    if (typeof body.text !== "string" || typeof body.sessionKey !== "string" || typeof body.operationId !== "string") throw Error("invalid ordinary-input preparation fixture");
    return new Response(JSON.stringify({ text: body.text, references: [], version: 1 }), { headers: { "Content-Type": "application/json" } });
  }
  const payload = pathname.includes("/__api/group-chats") ? { groups: [], enabled: true, internalSessions: [] }
    : pathname.includes("/__api/connectors/mcp/requests") ? { items: [] }
    : pathname.includes("/__api/status") ? { backends: [{ id: "openclaw", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: pathname.includes("%3Along") ? [{
      sealedAt: 1_600_000_000_000, fromReset: true,
      messages: [{ id: "archived", role: state.archiveAtTop ? "user" : "assistant", content: "An earlier archived reply\n\n".repeat(200) }],
    }] : [] } }
    : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason?.stack || event.reason); });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
};
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const thread = () => document.querySelector<HTMLDivElement>(".chat-thread")!;
const browseEarlier = () => thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
const bubbles = () => document.querySelectorAll<HTMLElement>(".chat-thread .chat-bubble:not(.is-activity-loading)");
const entries: any[] = [];
for (const type of ["longtask", "long-animation-frame"]) {
  if (PerformanceObserver.supportedEntryTypes.includes(type)) {
    new PerformanceObserver((list) => entries.push(...list.getEntries().map((entry) => entry.toJSON()))).observe({ type });
  }
}

createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.runScrollNavigationFixture = async () => {
  await wait(() => bubbles().length === 1, "short history before navigation");
  const gap = () => thread().scrollHeight - thread().scrollTop - thread().clientHeight;
  const openLong = async () => {
    const responses = state.tailHistoryResponses || 0;
    document.querySelector<HTMLButtonElement>('.chat-agent[title="perf"]')!.click();
    await wait(() => state.tailHistoryResponses > responses && bubbles().length === 50, "long history navigation");
    await wait(() => gap() < 2, "long history navigation reaches latest message");
    await pause(150);
    check(gap() < 2, `long history navigation drifted by ${gap()}px`);
  };
  await openLong();
  // Opening the selected Agent replaces its history too, even though its key
  // is unchanged. It must use the same landing as a cross-Agent navigation.
  await openLong();
  const reopenedGap = gap();

  // These older bubbles still have estimated content-visibility heights. A
  // smooth scroll to their old scrollHeight stops short as they are laid out.
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
  thread().scrollTop = 800;
  await frame(); await frame(); await pause(100);
  await wait(() => !!document.querySelector(".chat-jump"), "latest-message control above the tail");
  document.querySelector<HTMLButtonElement>(".chat-jump")!.click();
  await wait(() => gap() < 2, "one latest-message click reaches the tail");
  await pause(150);
  check(gap() < 2, `latest-message landing drifted by ${gap()}px`);
  const jumpedGap = gap();

  // An intentional upward scroll owns the viewport, including during the
  // layout-settling frames immediately after an explicit latest-message jump.
  thread().scrollTop -= 2000;
  thread().dispatchEvent(new Event("scroll"));
  await wait(() => !!document.querySelector(".chat-jump"), "latest-message control for cancellation");
  document.querySelector<HTMLButtonElement>(".chat-jump")!.click();
  thread().dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
  thread().scrollTop -= 200;
  await pause(150);
  check(gap() >= 150, "a latest-message jump must yield to the user's upward scroll");

  const composer = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Fixture navigation send");
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click();
  await wait(() => state.sent?.message === "Fixture navigation send", "navigation fixture send");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "delta",
    message: { role: "assistant", content: "A growing reply.\n\n".repeat(160) } } });
  await wait(() => thread().textContent?.includes("A growing reply."), "navigation fixture stream");
  // A locally running turn restores its live snapshot instead of committing
  // canonical history. Navigation must not wait for that suppressed commit.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) {
      state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "prompt",
        prompt: { kind: "clarify", requestId: "navigation-question", question: "Continue the fixture?", choices: ["Continue", "Stop"] } } });
      await wait(() => document.querySelector(".chat-prompt"), "running session waits for input");
    }
    browseEarlier();
    thread().scrollTop = 800;
    await frame(); await frame();
    check(gap() > 1000, "live transcript starts above the latest reply");
    const responses = state.tailHistoryResponses || 0;
    document.querySelector<HTMLButtonElement>('.chat-agent[title="perf"]')!.click();
    await wait(() => state.tailHistoryResponses > responses, "live reselect history response");
    await wait(() => gap() < 2, "reselecting a running session reaches its latest reply");
    await pause(150);
    check(gap() < 2, "live reselect remains at the latest reply");
    check(thread().textContent?.includes("Fixture navigation send") && thread().textContent?.includes("A growing reply."),
      "live reselect preserves the local user message and streamed reply");
    if (attempt > 0) check(thread().querySelector(".chat-prompt"), "reselect preserves the pending input card");
  }
  document.querySelector<HTMLButtonElement>('.chat-agent[title="short"]')!.click();
  await wait(() => bubbles().length === 1, "switch away from a running session");
  document.querySelector<HTMLButtonElement>('.chat-agent[title="perf"]')!.click();
  await wait(() => thread().textContent?.includes("Fixture navigation send") && gap() < 2,
    "returning to a running session reaches its latest reply without a canonical commit");
  await pause(150);
  check(gap() < 2, "returning to a running session remains at the tail");
  check(thread().querySelector(".chat-prompt"), "returning to a running session preserves pending input");
  longHistory.push({ id: "navigation-confirmed", role: "user", timestamp: Date.now(),
    idempotencyKey: state.sent.idempotencyKey, content: [{ type: "text", text: "Fixture navigation send" }] } as any);
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "final",
    message: { role: "assistant", content: "Navigation finished" } } });
  await wait(() => thread().dataset.historyLoaded === "true" && thread().querySelector('[data-chat-message-id="navigation-confirmed"]'),
    "navigation fixture reconciles canonical history after completion");
  longHistory.pop();
  state.sent = null;
  document.querySelector<HTMLButtonElement>('.chat-agent[title="short"]')!.click();
  await wait(() => bubbles().length === 1, "return to short history after navigation");
  await frame(); await frame();
  check(thread().scrollTop === 0, "tail settling must not affect the next conversation");
  return { reopenedGap, jumpedGap, userScrollCancels: true, liveReselections: 3, waitingInput: true, returnToRunning: true, liveMessagesPreserved: true };
};
state.runFixture = async () => {
  await wait(() => bubbles().length === 1 && document.querySelector(".chat-composer__input"), "short history");
  await pause(100);
  entries.length = 0;
  const start = performance.now();
  document.querySelector<HTMLButtonElement>('.chat-agent[title="perf"]')!.click();
  await wait(() => bubbles().length === 50 && thread().dataset.historyLoaded === "true", "first long-history page");
  const initialPageMs = Math.round(performance.now() - start);
  let earlierPages = 0;
  while (bubbles().length < historyCount) {
    const count = bubbles().length;
    const legacyButton = thread().querySelector<HTMLButtonElement>('[data-testid="chat-history-earlier"]');
    if (state.baseline && legacyButton) legacyButton.click();
    else {
      thread().scrollTo({ top: 0, behavior: "instant" });
      browseEarlier();
    }
    await wait(() => bubbles().length > count, "earlier-history page loaded");
    earlierPages++;
  }
  check(bubbles().length === historyCount, "all 220 history messages are loaded before performance checks");
  // Earlier-page loading preserves its reading position. Opening measurements
  // continue from the fully loaded transcript's explicit latest-message action.
  document.querySelector<HTMLButtonElement>('.chat-jump')?.click();
  await wait(() => thread().scrollHeight - thread().scrollTop - thread().clientHeight < 10, "expanded history at latest message");
  await frame(); await frame(); await pause(100);
  const opening = {
    initialPageMs, earlierPages,
    elapsedMs: Math.round(performance.now() - start - 100),
    domNodes: thread().querySelectorAll("*").length,
    maxTaskMs: Math.max(0, ...entries.filter((entry) => entry.entryType === "longtask").map((entry) => entry.duration)),
    maxForcedLayoutMs: Math.max(0, ...entries.flatMap((entry) => entry.scripts || []).map((script) => script.forcedStyleAndLayoutDuration)),
  };
  check(state.markdownCalls >= historyCount, "Markdown work counter must observe the initial transcript render");
  check(thread().scrollHeight - thread().scrollTop - thread().clientHeight < 10, "long history must initially land at the bottom");
  const lastTop = bubbles()[historyCount - 1].getBoundingClientRect().top;
  await pause(300);
  check(Math.abs(bubbles()[historyCount - 1].getBoundingClientRect().top - lastTop) < 2, "initial bottom must not drift after deferred layout");
  if (!state.baseline) check(getComputedStyle(bubbles()[29]).contentVisibility === "auto", "offscreen history uses browser layout skipping");

  const interactions: { name: string; elapsedMs: number; markdownCalls: number; childKeyCalls: number }[] = [];
  const measureInteraction = async (name: string, action: () => void) => {
    const calls = state.markdownCalls || 0;
    const keyCalls = state.childKeyCalls || 0;
    const settledBubbles = Array.from(bubbles());
    const started = performance.now();
    action();
    await frame(); await frame();
    const result = { name, elapsedMs: Math.round(performance.now() - started), markdownCalls: (state.markdownCalls || 0) - calls, childKeyCalls: (state.childKeyCalls || 0) - keyCalls };
    interactions.push(result);
    if (!state.baseline) check(result.markdownCalls === 0, `${name} must not reparse settled history (${result.markdownCalls} calls)`);
    if (!state.baseline) check(result.childKeyCalls === 0, `${name} must not rehash settled message children (${result.childKeyCalls} calls)`);
    check(settledBubbles.every((bubble, index) => bubble === bubbles()[index]), `${name} must retain every settled bubble node`);
  };
  const input = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  const setInput = (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await measureInteraction("type in composer", () => setInput("Draft"));
  await measureInteraction("edit composer", () => setInput("Draft revised"));
  await measureInteraction("clear composer", () => setInput(""));
  if (__CHAT_PERF_WITH_TOOLS__ && !state.baseline) {
    const activities = () => Array.from(document.querySelectorAll<HTMLButtonElement>(
      `.chat-thread button[aria-haspopup="dialog"][aria-label="${i18n.t("turnLab.processOpen")}"]`));
    const count = longHistory.filter(message => message.role === "assistant").length;
    check(activities().length === count, "each historical tool turn has one activity shortcut");
    const entry = activities()[0];
    await measureInteraction("open activity details", () => entry.click());
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!;
    check(modal?.querySelector("[data-action]"), "historical activity shows its tool");
    await measureInteraction("close activity details", () => modal
      .querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.close")}"]`)!.click());
    const preservedBubble = bubbles()[1];
    Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "enter immersive after reviewing activity");
    check(preservedBubble === bubbles()[1] && entry.isConnected, "immersive mode preserves mounted ordinary-chat contents");
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="immersive-chat"] button'))
      .find((button) => button.getAttribute("aria-label") === i18n.t("chat.immersiveExit"))!.click();
    await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "return to the activity shortcut");
    check(entry.isConnected && activities().length === count, "immersive round trip preserves the activity shortcuts");
  }

  // A memoized message must still refresh translated controls when the locale changes.
  const originalLanguage = i18n.language;
  const codeButton = document.querySelector<HTMLButtonElement>(".chat-thread [data-code]")!;
  check(codeButton, "code copy control is present");
  const originalLabel = codeButton.textContent;
  await i18n.changeLanguage(originalLanguage.startsWith("en") ? "zh-CN" : "en");
  await frame(); await frame();
  const translatedButton = document.querySelector<HTMLButtonElement>(".chat-thread [data-code]")!;
  check(translatedButton.textContent !== originalLabel, "memoized Markdown must update translated copy controls");
  await i18n.changeLanguage(originalLanguage);
  await frame(); await frame();

  if (MESSAGE_PINNING_ENABLED) {
    document.querySelector<HTMLButtonElement>(".chat-pinbar__jump")!.click();
    await pause(600);
    const pinnedGroup = bubbles()[29].closest(".chat-group")!;
    const pinnedRect = pinnedGroup.getBoundingClientRect();
    const viewport = thread().getBoundingClientRect();
    check(pinnedRect.bottom > viewport.top && pinnedRect.top < viewport.bottom, "pin jump must reveal the target group");
  } else {
    check(!document.querySelector(".chat-pinbar"), "disabled pinning must not render pin controls");
    check(localStorage.getItem("shoggoth.chat.pinned." + longKey) === JSON.stringify(["history-29"]), "disabled pinning retains saved pins");
  }

  // Archive prepend must preserve the actual bubble, not just scrollHeight.
  const legacyArchiveButton = state.baseline && thread().querySelector<HTMLButtonElement>(".chat-archive-bar.is-action");
  const archiveIndex = legacyArchiveButton && !state.archiveAtTop ? 55 : 0;
  if (legacyArchiveButton) bubbles()[archiveIndex].scrollIntoView({ block: "center", behavior: "instant" });
  else thread().scrollTo({ top: 0, behavior: "instant" });
  await frame(); await frame(); await pause(100);
  if (!legacyArchiveButton) thread().scrollTo({ top: 0, behavior: "instant" });
  const archiveAnchor = bubbles()[archiveIndex];
  const archiveTop = archiveAnchor.getBoundingClientRect().top;
  if (legacyArchiveButton) legacyArchiveButton.click();
  else browseEarlier();
  await wait(() => bubbles().length === historyCount + 1, "archive prepend");
  await frame(); await frame(); await pause(100);
  const archiveRestored = bubbles()[archiveIndex + 1];
  if (!state.baseline) check(Math.abs(archiveRestored.getBoundingClientRect().top - archiveTop) < 2, `archive prepend must preserve the message being read: ${archiveTop} -> ${archiveRestored.getBoundingClientRect().top}`);

  // Jump to an old bubble, then preserve its viewport while a reply streams below.
  bubbles()[56].scrollIntoView({ block: "center", behavior: "instant" });
  await frame(); await frame(); await pause(100);
  const oldBubble = bubbles()[56];
  const oldTop = oldBubble.getBoundingClientRect().top;
  let previous: Element | null = null;
  let replacements = 0;
  const streamCallsBefore = state.markdownCalls || 0;
  for (let index = 1; index <= 20; index++) {
    state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "delta", message: { role: "assistant", content: [{ type: "text", text: "Streaming **text** ".repeat(index) }] } } });
    await frame(); await frame();
    const current = document.querySelector(".chat-cursor")?.closest(".chat-bubble") || null;
    check(current, "streamed reply must be visible in the DOM");
    if (previous && previous !== current) replacements++;
    previous = current;
  }
  check(Math.abs(oldBubble.getBoundingClientRect().top - oldTop) < 2, "streaming must not move the old message being read");
  check(bubbles().length === historyCount + 2, "no history may be dropped");
  if (!state.baseline) check(replacements === 0, "streaming must update, not remount, the pending bubble");
  const streamMarkdownCalls = (state.markdownCalls || 0) - streamCallsBefore;
  if (!state.baseline) check(streamMarkdownCalls >= 20 && streamMarkdownCalls <= 22,
    `streaming must parse the changed reply, not the settled transcript (${streamMarkdownCalls} Markdown calls)`);

  // Reload canonical history, then exercise the real composer against our fake
  // socket. Sending must preserve the user-bubble anchor as the reply grows.
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "final", message: { role: "assistant", content: "Done" } } });
  await wait(() => !document.querySelector(".chat-cursor"), "stream final");
  await pause(100);
  document.querySelector<HTMLButtonElement>(".chat-jump")?.click();
  await pause(600);
  const composer = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Fixture-only send");
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  const sendButton = document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!;
  check(!sendButton.disabled, "composer remains usable");
  sendButton.click();
  await wait(() => state.sent?.message === "Fixture-only send", "fake send");
  await frame(); await frame();
  const sentBubble = Array.from(bubbles()).find((bubble) => bubble.textContent?.trim() === "Fixture-only send")!;
  check(sentBubble, "optimistic user bubble is rendered");
  const sentTop = sentBubble.getBoundingClientRect().top;
  for (let index = 1; index <= 8; index++) {
    state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: longKey, state: "delta", message: { role: "assistant", content: "A growing reply.\n\n".repeat(index * 20) } } });
    await frame(); await frame();
  }
  check(Math.abs(sentBubble.getBoundingClientRect().top - sentTop) < 2, "own-send anchor must stay fixed through reply growth");
  const switchingStarted = performance.now();
  document.querySelector<HTMLButtonElement>('.chat-agent[title="short"]')!.click();
  await wait(() => bubbles().length === 1, "switch back to short history");
  await frame(); await frame();
  check(thread().scrollTop === 0, "switching to a short session must reset scroll");
  const agentSwitchMs = Math.round(performance.now() - switchingStarted);
  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "enter immersive mode");
  check(document.querySelector('[data-testid="immersive-chat"]')!.textContent?.includes("Short conversation"), "immersive projection is created on demand");
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="immersive-chat"] button'))
    .find((button) => button.getAttribute("aria-label") === i18n.t("chat.immersiveExit"))!.click();
  await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "exit immersive mode");
  return {
    opening, interactions, agentSwitchMs, archiveAtTop: Boolean(state.archiveAtTop), withTools: __CHAT_PERF_WITH_TOOLS__, pinningEnabled: MESSAGE_PINNING_ENABLED, streamUpdates: 20, streamMarkdownCalls, bubbleReplacements: replacements,
    assertions: state.baseline ? "baseline measurement (new optimization assertions skipped)"
      : `bottom landing, ${MESSAGE_PINNING_ENABLED ? "pin jump" : "pin controls hidden and saved pins retained"}, archive prepend, old-message viewport, composer, own-send anchor, session switch, immersive mode, full history retained`,
  };
};
