#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { build } from "../app/manage-ui/node_modules/esbuild/lib/main.js";

const root = path.resolve(import.meta.dirname, "..");
const pagePath = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const source = fs.readFileSync(pagePath, "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
let manualRefresh;
let normalize;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("const cached = openClawModelCacheRef.current.get(agentId)")) {
    effect = node.arguments[0].getText(ast);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "refreshChatOrThrow") {
    manualRefresh = node.initializer.getText(ast);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "openClawChatModels") normalize = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(effect && manualRefresh && normalize, "exercise the real Chat effect and manual refresh");
const compiled = ts.transpileModule(`${normalize}\nglobalThis.mount = ${effect};\nglobalThis.refresh = ${manualRefresh};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

// Use the production store so the same publish path as ModelsPage invalidates mounted Chat.
if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
  };
}
const bundled = await build({
  entryPoints: [path.join(root, "app/manage-ui/src/model-catalog-store.ts")],
  bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
});
const { createModelCatalogStore } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const values = new Map();
const store = createModelCatalogStore({
  storage: {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  },
  events: new EventTarget(),
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const model = id => ({ id, name: id, provider: "fixture" });
const rpcReply = id => ({ payload: { models: [model(id)] } });
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
let revision = 0;
function publish(backendId = "openclaw") {
  store.publishApplied({ backendId, catalogRevision: (++revision).toString(16).padStart(64, "0"),
    models: [{ ...model("admin-only-model"), backendId }], verifiedAt: Date.now() });
}
const requests = [];
const history = [];
let rendered = [];
let loading;
const context = {
  activeModelsBackend: "openclaw",
  activeModelsAgentId: "qa-agent",
  activeKeyRef: { current: "agent:qa-agent:main" },
  connected: true,
  modelsBackendRef: { current: "" },
  openClawModelCacheRef: { current: new Map() },
  refreshActiveModelsRef: { current: null },
  setModels: next => { rendered = next; },
  setModelsLoading: next => { loading = next; },
  send: (method, params) => {
    const request = { method, params, ...deferred() };
    requests.push(request);
    return request.promise;
  },
  subscribeModelCatalog: store.subscribe,
  readModelCatalog: store.read,
  revalidateModelCatalog: store.revalidate,
  getModelCatalog: async backendId => ({ models: [{ ...model("other-backend"), backendId }],
    catalogRevision: "e".repeat(64) }),
  refreshSessions: async () => { history.push("sessions"); },
  loadHistory: async key => { history.push(key); },
};
vm.runInNewContext(compiled, context);
let unmount = context.mount();
assert.equal(loading, true);
assert.equal(requests.length, 1);
assert.equal(requests[0].method, "models.list");
assert.deepEqual(JSON.parse(JSON.stringify(requests[0].params)), { view: "configured", agentId: "qa-agent" });
requests[0].resolve(rpcReply("initial"));
await tick();
assert.equal(rendered[0].id, "initial");
assert.equal(loading, false);

publish("hermes");
assert.equal(requests.length, 1, "another backend does not invalidate this agent");
publish();
assert.equal(requests.length, 2, "applied Models catalog refreshes mounted Chat");
assert.equal(rendered[0].id, "initial", "admin all catalog never enters Chat");
assert.equal(requests[1].params.agentId, "qa-agent");
requests[1].resolve(rpcReply("new-endpoint"));
await tick();
assert.equal(rendered[0].id, "new-endpoint");

publish();
publish();
requests[3].resolve(rpcReply("latest-revision"));
await tick();
requests[2].resolve(rpcReply("late-old-revision"));
await tick();
assert.equal(rendered[0].id, "latest-revision", "late RPC cannot overwrite the newer invalidation result");
assert.equal(context.openClawModelCacheRef.current.get("qa-agent")[0].id, "latest-revision");

publish();
unmount();
context.activeModelsAgentId = "second-agent";
context.activeKeyRef.current = "agent:second-agent:main";
unmount = context.mount();
assert.equal(rendered.length, 0, "agent switch does not display the previous agent catalog");
requests[5].resolve(rpcReply("second-agent-only"));
await tick();
requests[4].resolve(rpcReply("late-first-agent"));
await tick();
assert.equal(rendered[0].id, "second-agent-only", "unmounted effect cannot write into the next agent");
assert.equal(context.openClawModelCacheRef.current.get("qa-agent")[0].id, "latest-revision");

let refreshed = false;
const manual = context.refresh().then(() => { refreshed = true; });
await tick();
assert.deepEqual(history, ["sessions", "agent:second-agent:main"]);
assert.equal(refreshed, false, "manual refresh waits for the model menu request");
requests[6].resolve(rpcReply("manual-fresh"));
await manual;
assert.equal(rendered[0].id, "manual-fresh");
const failed = context.refresh();
await tick();
requests[7].reject(new Error("configured catalog unavailable"));
await assert.rejects(failed, /configured catalog unavailable/);
assert.equal(rendered[0].id, "manual-fresh", "failed refresh preserves the last verified agent snapshot");

unmount();
assert.equal(context.refreshActiveModelsRef.current, null);
publish();
assert.equal(requests.length, 8, "unmount unsubscribes the old agent");
context.connected = false;
unmount = context.mount();
publish();
assert.equal(requests.length, 8, "disconnected invalidation waits for reconnect");
unmount();
context.connected = true;
unmount = context.mount();
requests[8].resolve(rpcReply("reconnected"));
await tick();
assert.equal(rendered[0].id, "reconnected");
unmount();

context.activeModelsBackend = "hermes";
unmount = context.mount();
await tick();
assert.equal(rendered[0].id, "other-backend", "other backends retain the shared verified catalog path");
await context.refresh();
assert.equal(rendered[0].backendId, "hermes");
unmount();
console.log("chat configured catalog refresh regression: PASS (publish, scope, races, manual refresh, reconnect)");
