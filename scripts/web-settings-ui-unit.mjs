import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = require("react"), { act, create } = require("react-test-renderer"), ts = require("typescript"), i18next = require("i18next");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function compile(file, stubs) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => stubs[name] || require(name), structuredClone });
  return module.exports;
}
const resources = compile("app/manage-ui/src/i18n/webSettingsResources.ts", {}).webSettingsResources;
let checks = 0;
for (const language of ["zh-CN", "en"]) {
  const translator = i18next.createInstance(); await translator.init({ lng: language });
  const pending = [], api = {}, defer = (kind, args) => new Promise((resolve, reject) => pending.push({ kind, args: structuredClone(args), resolve, reject }));
  api.getWebSettings = () => defer("read", {});
  api.setWebSettings = args => defer("selectors", args);
  api.setWebProviderKey = args => defer("key", args);
  api.clearWebProviderKey = args => defer("clear", args);
  let guard;
  const Field = props => React.createElement("label", {}, props.label, props.children);
  const Select = props => React.createElement("select", props, props.children);
  const Option = props => React.createElement("option", props, props.children);
  const TextInput = props => React.createElement("input", props);
  const Component = compile("app/manage-ui/src/pages/settings/SettingsWeb.tsx", {
    "../../api/web": api, "../../components/Field": { Field, Select, Option, TextInput },
    "../../lib/navigation-guard": { useNavigationGuard: state => { guard = state; } },
    "react-i18next": { useTranslation: () => ({ t: translator.getFixedT(language, "webSettings") }) },
    "../../i18n": { __esModule: true, default: translator }, "../../i18n/webSettingsResources": { webSettingsResources: resources },
    "./SettingsWeb.module.css": { __esModule: true, default: {} },
  }).default;
  const snapshot = (revision = 0, config = { searchProvider: "exa", fetchProvider: "direct" }, stored = []) => ({ revision, config,
    credentials: Object.fromEntries(["exa", "brave", "tavily", "tinyfish"].map(provider => [provider, { configured: stored.includes(provider), revision: stored.includes(provider) ? revision + 1 : null }])) });
  let tree;
  const mount = async () => { await act(async () => { tree = create(React.createElement(Component)); }); };
  const settle = async (kind, result, reject = false) => {
    const entry = pending.shift(); assert.equal(entry?.kind, kind); await act(async () => entry[reject ? "reject" : "resolve"](result)); return entry;
  };
  const providerForm = provider => tree.root.find(node => node.type === "form" && node.props["data-web-provider"] === provider);
  const input = provider => providerForm(provider).findByType("input");
  const enter = async (provider, value) => { await act(async () => input(provider).props.onChange({ target: { value } })); };
  const submit = async form => { await act(async () => form.props.onSubmit({ preventDefault() {} })); };
  const choose = async (index, value) => { await act(async () => tree.root.findAllByType("select")[index].props.onChange(value)); };
  const button = text => tree.root.findAllByType("button").find(node => node.children.includes(translator.t(text, { ns: "webSettings" })));
  await mount(); assert.equal(pending.length, 1); await settle("read", snapshot());
  assert.equal(tree.root.findAllByType("select")[0].findAllByType("option").length, 4);
  assert.equal(tree.root.findAllByType("select")[1].findAllByType("option").some(option => option.props.value === "brave"), false);
  assert.equal(tree.root.findAllByType("input").every(node => node.props.type === "password"), true); checks += 3;
  await choose(0, "brave"); await enter("tinyfish", "fixture-private-key"); assert.equal(guard.dirty, true);
  await submit(providerForm("tinyfish")); assert.equal(pending[0].kind, "key");
  assert.deepEqual(pending[0].args, { provider: "tinyfish", expectedRevision: null, apiKey: "fixture-private-key" });
  assert.equal(input("tinyfish").props.disabled, true); await submit(providerForm("tinyfish")); assert.equal(pending.length, 1); checks += 2;
  await settle("key", snapshot(3, { searchProvider: "tavily", fetchProvider: "direct" }, ["tinyfish"]));
  assert.equal(input("tinyfish").props.value, ""); assert.equal(tree.root.findAllByType("select")[0].props.value, "brave");
  await submit(tree.root.findAllByType("form")[0]); assert.equal(pending[0].args.expectedRevision, 0, "key response cannot adopt a concurrent selector revision"); checks += 2;
  await settle("selectors", Object.assign(Error("private transport detail"), { code: "WEB_SETTINGS_CONFLICT" }), true);
  assert.equal(tree.root.findByProps({ role: "alert" }).children.join(""), translator.t("errors.conflict", { ns: "webSettings" }));
  assert.equal(JSON.stringify(tree.toJSON()).includes("private transport detail"), false); assert.equal(guard.dirty, true); checks++;
  await act(async () => button("reload").props.onClick()); await settle("read", snapshot(3, { searchProvider: "tavily", fetchProvider: "direct" }, ["tinyfish"]));
  assert.equal(guard.dirty, false); await choose(1, "tinyfish"); await submit(tree.root.findAllByType("form")[0]);
  assert.equal(pending[0].args.expectedRevision, 3); await settle("selectors", snapshot(4, { searchProvider: "tavily", fetchProvider: "tinyfish" }, ["tinyfish"])); checks++;
  await enter("brave", "bad key"); await submit(providerForm("brave"));
  await settle("key", Object.assign(Error("private"), { code: "WEB_SETTINGS_INVALID" }), true);
  assert.equal(input("brave").props.disabled, false); assert.equal(input("brave").props.value, "bad key");
  await act(async () => guard.onDiscard()); assert.equal(input("brave").props.value, ""); checks++;
  const clear = providerForm("tinyfish").findAllByType("button").find(node => node.props.type === "button");
  await act(async () => clear.props.onClick()); assert.equal(pending[0].kind, "clear");
  await act(async () => tree.unmount()); await mount(); assert.equal(pending.length, 1);
  await settle("clear", snapshot(4)); await settle("read", snapshot(4));
  assert.equal(guard.dirty, false); assert.equal(JSON.stringify(tree.toJSON()).includes("fixture-private-key"), false); checks++;
  await act(async () => tree.unmount()); assert.equal(pending.length, 0);
}
console.log(`PASS web settings rendered React: ${checks} checks across Chinese/English, separate selectors/keys, stale writes, deletion, conflict drafts, remount and masking`);
