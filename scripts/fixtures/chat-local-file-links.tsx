import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// Real ChatPage and sanitizer; all transport and host calls stay in this fixture.
const state = window as any;
const key = "agent:files:files";
const paths = [
  "~/Documents/季度数据.csv",
  "/Users/example/Desktop/季度报告.pdf",
  "/Users/example/Documents/Quarterly Report/摘要.md",
  "~/Downloads/季度数据.csv",
  "/Users/example/Documents/report.ts",
  "/Users/example/Desktop/报告 备份.pdf",
];
const sessions = [{ key, agentId: "files", agentName: "文件助手", updatedAt: Date.now() }];
const messages = [
  { id: "user-files", role: "user", content: `请整理 ${paths[0]}，完成后把报告和数据文件发给我。` },
  { id: "assistant-files", role: "assistant", content: [
    "已经整理好了，点击路径即可打开对应文件。",
    `- 报告：${paths[1]}`,
    `- 摘要：\`${paths[2]}\``,
    `- 数据：\`${paths[3]}\``,
    `- 生成脚本：\`${paths[4]}:12:3\``,
    `- 备份："${paths[5]}"`,
    "\n[查看说明](https://example.com/guide)",
  ].join("\n") },
];
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
state.openCalls = [];
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
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "files", name: "文件助手" }] }
      : request.method === "chat.history" ? { messages } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.endsWith("/__api/host/open-path")) {
    state.openCalls.push(JSON.parse(String(init?.body)).path);
    return new Response(JSON.stringify(state.failOpen ? { error: "File not found" } : { ok: true }), {
      status: state.failOpen ? 500 : 200, headers: { "Content-Type": "application/json" },
    });
  }
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
const links = (scope = ".chat-thread") => Array.from(document.querySelectorAll<HTMLAnchorElement>(`${scope} a[data-local-path]`));
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

state.runFixture = async () => {
  await wait(() => links().length === paths.length, "user and assistant paths");
  const initialHash = window.location.hash;
  for (const [index, anchor] of links().entries()) {
    check(anchor.getAttribute("href") === "#" && !anchor.target, "local links stay in the app");
    check(decodeURIComponent(anchor.dataset.localPath!) === paths[index], "sanitizer preserves the exact path");
    (anchor.querySelector("code") || anchor).click();
    await wait(() => state.openCalls.length === index + 1, "host open request");
    check(state.openCalls[index] === paths[index], "click sends the exact path to the host");
  }
  check(window.location.hash === initialHash, "opening files must not navigate the chat");
  const external = document.querySelector<HTMLAnchorElement>('.chat-thread a[href="https://example.com/guide"]')!;
  check(external.target === "_blank" && !external.hasAttribute("data-local-path"), "external links retain normal behavior");
  check(!toSanitizedMarkdownHtml(paths[1]).includes("data-local-path"), "chat-only linkification must not leak through the Markdown cache");
  check(!toSanitizedMarkdownHtml('[bad](javascript:alert(1))', true).includes("href="), "unsafe hrefs stay blocked");

  state.failOpen = true;
  links()[0].click();
  await wait(() => document.querySelector(".chat-toast--error")?.textContent?.includes("File not found"), "failed opens show an error");
  state.failOpen = false;

  const streamingPath = "/tmp/streamed-report.md";
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, state: "delta", message: {
    role: "assistant", content: `生成中：\`${streamingPath}\``,
  } } });
  await wait(() => links().some((anchor) => anchor.title === streamingPath), "streaming path");
  links().find((anchor) => anchor.title === streamingPath)!.click();
  await wait(() => state.openCalls.at(-1) === streamingPath, "streaming path opens");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, state: "final", message: { role: "assistant", content: "完成" } } });
  await wait(() => !document.querySelector(".chat-cursor"), "stream complete");

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const immersive = '[data-testid="immersive-chat"]';
  await wait(() => links(immersive).length >= paths.length, "immersive paths");
  const before = state.openCalls.length;
  links(immersive)[1].click();
  await wait(() => state.openCalls.length === before + 1, "immersive path opens");
  check(state.openCalls.at(-1) === paths[1], "immersive click uses the same host path");
  document.querySelector<HTMLButtonElement>(`${immersive} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(immersive), "return to normal chat");
  return { passed: true, paths: paths.length, hostOpens: state.openCalls.length, checks: "sanitization, exact paths, nested code click, no navigation, external links, cache scope, errors, streaming, immersive" };
};
