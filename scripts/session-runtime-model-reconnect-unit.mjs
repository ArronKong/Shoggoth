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
let timerId = 0, view, renderer, clock = 1_000_000;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ui, "src/lib/useSessionRuntimeModels.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, AbortController, Error, Date: { now: () => clock },
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
  runtimes: [currentModel, newModel].map(({ bindingId, runtime }) => ({ bindingId, runtime, capabilities: { bindingId, steer: bindingId === currentModel.bindingId } })),
  capabilities: { bindingId: currentModel.bindingId, steer: true },
};
await settle(() => { void view.refresh(); });
await settle(() => requests.at(-1).resolve(catalog));
let selected;
await settle(() => { selected = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef, activeTurn: true }); });
assert.equal(view.pending, true);
assert.equal(view.pendingModel, newModel, "the exact choice is visible before the write completes");
assert.equal(view.data.selection, currentSelection, "confirmation and runtime capabilities stay authoritative");
assert.equal(view.data.capabilities, catalog.capabilities);
assert.equal(writes.at(-1).args[3].modelProviderRef, newModel.modelProviderRef);
assert.equal(writes.length, 1, "one write at a time");

const savedSelection = { ...currentSelection, bindingId: newModel.bindingId, modelProviderRef: newModel.modelProviderRef, revision: 8 };
await settle(() => writes.at(-1).resolve(savedSelection));
assert.equal(await selected, true);
assert.equal(view.pendingModel, undefined);
assert.equal(view.data.selection, savedSelection);
assert.equal(view.data.capabilities.bindingId, newModel.bindingId);
assert.equal(view.data.capabilities.steer, true, "selecting next turn's Runtime preserves current turn steering");

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
const resumedSend = view.settled();
const beforeReturn = requests.length;
await settle(() => writes.at(-1).resolve(currentSelection));
assert.equal(await resumedSend, true, "a send waiting after returning honors the Service's successful write");
assert.equal(requests.length, beforeReturn + 1, "the revisited session reads its current catalog after the write settles");
assert.equal(requests.at(-1).args[2], "session-c");
await settle(() => requests.at(-1).resolve(catalog));
assert.equal(await selectedC, true);
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

// Remembered catalogs: a reopened conversation and a sibling conversation show a list at once,
// while writes wait for the conversation's own read.
const remembered = { backend: "shoggoth", agent: "agent-r", session: "session-x", connected: true, epoch: 0 };
await settle(() => { renderer = create(React.createElement(View, remembered)); });
await settle(() => requests.at(-1).resolve(catalog));
assert.equal(view.confirmed, true);
await settle(() => renderer.update(React.createElement(View, { ...remembered, session: "session-y" })));
assert.equal(view.data, undefined, "a new conversation never borrows another conversation's selection");
assert.equal(view.catalog.models, catalog.models, "but its Agent's last catalog is shown at once");
assert.equal(view.loading, true);
await settle(() => requests.at(-1).resolve(result("session-y")));
await settle(() => renderer.update(React.createElement(View, { ...remembered, session: "session-x" })));
assert.equal(view.data, catalog, "a reopened conversation shows its last read before the new one lands");
assert.equal(view.confirmed, false);
const reopenRead = requests.at(-1);
assert.equal(reopenRead.args[2], "session-x", "and reads its current catalog");
const writesBeforeReopen = writes.length;
let selectedX;
await settle(() => { selectedX = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef }); });
assert.equal(view.pendingModel, newModel, "the pick shows at once");
assert.equal(writes.length, writesBeforeReopen, "a remembered revision is never written");
await settle(() => reopenRead.resolve({ ...catalog, selection: { ...currentSelection, revision: 9 } }));
assert.equal(writes.length, writesBeforeReopen + 1);
assert.equal(writes.at(-1).args[3].revision, 9, "the write waits for and uses the fresh revision");
await settle(() => writes.at(-1).resolve({ ...savedSelection, revision: 10 }));
assert.equal(await selectedX, true);
const readsBeforeMenu = requests.length;
await settle(() => { void view.refreshIfStale(); });
assert.equal(requests.length, readsBeforeMenu, "opening the menu right after a read does not read again");
clock += 31_000;
await settle(() => { void view.refreshIfStale(); });
assert.equal(requests.length, readsBeforeMenu + 1, "an old catalog is read again when the menu opens");
await settle(() => requests.at(-1).resolve(catalog));

// Rapid picks: each shows at once, one write runs at a time, and only the last waiting pick follows.
const writesBeforeRapid = writes.length;
let first, second, third;
await settle(() => { first = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef }); });
await settle(() => { second = view.select(currentModel.id, currentModel.bindingId, null); });
assert.equal(view.pendingModel, currentModel, "the latest pick is shown");
await settle(() => { third = view.select(newModel.id, newModel.bindingId, null, { modelProviderRef: newModel.modelProviderRef }); });
assert.equal(view.pendingModel, newModel);
assert.equal(writes.length, writesBeforeRapid + 1, "a pick never starts a second concurrent write");
let settledResult;
const settling = view.settled().then(value => { settledResult = value; });
await settle(() => writes.at(-1).resolve({ ...currentSelection, bindingId: newModel.bindingId,
  modelProviderRef: newModel.modelProviderRef, revision: 11 }));
assert.equal(writes.length, writesBeforeRapid + 2, "the middle pick is dropped");
assert.equal(writes.at(-1).args[3].bindingId, newModel.bindingId, "the last pick is written");
assert.equal(writes.at(-1).args[3].revision, 11, "with the revision the previous write returned");
assert.equal(settledResult, undefined, "a waiting send still waits");
await settle(() => writes.at(-1).resolve({ ...savedSelection, revision: 12 }));
await settling;
assert.equal(settledResult, true);
assert.deepEqual([await first, await second, await third], [true, true, true]);
assert.equal(view.pendingModel, undefined);
assert.equal(await view.settled(), true, "nothing left to wait for");

// A failed last pick tells a waiting send not to go, and the shown choice rolls back.
let failedPick;
await settle(() => { failedPick = view.select(currentModel.id, currentModel.bindingId, null); });
const failedSettle = view.settled();
await settle(() => writes.at(-1).reject(new Error("pick failed")));
assert.equal(view.pendingModel, undefined);
await settle(() => requests.at(-1).resolve(catalog));
assert.equal(await failedSettle, false);
assert.equal(await failedPick, false);
await settle(() => renderer.unmount());
console.log("PASS runtime model reconnect and selection: immediate choice, background writes, last pick wins, rollback, retry, session isolation and remembered catalogs");
