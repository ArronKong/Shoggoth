import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const ui = path.resolve(import.meta.dirname, "../app/manage-ui"), require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { act, create } = require("react-test-renderer"), ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [], timers = new Map(), listeners = new Map(); let nextTimer = 0;
const document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
const Modal = ({ children, footer, onClose }) => React.createElement("section", { role: "dialog" }, children, footer,
  React.createElement("button", { onClick: onClose, title: "close" }));
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ui, "src/components/ChatMemoryStatus.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { module, exports: module.exports, document, AbortController,
  setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
  require: name => name.endsWith(".css") ? {} : name === "./Modal" ? { __esModule: true, default: Modal }
    : name === "../api/client" ? { getSessionMemoryStatus: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) }
      : name === "react-i18next" ? { useTranslation: () => ({ t: key => key }) } : require(name),
});
const Component = module.exports.default;
const props = { backendId: "fixture", agentId: "agent", sessionKey: "session-one", connected: true, running: false };
const result = { supported: true, phase: "complete", outcome: "ok", updatedAt: 1, statusLines: ["status=ok"], traceLines: [] };
let renderer;
const mount = async input => { await act(async () => { renderer = create(React.createElement(Component, input)); }); };
const settle = async (value, failure = false) => {
  const request = requests.shift(); assert.ok(request);
  await act(async () => { request[failure ? "reject" : "resolve"](value); }); return request;
};
const click = async title => { await act(async () => { renderer.root.findByProps(title === "close" ? { title } : { "aria-label": title }).props.onClick(); }); };
await mount({ ...props, connected: false }); assert.equal(requests.length, 0); assert.equal(renderer.toJSON(), null);
await act(async () => renderer.unmount());
await mount(props); assert.equal(requests[0].args[3], false);
await settle(result); assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
await click("memoryStatus.title"); assert.equal(requests[0].args[3], true);
await settle({ ...result, traceLines: ["PRIVATE_RECALL"] }); assert.match(JSON.stringify(renderer.toJSON()), /PRIVATE_RECALL/u);
await click("close"); assert.ok(!JSON.stringify(renderer.toJSON()).includes("PRIVATE_RECALL"));
await settle(result); await click("memoryStatus.title");
const previous = requests[0]; await act(async () => renderer.unmount()); assert.equal(previous.args[4].aborted, true);
await mount({ ...props, sessionKey: "session-two" });
assert.equal(requests[1].args[2], "session-two"); assert.equal(requests[1].args[3], false);
await settle({ ...result, traceLines: ["LATE_PRIVATE_RECALL"] });
assert.ok(!JSON.stringify(renderer.toJSON()).includes("LATE_PRIVATE_RECALL"));
await settle(result); await click("memoryStatus.title"); await settle({ ...result, traceLines: ["CURRENT_PRIVATE_RECALL"] });
const timer = [...timers.values()].at(-1); await act(async () => { void timer(); });
await settle(new Error("private transport detail"), true);
assert.ok(!JSON.stringify(renderer.toJSON()).includes("CURRENT_PRIVATE_RECALL"));
assert.ok(!JSON.stringify(renderer.toJSON()).includes("private transport detail"));
document.hidden = true; await act(async () => listeners.get("visibilitychange")()); assert.equal(renderer.toJSON(), null);
document.hidden = false; await act(async () => listeners.get("visibilitychange")());
assert.equal(requests[0].args[3], false, "returning to the page does not reopen private details");
await settle({ supported: false }); assert.equal(renderer.toJSON(), null);
await act(async () => renderer.unmount());
assert.equal(listeners.size, 0);
console.log("PASS memory status UI: explicit details, close/hidden clearing, late response and session isolation, disconnected/unsupported states, safe read errors");
