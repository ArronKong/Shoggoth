import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

const scenario = new URLSearchParams(location.search).get("scenario");
if (scenario !== "pending" && scenario !== "stale") throw Error("invalid fixture scenario");
const agentId = "shoggoth-selection-fixture";
const key = `agent:${agentId}:11111111-1111-4111-8111-111111111111`;
const selection = [{ installationId: "selected-fixture", revision: 1 }];
const sessions = [{ key, agentId, agentName: "Selection fixture", backendId: "shoggoth",
  model: "gpt-fixture", updatedAt: Date.now() }];
const sent: Array<Record<string, unknown>> = [];
const sockets = new Set<FixtureSocket>();
let resolveCatalog: ((response: Response) => void) | null = null;
let catalogRequests = 0;

localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
localStorage.setItem("shoggoth.chat.plugin-selection.v1", JSON.stringify({ [key]: selection }));
void i18n.changeLanguage("zh-CN");

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { sockets.add(this); setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: [{ id: agentId,
      name: sessions[0].agentName, backendId: sessions[0].backendId }] };
    if (frame.method === "models.list") payload = { models: [{ id: "gpt-fixture", name: "Fixture model",
      provider: "codex" }] };
    if (frame.method === "chat.history") payload = { messages: [] };
    if (frame.method === "chat.send") {
      sent.push(frame.params);
      if (sessions[0].backendId !== "shoggoth") {
        setTimeout(() => this.emit({ type: "res", id: frame.id, ok: false,
          error: { code: "PLUGIN_SELECTION_UNAVAILABLE", message: "Host binding unavailable" } }), 0);
        return;
      }
      // Proxy's early receipt is deliberately not a durable Service acceptance.
      payload = { status: "started" };
    }
    setTimeout(() => this.emit({ type: "res", id: frame.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; sockets.delete(this); }
}

Object.assign(window, { WebSocket: FixtureSocket });
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.startsWith("/avatar/")) return originalFetch(input, init);
  let payload: unknown = {};
  if (url.pathname === "/__api/plugins") {
    catalogRequests += 1;
    const page = { supported: true, catalogRevision: "a".repeat(64), nextCursor: null,
      items: [{ installationId: "selected-fixture", revision: scenario === "stale" ? 2 : 1,
        packageName: "Selected fixture", declaredVersion: "1.0.0", sourceKind: "bundled",
        desiredState: "enabled", diagnosticCount: 0,
        components: [{ componentId: "skill-fixture", kind: "skill", title: "Fixture skill", state: "ready" }] }] };
    const response = new Response(JSON.stringify({ page }),
      { headers: { "Content-Type": "application/json" } });
    if (scenario === "pending") return new Promise<Response>(resolve => { resolveCatalog = resolve; });
    return response;
  }
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: ["shoggoth", "openclaw"].map(id =>
    ({ id, connected: true, info: { readyAgentIds: [agentId] } })) };
  if (url.pathname === "/__api/backends") payload = { backends: ["shoggoth", "openclaw"].map(id =>
    ({ id, surfaces: { agentHarness: true, chat: true } })) };
  if (url.pathname === "/__api/models") payload = { models: [{ id: "gpt-fixture", name: "Fixture model",
    provider: "codex", backendId: "shoggoth" }] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false,
    maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/slash") payload = { supported: false, commands: [] };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: "shoggoth",
    cacheScope: "restored-selection-fixture" };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};

const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 7_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const input = () => document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
const setInput = async (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
};

Object.assign(window, { runRestoredSelectionFixture: async () => {
  const hasSelectedChip = () => Array.from(document.querySelectorAll<HTMLButtonElement>(
    'button[aria-haspopup="dialog"]')).some(button =>
    button.textContent?.startsWith("插件") && button.textContent.includes("· 1"));
  await wait(() => input() && hasSelectedChip(), "restored selection chip");
  await wait(() => catalogRequests > 0, "catalog request");
  if (scenario === "stale") {
    await wait(() => document.querySelector('[role="alert"]')?.textContent?.includes("所选插件已更新"),
      "stale selection warning");
  }
  await setInput("Use the selected fixture plugin");
  check(input().value === "Use the selected fixture plugin", "draft was not editable");
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click();
  if (scenario === "stale") {
    await new Promise(resolve => setTimeout(resolve, 100));
    check(sent.length === 0, "known-stale selection must be rejected before chat.send");
    check(input().value === "Use the selected fixture plugin", "known-stale choice must retain the draft");
    // The same session can be reclassified after roster recovery. A stale
    // Shoggoth catalog result must not govern an OpenClaw-owned send; the
    // Proxy remains the failure-closed authority for that foreign host.
    sessions[0].backendId = "openclaw";
    for (const socket of sockets) socket.emit({ type: "event", event: "agents.changed", payload: {} });
    await wait(() => document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]')?.disabled === true, "foreign picker disabled");
    document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click();
    await wait(() => sent.length === 1, "foreign selected send reaches Proxy guard");
    check(JSON.stringify(sent[0].pluginSelection) === JSON.stringify(selection),
      "backend switch lost the selected intent before Proxy could reject it");
    await wait(() => input().value.includes("Use the selected fixture plugin"), "foreign rejection restores draft");
    return { scenario, sent: sent.length, retainedDraft: true,
      foreignSelectionForwardedToProxy: true };
  }
  await wait(() => sent.length === 1, "selected chat.send");
  check(JSON.stringify(sent[0].pluginSelection) === JSON.stringify(selection),
    "restored choice was silently omitted from chat.send");
  check(hasSelectedChip(),
    "Proxy started must not clear the one-shot choice");
  resolveCatalog?.(new Response(JSON.stringify({ page: { supported: true,
    catalogRevision: "a".repeat(64), nextCursor: null,
    items: [{ installationId: "selected-fixture", revision: 1,
      packageName: "Selected fixture", declaredVersion: "1.0.0", sourceKind: "bundled",
      desiredState: "enabled", diagnosticCount: 0,
      components: [{ componentId: "skill-fixture", kind: "skill", title: "Fixture skill", state: "ready" }] }] } }),
    { headers: { "Content-Type": "application/json" } }));
  for (const socket of sockets) socket.emit({ type: "event", event: "chat", payload: {
    runId: sent[0].idempotencyKey, sessionKey: key, state: "accepted" } });
  await wait(() => !hasSelectedChip(), "accepted choice cleared");
  return { scenario, sent: sent.length, selection: sent[0].pluginSelection,
    clearedAfterAccepted: true };
} });

createRoot(document.getElementById("root")!).render(
  <HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>,
);
