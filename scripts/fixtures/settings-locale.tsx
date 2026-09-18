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
  disabledBackends: [], notifications: { chat: true, cron: false, task: false }, setupCompletedAt: 1,
};
const standalone = new URLSearchParams(location.search).has("standalone");
if (!standalone) state.openclawDesktop = {};
state.fixtureConfig = () => ({ ...config });
state.fixtureWrites = 0;
state.fixtureConfigReads = 0;
state.fixtureConfigEvents = 0;
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
      // Let the real saving/busy guard commit before the host sees the save.
      await pause(25);
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
    } else state.fixtureConfigReads++;
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
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><HashRouter><NavigationGuardProvider><UiProvider>
    {connections ? <EnabledBackendsProbe /> : <PersistentLabel />}{accounts ? <ModelsSettingsPreview /> : <SettingsPage />}
  </UiProvider></NavigationGuardProvider></HashRouter></React.StrictMode>,
);

const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
};
const saveButton = () => document.querySelector<HTMLButtonElement>(".page-head-actions button")!;
const unloadBlocked = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
state.fixtureReady = () => !!document.querySelector("#settings-appearance button[role=combobox]:not(:disabled)");
state.chooseLocale = async (label: string) => {
  document.querySelector<HTMLButtonElement>("#settings-appearance button[role=combobox]")!.click();
  await wait(() => document.querySelectorAll('[role="option"]').length, "language options");
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.replace("✓", "").trim() === label);
  check(option, `missing language option: ${label}`);
  option!.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "", detail: 0 }));
  await wait(() => !saveButton().disabled, "dirty settings");
  await pause(30);
};
state.saveLocale = async (locale: string, title: string) => {
  const writes = state.fixtureWrites;
  saveButton().click();
  await wait(() => state.fixtureWrites === writes + 1, "saved config");
  await wait(() => document.querySelector("h1")?.textContent === title, `visible ${locale} translation`);
  await wait(() => document.body.textContent?.includes(locale === "en" ? "Settings saved." : "设置已保存。"), "localized save notification");
  await wait(() => !unloadBlocked(), "saved navigation guard cleared");
  check(i18n.language === locale && document.documentElement.lang === locale, "active locale and html lang must agree");
  check(document.querySelector("#persistent-label")?.textContent === title, "already-mounted components must translate");
  check(document.querySelector("#persistent-markdown .code-block-copy__idle")?.textContent === (locale === "en" ? "Copy" : "复制"), "cached Markdown controls must translate");
  check(saveButton().disabled, "saved settings must be clean");
};
state.runFixture = async () => {
  await wait(state.fixtureReady, "settings ready");
  check(!document.querySelector('input[name="settings-theme"]'), "theme picker must stay hidden");
  check(!!document.querySelector("#settings-appearance button[role=combobox]"), "language picker must remain visible");
  check(!unloadBlocked(), "clean settings must allow navigation");
  await state.chooseLocale("English");
  check(unloadBlocked(), "unsaved language must protect navigation");
  check(document.querySelector("h1")?.textContent === "设置", "unsaved choice must not apply");
  await state.saveLocale("en", "Settings");
  check(localStorage.getItem("openclaw.i18n.locale") === "en", "saved English must seed boot cache");
  await state.chooseLocale("简体中文");
  await state.saveLocale("zh-CN", "设置");
  await state.chooseLocale("跟随系统");
  const systemLocale = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  await state.saveLocale(systemLocale, systemLocale === "en" ? "Settings" : "设置");
  check(config.locale === "" && localStorage.getItem("openclaw.i18n.locale") === null, "follow-system must clear explicit override");
  await state.chooseLocale(systemLocale === "en" ? "简体中文" : "English");
  state.failNextSave = true;
  saveButton().click();
  await wait(() => document.body.textContent?.includes("fixture save failed"), "save error");
  await wait(() => !saveButton().disabled, "failed save editable");
  check(config.locale === "" && i18n.language === systemLocale, "failed save must retain saved language");
  check(unloadBlocked(), "failed save must retain dirty protection");
  await state.saveLocale(systemLocale === "en" ? "zh-CN" : "en", systemLocale === "en" ? "设置" : "Settings");
  check(state.fixtureConfigEvents === 4, "successful saves must notify persistent components");
  return { locale: config.locale, writes: state.fixtureWrites, checks: "en / zh-CN / system / failure / navigation / persistent UI" };
};

state.runConnectionsFixture = async () => {
  await wait(() => state.fixtureReady() && document.querySelectorAll(".settings-backend").length === 9, "all connections ready");
  document.getElementById("settings-tab-connections")!.click();
  await wait(() => !document.getElementById("settings-panel-connections")!.hidden, "connections tab");
  const heading = document.querySelector("h1");
  const editor = document.getElementById("settings-openclaw") as HTMLDetailsElement;
  editor.open = true;
  const input = document.getElementById("settings-gateway-url") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ws://127.0.0.1:9");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => !saveButton().disabled, "unsaved draft");
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
    check(!document.getElementById("settings-panel-connections")!.hidden, "current category must remain selected");
    check(editor.open && details.getAttribute("aria-expanded") === "true", "expanded editors and backend details must remain open");
    check(input.value === "ws://127.0.0.1:9" && !saveButton().disabled && unloadBlocked(), "unsaved draft must survive and keep its navigation protection");
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
    await wait(() => !action(id).disabled && !saveButton().disabled, "connection request settled");
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
  document.querySelector<HTMLButtonElement>(".settings-savebar .ui-cbtn")!.click();
  await wait(() => !unloadBlocked(), "draft discarded before persistence reload");
  check(input.value === config.gatewayUrl, "discard must restore the saved field");
  check(row("openclaw").textContent!.includes("已断开"), "discarding the draft must keep the saved connection change");
  return { disabledBackends: config.disabledBackends, writes: state.fixtureWrites, checks: "in-place disconnect / delayed reconnect / draft / category / expansion / scroll / failure / mounted selectors" };
};
