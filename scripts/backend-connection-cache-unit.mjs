import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const ts = require("typescript");
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, Error, window: { openclawDesktop: { getConfig: () => ({ disabledBackends: [] }) } },
    require: name => {
      if (name === "../api/client") return { getConfig: async () => ({ disabledBackends: [] }), getBackendDescriptors: async () => [] };
      if (name === "./useStickyState") return { useStickyState: (_key, initial) => React.useState(initial) };
      if (!name.startsWith(".")) return require(name);
      const resolved = path.resolve(path.dirname(file), name);
      return name.endsWith(".json") ? require(resolved) : load(`${resolved}.ts`);
    },
  });
  return module.exports;
}
const { usePageCache } = load(path.join(uiRoot, "src/lib/usePageCache.ts"));
const { applyDisabledBackends } = load(path.join(uiRoot, "src/lib/backends.ts"));
const views = new Map(), requests = [];
const resources = ["dashboard", "cron", "agents", "models", "skills", "cli", "inspiration", "immersive", "usage"];
function Page({ resource }) {
  const page = usePageCache(resource, () => new Promise((resolve, reject) => requests.push({ resource, resolve, reject })));
  views.set(resource, page);
  return React.createElement("output", { resource }, page.data);
}
const latest = resource => requests.findLast(request => request.resource === resource);
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });
let renderer;
await settle(() => { renderer = create(React.createElement(React.Fragment, {},
  ...resources.map(resource => React.createElement(Page, { key: resource, resource })))); });
await settle(() => { for (const request of requests) request.resolve(`all:${request.resource}`); });
for (const resource of resources) assert.equal(views.get(resource).data, `all:${resource}`);

// A page that is not mounted must lose its cached snapshot too.
let dormant;
await settle(() => { dormant = create(React.createElement(Page, { resource: "dormant" })); });
await settle(() => latest("dormant").resolve("old dormant snapshot"));
await settle(() => dormant.unmount());
await settle(() => { for (const page of views.values()) void page.refresh(); });
const oldRequests = resources.map(latest);
const beforeDisconnect = requests.length;
await settle(() => applyDisabledBackends(["openclaw", "hermes"]));
assert.equal(requests.length - beforeDisconnect, resources.length, "Every mounted data resource refreshes exactly once");
for (const resource of resources) {
  assert.equal(views.get(resource).data, undefined, "Old totals disappear before the new request resolves");
  assert.equal(views.get(resource).loading, true);
}
await settle(() => oldRequests.forEach((request, index) => index % 2
  ? request.reject(new Error("late old-scope failure")) : request.resolve("late old-scope result")));
for (const resource of resources) {
  assert.equal(views.get(resource).data, undefined, "A disconnected request cannot refill the cache");
  assert.equal(views.get(resource).error, null, "A stale failure cannot end the new loading state");
}
await settle(() => resources.forEach(resource => latest(resource).resolve(`shoggoth:${resource}`)));
for (const resource of resources) assert.equal(views.get(resource).data, `shoggoth:${resource}`);
await settle(() => { dormant = create(React.createElement(Page, { resource: "dormant" })); });
assert.equal(views.get("dormant").data, undefined, "Returning to an unmounted page cannot resurrect the old scope");
const oldDormant = latest("dormant");
const beforeNoop = requests.length;
await settle(() => applyDisabledBackends(["hermes", "openclaw", "hermes"]));
assert.equal(requests.length, beforeNoop, "Order/duplicates in the same disabled set do not trigger refresh storms");

await settle(() => applyDisabledBackends([]));
for (const resource of [...resources, "dormant"]) assert.equal(views.get(resource).data, undefined, "Reconnect starts a new cache generation");
await settle(() => oldDormant.resolve("late disconnected-scope result"));
assert.equal(views.get("dormant").data, undefined);
await settle(() => [...resources, "dormant"].forEach(resource => latest(resource).resolve(`reconnected:${resource}`)));
await settle(() => { void views.get("dashboard").refresh(); });
await settle(() => latest("dashboard").reject(new Error("temporary network failure")));
assert.equal(views.get("dashboard").data, "reconnected:dashboard", "Temporary transport failures preserve the same-scope snapshot");
assert.equal(views.get("dashboard").error, "temporary network failure");
await settle(() => { renderer.unmount(); dormant.unmount(); });
console.log("PASS shared connection cache: mounted/unmounted pages, disconnect/reconnect, stale success/failure, deduplication and offline retention");
