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
const footerModels = ["native-actual-model", "openclaw-actual-model", "hermes-actual-model"];
const messages = [
  { role: "user", content: userText, timestamp: 1790000000000 },
  { id: "assistant-a", role: "assistant", content: agentText, timestamp: 1790000001000,
    responseMetadata: { models: [footerModels[0]], modelSource: "reported",
      usage: { inputTokens: 359700, outputTokens: 3600, cachedInputTokens: 344100, cacheWriteInputTokens: 2000 },
      context: { usedTokens: 14000, windowTokens: 100000, quality: "estimated" } } },
  { role: "user", content: repeatedText, timestamp: 1790000060000 },
  { id: "assistant-b", role: "assistant", content: "第一遍检查完成。", timestamp: 1790000061000,
    model: footerModels[1], usage: { input: 359700, output: 3600, cacheRead: 344100, cacheWrite: 2000, totalTokens: 363300 } },
  { role: "user", content: repeatedText, timestamp: 1790000060000 },
  { id: "assistant-c", role: "assistant", content: "第二遍检查完成。", timestamp: 1790000062000,
    model: footerModels[2], usage: { inputTokens: 359700, outputTokens: 3600, contextPercent: 14, totalTokens: 363300 } },
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
      : request.method === "chat.history" ? { messages, hasMore: false, nextCursor: null, sourceId: "fixture-message-actions" } : {};
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
  for (const model of footerModels) {
    const label = [...document.querySelectorAll<HTMLElement>(".chat-thread .chat-response-model")].find(element => element.title === model)!;
    check(label, "normal footer keeps model " + model);
    const footer = label.closest<HTMLElement>(".chat-group__footer")!, button = footer.querySelector<HTMLButtonElement>(".chat-copybtn")!;
    check(!/[↑↓]|\b[RW]\d|\bctx\b|\btok\b/.test(footer.textContent || ""), "normal footer removes every metric " + model);
    check(getComputedStyle(label).opacity === "0", "normal model is hidden by default " + model);
    button.focus();
    await wait(() => getComputedStyle(label).opacity === "1" && getComputedStyle(button).opacity === "1", "normal model and actions reveal on focus");
    button.blur();
    await wait(() => getComputedStyle(label).opacity === "0", "normal model hides after focus leaves");
  }
  const footerScope = '[data-testid="immersive-chat"]';
  document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.immersiveEnter")}"]`)!.click();
  await wait(() => document.querySelector(footerScope), "immersive footer fixture");
  for (const model of footerModels) {
    const label = [...document.querySelectorAll<HTMLElement>(`${footerScope} .chat-response-model`)].find(element => element.title === model)!;
    check(label, "immersive footer keeps model " + model);
    const row = label.closest<HTMLElement>("[data-immersive-message]")!, footer = label.closest<HTMLElement>("[data-immersive-message-footer]")!;
    const button = row.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.copy")}"]`)!;
    check(!/[↑↓]|\b[RW]\d|\bctx\b|\btok\b/.test(footer.textContent || ""), "immersive footer removes every metric " + model);
    check(getComputedStyle(label).opacity === "0", "immersive model is hidden by default " + model);
    button.focus();
    await wait(() => getComputedStyle(label).opacity === "1" && getComputedStyle(button.parentElement!).opacity === "1", "immersive model and actions reveal on focus");
    button.blur();
    await wait(() => getComputedStyle(label).opacity === "0", "immersive model hides after focus leaves");
  }
  document.querySelector<HTMLButtonElement>(`${footerScope} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(footerScope), "normal chat restored after footer checks");
  check(!bubbles("此前已隐藏的消息。").length, "legacy backend-id deletion remains hidden");
  check(!document.querySelector(".chat-pinbar"), "saved pins do not render a pin bar");
  check(!document.querySelector(`button[title="${i18n.t("chat.pin")}"], button[title="${i18n.t("chat.unpin")}"]`), "message footers hide pin and unpin shortcuts");
  await openMenu(bubbles(userText)[0]);
  const labels = Array.from(document.querySelectorAll(".chat-ctxmenu button")).map((button) => button.textContent);
  check(JSON.stringify(labels) === JSON.stringify(["复制", "引用", "删除"]), `anonymous user menu hides pinning: ${labels}`);
  await clickMenu("复制");
  check(state.clipboardText === userText, "user copy remains correct");
  await openMenu(bubbles(agentText)[0]);
  check(!menuButton("置顶") && !menuButton("取消置顶"), "saved agent pin has no pin or unpin menu action");
  await clickMenu("复制");
  check(state.clipboardText === agentText, "agent copy remains correct");
  await remount();
  check(!document.querySelector(".chat-pinbar"), "pin bar stays hidden after reload");
  check(JSON.stringify(saved(pinnedKey)) === JSON.stringify(["assistant-a"]), "saved agent pin is preserved");

  await action(bubbles(repeatedText)[1], "删除");
  await wait(() => bubbles(repeatedText).length === 1, "only the selected duplicate is hidden");
  const duplicateHidden = saved(hiddenKey).find((id) => id !== "legacy-hidden")!;
  await undo();
  await wait(() => bubbles(repeatedText).length === 2, "undo restores the selected duplicate");
  // Archive prepend must not move the saved action to a different duplicate.
  messages.unshift(
    { role: "user", content: repeatedText, timestamp: 1790000060000 },
    { id: "archive-separator", role: "assistant", content: "更早的归档回复。" },
  );
  await remount();
  await wait(() => bubbles(repeatedText).length === 3, "older history prepended");
  await action(bubbles(repeatedText)[2], "删除");
  await wait(() => bubbles(repeatedText).length === 2, "selected duplicate hidden after archive prepend");
  check(saved(hiddenKey).includes(duplicateHidden), "archive prepend preserves the original action target");
  await undo();
  await wait(() => bubbles(repeatedText).length === 3, "undo restores the same duplicate after archive prepend");

  await action(bubbles(mixedText)[0], "删除");
  await wait(() => !bubbles(mixedText).length && !bubbles(identifiedText).length, "mixed-id user group is completely hidden");
  check(saved(hiddenKey).includes("user-identified"), "canonical deletion keys remain compatible");
  await remount();
  check(!bubbles(mixedText).length && !bubbles(identifiedText).length, "anonymous and canonical deletions survive reload");
  await remount(otherKey);
  check(bubbles(mixedText).length && bubbles(identifiedText).length, "deletion is scoped to its session");
  check(!document.querySelector(".chat-pinbar"), "pins are scoped to their session");
  await remount();

  check(bubbles(userText).length && bubbles(agentText).length && bubbles(repeatedText).length === 3,
    "saved pins do not filter the message stream");
  check(!document.querySelector(".chat-pinbar__toggle"), "pinned-only filter is hidden");

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const scope = '[data-testid="immersive-chat"]';
  await wait(() => document.querySelector(scope), "immersive chat");
  const immersiveUser = () => Array.from(document.querySelectorAll(`${scope} p`)).find((element) => element.textContent?.trim() === userText)!;
  await openMenu(immersiveUser());
  check(document.querySelectorAll(".chat-ctxmenu button").length === 3, "immersive anonymous user menu has three actions");
  check(!menuButton("置顶") && !menuButton("取消置顶"), "immersive context menu hides pinning");
  check(!document.querySelector(`${scope} button[title="${i18n.t("chat.pin")}"], ${scope} button[title="${i18n.t("chat.unpin")}"]`), "immersive hover actions hide pinning");
  await clickMenu("复制");
  await action(immersiveUser(), "删除");
  await wait(() => !immersiveUser(), "immersive delete hides the user message");
  document.querySelector<HTMLButtonElement>(`${scope} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(scope), "normal chat restored");
  await undo();
  await wait(() => bubbles(userText).length, "immersive deletion can be undone after mode switch");
  check(JSON.stringify(saved(pinnedKey)) === JSON.stringify(["assistant-a"]), "all message actions preserve saved pins while pinning is hidden");
  check(!state.requests.some((request: { method: string }) => /^(chat.send|sessions.delete|sessions.patch|sessions.fork)$/.test(request.method)), "local actions never mutate backend history");
  check(!state.fixtureError, "no renderer errors");
  return { passed: true, checks: "model-only footers for native/OpenClaw/Hermes history shapes, focus visibility and immersive parity; pin controls and bar hidden, saved pins retained, three actions, copy, delete/undo, reload persistence, duplicate identity, archive prepend, mixed IDs, legacy storage, session isolation, full message stream" };
};
document.getElementById("run-fixture")!.onclick = async () => {
  const output = document.getElementById("fixture-result")!;
  output.textContent = "检查中…";
  try { output.textContent = JSON.stringify(await state.runFixture()); }
  catch (error) { output.textContent = String(error); }
};
