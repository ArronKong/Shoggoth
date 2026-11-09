import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import McpApprovalInbox from "../../app/manage-ui/src/components/McpApprovalInbox";
import { MCP_CHANGE_EVENT } from "../../app/manage-ui/src/api/mcpConnectors";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __LIVE_RECOVERY_BACKEND__: string;
const backendId = __LIVE_RECOVERY_BACKEND__;
const agentId = backendId === "shoggoth" ? "shoggoth-default" : `${backendId}-fixture-a`;
const otherAgent = backendId === "shoggoth" ? "shoggoth-other" : `${backendId}-fixture-b`;
const key = `agent:${agentId}:fixture-a`, other = `agent:${otherAgent}:fixture-b`;
const now = Date.now(), state = window as any;
const sessions = [
  { key, agentId, backendId, agentName: "Fixture A", sessionId: "physical-a", updatedAt: now },
  { key: other, agentId: otherAgent, backendId, agentName: "Fixture B", sessionId: "physical-b", updatedAt: now - 1000 },
];
const user = { id: "seed-user", role: "user", content: "Initial A history", timestamp: now - 1000 };
const otherUser = { id: "other-user", role: "user", content: "Only B history", timestamp: now - 1000 };
const notes = ["先检查资料。", "第一项已经核对。", "第二项已经核对。", "现在检查最后一项。"];
const background = "切走以后仍然收到的完整说明。", partial = "切走以后仍在输出的正文。", final = "本轮检查已经完成。";
state.pendingMcp = []; state.resolutions = []; state.historyA = [user]; state.runId = "fixture-run";
localStorage.clear(); localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key); localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
class FixtureSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const r = JSON.parse(raw); let payload: any = {};
    if (r.method === "chat.history" && state.historyUnavailable) {
      setTimeout(() => this.emit({ type: "res", id: r.id, ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Fixture history temporarily unavailable" } }), 0);
      return;
    }
    if (r.method === "sessions.list") payload = { sessions, hasMore: false };
    if (r.method === "agents.list") payload = { agents: sessions.map(s => ({ id: s.agentId, name: s.agentName, backendId })) };
    if (r.method === "chat.history") payload = { messages: r.params.sessionKey === key ? state.historyA : [otherUser],
      ...(r.params.page ? { hasMore: false, nextCursor: null, sourceId: r.params.sessionKey } : {}) };
    if (r.method === "chat.send") { state.runId = r.params.idempotencyKey || state.runId; payload = { runId: state.runId }; }
    if (r.method === "chat.operation.get") payload = { status: "found", admissionAccepted: true,
      ...(backendId === "shoggoth" ? { stateAuthority: "native-service" } : {}),
      run: { id: r.params.idempotencyKey || r.params.runId || state.runId, status: state.runStatus || (state.completed ? "completed" : "running") } };
    setTimeout(() => this.emit({ type: "res", id: r.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url); let payload: unknown = { items: [], servers: [] };
  if (pathname.includes("/__api/chat/secrets/prepare")) {
    const body = JSON.parse(String(init?.body));
    if (typeof body.text !== "string" || typeof body.sessionKey !== "string" || typeof body.operationId !== "string") throw Error("invalid ordinary-input preparation fixture");
    return new Response(JSON.stringify({ text: body.text, references: [], version: 1 }), { headers: { "Content-Type": "application/json" } });
  }
  if (pathname.includes("/__api/status")) payload = { backends: [{ id: backendId, connected: true, info: { readyAgentIds: [agentId, otherAgent] } }] };
  else if (pathname.includes("/__api/backends")) payload = { backends: [] };
  else if (pathname.includes("runtime-models")) payload = { selection: { bindingId: "fixture-binding", runtime: "codex", model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] };
  else if (pathname.includes("/archive")) payload = { archive: { supported: false, segments: [] } };
  else if (pathname.includes("/mcp/approvals")) payload = { items: state.pendingMcp, generation: 1 };
  else if (pathname.includes("/mcp/approval-resolve")) {
    const body = JSON.parse(String(init?.body)); state.resolutions.push(body);
    await new Promise(resolve => setTimeout(resolve, 30));
    if (state.failResolveOnce) { state.failResolveOnce = false; return new Response(JSON.stringify({ error: { code: "MCP_CONNECTOR_REQUEST_FAILED" } }), { status: 503, headers: { "Content-Type": "application/json" } }); }
    state.pendingMcp = state.pendingMcp.filter((item: any) => item.requestId !== body.requestId);
    payload = { resolved: true, approved: body.approved };
  }
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await pause(15); }
};
const replies = () => Array.from(document.querySelectorAll(".chat-thread .is-assistant .chat-bubble:not(.is-activity-loading)"))
  .map(node => node.textContent?.replace(/●/g, "").trim()).filter(Boolean);
const emit = async (payload: any) => { state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: state.runId, ...payload } }); await frame(); await frame(); };
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
const select = async (name: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-agent")).find(node => node.textContent?.includes(name));
  check(button, `Agent ${name} exists`); button!.click();
  await wait(() => document.querySelector(".chat-agent.is-active")?.textContent?.includes(name), `select ${name}`);
  await frame(); await frame();
};
const approval = (id = "mcp-request", changes = {}) => ({ requestId: id, backendId, agentId, sessionId: "physical-a",
  toolName: "mcp_server_call", serverId: "composio", argumentsPreview: JSON.stringify({ serverId: "composio", toolName: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }] } }),
  argumentDigest: "a".repeat(64), reason: "检查 Gmail 连接状态", createdAt: now, expiresAt: Date.now() + 60000, ...changes });
const refreshMcp = () => window.dispatchEvent(new Event(MCP_CHANGE_EVENT));
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ChatPage /><McpApprovalInbox /></UiProvider></HashRouter>);
state.runLiveRecoveryFixture = async () => {
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes(user.content), "initial history");
  const input = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "请检查这些资料。");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => document.querySelector<HTMLButtonElement>(".chat-send")?.disabled === false, "send ready");
  document.querySelector<HTMLButtonElement>(".chat-send")!.click();
  await wait(() => document.querySelector(".chat-thread")?.textContent?.includes("请检查这些资料。"), "actual send");
  for (const text of notes) { await emit({ state: "delta", message: message(text) }); await emit({ state: "interim", message: message(text) }); }
  await emit({ state: "prompt", prompt: { kind: "approval", requestId: "runtime-old", command: "fixture-only", choices: ["once", "deny"] } });
  check(JSON.stringify(replies()) === JSON.stringify(notes), "four sealed progress messages are visible");
  await select("Fixture A");
  check(JSON.stringify(replies()) === JSON.stringify(notes), "sealed messages survive current session reselect");
  check(document.querySelectorAll(".chat-thread .chat-prompt--approval").length === 1, "runtime approval survives reselect");
  await select("Fixture B");
  await emit({ state: "delta", message: message(background) }); await emit({ state: "interim", message: message(background) });
  await emit({ state: "delta", message: message(partial) });
  await emit({ state: "promptExpire", requestId: "runtime-old" });
  await emit({ state: "prompt", prompt: { kind: "approval", requestId: "runtime-new", command: "updated-fixture-only", choices: ["once", "deny"] } });
  check(!document.querySelector(".chat-thread")?.textContent?.includes(background), "background text cannot enter another Agent's thread");
  const expected = [...notes, background, partial];
  for (let repeat = 0; repeat < 3; repeat++) {
    await select("Fixture A");
    check(JSON.stringify(replies()) === JSON.stringify(expected), "visible and background segments survive switching back without duplicates");
    check(document.querySelectorAll(".chat-thread .chat-prompt--approval").length === 1
      && document.querySelector(".chat-thread .chat-prompt")?.textContent?.includes("updated-fixture-only"), "only the current approval is restored");
    await select("Fixture B");
  }
  state.completed = true;
  state.historyA = [user, { id: "sent-user", role: "user", content: "请检查这些资料。", timestamp: now },
    ...[...notes, background, final].map((text, index) => ({ id: `canonical-${index}`, role: "assistant", content: text, timestamp: now + index + 1 }))];
  await emit({ state: "final", message: message(final) });
  await select("Fixture A");
  await wait(() => replies().includes(final), "final history after background completion");
  check(replies().filter(text => text === notes[0]).length === 1, "history handoff does not duplicate sealed messages");
  check(!document.querySelector(".chat-thread .chat-prompt--approval"), "terminal history retires runtime approvals");
  state.pendingMcp = [approval()]; refreshMcp();
  await wait(() => document.querySelector('.chat-thread [data-mcp-approval="mcp-request"]'), "MCP approval in its own conversation");
  check(!document.querySelector('[role="dialog"]'), "matching MCP request needs no global modal");
  check(!Array.from(document.querySelectorAll("button")).some(node => node.textContent?.includes("工具调用等待确认")), "inline approval has no duplicate global notice");
  await select("Fixture B");
  check(!document.querySelector(".chat-thread [data-mcp-approval]"), "MCP approval never appears under another Agent");
  const notice = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.includes("工具调用等待确认"));
  check(notice, "unmatched MCP approval keeps its global inbox"); notice!.click();
  await wait(() => document.querySelector('[role="dialog"] .chat-prompt--approval'), "global inbox uses the same approval card");
  await select("Fixture A");
  await wait(() => document.querySelector('.chat-thread [data-mcp-approval="mcp-request"]'), "MCP card returns with its owner");
  await wait(() => !document.querySelector('[role="dialog"]'), "global modal finishes closing when its request moves into the chat");
  state.failResolveOnce = true;
  document.querySelector<HTMLButtonElement>('.chat-thread [data-mcp-approval="mcp-request"] .is-primary')!.click();
  await wait(() => document.querySelector('.chat-thread [role="alert"]'), "failed approval response remains retryable");
  const allow = document.querySelector<HTMLButtonElement>('.chat-thread [data-mcp-approval="mcp-request"] .is-primary')!;
  allow.click(); allow.click();
  await wait(() => !document.querySelector('.chat-thread [data-mcp-approval="mcp-request"]'), "exact MCP request resolved");
  check(state.resolutions.length === 2, "failed attempt plus one retry; double click sends once");
  check(state.resolutions.every((value: any) => JSON.stringify(value) === JSON.stringify({ requestId: "mcp-request", argumentDigest: "a".repeat(64), approved: true })), "responses retain the exact request, argument digest and once-only decision");
  state.pendingMcp = [approval("denied")]; refreshMcp();
  await wait(() => document.querySelector('.chat-thread [data-mcp-approval="denied"]'), "denial request");
  Array.from(document.querySelectorAll<HTMLButtonElement>('.chat-thread [data-mcp-approval="denied"] button'))
    .find(button => button.textContent === "拒绝")!.click();
  await wait(() => !document.querySelector('.chat-thread [data-mcp-approval="denied"]'), "denial acknowledged");
  check(JSON.stringify(state.resolutions.at(-1)) === JSON.stringify({ requestId: "denied", argumentDigest: "a".repeat(64), approved: false }), "denial keeps the original broker identity");
  state.pendingMcp = [approval("expired", { expiresAt: Date.now() - 1 })]; refreshMcp(); await pause(100);
  check(!document.querySelector('[data-mcp-approval="expired"]'), "expired requests are not actionable");
  return { backendId, repeatedSwitches: 3, sealedAndBackgroundText: true, runtimeApproval: true, canonicalHandoff: true,
    scopedMcpCard: true, globalCardParity: true, failedApprovalRetry: true, exactDigest: true, denial: true, doubleClickSuppressed: true, errors: state.fixtureError || null };
};
state.runInterruptedTailFixture = async () => {
  await wait(() => document.querySelector(".chat-thread"), "chat mounted");
  state.pendingMcp = []; refreshMcp();
  await select("Fixture A");
  state.completed = false; state.runStatus = "running"; state.historyUnavailable = true;
  const sendMessage = async (text: string) => {
    const input = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")?.disabled === false, "next send ready");
    document.querySelector<HTMLButtonElement>(".chat-send")!.click();
    await wait(() => document.querySelector(".chat-stop") && document.querySelector(".chat-thread")?.textContent?.includes(text), "new turn running");
  };
  const tool = async (id: string) => {
    state.socket.emit({ type: "event", event: "session.tool", payload: { sessionKey: key, runId: state.runId,
      toolCallId: id, name: "browser_read", phase: "start", args: { description: id } } });
    await frame(); await frame();
  };
  const firstText = "磁盘故障前已经读取的正文。";
  await sendMessage("检查磁盘恢复后的旧轮次。");
  await emit({ state: "delta", message: message(firstText) });
  await tool("interrupted-browser-tool");
  check(document.querySelectorAll(".chat-thread .is-streaming").length === 1, "one original streaming bubble");
  // Lose final/error and canonical history together. Only the exact durable
  // operation receipt can end the previous generation after Service recovery.
  state.runStatus = "interrupted";
  state.socket.emit({ type: "event", event: "agents.changed", payload: {} });
  await wait(() => !document.querySelector(".chat-stop"), "terminal receipt releases generation controls");
  await wait(() => !document.querySelector(".chat-thread .is-streaming"), "terminal receipt also retires the old bubble");
  check(replies().includes(firstText), "partial text survives without canonical history");
  check(!document.querySelector(".chat-thread [data-chat-activity-preview][data-status='running']"), "the interrupted process stops pulsing");
  check(!document.querySelector(".chat-thread .chat-prompt"), "old prompts are not left actionable");
  state.runStatus = "running";
  await sendMessage("继续下一轮查询。");
  await emit({ state: "delta", message: message("新一轮独立输出。") });
  await tool("next-browser-tool");
  check(document.querySelectorAll(".chat-thread .is-streaming").length === 1, "only the new turn has a streaming bubble");
  check(document.querySelector(".chat-stop"), "the new active turn retains its stop button");
  check(replies().filter(text => text === firstText).length === 1, "old partial text appears once");
  check(document.querySelectorAll(".chat-thread [data-chat-activity-preview][data-status='running']").length === 1,
    "the current process cannot be mirrored into the old turn");
  return { backendId, missingTerminalEvent: true, unavailableHistory: true, oldBubbleRetired: true,
    partialTextPreserved: true, nextTurnHasOneBubble: true, nextTurnHasStop: true, errors: state.fixtureError || null };
};
state.captureMcpApproval = async (theme: string) => {
  document.documentElement.dataset.theme = theme;
  state.pendingMcp = [approval("capture")]; refreshMcp();
  await wait(() => document.querySelector('.chat-thread [data-mcp-approval="capture"]'), "capture approval");
  const card = document.querySelector<HTMLElement>('.chat-thread [data-mcp-approval="capture"]')!;
  card.scrollIntoView({ block: "center" }); await frame(); await frame();
  const actions = card.querySelector<HTMLElement>(".chat-prompt__actions")!;
  const composer = document.querySelector(".chat-composer")!;
  if (actions.getBoundingClientRect().bottom > composer.getBoundingClientRect().top) {
    await wait(() => document.querySelector(".chat-jump"), "covered approval actions offer jump to latest");
    document.querySelector<HTMLButtonElement>(".chat-jump")!.click();
    await wait(() => actions.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top, "approval actions are reachable above the composer");
  }
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    inline: !!card.querySelector(".chat-prompt--approval"), actionsReachable: actions.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top };
};
