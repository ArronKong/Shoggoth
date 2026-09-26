"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");

const binding = (runtime = "codex", profile = "default") => ({
  runtime, runtimeProfileId: profile, runtimeAccountId: `account-${runtime}`,
});
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(extra = {}) {
  let now = 0; let serial = 0;
  const timers = new Map(); const stops = []; const acquisitions = []; const errors = [];
  const registry = new RuntimeAdapterRegistry({
    // This fixture tests queue retirement with generation-only sentinel handles.
    validateHandles: false,
    idleTimeoutMs: 120,
    isIdle: () => true,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    onIdleError(error) { errors.push(error); },
    ...extra,
  });
  for (const runtime of ["codex", "grok-build", "antigravity", "pi", "deepseek-harness"]) {
    registry.register(runtime, {
      async acquire(value, options) { acquisitions.push([value, options]); return { generation: acquisitions.length }; },
      async stop(value) { stops.push(value); },
      async stopAll() {},
    });
  }
  return {
    registry, timers, stops, acquisitions, errors,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id); timer.fn();
      }
      await flush();
    },
  };
}

test("all enabled runtime adapters retire only after the full idle window, then reacquire", async () => {
  const h = harness();
  for (const runtime of ["codex", "grok-build", "antigravity", "pi", "deepseek-harness"]) {
    await h.registry.acquire(binding(runtime), { workspace: "/fixture" });
  }
  await h.advance(119); assert.equal(h.stops.length, 0);
  await h.advance(1); assert.equal(h.stops.length, 5);
  assert.equal(h.timers.size, 0);
  const cold = await h.registry.acquire(binding());
  assert.equal(cold.generation, 6);
  await h.registry.stopAll();
});

test("active work, approvals, login or unverified activity prevent retirement", async () => {
  for (const activity of [false, undefined, Promise.resolve(true), "unknown"]) {
    let idle = activity;
    const h = harness({ isIdle: () => idle });
    await h.registry.acquire(binding());
    await h.advance(120); await h.advance(120);
    assert.equal(h.stops.length, 0);
    idle = true;
    await h.advance(120); assert.equal(h.stops.length, 1);
  }
  const h = harness({ isIdle: () => { throw new Error("activity unavailable"); } });
  await h.registry.acquire(binding()); await h.advance(120);
  assert.equal(h.stops.length, 0);
  await h.registry.stopAll();
});

test("a new acquire resets idle time without keeping unrelated profiles alive", async () => {
  const h = harness();
  await h.registry.acquire(binding("codex", "first"));
  await h.registry.acquire(binding("codex", "second"));
  await h.advance(100);
  await h.registry.acquire(binding("codex", "first"));
  await h.advance(20);
  assert.deepEqual(h.stops.map((b) => b.runtimeProfileId), ["second"]);
  await h.advance(100);
  assert.deepEqual(h.stops.map((b) => b.runtimeProfileId), ["second", "first"]);
});

test("requests arriving during idle cleanup wait and acquire a fresh host", async () => {
  const h = harness(); const stopped = deferred(); let generation = 0;
  h.registry.register("test-runtime", {
    async acquire() { return ++generation; },
    stop() { return stopped.promise; },
    async stopAll() {},
  });
  const b = binding("test-runtime");
  assert.equal(await h.registry.acquire(b), 1);
  await h.advance(120);
  let returned = false;
  const next = h.registry.acquire(b).then((value) => { returned = true; return value; });
  await flush(); assert.equal(returned, false); assert.equal(generation, 1);
  stopped.resolve();
  assert.equal(await next, 2);
  await h.registry.stopAll();
});

test("pending startup is not timed out as an idle runtime", async () => {
  const h = harness(); const ready = deferred(); let stopped = false;
  h.registry.register("test-runtime", {
    acquire() { return ready.promise; }, stop() { stopped = true; }, stopAll() {},
  });
  const starting = h.registry.acquire(binding("test-runtime"));
  await h.advance(1000); assert.equal(stopped, false);
  ready.resolve({ ready: true }); await starting;
  await h.advance(119); assert.equal(stopped, false);
  await h.advance(1); assert.equal(stopped, true);
});

test("cleanup failures are reported and are never turned into successful reacquisition", async () => {
  const h = harness(); const stopped = deferred(); const error = new Error("cleanup incomplete");
  h.registry.register("test-runtime", {
    acquire() { return {}; }, stop() { return stopped.promise; }, stopAll() {},
  });
  await h.registry.acquire(binding("test-runtime")); await h.advance(120);
  const next = h.registry.acquire(binding("test-runtime"));
  stopped.reject(error);
  await assert.rejects(next, (failure) => failure === error);
  await flush(); assert.deepEqual(h.errors, [error]); assert.equal(h.timers.size, 0);
});

test("service shutdown clears idle timers and cannot resurrect an acquiring host", async () => {
  const h = harness();
  await h.registry.acquire(binding());
  await h.registry.stopAll();
  assert.equal(h.timers.size, 0);
  await h.advance(1000); assert.equal(h.stops.length, 0);
  await h.registry.acquire(binding());
  await h.advance(120); assert.equal(h.stops.length, 1);
});
