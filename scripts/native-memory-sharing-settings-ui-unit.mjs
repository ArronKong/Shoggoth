import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { act, create } = require("react-test-renderer"), ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pending = []; let guard;
const deferred = (kind, args) => new Promise((resolve, reject) => pending.push({ kind, args, resolve, reject }));
const api = { getNativeMemorySharingConfig: () => deferred("read"), getNativeMemorySharingContext: () => deferred("context"),
  updateNativeMemorySharingConfig: input => deferred("write", structuredClone(input)) };
const fields = { Switch: ({ label, checked, onChange, disabled }) => React.createElement("input", { type: "checkbox", title: label, checked, onChange, disabled }) };
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, structuredClone, Set, Object, Error,
    require: name => {
      if (name.endsWith('/api/client')) return api;
      if (name.endsWith('/components/Field')) return fields;
      if (name.endsWith('/navigation-guard')) return { useNavigationGuard: value => { guard = value; } };
      if (name.endsWith('/nativeMemoryForm')) return load("src/lib/nativeMemoryForm.ts");
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key, args) => args?.id ? `${key}:${args.id}` : key }) };
      return require(name);
    },
  }); cache.set(relative, module.exports); return module.exports;
}
const Component = load("src/pages/settings/NativeMemorySharingSettings.tsx").default;
const config = (enabled = true, excludedProfiles = []) => ({ enabled, excludedProfiles });
const context = (revision, names = ["a", "b"], gated = false) => ({ owner: "shoggoth-memory-core", revision,
  featureReady: !gated, effectiveEnabled: !gated, agents: names.map(id => ({ profileId: id, agentId: `public-${id}`, name: `Agent ${id}`, participating: true })) });
let renderer;
const mount = async () => { await act(async () => { renderer = create(React.createElement(Component)); }); };
const settle = async (kind, value, reject = false) => {
  const request = pending.shift(); assert.equal(request?.kind, kind);
  await act(async () => { request[reject ? "reject" : "resolve"](value); }); return request;
};
const choose = async (title, value) => { await act(async () => { renderer.root.findByProps({ title }).props.onChange(value); }); };
const selected = title => renderer.root.findByProps({ title }).props.checked;
const submit = async () => { await act(async () => { void renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); }); };
const button = key => renderer.root.findAllByType("button").find(node => node.children.includes(key));
await mount(); await settle("read", { revision: 3, config: config() }); await settle("context", context(3, undefined, true));
assert.ok(JSON.stringify(renderer.toJSON()).includes("nativeMemorySharing.gated"));
assert.equal(selected("Agent a"), true); assert.equal(selected("Agent b"), true); assert.equal(guard.dirty, false);
await choose("Agent b", false); assert.equal(guard.dirty, true); await submit();
assert.deepEqual(pending[0].args, { expectedRevision: 3, config: config(true, ["b"]) });
assert.equal(guard.busy, true); await choose("Agent a", false); assert.equal(selected("Agent a"), true, "pending write freezes participant edits");
await settle("write", { revision: 4, config: config(true, ["b"]) }); await settle("context", context(4));
assert.equal(guard.dirty, false); assert.equal(guard.busy, false); assert.equal(selected("Agent b"), false);
await choose("nativeMemorySharing.enabled", false); await submit();
await settle("write", Object.assign(Error("private transport payload"), { code: "NATIVE_MEMORY_SHARING_CONFLICT" }), true);
assert.equal(selected("nativeMemorySharing.enabled"), false, "conflict preserves draft"); assert.equal(guard.dirty, true);
assert.equal(button("common.save").props.disabled, true);
assert.equal(JSON.stringify(renderer.toJSON()).includes("private transport payload"), false);
assert.equal(renderer.root.findByProps({ role: "alert" }).children[0], "nativeMemory.conflict");
await choose("Agent a", false); assert.equal(selected("Agent a"), true, "conflict freezes edits until refresh");
await act(async () => { button("nativeMemory.discardReload").props.onClick(); });
await settle("read", { revision: 6, config: config(true, ["b", "missing"]) }); await settle("context", context(6, ["a", "b", "new"]));
assert.equal(selected("Agent new"), true, "new Profile dynamically participates");
assert.equal(selected("nativeMemory.unavailableAgent:missing"), false, "unavailable exclusions remain recoverable");
await choose("nativeMemory.unavailableAgent:missing", true); await submit();
assert.deepEqual(pending[0].args.config.excludedProfiles, ["b"]);
await settle("write", { revision: 7, config: config(true, ["b"]) }); await settle("context", context(7, ["a", "b", "new"]));
await choose("Agent b", true); await submit();
const write = pending[0]; assert.deepEqual(write.args.config, config());
await act(async () => { renderer.unmount(); }); await mount();
assert.equal(pending.length, 1, "new instance waits for outstanding write before reading");
await settle("write", { revision: 8, config: config() });
await settle("read", { revision: 8, config: config() }); await settle("context", context(8, ["a", "b", "new"]));
assert.equal(guard.dirty, false); assert.equal(selected("Agent new"), true);
await choose("nativeMemorySharing.enabled", false); await submit();
await settle("write", Object.assign(Error("bad config"), { code: "NATIVE_MEMORY_SHARING_INVALID" }), true);
assert.equal(button("common.save").props.disabled, false, "known validation failure keeps editable draft");
await act(async () => { guard.onDiscard(); }); assert.equal(guard.dirty, false); assert.equal(selected("nativeMemorySharing.enabled"), true);
const json = JSON.stringify(renderer.toJSON());
for (const key of ["scopeHint", "providerHint", "workspaceHint", "runtimeHint"]) assert.ok(json.includes(`nativeMemorySharing.${key}`));
assert.equal(json.includes("recall-status"), false);
await act(async () => { renderer.unmount(); }); assert.equal(pending.length, 0);
console.log("PASS rendered sharing settings: independent CAS, trusted gate, default/new participants, persistent exclusions, freeze/conflict retention, missing Profile restoration, remount race, global off, provenance/provider/workspace/Runtime disclosure");
