import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

const scope = window as any;
scope.fixtureErrors = []; scope.fixtureCalls = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const now = Date.now();
const mainKey = "agent:main:main", otherKey = "agent:other:main";
const childKey = "agent:main:subagent:fixture-child", siblingKey = "agent:main:subagent:fixture-sibling";
const childRun = "child-run", parentRun = "parent-run";
const sessions: any[] = [
  { key: mainKey, agentId: "main", backendId: "openclaw", agentName: "虾长老 · 隔离测试", updatedAt: now },
  { key: otherKey, agentId: "other", backendId: "openclaw", agentName: "另一位助理 · 隔离测试", updatedAt: now - 1 },
  { key: childKey, agentId: "main", backendId: "openclaw", label: "配置执行器诊断", spawnedBy: mainKey,
    parentSessionKey: mainKey, status: "running", updatedAt: now },
  { key: siblingKey, agentId: "main", backendId: "openclaw", label: "网络可用性检查", spawnedBy: mainKey,
    parentSessionKey: mainKey, status: "running", updatedAt: now },
  { key: "agent:main:dashboard:ordinary", agentId: "main", backendId: "openclaw", label: "讨论子代理的普通会话", updatedAt: now - 2 },
];
const msg = (role: string, content: unknown, id: string, runId = parentRun) => ({
  role, content, timestamp: now - 1000, __openclaw: { id, runId },
});
const spawn = (key: string, id: string, label: string, run: string) => [
  msg("custom", [{ type: "toolCall", id, name: "sessions_spawn", arguments: { label, task: "只读检查环境" }, parentToolCallId: "outer" }], `${id}-call`),
  msg("custom", [{ type: "tool_result", toolCallId: id, name: "sessions_spawn",
    content: JSON.stringify({ status: "accepted", childSessionKey: key, runId: run }), parentToolCallId: "outer" }], `${id}-receipt`),
];
let mainHistory: any[] = [
  msg("user", "检查配置执行器和网络状态。", "u1"),
  ...spawn(childKey, "spawn-one", "配置执行器诊断", childRun),
  ...spawn(siblingKey, "spawn-two", "网络可用性检查", "sibling-run"),
  msg("assistant", "已安排两个子代理检查，进展会显示在这条对话中。", "yield"),
];
const histories = new Map<string, any[]>([
  [childKey, [msg("assistant", [{ type: "toolCall", id: "shared-id", name: "read", arguments: { path: "config.json" } }], "child-tool", childRun)]],
  [siblingKey, [msg("assistant", [{ type: "toolCall", id: "shared-id", name: "web_fetch", arguments: { url: "https://example.invalid/health" } }], "sibling-tool", "sibling-run")]],
]);
const hello = { protocol: 4, server: { version: "isolated-fixture" },
  auth: { role: "operator", scopes: ["operator.read", "operator.approvals", "operator.questions"] },
  features: { methods: ["sessions.messages.subscribe", "sessions.messages.unsubscribe", "exec.approval.list", "exec.approval.resolve", "question.list", "question.resolve"],
    events: ["session.message", "session.tool", "agent", "exec.approval.requested", "exec.approval.resolved", "question.requested", "question.resolved"], capabilities: [] },
  policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 } };
const query = new URLSearchParams(location.search);
const language = query.get("language") || "zh-CN";
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", mainKey);
localStorage.setItem("shoggoth.chat.immersive.v1", query.get("immersive") || "0");
void i18n.changeLanguage(language);
document.documentElement.dataset.theme = query.get("theme") || "light";

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  subscriptions = new Map<string, string>();
  constructor() {
    scope.fixtureSocket = this;
    setTimeout(() => { this.onopen?.(); setTimeout(() => this.emit("gateway.ready", hello), 20); }, 0);
  }
  emit(event: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ type: "event", event, payload }) }); }
  send(raw: string) {
    const frame = JSON.parse(raw); scope.fixtureCalls.push(frame);
    let payload: unknown = {};
    if (frame.method === "sessions.list") payload = { sessions, hasMore: false };
    if (frame.method === "agents.list") payload = { agents: sessions.slice(0, 2).map(s => ({ id: s.agentId, name: s.agentName, backendId: "openclaw" })) };
    if (frame.method === "models.list") payload = { models: [] };
    if (frame.method === "exec.approval.list") payload = [];
    if (frame.method === "question.list") payload = { questions: [] };
    if (frame.method === "exec.approval.resolve") payload = { ok: true };
    if (frame.method === "chat.history") payload = { hasMore: false, nextCursor: null, sourceId: frame.params.sessionKey,
      messages: frame.params.sessionKey === mainKey ? mainHistory : histories.get(frame.params.sessionKey) || [msg("user", "另一条独立对话", "other-user")] };
    if (frame.method === "sessions.messages.subscribe") { this.subscriptions.set(frame.params.key, frame.params.subscriptionId); payload = { subscribed: true }; }
    if (frame.method === "sessions.messages.unsubscribe" && this.subscriptions.get(frame.params.key) === frame.params.subscriptionId) this.subscriptions.delete(frame.params.key);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async input => {
  const url = new URL(String(input), location.origin);
  let payload: unknown = {};
  if (url.pathname === "/__api/plugins") payload = { page: { supported: true, catalogRevision: "a".repeat(64), items: [], nextCursor: null } };
  if (url.pathname === "/__api/plugins/bundled") payload = { batchDigest: "a".repeat(64), items: [] };
  if (url.pathname === "/__api/status") payload = { backends: [{ id: "openclaw", connected: true, info: { readyAgentIds: ["main", "other"] } }] };
  if (url.pathname === "/__api/backends") payload = { backends: [{ id: "openclaw", surfaces: { chat: true } }] };
  if (url.pathname === "/__api/models") payload = { models: [] };
  if (url.pathname === "/__api/chat/capabilities") payload = { attachments: {}, slash: false, maxPromptBytes: 61440 };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: "openclaw", cacheScope: "isolated-subagent-fixture" };
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
const expect = (value: unknown, label: string) => { if (!value) throw Error(label); };
const visible = <T extends Element>(items: Iterable<T>) => [...items].filter(item => item.getClientRects().length > 0);
const surface = () => document.querySelector('[data-testid="immersive-chat"]') ?? document;
const children = (key = childKey) => visible(surface().querySelectorAll<HTMLElement>(`[data-subagent-key="${key}"]`));
const navigate = (key: string) => window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
const expand = async () => {
  await wait(() => visible(surface().querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).some(button => /助理实时动态|Agent Steps/.test(button.textContent || "")), "parent timeline");
  for (const button of visible(surface().querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'))) {
    if (/助理实时动态|Agent Steps/.test(button.textContent || "")) button.click();
  }
};
Object.assign(window, { runSubagentPageFixture: async () => {
  await expand();
  await wait(() => children()[0]?.textContent?.includes("config.json"), "child history recovered under parent");
  expect(children().length === 1 && children(siblingKey).length === 1, "parallel child tasks appear once each");
  await wait(() => scope.fixtureSocket.subscriptions.has(mainKey) && scope.fixtureSocket.subscriptions.has(childKey), "parent and child must have explicit message subscriptions");
  const detail = () => children()[0];
  const pickerButton = surface().querySelector<HTMLButtonElement>(query.get("immersive") === "1" ? 'button[class*="identity"]' : '.chat-session-select');
  expect(pickerButton, "session picker must be available");
  pickerButton!.click();
  await wait(() => surface().querySelector('input[class*="pickerSearch"], .model-menu__search'), "session list opens");
  const picker = surface().querySelector('input[class*="pickerSearch"], .model-menu__search')!.parentElement!;
  const pickerList = query.get("immersive") === "1" ? picker : picker.parentElement!;
  expect(pickerList.textContent?.includes("讨论子代理的普通会话"), "ordinary conversations mentioning subagents stay visible");
  expect(!pickerList.textContent?.includes("配置执行器诊断") && !pickerList.textContent?.includes("网络可用性检查"), "child sessions are hidden from the actual picker");
  pickerButton!.click();
  const before = scope.fixtureCalls.length;
  navigate(childKey); await new Promise(resolve => setTimeout(resolve, 100));
  expect(children().length === 1, "hidden child deep link must preserve current parent");
  expect(!scope.fixtureCalls.slice(before).some((c: any) => c.method === "chat.history" && c.params.sessionKey === childKey), "hidden child links cannot open an independent history");

  scope.fixtureSocket.emit("exec.approval.requested", { id: "child-approval", createdAtMs: now, expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: childKey, agentId: "main", runId: childRun, command: "printf fixture-check",
      cwd: "/isolated/child", allowedDecisions: ["allow-once", "deny"] } });
  await wait(() => surface().querySelector('.chat-prompt--approval')?.textContent?.includes("fixture-check"), "hidden child approval is visible in parent");
  const approval = surface().querySelector('.chat-prompt--approval')!;
  const deny = [...approval.querySelectorAll<HTMLButtonElement>("button")].find(button => /拒绝|Deny/.test(button.textContent || ""));
  expect(deny, "child approval has a deny action"); deny!.click();
  await wait(() => !surface().querySelector('.chat-prompt--approval'), "child approval resolves in place");
  expect(scope.fixtureCalls.some((call: any) => call.method === "exec.approval.resolve" && call.params.id === "child-approval" && call.params.decision === "deny"), "approval response preserves original child request identity");
  scope.fixtureSocket.emit("question.requested", { id: "child-question", sessionKey: childKey, runId: childRun,
    status: "pending", createdAtMs: now, expiresAtMs: Date.now() + 60_000,
    questions: [{ questionId: "scope", header: "检查范围", question: "子代理需要确认检查范围", options: [] }] });
  await wait(() => surface().querySelector('.chat-prompt')?.textContent?.includes("子代理需要确认检查范围"), "child question appears in parent");
  scope.fixtureSocket.emit("question.resolved", { id: "child-question", status: "answered" });
  await wait(() => !surface().querySelector('.chat-prompt'), "externally resolved child question clears from parent");

  scope.fixtureSocket.emit("session.tool", { sessionKey: childKey, runId: childRun, data: {
    toolCallId: "live-query", name: "web_search", phase: "start", args: { query: "子代理实时查询" } } });
  await wait(() => detail()?.textContent?.includes("子代理实时查询"), "live child tool start");
  scope.fixtureSocket.emit("session.tool", { sessionKey: childKey, runId: childRun, data: {
    toolCallId: "live-query", name: "web_search", phase: "update", partialResult: "已检查两个配置项" } });
  const toolButton = visible(detail().querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("子代理实时查询"));
  toolButton?.click();
  await wait(() => detail()?.textContent?.includes("已检查两个配置项"), "live partial output");
  expect(!children(siblingKey)[0].textContent?.includes("子代理实时查询"), "sibling progress must be isolated");
  scope.fixtureSocket.emit("agent", { sessionKey: childKey, runId: childRun, stream: "item", seq: 1,
    data: { itemId: "child-preamble", kind: "preamble", phase: "update", progressText: "子代理公开进展：继续核对环境" } });
  await wait(() => detail()?.textContent?.includes("子代理公开进展：继续核对环境"), "public child preamble appears in parent activity");
  scope.fixtureSocket.emit("session.tool", { sessionKey: siblingKey, runId: "sibling-run", data: {
    toolCallId: "shared-id", name: "web_fetch", phase: "result", result: "连接正常" } });
  histories.set(siblingKey, [msg("assistant", "网络检查完成，连接正常。", "network-final", "sibling-run")]);
  sessions[3].status = "done"; sessions[3].updatedAt = now + 5000;
  scope.fixtureSocket.emit("chat", { sessionKey: siblingKey, runId: "sibling-run", state: "final" });
  scope.fixtureSocket.emit("agent", { sessionKey: childKey, runId: childRun, stream: "lifecycle", ts: now + 5000,
    data: { phase: "end", status: "timed_out", error: "子代理达到 240 秒时限" } });
  await wait(() => /超时|Timed out/.test(detail()?.textContent || ""), "explicit timeout");
  expect(!detail().querySelector('[data-running="1"]'), "terminal child must not retain a running tool animation");
  scope.fixtureSocket.emit("session.tool", { sessionKey: childKey, runId: childRun, data: {
    toolCallId: "live-query", phase: "update", partialResult: "迟到的进展不能复活任务" } });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(!detail().textContent?.includes("迟到的进展不能复活任务"), "late progress is ignored");

  navigate(otherKey);
  await wait(() => !children().length && scope.fixtureSocket.subscriptions.has(otherKey), "switch to unrelated conversation");
  expect(!scope.fixtureSocket.subscriptions.has(childKey), "switch releases child subscription");
  navigate(mainKey); await expand();
  await wait(() => children().length === 1, "return to parent");
  expect(/超时|Timed out/.test(detail().textContent || ""), "terminal status survives navigation");
  const childHead = detail().querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (childHead?.getAttribute("aria-expanded") === "false") childHead.click();

  histories.set(childKey, [msg("assistant", "已恢复：子任务超时前完成了环境检查。", "restored-child", childRun)]);
  scope.fixtureSocket.emit("gateway.ready", hello);
  await wait(() => detail()?.textContent?.includes("已恢复：子任务超时前完成了环境检查。"), "reconnect reads canonical child history");
  mainHistory = [...mainHistory, msg("assistant", "主助手已接续诊断，并保留子任务超时状态。", "parent-final", "parent-resumed")];
  scope.fixtureSocket.emit("session.message", { sessionKey: mainKey, message: mainHistory.at(-1) });
  await wait(() => document.body.innerText.includes("主助手已接续诊断"), "parent continuation remains visible");
  await expand();
  expect(children().length === 1, "parent refresh does not duplicate the child task");
  if (query.get("immersive") !== "1") {
    const composer = document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "/subagents ");
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await wait(() => document.body.innerText.includes("subagent:fixture-child") && document.body.innerText.includes("subagent:fixture-sibling"), "subagent control command still reads hidden records");
  }
  expect(!scope.fixtureCalls.some((call: any) => ["chat.send", "sessions.delete", "chat.abort"].includes(call.method)), "display must not replay, delete or stop tasks");
  expect(scope.fixtureErrors.length === 0, `UI errors: ${scope.fixtureErrors}`);
  return { immersive: query.get("immersive") === "1", language, passed: true, providerCalls: 0,
    subscriptions: scope.fixtureCalls.filter((call: any) => call.method === "sessions.messages.subscribe").length };
} });
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
