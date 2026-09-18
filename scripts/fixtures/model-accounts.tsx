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
      return reply({ profiles: ["default"], providers: [{ id: `${backend}-account`, name: `${name} 账号`,
        flow: "pkce", cliCommand: "", docsUrl: "", disconnectable: true, disconnectCommand: null,
        disconnectHint: null, connectedProfiles: ["default"], status: { loggedIn: connected,
          source: "fixture", sourceLabel: "预览账号", tokenPreview: null, expiresAt: null,
          hasRefreshToken: false, error: null } }] });
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
      update: false, rename: false, delete: false, updateProvider: false, blockers: [] });
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
    await wait(() => document.getElementById("models-runtime-accounts")?.textContent?.includes(`${name} · 账号与订阅`), `${name} accounts`);
  };
  const accountButton = (label: string) => buttons("#models-runtime-accounts button").find(button => button.getAttribute("aria-label")?.includes(label))!;
  await wait(state.fixtureReady, "settings loaded");
  check(!document.querySelector("#settings-runtime-auth, #settings-service-provider"), "settings must not contain account or model configuration panels");
  check(!buttons(".settings-page button").some(button => button.textContent?.trim() === "管理账号"), "settings must not expose account management buttons");
  check(!state.accountCalls.some((call: any) => call.route === "/__api/oauth"), "settings must not load account credentials");
  document.querySelector<HTMLAnchorElement>('a[href="#/models"]')!.click();
  await wait(() => document.querySelector(".models-page"), "models route");
  for (const backend of FALLBACK_BACKEND_DESCRIPTORS.filter(item => ["builtin-service", "native-runtime"].includes(item.connectionMode))) {
    await selectBackend(backend.name);
    await wait(() => document.querySelector(".model-grid")?.textContent?.includes(`${backend.name} Model 1`), `${backend.name} model list`);
    await wait(() => accountButton(`${backend.name} 账号`), `${backend.name} login action`);
  }
  await selectBackend("Codex");
  accountButton("重新登录").click();
  await wait(() => document.querySelector('[role="dialog"] input'), "login code input");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-code");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pause(20);
  buttons('[role="dialog"] button').find(button => button.textContent?.includes("提交"))!.click();
  await wait(() => document.querySelector(".model-grid")?.textContent?.includes("Codex Model 2"), "successful login refreshes model list");
  accountButton("断开").click();
  await wait(() => document.querySelector('[role="alertdialog"]'), "account disconnect confirmation");
  buttons('[role="alertdialog"] button').at(-1)!.click();
  await wait(() => document.querySelector(".model-grid")?.textContent?.includes("Codex Model 3"), "account disconnect refreshes model list");
  check(state.accountCalls.filter((call: any) => call.method === "POST").every((call: any) => call.backend === "codex"), "Codex account mutations must keep their backend scope");

  state.delayAccountBackend = "grok-build";
  await selectBackend("Grok");
  await selectBackend("Shoggoth");
  await pause(500);
  check(!document.getElementById("models-runtime-accounts")!.textContent!.includes("Grok 账号"), "late account responses must not cross backends");
  document.querySelector<HTMLElement>("#models-runtime-accounts summary")!.click();
  await wait(() => buttons("#models-runtime-accounts button").some(button => button.textContent?.trim() === "退出 Shoggoth 登录"), "Shoggoth independent account controls");
  buttons("#models-runtime-accounts button").find(button => button.textContent?.trim() === "退出 Shoggoth 登录")!.click();
  await wait(() => document.querySelector('[role="alertdialog"]'), "Shoggoth logout confirmation");
  buttons('[role="alertdialog"] button').at(-1)!.click();
  await wait(() => state.accountCalls.some((call: any) => call.route.endsWith("/shoggoth-internal-codex-default-v1/logout")), "independent Shoggoth logout target");
  await wait(() => document.querySelector(".model-grid")?.textContent?.includes("Shoggoth Model 2"), "Shoggoth account change refreshes models");

  state.failCatalogBackend = "claude-code";
  state.failAccountLogin = true;
  await selectBackend("Claude Code");
  await wait(() => document.querySelector(".models-page .error")?.textContent?.includes("fixture catalog failed"), "catalog failure");
  await wait(() => accountButton("Claude Code 账号"), "account management available without catalog");
  accountButton("重新登录").click();
  await wait(() => document.querySelector('[role="dialog"]')?.textContent?.includes("fixture login failed"), "login failure");
  buttons('[role="dialog"] button').find(button => button.getAttribute("aria-label") === "关闭")!.click();
  await selectBackend("Codex");
  check(!document.querySelector('[role="dialog"]'), "backend switch must not retain the previous account dialog");
  return { writes: 0, checks: "settings removal / all 7 native accounts with models / login and logout refresh / account isolation / delayed responses / catalog and login failure" };
}
