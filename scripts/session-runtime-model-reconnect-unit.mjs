import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { create, act } = require("react-test-renderer"), ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [], timers = new Map();
let timerId = 0, view, renderer;
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ui, "src/lib/useSessionRuntimeModels.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, AbortController,
  setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout: id => timers.delete(id),
  require: name => name === "react" ? React
    : name === "react-i18next" ? { useTranslation: () => ({ t: value => value }) }
      : name === "../components/ui" ? { useToast: () => ({ error() {} }) }
        : name === "./sessionRuntimeSupport" ? { sessionRuntimeSupportKey: () => null }
          : name === "../api/client" ? { ApiError: Error,
            getSessionRuntimeModels: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
            selectSessionRuntimeModel: () => assert.fail("read recovery must not select or send") } : require(name),
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
console.log("PASS runtime model reconnect: cancel old read, reject late results, deduplicate refresh, bound waiting, retry, session and unmount isolation");
