import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// Real ChatPage with isolated data. History is projected by the production
// Service/Backend on this preview server; no model or installed backend is used.
const state = window as any;
const backend = new URLSearchParams(location.search).get("backend") || "hermes";
const agentId = backend === "hermes" ? "hermes-fixture" : backend === "openclaw" ? "main" : "shoggoth-fixture";
const key = `agent:${agentId}:inspiration-display`;
const name = backend === "hermes" ? "owl" : backend === "openclaw" ? "OpenClaw" : "Shoggoth";
const sessions = [{ key, agentId, agentName: name, backendId: backend, displayName: "灵感 · RSI 学习卡片", updatedAt: Date.now() }];
const realFetch = window.fetch.bind(window);
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  async send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: agentId, name }] }
      : request.method === "chat.history" ? await (await realFetch(`/fixture-history?backend=${backend}`)).json() : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const pathname = String(url);
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: backend, connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: [] }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
