import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AgentMainModelField from "../../app/manage-ui/src/pages/agents/AgentMainModelField";
import { useAgentModelSettings } from "../../app/manage-ui/src/pages/agents/useAgentModelSettings";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import ov from "../../app/manage-ui/src/pages/AgentsPage.module.css";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Mount the production hook and picker; all external I/O is in-memory.
const scope = window as any;
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 6000;
  while (!predicate()) {
    check(!errors.length, errors.join("\n"));
    check(performance.now() < deadline, message);
    await pause();
  }
};
const selections: Record<string, { provider: string; model: string }> = {
  first: { provider: "alpha", model: "shared-model" },
  second: { provider: "alpha", model: "second-model" },
};
const providers = [
  { slug: "alpha", name: "Alpha Subscription", models: ["shared-model", "second-model", "blocked-model"],
    unavailableModels: ["blocked-model"], capabilities: { "shared-model": { reasoning: true, fast: true } } },
  { slug: "beta", name: "Beta API", models: ["shared-model", "beta-only"] },
  { slug: "unconfigured", name: "Unconfigured Provider", models: [], authenticated: false, authType: "api_key", keyEnv: "FIXTURE_ONLY_KEY" },
];
const writes: Array<{ profile: string; provider: string; model: string }> = [];
let rejectNext = false, rejectRead = false, rejectReadAfterWrite = false;
let releaseWrite: (() => void) | undefined;
let holdWrite = false, notifications = 0;
window.fetch = async (input, init) => {
  const url = new URL(String(input), "https://fixture.invalid");
  check(url.searchParams.get("backend") === "hermes", "backend identity is preserved");
  if (url.pathname === "/__api/models/settings" && !init?.method) {
    if (rejectRead) { rejectRead = false; return Response.json({ error: "fixture catalog failure" }, { status: 502 }); }
    const profile = url.searchParams.get("profile")!;
    return Response.json({ supported: true, profile, profiles: ["first", "second"],
      providers, main: selections[profile], defaults: { reasoningEffort: "xhigh", serviceTier: "normal" } });
  }
  check(url.pathname === "/__api/models/settings/main" && init?.method === "POST", "no credential or default-parameter writes");
  const body = JSON.parse(String(init!.body));
  writes.push(body);
  if (holdWrite) { holdWrite = false; await new Promise<void>(resolve => { releaseWrite = resolve; }); }
  else await pause(80);
  if (rejectNext) { rejectNext = false; return Response.json({ error: "fixture save rejected" }, { status: 422 }); }
  selections[body.profile] = { provider: body.provider, model: body.model };
  if (rejectReadAfterWrite) { rejectReadAfterWrite = false; rejectRead = true; }
  return Response.json({ ok: true, ...selections[body.profile], staleAux: [] });
};

function Fixture() {
  const [profile, setProfile] = useState("first");
  const state = useAgentModelSettings({ backend: "hermes", profile, reloadToken: 0,
    onMainModelChanged: () => { notifications++; }, onNavigate: () => { throw Error("hidden setup must not navigate"); } });
  scope.state = state;
  scope.switchProfile = setProfile;
  return <main data-agent-overview-panel style={{ position: "relative", margin: 16, height: "calc(100vh - 32px)",
    padding: "clamp(16px, 4vw, 48px)", background: "var(--ui-surface-1)", borderRadius: 24, boxSizing: "border-box" }}>
    <section className={ov.ovSection} style={{ maxWidth: 600, margin: "auto" }}>
      <h2 id="model-label" className={ov.ovSectionTitle}>Default model</h2>
      <div className={ov.ovSectionBody}><AgentMainModelField key={profile} state={state} labelId="model-label" /></div>
    </section>
  </main>;
}

const trigger = () => document.querySelector<HTMLButtonElement>(".chat-model-menu > button")!;
const options = () => [...document.querySelectorAll<HTMLButtonElement>(".model-menu__item")];
const inputValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const openMenu = async () => {
  await wait(() => trigger() && !scope.state.loading && !scope.state.applying, "model picker ready");
  if (trigger().getAttribute("aria-expanded") !== "true") trigger().click();
  await wait(() => document.querySelector(".model-menu") && !scope.state.loading, "menu refreshed");
};
const closeMenu = async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".model-menu"), "menu closed");
};
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.model-menu [role="tab"]')]
  .find(item => item.textContent === name)!;
const choose = async (providerName: string, model: string) => {
  await openMenu(); tab(providerName).click();
  await wait(() => options().some(item => item.title === model), "provider models visible");
  const option = options().find(item => item.title === model)!;
  option.click();
  return option;
};

scope.runMainModelMenu = async () => {
  await wait(() => trigger(), "initial model");
  check(trigger().textContent?.includes("shared-model"), "saved model shown");
  check(!document.querySelector('details, [role="combobox"], [role="switch"]'), "setup, reasoning and fast controls hidden");
  await openMenu();
  check(options().filter(item => item.title === "shared-model").length === 2, "same model id preserved across providers");
  check(options().filter(item => item.getAttribute("aria-selected") === "true").length === 1, "only exact provider selected");
  const blocked = options().find(item => item.title === "blocked-model")!;
  check(blocked.disabled, "unavailable model disabled"); blocked.click();
  check(writes.length === 0, "disabled choice does not write");
  inputValue(document.querySelector<HTMLInputElement>(".model-menu__search")!, "beta-only");
  await wait(() => options().length === 1, "search filters catalog");
  const candidate = options()[0]; candidate.click(); candidate.click();
  await wait(() => scope.state.applying, "saving state visible");
  check(trigger().textContent?.includes("shared-model"), "pending save retains confirmed model");
  await wait(() => !scope.state.applying && trigger().textContent?.includes("beta-only"), "selection saved without Apply button");
  check(writes.length === 1 && writes[0].provider === "beta" && writes[0].profile === "first", "one qualified write for double click");

  rejectNext = true;
  await choose("Alpha Subscription", "shared-model");
  await wait(() => !scope.state.applying && document.body.textContent?.includes("fixture save rejected"), "failed save reported");
  check(trigger().textContent?.includes("beta-only"), "failed save keeps prior model");
  await choose("Alpha Subscription", "shared-model");
  await wait(() => !scope.state.applying && trigger().textContent?.includes("shared-model"), "retry accepted");
  const savedWrites = writes.length;
  await choose("Alpha Subscription", "shared-model"); await pause();
  check(writes.length === savedWrites, "reselecting current model does not write");

  rejectRead = true;
  await openMenu();
  check(!!document.querySelector(".model-menu__error") && options().length === 0, "failed catalog cannot offer stale writes");
  document.querySelector<HTMLButtonElement>(".model-menu__error button")!.click();
  await wait(() => options().length > 0 && !scope.state.error, "catalog retry succeeds");
  await closeMenu();

  rejectReadAfterWrite = true;
  await choose("Beta API", "shared-model");
  await wait(() => !scope.state.applying && scope.state.error, "post-save refresh failed");
  check(scope.state.main.provider === "beta", "confirmed save survives failed refresh");
  await openMenu(); await closeMenu();

  holdWrite = true;
  await choose("Beta API", "beta-only");
  await wait(() => releaseWrite, "held write pending");
  const notified = notifications;
  scope.switchProfile("second");
  await wait(() => scope.state.profile === "second" && !scope.state.loading, "new profile loaded");
  releaseWrite!(); releaseWrite = undefined;
  await pause(100);
  check(scope.state.main.model === "second-model" && notifications === notified, "old completion cannot overwrite new agent");
  check(writes.at(-1)?.profile === "first", "in-flight write keeps original profile");
  check(errors.length === 0, errors.join("\n"));
  return { writes: writes.length, cases: ["qualified selection", "disabled model", "search", "single write", "failure and retry",
    "catalog failure", "confirmed save with refresh failure", "profile switch", "hidden controls preserve defaults"] };
};

scope.checkMainModelGeometry = async (locale: string, theme: string) => {
  document.documentElement.dataset.theme = theme;
  await applyConfiguredLocale(locale);
  await openMenu();
  await pause(100);
  const menu = document.querySelector<HTMLElement>(".model-menu")!;
  const rect = menu.getBoundingClientRect();
  check(menu.parentElement?.hasAttribute("data-agent-overview-panel"), "menu portals outside field layout");
  check(rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, "menu fits viewport");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  check(!document.querySelector('details, [role="combobox"], [role="switch"]'), "advanced options remain hidden");
  return { width: innerWidth, locale, theme, menuWidth: Math.round(rect.width), menuHeight: Math.round(rect.height) };
};
void applyConfiguredLocale("zh-CN").then(() => createRoot(document.getElementById("root")!).render(<UiProvider><Fixture /></UiProvider>));
