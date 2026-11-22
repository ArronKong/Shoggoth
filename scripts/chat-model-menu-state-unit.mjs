import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const React = require("react");
const { act, create } = require("react-test-renderer");
const FilterTabs = () => null;
const BackendTabIcon = ({ backend }) => React.createElement("span", { "data-backend-icon": backend });
const filename = path.join(root, "app/manage-ui/src/pages/ChatModelMenu.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename,
  compilerOptions: {
    esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
  module: mod,
  require: name => name.endsWith(".css") ? {}
    : name === "react-dom" ? { createPortal: node => node }
    : name === "react-i18next" ? { useTranslation: () => ({ t: key => key }) }
    : name === "../lib/useComposerPopupPosition" ? { useComposerPopupPosition: () => ({}) }
    : name === "../lib/useScrollFade" ? { useScrollFade: () => ({ ref() {} }) }
    : name === "../components/BackendTabIcon" ? BackendTabIcon
    : name === "../components/FilterTabs" ? FilterTabs
    : name === "../components/FusionLoader" ? ({ label }) => React.createElement("span", { role: "status" }, label)
    : name === "./chatIcons" ? { IconSearch: () => React.createElement("svg", { "aria-hidden": true }), IconModel: () => React.createElement("svg", { "aria-hidden": true }) }
    : require(name),
  document: { addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: callback => { callback(); return 1; },
  cancelAnimationFrame() {},
});
const Menu = mod.exports.default;
const trigger = renderer => renderer.root.findByProps({ "aria-haspopup": "listbox" });
const triggerLabel = renderer => trigger(renderer).findByProps({ className: "chat-pill__label" }).children.join("");
const contents = renderer => JSON.stringify(renderer.toJSON());
const choice = { id: "native-default", name: "Native Default", provider: "native" };

test("native tabs show runtime icons and section titles appear only in All", () => {
  const runtimeGroups = [
    { runtime: "codex", bindingId: "bundled", name: "Shoggoth", available: true },
    { runtime: "codex", bindingId: "local", name: "Codex", available: true },
  ];
  const models = runtimeGroups.map(group => ({
    ...choice, name: `${group.name} Model`, bindingId: group.bindingId, runtime: group.runtime, runtimeName: group.name,
  }));
  let renderer;
  act(() => { renderer = create(React.createElement(Menu, {
    models, runtimeGroups, activeModel: "", onSelect() {},
  })); });
  try {
    act(() => trigger(renderer).props.onClick());
    const filter = renderer.root.findByType(FilterTabs);
    const listbox = renderer.root.findByProps({ role: "listbox" });
    assert.equal(filter.props.centerOnEdgeSelection, true);
    const labels = () => renderer.root.findAllByProps({ className: "model-menu__label" });
    assert.equal(listbox.props["data-filtered"], undefined);
    assert.deepEqual(Array.from(filter.props.items, item => item.leadingIcon?.props.backend ?? null), [null, "shoggoth", "codex"]);
    assert.deepEqual(labels().map(label => label.findByType(BackendTabIcon).props.backend), ["shoggoth", "codex"]);
    for (const group of runtimeGroups) {
      act(() => filter.props.onChange(group.bindingId));
      assert.equal(listbox.props["data-filtered"], true);
      assert.equal(labels().length, 0);
      const option = renderer.root.findByProps({ role: "option" });
      assert.deepEqual(option.findByProps({ className: "model-menu__name" }).children, [`${group.name} Model`]);
    }
    act(() => filter.props.onChange(""));
    assert.equal(listbox.props["data-filtered"], undefined);
    assert.deepEqual(labels().map(label => label.findByType(BackendTabIcon).props.backend), ["shoggoth", "codex"]);
  } finally { act(() => renderer.unmount()); }
});

test("unavailable configured models stay visible and selected but cannot be chosen", () => {
  let renderer;
  act(() => { renderer = create(React.createElement(Menu, {
    models: [{ ...choice, available: false }, { ...choice, id: "ready", available: true }],
    activeModel: choice.id, activeProvider: choice.provider, onSelect() {},
  })); });
  try {
    act(() => trigger(renderer).props.onClick());
    const options = renderer.root.findAllByProps({ role: "option" });
    assert.equal(options.length, 2);
    assert.equal(options[0].props["aria-selected"], true);
    assert.equal(options[0].props.disabled, true);
    assert.equal(options[1].props.disabled, false);
    assert.equal(triggerLabel(renderer), choice.name);
  } finally { act(() => renderer.unmount()); }
});

test("model discovery distinguishes loading, failure with retry, and an empty catalog", () => {
  let refreshes = 0;
  let renderer;
  const props = { models: [], activeModel: "", onSelect() {}, onRefresh: () => refreshes++ };
  act(() => { renderer = create(React.createElement(Menu, { ...props, loading: true })); });
  try {
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(refreshes, 1, "opening an empty menu requests discovery");
    assert.match(contents(renderer), /chat.loadingModels/);
    assert.doesNotMatch(contents(renderer), /chat.noModelMatch|chat.modelCatalogEmpty|chat.modelLoadFailed/);

    act(() => { renderer.update(React.createElement(Menu, { ...props, loadError: true })); });
    const alert = renderer.root.findByProps({ role: "alert" });
    assert.match(contents(renderer), /chat.modelLoadFailed/);
    assert.doesNotMatch(contents(renderer), /chat.noModelMatch|chat.modelCatalogEmpty/);
    act(() => { alert.findByType("button").props.onClick(); });
    assert.equal(refreshes, 2, "failure offers a working retry action");

    act(() => { renderer.update(React.createElement(Menu, props)); });
    assert.match(contents(renderer), /chat.modelCatalogEmpty/);
    assert.doesNotMatch(contents(renderer), /chat.noModelMatch|chat.modelLoadFailed/);
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(refreshes, 2, "closing does not start another request");
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(refreshes, 3, "reopening can recover a later failure");
  } finally { act(() => renderer.unmount()); }
});

test("failed refresh preserves the current model and cached choices remain selectable", () => {
  let selected;
  let renderer;
  act(() => { renderer = create(React.createElement(Menu, {
    models: [choice], activeModel: choice.id, activeProvider: choice.provider,
    loadError: true, onSelect: (...args) => { selected = args; }, onRefresh() {},
  })); });
  try {
    assert.equal(triggerLabel(renderer), choice.name);
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 1);
    const option = renderer.root.findByProps({ role: "option" });
    assert.equal(option.props["aria-selected"], true);
    act(() => { option.props.onClick(); });
    assert.deepEqual(selected, [choice.id, choice.provider]);
    assert.equal(renderer.root.findAllByProps({ role: "listbox" }).length, 0);
  } finally { act(() => renderer.unmount()); }
});

test("deleting the selected provider never activates another provider with the same model ID", () => {
  let renderer;
  act(() => { renderer = create(React.createElement(Menu, {
    models: [{ id: "same", name: "Other Provider Model", provider: "other" }],
    activeModel: "same", activeProvider: "deleted", onSelect() {},
  })); });
  try {
    assert.equal(triggerLabel(renderer), "same");
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(renderer.root.findByProps({ role: "option" }).props["aria-selected"], false);
  } finally { act(() => renderer.unmount()); }
});

test("no matches means a search miss and a late catalog resolves the default model label", () => {
  let renderer;
  const props = { activeModel: choice.id, activeProvider: choice.provider, onSelect() {} };
  act(() => { renderer = create(React.createElement(Menu, { ...props, models: [], loading: true })); });
  try {
    act(() => { trigger(renderer).props.onClick(); });
    act(() => { renderer.update(React.createElement(Menu, { ...props, models: [choice] })); });
    assert.equal(triggerLabel(renderer), choice.name);
    assert.equal(renderer.root.findByProps({ role: "option" }).props["aria-selected"], true);
    act(() => { renderer.root.findByType("input").props.onChange({ target: { value: "missing" } }); });
    assert.match(contents(renderer), /chat.noModelMatch/);
    assert.doesNotMatch(contents(renderer), /chat.modelCatalogEmpty|chat.modelLoadFailed/);
    act(() => { renderer.root.findByType("input").props.onChange({ target: { value: "" } }); });
    assert.equal(renderer.root.findAllByProps({ role: "option" }).length, 1);
  } finally { act(() => renderer.unmount()); }
});
