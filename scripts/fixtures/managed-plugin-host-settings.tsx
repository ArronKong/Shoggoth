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
const observed = { openclaw: "existing", hermes: "existing" };
scope.configSnapshot = () => JSON.parse(JSON.stringify(config));
window.fetch = async (input: RequestInfo | URL, options: RequestInit = {}) => {
  const url = String(input); scope.fixtureRequests.push({ url, method: options.method || "GET", body: options.body });
  let payload: unknown;
  if (url === "/__api/config") {
    if (options.method === "PUT") config = { ...config, ...JSON.parse(String(options.body)) };
    payload = { config };
  } else if (url === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  else if (url === "/__api/status") payload = { backends: ["openclaw", "hermes"].map(id => ({ id, name: id === "openclaw" ? "OpenClaw" : "Hermes", connected: true,
    disabled: false, info: { connectionMode: id === "openclaw" ? "gateway" : "managed-service", agents: 1 } })) };
  else if (url === "/__api/versions") payload = { versions: ["openclaw", "hermes"].map(id => ({ id, name: id, current: "old", latest: "new", updateAvailable: true, comparisonSupported: true })) };
  else if (url === "/__api/self-updates") payload = { updates: ["openclaw", "hermes"].map(id => ({ id, supported: true, actions: ["update", "repair"], status: null })) };
  else if (/^\/__api\/plugins\/host-runtime\/(openclaw|hermes)$/u.test(url)) {
    const backendId = url.endsWith("hermes") ? "hermes" : "openclaw", mode = observed[backendId];
    payload = { version: 1, backendId, mode, state: mode === "managed" ? "running" : "idle", operationId: null, selectionSupported: mode === "managed", errorCode: null };
  } else return new Response(JSON.stringify({ error: "unsupported fixture endpoint" }), { status: 501 });
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
const card = (backendId: string) => document.querySelector(`[data-managed-plugin-host=${backendId}]`);
const button = (text: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === text);
const writes = () => scope.fixtureRequests.filter((row: any) => row.method !== "GET");
scope.runManagedSettingsFixture = async () => {
  const checks: string[] = [];
  await wait(() => editor() && !editor()!.disabled && card("openclaw") && card("hermes"), "legacy controls ready");
  assert(writes().length === 0, "initial render must never write settings");
  assert(card("hermes")!.getBoundingClientRect().top - card("openclaw")!.getBoundingClientRect().bottom >= 23,
    "managed backend cards need distinct vertical spacing in the actual Settings layout");
  assert(card("openclaw")!.getAttribute("aria-labelledby") !== card("hermes")!.getAttribute("aria-labelledby"), "two cards need distinct names");
  checks.push("full Settings renders both backend cards while existing legacy settings remain usable");
  const input = editor()!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ws://127.0.0.1:10");
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause(20);
  observed.openclaw = "managed"; observed.hermes = "managed";
  button("重新检查", card("openclaw")!)!.click(); button("重新检查", card("hermes")!)!.click();
  await wait(() => !document.querySelector("#settings-openclaw") && !document.querySelector("#settings-hermes"), "managed editors hidden");
  await pause(650);
  assert(config.gatewayUrl === "ws://127.0.0.1:9", "queued legacy connection edit must not write after managed admission");
  assert(writes().length === 0, "mode observation and filtered legacy edits perform no write");
  assert(config.token === "retained-legacy-value" && config.hermesRemotes[0].profile === "retained", "managed controls must preserve old config values");
  checks.push("accurate mode observation hides legacy editors and fences a pending debounced write without erasing old values");
  assert(!Array.from(document.querySelectorAll("button")).some(node => node.textContent?.trim() === "立即更新"), "managed global updater actions must be hidden");
  assert(!document.querySelector(".update-decision"), "managed backend must not show old updater capability decisions");
  assert(!document.querySelector(".settings-update-link") && !document.body.textContent?.includes("vold"), "managed overview cards must not advertise old global versions or updater links");
  checks.push("managed cards suppress ordinary global updater/version action surfaces");
  config = { ...config, openclawPluginHostMode: "managed", hermesPluginHostMode: "managed" };
  scope.remountSettings();
  await wait(() => card("openclaw") && card("hermes") && document.querySelector("#settings-appearance [role=combobox]"), "persisted managed mode remount");
  await pause(100);
  assert(!document.querySelector("#settings-openclaw") && !document.querySelector("#settings-hermes"), "saved managed mode must fence controls before polling");
  assert(writes().length === 0 && scope.fixtureErrors.length === 0, "guard render must remain read-only and error free");
  checks.push("persisted managed modes fence the full Settings form after remount");
  return { verified: true, checks, sourceBoundary: "actual full Settings render; explicit API data doubles, no actual Host/model/updater", userCredentials: 0, modelCalls: 0, runtimeSpawns: 0 };
};
