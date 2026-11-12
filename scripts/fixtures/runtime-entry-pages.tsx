import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import AgentsPage from "../../app/manage-ui/src/pages/AgentsPage";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { AgentManagedFile } from "../../app/manage-ui/src/types";
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
// Settings lists local CLIs in the Shoggoth card's dialog.
const openLocalRuntimes = async () => {
  await wait(() => document.querySelector('[data-manage="shoggoth"]'), "Shoggoth local tools entry");
  if (!document.querySelector("#settings-local-runtimes")) document.querySelector<HTMLButtonElement>('[data-manage="shoggoth"]')!.click();
};
const agentId = "shoggoth-agent-ui-entry";
const occupiedName = "已有助理";
let agentName = "独立 Agent";
const artifactName = "Private report.txt";
const artifactPath = `/fixture/workspace/${artifactName}`;
let artifactReads = 0;
let revealedPath: string | undefined;
let managedFile: AgentManagedFile | null = null;
let failManagedRead = false;
const managedId = "f".repeat(64);
const managedBytes = "Private file fixture text";
const managedRoute = `/__api/agents/${agentId}/managed-files`;
const managedPath = () => `/fixture/agents/${agentId}/files/${managedId}/${managedFile?.name}`;
const filesTime = Date.now();
const day = 24 * 60 * 60 * 1000;
const managedSamples: AgentManagedFile[] = Array.from({ length: 21 }, (_, index) => ({
  fileId: String(index).padStart(64, "0"),
  profileId: agentId,
  name: index === 0 ? "Agent-workspace-notes-with-a-long-filename-for-narrow-layout.md" : `Agent notes ${index}.md`,
  mimeType: "text/markdown", sizeBytes: 2048, sha256: "a".repeat(64), status: index === 1 ? "missing" : "available",
  revision: 1, createdAt: filesTime - (index + 1) * day, updatedAt: filesTime - (index + 1) * day,
  source: { kind: "chat", runId: "fixture-run", sourceId: "fixture-source", sessionKey: null },
}));
const sessionKey = `agent:${agentId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const first = "11111111-1111-8111-8111-111111111111", second = "22222222-2222-8222-8222-222222222222";
const descriptors = FALLBACK_BACKEND_DESCRIPTORS.filter(item => item.id === "shoggoth").map(item => ({ ...item,
  surfaces: { ...item.surfaces, nativeCapacity: false, agentFiles: true } }));
const row = () => ({ key: sessionKey, backendId: "shoggoth", agentId, agentName: "独立 Agent", displayName: preview ? "模型与 Runtime" : "Runtime 入口验收",
  kind: "direct", updatedAt: preview ? Date.now() : 123456, runtime: session.runtime, model: session.model });
let session = { sessionKey, revision: 1, bindingId: first, runtime: "codex", model: preview ? "gpt-5.4" : "shared-model", canSwitch: true, contextUsage: null };
const third = "33333333-3333-8333-8333-333333333333";
const bindings = [
  { id: first, runtime: "codex", name: "Shoggoth" }, { id: second, runtime: "pi", name: "Pi" },
  { id: third, runtime: "deepseek-harness", name: "DeepSeek" },
].map(binding => ({ ...binding, runtimeAccountId: binding.id === first ? "shoggoth-internal-codex-default-v1"
  : `native-${binding.runtime}-default-v1`, label: binding.name, enabled: true }));
const expectedRuntimeRows = 5;
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
  runtimes: bindings.map(binding => ({ runtime: binding.runtime, bindingId: binding.id, name: binding.name, available: true, capabilities })),
  models: bindings.flatMap(binding => (preview ? previewModels[binding.runtime] : ["shared-model", `${binding.runtime}-fast`, ...Array.from({ length: 18 }, (_, i) => `${binding.runtime}-model-${i}`)]).map((id, index) => ({
    id, name: id, provider: binding.runtime, backendId: "shoggoth", runtime: binding.runtime, runtimeName: binding.name,
    bindingId: binding.id, isDefault: index === 0, reasoning: preview,
  }))) });
let bindingRevision = 1, defaultBindingId = first;
let defaultModel = preview ? "gpt-5.4" : "shared-model";
let defaultProvider: string | undefined = "@chatgpt", defaultReject = false, defaultReads = 0, defaultWrites = 0;
const agentDetail = () => ({ id: agentId, name: agentName, backendId: "shoggoth", profile: agentId,
  model: defaultModel, provider: defaultProvider === "@chatgpt" ? "ChatGPT" : defaultProvider ?? "pi",
  runtime: bindings.find(binding => binding.id === defaultBindingId)!.runtime,
  environmentKind: defaultBindingId === first ? "shoggoth-managed" : "native-user",
  files: [], isDefault: true, protected: true, sharedAgentCount: 1 });
const agentDefault = () => ({ bindingId: defaultBindingId, model: defaultModel, revision: bindingRevision,
  ...(defaultProvider ? { modelProviderRef: defaultProvider } : {}) });
const defaultCatalog = () => {
  const { models, runtimes } = catalog();
  const choices = models.map(item => item.bindingId === first
    ? { ...item, name: `${item.name} · ChatGPT`, modelProviderRef: "@chatgpt" } : item);
  const duplicate = choices.find(item => item.bindingId === first && item.id === (preview ? "gpt-5.4" : "shared-model"))!;
  return { selection: agentDefault(),
    models: [...choices, { ...duplicate, name: `${duplicate.id} · Fixture Endpoint`, modelProviderRef: "fixture-endpoint" }],
    runtimes };
};
let writes: string[] = [];
const cfg = { disabledBackends: [] as string[], theme: "light", locale: "zh-CN", notifications: { chat: true, cron: true, task: true },
  gatewayUrl: "ws://127.0.0.1:1", token: "", hermesMode: "local", hermesRemotes: [], hermesKeepAlive: true, setupCompletedAt: 1 };
const accounts = ["codex", "pi"].map(runtime => ({ id: `native-${runtime}-default-v1`, runtime, kind: "native-user", sharedAgentCount: 1 }));
const bindingSnapshot = () => ({ bindings, revision: bindingRevision, defaultBindingId, canAdd: true });
scope.fetch = async (input: string, init?: RequestInit) => {
  const url = new URL(String(input), "http://fixture.invalid");
  const route = url.pathname;
  if (route === `/__api/agents/${agentId}/default-model`) {
    if (init?.method !== "PUT") { defaultReads++; return Response.json(defaultCatalog()); }
    const body = JSON.parse(String(init.body));
    check(body.revision === bindingRevision, "Agent selection uses its binding revision");
    const choice = defaultCatalog().models.find(item => item.id === body.model && item.bindingId === body.bindingId
      && ("modelProviderRef" in item ? item.modelProviderRef : undefined) === body.modelProviderRef);
    check(choice, "Agent selection preserves Runtime and source identity");
    if (defaultReject) { defaultReject = false; return Response.json({ error: "unavailable", code: "PROFILE_MODEL_NOT_AVAILABLE" }, { status: 409 }); }
    defaultBindingId = body.bindingId; defaultModel = body.model; defaultProvider = body.modelProviderRef;
    bindingRevision++; defaultWrites++;
    return Response.json(agentDefault());
  }
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
    readiness: "ready",
    runtime, name: runtime, runtimeAccountId: `native-${runtime}-default-v1`, backendId: "shoggoth", enabled: preview ? ["codex", "pi", "deepseek-harness"].includes(runtime) : runtime !== "pi",
    releaseEnabled: runtime !== "claude-code", installation: runtime === "grok-build" ? "unavailable" : "available", serviceConnected: true,
  })) });
  if (route === "/__api/shoggoth/runtime-accounts") return Response.json({ accounts });
  if (route === "/__api/shoggoth/status") return Response.json({ error: "fixture service details unavailable" }, { status: 503 });
  if (route === "/__api/versions") return Response.json({ versions: [] });
  if (route === "/__api/self-updates") return Response.json({ backends: [] });
  if ((route === "/__api/agents" && init?.method === "POST")
    || (route === `/__api/agents/${agentId}` && init?.method === "PUT")) {
    const { name } = JSON.parse(String(init.body));
    if (name === occupiedName) {
      return Response.json({ code: "AGENT_NAME_CONFLICT", field: "name", error: "fixture conflict" }, { status: 409 });
    }
    if (init.method === "PUT") agentName = name;
    return Response.json({ result: init.method === "PUT" ? { id: agentId } : {} });
  }
  if (route === "/__api/agents") return Response.json({ agents: [agentDetail()] });
  if (route === `/__api/agents/${agentId}`) return Response.json({ agent: agentDetail() });
  if (route === managedRoute || route.startsWith(managedRoute + "/")) {
    check(url.searchParams.get("backend") === "shoggoth", "Private file uses the selected backend");
    if (route === managedRoute && init?.method === "POST") {
      check(init.body instanceof File && await init.body.text() === managedBytes, "Upload preserves file bytes");
      check(url.searchParams.get("operationId"), "Upload uses an operation ID");
      const now = Date.now();
      managedFile = { fileId: managedId, profileId: agentId, name: url.searchParams.get("name")!,
        mimeType: "text/plain", sizeBytes: managedBytes.length, sha256: "a".repeat(64),
        status: "available", revision: 1, createdAt: now, updatedAt: now,
        source: { kind: "import", runId: null, sourceId: null, sessionKey: null } };
      return Response.json({ file: managedFile });
    }
    if (route === managedRoute) {
      if (failManagedRead) {
        failManagedRead = false;
        return Response.json({ error: "fixture private files unavailable" }, { status: 503 });
      }
      const cursor = Number(url.searchParams.get("cursor")) || 0;
      const items = managedFile?.status === "available" ? [managedFile, ...managedSamples] : managedSamples;
      return Response.json({ items: items.slice(cursor, cursor + 20), nextCursor: items.length > cursor + 20 ? cursor + 20 : null });
    }
    check(route === `${managedRoute}/${managedId}` || route === `${managedRoute}/${managedId}/content`, "Private file keeps its ID");
    if (route.endsWith("/content")) return new Response(managedBytes, { headers: { "Content-Type": "text/plain" } });
    if (init?.method === "PUT" || init?.method === "DELETE") {
      const body = JSON.parse(String(init.body));
      check(managedFile && body.expectedRevision === managedFile.revision, "Private file changes are revision checked");
      managedFile = { ...managedFile!, revision: managedFile!.revision + 1,
        ...(init.method === "PUT" ? { name: body.name } : { status: "deleted" }) };
      return Response.json({ file: managedFile });
    }
    return Response.json({ file: managedFile, path: managedPath() });
  }
  if (route === `/__api/agents/${agentId}/artifacts`) {
    check(url.searchParams.get("backend") === "shoggoth", "Agent files request uses the selected backend");
    check(url.searchParams.get("scope") === "workspace", "workspace read excludes the separate private index");
    if (++artifactReads === 1) return Response.json({ error: "fixture unavailable" }, { status: 503 });
    return Response.json({ artifacts: { supported: true, partial: true, total: 2, items: [
      { path: artifactPath, name: artifactName, kind: "doc", area: "session-output", mtimeMs: filesTime - 1.5 * day, size: 2048 },
    ] } });
  }
  if (route === "/__api/host/reveal-path") {
    check(init?.method === "POST", "revealing a file uses the host action");
    revealedPath = JSON.parse(String(init?.body)).path;
    return Response.json({ ok: true });
  }
  if (route.startsWith("/__api/shoggoth/providers") && document.querySelector("[data-agent-overview-panel]")) {
    throw Error("Agent Overview must not load legacy source or endpoint settings");
  }
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
  scope.showAgents = (value: boolean) => { setSettings(false); setAgentPage(value); };
  const [theme, setTheme] = useState("light");
  return <MemoryRouter initialEntries={[`/chat?backend=shoggoth&session=${encodeURIComponent(sessionKey)}`]}><UiProvider><NavigationGuardProvider>
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
      : agentPage ? <AgentsPage /> : <ChatPage />}</main>
  </NavigationGuardProvider></UiProvider></MemoryRouter>;
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
  check(!!button("全部") && !!button("Shoggoth") && !!button("DeepSeek"), "Runtime tabs reuse existing menu");
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
  cfg.disabledBackends = ["pi"]; scope.showSettings(true); await openLocalRuntimes();
  await wait(() => document.querySelectorAll('#settings-local-runtimes [data-runtime]').length === expectedRuntimeRows, "available CLIs in full Settings");
  check(document.querySelector('[data-runtime="pi"]')!.textContent?.includes("未连接"), "Pi stays disabled");
  check(!document.querySelector('[data-runtime="claude-code"]'), "release-disabled runtime hidden");
  check(document.querySelector('[data-runtime="grok-build"]')!.textContent?.includes("未安装"), "unavailable CLI visible");
  check(document.querySelector('[data-runtime="codex"]')!.textContent?.includes("已就绪"), "ready CLI visible");
  return { fullChatPage: true, fullSettingsPage: true, modelSelectsRuntime: true, agentDefaultUnchanged: true,
    duplicateModelIdentity: true, conflictRetry: true, cliRows: expectedRuntimeRows, writes: writes.length };
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
  await openModels(); button("Shoggoth").click(); await pause(50);
  const list = document.querySelector<HTMLElement>(".model-menu__list")!;
  list.scrollTop = list.scrollHeight; check(list.scrollTop > 0, "model list scrolls");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await pause(50);
  scope.showSettings(true); await openLocalRuntimes();
  await wait(() => document.querySelectorAll('#settings-local-runtimes [data-runtime]').length === expectedRuntimeRows, "Settings remount");
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

const openAgentOverview = async () => {
  scope.showAgents(true);
  const card = () => document.querySelector<HTMLButtonElement>(`button[data-agent-id="${agentId}"]`);
  await wait(card, "Agent card");
  card()!.click();
  const trigger = () => document.querySelector<HTMLButtonElement>("[data-agent-overview-panel] .chat-model-menu > button");
  await wait(trigger, "Agent Overview default model");
  await pause(650);
  return trigger()!;
};
const openDefaultMenu = async (trigger: HTMLButtonElement) => {
  trigger.scrollIntoView({ block: "center" });
  if (!document.querySelector(".model-menu")) trigger.click();
  await wait(() => document.querySelector('.model-menu [role="option"]'), "Agent model catalog");
  await wait(() => document.activeElement?.classList.contains("model-menu__search"), "Agent model search focus");
  const menu = document.querySelector<HTMLElement>(".model-menu")!;
  check(menu.parentElement?.hasAttribute("data-agent-overview-panel"), "menu escapes the scroll container");
  await wait(() => {
    const rect = menu.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1
      && menu.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }, "Agent menu fits viewport after resizing and scrolling");
  return menu;
};
const modelOption = (menu: HTMLElement, name: string) => [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  .find(option => option.textContent === name)!;
scope.checkAgentDefaultModel = async () => {
  const trigger = await openAgentOverview();
  const overview = document.querySelector("[data-agent-overview-panel]")!;
  check(overview.textContent?.includes("默认模型"), "Agent uses Default model label");
  check(!["默认 Runtime", "模型来源", "自定义模型"].some(title => overview.textContent?.includes(title)), "legacy Agent overview controls hidden");
  check(defaultReads === 0, "opening an Agent does not load the catalog");
  const chatBefore = JSON.stringify(session);
  let menu = await openDefaultMenu(trigger);
  check(menu.querySelector('[aria-selected="true"].model-menu__item')?.textContent === "shared-model · ChatGPT", "select the precise current source");
  modelOption(menu, "shared-model · Fixture Endpoint").click();
  await wait(() => defaultWrites === 1 && trigger.textContent?.includes("Fixture Endpoint"), "save exact source");
  check(document.activeElement === trigger, "selection restores trigger focus");
  menu = await openDefaultMenu(trigger);
  defaultReject = true;
  modelOption(menu, "pi-fast").click();
  await wait(() => document.body.textContent?.includes("所选模型或运行环境已不可用"), "save error is localized and visible");
  check(defaultBindingId === first && trigger.textContent?.includes("Fixture Endpoint"), "failed save keeps the previous selection");
  menu = await openDefaultMenu(trigger);
  modelOption(menu, "pi-fast").click();
  await wait(() => defaultWrites === 2 && trigger.textContent === "pi-fast", "Runtime and model changed together");
  check(defaultBindingId === second && JSON.stringify(session) === chatBefore, "Agent save is separate from the conversation");
  menu = await openDefaultMenu(trigger);
  check(menu.querySelector('[aria-selected="true"].model-menu__item')?.textContent === "pi-fast", "saved selection is read back");
  menu.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(() => !document.querySelector(".model-menu") && document.activeElement === trigger, "Escape closes and restores focus");
  return { fullAgentsPage: true, exactSource: true, atomicSave: true, failedSave: true, sessionUntouched: true, defaultWrites };
};
scope.checkAgentDefaultGeometry = async (locale: string, theme: string) => {
  await applyConfiguredLocale(locale);
  document.documentElement.dataset.theme = theme;
  const trigger = document.querySelector<HTMLButtonElement>("[data-agent-overview-panel] .chat-model-menu > button")!;
  const menu = await openDefaultMenu(trigger);
  await pause(250); // Wait for the shared filter tabs' theme transition before a screenshot.
  check(menu.getAttribute("aria-labelledby") && menu.querySelector("input")?.placeholder, "label and search available");
  const title = locale === "en" ? "Default model" : "默认模型";
  check(document.getElementById(menu.getAttribute("aria-labelledby")!)?.textContent === title, "localized Default model label");
  return { width: innerWidth, locale, theme, menuOnTop: true };
};
scope.checkAgentFiles = async () => {
  document.querySelector(".model-menu input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(() => !document.querySelector(".model-menu"), "close the default model menu");
  check(artifactReads === 0, "Agent files load only when selected");
  const files = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === "Files");
  check(files, "Shoggoth Agent shows the Files tab");
  files!.click();
  const list = () => document.querySelector<HTMLUListElement>('ul[aria-label="Files"]');
  const rows = () => [...(list()?.querySelectorAll<HTMLButtonElement>("li > button") ?? [])];
  await wait(() => button("Retry") && rows().length === 20, "a failed workspace read still shows the private files");
  check(files!.getAttribute("aria-selected") === "true", "the Files tab remains selected");
  button("Retry").click();
  const row = () => document.querySelector<HTMLButtonElement>(`button[title$="${artifactPath}"]`);
  await wait(row, "Agent file from the shared artifact route");
  check(artifactReads === 2 && row()!.textContent?.includes(artifactName), "retry renders the Agent output");
  check(document.body.textContent?.includes("Showing 21")
    && [...document.querySelectorAll('[role="status"]')].some(status => status.textContent?.includes("Some sessions are unavailable")),
    "confirmed files and partial results are visible");
  check(document.querySelectorAll('ul[aria-label="Files"]').length === 1 && rows()[1] === row(),
    "workspace output and private files share one list in modification order");
  check(rows().every(item => item.className === row()!.className && item.scrollWidth <= item.clientWidth + 1)
    && getComputedStyle(list()!).flexDirection === "column" && rows()[2].textContent?.includes("Missing on disk"),
    "both sources use compact rows that fit the narrow window");
  button("Load more").click();
  await wait(() => rows().length === 22 && !button("Load more"), "older private files append to the same list");
  check(rows()[1] === row(), "loading older files retains the workspace output");
  row()!.click();
  await wait(() => revealedPath === artifactPath, "file row reveals the exact output in Finder");

  const uploadInput = () => document.querySelector<HTMLInputElement>('input[type="file"][hidden]');
  await wait(() => button("Import file") && uploadInput(), "private library entry");
  const transfer = new DataTransfer();
  transfer.items.add(new File([managedBytes], artifactName, { type: "text/plain" }));
  uploadInput()!.files = transfer.files;
  uploadInput()!.dispatchEvent(new Event("change", { bubbles: true }));
  const privateRow = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.includes(name) && item.textContent.includes("Imported"));
  await wait(() => privateRow(artifactName) && !privateRow(artifactName)!.disabled, "uploaded private file in the list");
  check(rows()[0] === privateRow(artifactName) && rows().filter(item => item.firstElementChild?.textContent === artifactName).length === 2,
    "same-name files have separate rows and the newer file appears first");
  privateRow(artifactName)!.click();
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find(item => item.textContent === label);
  await wait(() => dialog()?.querySelector("pre")?.textContent === managedBytes, "bounded private text preview");
  const originalHref = dialog()!.querySelector("a[download]")!.getAttribute("href");
  const filename = dialog()!.querySelector<HTMLInputElement>("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filename, "Renamed report.txt");
  filename.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => dialogButton("Save") && !dialogButton("Save")!.disabled, "private file rename ready");
  dialogButton("Save")!.click();
  await wait(() => dialog()?.querySelector("h2")?.textContent === "Renamed report.txt", "rename updates the private file");
  check(dialog()!.querySelector("a[download]")!.getAttribute("href") === originalHref, "download URL survives rename");
  const reveal = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => /reveal|finder/iu.test(item.textContent || ""));
  check(reveal, "private Finder reveal");
  reveal!.click();
  await wait(() => revealedPath === managedPath(), "private Finder action resolves the renamed path");
  dialogButton("Delete")!.click();
  const confirmation = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  await wait(() => confirmation()?.textContent?.includes("Renamed report.txt"), "confirm private deletion");
  confirmation()!.querySelector<HTMLButtonElement>(".btn-danger")!.click();
  await wait(() => managedFile?.status === "deleted" && !privateRow("Renamed report.txt") && !dialog(), "private file removed from index");
  await wait(() => !button("Refresh")?.disabled, "file controls ready after deletion");
  failManagedRead = true;
  button("Refresh").click();
  await wait(() => button("Retry"), "a failed private file refresh can be retried");
  check(rows().length === 1 && rows()[0] === row(), "private file errors keep the workspace row visible");
  button("Retry").click();
  await wait(() => !button("Retry") && !button("Refresh")?.disabled, "private file retry succeeds");
  return { filesTab: true, singleList: true, loadMore: true, sameNameFiles: true, artifactReads, reveal: true, privateImportPreviewRenameDelete: true };
};

scope.checkAgentNameConflicts = async () => {
  scope.showAgents(false);
  await wait(() => !document.querySelector(".agents-page"), "return to chat");
  scope.showAgents(true);
  await applyConfiguredLocale("en");
  const add = () => document.querySelector<HTMLButtonElement>('button[title="+ New Agent"]');
  await wait(add, "new Agent button");
  add()!.click();
  const createName = () => document.querySelector<HTMLInputElement>('[role="dialog"] input');
  await wait(createName, "new Agent name field");
  const setName = (input: HTMLInputElement, name: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const errorFor = (input: HTMLInputElement) => document.getElementById(input.getAttribute("aria-describedby") || "");
  setName(createName()!, occupiedName);
  button("Create").click();
  await wait(() => errorFor(createName()!)?.textContent?.includes("Choose a different name"), "localized create conflict");
  check(createName()!.value === occupiedName && createName()!.getAttribute("aria-invalid") === "true", "keep the create draft");
  setName(createName()!, "新助理");
  await wait(() => !errorFor(createName()!), "editing clears the create conflict");
  button("Create").click();
  await wait(() => !createName(), "corrected creation succeeds");

  await openAgentOverview();
  await applyConfiguredLocale("zh-CN");
  const rename = () => document.querySelector<HTMLInputElement>("[data-agent-overview-panel] input");
  setName(rename()!, occupiedName);
  await wait(() => button("保存"), "rename save button");
  button("保存").click();
  await wait(() => errorFor(rename()!)?.textContent?.includes("请换一个名称"), "localized rename conflict");
  check(rename()!.value === occupiedName && agentName === "独立 Agent", "keep the rename draft and saved name");
  setName(rename()!, "资料助理");
  await wait(() => !errorFor(rename()!), "editing clears the rename conflict");
  button("保存").click();
  await wait(() => agentName === "资料助理" && rename()?.value === agentName, "corrected rename succeeds");
  return { create: true, rename: true };
};

if (preview) {
  document.title = "Shoggoth · 模型与 Runtime 预览";
  void wait(() => picker() && !picker()!.disabled, "preview model picker").then(async () => {
    await wait(() => document.querySelector('.chat-thread'), "preview chat loaded");
    picker()!.click();
  }).catch(error => scope.fixtureErrors.push(String(error)));
}
