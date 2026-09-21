import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// Exercise the real message grouping, Markdown DOM and context menu without
// touching the user's backend, history or system clipboard.
const state = window as any;
const key = "agent:copy:main";
const userTexts = ["请整理今天的日报。", "请保留每一步的进度说明。"];
const errorText = "本轮运行失败，请稍后重试。";
const texts = [
  "收到，开始生成 **日报**。",
  "素材收集中——补充哨兵、20:00 任务、Neo 日志、备份等细节：",
  "继续补最后几块素材——重点是 `daily-ops-report` Skill：\n\n```js\nconst ready = true;\n```",
  "数据齐了，现在生成完整日报。",
];
const sessions = [{ key, agentId: "copy", agentName: "复制检查", backendId: "openclaw", updatedAt: Date.now() }];
const messages = [
  ...userTexts.map((text, index) => ({ id: `user-${index}`, role: "user", content: text })),
  { id: "failed", role: "assistant", content: errorText, stopReason: "error" },
  { id: "start", role: "assistant", content: [
    { type: "thinking", thinking: "这段过程不应进入单个气泡的复制结果。" },
    { type: "text", text: texts[0] },
  ] },
  { id: "middle", role: "assistant", content: [
    { type: "text", text: texts[1] },
    { type: "text", text: texts[2] },
  ] },
  { id: "finish", role: "assistant", content: texts[3] },
];
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
state.clipboardWrites = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (text: string) => {
    state.clipboardWrites.push(text);
    document.getElementById("clipboard-output")!.textContent = text;
  },
} });
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "copy", name: "复制检查" }] }
      : request.method === "chat.history" ? { messages } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  if (pathname.includes("/sessions/describe")) state.forkAdvertised = true;
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: "openclaw", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("/sessions/describe") ? { supported: true, session: { key }, methods: {
      "environments.list": false, "sessions.describe": false, "sessions.branches.list": false, "sessions.fork": true,
    } }
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
const contextMenu = async (element: Element) => {
  element.scrollIntoView({ block: "center" });
  const bounds = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: bounds.left + 20, clientY: bounds.top + 15,
  }));
  await wait(() => document.querySelector(".chat-ctxmenu"), "context menu");
};
const copyFromMenu = async (element: Element, expected: string, label: string) => {
  await contextMenu(element);
  const copy = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-ctxmenu button"))
    .find((button) => button.textContent === i18n.t("chat.copy"));
  check(copy, `${label}: copy is available`);
  const before = state.clipboardWrites.length;
  copy!.click();
  await wait(() => state.clipboardWrites.length === before + 1, "clipboard write");
  check(state.clipboardWrites.at(-1) === expected, `${label}: copy must contain only the clicked bubble's Markdown`);
  await wait(() => !document.querySelector(".chat-ctxmenu"), "menu closed");
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

state.runFixture = async () => {
  await wait(() => document.querySelectorAll(".chat-thread .chat-bubble").length === 7 && state.forkAdvertised, "history and fork capability");
  const bubbles = Array.from(document.querySelectorAll<HTMLElement>(".chat-thread .chat-bubble"));
  const expected = [...userTexts, errorText, ...texts];
  for (const [index, bubble] of bubbles.entries()) {
    // Include nested Markdown elements, not only a bubble's outer container.
    const target = bubble.querySelector("strong, code, p") || bubble;
    await copyFromMenu(target, expected[index], `normal bubble ${index}`);
  }
  await contextMenu(bubbles[0]);
  check(!document.querySelector(".chat-ctxmenu")!.textContent!.includes(i18n.t("chat.advanced.forkHere")), "fork stays hidden even when supported");
  (document.querySelector(".chat-ctxmenu__backdrop") as HTMLElement).click();
  await wait(() => !document.querySelector(".chat-ctxmenu"), "menu closed");

  // The group footer remains an explicit way to copy the whole response.
  const footerCopy = bubbles.at(-1)!.closest(".chat-group")!.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.copyAsMarkdown")}"]`)!;
  footerCopy.click();
  check(state.clipboardWrites.at(-1) === [errorText, ...texts].join("\n"), "footer keeps the complete grouped response");

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const scope = '[data-testid="immersive-chat"]';
  await wait(() => document.querySelector(scope), "immersive chat");
  const immersive = document.querySelector(scope)!;
  const error = Array.from(immersive.querySelectorAll("span")).find((element) => element.textContent === errorText)!;
  await copyFromMenu(error, errorText, "immersive error card");
  const response = Array.from(immersive.querySelectorAll("strong")).find((element) => element.textContent === "日报")!;
  await copyFromMenu(response, texts.join("\n"), "immersive response card");
  const card = response.closest("[data-glass-panel]")!;
  card.parentElement!.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.copy")}"]`)!.click();
  check(state.clipboardWrites.at(-1) === texts.join("\n"), "immersive hover copy excludes neighboring error cards");
  const user = Array.from(immersive.querySelectorAll("p")).find((element) => element.textContent?.includes(userTexts[0]))!;
  await contextMenu(user);
  check(!document.querySelector(".chat-ctxmenu")!.textContent!.includes(i18n.t("chat.advanced.forkHere")), "immersive fork stays hidden");
  (document.querySelector(".chat-ctxmenu__backdrop") as HTMLElement).click();
  immersive.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(scope), "normal chat restored");
  return { passed: true, copies: state.clipboardWrites.length, checks: "grouped messages, multipart message, nested Markdown, user/error bubbles, full-response footer, immersive context/hover, fork hidden" };
};
document.getElementById("run-fixture")!.onclick = async () => {
  const output = document.getElementById("fixture-result")!;
  output.textContent = "检查中…";
  try { output.textContent = JSON.stringify(await state.runFixture()); }
  catch (error) { output.textContent = String(error); }
};
