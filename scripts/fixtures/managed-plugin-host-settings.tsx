import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Actual full Settings render; API boundaries below are controlled read/write data.
// No actual Host, account, model, global runtime or updater is used.
const scope = window as any;
scope.fixtureErrors = []; scope.fixtureRequests = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
let config: any = { gatewayUrl: "ws://127.0.0.1:9", token: "retained-legacy-value", locale: "zh-CN", theme: "light",
  openclawPluginHostMode: "existing", hermesPluginHostMode: "existing", hermesMode: "remote",
  hermesRemotes: [{ profile: "retained", baseUrl: "http://127.0.0.1:9", token: "retained-legacy-remote" }],
  hermesKeepAlive: true, disabledBackends: [], notifications: { chat: true, cron: true, task: true }, setupCompletedAt: 1 };
scope.configSnapshot = () => JSON.parse(JSON.stringify(config));
window.fetch = async (input: RequestInfo | URL, options: RequestInit = {}) => {
  const url = String(input); scope.fixtureRequests.push({ url, method: options.method || "GET", body: options.body });
  let payload: unknown;
  if (url === "/__api/config") {
    if (options.method === "PUT") config = { ...config, ...JSON.parse(String(options.body)) };
    payload = { config };
  } else if (url === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(descriptor =>
    descriptor.id === "shoggoth" ? { ...descriptor, surfaces: { ...descriptor.surfaces, nativeMemoryConfig: true } } : descriptor) };
  else if (url === "/__api/status") payload = { backends: ["openclaw", "hermes"].map(id => ({ id, name: id === "openclaw" ? "OpenClaw" : "Hermes", connected: true,
    disabled: false, info: { connectionMode: id === "openclaw" ? "gateway" : "managed-service", agents: 1 } })) };
  else if (url === "/__api/versions") payload = { versions: ["openclaw", "hermes"].map(id => ({ id, name: id, current: "old", latest: "new", updateAvailable: true, comparisonSupported: true })) };
  else if (url === "/__api/self-updates") payload = { updates: ["openclaw", "hermes"].map(id => ({ id, supported: true, actions: ["update", "repair"], status: null })) };
  else return new Response(JSON.stringify({ error: "unsupported fixture endpoint" }), { status: 501 });
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};
await applyConfiguredLocale("zh-CN");
function Fixture() {
  const [generation, setGeneration] = useState(0);
  scope.remountSettings = () => setGeneration(value => value + 1);
  return <HashRouter><NavigationGuardProvider><UiProvider><SettingsPage key={generation} /></UiProvider></NavigationGuardProvider></HashRouter>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(condition: () => unknown, name: string) { const deadline = performance.now() + 5000;
  while (!condition()) { if (scope.fixtureErrors.length) throw new Error(scope.fixtureErrors.join("; ")); if (performance.now() > deadline) throw new Error(`bounded Settings observation: ${name}`); await pause(15); }
}
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const editor = () => document.querySelector<HTMLInputElement>("#settings-gateway-url");
const writes = () => scope.fixtureRequests.filter((row: any) => row.method !== "GET");
const backendIds = ["openclaw", "hermes"];
const backendCard = (id: string) => document.querySelector(`article[data-backend="${id}"]`);
const cardsReady = () => backendIds.every(id => backendCard(id)?.querySelector(".settings-health.is-healthy"));
scope.runManagedSettingsFixture = async () => {
  const checks: string[] = [];
  const hiddenTitles = ["多 Agent 群聊", "记忆设置", "OpenClaw 运行环境", "Hermes 运行环境"];
  const checkHiddenModules = () => {
    for (const title of hiddenTitles) {
      assert(!document.body.textContent?.includes(title), `${title} must stay hidden in Settings`);
    }
    assert(!scope.fixtureRequests.some((row: any) => row.url.startsWith("/__api/plugins/host-runtime/")),
      "hidden runtime panels must not fetch host status");
    assert(!document.querySelector("#settings-web, #settings-web-title"), "standalone Web settings must stay hidden");
    assert(!scope.fixtureRequests.some((row: any) => row.url.startsWith("/__api/web-settings")),
      "hidden Web settings must not fetch settings or credentials");
  };
  // OpenClaw connection settings live in a dialog opened from its card.
  await wait(() => cardsReady() && backendIds.every(id => backendCard(id)?.querySelector(".settings-backend-version"))
    && document.querySelector('[data-manage="openclaw"]:enabled'), "existing backend cards and versions ready");
  assert(!editor(), "legacy connection editor stays closed until requested");
  document.querySelector<HTMLButtonElement>('[data-manage="openclaw"]')!.click();
  await wait(() => editor() && !editor()!.disabled, "legacy controls ready");
  assert(editor()?.closest('[role="dialog"]') && editor()?.value === config.gatewayUrl, "existing gateway address is available inside its dialog");
  checkHiddenModules();
  assert(writes().length === 0, "initial render must never write settings");
  checks.push("existing connection dialog is usable while the standalone Web settings and other modules stay hidden");
  config = { ...config, openclawPluginHostMode: "managed", hermesPluginHostMode: "managed" };
  scope.remountSettings();
  await wait(() => scope.fixtureRequests.filter((row: any) => row.url === "/__api/versions").length >= 2
    && cardsReady() && backendIds.every(id => backendCard(id)?.querySelector(".settings-backend-actions button:enabled")),
    "saved managed backend cards ready");
  assert(!document.querySelector("#settings-openclaw, #settings-hermes, [data-manage=openclaw], [data-manage=hermes]"),
    "saved managed modes hide legacy editors and their entry buttons");
  checkHiddenModules();
  assert(config.token === "retained-legacy-value" && config.hermesRemotes[0].profile === "retained", "legacy config values are preserved");
  assert(!Array.from(document.querySelectorAll("button")).some(node => node.textContent?.trim() === "立即更新"), "managed global updater actions must be hidden");
  assert(!document.querySelector(".update-decision"), "managed backend must not show old updater capability decisions");
  assert(!document.querySelector(".settings-update-link") && !document.body.textContent?.includes("vold"), "managed overview cards must not advertise old global versions or updater links");
  checks.push("managed cards suppress ordinary global updater/version action surfaces");
  assert(writes().length === 0 && scope.fixtureErrors.length === 0, "guard render must remain read-only and error free");
  checks.push("persisted managed modes fence the full Settings form after remount");
  return { verified: true, checks, sourceBoundary: "actual full Settings render; explicit API data doubles, no actual Host/model/updater", userCredentials: 0, modelCalls: 0, runtimeSpawns: 0 };
};
