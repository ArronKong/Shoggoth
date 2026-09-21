import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import i18n, { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import { FALLBACK_BACKEND_DESCRIPTORS, useEnabledBackends } from "../../app/manage-ui/src/lib/backends";
import { installModelAccountsFixture, ModelsSettingsPreview, runModelAccountsFixture } from "./model-accounts";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Real settings, translations and navigation guard; all APIs are in-memory.
const state = window as any;
const accounts = new URLSearchParams(location.search).has("accounts");
const connections = accounts || new URLSearchParams(location.search).has("connections");
const configKey = connections ? "fixture.settings.connections.config" : "fixture.settings.config";
let config = JSON.parse(localStorage.getItem(configKey) || "null") || {
  gatewayUrl: "ws://127.0.0.1:1", token: "", locale: "zh-CN", theme: "light",
  hermesMode: "local", hermesRemotes: [], hermesKeepAlive: true,
  disabledBackends: [], notifications: { chat: true, cron: true, task: true }, setupCompletedAt: 1,
};
const standalone = new URLSearchParams(location.search).has("standalone");
if (!standalone) state.openclawDesktop = {};
state.fixtureConfig = () => ({ ...config });
state.fixtureWrites = 0;
state.fixtureConfigReads = 0;
state.fixtureConfigEvents = 0;
state.fixtureRequests = [];
state.activeWrites = 0;
state.maxActiveWrites = 0;
const readyAt = new Map<string, number>();
window.addEventListener("openclaw:config-changed", () => state.fixtureConfigEvents++);
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason?.stack || event.reason); });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const accountFixture = accounts ? installModelAccountsFixture(state) : null;
state.runModelAccountsFixture = () => runModelAccountsFixture(state);
state.fetch = async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input), location.href);
  let payload: unknown;
  if (url.pathname === "/__api/config") {
    if (init?.method === "PUT") {
      state.fixtureRequests.push(JSON.parse(String(init.body)));
      state.activeWrites++;
      state.maxActiveWrites = Math.max(state.maxActiveWrites, state.activeWrites);
      await pause(state.saveDelay || 25);
      state.activeWrites--;
      if (state.failNextSave) {
        state.failNextSave = false;
        return new Response(JSON.stringify({ error: "fixture save failed" }), { status: 500 });
      }
      const next = { ...config, ...JSON.parse(String(init.body)) };
      for (const id of config.disabledBackends) {
        if (!next.disabledBackends.includes(id)) readyAt.set(id, Date.now() + 500);
      }
      config = next;
      localStorage.setItem(configKey, JSON.stringify(config));
      state.fixtureWrites++;
      if (!standalone) state.fixtureHost?.configSaved(config);
    } else {
      state.fixtureConfigReads++;
      if (state.failConfigReads) return new Response(JSON.stringify({ error: "fixture load failed" }), { status: 500 });
    }
    payload = { config };
  } else if (connections && url.pathname === "/__api/backends") {
    payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  } else if (connections && url.pathname === "/__api/status") {
    payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map((backend) => ({
      id: backend.id, name: backend.name,
      connected: !config.disabledBackends.includes(backend.id) && Date.now() >= (readyAt.get(backend.id) || 0),
      disabled: config.disabledBackends.includes(backend.id),
      info: { connectionMode: backend.connectionMode, agents: 1 },
    })) };
  } else if (["/__api/backends", "/__api/status", "/__api/versions", "/__api/self-updates"].includes(url.pathname)) {
    payload = { backends: [], versions: [], updates: [] };
  } else {
    const accountResponse = await accountFixture?.(url, init);
    if (accountResponse) return accountResponse;
    return new Response(JSON.stringify({ error: "unavailable in fixture" }), { status: 501 });
  }
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};

function PersistentLabel() {
  const { t } = useTranslation();
  return <><span id="persistent-label">{t("settings.pageTitle")}</span>
    <div id="persistent-markdown" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml("```js\nconst message = 'language test';\n```") }} />
  </>;
}
function EnabledBackendsProbe() {
  return <output hidden id="fixture-enabled-backends">{useEnabledBackends().join(",")}</output>;
}
await applyConfiguredLocale(config.locale);
const fixtureRoot = createRoot(document.getElementById("root")!);
const renderSettings = () => fixtureRoot.render(
  <React.StrictMode><HashRouter><NavigationGuardProvider><UiProvider>
    {connections ? <EnabledBackendsProbe /> : <PersistentLabel />}{accounts ? <ModelsSettingsPreview /> : <SettingsPage />}
  </UiProvider></NavigationGuardProvider></HashRouter></React.StrictMode>,
);

renderSettings();
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > deadline) throw Error(`Timed out: ${label}; ${JSON.stringify({
      locale: config.locale, requests: state.fixtureRequests, writes: state.fixtureWrites,
      picker: document.querySelector("#settings-appearance [role=combobox]")?.outerHTML,
    })}`);
    await pause(10);
  }
};
const noSaveActions = () => !document.querySelector(".page-head-actions button, .settings-savebar");
const editInput = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const unloadBlocked = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
state.fixtureReady = () => !!document.querySelector("#settings-appearance button[role=combobox]:not(:disabled)");
const visibleLanguageOptions = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  .filter(node => node.getBoundingClientRect().height > 0);
state.chooseLocale = async (label: string) => {
  await wait(() => visibleLanguageOptions().length === 0, "previous language menu closed");
  document.querySelector<HTMLButtonElement>("#settings-appearance button[role=combobox]")!.click();
  await wait(() => document.querySelector('#settings-appearance [role=combobox]')?.getAttribute("aria-expanded") === "true"
    && visibleLanguageOptions().length, "language options");
  const option = visibleLanguageOptions().find((node) => node.textContent?.replace("✓", "").trim() === label);
  check(option, `missing language option: ${label}`);
  option!.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "", detail: 0 }));
  await wait(() => visibleLanguageOptions().length === 0, "language menu dismissed");
  await new Promise(requestAnimationFrame);
};
state.checkLocale = async (locale: string, title: string, configuredLocale = locale) => {
  await wait(() => config.locale === configuredLocale && state.activeWrites === 0
    && state.fixtureConfigEvents === state.fixtureWrites, "automatic save settled");
  await wait(() => document.querySelector("h1")?.textContent === title, `visible ${locale} translation`);
  check(!unloadBlocked(), "automatic preferences must not require a discard confirmation");
  check(i18n.language === locale && document.documentElement.lang === locale, "active locale and html lang must agree");
  check(document.querySelector("#persistent-label")?.textContent === title, "already-mounted components must translate");
  check(document.querySelector("#persistent-markdown .code-block-copy__idle")?.textContent === (locale === "en" ? "Copy" : "复制"), "cached Markdown controls must translate");
  check(noSaveActions(), "settings must have no manual save or discard actions");
};
state.runFixture = async () => {
  await wait(state.fixtureReady, "settings ready");
  check(state.fixtureWrites === 0, "loading must not write defaults");
  check(noSaveActions(), "no save buttons on first load");
  check(!document.querySelector(".settings-save-state"), "no automatic-save hint in the page header");
  check(!document.querySelector('input[name="settings-theme"]'), "theme picker must stay hidden");
  await state.chooseLocale("English");
  await state.checkLocale("en", "Settings");
  check(config.locale === "en" && localStorage.getItem("openclaw.i18n.locale") === "en", "English saves and seeds the boot cache");
  await state.chooseLocale("简体中文");
  await state.checkLocale("zh-CN", "设置");
  await state.chooseLocale("跟随系统");
  const systemLocale = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  await state.checkLocale(systemLocale, systemLocale === "en" ? "Settings" : "设置", "");
  check(config.locale === "" && localStorage.getItem("openclaw.i18n.locale") === null, "follow-system must clear explicit override");
  const retryLocale = systemLocale === "en" ? "zh-CN" : "en";
  const retryLabel = systemLocale === "en" ? "简体中文" : "English";
  state.failNextSave = true;
  await state.chooseLocale(retryLabel);
  await wait(() => document.body.textContent?.includes("fixture save failed"), "save error");
  check(config.locale === "" && i18n.language === systemLocale, "failed save must retain the confirmed language");
  check(!unloadBlocked() && noSaveActions(), "failure must not create a manual-save workflow");
  await state.chooseLocale(retryLabel);
  await state.checkLocale(retryLocale, retryLocale === "en" ? "Settings" : "设置");

  // Slow disk/network responses must not disable or overwrite later switches.
  state.saveDelay = 120;
  const switches = () => [...document.querySelectorAll<HTMLButtonElement>("#settings-notif [role=switch]")];
  const beforeRapid = state.fixtureWrites;
  for (const index of [0, 1, 0, 2]) { switches()[index].click(); await pause(10); }
  await wait(() => state.fixtureWrites === beforeRapid + 4, "queued preference writes");
  await pause(30);
  check(JSON.stringify(config.notifications) === JSON.stringify({ chat: true, cron: false, task: false }), "all rapid notification choices must persist, including a reversal");
  check(switches().map(node => node.getAttribute("aria-checked")).join() === "true,false,false", "old responses must not revert visible choices");
  check(state.maxActiveWrites === 1, "preference requests must be serialized");

  // A failed earlier request must not roll back a later edit of the same control.
  const beforeFailure = state.fixtureWrites;
  state.failNextSave = true;
  switches()[0].click(); await pause(10);
  switches()[0].click(); await pause(10);
  await wait(() => state.fixtureWrites === beforeFailure + 1, "newer choice after failed save");
  check(config.notifications.chat && switches()[0].getAttribute("aria-checked") === "true", "failure rollback must respect the latest edit");
  state.saveDelay = 0;

  const editor = document.getElementById("settings-openclaw") as HTMLDetailsElement;
  editor.open = true;
  const input = document.getElementById("settings-gateway-url") as HTMLInputElement;
  const beforeText = state.fixtureWrites;
  editInput(input, "ws://127.0.0.1:2"); await pause(50);
  editInput(input, "ws://127.0.0.1:3"); await pause(100);
  check(state.fixtureWrites === beforeText, "text input must debounce intermediate values");
  await wait(() => config.gatewayUrl === "ws://127.0.0.1:3", "debounced endpoint save");
  check(state.fixtureWrites === beforeText + 1 && editor.open, "endpoint saves once and preserves its expanded editor");
  editInput(input, "ws://"); await pause(550);
  check(config.gatewayUrl === "ws://127.0.0.1:3" && input.getAttribute("aria-invalid") === "true", "invalid endpoint must not overwrite the working connection");
  switches()[2].click();
  await wait(() => config.notifications.task, "preferences save despite incomplete endpoint");
  check(config.gatewayUrl === "ws://127.0.0.1:3", "preference patch must exclude invalid endpoint");

  // Leaving immediately flushes a valid pending text edit and finishes queued writes.
  state.saveDelay = 120;
  editInput(input, "ws://127.0.0.1:4"); await pause(10);
  fixtureRoot.render(<div id="left-settings">Away</div>);
  await wait(() => document.getElementById("left-settings"), "left settings during debounce");
  renderSettings();
  await wait(state.fixtureReady, "settings reopened while save is pending");
  check(config.gatewayUrl === "ws://127.0.0.1:4", "immediate remount must await the pending save");
  state.saveDelay = 0;
  check((document.getElementById("settings-gateway-url") as HTMLInputElement).value === config.gatewayUrl, "remount reads persisted settings");

  fixtureRoot.render(<div>Reload</div>); await pause(10);
  const beforeLoadFailure = state.fixtureWrites;
  state.failConfigReads = true;
  renderSettings();
  await wait(() => document.querySelector(".settings-page > .error"), "config load error");
  check(document.querySelector<HTMLButtonElement>("#settings-appearance [role=combobox]")?.disabled, "load failure disables preferences");
  check(document.querySelector<HTMLInputElement>("#settings-gateway-url")?.disabled, "load failure disables connection inputs");
  check(state.fixtureWrites === beforeLoadFailure, "failed load must never overwrite settings with defaults");
  state.failConfigReads = false;
  check(state.fixtureConfigEvents === state.fixtureWrites, "successful autosaves must notify persistent components");
  return { locale: config.locale, writes: state.fixtureWrites, checks: "automatic locale / rapid switches / rollback / serialized patches / debounce / validation / navigation / load failure / persistent UI" };
};

state.runConnectionsFixture = async () => {
  await wait(() => state.fixtureReady() && document.querySelectorAll(".settings-backend").length === FALLBACK_BACKEND_DESCRIPTORS.length, "all connections ready");
  check(!document.querySelector('.settings-page [role="tablist"], .settings-page [role="tabpanel"]'), "settings must not require category tabs");
  const groupsVisible = () => ["settings-general", "settings-connections"].every((id) => document.getElementById(id)!.getBoundingClientRect().height > 0);
  check(groupsVisible(), "preferences and connections must be displayed together");
  const heading = document.querySelector("h1");
  const editor = document.getElementById("settings-openclaw") as HTMLDetailsElement;
  editor.open = true;
  const input = document.getElementById("settings-gateway-url") as HTMLInputElement;
  editInput(input, "ws://");
  await wait(() => input.getAttribute("aria-invalid") === "true", "incomplete endpoint");
  const reads = state.fixtureConfigReads;
  const row = (id: string) => document.getElementById(`backend-detail-${id}`)!.closest("article")!;
  const action = (id: string) => [...row(id).querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => ["断开连接", "重新连接"].includes(button.textContent!.trim()))!;
  const details = row("openclaw").querySelector<HTMLButtonElement>(".settings-detail-toggle")!;
  details.click();
  await wait(() => details.getAttribute("aria-expanded") === "true", "expanded backend details");
  window.scrollTo(0, 180);
  await pause(50);
  const scrollTop = document.scrollingElement!.scrollTop;
  check(scrollTop > 0, "fixture must exercise a scrolled settings page");
  const retained = () => {
    check(document.querySelector("h1") === heading, "document and settings must stay mounted");
    check(groupsVisible(), "preferences and connections must remain displayed together");
    check(editor.open && details.getAttribute("aria-expanded") === "true", "expanded editors and backend details must remain open");
    check(input.value === "ws://" && noSaveActions() && !unloadBlocked(), "incomplete text stays editable without manual save actions");
    check(config.gatewayUrl === "ws://127.0.0.1:1", "connection toggles must not save the draft");
    check(state.fixtureConfigReads === reads, "connection toggles must not reload settings data");
    check(Math.abs(document.scrollingElement!.scrollTop - scrollTop) <= 1, "scroll position must remain unchanged");
  };
  const toggle = async (id: string, disconnect: boolean, fail = false) => {
    const before = state.fixtureWrites;
    if (fail) state.failNextSave = true;
    action(id).click();
    if (disconnect) {
      await wait(() => document.querySelector('[role="alertdialog"]'), "disconnect confirmation");
      const dialog = document.querySelector('[role="alertdialog"]')!;
      check(dialog.textContent!.includes("断开"), "dirty draft must not trigger a discard-navigation dialog");
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent!.trim() === "断开连接")!.click();
    }
    if (fail) await wait(() => document.body.textContent?.includes("fixture save failed"), "connection save failure");
    else await wait(() => state.fixtureWrites === before + 1, "connection saved");
    await wait(() => !action(id).disabled, "connection request settled");
    if (!fail) {
      check(config.disabledBackends.includes(id) === disconnect, "saved connection intent");
      const enabled = document.getElementById("fixture-enabled-backends")!.textContent!.split(",");
      check(enabled.includes(id) !== disconnect, "mounted backend selectors must update immediately");
      if (!disconnect) await wait(() => row(id).querySelector(".settings-health")?.textContent === "已连接", "reconnected status converged");
    } else {
      check(state.fixtureWrites === before && config.disabledBackends.includes(id), "failed reconnect must preserve the previous connection state");
    }
    retained();
  };
  for (const id of ["openclaw", "hermes", "codex", "shoggoth"]) await toggle(id, true);
  await toggle("codex", false);
  await toggle("shoggoth", false, true);
  await pause(900);
  retained();
  editInput(input, "ws://127.0.0.1:9");
  await wait(() => config.gatewayUrl === input.value, "corrected endpoint auto-saved");
  check(row("openclaw").textContent!.includes("已断开"), "endpoint save must keep the saved connection switch");
  return { disabledBackends: config.disabledBackends, writes: state.fixtureWrites, checks: "in-place disconnect / delayed reconnect / incomplete endpoint / automatic correction / stacked sections / expansion / scroll / failure / mounted selectors" };
};
