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
const runId = `fixture-progress-run-${now}`;
const texts = ["我先确认当前配置，保留已完成的修改。", "备份已做好，正在检查剩余引用。", "检查已结束，现在整理处理结果。"];
const finalText = "处理完成，已保存检查结果。";
const user = { id: "u1", role: "user", timestamp: now - 3000, content: [{ type: "text", text: "请检查配置并逐步报告进度。" }] };
const paragraphText = (text: string, index: number) => index <= 2 && text === texts[index - 1]
  ? `${text}\n\n本步骤的详细检查结果已记录。` : text;
const canonical = (text: string, index: number, commentary = true) => {
  text = paragraphText(text, index);
  const segment = commentary && index <= 2;
  return {
    role: "assistant", timestamp: now + index * 1000,
    __openclaw: { id: `history-${index}`, runId },
    // Actual Gateway segment projections move identity out of textSignature.
    content: [{ type: "text", text, ...(commentary && !segment ? { textSignature: JSON.stringify({ v: 1, id: `item-${index}`, phase: "commentary" }) } : {}) }],
    ...(segment ? { openclawStreamFallback: { source: "segment", itemId: `item-${index}`, replacementText: text } } : {}),
  };
};
let history: any[] = [user];
let historyReads = 0;
const hello = { protocol: 4, server: { version: "fixture" },
  features: { methods: [], events: [], capabilities: [] },
  policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 } };
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", mainKey);
localStorage.setItem("shoggoth.chat.immersive.v1", new URLSearchParams(location.search).get("immersive") ?? "0");
localStorage.setItem("openclaw.theme", new URLSearchParams(location.search).get("theme") ?? "light");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
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
    if (frame.method === "chat.history") {
      historyReads++;
      payload = { hasMore: false, nextCursor: null, sourceId: frame.params.sessionKey,
        messages: frame.params.sessionKey === mainKey ? history : [user] };
    }
    if (frame.method === "exec.approval.list") payload = [];
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
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: "openclaw", cacheScope: `isolated-preamble-fixture-${now}` };
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
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const navigate = (key: string) => window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
const bubbles = () => {
  const immersive = document.querySelector('[data-testid="immersive-chat"]');
  return Array.from((immersive ?? document).querySelectorAll<HTMLElement>(immersive ? "[data-immersive-message]" : ".chat-bubble"))
    .filter(element => element.getClientRects().length > 0);
};
const matching = (text: string) => bubbles().filter(element => element.textContent?.includes(text));
const emit = (event: string, payload: unknown) => scope.fixtureSocket.emit(event, payload);
const preamble = (index: number, text: string, seq = index * 10, phase = "end", key = mainKey) => emit("agent", {
  sessionKey: key, runId, seq, ts: now + index * 1000, stream: "item",
  data: { kind: "preamble", itemId: `item-${index}`, phase, progressText: paragraphText(text, index).replace(/\s+/g, " ") },
});
Object.assign(window, { runOpenClawPreambleFixture: async () => {
  await wait(() => matching("请检查配置").length === 1, "initial history");
  await pause();
  const composer = () => document.querySelector<HTMLTextAreaElement>(".chat-conv textarea")!;
  const draft = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), value);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  };
  draft("尚未发送的测试草稿");
  await pause();
  const openReads = historyReads;
  navigate(mainKey);
  await wait(() => historyReads > openReads, "reopen same conversation history");
  await pause();
  expect(composer().value === "尚未发送的测试草稿", "reopening the active history must preserve the unsent draft");
  draft("");
  await pause();
  emit("chat", { sessionKey: mainKey, runId, state: "accepted" });
  preamble(1, "我先确认", 1, "update");
  await wait(() => matching("我先确认").length === 1, "FIRST preamble appears before any final answer");
  const first = matching("我先确认")[0];
  preamble(1, texts[0], 2);
  await wait(() => matching(texts[0]).length === 1, "full first snapshot replaces partial snapshot");
  expect(first === matching(texts[0])[0], "updating a preamble must preserve its DOM node");
  emit("agent", { sessionKey: mainKey, runId, stream: "tool", data: { toolCallId: "tool-1", name: "read", phase: "start", args: { path: "/fixture/config.json" } } });
  preamble(2, texts[1]);
  await wait(() => matching(texts[1]).length === 1, "SECOND preamble appears during tool activity");
  expect(matching(texts[0]).length === 1, "second preamble must preserve first");
  emit("agent", { sessionKey: mainKey, runId, stream: "tool", data: { toolCallId: "tool-1", name: "read", phase: "result", result: "fixture done" } });
  preamble(3, texts[2]);
  await wait(() => matching(texts[2]).length === 1, "THIRD preamble appears before final");
  expect(texts.every(text => matching(text).length === 1), "three separate progress bubbles");
  preamble(1, "过期内容，不应出现", 1, "update");
  preamble(9, "其他会话的进度", 90, "end", otherKey);
  await pause();
  expect(!matching("过期内容").length && !matching("其他会话").length, "stale snapshots and foreign sessions stay isolated");
  navigate(otherKey);
  await wait(() => matching("其他会话的进度").length === 1, "inactive owner recovers its progress on switch");
  navigate(mainKey);
  await wait(() => texts.every(text => matching(text).length === 1), "switch back preserves all progress");
  await pause(); // Let the session-open history request settle before the answer event.
  // Final can be readable before the history endpoint exposes commentary records.
  history = [user, canonical(finalText, 4, false)];
  emit("chat", { sessionKey: mainKey, runId, state: "delta", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
  await wait(() => matching(finalText).length === 1, "FOURTH final answer streams separately");
  expect(texts.every(text => matching(text).length === 1), "final delta cannot consume progress bubbles");
  const reads = historyReads;
  emit("chat", { sessionKey: mainKey, runId, state: "final", message: canonical(finalText, 4, false) });
  await wait(() => historyReads > reads, "terminal reload");
  await pause();
  expect([...texts, finalText].every(text => matching(text).length === 1), "history lag cannot remove unacknowledged progress");
  const projectedHistory = texts.map((text, i) => canonical(text, i + 1));
  history = [user, ...projectedHistory, canonical(finalText, 4, false)];
  const canonicalReads = historyReads;
  emit("session.message", { sessionKey: mainKey, message: canonical(finalText, 4, false) });
  await wait(() => historyReads > canonicalReads, "debounced canonical history reload");
  await wait(() => matching(texts[0]).some(element => Array.from(element.querySelectorAll("p"))
    .some(paragraph => paragraph.textContent?.startsWith("本步骤的详细检查结果已记录。"))), "canonical paragraph formatting replaces the flattened live snapshot");
  await pause();
  emit("gateway.ready", hello);
  await pause();
  preamble(1, "终止后的旧事件，不应复活", 999);
  await pause();
  const body = bubbles().map(element => element.textContent ?? "").join("\n");
  expect([...texts, finalText].every(text => matching(text).length === 1), "canonical reload and reconnect must not duplicate progress");
  expect(projectedHistory.slice(0, 2).every(message => !message.content[0].textSignature && message.openclawStreamFallback?.source === "segment"),
    "regression uses actual unsigned Gateway segment projections");
  expect([...texts, finalText].every(text => body.split(text).length === 2), "each commentary and answer occurs exactly once in the visible surface");
  expect(texts.every((text, i) => body.indexOf(text) < body.indexOf(i < 2 ? texts[i + 1] : finalText)), "progress retains chronological order");
  expect(!body.includes("终止后的旧事件"), "terminal run cannot reopen from a late preamble");
  expect(!scope.fixtureCalls.some((frame: any) => ["chat.send", "chat.respond", "exec.approval.resolve"].includes(frame.method)), "display recovery cannot replay work or answer approvals");
  expect(scope.fixtureErrors.length === 0, `UI errors: ${scope.fixtureErrors}`);
  return { immersive: new URLSearchParams(location.search).get("immersive") === "1", width: innerWidth,
    theme: document.documentElement.dataset.theme, passed: true, progression: [1, 2, 3, 4], errors: scope.fixtureErrors };
} });
createRoot(document.getElementById("root")!).render(
  <HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>,
);

// Manual source-only replay for the built-in browser; no real gateway is connected.
if (new URLSearchParams(location.search).has("preview")) {
  const controls = document.createElement("div");
  controls.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:5000;padding:12px;background:#1c2330;color:white;border-radius:12px;font:12px system-ui;box-shadow:0 3px 20px #0003";
  const label = document.createElement("div");
  label.textContent = "源码隔离回放 · 测试数据 · 0 / 4";
  label.style.marginBottom = "8px";
  const next = document.createElement("button");
  next.textContent = "显示下一条消息";
  next.style.cssText = "padding:6px 10px;border:0;border-radius:6px;cursor:pointer";
  let step = 0;
  next.onclick = () => {
    if (step === 0) emit("chat", { sessionKey: mainKey, runId, state: "accepted" });
    step++;
    if (step <= 3) preamble(step, texts[step - 1]);
    else {
      history = [user, ...texts.map((text, i) => canonical(text, i + 1)), canonical(finalText, 4, false)];
      emit("chat", { sessionKey: mainKey, runId, state: "final", message: canonical(finalText, 4, false) });
      next.disabled = true;
    }
    label.textContent = `源码隔离回放 · 测试数据 · ${step} / 4`;
  };
  controls.append(label, next);
  document.body.append(controls);
}
