import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Production ChatPage with isolated transports. /new returns only its canonical
// key; the empty session is deliberately omitted from sessions.list until asked.
const agents = [
  { id: "shoggoth-61ccd39b-7a29-8bbc-a47c-3af127d719b8", name: "溪桥", backendId: "shoggoth" },
  { id: "shoggoth-f8a76c25-bd49-4c12-9d63-7b7d1eb1d0a4", name: "Shoggoth", backendId: "shoggoth" },
  { id: "ada", name: "Product", backendId: "openclaw" },
  { id: "main", name: "CEO", backendId: "openclaw" },
  { id: "codex-c79e0e41-2c12-8cc9-978b-aa7882d56be4", name: "星帆", backendId: "codex" },
  { id: "deepseek-harness-2031c7ed-e75e-8a61-8cf4-ea24551b3887", name: "晴川", backendId: "deepseek-harness" },
  { id: "shoggoth-grok", name: "Grok", backendId: "grok-build" },
  { id: "shoggoth-antigravity", name: "Antigravity", backendId: "antigravity" },
  { id: "shoggoth-pi", name: "Pi", backendId: "pi" },
  { id: "hermes-bull", name: "bull", backendId: "hermes" },
];
type Row = { key: string; agentId: string; agentName?: string; backendId: string; model: string; modelProvider: string; updatedAt: number };
const parents: Row[] = agents.map((agent, index) => ({
  key: `agent:${agent.id}:main`, agentId: agent.id, agentName: agent.name,
  backendId: agent.backendId, model: "fixture-model", modelProvider: agent.backendId,
  updatedAt: Date.now() - index * 60_000,
}));
const created: Row[] = [];
const requests: unknown[] = [];
let listCreated = false;
let rosterMode: "current" | "failed" | "delayed" = "current";
let publish = () => {};
const sockets = new Set<FixtureSocket>();
const realFetch = window.fetch.bind(window);
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(parents));
localStorage.setItem("shoggoth.chat.lastActive.v1", parents[0].key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");

class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { sockets.add(this); setTimeout(() => this.onopen?.(), 0); }
  send(raw: string) {
    const request = JSON.parse(raw);
    let payload: unknown = {};
    if (request.method === "sessions.list") {
      payload = { sessions: [...parents, ...(listCreated ? created : [])], hasMore: false };
    }
    if (request.method === "agents.list") payload = { agents };
    if (request.method === "models.list") payload = { models: [{ id: "fixture-model", name: "Fixture model", provider: "openclaw" }] };
    if (request.method === "sessions.create") {
      const source = [...parents, ...created].find(row => row.key === request.params.parentSessionKey);
      if (!source || source.agentId !== request.params.agentId) throw Error("Wrong parent/agent routing");
      const key = `agent:${source.agentId}:${crypto.randomUUID()}`;
      created.push({ key, agentId: source.agentId, backendId: source.backendId,
        model: request.params.model, modelProvider: request.params.modelProvider, updatedAt: Date.now() });
      requests.push({ method: request.method, ...request.params, returnedKey: key });
      payload = { key };
      publish();
    }
    if (request.method === "chat.history") {
      const old = parents.find(row => row.key === request.params.sessionKey);
      payload = { messages: old ? [{ id: `${old.agentId}-history`, role: "assistant",
        content: `${old.agentName} 的旧会话内容保留。`, timestamp: old.updatedAt }] : [] };
    }
    if (request.method === "chat.send") throw Error("This identity test must not send a model prompt");
    const failed = request.method === "agents.list" && rosterMode === "failed";
    const delay = request.method === "agents.list" && rosterMode === "delayed" ? 600 : 0;
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id,
      ok: !failed, ...(failed ? { error: { message: "Fixture roster offline" } } : { payload }) }) }), delay);
  }
  close() { this.readyState = 3; sockets.delete(this); }
}
Object.assign(window, { WebSocket: FixtureSocket });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (url.pathname.startsWith("/avatar/")) return realFetch(input, init);
  let payload: unknown = {};
  if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(({ id }) => ({
    id, connected: true, info: { readyAgentIds: agents.filter(a => a.backendId === id).map(a => a.id) },
  })) };
  if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  if (url.pathname === "/__api/models") payload = { models: [{ id: "fixture-model", name: "Fixture model", provider: url.searchParams.get("backend") }] };
  if (url.pathname === "/__api/agents") payload = { agents };
  if (url.pathname === "/__api/chat/capabilities") payload = { slash: true, attachments: {} };
  if (url.pathname === "/__api/chat/slash") payload = { supported: true, commands: [] };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: url.searchParams.get("backend"), cacheScope: "identity-fixture" };
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const refresh = () => {
  for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ type: "event", event: "agents.changed", payload: {} }) });
  publish();
};
const errors: string[] = [];
window.addEventListener("error", event => { errors.push(event.message); publish(); });
window.addEventListener("unhandledrejection", event => { errors.push(String(event.reason)); publish(); });

function Preview() {
  const [, rerender] = useState(0);
  publish = () => rerender(value => value + 1);
  return <>
    <details style={{ padding: "8px 24px", fontSize: 12 }}>
      <summary>新会话名称回归 · 隔离测试数据 · 已创建 {created.length} 个会话</summary>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: 8 }}>
        <button onClick={() => { listCreated = false; refresh(); }}>刷新：列表遗漏新会话</button>
        <button onClick={() => { listCreated = true; refresh(); }}>刷新：新会话入列但无名称</button>
        <button onClick={() => { rosterMode = "failed"; refresh(); }}>名称请求失败</button>
        <button onClick={() => { rosterMode = "delayed"; refresh(); }}>名称请求延迟</button>
        <button onClick={() => { rosterMode = "current"; agents[0].name = "溪桥更新"; refresh(); }}>测试助理改名</button>
        <Link to={`/chat?backend=shoggoth&session=${encodeURIComponent(parents[0].key)}`}>打开溪桥旧会话</Link>
      </div>
      <output data-testid="identity-fixture-state" style={{ display: "block", maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {JSON.stringify({ listCreated, rosterMode, requests, errors }, null, 2)}
      </output>
    </details>
    <div style={{ flex: 1, minHeight: 0, padding: "0 24px" }}><ChatPage /></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><Preview /></UiProvider></HashRouter>);
