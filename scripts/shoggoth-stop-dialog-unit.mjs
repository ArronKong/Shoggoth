#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = uiRequire("react");
const renderer = uiRequire("react-test-renderer");
const text = node => typeof node === "string" ? node : Array.isArray(node)
  ? node.map(text).join("") : node?.children ? text(node.children) : "";
function load(relative, require, window = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 }, fileName: relative,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${source}\n})(require,module,module.exports);`, {
    require, module, window, console,
  });
  return module.exports;
}
const dictionary = load("app/manage-ui/src/i18n/locales/zh-CN.ts", uiRequire).default;
const translate = (key, params = {}) => String(key.split(".").reduce((value, part) => value?.[part], dictionary) ?? key)
  .replace(/\{\{(\w+)\}\}/gu, (_, name) => String(params[name] ?? ""));
const snapshot = (revision = "a", runs = []) => ({ availability: "available", revision: revision.repeat(64), totalCount: runs.length, runs });
const task = { runId: "run-one", agentName: "Grok", title: "整理发布说明", source: "inspiration", status: "waiting_approval" };

function fixture() {
  const state = { impact: snapshot("a", [task]), reads: 0, stops: [], stopped: 0, cancelled: 0, timer: null };
  class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
  state.ApiError = ApiError;
  const api = {
    ApiError,
    async getShoggothStopImpact() { state.reads += 1; return state.read ? state.read() : state.impact; },
    async getShoggothProductStatus() { return { service: { healthy: true }, background: { supported: true, loaded: true } }; },
    async runShoggothBackgroundAction(action, revision) {
      state.stops.push({ action, revision });
      if (state.stop) return state.stop();
      return { service: { healthy: false }, background: { supported: true, loaded: false } };
    },
  };
  const AlertDialog = Object.fromEntries(["Root", "Portal", "Backdrop", "Popup", "Title"].map(name => [name,
    ({ children, ...props }) => React.createElement(name === "Title" ? "h2" : "div", props, children)]));
  const component = load("app/manage-ui/src/pages/settings/BackgroundStopDialog.tsx", name => {
    if (name.endsWith(".css")) return {};
    if (name === "../../api/client") return api;
    if (name === "@base-ui/react/alert-dialog") return { AlertDialog };
    if (name === "react-i18next") return { useTranslation: () => ({ t: translate }) };
    return uiRequire(name);
  }, { setInterval(callback) { state.timer = callback; return 1; }, clearInterval() { state.timer = null; } });
  state.mount = async () => { await renderer.act(async () => {
    state.tree = renderer.create(React.createElement(component.default, {
      onCancel: () => { state.cancelled += 1; }, onStopped: () => { state.stopped += 1; },
    }));
  }); };
  state.button = label => state.tree.root.findAllByType("button").find(button => text(button.props.children) === label);
  state.click = async label => { await renderer.act(async () => state.button(label).props.onClick()); };
  state.unmount = () => renderer.act(() => state.tree.unmount());
  return state;
}

test("dialog shows actual task, source and approval state; cancel never stops", async () => {
  const f = fixture(); await f.mount();
  const body = text(f.tree.toJSON());
  for (const label of ["整理发布说明", "Grok", "灵感", "等待授权", "以下 1 个任务", "按规则调度"]) assert.ok(body.includes(label), label);
  await f.click("取消");
  assert.equal(f.cancelled, 1); assert.equal(f.stops.length, 0);
  f.unmount(); assert.equal(f.timer, null);
});

test("loading cannot stop and a late result after unmount has no effects", async () => {
  const f = fixture(); let resolve;
  f.read = () => new Promise(done => { resolve = done; });
  await f.mount();
  assert.equal(f.button("停止后台").props.disabled, true);
  assert.ok(text(f.tree.toJSON()).includes("正在检查"));
  f.unmount();
  await renderer.act(async () => resolve(snapshot()));
  assert.equal(f.stops.length, 0); assert.equal(f.stopped, 0);
});

test("known empty and unknown remain distinct; unknown requires explicit Stop anyway", async () => {
  const f = fixture(); f.impact = snapshot(); await f.mount();
  assert.ok(text(f.tree.toJSON()).includes("当前没有会被中断"));
  f.impact = { availability: "unavailable", revision: "unavailable", totalCount: null, runs: [] };
  await renderer.act(async () => f.timer());
  const body = text(f.tree.toJSON());
  assert.ok(body.includes("无法确认当前任务状态"));
  assert.ok(!body.includes("当前没有会被中断"));
  await f.click("仍然停止");
  assert.deepEqual(f.stops, [{ action: "stop", revision: "unavailable" }]);
  assert.equal(f.stopped, 1); f.unmount();
});

test("changed impact refreshes in place and requires a second explicit confirmation", async () => {
  const f = fixture(); await f.mount();
  f.stop = () => {
    f.impact = snapshot("b", [task, { ...task, runId: "new-run", title: "新的执行任务", status: "running" }]);
    throw new f.ApiError("SHOGGOTH_STOP_IMPACT_CHANGED");
  };
  await f.click("停止后台");
  assert.equal(f.stops.length, 1); assert.equal(f.stopped, 0);
  assert.ok(text(f.tree.toJSON()).includes("任务状态已变化"));
  assert.ok(text(f.tree.toJSON()).includes("新的执行任务"));
  f.stop = null;
  await f.click("停止后台");
  assert.equal(f.stops.length, 2); assert.equal(f.stopped, 1);
  assert.equal(f.stops[1].revision, "b".repeat(64));
  f.unmount();
});

test("double click sends one stop and completion after unmount is ignored", async () => {
  const f = fixture(); await f.mount(); let resolve;
  f.stop = () => new Promise(done => { resolve = done; });
  const click = f.button("停止后台").props.onClick;
  await renderer.act(async () => { click(); click(); });
  assert.equal(f.stops.length, 1);
  assert.equal(f.button("取消").props.disabled, true);
  f.unmount();
  await renderer.act(async () => resolve({ background: { supported: true, loaded: false }, service: { healthy: false } }));
  assert.equal(f.stopped, 0);
});

test("a failed read offers retry instead of showing zero or allowing a stale stop", async () => {
  const f = fixture(); f.read = async () => { throw Error("network"); }; await f.mount();
  assert.ok(text(f.tree.toJSON()).includes("暂时无法完成检查"));
  assert.equal(f.button("停止后台"), undefined);
  f.read = null; await f.click("重试");
  assert.equal(f.button("停止后台").props.disabled, false);
  await f.click("停止后台"); assert.equal(f.stops.length, 1); assert.equal(f.stopped, 1);
  f.unmount();
});
