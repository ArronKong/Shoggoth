import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

const scope = window as any;
scope.fixtureErrors = [];
scope.fixtureCalls = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const now = Date.now();
const mainKey = "agent:main:main";
const otherKey = "agent:other:main";
const sessions = [
  { key: mainKey, agentId: "main", backendId: "openclaw", sessionId: "physical-main", agentName: "虾长老 · 测试数据", updatedAt: now },
  { key: otherKey, agentId: "other", backendId: "openclaw", sessionId: "physical-other", agentName: "另一位助理 · 测试数据", updatedAt: now - 1 },
];
const approval = (id: string, sessionKey = mainKey, expiresAtMs = Date.now() + 60_000) => ({
  id, createdAtMs: now, expiresAtMs,
  request: { sessionKey, agentId: sessionKey === mainKey ? "main" : "other", runId: "fixture-run",
    command: `python3 -c 'print("${id}")'`, cwd: "/isolated/fixture",
    allowedDecisions: ["allow-once", "deny"],
    warningText: "自动审批请求超时，需要你确认后继续。", },
});
let pending = [approval("restored-on-open")];
let failNext = true;
const hello = { protocol: 4, server: { version: "fixture" },
  auth: { role: "operator", scopes: ["operator.read", "operator.approvals"] },
  features: { methods: ["exec.approval.list", "exec.approval.resolve"],
    events: ["exec.approval.requested", "exec.approval.resolved"], capabilities: [] },
  policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 } };

localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", mainKey);
localStorage.setItem("shoggoth.chat.immersive.v1", new URLSearchParams(location.search).get("immersive") ?? "0");
void i18n.changeLanguage("zh-CN");

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    scope.fixtureSocket = this;
    setTimeout(() => { this.onopen?.(); setTimeout(() => this.emit("gateway.ready", hello), 20); }, 0);
  }
  emit(event: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type: "event", event, payload }) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    scope.fixtureCalls.push(frame);
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: sessions.map(s => ({ id: s.agentId, name: s.agentName, backendId: "openclaw" })) };
    if (frame.method === "models.list") payload = { models: [] };
    if (frame.method === "chat.history") payload = { hasMore: false, nextCursor: null, sourceId: frame.params.sessionKey, messages: [
      { id: "u1", role: "user", timestamp: now - 3000, content: [{ type: "text", text: "只读比较一下助理的模型配置。" }] },
    ] };
    if (frame.method === "exec.approval.list") payload = pending;
    if (frame.method === "exec.approval.resolve") {
      if (failNext) {
        failNext = false;
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id,
          ok: false, error: { message: "测试连接短暂失败，请重试" } }) }), 120);
        return;
      }
      pending = pending.filter(entry => entry.id !== frame.params.id);
      payload = { ok: true };
    }
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async (input) => {
  const url = new URL(String(input), location.origin);
  let payload: unknown = {};
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true, catalogRevision: "a".repeat(64), items: [], nextCursor: null } };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: [{ id: "openclaw", connected: true, info: { readyAgentIds: ["main", "other"] } }] };
  if (url.pathname === "/__api/backends") payload = { backends: [{ id: "openclaw", surfaces: { chat: true } }] };
  if (url.pathname === "/__api/models") payload = { models: [] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false, maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: "openclaw", cacheScope: "isolated-exec-approval-fixture" };
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
const card = () => Array.from((document.querySelector('[data-testid="immersive-chat"]') ?? document).querySelectorAll<HTMLElement>(".chat-prompt--approval"))
  .find(element => element.getClientRects().length > 0);
const expect = (value: unknown, label: string) => { if (!value) throw Error(label); };
const navigate = (key: string) => window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
Object.assign(window, { runExecApprovalPageFixture: async () => {
  await wait(() => card()?.textContent?.includes("restored-on-open"), "cold-open approval card");
  const bounds = card()!.getBoundingClientRect();
  const visiblePoint = document.elementFromPoint(bounds.left + bounds.width / 2, Math.max(0, bounds.top) + 20);
  expect(bounds.height > 100 && bounds.top < window.innerHeight && card()!.contains(visiblePoint), "approval must be visible in the viewport, not clipped by its container");
  expect(!document.querySelector('.chat-bubble.is-streaming [role="status"]'), "waiting for approval must not show the running animation");
  expect(card()?.textContent?.includes("自动审批请求超时"), "review failure must be visible");
  expect(card()?.querySelectorAll("button").length === 2, "only once and deny are offered");
  const allow = () => card()!.querySelector<HTMLButtonElement>("button.is-primary")!;
  allow().click();
  await wait(() => !card(), "immediate dismissal");
  await wait(() => card()?.textContent?.includes("restored-on-open"), "failed response restores card");
  allow().click();
  await wait(() => !card(), "successful response removes card");
  const answers = scope.fixtureCalls.filter((frame: any) => frame.method === "exec.approval.resolve");
  expect(answers.length === 2 && answers.every((frame: any) => frame.params.id === "restored-on-open"
    && frame.params.decision === "allow-once"), "answer must use original approval identity and exact decision");

  const other = approval("other-session", otherKey);
  pending = [other];
  scope.fixtureSocket.emit("exec.approval.requested", other);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(!card(), "other session approval must not leak into the active conversation");
  navigate(otherKey);
  await wait(() => card()?.textContent?.includes("other-session"), "switch to approval owner");
  pending = [];
  scope.fixtureSocket.emit("exec.approval.resolved", { id: other.id, decision: "deny" });
  await wait(() => !card(), "another client resolving removes card");
  navigate(mainKey);
  await new Promise(resolve => setTimeout(resolve, 100));
  const live = approval("live-arrival");
  pending = [live];
  scope.fixtureSocket.emit("exec.approval.requested", live);
  await wait(() => card()?.textContent?.includes("live-arrival"), "live event displays immediately");
  pending = [approval("reconnected")];
  scope.fixtureSocket.emit("gateway.ready", hello);
  await wait(() => card()?.textContent?.includes("reconnected"), "reconnect replaces stale pending cards");
  pending = [];
  scope.fixtureSocket.emit("exec.approval.resolved", { id: "reconnected" });
  await wait(() => !card(), "resolved cleanup");
  scope.fixtureSocket.emit("exec.approval.requested", approval("expires-soon", mainKey, Date.now() + 200));
  await wait(() => card()?.textContent?.includes("expires-soon"), "short-lived approval");
  await wait(() => !card(), "expiry cleanup without a resolved event");
  expect(!scope.fixtureCalls.some((frame: any) => ["chat.send", "chat.respond"].includes(frame.method)), "approval must not send/replay a chat turn");
  expect(scope.fixtureErrors.length === 0, `UI errors: ${scope.fixtureErrors}`);
  return { immersive: new URLSearchParams(location.search).get("immersive") === "1", passed: true,
    errors: scope.fixtureErrors, responses: answers.map((frame: any) => frame.params) };
} });

createRoot(document.getElementById("root")!).render(
  <HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>,
);
