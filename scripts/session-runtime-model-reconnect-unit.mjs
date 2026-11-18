import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { create, act } = require("react-test-renderer"), ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [], writes = [], errors = [], timers = new Map();
let timerId = 0, view, renderer;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ui, "src/lib/useSessionRuntimeModels.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, AbortController, Error,
  setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout: id => timers.delete(id),
  require: name => name === "react" ? React
    : name === "react-i18next" ? { useTranslation: () => ({ t: value => value }) }
      : name === "../components/ui" ? { useToast: () => ({ error: message => errors.push(message) }) }
        : name === "./sessionRuntimeSupport" ? { sessionRuntimeSupportKey: () => null }
          : name === "../api/client" ? { ApiError: Error,
            getSessionRuntimeModels: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
            selectSessionRuntimeModel: (...args) => new Promise((resolve, reject) => writes.push({ args, resolve, reject })) } : require(name),
});
function View(props) {
  view = module.exports.useSessionRuntimeModels(props.backend, props.agent, props.session, true, props.connected, props.epoch);
  return null;
}
const initial = { backend: "shoggoth", agent: "agent-a", session: "session-a", connected: true, epoch: 0 };
const settle = fn => act(async () => { fn?.(); await new Promise(setImmediate); });
const update = props => settle(() => renderer.update(React.createElement(View, { ...initial, ...props })));
const result = name => ({ models: [{ id: name }], selection: { revision: 1 }, runtimes: [], capabilities: {} });
await settle(() => { renderer = create(React.createElement(View, initial)); });
assert.equal(requests.length, 1);
const old = requests[0];
await update({ connected: false });
await update({ connected: true });
assert.equal(requests.length, 2, "reconnect must start a fresh read while the old request is unresolved");
assert.equal(old.args[3].aborted, true, "disconnect cancels the old HTTP read");
await settle(() => requests[1].resolve(result("current")));
await settle(() => old.reject(new Error("old Service response arrived late")));
assert.equal(view.data.models[0].id, "current");
assert.equal(view.error, false, "late old failure cannot poison the recovered catalog");
assert.equal(view.loading, false);

await settle(() => { void view.refresh(); });
const beforeRecovery = requests.at(-1), countBeforeRecovery = requests.length;
await update({ epoch: 1 });
assert.equal(requests.length, countBeforeRecovery + 1, "backend recovery refreshes even while the Proxy socket stays connected");
assert.equal(beforeRecovery.args[3].aborted, true);
await settle(() => requests.at(-1).resolve(result("recovered-service")));
await settle(() => beforeRecovery.resolve(result("old-service")));
assert.equal(view.data.models[0].id, "recovered-service");
initial.epoch = 1;

const beforeClicks = requests.length;
await settle(() => { void view.refresh(); void view.refresh(); });
assert.equal(requests.length, beforeClicks + 1, "concurrent refresh clicks join one read");
const changingSession = requests.at(-1);
await update({ session: "session-b" });
assert.equal(changingSession.args[3].aborted, true);
assert.equal(requests.length, beforeClicks + 2);
await settle(() => requests.at(-1).resolve(result("session-b")));
await settle(() => changingSession.resolve(result("stale-session-a")));
assert.equal(view.data.models[0].id, "session-b");
assert.equal(writes.length, 0, "read recovery must not select a model");

const currentModel = { id: "deepseek", name: "DeepSeek (default)", bindingId: "first", runtime: "codex" };
const newModel = { ...currentModel, name: "DeepSeek (custom)", bindingId: "second", modelProviderRef: "custom" };
const currentSelection = { model: currentModel.id, bindingId: currentModel.bindingId, runtime: "codex", revision: 7, canSwitch: true,
  candidates: [currentModel, newModel].map(({ bindingId }) => ({ bindingId, adjustments: { permissionMode: null } })) };
const catalog = {
  models: [currentModel, newModel], selection: currentSelection,
  runtimes: [currentModel, newModel].map(({ bindingId, runtime }) => ({ bindingId, runtime, capabilities: { bindingId } })),
  capabilities: { bindingId: currentModel.bindingId },
};
await settle(() => { void view.refresh(); });
await settle(() => requests.at(-1).resolve(catalog));
let selected;
await settle(() => { selected = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef }); });
assert.equal(view.pending, true);
assert.equal(view.pendingModel, newModel, "the exact choice is visible before the write completes");
assert.equal(view.data.selection, currentSelection, "confirmation and runtime capabilities stay authoritative");
assert.equal(view.data.capabilities, catalog.capabilities);
assert.equal(writes.at(-1).args[3].modelProviderRef, newModel.modelProviderRef);
assert.equal(await view.select(currentModel.id, currentModel.bindingId, null), false, "a second pick cannot overtake the pending write");
assert.equal(writes.length, 1);

const savedSelection = { ...currentSelection, bindingId: newModel.bindingId, modelProviderRef: newModel.modelProviderRef, revision: 8 };
await settle(() => writes.at(-1).resolve(savedSelection));
assert.equal(await selected, true);
assert.equal(view.pendingModel, undefined);
assert.equal(view.data.selection, savedSelection);
assert.equal(view.data.capabilities.bindingId, newModel.bindingId);

await settle(() => { selected = view.select(currentModel.id, currentModel.bindingId, null); });
assert.equal(view.pendingModel, currentModel, "a choice can remove the previous provider reference");
await settle(() => writes.at(-1).reject(new Error("selection failed")));
assert.deepEqual(errors, ["selection failed"]);
assert.equal(view.pending, false);
assert.equal(view.pendingModel, undefined, "a rejected choice rolls back before the follow-up read finishes");
assert.equal(view.data.selection, savedSelection);
assert.equal(view.loading, true);
await settle(() => requests.at(-1).resolve({ ...catalog, selection: savedSelection }));
assert.equal(await selected, false);

await settle(() => { selected = view.select(currentModel.id, currentModel.bindingId, null); });
const oldSelection = writes.at(-1);
await update({ session: "session-c" });
assert.equal(view.pendingModel, undefined, "a pending choice cannot carry over to another conversation");
const otherCatalog = requests.at(-1);
assert.equal(otherCatalog.args[2], "session-c");
assert.equal(view.pending, false, "a pending write in session B must not disable session C");
await settle(() => otherCatalog.resolve(catalog));
let selectedC;
await settle(() => { selectedC = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef }); });
const writeC = writes.at(-1);
assert.equal(writeC.args[2], "session-c");
await settle(() => oldSelection.reject(new Error("late rejection")));
assert.equal(await selected, false);
assert.deepEqual(errors, ["selection failed"], "the old conversation cannot show an error in the new one");
assert.equal(view.pendingModel, newModel, "settling the old write cannot unlock the new conversation's write");
await settle(() => writeC.resolve(savedSelection));
assert.equal(await selectedC, true);
assert.equal(view.data.selection, savedSelection);

// Return to a conversation while its write is pending and after a different catalog was loaded.
await settle(() => { selectedC = view.select(currentModel.id, currentModel.bindingId, null); });
await update({ session: "session-d" });
await settle(() => requests.at(-1).resolve(result("session-d")));
await update({ session: "session-c" });
assert.equal(view.pendingModel, currentModel);
const beforeReturn = requests.length;
await settle(() => writes.at(-1).resolve(currentSelection));
assert.equal(requests.length, beforeReturn + 1, "the revisited session reads its current catalog after the write settles");
assert.equal(requests.at(-1).args[2], "session-c");
await settle(() => requests.at(-1).resolve(catalog));
await selectedC;
assert.equal(view.data, catalog);

// A partial source gets one automatic retry. Verified endpoint rows remain available meanwhile.
const partialCatalog = { ...catalog, runtimes: [{ ...catalog.runtimes[0], unavailableSource: "ChatGPT" }] };
await settle(() => { void view.refresh(); });
await settle(() => requests.at(-1).resolve(partialCatalog));
const retry = [...timers].find(([, timer]) => timer.ms < 60_000);
assert.ok(retry, "a partial ChatGPT source schedules recovery");
timers.delete(retry[0]);
await settle(() => retry[1].fn());
await settle(() => requests.at(-1).resolve({ ...partialCatalog }));
assert.equal(view.data.models.length, 2);
assert.equal(timers.size, 0, "a persistent outage does not poll indefinitely");

await settle(() => { void view.refresh(); });
const stalled = requests.at(-1);
stalled.args[3].addEventListener("abort", () => stalled.reject(new Error("request timed out")), { once: true });
const deadline = [...timers.values()].findLast(item => item.ms > 0);
assert.ok(deadline && deadline.ms <= 60000, "a stalled read has a bounded UI deadline");
await settle(() => deadline.fn());
assert.equal(stalled.args[3].aborted, true);
assert.equal(view.loading, false);
assert.equal(view.error, true);
const beforeRetry = requests.length;
await settle(() => { void view.refresh(); });
assert.equal(requests.length, beforeRetry + 1, "timeout releases the retry gate");
const beforeUnmount = requests.at(-1);
await settle(() => renderer.unmount());
assert.equal(beforeUnmount.args[3].aborted, true);
await settle(() => beforeUnmount.resolve(result("late-unmounted")));
assert.equal(timers.size, 0);
console.log("PASS runtime model reconnect and selection: immediate choice, confirmation, rollback, retry and session isolation");
