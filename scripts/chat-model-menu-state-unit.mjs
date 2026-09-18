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
    : name === "../components/FilterTabs" ? () => null
    : name === "../components/FusionLoader" ? ({ label }) => React.createElement("span", { role: "status" }, label)
    : require(name),
  document: { addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: callback => { callback(); return 1; },
  cancelAnimationFrame() {},
});
const Menu = mod.exports.default;
const trigger = renderer => renderer.root.findByProps({ className: "chat-pill chat-pill--select chat-pill--model" });
const contents = renderer => JSON.stringify(renderer.toJSON());
const choice = { id: "native-default", name: "Native Default", provider: "native" };

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
    assert.equal(trigger(renderer).children.join(""), choice.name);
    act(() => { trigger(renderer).props.onClick(); });
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 1);
    const option = renderer.root.findByProps({ role: "option" });
    assert.equal(option.props["aria-selected"], true);
    act(() => { option.props.onClick(); });
    assert.deepEqual(selected, [choice.id, choice.provider]);
    assert.equal(renderer.root.findAllByProps({ role: "listbox" }).length, 0);
  } finally { act(() => renderer.unmount()); }
});

test("no matches means a search miss and a late catalog resolves the default model label", () => {
  let renderer;
  const props = { activeModel: choice.id, activeProvider: choice.provider, onSelect() {} };
  act(() => { renderer = create(React.createElement(Menu, { ...props, models: [], loading: true })); });
  try {
    act(() => { trigger(renderer).props.onClick(); });
    act(() => { renderer.update(React.createElement(Menu, { ...props, models: [choice] })); });
    assert.equal(trigger(renderer).children.join(""), choice.name);
    assert.equal(renderer.root.findByProps({ role: "option" }).props["aria-selected"], true);
    act(() => { renderer.root.findByType("input").props.onChange({ target: { value: "missing" } }); });
    assert.match(contents(renderer), /chat.noModelMatch/);
    assert.doesNotMatch(contents(renderer), /chat.modelCatalogEmpty|chat.modelLoadFailed/);
    act(() => { renderer.root.findByType("input").props.onChange({ target: { value: "" } }); });
    assert.equal(renderer.root.findAllByProps({ role: "option" }).length, 1);
  } finally { act(() => renderer.unmount()); }
});
