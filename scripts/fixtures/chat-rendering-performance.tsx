import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
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
const sessions = [shortKey, longKey].map((key) => ({ key, agentId: key.split(":")[1], agentName: key === shortKey ? "Short chat" : "Long chat (220 messages)", updatedAt: 1_700_000_000_000 }));
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
    if (request.method === "agents.list") payload = { agents: sessions.map((row) => ({ id: row.agentId, name: row.agentName })) };
    if (request.method === "chat.history") payload = { messages: request.params.sessionKey === longKey ? longHistory : shortHistory };
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: "openclaw", connected: true }] }
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
const bubbles = () => document.querySelectorAll<HTMLElement>(".chat-thread .chat-bubble");
const entries: any[] = [];
for (const type of ["longtask", "long-animation-frame"]) {
  if (PerformanceObserver.supportedEntryTypes.includes(type)) {
    new PerformanceObserver((list) => entries.push(...list.getEntries().map((entry) => entry.toJSON()))).observe({ type });
  }
}

createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.runFixture = async () => {
  await wait(() => bubbles().length === 1 && document.querySelector(".chat-composer__input"), "short history");
  await pause(100);
  entries.length = 0;
  const start = performance.now();
  document.querySelector<HTMLButtonElement>('.chat-agent[title="perf"]')!.click();
  await wait(() => bubbles().length === historyCount, "long history");
  await frame(); await frame(); await pause(100);
  const opening = {
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
  const trajectoryButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-iconbtn"))
    .find((button) => [i18n.t("chat.showTrajectory"), i18n.t("chat.hideTrajectory")].includes(button.title))!;
  const trajectoryCards = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-thread button"))
    .filter((button) => button.title === i18n.t("turnLab.processLargeView"));
  const trajectoryInitiallyVisible = trajectoryButton().getAttribute("aria-pressed") === "true";
  if (!state.baseline) check(trajectoryInitiallyVisible, "trajectory is enabled by default");
  if (trajectoryInitiallyVisible) {
    if (__CHAT_PERF_WITH_TOOLS__) check(trajectoryCards().length === longHistory.filter((message) => message.role === "assistant").length, "trajectory shows historical tool processes by default");
    await measureInteraction("hide default trajectory", () => trajectoryButton().click());
    check(trajectoryCards().length === 0, "default trajectory can still be hidden");
  }
  await measureInteraction("show trajectory", () => trajectoryButton().click());
  if (__CHAT_PERF_WITH_TOOLS__) check(trajectoryCards().length === longHistory.filter((message) => message.role === "assistant").length, "show trajectory must retain every historical tool process");
  if (__CHAT_PERF_WITH_TOOLS__) {
    const processToggle = trajectoryCards()[0].parentElement!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    processToggle.click();
    await frame(); await frame();
    check(processToggle.getAttribute("aria-expanded") === "true", "historical process expands");
    const preservedBubble = bubbles()[1];
    Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "enter immersive with expanded process");
    check(preservedBubble === bubbles()[1] && processToggle.isConnected, "immersive mode must preserve mounted ordinary-chat contents");
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="immersive-chat"] button'))
      .find((button) => button.getAttribute("aria-label") === i18n.t("chat.immersiveExit"))!.click();
    await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "return to expanded process");
    check(processToggle.isConnected && processToggle.getAttribute("aria-expanded") === "true", "immersive round trip must preserve expanded process state");
  }
  await measureInteraction("hide trajectory", () => trajectoryButton().click());
  check(trajectoryCards().length === 0, "hide trajectory must still hide the tool process cards");

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

  document.querySelector<HTMLButtonElement>(".chat-pinbar__jump")!.click();
  await pause(600);
  const pinnedGroup = bubbles()[29].closest(".chat-group")!;
  const pinnedRect = pinnedGroup.getBoundingClientRect();
  const viewport = thread().getBoundingClientRect();
  check(pinnedRect.bottom > viewport.top && pinnedRect.top < viewport.bottom, "pin jump must reveal the target group");

  // Archive prepend must preserve the actual bubble, not just scrollHeight.
  const archiveIndex = state.archiveAtTop ? 0 : 55;
  bubbles()[archiveIndex].scrollIntoView({ block: "center", behavior: "instant" });
  await frame(); await frame(); await pause(100);
  const archiveAnchor = bubbles()[archiveIndex];
  const archiveTop = archiveAnchor.getBoundingClientRect().top;
  document.querySelector<HTMLButtonElement>(".chat-archive-bar.is-action")!.click();
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
  if (!state.baseline) check(streamMarkdownCalls >= 20 && streamMarkdownCalls <= 22, "streaming must parse the changed reply, not the settled transcript");

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
    opening, interactions, agentSwitchMs, archiveAtTop: Boolean(state.archiveAtTop), withTools: __CHAT_PERF_WITH_TOOLS__, streamUpdates: 20, streamMarkdownCalls, bubbleReplacements: replacements,
    assertions: state.baseline ? "baseline measurement (new optimization assertions skipped)"
      : "bottom landing, pin jump, archive prepend, old-message viewport, composer, own-send anchor, session switch, immersive mode, full history retained",
  };
};
