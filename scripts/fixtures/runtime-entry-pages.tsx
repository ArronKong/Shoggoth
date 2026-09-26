import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import AgentDefaultRuntime from "../../app/manage-ui/src/components/AgentDefaultRuntime";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Full production pages (no ChatPage testDeps). Only external I/O is mocked.
const preview = new URL(location.href).searchParams.has("preview");
const scope = window as any;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 8000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(20); }
};
const agentId = "shoggoth-agent-ui-entry";
const sessionKey = `agent:${agentId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const first = "11111111-1111-8111-8111-111111111111", second = "22222222-2222-8222-8222-222222222222";
const descriptors = FALLBACK_BACKEND_DESCRIPTORS.filter(item => item.id === "shoggoth").map(item => ({ ...item,
  surfaces: { ...item.surfaces, nativeCapacity: false } }));
const row = () => ({ key: sessionKey, backendId: "codex", agentId, agentName: "独立 Agent", displayName: preview ? "模型与 Runtime" : "Runtime 入口验收",
  kind: "direct", updatedAt: preview ? Date.now() : 123456, runtime: session.runtime, model: session.model });
let session = { sessionKey, revision: 1, bindingId: first, runtime: "codex", model: preview ? "gpt-5.4" : "shared-model", canSwitch: true, contextUsage: null };
const third = "33333333-3333-8333-8333-333333333333";
const bindings = [
  { id: first, runtime: "codex", name: "Codex" }, { id: second, runtime: "pi", name: "Pi" },
  { id: third, runtime: "deepseek-harness", name: "DeepSeek" },
].map(binding => ({ ...binding, runtimeAccountId: `native-${binding.runtime}-default-v1`, label: binding.name, enabled: true }));
const capabilities = { attachments: { image: {} }, slash: false, steer: false };
const candidates = () => bindings.map(binding => ({ bindingId: binding.id, support: { supported: true },
  adjustments: { clearModelOverride: false, permissionMode: binding.id === second ? "auto" : null } }));
const snapshot = () => ({ ...session, candidates: candidates() });
let conflictNext = false, conflicts = 0;
const previewModels: Record<string, string[]> = {
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
  pi: ["gpt-5.4", "claude-sonnet-4-6", "gemini-3.1-pro-preview"],
  "deepseek-harness": ["deepseek-v4-flash", "deepseek-v4-pro"],
};
const catalog = () => ({ selection: snapshot(), capabilities,
  runtimes: bindings.map(binding => ({ runtime: binding.runtime, name: binding.name, available: true, capabilities })),
  models: bindings.flatMap(binding => (preview ? previewModels[binding.runtime] : ["shared-model", `${binding.runtime}-fast`, ...Array.from({ length: 18 }, (_, i) => `${binding.runtime}-model-${i}`)]).map((id, index) => ({
    id, name: id, provider: binding.runtime, backendId: "shoggoth", runtime: binding.runtime, runtimeName: binding.name,
    bindingId: binding.id, isDefault: index === 0, reasoning: preview,
  }))) });
let bindingRevision = 1, defaultBindingId = first;
let writes: string[] = [];
const cfg = { disabledBackends: [] as string[], theme: "light", locale: "zh-CN", notifications: { chat: true, cron: true, task: true },
  gatewayUrl: "ws://127.0.0.1:1", token: "", hermesMode: "local", hermesRemotes: [], hermesKeepAlive: true, setupCompletedAt: 1 };
const accounts = ["codex", "pi"].map(runtime => ({ id: `native-${runtime}-default-v1`, runtime, kind: "native-user", sharedAgentCount: 1 }));
const bindingSnapshot = () => ({ bindings, revision: bindingRevision, defaultBindingId, canAdd: true });
scope.fetch = async (input: string, init?: RequestInit) => {
  const url = new URL(String(input), "http://fixture.invalid");
  const route = url.pathname;
  if (route.includes("runtime-bindings")) {
    if (preview && route.endsWith("/default") && init?.method === "POST") {
      const selected = bindings.find(binding => route.includes(binding.id)); check(selected, "known default Runtime");
      defaultBindingId = selected!.id; bindingRevision++;
      return Response.json({ ...bindingSnapshot(), binding: selected });
    }
    check(!init?.method || init.method === "GET", "Chat must never edit bindings or Agent defaults");
    return Response.json(bindingSnapshot());
  }
  if (route.includes("runtime-models")) {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (conflictNext) { conflictNext = false; conflicts++; session.revision++;
        return Response.json({ error: "会话已更新，请重试", code: "CHAT_SESSION_REVISION_CONFLICT" }, { status: 409 }); }
      check(body.revision === session.revision, "selection CAS");
      const choice = catalog().models.find(model => model.id === body.model && model.bindingId === body.bindingId);
      check(choice, "model belongs to selected CLI");
      if (choice!.bindingId === second && session.bindingId !== second) {
        check(body.acceptAdjustments === true, "model selection accepts target Runtime permission adjustment without a prompt");
      }
      session = { ...session, runtime: choice!.runtime, bindingId: choice!.bindingId, model: choice!.id, revision: session.revision + 1 };
      writes.push("model-select"); return Response.json(snapshot());
    }
    return Response.json(catalog());
  }
  if (route === "/__api/backends") return Response.json({ backends: descriptors });
  if (route === "/__api/config") {
    if (init?.method === "PUT") { Object.assign(cfg, JSON.parse(String(init.body))); writes.push("config"); }
    return Response.json({ config: cfg });
  }
  if (route === "/__api/status") return Response.json({ backends: [{ id: "shoggoth", name: "Shoggoth", connected: true, info: { readyAgentIds: [agentId] } }] });
  if (route === "/__api/runtime-status") return Response.json({ runtimes: ["codex", "claude-code", "pi", "grok-build", "antigravity", "deepseek-harness"].map(runtime => ({
    runtime, name: runtime, runtimeAccountId: `native-${runtime}-default-v1`, backendId: "shoggoth", enabled: preview ? ["codex", "pi", "deepseek-harness"].includes(runtime) : runtime !== "pi",
    releaseEnabled: runtime !== "claude-code", installation: runtime === "grok-build" ? "unavailable" : "available", serviceConnected: true,
  })) });
  if (route === "/__api/shoggoth/runtime-accounts") return Response.json({ accounts });
  if (route === "/__api/shoggoth/status") return Response.json({ error: "fixture service details unavailable" }, { status: 503 });
  if (route === "/__api/versions") return Response.json({ versions: [] });
  if (route === "/__api/self-updates") return Response.json({ backends: [] });
  if (route === "/__api/agents") return Response.json({ agents: [{ id: agentId, name: "独立 Agent", backendId: "shoggoth" }] });
  if (route === "/__api/models") return Response.json({ models: [] });
  return Response.json({ supported: false, items: [], messages: [], grants: [], sources: [], commands: [] });
};
class FixtureSocket {
  static OPEN = 1; readyState = 1; onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
  constructor() { setTimeout(() => this.onopen?.(), 20); }
  send(raw: string) {
    const request = JSON.parse(raw);
    check(!["chat.send", "sessions.patch", "sessions.delete"].includes(request.method), "no chat mutation during switch");
    const payload = request.method === "sessions.list" ? { sessions: [row()], hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: agentId, name: "独立 Agent" }] }
      : request.method === "chat.history" ? { messages: [{ role: "user", content: [{ type: "text", text: preview ? "我想在这个会话中试用不同 CLI 的模型。" : "保留这段历史" }] }] }
      : { models: [], commands: [], items: [], supported: false };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 10);
  }
  close() { this.readyState = 3; }
}
scope.WebSocket = FixtureSocket;
function Fixture() {
  const [settings, setSettings] = useState(false); scope.showSettings = setSettings;
  const [agentPage, setAgentPage] = useState(false);
  const [theme, setTheme] = useState("light");
  return <MemoryRouter initialEntries={[`/chat?backend=codex&session=${encodeURIComponent(sessionKey)}`]}><UiProvider>
    <ScrollbarProvider />
    {preview && <nav style={{ height: 44, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
      <span style={{ color: "var(--muted)", marginRight: "auto" }}>交互预览 · 示例模型目录</span>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => { setSettings(false); setAgentPage(false); }}>聊天</button>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => { setSettings(false); setAgentPage(true); }}>AI 助理</button>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => { setSettings(true); setAgentPage(false); }}>设置</button>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => { const next = theme === "light" ? "dark" : "light";
        cfg.theme = next; document.documentElement.dataset.theme = next; setTheme(next); }}>{theme === "light" ? "深色" : "浅色"}</button>
    </nav>}
    <main className="content" style={{ height: preview ? "calc(100vh - 44px)" : "100vh" }}>{settings ? <SettingsPage />
      : agentPage ? <div style={{ padding: 32, maxWidth: 700 }}><h2>AI 助理 · 独立 Agent</h2>
        <AgentDefaultRuntime backend="shoggoth" agentId={agentId} onChanged={() => {}} /></div> : <ChatPage />}</main>
  </UiProvider></MemoryRouter>;
}
await applyConfiguredLocale("zh-CN"); createRoot(document.getElementById("root")!).render(<Fixture />);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
const picker = () => document.querySelector<HTMLButtonElement>('[data-testid="immersive-chat"] .chat-model-menu > button')
  || document.querySelector<HTMLButtonElement>('.chat-model-menu > button');
const openModels = async () => {
  await wait(() => picker() && !picker()!.disabled, "model picker ready");
  if (!document.querySelector(".model-menu")) picker()!.click();
  await wait(() => button("Pi") && document.querySelector('.model-menu [role="option"]'), "connected CLI models loaded");
};
const choose = async (runtime: string, model = "shared-model") => {
  await openModels(); const tab = button(bindings.find(binding => binding.runtime === runtime)!.name);
  if (tab.getAttribute("aria-selected") !== "true") tab.click();
  await wait(() => document.querySelectorAll(".model-menu__label").length === 1
    && document.querySelector(".model-menu__label")?.textContent === bindings.find(binding => binding.runtime === runtime)!.name, "CLI tab applied");
  const option = [...document.querySelectorAll<HTMLButtonElement>('.model-menu [role="option"]')].find(item => item.title === model);
  check(option && !option.disabled, "available model directly selectable"); option!.click();
};
scope.runRuntimeEntryFixture = async () => {
  await openModels();
  check(!document.querySelector('button[aria-label="切换 Runtime"]'), "no separate Runtime button");
  check(!button("添加绑定") && !button("添加或管理运行环境"), "no binding workflow in Chat");
  check(!!button("全部") && !!button("Codex") && !!button("DeepSeek"), "CLI tabs reuse existing menu");
  check(!button("Claude Code") && !button("Grok Build"), "disconnected or unavailable CLIs absent");
  check(document.querySelectorAll('.model-menu [role="option"][aria-selected="true"]').length === 1, "same model ID selects only current CLI");
  await choose("pi"); await wait(() => session.runtime === "pi" && !document.querySelector(".model-menu"), "select model switches Runtime");
  check(!document.querySelector('[role="alertdialog"]'), "model switch has no confirmation dialog");
  await pause(100); await choose("codex"); await wait(() => session.runtime === "codex", "same model on another CLI switches back");
  await pause(100); await openModels(); conflictNext = true;
  await choose("deepseek-harness", "deepseek-harness-fast");
  await wait(() => conflicts === 1 && document.body.textContent?.includes("会话已更新"), "CAS conflict visible");
  check(session.runtime === "codex" && session.model === "shared-model", "failed selection has no partial switch");
  await pause(100); await choose("deepseek-harness", "deepseek-harness-fast");
  await wait(() => session.runtime === "deepseek-harness", "refresh allows retry");
  check(bindingSnapshot().defaultBindingId === first && bindings.length === 3, "Agent default and automatic bindings unchanged");
  check(writes.join(",") === "model-select,model-select,model-select", "only atomic model selections");
  await wait(() => document.body.textContent?.includes("独立 Agent") && document.body.textContent?.includes("保留这段历史"), "identity and transcript preserved");
  cfg.disabledBackends = ["pi"]; scope.showSettings(true);
  await wait(() => document.querySelectorAll('#settings-local-runtimes [data-runtime]').length === 6, "six CLIs in full Settings");
  check(document.querySelector('[data-runtime="pi"]')!.textContent?.includes("已断开"), "Pi stays disabled");
  check(document.querySelector('[data-runtime="claude-code"]')!.textContent?.includes("此版本暂未开放"), "release gate visible");
  check(document.querySelector('[data-runtime="grok-build"]')!.textContent?.includes("未安装"), "unavailable CLI visible");
  check(document.querySelector('[data-runtime="codex"]')!.textContent?.includes("已就绪"), "ready CLI visible");
  return { fullChatPage: true, fullSettingsPage: true, modelSelectsRuntime: true, agentDefaultUnchanged: true,
    duplicateModelIdentity: true, conflictRetry: true, cliRows: 6, writes: writes.length };
};
scope.checkRuntimeEntryGeometry = async (theme: string) => {
  cfg.theme = theme; document.documentElement.dataset.theme = theme; await pause(100);
  check(document.documentElement.scrollWidth <= innerWidth + 1, "Settings horizontal overflow");
  for (const row of document.querySelectorAll<HTMLElement>('#settings-local-runtimes [data-runtime]')) {
    const rect = row.getBoundingClientRect(); check(rect.width > 0 && rect.right <= innerWidth + 1, "CLI row inside viewport");
  }
  scope.showSettings(false); await openModels(); await pause(200);
  const rect = document.querySelector<HTMLElement>(".model-menu")!.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0, "model menu inside viewport");
  const search = document.querySelector<HTMLInputElement>('.model-menu__search')!;
  search.focus(); check(document.activeElement === search, "search keyboard focus");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "fast");
  search.dispatchEvent(new Event("input", { bubbles: true })); await pause(50);
  check(document.querySelectorAll('.model-menu [role="option"]').length === 3, "search across CLI models");
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await pause(50);
  check(!document.querySelector('.model-menu') && document.activeElement === picker(), "Escape closes menu and restores focus");
  await openModels(); button("Codex").click(); await pause(50);
  const list = document.querySelector<HTMLElement>(".model-menu__list")!;
  list.scrollTop = list.scrollHeight; check(list.scrollTop > 0, "model list scrolls");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await pause(50);
  scope.showSettings(true); await wait(() => document.querySelectorAll('#settings-local-runtimes [data-runtime]').length === 6, "Settings remount");
  return { width: innerWidth, theme, overflow: false, modelMenuVisible: true, searchAndScroll: true };
};
scope.prepareChatCapture = async () => {
  scope.showSettings(false); await openModels(); await pause(250);
};
scope.checkImmersiveRuntime = async () => {
  scope.showSettings(true); await pause(50); localStorage.setItem("shoggoth.chat.immersive.v1", "1"); scope.showSettings(false);
  await wait(() => document.querySelector('[data-testid="immersive-chat"] .chat-model-menu'), "immersive model picker");
  await openModels(); await pause(200);
  const menu = document.querySelector<HTMLElement>(".model-menu")!; const rect = menu.getBoundingClientRect();
  check(menu.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), "model menu on top");
  document.querySelector('.model-menu__search')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await pause(100);
  check(!!document.querySelector('[data-testid="immersive-chat"]') && !document.querySelector('.model-menu'), "Escape retains immersive");
  await choose("pi"); await wait(() => session.runtime === "pi", "immersive uses same selection path");
  check(bindingSnapshot().defaultBindingId === first, "immersive selection preserves Agent default");
  return { immersiveModelPicker: true, selectionWorks: true, menuOnTop: true, escapeRetainsImmersive: true };
};

if (preview) {
  document.title = "Shoggoth · 模型与 Runtime 预览";
  void wait(() => picker() && !picker()!.disabled, "preview model picker").then(async () => {
    await wait(() => document.querySelector('.chat-thread'), "preview chat loaded");
    picker()!.click();
  }).catch(error => scope.fixtureErrors.push(String(error)));
}
