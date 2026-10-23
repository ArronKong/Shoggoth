// Exercise the real hook with controlled service replies, timers and window events.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";

const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react");
const { act, create } = require("react-test-renderer");
const ts = require("typescript");
const groupReply = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ui, "src/lib/groupReply.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: groupReply, exports: groupReply.exports });
const code = ts.transpileModule(fs.readFileSync(path.join(ui, "src/lib/groupChat.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const group = id => ({ group: { id, name: id }, internalSessionKeys: [`internal:${id}`] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness(t, load) {
  let now = 100, timerId = 0, calls = 0, current, renderer;
  const timers = new Map(), window = new EventTarget(), document = new EventTarget();
  document.visibilityState = "visible";
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, window, document, CustomEvent,
    Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name === "react" ? React : name === "../api/client"
      ? { listGroupChats: () => { calls++; return load(calls); } } : name === "./groupReply" ? groupReply.exports : require(name),
  });
  function Probe() { current = module.exports.useGroupChats(); return React.createElement("ul", null,
    current.groups.map(row => React.createElement("li", { key: row.group.id }, row.group.name))); }
  const unmount = async () => { if (renderer) { await act(async () => renderer.unmount()); renderer = null; } };
  t.after(unmount);
  await act(async () => { renderer = create(React.createElement(Probe)); });
  return {
    ...module.exports, window, document, timers, unmount,
    get calls() { return calls; }, get current() { return current; },
    get ids() { return Array.from(current.groups, row => row.group.id); },
    refresh: () => act(async () => { await current.refresh(); }),
    event: (target, type) => act(async () => { target.dispatchEvent(new Event(type)); }),
    change: () => act(async () => module.exports.emitGroupChanged("old")),
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]);
        await act(async () => { next[1].fn(); });
      }
      now = until;
    },
  };
}

test("cold-start failure recovers without creating a group or receiving group events", async t => {
  const h = await harness(t, async n => { if (n === 1) throw Error("GROUP_CHAT_UNAVAILABLE"); return { groups: [group("existing")] }; });
  assert.deepEqual(h.ids, []);
  await h.advance(1000);
  assert.deepEqual(h.ids, ["existing"]);
  assert.equal(h.calls, 2);
  await h.advance(60000);
  assert.equal(h.calls, 2, "successful lists are not polled");
});

test("repeated startup failures back off, then recover even after a long service startup", async t => {
  let ready = false;
  const h = await harness(t, async () => { if (!ready) throw Error("offline"); return { groups: [group("ready")] }; });
  await h.advance(30000);
  assert.ok(h.calls >= 4 && h.calls <= 8, "retry rate stays bounded");
  ready = true;
  await h.advance(30000);
  assert.deepEqual(h.ids, ["ready"]);
});

test("failed and malformed refreshes retain existing groups and enabled state", async t => {
  let reply = { groups: [group("existing")], enabled: false };
  const h = await harness(t, async () => reply);
  assert.equal(h.current.enabled, false);
  reply = {};
  await h.refresh();
  assert.deepEqual(h.ids, ["existing"]);
  assert.equal(h.current.enabled, false);
  reply = { groups: [group("recovered")], enabled: true };
  await h.advance(1000);
  assert.deepEqual(h.ids, ["recovered"]);
  assert.equal(h.current.enabled, true);
  reply = { groups: [] };
  await h.refresh();
  assert.deepEqual(h.ids, [], "an authoritative empty list clears archived groups");
  assert.equal(h.timers.size, 0);
});

test("focus and returning to a visible page refresh idle groups", async t => {
  let reply = { groups: [] };
  const h = await harness(t, async () => reply);
  reply = { groups: [group("existing")] };
  await h.event(h.window, "focus");
  assert.deepEqual(h.ids, ["existing"]);
  h.document.visibilityState = "hidden";
  await h.event(h.document, "visibilitychange");
  assert.equal(h.calls, 2);
  h.document.visibilityState = "visible";
  reply = { groups: [group("newer")] };
  await h.event(h.document, "visibilitychange");
  assert.deepEqual(h.ids, ["newer"]);
});

test("group events debounce and an in-flight refresh rechecks changes after its response", async t => {
  const first = deferred(), next = deferred();
  const h = await harness(t, n => n === 1 ? first.promise : next.promise);
  await h.change(); await h.change(); await h.advance(150);
  assert.equal(h.calls, 1, "do not start overlapping list requests");
  await act(async () => first.resolve({ groups: [group("old")] }));
  assert.equal(h.calls, 2, "a change during loading must not be lost");
  await act(async () => next.resolve({ groups: [group("old"), group("created")] }));
  assert.deepEqual(h.ids, ["old", "created"]);
});

test("unmount cancels retries and event listeners", async t => {
  const h = await harness(t, async () => { throw Error("offline"); });
  assert.equal(h.timers.size, 1);
  await h.unmount();
  await h.advance(60000); await h.event(h.window, "focus"); await h.change();
  assert.equal(h.calls, 1);
  assert.equal(h.timers.size, 0);
});

test("late replies from an unmounted hook cannot update the shared internal-session cache", async t => {
  const pending = deferred();
  const h = await harness(t, () => pending.promise);
  await h.unmount();
  await act(async () => pending.resolve({ groups: [group("late")] }));
  assert.equal(await h.isGroupInternalSession("internal:late"), false);
  assert.equal(h.calls, 1);
});
