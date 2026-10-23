#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, ".."), requireUi = createRequire(path.join(root, "app/manage-ui/package.json"));
const memory = new Map(), calls = []; let reply;
const storage = { getItem: key => memory.has(key) ? memory.get(key) : null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
async function compile(file) {
  const result = await requireUi("esbuild").build({ entryPoints: [path.join(root, file)], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, localStorage: storage,
    fetch: async (url, options) => { calls.push({ url, options }); return { status: 200, ok: true, json: async () => JSON.parse(JSON.stringify(reply)) }; } });
  return module.exports;
}
async function main() {
  const api = await compile("app/manage-ui/src/lib/managedPluginHostApi.ts"), recovery = await compile("app/manage-ui/src/lib/managedPluginHostRecovery.ts"), settings = await compile("app/manage-ui/src/lib/managedPluginHostSettings.ts");
  const status = backendId => ({ version: 1, backendId, mode: "managed", state: "running", operationId: "original-operation", selectionSupported: true, errorCode: null });
  for (const id of ["openclaw", "hermes"]) {
    reply = status(id); assert.equal((await api.getManagedPluginHostStatus(id)).backendId, id);
    await api.runManagedPluginHostAction(id, "restart", "original-operation");
    const action = calls.at(-1); assert.equal(action.url, `/__api/plugins/host-runtime/${id}/restart`);
    assert.equal(action.options.credentials, "same-origin"); assert.deepEqual(JSON.parse(action.options.body), { operationId: "original-operation" });
    await api.getManagedPluginHostOperation(id, "original-operation"); assert.equal(calls.at(-1).url, `/__api/plugins/host-runtime/${id}/operations/original-operation`);
  }
  console.log("PASS exact backend routes and operation-only actions share no caller readiness or credential fields");
  const count = calls.length;
  for (const id of ["unknown", "../hermes", {}, null]) assert.throws(() => api.getManagedPluginHostStatus(id));
  for (const op of ["bad/id", "a".repeat(129), {}, 42, null]) assert.throws(() => api.getManagedPluginHostOperation("hermes", op));
  assert.throws(() => api.runManagedPluginHostAction("hermes", "activate", "ok")); assert.equal(calls.length, count);
  console.log("PASS unsupported backends, injected paths and non-string operations dispatch no fetch");
  for (const invalid of [status("openclaw"), { ...status("hermes"), token: "must-not-project" }, { ...status("hermes"), operationId: "bad/id" },
    { ...status("hermes"), state: "idle" }, { ...status("hermes"), mode: "existing" }, { ...status("hermes"), selectionSupported: "true" }]) {
    reply = invalid; await assert.rejects(api.getManagedPluginHostStatus("hermes"), /status invalid/u);
  }
  console.log("PASS wrong-backend/private/truthy and non-ready DTOs cannot become renderer readiness");
  recovery.saveManagedHostPending("openclaw", "original-oc"); recovery.saveManagedHostPending("hermes", "original-hermes");
  const restored = await compile("app/manage-ui/src/lib/managedPluginHostRecovery.ts");
  assert.equal(restored.readManagedHostPending("openclaw"), "original-oc"); assert.equal(restored.readManagedHostPending("hermes"), "original-hermes");
  recovery.saveManagedHostPending("hermes", "newer-hermes"); recovery.clearManagedHostPending("hermes", "original-hermes");
  assert.equal(recovery.readManagedHostPending("hermes"), "newer-hermes"); assert.equal(recovery.readManagedHostPending("openclaw"), "original-oc");
  memory.set("shoggoth:managed-plugin-host-operation:hermes", JSON.stringify({ version: 1, backendId: "openclaw", operationId: "foreign" }));
  assert.throws(() => recovery.readManagedHostPending("hermes"), /recovery invalid/u);
  memory.set("shoggoth:managed-plugin-host-operation:hermes", "broken-json"); assert.throws(() => recovery.readManagedHostPending("hermes"));
  assert([...memory.values()].every(value => !value.includes("token")));
  console.log("PASS original operation survives module reload; cross-backend records and stale-clear attempts cannot erase a newer observation");
  const patch = { gatewayUrl: "retained-url", token: "retained-token", hermesMode: "remote", hermesRemotes: [{ profile: "retained" }], hermesKeepAlive: true,
    locale: "en", notifications: { chat: true, cron: false, task: true }, openclawPluginHostMode: "existing", hermesPluginHostMode: "existing" };
  const filtered = settings.filterLegacyHostSettings(patch, { openclaw: true, hermes: true });
  assert.deepEqual(JSON.parse(JSON.stringify(filtered)), { locale: "en", notifications: patch.notifications });
  assert.equal(patch.gatewayUrl, "retained-url"); assert.equal(patch.hermesRemotes[0].profile, "retained");
  const legacy = settings.filterLegacyHostSettings(patch, { openclaw: false, hermes: false });
  assert.equal(legacy.gatewayUrl, patch.gatewayUrl); assert.equal(legacy.hermesMode, "remote"); assert.equal(legacy.openclawPluginHostMode, undefined);
  console.log("PASS managed late-write projection preserves independent preferences and existing saved connection data");
  console.log("5/5 actual typed UI boundary groups passed; network/Host/model/user-credential effects: 0");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
