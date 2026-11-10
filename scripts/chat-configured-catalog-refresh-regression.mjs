#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui/src");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript"), React = require("react");
const { act, create } = require("react-test-renderer");
const catalog = id => ({ defaultModel: `p/${id}`, models: [
  { id, name: id, provider: "p", backendId: "openclaw", available: true },
  { id, name: "Same ID, other provider", provider: "other", backendId: "openclaw", available: true },
  { id: "offline", name: "Unavailable default", provider: "p", backendId: "openclaw", available: false },
] });
const tick = async () => { await new Promise(setImmediate); };

function fixture() {
  const requests = [], watches = new Map(), modules = new Map(), views = new Map();
  const load = file => {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = name => name === "../api/client" ? {
      getAgentModels: (backend, agentId) => new Promise((resolve, reject) => requests.push({ backend, agentId, resolve, reject })),
    } : name === "../model-catalog-store" ? {
      subscribeModelCatalog: (backend, listener) => {
        if (!watches.has(backend)) watches.set(backend, new Set());
        watches.get(backend).add(listener);
        return () => watches.get(backend).delete(listener);
      },
    } : name.startsWith(".") ? load(path.resolve(path.dirname(file), name) + ".ts") : require(name);
    vm.runInNewContext(`(function(require,module,exports){${compiled}\n})(require,module,module.exports)`, {
      require: localRequire, module, console, Promise, Error,
    });
    modules.set(file, module.exports);
    return module.exports;
  };
  const { useAgentModelCatalog } = load(path.join(uiRoot, "lib/useAgentModelCatalog.ts"));
  const { invalidatePageCache } = load(path.join(uiRoot, "lib/usePageCache.ts"));
  function Probe({ surface, agentId = "a", backend = "openclaw", connected = true }) {
    const value = useAgentModelCatalog(backend, agentId, { connected });
    views.set(surface, value);
    return React.createElement("output", { "data-surface": surface }, JSON.stringify(value.models));
  }
  const render = specs => React.createElement(React.Fragment, {}, ...specs.map(spec => React.createElement(Probe, { key: spec.surface, ...spec })));
  const publish = backend => {
    for (const listener of watches.get(backend) || []) listener({ backendId: backend,
      catalogRevision: "a".repeat(64), models: [{ id: "admin-only" }], verifiedAt: Date.now() });
  };
  return { requests, watches, views, render, publish, invalidatePageCache };
}

test("three menus share Agent rows, availability, defaults, requests and open-menu refreshes", async () => {
  const f = fixture(); let renderer;
  const surfaces = ["chat", "agents", "inspiration"].map(surface => ({ surface }));
  await act(async () => { renderer = create(f.render(surfaces)); await tick(); });
  try {
    assert.equal(f.requests.length, 1, "concurrent consumers coalesce discovery");
    assert.equal(f.requests[0].agentId, "a");
    const first = catalog("first");
    await act(async () => f.requests[0].resolve(first));
    for (const { surface } of surfaces) {
      assert.equal(f.views.get(surface).data, first);
      assert.equal(f.views.get(surface).models.length, 3, "do not collapse providers or hide unavailable rows");
      assert.equal(f.views.get(surface).loading, false);
    }
    assert.equal(f.watches.get("openclaw").size, 1, "one management invalidation listener");
    let refresh;
    await act(async () => {
      refresh = f.views.get("agents").refresh();
      assert.equal(f.views.get("chat").refresh(), refresh);
      await tick();
    });
    assert.equal(f.requests.length, 2);
    const second = catalog("second");
    await act(async () => { f.requests[1].resolve(second); await refresh; });
    for (const { surface } of surfaces) assert.equal(f.views.get(surface).data, second);
    await act(async () => { f.views.get("agents").invalidate(); await tick(); });
    assert.equal(f.requests.length, 3, "saving an Agent default refreshes every consumer together");
    await act(async () => f.requests[2].resolve(catalog("saved-default")));
    assert.equal(f.views.get("inspiration").data.defaultModel, "p/saved-default");
  } finally { act(() => renderer.unmount()); }
  assert.equal(f.watches.get("openclaw").size, 0);
});

test("switching Agent/backend or connection never displays a previous scope or its late reply", async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(f.render([{ surface: "chat" }])); await tick(); });
  try {
    await act(async () => { renderer.update(f.render([{ surface: "chat", agentId: "b" }])); await tick(); });
    assert.equal(f.views.get("chat").data, undefined);
    await act(async () => f.requests[1].resolve(catalog("agent-b")));
    await act(async () => f.requests[0].resolve(catalog("late-agent-a")));
    assert.equal(f.views.get("chat").models[0].id, "agent-b");
    await act(async () => { renderer.update(f.render([{ surface: "chat", backend: "other", agentId: "b" }])); await tick(); });
    assert.equal(f.views.get("chat").data, undefined);
    assert.equal(f.requests[2].backend, "other");
    await act(async () => { f.invalidatePageCache(); await tick(); });
    assert.equal(f.requests.length, 4, "a changed connection has its own request");
    await act(async () => f.requests[3].resolve(catalog("new-connection")));
    await act(async () => f.requests[2].resolve(catalog("late-old-connection")));
    assert.equal(f.views.get("chat").models[0].id, "new-connection");
  } finally { act(() => renderer.unmount()); }
});

test("management invalidation retires late reads and never inserts the management all catalog", async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(f.render([{ surface: "chat" }, { surface: "agents" }])); await tick(); });
  try {
    await act(async () => f.requests[0].resolve(catalog("initial")));
    let oldRead;
    await act(async () => { oldRead = f.views.get("chat").refresh(); await tick(); });
    act(() => f.publish("hermes"));
    assert.equal(f.requests.length, 2, "other backends do not invalidate OpenClaw");
    await act(async () => { f.publish("openclaw"); await tick(); });
    assert.equal(f.requests.length, 3);
    assert.equal(f.views.get("chat").models[0].id, "initial");
    await act(async () => f.requests[2].resolve(catalog("current")));
    await act(async () => { f.requests[1].resolve(catalog("late-old")); await oldRead; });
    assert.equal(f.views.get("chat").models[0].id, "current");
    assert.equal(f.views.get("agents").models[0].id, "current");
  } finally { act(() => renderer.unmount()); }
});

test("cold failures, retries, cached failures and reconnect settle identically for all menus", async () => {
  const f = fixture(); let renderer;
  await act(async () => { renderer = create(f.render([{ surface: "chat" }, { surface: "inspiration" }])); await tick(); });
  try {
    await act(async () => f.requests[0].reject(new Error("offline")));
    for (const value of f.views.values()) { assert.equal(value.error, "offline"); assert.equal(value.loading, false); }
    let read;
    await act(async () => { read = f.views.get("inspiration").refresh(); await tick(); });
    await act(async () => { f.requests[1].resolve(catalog("recovered")); await read; });
    let failed;
    await act(async () => { failed = assert.rejects(f.views.get("chat").refresh(), /again/); await tick(); });
    await act(async () => { f.requests[2].reject(new Error("again")); await failed; });
    for (const value of f.views.values()) { assert.equal(value.models[0].id, "recovered"); assert.equal(value.error, "again"); }
    await act(async () => { renderer.update(f.render([{ surface: "chat", connected: false }])); await tick(); });
    assert.equal(f.requests.length, 3);
    await act(async () => { renderer.update(f.render([{ surface: "chat", connected: true }])); await tick(); });
    assert.equal(f.requests.length, 4);
    await act(async () => f.requests[3].resolve(catalog("reconnected")));
    assert.equal(f.views.get("chat").error, null);
  } finally { act(() => renderer.unmount()); }
});

test("all three production entry points use the shared Agent catalog", () => {
  const chat = fs.readFileSync(path.join(uiRoot, "pages/ChatPage.tsx"), "utf8");
  const agents = fs.readFileSync(path.join(uiRoot, "pages/AgentsPage.tsx"), "utf8");
  const inspiration = fs.readFileSync(path.join(uiRoot, "pages/InspirationThread.tsx"), "utf8");
  for (const source of [chat, agents, inspiration]) assert.match(source, /useAgentModelCatalog\(/);
  assert.doesNotMatch(chat, /openClawModelCacheRef|send\("models\.list"/);
  assert.doesNotMatch(agents, /getModelCatalog|readModelCatalog/);
  assert.match(agents, /onRefresh=\{\(\) => \{ void agentModelCatalog\.refresh\(/);
  assert.match(inspiration, /agent\.backendId === 'openclaw' \? agentCatalog\.data : inspirationCatalog\.data/);
});
