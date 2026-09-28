import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const ts = require("typescript");
const releasePolicy = JSON.parse(fs.readFileSync(path.join(root, "app/release-policy.json"), "utf8"));
const ids = ["openclaw", "hermes", "shoggoth"]
  .filter(id => !releasePolicy.disabledRuntimes.includes(id));
let disabledBackends = [];
const api = {
  getConfig: async () => ({ disabledBackends }),
  getBackendDescriptors: async () => [],
};
function load(file, stubs = {}, desktop = { getConfig: () => ({ disabledBackends }) }) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true,
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
    module: mod, require: name => stubs[name] || (name === "./usePageCache" ? { invalidatePageCache() {} }
      : name === "../../../release-policy.json" ? releasePolicy : require(name)),
    window: { openclawDesktop: desktop },
  });
  return mod.exports;
}
const loadBackends = () => load("app/manage-ui/src/lib/backends.ts", {
  "../api/client": api,
  "./useStickyState": { useStickyState: (_key, initial) => React.useState(initial) },
});
const { FALLBACK_BACKEND_DESCRIPTORS } = loadBackends();
assert.deepEqual(Array.from(FALLBACK_BACKEND_DESCRIPTORS, d => d.id), ids);
const toggleIds = Array.from(FALLBACK_BACKEND_DESCRIPTORS.filter(d => d.disconnectable), d => d.id);
assert.deepEqual(toggleIds, ["openclaw", "hermes"].filter(id => ids.includes(id)));
assert.equal(FALLBACK_BACKEND_DESCRIPTORS.find(d => d.id === "shoggoth")?.disconnectable, false);
const Overview = load("app/manage-ui/src/pages/settings/BackendOverview.tsx", {
  "react-i18next": { useTranslation: () => ({ t: key => key }) },
  "../../lib/connectionOptions": { REMOTE_CONNECTIONS_ENABLED: false },
  "../../components/BackendTabIcon": { __esModule: true, default: () => null },
}).default;
const descriptors = new Map(FALLBACK_BACKEND_DESCRIPTORS.map(d => [d.id, d]));
const render = async (disabled, extra = {}) => {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Overview, {
      backends: ids.map(id => ({ id, name: id, connected: !disabled.includes(id), disabled: disabled.includes(id), info: {} })),
      descriptors, versions: new Map(), loading: false, configFailed: false,
      attention: () => false, renderDetails: () => null,
      isDisconnectable: b => descriptors.get(b.id).disconnectable,
      enabledCount: ids.length - disabled.length, onToggle: () => {}, onConfigure: () => {}, ...extra,
    }));
  });
  return renderer;
};
const row = (renderer, id) => renderer.root.findAllByType("article")
  .find(node => node.findByType("h4").children.join("") === id);
const toggle = (renderer, id) => row(renderer, id).findAllByType("button")
  .find(node => ["settings.disconnect", "settings.reconnect"].includes(node.children.join("")));
// The guard follows the enabled count supplied by Settings; the built-in
// Shoggoth service itself does not expose a disconnect button.
{
  const renderer = await render([], { enabledCount: 1 });
  for (const id of toggleIds) {
    assert.equal(toggle(renderer, id).props.disabled, true, `protect last connection ${id}`);
    assert.equal(toggle(renderer, id).props.title, "settings.disconnectLastHint");
  }
  assert.equal(toggle(renderer, "shoggoth"), undefined);
  await act(async () => renderer.unmount());
}
for (const disconnected of toggleIds) {
  disabledBackends = [disconnected];
  const renderer = await render(disabledBackends, { enabledCount: 1 });
  assert.equal(toggle(renderer, disconnected).children.join(""), "settings.reconnect");
  assert.equal(toggle(renderer, disconnected).props.disabled, false, `allow ${disconnected} to reconnect`);
  await act(async () => renderer.unmount());

  const { useEnabledBackends } = loadBackends();
  function Enabled() { return React.createElement("output", { ids: useEnabledBackends("chat") }); }
  let enabled;
  await act(async () => { enabled = create(React.createElement(Enabled)); });
  assert.deepEqual(Array.from(enabled.root.findByType("output").props.ids),
    ids.filter(id => id !== disconnected), "external switches must update mounted backend selectors");
  await act(async () => enabled.unmount());
}
for (const disabled of [[], ["hermes"], ["openclaw"], ["openclaw", "hermes"]]) {
  const renderer = await render(disabled);
  for (const id of toggleIds) assert.equal(toggle(renderer, id).props.disabled, false);
  assert.equal(toggle(renderer, "shoggoth"), undefined);
  await act(async () => renderer.unmount());
}
for (const blocked of [{ loading: true }, { configFailed: true }]) {
  const renderer = await render([], blocked);
  for (const id of toggleIds) {
    assert.equal(toggle(renderer, id).props.disabled, true);
    assert.equal(toggle(renderer, id).props.title, undefined, "loading/error is not a last-connection warning");
  }
  await act(async () => renderer.unmount());
}

// Mounted backend switches and newly mounted pages must update without a reload.
disabledBackends = [];
{
  const { useEnabledBackends, applyDisabledBackends } = loadBackends();
  function Enabled() { return React.createElement("output", { ids: useEnabledBackends("chat") }); }
  let mounted, later;
  await act(async () => { mounted = create(React.createElement(Enabled)); });
  await act(async () => applyDisabledBackends(["openclaw", "hermes"]));
  assert.deepEqual(Array.from(mounted.root.findByType("output").props.ids), ["shoggoth"]);
  await act(async () => { later = create(React.createElement(Enabled)); });
  assert.deepEqual(Array.from(later.root.findByType("output").props.ids), Array.from(mounted.root.findByType("output").props.ids));
  await act(async () => applyDisabledBackends([]));
  for (const renderer of [mounted, later]) {
    assert.deepEqual(Array.from(renderer.root.findByType("output").props.ids), ids);
    await act(async () => renderer.unmount());
  }
}
{
  let resolveConfig;
  const pendingConfig = new Promise(resolve => { resolveConfig = resolve; });
  const { useEnabledBackends, applyDisabledBackends } = load("app/manage-ui/src/lib/backends.ts", {
    "../api/client": { ...api, getConfig: () => pendingConfig },
    "./useStickyState": { useStickyState: (_key, initial) => React.useState(initial) },
  }, {});
  function Enabled() { return React.createElement("output", { ids: useEnabledBackends() }); }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Enabled)); });
  await act(async () => applyDisabledBackends(["openclaw"]));
  await act(async () => resolveConfig({ disabledBackends: [] }));
  assert.deepEqual(Array.from(renderer.root.findByType("output").props.ids),
    ids.filter(id => id !== "openclaw"), "an old config request must not undo a saved disconnect");
  await act(async () => renderer.unmount());
}

// Exercise the actual desktop configuration reaction with isolated adapters.
const source = fs.readFileSync(path.join(root, "app/ui-entry.js"), "utf8");
const ast = ts.createSourceFile("ui-entry.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["connectionFieldsChanged", "applyConfigChange"].includes(node.name?.text))
  .map(node => node.getText(ast)).join("\n");
const calls = [];
let config = { gatewayUrl: "", hermesMode: "local", hermesRemotes: [], disabledBackends: [] };
const backends = new Map(ids.map(id => [id, {
  getBackendDescriptor: () => descriptors.get(id),
  stop: async () => calls.push([id, "stop"]), start: async () => calls.push([id, "start"]),
}]));
const context = vm.createContext({ configStore: { read: () => config }, appliedConfig: config,
  appBackendRegistry: { backends, start: id => backends.get(id).start() }, nativeTheme: {}, buildMenu() {},
  mainWindow: { webContents: { reload: () => calls.push(["window", "reload"]) } }, console,
});
vm.runInContext(functions, context);
for (const id of toggleIds) {
  config = { ...config, disabledBackends: [id] };
  calls.length = 0;
  await context.applyConfigChange();
  assert.deepEqual(calls, [[id, "stop"]], "disconnect must not reload the settings page");
  config = { ...config, disabledBackends: [] };
  calls.length = 0;
  await context.applyConfigChange();
  assert.deepEqual(calls, [[id, "start"]], "reconnect must not reload the settings page");
}
// Endpoint autosaves refresh the affected transport without reloading the form.
config = { ...config, gatewayUrl: "ws://127.0.0.1:18793" };
calls.length = 0;
await context.applyConfigChange();
assert.deepEqual(calls, [["openclaw", "stop"]]);
backends.get("hermes").reconfigure = async () => calls.push(["hermes", "reconfigure"]);
config = { ...config, hermesMode: "remote" };
calls.length = 0;
await context.applyConfigChange();
assert.deepEqual(calls, [["hermes", "reconfigure"]]);
console.log(`PASS settings: ${toggleIds.length} disconnectable backend controls, built-in service protection, final connection guard, reconnect, backend filtering and live endpoint changes`);
