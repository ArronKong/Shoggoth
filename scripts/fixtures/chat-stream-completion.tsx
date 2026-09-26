import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __STREAM_FIXTURE__: { key: string; note: string; answer: string; frames: any[] };
const { key, note, answer, frames } = __STREAM_FIXTURE__;
const state = window as any;
const now = Date.now();
const sessions = [{ key, agentId: "shoggoth-default", agentName: "Shoggoth", backendId: "shoggoth", updatedAt: now }];
const user = { id: "user-1", role: "user", content: "帮我分析一下这款产品。", timestamp: now };
const history = [user];
const canonical = [user,
  { id: "note-1", role: "assistant", content: note, timestamp: now + 1 },
  { id: "tool-1", role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: {} }], timestamp: now + 2 },
  { id: "tool-result-1", role: "toolResult", content: [{ type: "text", text: "Found sources" }], timestamp: now + 302 },
  { id: "answer-1", role: "assistant", content: answer, timestamp: now + 303 },
];
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
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
      : request.method === "agents.list" ? { agents: [{ id: "shoggoth-default", name: "Shoggoth", backendId: "shoggoth" }] }
      : request.method === "chat.history" ? { messages: state.completed ? canonical : history } : {};
    if (request.method === "chat.history" && state.completed) state.historyReloaded = true;
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), state.completed ? 80 : 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: "shoggoth", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("runtime-models") ? { selection: { bindingId: "fixture-binding", runtime: "codex", model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { state.copied = text; } } });
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason); });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Measure painted layout, after content-visibility has resolved visible bubbles.
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
};
const bubbles = () => Array.from(document.querySelectorAll<HTMLElement>(".chat-thread .is-assistant .chat-bubble"));
const snapshot = () => ({
  bubbles: bubbles().map((node) => { const r = node.getBoundingClientRect(); return { text: node.textContent?.replace(/●/g, "").trim(), top: r.top, height: r.height }; }),
  scrollTop: document.querySelector(".chat-thread")!.scrollTop,
});
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
state.startFixture = async () => {
  await wait(() => document.querySelector(".chat-thread .chat-bubble")?.textContent?.trim() === user.content, "initial history");
  await pause(350);
  for (const event of frames.filter((value) => value.payload.state !== "final")) {
    state.socket.emit(event);
    await frame(); await frame();
  }
  // Match the user's collapsed process row; its intentional expanded/collapsed
  // layout is independent from the response bubbles being checked here.
  const process = document.querySelector<HTMLButtonElement>(".chat-thread button[aria-expanded='true']");
  process?.click();
  await pause(200);
  check(bubbles().length === 2, `the commentary and answer must already be separate while streaming; got ${bubbles().length}`);
  check(bubbles()[0].textContent?.trim() === note, "the progress bubble contains only commentary");
  check(bubbles()[1].textContent?.includes("重点说明"), "the answer streams in the second bubble");
  check(document.querySelectorAll(".chat-cursor").length === 1, "only the live answer has a cursor");
  state.before = snapshot();
  return state.before;
};
state.finishFixture = async () => {
  state.completed = true;
  state.socket.emit(frames.find((value) => value.payload.state === "final"));
  const samples = [];
  for (let index = 0; index < 25; index += 1) { await frame(); samples.push(snapshot()); }
  await wait(() => state.historyReloaded && bubbles().length === 2, "canonical history");
  await pause(150);
  samples.push(snapshot());
  check(samples.every((sample) => sample.bubbles.length === 2), "completion and history refresh must keep both bubbles");
  check(samples.every((sample) => sample.bubbles.every((bubble, index) => bubble.text === state.before.bubbles[index].text)), "completion must not change, duplicate or drop visible text");
  const heightShift = Math.max(...samples.flatMap((sample) => sample.bubbles.map((bubble, index) => Math.abs(bubble.height - state.before.bubbles[index].height))));
  const positionShift = Math.max(...samples.flatMap((sample) => sample.bubbles.map((bubble, index) => Math.abs(bubble.top - state.before.bubbles[index].top))));
  const flowShift = Math.max(...samples.flatMap((sample) => sample.bubbles.map((bubble, index) => Math.abs(bubble.top + sample.scrollTop - state.before.bubbles[index].top - state.before.scrollTop))));
  check(heightShift < 2, `completion must keep bubble height; shifted ${heightShift}px`);
  check(flowShift < 2, `completion must keep bubble layout; shifted ${flowShift}px`);
  // A bottom-following viewport may move by the footer's 4px when its action
  // buttons become available. The bubbles themselves must not change geometry.
  check(positionShift <= 4, `completion must keep the reading position; shifted ${positionShift}px`);
  check(!document.querySelector(".chat-cursor"), "completion removes the cursor");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  // Each visible bubble retains its own copy scope after history rehydration.
  for (const [index, expected] of [note, answer].entries()) {
    bubbles()[index].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 220, clientY: 300 }));
    await wait(() => document.querySelector(".chat-ctxmenu"), "copy menu");
    Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-ctxmenu button")).find((button) => button.textContent === i18n.t("chat.copy"))!.click();
    await wait(() => state.copied === expected, "single bubble copy");
  }
  return { bubbleCount: 2, heightShift, flowShift, positionShift, historyReloaded: true, perBubbleCopy: true };
};
