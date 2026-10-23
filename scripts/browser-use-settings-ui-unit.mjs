import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = require("react"), { create, act } = require("react-test-renderer");
const ts = require("typescript"), i18next = require("i18next");
function load(file, stubs = {}, globals = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})(require,module,module.exports);`, {
    module, require: name => stubs[name] || (name === "../productToolLabels"
      ? load("app/manage-ui/src/i18n/productToolLabels.ts") : require(name)), ...globals,
  });
  return module.exports;
}
let checks = 0;
for (const language of ["zh-CN", "en"]) {
  const translator = i18next.createInstance();
  await translator.init({ lng: language, resources: { [language]: { translation: load(`app/manage-ui/src/i18n/locales/${language}.ts`).default } }, interpolation: { escapeValue: false } });
  const listeners = new Map();
  const surface = { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let desktop = true, readError = false, delayed = null, reads = 0;
  let current = { available: true, reason: null, browser: "chrome", engineVersion: "0.0.82", sessions: [{
    id: "browser-a", profileId: "agent-a", workRunId: "run-a", browser: "chrome",
    headless: false, isolated: true, status: "ready", expiresAt: null,
  }] };
  const api = { desktopBrowserAvailable: () => desktop, getDesktopBrowserState: async () => {
    reads++; if (delayed) return delayed; if (readError) throw new Error("service unavailable"); return current;
  } };
  const Field = props => React.createElement("field", props, props.children);
  const Switch = props => React.createElement("switch", props);
  const Select = props => React.createElement("select", props, props.children);
  const Option = props => React.createElement("option", props, props.children);
  const Component = load("app/manage-ui/src/pages/settings/SettingsBrowserUse.tsx", {
    "../../api/client": api, "../../components/Field": { Field, Switch, Select, Option },
    "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator), i18n: { language } }) },
    "./SettingsBrowserUse.module.css": { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) },
  }, { window: surface, document: surface, setInterval: () => 1, clearInterval() {} }).default;
  let cfg = { browserUse: { enabled: true, browser: "chrome", headless: false, isolated: true } }, tree;
  const change = patch => { cfg = { ...cfg, ...patch }; tree.update(React.createElement(Component, { cfg, onChange: change, disabled: false })); };
  const render = async disabled => { await act(async () => { tree = create(React.createElement(Component, { cfg, onChange: change, disabled })); }); };
  await render(false);
  const status = () => tree.root.find(node => node.props["data-browser-state"] !== undefined).props["data-browser-state"];
  const switches = () => tree.root.findAllByType("switch");
  assert.equal(tree.root.findAllByType("small").some(node => node.children.join("") === translator.t("settings.browserUse.sessionLifetime")), true);
  checks++;
  assert.equal(status(), "ready"); assert.equal(switches().length, 3); assert.equal(reads > 0, true); checks++;
  await act(async () => switches()[1].props.onChange(true));
  assert.equal(cfg.browserUse.headless, true); assert.equal(cfg.browserUse.isolated, true); checks++;
  await act(async () => switches()[2].props.onChange(true));
  assert.equal(cfg.browserUse.isolated, false); checks++;
  current = { ...current, available: false, reason: "BROWSER_EXECUTABLE_UNAVAILABLE" };
  await act(async () => tree.root.findByType("button").props.onClick());
  assert.equal(status(), "browserMissing"); assert.equal(cfg.browserUse.browser, "chrome");
  assert.equal(tree.root.findAllByType("select").length, 0); checks++;
  await act(async () => switches()[0].props.onChange(false));
  assert.equal(status(), "disabled"); assert.equal(switches()[1].props.disabled, true); checks++;
  current = { ...current, browser: "chrome", available: true, reason: null };
  cfg = { browserUse: { ...cfg.browserUse, enabled: true, browser: "chrome" } };
  await act(async () => tree.update(React.createElement(Component, { cfg, onChange: change, disabled: false })));
  readError = true;
  await act(async () => tree.root.findByType("button").props.onClick());
  assert.equal(status(), "serviceUnavailable"); assert.equal(tree.root.findAllByType("details").length, 0); checks++;
  let release;
  delayed = new Promise(resolve => { release = resolve; }); readError = false;
  await act(async () => tree.root.findByType("button").props.onClick());
  delayed = null;
  current = { ...current, available: false, reason: "BROWSER_ENGINE_UNAVAILABLE" };
  await act(async () => listeners.get("focus")());
  await act(async () => release({ ...current, available: true, reason: null }));
  assert.equal(status(), "engineMissing", "a stale read cannot overwrite current engine failure"); checks++;
  await act(async () => tree.unmount()); assert.equal(listeners.size, 0);
  desktop = false; await render(false);
  assert.equal(status(), "desktopOnly"); assert.equal(tree.root.findByType("button").props.disabled, true); checks++;
  await act(async () => tree.unmount());
  desktop = true; await render(true);
  assert.equal(switches().every(node => node.props.disabled), true); checks++;
  await act(async () => tree.unmount());
}
console.log(`PASS Browser Use Settings (${checks} checks, Chinese and English, toggles, failures, stale reads, desktop boundary)`);
