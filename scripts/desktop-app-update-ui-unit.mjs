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
const i18next = require("i18next");

function load(file, stubs = {}) {
  const source = path.join(root, file);
  const localRequire = createRequire(source);
  const compiled = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
    module, require: (name) => {
      if (stubs[name]) return stubs[name];
      if (name.startsWith(".")) {
        const dependency = path.resolve(path.dirname(source), name);
        const typescript = [".ts", ".tsx"].map(extension => dependency + extension).find(fs.existsSync);
        if (typescript) return load(path.relative(root, typescript), stubs);
      }
      return localRequire(name);
    },
  });
  return module.exports;
}

const dictionaries = Object.fromEntries(["zh-CN", "en"].map((language) => [language,
  load(`app/manage-ui/src/i18n/locales/${language}.ts`).default]));
const downloaded = { supported: true, reason: null, status: "downloaded", currentVersion: "0.8.152",
  availableVersion: "0.8.153", releaseName: null, releaseDate: null, progress: 100,
  canCheck: false, canInstall: true, installBlockReason: null, automaticUpdates: false };
let checkedStates = 0;
for (const language of ["zh-CN", "en"]) {
  const translator = i18next.createInstance();
  await translator.init({ lng: language, fallbackLng: language,
    resources: { [language]: { translation: dictionaries[language] } }, interpolation: { escapeValue: false } });
  let listener;
  let unsubscribed = false;
  let saveFails = false;
  const bridge = {
    getState: async () => downloaded,
    onState: (next) => { listener = next; return () => { unsubscribed = true; }; },
    setAutomatic: async (enabled) => {
      if (saveFails) throw new Error("Could not write setting");
      return { ...downloaded, automaticUpdates: enabled };
    },
    install: async () => { throw new Error("IPC disconnected"); },
  };
  const Page = load("app/manage-ui/src/pages/settings/SettingsAppUpdate.tsx", {
    "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator) }) },
    "../../lib/appUpdate": { appUpdateBridge: () => bridge },
    "../../components/Field": { Switch: ({ checked, disabled, onChange, label }) =>
      React.createElement("input", { role: "switch", checked, disabled, onChange, "aria-label": label }) },
    "./SettingsIcons": { SettingsIcon: () => null },
  }).default;
  let renderer;
  await act(async () => { renderer = create(React.createElement(Page)); });
  const hint = () => renderer.root.findByProps({ role: "status" });
  const buttons = () => renderer.root.findAllByType("button");
  assert.equal(hint().children.join(""), translator.t("settings.appUpdate.downloaded", { version: "0.8.153" }));
  assert.equal(hint().props["aria-live"], "polite");
  const toggle = () => renderer.root.findByProps({ role: "switch" });
  assert.equal(toggle().props.checked, false);
  await act(async () => { toggle().props.onChange(true); });
  assert.equal(toggle().props.checked, true);
  saveFails = true;
  await act(async () => { toggle().props.onChange(false); });
  assert.equal(toggle().props.checked, true, "a failed save keeps the last saved preference");
  assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), translator.t("settings.appUpdate.preferenceError"));
  assert.equal(renderer.root.findAllByType("a").length, 0);
  const Project = load("app/manage-ui/src/pages/settings/SettingsProject.tsx", {
    "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator) }) },
    "./SettingsIcons": { SettingsIcon: () => null },
  }).default;
  let projectRenderer;
  await act(async () => { projectRenderer = create(React.createElement(Project)); });
  const github = projectRenderer.root.findByType("a");
  assert.equal(github.props.href, "https://github.com/ArronKong/Shoggoth");
  assert.equal(github.props.target, "_blank");
  await act(async () => { projectRenderer.unmount(); });
  for (const reason of Object.keys(dictionaries[language].settings.appUpdate.installBlocked)) {
    await act(async () => { listener({ ...downloaded, installBlockReason: reason }); });
    assert.equal(hint().children.join(""), translator.t(`settings.appUpdate.installBlocked.${reason}`));
    assert.equal(buttons()[0].props.disabled, false, "blocked installation keeps an explicit retry action");
    checkedStates += 1;
  }
  await act(async () => { listener({ ...downloaded, installBlockReason: "future-reason" }); });
  assert.equal(hint().children.join(""), translator.t("settings.appUpdate.installBlocked.unknown"));
  for (const status of ["preparing", "recovering"]) {
    await act(async () => { listener({ ...downloaded, status, canInstall: false }); });
    assert.equal(hint().children.join(""), translator.t(`settings.appUpdate.${status}`));
    assert.equal(buttons().length, 1);
    assert.equal(buttons()[0].props.disabled, true);
    assert.equal(renderer.root.findAllByType("progress").length, 0);
    checkedStates += 1;
  }
  await act(async () => { listener(downloaded); });
  await act(async () => { buttons()[0].props.onClick(); });
  assert.equal(hint().children.join(""), translator.t("settings.appUpdate.installBlocked.unknown"));
  assert.equal(buttons()[0].props.disabled, false, "a rejected install IPC must leave the page retryable");
  await act(async () => { renderer.unmount(); });
  assert.equal(unsubscribed, true);
}
console.log(`Desktop App update UI unit: PASS (${checkedStates} localized states, fallback, retry and cleanup)`);
