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
const status = (value = false) => ({ supported: true, available: true, driverVersion: "0.22.0",
  contractVersion: "0.7.0", permissions: { accessibility: value, screenRecording: value }, sessions: [{ id: "computer-a", profileId: "agent-a", workRunId: "run-a",
    allowedApplications: ["com.apple.TextEdit"], status: "ready", createdAt: 1_000,
    updatedAt: 1_000, expiresAt: null, pauseReason: null }] });
let checked = 0;
for (const language of ["zh-CN", "en"]) {
  const dictionary = load(`app/manage-ui/src/i18n/locales/${language}.ts`).default;
  const translator = i18next.createInstance();
  await translator.init({ lng: language, resources: { [language]: { translation: dictionary } }, interpolation: { escapeValue: false } });
  const listeners = new Map();
  const surface = { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  let current = status(), readError = false, reloadBusy = false, reads = 0, prompts = 0, reloads = 0;
  let delayedRead = null, notified = 0;
  const links = [];
  const api = {
    desktopComputerAvailable: () => true,
    getDesktopComputerState: async () => {
      reads += 1;
      if (delayedRead) return delayedRead;
      if (readError) throw Object.assign(new Error("not granted is unknown"), { code: "COMPUTER_SERVICE_UNAVAILABLE" });
      return current;
    },
    requestDesktopComputerPermissions: async () => { prompts += 1; return { accessibility: true, screenRecording: true }; },
    reloadDesktopComputerPermissions: async () => {
      reloads += 1;
      if (reloadBusy) throw Object.assign(new Error("busy"), { code: "COMPUTER_PERMISSION_RELOAD_BUSY" });
      current = status(true); return current;
    },
    openDesktopComputerAccessibilitySettings: async () => { links.push("accessibility"); },
    openDesktopComputerScreenRecordingSettings: async () => { links.push("screenRecording"); },
  };
  const stubs = {
    "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator), i18n: translator }) },
    "../../api/client": api,
    "./SettingsComputerUse.module.css": new Proxy({}, { get: (_, name) => String(name) }),
  };
  const Page = load("app/manage-ui/src/pages/settings/SettingsComputerUse.tsx", stubs,
    { window: surface, document: surface }).default;
  let renderer;
  await act(async () => { renderer = create(React.createElement(Page, { onServiceRestarted: () => notified++ })); });
  const buttons = () => renderer.root.findAllByType("button");
  const button = key => {
    // Permission rows share the same action label; locate the intended row.
    if (key === "accessibilitySettings" || key === "screenRecordingSettings") {
      const kind = key.slice(0, -"Settings".length);
      return renderer.root.findByProps({ "data-permission": kind }).parent.findByType("button");
    }
    return buttons().find(node => node.children.join("") === translator.t(`settings.computerUse.${key}`));
  };
  assert.equal(renderer.root.findAllByType("small").some(node => node.children.join("") === translator.t("settings.computerUse.sessionLifetime")), true);
  assert.equal(JSON.stringify(renderer.toJSON()).includes("Invalid Date"), false);
  const permissions = () => renderer.root.findAll(node => !!node.props["data-permission"]);
  assert.deepEqual(permissions().map(node => node.props["data-state"]), ["false", "false"]);
  await act(async () => { button("grant").props.onClick(); });
  assert.equal(prompts, 1);
  assert.deepEqual(permissions().map(node => node.props["data-state"]), ["false", "false"], "prompt response cannot become a Service grant");
  await act(async () => { button("accessibilitySettings").props.onClick(); });
  await act(async () => { button("screenRecordingSettings").props.onClick(); });
  assert.deepEqual(links, ["accessibility", "screenRecording"]);
  readError = true;
  await act(async () => { button("refresh").props.onClick(); });
  assert.deepEqual(permissions().map(node => node.props["data-state"]), ["unknown", "unknown"]);
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), translator.t("settings.computerUse.serviceUnavailable"));
  readError = false;
  await act(async () => { listeners.get("focus")(); });
  assert.deepEqual(permissions().map(node => node.props["data-state"]), ["false", "false"]);
  reloadBusy = true;
  await act(async () => { button("reload").props.onClick(); });
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), translator.t("settings.computerUse.reloadBusy"));
  assert.equal(button("reload").props.disabled, false, "busy refusal leaves an explicit retry");
  reloadBusy = false;
  let resolveRead;
  delayedRead = new Promise(resolve => { resolveRead = resolve; });
  await act(async () => { listeners.get("focus")(); });
  await act(async () => { button("reload").props.onClick(); });
  assert.equal(notified, 1);
  await act(async () => { resolveRead(status(false)); });
  delayedRead = null;
  assert.deepEqual(permissions().map(node => node.props["data-state"]), ["true", "true"], "pre-restart status cannot overwrite the new generation");
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), translator.t("settings.computerUse.ready"));
  assert.equal(prompts, 1, "focus and visibility checks never prompt");
  assert.equal(reloads, 2);
  current = status(false);
  await act(async () => { listeners.get("focus")(); });
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), translator.t("settings.computerUse.grantHint"),
    "revocation must clear a previous permission-ready message");
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);
  const before = reads;
  api.desktopComputerAvailable = () => false;
  await act(async () => { renderer = create(React.createElement(Page)); });
  assert.equal(reads, before);
  assert.ok(buttons().every(node => node.props.disabled));
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), translator.t("settings.computerUse.desktopOnly"));
  await act(async () => { renderer.unmount(); });
  checked += 11;
}
console.log(`Computer Use settings UI: PASS (${checked} localized cases, unknown state, post-grant check, reload race, retry, desktop boundary)`);
