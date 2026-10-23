import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import i18n from "../../app/manage-ui/src/i18n";

const state = window as any;
const { key, otherKey, agentId, history } = state.imageFixture;
const backendId = "shoggoth";
const sessions = [key, otherKey].map((sessionKey, index) => ({ key: sessionKey, agentId, agentName: "原生 Agent 图片验证",
  backendId, updatedAt: Date.now(), displayName: index ? "另一个会话" : "图片回复", kind: "direct" }));
const reads: string[] = [];
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
window.location.hash = `/chat?session=${encodeURIComponent(key)}`;
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(data: string) {
    const request = JSON.parse(data);
    let payload: any = {};
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    if (request.method === "agents.list") payload = { agents: [{ id: agentId, name: sessions[0].agentName, backendId }] };
    if (request.method === "chat.history") {
      reads.push(request.params.sessionKey);
      payload = { messages: request.params.sessionKey === key ? history : [] };
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
const originalFetch = window.fetch.bind(window);
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.startsWith("/__api/sessions/image?") || pathname.startsWith("data:")) return originalFetch(pathname, init);
  const payload = pathname.includes("/chat/capabilities") ? { attachments: { image: { maxBytes: 10485760 } }, slash: false }
    : pathname.includes("/__api/status") ? { backends: [{ id: backendId, connected: true, info: { readyAgentIds: [agentId] } }] }
    : pathname.includes("/__api/backends") ? { backends: [{ id: backendId, surfaces: { agentHarness: true, chat: true } }] }
    : pathname.includes("/__api/models?") ? { models: [] }
    : pathname.includes("/archive") ? { archive: { supported: false, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}; images=${images().length}, loaded=${images().filter(loaded).length}`); await pause(25); }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const images = () => Array.from((document.querySelector('[data-testid="immersive-chat"]') ?? document.querySelector(".chat-thread") ?? document)
  .querySelectorAll<HTMLImageElement>("img.markdown-inline-image, .chat-att-row img, img[class*='attThumb']"))
  .filter(image => image.getClientRects().length > 0);
const normalChatVisible = () => !document.querySelector('[data-testid="immersive-chat"]') && !!document.querySelector(".chat-thread")?.getClientRects().length;
const loaded = (image: HTMLImageElement) => image.complete && image.naturalWidth > 0;
const snapshot = () => images().map(image => ({ alt: image.alt, loaded: loaded(image), width: image.getBoundingClientRect().width,
  naturalWidth: image.naturalWidth, scoped: new URL(image.src).searchParams.get("key") === key }));
state.runFixture = async () => {
  await wait(() => reads.includes(key) && images().length === 5 && images().every(loaded), "five native reply images load");
  const normal = snapshot();
  check(normal.every(image => image.scoped), "every local image carries the native session identity");
  check(normal.every(image => image.width <= Math.min(420, window.innerWidth)), "images fit the normal viewport");
  const source = images().find(image => image.alt === "宽图")!;
  source.scrollIntoView({ block: "center" });
  source.click(); await wait(() => document.querySelector(".chat-lightbox__img"), "click opens the image viewer");
  check((document.querySelector(".chat-lightbox__img") as HTMLImageElement).src === source.src, "image viewer uses the exact clicked source");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".chat-lightbox"), "Escape closes the image viewer");
  window.location.hash = `/chat?session=${encodeURIComponent(otherKey)}`;
  await wait(() => reads.includes(otherKey) && images().length === 0, "switching sessions removes the previous images");
  window.location.hash = `/chat?session=${encodeURIComponent(key)}`;
  await wait(() => images().length === 5 && images().every(loaded), "cached and reloaded history restores the images");
  const enter = document.querySelector<HTMLButtonElement>(`button[title='${i18n.t("chat.immersiveEnter")}']`)!;
  enter.click();
  await wait(() => !normalChatVisible() && images().length === 5 && images().every(loaded), "immersive reply images load");
  const immersive = snapshot();
  check(immersive.every(image => image.width <= Math.min(380, window.innerWidth)), "images fit the immersive viewport");
  images().find(image => image.alt === "宽图")!.click();
  await wait(() => document.querySelector(".chat-lightbox__img"), "immersive click opens the image viewer");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".chat-lightbox"), "immersive Escape closes the image viewer");
  const a = toSanitizedMarkdownHtml("![image](./relative.png)", true, { backendId, sessionKey: key });
  const b = toSanitizedMarkdownHtml("![image](./relative.png)", true, { backendId, sessionKey: otherKey });
  check(a !== b && a.includes(encodeURIComponent(key)) && b.includes(encodeURIComponent(otherKey)), "Markdown cache is isolated by session");
  const remote = toSanitizedMarkdownHtml("![remote](https://images.example.test/image.png)");
  check(remote.includes('<img') && remote.includes('referrerpolicy="no-referrer"'), "HTTPS images are renderable without referrers");
  for (const href of ["javascript:alert(1)", "file://evil.test/a.png", "//evil.test/a.png", "data:text/html;base64,PHNjcmlwdD4="])
    check(!toSanitizedMarkdownHtml(`![unsafe](<${href}>)`, true, { backendId, sessionKey: key }).includes("<img"), "unsafe image sources stay inert");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(normalChatVisible, "return to normal chat");
  return { passed: true, viewport: window.innerWidth, normal, immersive,
    checks: ["local/URL/relative/MEDIA images", "Chinese paths with spaces and parentheses", "real HTTP image bytes", "normal and immersive zoom/Escape",
      "session switching and history restore", "session-scoped Markdown cache", "HTTPS images and safe schemes", "responsive image bounds"] };
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
document.getElementById("run-checks")!.onclick = async () => {
  const status = document.getElementById("status")!;
  try { status.textContent = JSON.stringify(await state.runFixture()); } catch (error) { status.textContent = String(error); }
};
