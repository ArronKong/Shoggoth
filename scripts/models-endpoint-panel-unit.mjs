import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const uiRoot = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const confirmations = [];
const confirmationResults = [];
const output = await require("esbuild").build({
  entryPoints: [path.join(uiRoot, "src/pages/models/CustomEndpointsPanel.tsx")],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/jsx-runtime"], loader: { ".css": "empty", ".module.css": "empty" }, logLevel: "silent",
  plugins: [{ name: "panel-boundaries", setup(build) {
    build.onResolve({ filter: /^(react-i18next|.*\/components\/ui|\.\/EndpointModal|\.\/model-operation-recovery)$/ },
      ({ path }) => ({ path, namespace: "panel-boundaries" }));
    build.onLoad({ filter: /.*/, namespace: "panel-boundaries" }, ({ path: name }) => ({
      loader: "js", contents: name === "react-i18next"
        ? 'export const useTranslation = () => ({t: (key, args = {}) => key + (Object.keys(args).length ? ":" + Object.values(args).join(",") : "")});'
        : name.endsWith("components/ui")
          ? 'export const useConfirm = () => globalThis.confirmFixture; export const useToast = () => ({error(){},success(){},info(){}});'
          : name.endsWith("EndpointModal")
            ? 'export default function EndpointModal() { return null; }'
            : 'const state = {required:false,storageVerified:true,journal:"ready",operations:[],revision:0}; export const getModelOperationRecoverySnapshot=()=>state; export const subscribeModelOperationRecovery=()=>()=>{}; export const modelOperationRecoveryBlocks=()=>false;',
    }));
  } }],
});
const module = { exports: {} };
vm.runInNewContext(output.outputFiles[0].text, {
  module, exports: module.exports, require, console, crypto: webcrypto, URL, AbortController,
  setTimeout, clearTimeout, window: { setTimeout, clearTimeout },
  confirmFixture: async (options) => { confirmations.push(options); return confirmationResults.shift() ?? true; },
});
const Panel = module.exports.default;
const settle = (fn) => act(async () => { await fn?.(); await new Promise(setImmediate); });
const endpoint = (id) => ({ id, name: id, baseUrl: "https://fixture.invalid/v1", model: "same", models: ["same"], hasApiKey: false });
const snapshot = { supported: true, endpoints: [endpoint("xmxm"), endpoint("other")] };
const references = [{ store: "config", referenceKey: "agents.entries.travelplanner.model.primary" },
  { store: "cron", referenceKey: "cron-1" }, { store: "cron", referenceKey: "cron-2" }];
function blocked(session, { forceable = false } = {}) {
  const code = forceable ? "references_exist" : "primary_model_in_use";
  return { operationId: session.rootOperationId, status: "blocked", stage: "preflight", code,
    canForce: forceable, sync: "pending", snapshot,
    steps: [{ operationId: `${session.rootOperationId}:delete:provider`, status: "blocked", stage: "preflight", code,
      canForce: forceable, references, blockers: [{ code: "references_exist" }, { code }] }],
    recovery: { code, stage: "preflight", locked: false, retryable: false, references } };
}
const buttons = (renderer, label) => renderer.root.findAllByType("button")
  .filter((button) => button.children.includes(label));
const editButtons = (renderer) => renderer.root.findAllByType("button").filter(button => button.props.type === "button");

test("a rejected endpoint deletion explains its references and leaves the panel usable", async () => {
  const attempts = [], releases = [];
  const controller = { backend: "openclaw", list: async () => snapshot,
    remove: async (_endpoint, session) => { attempts.push(session); return blocked(session); },
    retry: () => { throw new Error("A rejected operation must not be resumed"); },
    release: (session) => releases.push(session.rootOperationId) };
  let renderer;
  await settle(() => { renderer = create(React.createElement(Panel, { controller, active: true, onChanged() {} })); });
  await settle(() => buttons(renderer, "common.delete")[0].props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /deleteBlocked:xmxm/);
  assert.match(rendered, /deletePrimaryOwners:travelplanner/);
  assert.match(rendered, /deleteCronReferences:2/);
  assert.equal(buttons(renderer, "models.settings.endpoints.retryMutation").length, 0);
  assert.ok(editButtons(renderer).every(button => !button.props.disabled));
  assert.equal(releases.length, 1);
  await settle(() => buttons(renderer, "common.delete")[0].props.onClick());
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].rootOperationId, attempts[1].rootOperationId);
  await settle(() => renderer.unmount());
});

test("a force-confirmed request that is rejected before writing is also unlocked", async () => {
  const attempts = [];
  const controller = { backend: "openclaw", list: async () => snapshot,
    remove: async (_endpoint, session, force) => { attempts.push(force); return blocked(session, { forceable: !force }); } };
  let renderer;
  await settle(() => { renderer = create(React.createElement(Panel, { controller, active: true, onChanged() {} })); });
  await settle(() => buttons(renderer, "common.delete")[0].props.onClick());
  assert.deepEqual(attempts, [false, true]);
  assert.equal(buttons(renderer, "models.settings.endpoints.retryMutation").length, 0);
  assert.ok(editButtons(renderer).every(button => !button.props.disabled));
  await settle(() => renderer.unmount());
});

test("canceling reference removal releases a proven zero-write deletion", async () => {
  const attempts = [], releases = [];
  const controller = { backend: "openclaw", list: async () => snapshot,
    remove: async (_endpoint, session, force) => { attempts.push(force); return blocked(session, { forceable: true }); },
    release: (session) => releases.push(session.rootOperationId) };
  let renderer;
  await settle(() => { renderer = create(React.createElement(Panel, { controller, active: true, onChanged() {} })); });
  confirmationResults.push(true, false);
  await settle(() => buttons(renderer, "common.delete")[0].props.onClick());
  assert.deepEqual(attempts, [false]);
  assert.equal(releases.length, 1);
  assert.equal(buttons(renderer, "models.settings.endpoints.retryMutation").length, 0);
  assert.ok(editButtons(renderer).every(button => !button.props.disabled));
  await settle(() => renderer.unmount());
});

test("an unconfirmed deletion keeps its original operation until a verified readback", async () => {
  const attempts = [], retries = [];
  const controller = { backend: "openclaw", list: async () => snapshot,
    remove: async (_endpoint, session) => {
      attempts.push(session);
      return { operationId: session.rootOperationId, status: "partial", stage: "request", code: "response_lost",
        sync: "pending", steps: [], recovery: { code: "response_lost", locked: true, retryable: true } };
    },
    retry: async (session) => {
      retries.push(session);
      return { operationId: session.rootOperationId, status: "applied", sync: "synced", steps: [],
        snapshot: { ...snapshot, endpoints: [endpoint("other")] } };
    } };
  let renderer;
  await settle(() => { renderer = create(React.createElement(Panel, { controller, active: true, onChanged() {} })); });
  await settle(() => buttons(renderer, "common.delete")[0].props.onClick());
  assert.ok(editButtons(renderer).every(button => button.props.disabled));
  await settle(() => buttons(renderer, "models.settings.endpoints.retryMutation")[0].props.onClick());
  assert.equal(attempts.length, 1);
  assert.equal(retries[0], attempts[0]);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /xmxm/);
  assert.ok(editButtons(renderer).every(button => !button.props.disabled));
  await settle(() => renderer.unmount());
});
