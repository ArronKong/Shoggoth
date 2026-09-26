import assert from "node:assert/strict";
import test from "node:test";
import { build } from "../app/manage-ui/node_modules/esbuild/lib/main.js";

const compiled = await build({
  entryPoints: ["app/manage-ui/src/pages/chat-model-refresh.ts"],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { createModelCatalogRefresh } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("opening the model menu during discovery shares the pending request", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const states = [];
  const loader = createModelCatalogRefresh({
    load: async () => { calls++; await gate; },
    onState: state => states.push(state),
  });
  const first = loader.refresh();
  assert.equal(loader.refresh(), first);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(states, [{ loading: true, error: false }]);
  release();
  await first;
  assert.deepEqual(states.at(-1), { loading: false, error: false });
  loader.dispose();
});

test("a cold discovery failure is visible and automatically recovers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const states = [];
  const loader = createModelCatalogRefresh({
    load: async () => { if (++calls === 1) throw new Error("discovery unavailable"); },
    onState: state => states.push(state),
  });
  await assert.rejects(loader.refresh());
  assert.deepEqual(states.at(-1), { loading: false, error: true });
  t.mock.timers.tick(1499);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(states.at(-1), { loading: false, error: false });
  loader.dispose();
});

test("persistent failure stops automatic retries but permits a later manual retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let fail = true;
  const states = [];
  const loader = createModelCatalogRefresh({
    load: async () => { calls++; if (fail) throw new Error("offline"); },
    onState: state => states.push(state),
  });
  await assert.rejects(loader.refresh());
  for (const delay of [1500, 5000, 60000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(calls, 3);
  assert.deepEqual(states.at(-1), { loading: false, error: true });
  fail = false;
  await loader.refresh();
  assert.equal(calls, 4);
  assert.deepEqual(states.at(-1), { loading: false, error: false });
  loader.dispose();
});

test("manual retry cancels the scheduled retry instead of launching a second discovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const loader = createModelCatalogRefresh({
    load: async () => { if (++calls === 1) throw new Error("offline"); }, onState() {},
  });
  await assert.rejects(loader.refresh());
  await loader.refresh();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 2);
  loader.dispose();
});

test("switching away cancels retry and ignores late completion state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const loader = createModelCatalogRefresh({
    load: async () => { calls++; throw new Error("offline"); }, onState() {},
  });
  await assert.rejects(loader.refresh());
  loader.dispose();
  t.mock.timers.tick(60000);
  await flush();
  await loader.refresh();
  assert.equal(calls, 1);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const states = [];
  const pending = createModelCatalogRefresh({ load: () => gate, onState: state => states.push(state) });
  const request = pending.refresh();
  pending.dispose();
  release();
  await request;
  assert.deepEqual(states, [{ loading: true, error: false }]);
});
