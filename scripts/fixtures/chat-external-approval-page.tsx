import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

const scope = window as any;
scope.fixtureReads = [];
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const backendId = new URLSearchParams(location.search).get("backend") === "hermes"
  ? "hermes" : "openclaw";
const agentId = `${backendId}-fixture`;
const physicalSessionId = `physical-${backendId}-session`;
const key = `agent:${agentId}:${backendId === "hermes" ? physicalSessionId : "main"}`;
const toolCallId = `host-${backendId}-tool-call`;
const session = { key, agentId, backendId, sessionId: physicalSessionId,
  agentName: `${backendId} fixture`, label: "Approval round", updatedAt: Date.now() };
const now = Date.now();
const history = [
  { id: "user-one", role: "user", timestamp: now - 3000, content: [{ type: "text", text: "Use the plugin" }] },
  { id: "assistant-one", role: "assistant", timestamp: now - 2000,
    content: [{ type: "toolCall", id: toolCallId, name: "shoggoth_plugin_call",
      arguments: { serverId: "plugin.fixture", toolName: "echo" } },
    { type: "text", text: "The call finished." }] },
  { id: "tool-one", role: "toolResult", toolCallId, toolName: "shoggoth_plugin_call",
    timestamp: now - 1000, content: [{ type: "text", text: "fixture output" }] },
];

localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify([{
  ...session, sessionId: "stale-cached-physical-id" }]));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions: [session], hasMore: false };
    if (frame.method === "agents.list") payload = { agents: [{ id: agentId,
      name: session.agentName, backendId }] };
    if (frame.method === "models.list") payload = { models: [] };
    if (frame.method === "chat.history") payload = { messages: history };
    setTimeout(() => this.emit({ type: "res", id: frame.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.startsWith("/avatar/")) return originalFetch(input, init);
  let payload: unknown = {};
  if (url.pathname === "/__api/plugins/external-calls") {
    scope.fixtureReads.push(url.search);
    if (url.searchParams.get("backendId") !== backendId
      || url.searchParams.get("agentId") !== agentId
      || url.searchParams.get("sessionId") !== physicalSessionId
      || url.searchParams.get("toolCallId") !== toolCallId) {
      throw Error(`ChatPage used an untrusted host call identity: ${url.search}`);
    }
    payload = { items: [{ callId: "audit-one", backendId, agentId,
      sessionId: physicalSessionId, toolCallId, approvalOutcome: "approved",
      status: "confirmed" }], nextCursor: null };
  }
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true,
    catalogRevision: "a".repeat(64), items: [], nextCursor: null } };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: [{ id: backendId,
    connected: true, info: { readyAgentIds: [agentId] } }] };
  if (url.pathname === "/__api/backends") payload = { backends: [{ id: backendId,
    surfaces: { agentHarness: true, chat: true } }] };
  if (url.pathname === "/__api/models") payload = { models: [] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false,
    maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/slash") payload = { supported: false, commands: [] };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId,
    cacheScope: "approval-page-fixture" };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};

const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
Object.assign(window, { runExternalApprovalPageFixture: async () => {
  await wait(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .some(button => button.textContent?.includes("助理实时动态")), "turn process");
  if (scope.fixtureReads.some((query: string) => query.includes("stale-cached")))
    throw Error("cached physical session ID was used as authority");
  const process = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("助理实时动态"))!;
  if (process.getAttribute("aria-expanded") === "false") process.click();
  await wait(() => !!document.querySelector('[data-testid="external-plugin-call-outcome"]'),
    "exact host approval in chat round");
  const text = document.querySelector<HTMLElement>('[data-testid="external-plugin-call-outcome"]')!.textContent;
  if (!text?.includes("审批: 已允许一次") || !text.includes("Service 调用: 已完成"))
    throw Error(`inaccurate chat approval result: ${text}`);
  return { backendId, physicalSessionId, toolCallId, scopedReads: scope.fixtureReads,
    rendered: true, errors: scope.fixtureErrors };
} });

createRoot(document.getElementById("root")!).render(
  <HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>,
);
