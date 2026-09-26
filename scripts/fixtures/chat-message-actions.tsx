import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// All history, RPC, clipboard and storage live in an isolated browser profile.
const state = window as any;
const key = "agent:actions:main";
const otherKey = "agent:other:main";
const pinnedKey = "shoggoth.chat.pinned.";
const hiddenKey = "shoggoth.chat.hidden.";
const userText = "我的消息：请整理今天的日报。";
const repeatedText = "再检查一遍。";
const mixedText = "这条用户消息没有服务端 ID。";
const identifiedText = "这条相邻用户消息有服务端 ID。";
const agentText = "收到，开始整理日报。";
const messages = [
  { role: "user", content: userText, timestamp: 1790000000000 },
  { id: "assistant-a", role: "assistant", content: agentText },
  { role: "user", content: repeatedText, timestamp: 1790000060000 },
  { id: "assistant-b", role: "assistant", content: "第一遍检查完成。" },
  { role: "user", content: repeatedText, timestamp: 1790000060000 },
  { id: "assistant-c", role: "assistant", content: "第二遍检查完成。" },
  { role: "user", content: mixedText },
  { id: "user-identified", role: "user", content: identifiedText },
  { id: "assistant-d", role: "assistant", content: "两条补充要求都已收到。" },
  { id: "legacy-hidden", role: "assistant", content: "此前已隐藏的消息。" },
];
const sessions = [key, otherKey].map((sessionKey) => ({
  key: sessionKey, agentId: sessionKey.split(":")[1], agentName: sessionKey === key ? "消息操作检查" : "另一会话",
  backendId: "openclaw", updatedAt: 1790000060000,
}));
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
localStorage.setItem(pinnedKey + key, JSON.stringify(["assistant-a"]));
localStorage.setItem(hiddenKey + key, JSON.stringify(["legacy-hidden"]));
void i18n.changeLanguage("zh-CN");
state.requests = [];
state.historyLoads = 0;
state.clipboardText = "";
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (text: string) => { state.clipboardText = text; },
} });
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(data: string) {
    const request = JSON.parse(data);
    state.requests.push(request);
    if (request.method === "chat.history") state.historyLoads += 1;
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: sessions.map((session) => ({ id: session.agentId, name: session.agentName })) }
      : request.method === "chat.history" ? { messages } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: "openclaw", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const saved = (prefix: string, sessionKey = key): string[] => JSON.parse(localStorage.getItem(prefix + sessionKey) || "[]");
const bubbles = (text: string) => Array.from(document.querySelectorAll<HTMLElement>(".chat-thread .chat-bubble"))
  .filter((element) => element.textContent?.trim() === text);
const menuButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-ctxmenu button"))
  .find((button) => button.textContent === label);
const openMenu = async (element: Element) => {
  check(element, "context menu target exists");
  element.scrollIntoView({ block: "center" });
  const bounds = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: bounds.left + 20, clientY: bounds.top + 15,
  }));
  await wait(() => document.querySelector(".chat-ctxmenu"), "context menu");
};
const clickMenu = async (label: string) => {
  const button = menuButton(label);
  check(button, `menu offers ${label}`);
  button!.click();
  await wait(() => !document.querySelector(".chat-ctxmenu"), "menu closes after action");
};
const action = async (element: Element, label: string) => { await openMenu(element); await clickMenu(label); };
const undo = async () => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-toast button"))
    .find((button) => button.textContent === i18n.t("chat.undo"));
  check(button, "delete offers undo");
  button!.click();
};
let root = createRoot(document.getElementById("root")!);
const render = () => root.render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
render();
const remount = async (sessionKey = key) => {
  root.unmount();
  localStorage.setItem("shoggoth.chat.lastActive.v1", sessionKey);
  const before = state.historyLoads;
  root = createRoot(document.getElementById("root")!);
  render();
  await wait(() => state.historyLoads > before && bubbles(agentText).length, "canonical history reload");
};

state.runFixture = async () => {
  await wait(() => bubbles(userText).length && bubbles(identifiedText).length, "history rendered");
  check(!bubbles("此前已隐藏的消息。").length, "legacy backend-id deletion remains hidden");
  check(document.querySelector(".chat-pinbar__text")?.textContent === agentText, "legacy backend-id pin remains visible");
  await openMenu(bubbles(userText)[0]);
  const labels = Array.from(document.querySelectorAll(".chat-ctxmenu button")).map((button) => button.textContent);
  check(JSON.stringify(labels) === JSON.stringify(["复制", "引用", "置顶", "删除"]), `anonymous user menu has four actions: ${labels}`);
  await clickMenu("复制");
  check(state.clipboardText === userText, "user copy remains correct");
  await action(bubbles(userText)[0], "置顶");
  check(saved(pinnedKey).length === 2, "anonymous user pin is saved alongside the existing agent pin");
  check(document.querySelector(".chat-pinbar__text")?.textContent === userText, "pin bar displays the user message");
  await remount();
  await action(bubbles(userText)[0], "取消置顶");
  check(JSON.stringify(saved(pinnedKey)) === JSON.stringify(["assistant-a"]), "user unpin persists and preserves the agent pin");

  await action(bubbles(repeatedText)[1], "置顶");
  const duplicatePin = saved(pinnedKey).find((id) => id !== "assistant-a")!;
  await action(bubbles(repeatedText)[1], "删除");
  await wait(() => bubbles(repeatedText).length === 1, "only the selected duplicate is hidden");
  await undo();
  await wait(() => bubbles(repeatedText).length === 2, "undo restores the selected duplicate");
  // Archive prepend must not move the saved action to a different duplicate.
  messages.unshift(
    { role: "user", content: repeatedText, timestamp: 1790000060000 },
    { id: "archive-separator", role: "assistant", content: "更早的归档回复。" },
  );
  await remount();
  await wait(() => bubbles(repeatedText).length === 3, "older history prepended");
  await action(bubbles(repeatedText)[2], "取消置顶");
  check(!saved(pinnedKey).includes(duplicatePin), "archive prepend preserves the original pin target");

  await action(bubbles(mixedText)[0], "删除");
  await wait(() => !bubbles(mixedText).length && !bubbles(identifiedText).length, "mixed-id user group is completely hidden");
  check(saved(hiddenKey).includes("user-identified"), "canonical deletion keys remain compatible");
  await remount();
  check(!bubbles(mixedText).length && !bubbles(identifiedText).length, "anonymous and canonical deletions survive reload");
  await remount(otherKey);
  check(bubbles(mixedText).length && bubbles(identifiedText).length, "deletion is scoped to its session");
  check(!document.querySelector(".chat-pinbar"), "pins are scoped to their session");
  await remount();

  await action(bubbles(userText)[0], "置顶");
  document.querySelector<HTMLButtonElement>(".chat-pinbar__toggle")!.click();
  await wait(() => !bubbles(repeatedText).length, "pinned-only filter excludes unpinned user messages");
  check(bubbles(userText).length && bubbles(agentText).length, "pinned-only filter includes user and agent messages");
  document.querySelector<HTMLButtonElement>(".chat-pinbar__toggle")!.click();
  await wait(() => bubbles(repeatedText).length === 3, "all messages restored");
  await action(bubbles(userText)[0], "取消置顶");

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const scope = '[data-testid="immersive-chat"]';
  await wait(() => document.querySelector(scope), "immersive chat");
  const immersiveUser = () => Array.from(document.querySelectorAll(`${scope} p`)).find((element) => element.textContent?.trim() === userText)!;
  await openMenu(immersiveUser());
  check(document.querySelectorAll(".chat-ctxmenu button").length === 4, "immersive anonymous user menu has four actions");
  await clickMenu("置顶");
  await action(immersiveUser(), "取消置顶");
  await action(immersiveUser(), "删除");
  await wait(() => !immersiveUser(), "immersive delete hides the user message");
  document.querySelector<HTMLButtonElement>(`${scope} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(scope), "normal chat restored");
  await undo();
  await wait(() => bubbles(userText).length, "immersive deletion can be undone after mode switch");
  check(!state.requests.some((request: { method: string }) => /^(chat.send|sessions.delete|sessions.patch|sessions.fork)$/.test(request.method)), "local actions never mutate backend history");
  check(!state.fixtureError, "no renderer errors");
  return { passed: true, checks: "four actions, copy, pin/unpin, delete/undo, reload persistence, duplicate identity, archive prepend, mixed IDs, legacy storage, session isolation, pinned filter, immersive parity" };
};
document.getElementById("run-fixture")!.onclick = async () => {
  const output = document.getElementById("fixture-result")!;
  output.textContent = "检查中…";
  try { output.textContent = JSON.stringify(await state.runFixture()); }
  catch (error) { output.textContent = String(error); }
};
