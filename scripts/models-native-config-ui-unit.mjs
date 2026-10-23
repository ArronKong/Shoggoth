import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const records = new Map();
const key = (backend, provider) => backend + ":" + provider;
const recovery = {
  getModelOperationRecoverySnapshot: () => ({ storageVerified: true, required: true, journal: "ready", operations: [...records.values()] }),
  modelOperationRecoveryBlocks: (backend, provider, except) => { const row = records.get(key(backend, provider)); return !!row && row.operationId !== except; },
  retainedProviderModelOperation: (backend, provider) => records.get(key(backend, provider)),
  retainModelOperation: async row => { records.set(key(row.backendId, row.providerKey), row); return true; },
  confirmModelOperationTerminal: async row => { const id = key(row.backendId, row.providerKey); assert.equal(records.get(id)?.operationId, row.operationId); records.delete(id); return true; },
};
const bundled = await require("esbuild").build({
  entryPoints: [path.join(root, "app/manage-ui/src/pages/models/openclaw-endpoint-controller.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
  plugins: [{ name: "isolated-boundaries", setup(build) {
    build.onResolve({ filter: /api\/client$|model-operation-recovery$/ }, args => ({ path: args.path, namespace: "isolated" }));
    build.onLoad({ filter: /.*/, namespace: "isolated" }, ({ path: name }) => ({ loader: "js", contents: name.includes("api/client")
      ? 'export class ApiError extends Error {};' + ["addModelConfig", "applyModelBatch", "getModelChangeOperation", "listCustomEndpoints", "removeModelConfig", "removeModelProvider", "saveModelProviderDraft", "revealModelProviderKey", "updateModelProvider", "validateCustomEndpoint", "deleteCustomEndpoint", "saveCustomEndpoint"]
        .map(name => `export const ${name}=()=>{throw Error("unexpected default dependency")};`).join("\n")
      : Object.keys(recovery).map(name => `export const ${name}=(...args)=>globalThis.recovery.${name}(...args);`).join("\n") }));
  } }],
});
const module = { exports: {} };
vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, recovery, console, URL, AbortController });
const { createOpenClawEndpointController } = module.exports;

async function fixture({ lostRead = false, status = "applied", lostWrite = false } = {}) {
  records.clear();
  const endpoint = { id: "xmxm", name: "xmxm", baseUrl: "https://fixture.invalid/v1", model: "old", models: ["old"], hasApiKey: false };
  const snapshot = { supported: true, endpoints: [endpoint], form: { configurationDraft: true, allowEmptyModels: true, configRevision: "revision-1" } };
  let reads = 0;
  const writes = [], clears = [];
  const deps = {
    listCustomEndpoints: async () => { if (++reads > 1 && lostRead) throw Error("controlled refresh failure"); return structuredClone(snapshot); },
    saveModelProviderDraft: async (backend, input, operationId) => {
      writes.push({ backend, input: structuredClone(input), operationId });
      if (lostWrite) throw Error("controlled response loss");
      return { operationId, status, stage: status === "failed" ? "preflight" : "config-saved", configSaved: status !== "failed", receiptIdentityVerified: true };
    },
    getModelChangeOperation: async (backendId, operationId, providerKey) => ({ version: 1, backendId, operationId, providerKey, status, stage: "preflight", terminal: status === "failed" }),
    updateModelProvider: async (backend, providerKey, patch, operationId) => {
      clears.push({ backend, providerKey, patch: structuredClone(patch), operationId });
      return { operationId, status: "applied", stage: "config-saved", receiptIdentityVerified: true };
    },
  };
  const controller = createOpenClawEndpointController("openclaw", deps);
  await controller.list();
  const input = { id: "xmxm", name: "xmxm", baseUrl: endpoint.baseUrl, models: ["one", "two"], model: "one", credentialScope: "provider", baseHash: "revision-1" };
  const session = { rootOperationId: "endpoint-original", backend: "openclaw", kind: "edit" };
  return { controller, endpoint, input, session, writes, clears };
}

test("native endpoint saves all model choices once and keeps successful save independent of list refresh", async () => {
  const f = await fixture({ lostRead: true });
  const result = await f.controller.save(f.input, f.session, f.endpoint);
  assert.equal(result.status, "applied");
  assert.equal(result.configSaved, true);
  assert.equal(result.sync, "pending");
  assert.equal(result.recovery, undefined);
  assert.equal(records.size, 0);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].input.models, ["one", "two"]);
  assert.equal(f.writes[0].input.credentialScope, "provider");
  assert.equal(Object.hasOwn(f.writes[0].input, "agentId"), false);
  assert.equal(f.writes[0].input.baseHash, "revision-1");
});

test("native endpoint clear is one Provider operation with the displayed revision", async () => {
  const f = await fixture();
  await f.controller.clearApiKey(f.endpoint, { ...f.session, kind: "clear-key" },
    { credentialScope: "provider", baseHash: "revision-1" });
  assert.equal(f.clears.length, 1);
  assert.deepEqual(f.clears[0].patch, { clearApiKey: true, credentialScope: "provider", baseHash: "revision-1" });
});

test("native endpoint accepts an empty models array without manufacturing a default model", async () => {
  const f = await fixture();
  const result = await f.controller.save({ ...f.input, models: [], model: "" }, f.session, f.endpoint);
  assert.equal(result.status, "applied");
  assert.deepEqual(f.writes[0].input.models, []);
});

test("known rejected native draft releases the original marker and form", async () => {
  const f = await fixture({ status: "failed" });
  const result = await f.controller.save(f.input, f.session, f.endpoint);
  assert.equal(result.status, "failed");
  assert.equal(result.recovery.locked, false);
  assert.equal(records.size, 0);
});

test("uncertain native write retains the original identity and never resubmits it", async () => {
  const f = await fixture({ lostWrite: true });
  const result = await f.controller.save(f.input, f.session, f.endpoint);
  assert.equal(result.status, "partial");
  assert.equal(result.recovery.locked, true);
  assert.equal(records.size, 1);
  await assert.rejects(f.controller.retry(f.session), /model_original_operation_pending/);
  assert.equal(f.writes.length, 1);
});
