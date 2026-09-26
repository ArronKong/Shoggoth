import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const file = path.join(root, "app/manage-ui/src/lib/agentServiceRestart.ts");
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(source, { exports: module.exports });
const { observeAgentService: observe, INITIAL_AGENT_SERVICE_RESTART_STATE: initial } = module.exports;
const background = { supported: true, installed: true, enabled: true, loaded: true, needsRepair: false };
const healthy = { healthy: true, startedAt: 100, domainAvailability: { kanban: true, cron: true },
  pendingCommandsLocked: false, mcpCredentialsLocked: false };
// Matches the unavailable status shown in Settings, including conservative locks.
const offline = { healthy: false, domainAvailability: { kanban: false, cron: false },
  pendingCommandsLocked: true, mcpCredentialsLocked: true };
const ready = observe(initial, healthy, background, 0);
assert.equal(ready.notice, null, "Healthy first observation is silent");
const lazyMcp = { ...healthy, mcpCredentialsLocked: true };
assert.equal(observe(initial, lazyMcp, background, 0).state.wasHealthy, true,
  "Lazy MCP credential initialization must not make startup unhealthy");
assert.equal(observe(ready.state, lazyMcp, background, 15_000).notice, null,
  "Optional MCP credentials must not trigger a background-service fault");

let sample = observe(ready.state, offline, background, 5_000);
assert.equal(sample.notice, "recovering", "A running service failure must notify immediately");
sample = observe(sample.state, offline, background, 10_000);
assert.equal(sample.notice, null, "Polling must not repeat the same fault notification");
sample = observe(sample.state, null, undefined, 15_000);
assert.equal(sample.notice, null, "A subsequent host failure is still the same outage");
sample = observe(sample.state, healthy, background, 20_000);
assert.equal(sample.notice, null, "Recovery with the same startedAt is not a restart");
sample = observe(sample.state, offline, background, 25_000);
assert.equal(sample.notice, "recovering", "A new outage after recovery must notify again");
sample = observe(sample.state, { ...healthy, startedAt: 200 }, background, 30_000);
assert.equal(sample.notice, "restarted", "An authoritative changed startedAt still reports restart");
assert.equal(observe(sample.state, { ...healthy, startedAt: 200 }, background, 35_000).notice, null);

sample = observe(ready.state, null, undefined, 5_000);
assert.equal(sample.notice, "recovering", "Rejected or timed-out host requests must not be swallowed");
assert.equal(sample.state.startedAt, 100, "Host failure must preserve the last confirmed generation");
assert.equal(observe(sample.state, { ...healthy, startedAt: 200 }, background, 10_000).notice, "restarted");

for (const failure of [offline, null]) {
  sample = observe(initial, failure, failure ? background : undefined, 0);
  assert.equal(sample.notice, null, "Normal startup gets the LaunchAgent's health budget");
  for (const now of [5_000, 15_000, 44_999]) {
    sample = observe(sample.state, failure, failure ? background : undefined, now);
    assert.equal(sample.notice, null, "Repeated startup samples must preserve the grace deadline");
  }
  sample = observe(sample.state, failure, failure ? background : undefined, 45_000);
  assert.equal(sample.notice, "recovering", "An already broken service must eventually notify without a healthy baseline");
  assert.equal(observe(sample.state, failure, failure ? background : undefined, 50_000).notice, null);
}
sample = observe(initial, offline, background, 0);
sample = observe(sample.state, healthy, background, 40_000);
assert.equal(sample.notice, null, "Startup that recovers within budget stays silent");

for (const fault of [
  { pendingCommandsLocked: true },
  { domainAvailability: { kanban: false, cron: true } },
  { domainAvailability: { kanban: true, cron: false } },
]) {
  const degraded = { ...healthy, ...fault };
  sample = observe(ready.state, degraded, background, 5_000);
  assert.equal(sample.notice, null, "Brief crypto/domain warm-up must not cause false alarms");
  const transientRecovery = observe(sample.state, healthy, background, 10_000);
  assert.equal(transientRecovery.notice, null);
  sample = observe(sample.state, degraded, background, 15_000);
  assert.equal(sample.notice, "recovering", "Persistent locked or unavailable domains must notify");
  assert.equal(observe(sample.state, degraded, background, 20_000).notice, null);
}

for (const loaded of [true, false]) {
  sample = observe(ready.state, offline, { ...background, enabled: false, loaded }, 5_000);
  assert.equal(sample.notice, null, "Deliberate stop, including disable-before-bootout, must stay silent");
  sample = observe(sample.state, offline, { ...background, enabled: false, loaded }, 60_000);
  assert.equal(sample.notice, null);
  sample = observe(sample.state, offline, background, 65_000);
  assert.equal(sample.notice, null, "Starting again receives a fresh startup grace");
  assert.equal(observe(sample.state, offline, background, 110_000).notice, "recovering");
}
assert.equal(observe(ready.state, offline, { ...background, loaded: false }, 5_000).notice,
  "recovering", "Enabled but unloaded is not an intentional stop");
assert.equal(observe(ready.state, offline, { ...background, enabled: false, needsRepair: true }, 5_000).notice,
  "recovering", "Repair-required status must not be hidden as an intentional stop");
for (const reason of ["unsupported-platform", "unstable-install-location"]) {
  sample = observe(initial, offline, { supported: false, reason }, 0);
  assert.equal(observe(sample.state, offline, { supported: false, reason }, 60_000).notice, null,
    "An initially unsupported environment must stay silent");
}
sample = observe(initial, offline, { supported: false, reason: "status-unavailable" }, 0);
assert.equal(observe(sample.state, offline, { supported: false, reason: "status-unavailable" }, 45_000).notice,
  "recovering", "Failed background diagnostics must not be confused with unsupported environments");
assert.equal(observe(initial, { ...healthy, startedAt: undefined }, background, 0).state.wasHealthy, true,
  "An absent optional startedAt is not itself a service failure");

// Mount the real App shell; page bodies are irrelevant to its global monitor.
const React = require("react");
const { create, act } = require("react-test-renderer");
const notices = [], intervals = new Map(), listeners = new Map();
let response = { service: healthy, background }, rejectRequest = false, pending = null;
let pathname = "/settings", calls = 0, timerId = 0;
const toast = { error: key => notices.push({ type: "error", key }), info: key => notices.push({ type: "info", key }) };
const t = key => key;
const doc = {
  visibilityState: "visible",
  addEventListener: (name, callback) => listeners.set(name, callback),
  removeEventListener: name => listeners.delete(name),
};
const localRequire = name => {
  if (name === "react") return { ...React, lazy: () => () => null };
  if (name === "react-router-dom") return { useLocation: () => ({ pathname, search: "" }),
    NavLink: () => null, Navigate: () => null, Route: () => null, Routes: () => null };
  if (name === "react-i18next") return { useTranslation: () => ({ t }) };
  if (name.endsWith("/components/ui")) return { useToast: () => toast };
  if (name.endsWith("/api/client")) return { getShoggothProductStatus: async signal => {
    calls++;
    assert.ok(signal instanceof AbortSignal, "Status probes must carry a timeout signal");
    if (pending) return pending;
    if (rejectRequest) throw new Error("fixture transport failure");
    return response;
  } };
  if (name.endsWith("/lib/agentServiceRestart")) return module.exports;
  if (name.endsWith("/lib/inspiration-navigation")) return { useInspirationReturnTarget: () => "/inspirations" };
  if (name.endsWith("/lib/navigation-guard")) return { useNavigationRequest: () => () => {} };
  if (name.endsWith("/lib/page-refresh")) return { useHasPageRefresh: () => false, usePageLoading: () => false };
  if (name.endsWith("/components/debug/store")) return { useDebugEnabled: () => false };
  if (name.endsWith("/components/NavIcons")) return { NAV_ICON_COMPONENTS: {} };
  if (name.endsWith("/lib/productTelemetry")) return { installProductActivityListener: () => () => {} };
  if (name.endsWith("/lib/desktop-inspiration")) return { desktopInspirationBridge: () => null };
  if (name.endsWith("/pages/inspiration-fonts")) return { loadInspirationFonts: async () => {} };
  if (name.endsWith(".svg")) return name;
  if (name.startsWith("./components/")) return { __esModule: true, default: () => null };
  return require(name);
};
const appModule = { exports: {} };
const appSource = ts.transpileModule(fs.readFileSync(path.join(root, "app/manage-ui/src/App.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
vm.runInNewContext(appSource, { exports: appModule.exports, require: localRequire, document: doc,
  AbortSignal, window: {
    setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: () => ++timerId, clearTimeout: () => {},
  },
});
const App = appModule.exports.default;
const settle = async callback => act(async () => { callback?.(); await new Promise(setImmediate); });
const poll = () => settle(() => [...intervals.values()].forEach(callback => callback()));
let renderer;
await settle(() => { renderer = create(React.createElement(App)); });
assert.equal(notices.length, 0);
response = { service: offline, background };
await poll();
assert.deepEqual(notices, [{ type: "error", key: "common.agentServiceRecovering" }],
  "App must display a red global toast for the Settings reconnect state");
await poll();
pathname = "/dashboard";
await settle(() => renderer.update(React.createElement(App)));
await poll();
assert.equal(notices.length, 1, "Polling and route changes must not duplicate the outage");
response = { service: healthy, background };
await poll();
rejectRequest = true;
await poll();
assert.equal(notices.length, 2, "The global toast must also cover failed status requests on another page");
assert.equal(notices[1].type, "error");
rejectRequest = false;
response = { service: { ...healthy, startedAt: 200 }, background };
await poll();
assert.deepEqual(notices[2], { type: "info", key: "common.agentServiceRestarted" });

doc.visibilityState = "hidden";
response = { service: offline, background };
const beforeHidden = calls;
await poll();
assert.equal(calls, beforeHidden, "Hidden windows must not consume the notification");
doc.visibilityState = "visible";
await settle(() => listeners.get("visibilitychange")());
assert.equal(notices.length, 4, "Returning to the window must immediately check service health");

response = { service: healthy, background };
await poll();
let resolvePending;
pending = new Promise(resolve => { resolvePending = resolve; });
await poll();
const beforeOverlap = calls;
await poll();
assert.equal(calls, beforeOverlap, "Pending probes must not overlap");
await settle(() => renderer.unmount());
const beforeUnmount = notices.length;
await settle(() => resolvePending({ service: offline, background }));
assert.equal(notices.length, beforeUnmount, "A late response after unmount must not notify");
assert.equal(intervals.size, 0);
assert.equal(listeners.size, 0);

console.log("PASS agent service notifications: state transitions and mounted App polling, red toasts, route deduplication, request failures, visibility and cleanup");
