"use strict";
const assert = require("node:assert/strict"), test = require("node:test"), vm = require("node:vm");
const { bridgeSdk } = require("../app/native-chat-ui-renderer");
const saved = { amount: 5820000, annualRate: 30, termYears: 10 };
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const events = new Map(), timers = new Map(), calls = [];
  let timerId = 0;
  const parent = { postMessage() {} };
  const context = vm.createContext({ parent, queueMicrotask,
    addEventListener: (name, listener) => events.set(name, listener),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(bridgeSdk(), context);
  const port = { start() {}, postMessage(request) {
    calls.push(request.type);
    queueMicrotask(() => port.onmessage({ data: { id: request.id, result: request.type === "ready"
      ? { state: saved, stateRevision: 5, readOnly: false, readOnlyReason: null } : null } }));
  } };
  events.get("message")({ source: parent, data: { type: "shoggoth-ui-connect" }, ports: [port] });
  return { sdk: context.shoggothUi, context, calls, update(state) {
    port.onmessage({ data: { type: "state", value: { state, stateRevision: 6 } } });
  } };
}

test("a generated page subscribing after ready restores saved parameters immediately", async () => {
  const f = fixture(), seen = [];
  await f.sdk.ready();
  f.sdk.onStateChange(value => seen.push(plain(value)));
  assert.deepEqual(seen, [saved]);
  assert.deepEqual(f.calls, ["ready"], "display restoration must not save defaults or submit an action");
});

test("a subscription before ready receives initialization once", async () => {
  const f = fixture(), seen = [];
  f.sdk.onStateChange(value => seen.push(plain(value)));
  assert.deepEqual(seen, []);
  await f.sdk.ready();
  assert.deepEqual(seen, [saved]);
});

test("late subscribers receive current local edits instead of the cached ready reply", async () => {
  const f = fixture(), seen = [];
  await f.sdk.ready();
  vm.runInContext("void shoggothUi.setState({amount:420000});", f.context);
  await Promise.resolve(); await Promise.resolve();
  f.sdk.onStateChange(value => seen.push(plain(value)));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { ...saved, amount: 420000 });
  assert(!f.calls.includes("state.patch"), "the replay does not flush an unconfirmed edit");
});

test("subscriber mutations and errors do not alter other subscribers or host state", async () => {
  const f = fixture(), seen = [];
  await f.sdk.ready();
  f.sdk.onStateChange(value => { value.amount = 0; throw Error("page listener failed"); });
  f.sdk.onStateChange(value => seen.push(plain(value)));
  assert.deepEqual(seen, [saved]);
  f.update({ ...saved, amount: 500000 });
  assert.deepEqual(seen.at(-1), { ...saved, amount: 500000 });
});

test("unsubscribe still stops later state notifications", async () => {
  const f = fixture(), seen = [];
  await f.sdk.ready();
  const off = f.sdk.onStateChange(value => seen.push(plain(value)));
  off(); f.update({ ...saved, amount: 500000 });
  assert.deepEqual(seen, [saved]);
});
