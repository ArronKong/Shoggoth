// Exercise the production React component and shared desktop pool with a
// controlled native bridge. Mounting a card must not submit an Agent action.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { act, create } = require("react-test-renderer"), ts = require("typescript");
const part = { schemaVersion: 1, artifactId: "loan-card", revision: 1, sourceEventId: "loan-source",
  segmentId: "loan-segment", title: "贷款计算器", summary: "调整参数" };
const textOf = node => typeof node === "string" ? node : Array.isArray(node)
  ? node.map(textOf).join(" ") : node?.children ? textOf(node.children) : "";

async function harness(t, { available = true, failFirst = false } = {}) {
  const calls = [], subscribers = new Set(), timers = new Map(), cache = new Map();
  let timerId = 0, mounts = 0, confirmed = { amount: 1000000, annualRate: 4.2, termYears: 30 };
  const bridge = {
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    async mount(value) {
      calls.push({ kind: "mount", value });
      if (++mounts === 1 && failFirst) return { ok: false, error: { code: "UI_HOST_REQUIRED", message: "暂时无法加载" } };
      return { ok: true, result: { descriptor: { part, actions: [], enabled: true }, state: { ...confirmed },
        stateRevision: mounts, draftId: `draft-${mounts}`, readOnly: false, readOnlyReason: null } };
    },
    async release(value) { calls.push({ kind: "release", value }); return { ok: true, result: null }; },
    async theme() { return { ok: true, result: null }; },
    action() { assert.fail("automatic display submitted an Agent action"); },
  };
  const window = { openclawDesktop: available ? { chatUi: bridge } : undefined };
  class Observer { observe() {} disconnect() {} }
  const context = { window, document: { documentElement: { dataset: {}, classList: { contains: () => false } } },
    crypto: webcrypto, structuredClone, MutationObserver: Observer,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id) };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
    }).outputText;
    vm.runInNewContext(code, { ...context, module, exports: module.exports, require: name => {
      if (name === "react-i18next") return { useTranslation: () => ({ i18n: { language: "zh-CN" } }) };
      if (name === "../api/client") return { chatUiRequest: () => assert.fail("autoload performed an action/query") };
      if (name.endsWith(".css")) return {};
      if (name.startsWith(".")) return load(path.resolve(path.dirname(file), name) + (name.includes("ChatUiArtifact") ? ".tsx" : ".ts"));
      return require(name);
    } });
    return module.exports;
  }
  const Card = load(path.join(ui, "src/components/ChatUiArtifact.tsx")).default;
  const pool = load(path.join(ui, "src/lib/chatUiDesktop.ts"));
  const owner = { backend: "shoggoth", agentId: "shoggoth-codex", sessionKey: "loan-session", part };
  const props = { ...owner, visible: true };
  let renderer;
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); });
  const render = async (extra = {}) => act(async () => {
    const element = React.createElement(Card, { ...props, ...extra });
    if (renderer) renderer.update(element); else renderer = create(element);
  });
  return { calls, pool, owner, props, Card, render, get renderer() { return renderer; },
    get mounts() { return mounts; }, get text() { return textOf(renderer.toJSON()); },
    set confirmed(value) { confirmed = value; },
    async emit(value) { await act(async () => { for (const listener of subscribers) listener(value); }); },
    async leave() { await act(async () => renderer.unmount()); renderer = null; },
    async expireDeparture() { await act(async () => { for (const [id, timer] of [...timers]) {
      timers.delete(id); timer.fn();
    } }); },
  };
}

test("settled/history card loads by default without a user click or model action", async t => {
  const h = await harness(t); await h.render();
  assert.equal(h.mounts, 1);
  assert.equal(h.pool.nativeUiPoolEntry(h.owner).value.active, true);
  assert.doesNotMatch(h.text, /激活交互|激活后可调整/u);
  await h.render({ part: { ...part } });
  assert.equal(h.mounts, 1, "settling/re-rendering keeps the same native document");
});

test("hidden surface waits until visible and does not reopen a card selected elsewhere", async t => {
  const h = await harness(t); await h.render({ visible: false }); assert.equal(h.mounts, 0);
  await h.render(); assert.equal(h.mounts, 1);
  const entry = h.pool.nativeUiPoolEntry(h.owner);
  await h.emit({ mountId: entry.mountId, type: "inactive" });
  await h.render({ visible: false }); await h.render();
  assert.equal(h.mounts, 1, "mode handover must not replace a subsequently selected card");
});

test("returning after a real departure loads the saved parameters automatically", async t => {
  const h = await harness(t); await h.render();
  h.confirmed = { amount: 500000, annualRate: 3.5, termYears: 20 };
  await h.leave(); await h.expireDeparture();
  assert.equal(h.calls.filter(call => call.kind === "release").length, 1);
  await h.render(); assert.equal(h.mounts, 2);
  assert.deepEqual(h.pool.nativeUiPoolEntry(h.owner).value.state, { amount: 500000, annualRate: 3.5, termYears: 20 });
});

test("ordinary/immersive DOM handover shares the same native document", async t => {
  const h = await harness(t); await h.render();
  await h.leave(); await h.render(); await h.expireDeparture();
  assert.equal(h.mounts, 1);
  assert.equal(h.calls.filter(call => call.kind === "release").length, 0);
});

test("failed default load is bounded and a user can retry", async t => {
  const h = await harness(t, { failFirst: true }); await h.render(); assert.equal(h.mounts, 1);
  assert.match(h.text, /暂时无法加载/u);
  await h.render(); assert.equal(h.mounts, 1, "failed mounts do not loop");
  const retry = h.renderer.root.findAllByType("button").find(button => /加载|显示/.test(textOf(button.toJSON?.() ?? { children: button.children })));
  assert(retry, "a failed load needs a retry control");
  await act(async () => retry.props.onClick()); assert.equal(h.mounts, 2);
});

test("browser without desktop bridge does not attempt a native mount", async t => {
  const h = await harness(t, { available: false }); await h.render();
  assert.equal(h.mounts, 0); assert.match(h.text, /桌面应用/u);
  assert.equal(h.pool.nativeUiPoolEntry(h.owner).autoActivationConsumed, false);
});

test("a non-current history card waits for explicit selection", async t => {
  const h = await harness(t); await h.render({ autoActivate: false });
  assert.equal(h.mounts, 0);
  const button = h.renderer.root.findAllByType("button").find(button => button.children.includes("显示交互卡片"));
  assert(button); await act(async () => button.props.onClick());
  assert.equal(h.mounts, 1);
});
