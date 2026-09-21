import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// Real ChatPage and image loading; all data and uploads belong to this fixture.
const state = window as any;
const sessions = Array.from({ length: 22 }, (_, index) => ({
  key: `agent:fixture-${index}:main`, agentId: `fixture-${index}`,
  agentName: `测试助手 ${index + 1}`, updatedAt: 1_700_000_000_000 - index * 60_000,
}));
const messages = Array.from({ length: 12 }, (_, index) => ({
  id: `message-${index}`, role: "assistant", content: `已加载的聊天内容 ${index + 1}。\n\n切回前台时保留头像、草稿和滚动位置。`,
}));
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", sessions[0].key);
void i18n.changeLanguage("zh-CN");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: sessions.map((row) => ({ id: row.agentId, name: row.agentName })) }
      : request.method === "chat.history" ? { messages } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
const localFetch = window.fetch.bind(window);
let statusCalls = 0;
let failStatus = false;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.startsWith("/avatar/")) return localFetch(pathname, init);
  if (pathname === "/__api/status") {
    statusCalls++;
    if (failStatus) throw Error("Fixture status unavailable");
  }
  const payload = pathname === "/__api/status" ? { backends: [{ id: "openclaw", connected: true }] }
    : pathname === "/__api/backends" ? { backends: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason); });
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
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const avatars = () => Array.from(document.querySelectorAll<HTMLElement>("[data-avatar-state]"));
const images = () => avatars().map((avatar) => avatar.querySelector("img")!);
const loaded = () => avatars().length >= 23 && avatars().every((avatar) => avatar.dataset.avatarState === "loaded");
const imageRequests = () => performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).pathname.startsWith("/avatar/")).length;
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

state.runFixture = async () => {
  await wait(() => loaded() && document.querySelectorAll(".chat-bubble").length === messages.length, "loaded avatars and history");
  await pause(300);
  const input = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "未发送的草稿");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await frame(); await frame();
  const thread = document.querySelector<HTMLElement>(".chat-thread")!;
  thread.scrollTop = 100;
  await frame(); await frame();

  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });
  const results: object[] = [];
  const checkReturn = async (kind: "focus" | "visibility" | "both", label: string) => {
    const before = avatars();
    const beforeImages = images();
    const sources = beforeImages.map((img) => img.src);
    const bubbles = Array.from(document.querySelectorAll(".chat-bubble"));
    const scrollTop = thread.scrollTop;
    const requests = imageRequests();
    const statuses = statusCalls;
    if (kind !== "visibility") window.dispatchEvent(new Event("blur"));
    if (kind !== "focus") {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await frame();
    if (kind !== "focus") {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (kind !== "visibility") window.dispatchEvent(new Event("focus"));
    await frame(); await frame();
    const remounted = before.filter((avatar, index) => avatar !== avatars()[index]).length;
    const loading = avatars().filter((avatar) => avatar.dataset.avatarState !== "loaded").length;
    check(remounted === 0 && loading === 0, `${label}: ${remounted} avatars remounted, ${loading} avatars lost their loaded image`);
    await pause(200); // Covers the fixture's delayed avatar responses and async status refresh.
    check(beforeImages.every((img, index) => img === images()[index] && img.src === sources[index]), `${label}: image nodes and URLs stay stable`);
    check(imageRequests() === requests, `${label}: no new avatar requests`);
    check(statusCalls > statuses, `${label}: backend status still refreshes`);
    check(bubbles.every((bubble, index) => bubble === document.querySelectorAll(".chat-bubble")[index]), `${label}: history nodes stay mounted`);
    check(input.value === "未发送的草稿" && Math.abs(thread.scrollTop - scrollTop) < 1, `${label}: draft and scroll position are preserved`);
    results.push({ label, avatars: before.length, remounted, newImageRequests: imageRequests() - requests });
  };
  await checkReturn("focus", "switch apps");
  await checkReturn("visibility", "restore visibility");
  for (let cycle = 0; cycle < 3; cycle++) await checkReturn("both", `repeat return ${cycle + 1}`);
  failStatus = true;
  await checkReturn("both", "status probe fails");
  failStatus = false;

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  await wait(() => avatars().length > 23 && loaded(), "immersive avatar loaded");
  await checkReturn("both", "immersive return");
  document.querySelector<HTMLButtonElement>(`[data-testid="immersive-chat"] [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "exit immersive");

  // A real PNG travels through the existing resize/upload handler into the
  // fixture server's memory, then replaces the list and header images.
  const beforeUpload = images().map((img) => img.src);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
  const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
  const transfer = new DataTransfer();
  transfer.items.add(new File([png], "fixture.png", { type: "image/png" }));
  const picker = document.querySelector<HTMLInputElement>(".avatar-edit input")!;
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => loaded() && images().every((img, index) => img.src !== beforeUpload[index]), "successful upload refreshes avatars");
  check(images().filter((img) => new URL(img.src).pathname === "/avatar/fixture-0").every((img) => img.naturalWidth === 768), "header and list show the uploaded PNG");
  await checkReturn("both", "return after upload");

  const beforeRoute = images().map((img) => img.src);
  window.location.hash = "/agents";
  await pause(100);
  window.location.hash = "/chat";
  await wait(() => loaded() && images().every((img, index) => img.src !== beforeRoute[index]), "return from Agent management still refreshes avatars");
  delete (document as any).visibilityState;
  delete (document as any).hidden;
  return { passed: true, returns: results, uploadUpdatesHeaderAndList: true, managementRouteRefresh: true };
};
