import React from "react";
import { Link, Route, Routes } from "react-router-dom";
import ModelsPage from "../../app/manage-ui/src/pages/ModelsPage";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";

// Isolated accounts: no credentials, native commands or real services are used.
export function installModelAccountsFixture(state: any) {
  const descriptors = FALLBACK_BACKEND_DESCRIPTORS;
  const loggedIn = new Map(descriptors.map(({ id }) => [id, true]));
  const versions = new Map(descriptors.map(({ id }) => [id, 1]));
  state.accountCalls = [];
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  return async (url: URL, init?: RequestInit): Promise<Response | undefined> => {
    const backend = url.searchParams.get("backend") || "shoggoth";
    const descriptor = descriptors.find(({ id }) => id === backend)!;
    const name = descriptor?.name || backend;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const route = url.pathname;
    state.accountCalls.push({ route, backend, method: init?.method || "GET", body });
    if (route === "/__api/oauth") {
      const connected = loggedIn.get(backend);
      if (state.delayAccountBackend === backend) await new Promise(resolve => setTimeout(resolve, 450));
      const account = { id: `${backend}-account`, name: `${name} 账号`,
        flow: "pkce", cliCommand: "", docsUrl: "", disconnectable: true, disconnectCommand: null,
        disconnectHint: null, connectedProfiles: ["default"], status: { loggedIn: connected,
          source: "fixture", sourceLabel: "预览账号", tokenPreview: null, expiresAt: null,
          hasRefreshToken: false, error: null } };
      return reply({ profiles: ["default"], providers: backend === "shoggoth" ? [
        ["antigravity", "Antigravity"], ["codex", "Codex CLI"], ["codex-harness", "Shoggoth"],
        ["deepseek-harness", "DeepSeek"], ["grok-build", "Grok"], ["opencode", "OpenCode"], ["pi", "Pi"],
      ].map(([runtime, name]) => ({ ...account, name,
        id: runtime === "codex-harness" ? "shoggoth-internal-codex-default-v1" : `native-${runtime}-default-v1`,
        ...(runtime === "codex-harness" ? {} : { connection: { id: runtime,
          enabled: !state.fixtureConfig().disabledBackends.includes(runtime) } }) })) : [account] });
    }
    if (route === "/__api/oauth/start") {
      if (state.failAccountLogin) return reply({ error: "fixture login failed" }, 500);
      return reply({ flow: "pkce", sessionId: `${backend}-session`, authUrl: "", expiresIn: 600 });
    }
    if (route === "/__api/oauth/submit") {
      loggedIn.set(backend, true);
      versions.set(backend, versions.get(backend)! + 1);
      return reply({ ok: true, status: "approved" });
    }
    if (route === "/__api/oauth/disconnect") {
      loggedIn.set(backend, false);
      versions.set(backend, versions.get(backend)! + 1);
      return reply({ ok: true });
    }
    if (route === "/__api/oauth/cancel") return reply({ ok: true });
    if (route === "/__api/models") {
      if (state.failCatalogBackend === backend) return reply({ error: "fixture catalog failed" }, 500);
      const version = versions.get(backend)!;
      return reply({ catalogRevision: version.toString(16).padStart(64, "0"), unchanged: false,
        models: [{ id: `${backend}-model-${version}`, name: `${name} Model ${version}`, provider: name,
          backendId: backend, contextWindow: 128000, reasoning: true }] });
    }
    if (route === "/__api/models/active") return reply({ byScope: {}, providerByScope: {} });
    if (route === "/__api/models/config") return reply({ providers: [] });
    if (route === "/__api/models/config/capabilities") return reply({ supported: false, create: false,
      update: false, rename: false, delete: false, updateProvider: false,
      providerManagedCatalog: backend === "shoggoth", perAgentModelSettings: backend === "hermes", blockers: [] });
    if (route === "/__api/env") return reply({ vars: [] });
    if (route === "/__api/models/endpoints") return reply({ supported: true, profiles: ["Shoggoth"],
      endpoints: [{ id: "fixture-endpoint", name: "Fixture endpoint", baseUrl: "https://fixture.invalid/v1",
        model: "fixture-model", models: ["fixture-model"], profiles: ["Shoggoth"], hasApiKey: false }],
      ...(backend === "shoggoth" ? { form: { apiOptions: ["openai-responses"], defaultApi: "openai-responses",
        firstModelIsDefault: false, nameEditable: false } } : { form: {
        apiOptions: ["", "chat_completions", "codex_responses", "anthropic_messages"], defaultApi: "" } }) });
    if (route === "/__api/models/endpoints/validate") return reply({ ok: true, reachable: true,
      models: ["fixture-model", "fixture-small"] });
    if (route === "/__api/models/config/pending") return reply({ operations: [] });
    if (route === "/__api/models/auth-profiles") return reply({ supported: false, profiles: [] });
    if (route === "/__api/shoggoth/status") return reply({
      service: { healthy: true, serviceVersion: "preview", domainAvailability: { kanban: true, cron: true } },
      background: { supported: true, installed: true, loaded: true, needsRepair: false },
    });
    if (route === "/__api/shoggoth/providers") return reply({
      profile: { id: "shoggoth-preview", isDefault: true, ready: true, defaultModel: "shoggoth-model-1" },
      providers: [{ id: "chatgpt", kind: "chatgpt", displayName: "ChatGPT", authSource: "managed",
        authState: loggedIn.get("shoggoth") ? "authenticated" : "missing" }],
    });
    if (route === "/__api/shoggoth/chatgpt/models") return reply({
      models: [{ id: "shoggoth-model-1", displayName: "Shoggoth Model 1", isDefault: true }],
    });
    if (route.endsWith("/shoggoth-internal-codex-default-v1/logout")) {
      loggedIn.set("shoggoth", false);
      versions.set("shoggoth", versions.get("shoggoth")! + 1);
      return reply({ loggedOut: true });
    }
    return undefined;
  };
}

export function ModelsSettingsPreview() {
  return <>
    <nav aria-label="预览页面" style={{ display: "flex", gap: 16, padding: "16px 40px 0" }}>
      <Link to="/settings">设置</Link><Link to="/models">模型</Link>
    </nav>
    <Routes><Route path="/models" element={<ModelsPage />} /><Route path="*" element={<SettingsPage />} /></Routes>
  </>;
}

export async function runModelAccountsFixture(state: any) {
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate: () => unknown, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (state.fixtureError) throw Error(state.fixtureError);
      if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
      await pause(10);
    }
  };
  const buttons = (selector: string) => [...document.querySelectorAll<HTMLButtonElement>(selector)];
  const selectBackend = async (name: string) => {
    buttons('.models-page [role="tab"]').find(button => button.getAttribute("aria-label") === name || button.textContent?.trim() === name)!.click();
    await wait(() => buttons('.models-page [role="tab"]').some(button => button.getAttribute("aria-label") === name && button.getAttribute("aria-selected") === "true"), `${name} selected`);
    await wait(() => buttons(".models-page button").some(button => button.title === (name === "Shoggoth" ? "Codex CLI" : `${name} 账号`)), `${name} accounts`);
    const titleSelector = name === "Shoggoth" ? "#models-runtime-accounts h4" : "#keys-oauth h4";
    await wait(() => document.querySelector(titleSelector)?.textContent?.trim() === "Provider 登录（OAuth）", `${name} shared OAuth title`);
  };
  const accountButton = (label: string) => buttons("#models-runtime-accounts button").find(button => button.getAttribute("aria-label")?.includes(label))!;
  const oauthReads = () => state.accountCalls.filter((call: any) => call.route === "/__api/oauth" && call.backend === "shoggoth").length;
  await wait(state.fixtureReady, "settings loaded");
  check(!document.querySelector("#settings-runtime-auth, #settings-service-provider"), "settings must not contain account or model configuration panels");
  check(!buttons(".settings-page button").some(button => button.textContent?.trim() === "管理账号"), "settings must not expose account management buttons");
  check(!state.accountCalls.some((call: any) => call.route === "/__api/oauth"), "settings must not load account credentials");
  document.querySelector<HTMLAnchorElement>('a[href="#/models"]')!.click();
  await wait(() => document.querySelector(".models-page"), "models route");
  await selectBackend("Shoggoth");
  await wait(() => document.querySelector(".models-page")?.textContent?.includes("Fixture endpoint"), "shared custom endpoints card");
  check(!document.querySelector("#models-runtime-accounts details"), "per-assistant provider defaults are absent from the shared models page");
  check(!state.accountCalls.some((call: any) => ["/__api/shoggoth/providers", "/__api/shoggoth/chatgpt/models"].includes(call.route)), "models page does not load the default assistant's provider settings");
  check(!document.querySelector(".model-grid, .models-page input[type=search], .models-page [aria-label='Provider 筛选']"), "provider-managed page has no catalog, search or provider filter");
  check(!state.accountCalls.some((call: any) => call.backend === "shoggoth" && ["/__api/models", "/__api/models/active", "/__api/models/config"].includes(call.route)), "hidden catalog data is not requested");
  const grid = document.querySelector("#models-runtime-accounts [class*='oauthGrid']")!;
  check(getComputedStyle(grid).gridTemplateColumns.split(" ").length === 2, "native accounts use the shared two-column grid");
  check(grid.children.length === 7, "local CLI accounts are aggregated in the OAuth card");
  check(buttons("#models-runtime-accounts button").some(button => button.title === "Shoggoth (内置codex)"),
    "the Models page identifies the bundled Codex account");
  const removeButton = buttons("#models-runtime-accounts button").find(button => button.title === "删除")!;
  check(removeButton.querySelector("svg") && !removeButton.textContent?.trim()
    && removeButton.getAttribute("aria-label")?.includes("Fixture endpoint"), "custom model delete is an accessible icon action");
  buttons("#models-runtime-accounts button").find(button => button.textContent?.trim() === "新增模型")!.click();
  await wait(() => document.querySelector('[role="dialog"]')?.textContent?.includes("新增自定义模型"), "custom model form");
  const modelDialog = document.querySelector('[role="dialog"]')!;
  const saveModel = buttons('[role="dialog"] button').find(button => button.textContent?.trim() === "保存")!;
  const cancelModel = buttons('[role="dialog"] button').find(button => button.textContent?.trim() === "取消")!;
  const addModelId = buttons('[role="dialog"] button').find(button => button.textContent?.trim() === "添加")!;
  check(!modelDialog.closest(".management-page"), "dialog is portaled outside the management page");
  check(modelDialog.querySelector("[role=note]")?.textContent?.includes("OpenAI Responses API")
    && !modelDialog.querySelector("[role=combobox]"), "single native protocol is a fixed explanation, not a selector");
  check(saveModel.getBoundingClientRect().height === 48 && getComputedStyle(saveModel).borderRadius === "32px"
    && cancelModel.getBoundingClientRect().height === 48 && addModelId.getBoundingClientRect().height === 40,
  "custom model dialog uses the shared large and medium button geometry outside the page scope");
  cancelModel.click();
  await wait(() => !document.querySelector('[role="dialog"]'), "custom model form closed");
  const beforeLogin = oauthReads();
  accountButton("Codex CLI — 重新登录").click();
  await wait(() => document.querySelector('[role="dialog"] input'), "login code input");
  const submitCode = buttons('[role="dialog"] button').find(button => button.textContent?.includes("提交"))!;
  check(submitCode.getBoundingClientRect().height === 48 && getComputedStyle(submitCode).borderRadius === "32px",
    "OAuth dialog uses shared buttons outside the page scope");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-code");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause(20);
  buttons('[role="dialog"] button').find(button => button.textContent?.includes("提交"))!.click();
  await wait(() => oauthReads() > beforeLogin && !document.querySelector('[role="dialog"]'), "successful login refreshes account state");
  accountButton("Codex CLI — 断开").click();
  await wait(() => document.querySelector('[role="alertdialog"]'), "account disconnect confirmation");
  buttons('[role="alertdialog"] button').at(-1)!.click();
  await wait(() => state.fixtureConfig().disabledBackends.includes("codex") && accountButton("Codex CLI — 重新连接"), "native disconnect updates its app connection");
  accountButton("Codex CLI — 重新连接").click();
  await wait(() => !state.fixtureConfig().disabledBackends.includes("codex") && accountButton("Codex CLI — 断开"), "native reconnect restores its app connection");
  check(!state.accountCalls.some((call: any) => call.route === "/__api/oauth/disconnect"), "native connection toggle never signs out");
  check(!document.querySelector(".model-grid, #models-runtime-accounts details"), "account changes keep catalog and per-assistant defaults hidden");

  state.delayAccountBackend = "hermes";
  buttons('.models-page [role="tab"]').find(button => button.getAttribute("aria-label") === "Hermes")!.click();
  await wait(() => buttons('.models-page [role="tab"]').some(button => button.getAttribute("aria-label") === "Hermes" && button.getAttribute("aria-selected") === "true"), "Hermes selected before its delayed response");
  await selectBackend("Shoggoth");
  await pause(500);
  check(!document.getElementById("models-runtime-accounts")!.textContent!.includes("Hermes 账号"), "late account responses must not cross backends");

  state.failAccountLogin = true;
  await selectBackend("Hermes");
  buttons(".models-page button").find(button => button.getAttribute("aria-label") === "Hermes 账号 — 重新登录")!.click();
  await wait(() => document.querySelector('[role="dialog"]')?.textContent?.includes("fixture login failed"), "login failure");
  buttons('[role="dialog"] button').find(button => button.getAttribute("aria-label") === "关闭")!.click();
  await selectBackend("Shoggoth");
  check(!document.querySelector('[role="dialog"]'), "backend switch must not retain the previous account dialog");
  return { writes: state.fixtureWrites, checks: "settings removal / 7 local CLI accounts in shared OAuth grid / endpoints without catalog or assistant-default reads / native connection toggle / login refresh / backend isolation / delayed responses / login failure" };
}
