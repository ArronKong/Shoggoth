#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  RuntimeAdapterRegistry,
} = require(path.join(ROOT, "app", "agent-service", "runtime-adapter-registry.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function adapter(overrides = {}) {
  return {
    acquire() {},
    stop() {},
    stopAll() {},
    ...overrides,
  };
}

test("acquire 与 stop 按 RuntimeBinding 路由到唯一 Adapter", async () => {
  const calls = [];
  const registry = new RuntimeAdapterRegistry();
  registry.register("codex", adapter({
    acquire(binding, options) {
      calls.push(["acquire", binding, options]);
      return Promise.resolve("codex-handle");
    },
    stop(binding) {
      calls.push(["stop", binding]);
      return Promise.resolve();
    },
  }));
  registry.register("grok", adapter({
    acquire() { throw new Error("wrong adapter"); },
    stop() { throw new Error("wrong adapter"); },
  }));

  const options = { spawnEnv: { RUNTIME_TEST: "1" } };
  const binding = {
    runtime: "codex",
    runtimeProfileId: "profile-codex",
    runtimeAccountId: "account-codex",
  };
  assert.equal(await registry.acquire(binding, options), "codex-handle");
  await registry.stop(binding);
  assert.deepEqual(calls.map(([method]) => method), ["acquire", "stop"]);
  assert.deepEqual(calls[0][1], binding);
  assert.equal(Object.isFrozen(calls[0][1]), true);
  assert.equal(calls[0][2], options);
});

test("重复注册、非法注册与未知 Runtime 都严格拒绝", () => {
  const registry = new RuntimeAdapterRegistry();
  registry.register("codex", adapter());
  assert.throws(
    () => registry.register("codex", adapter()),
    (error) => error.code === "RUNTIME_ADAPTER_ALREADY_REGISTERED",
  );
  assert.throws(
    () => registry.register("Bad Runtime", adapter()),
    (error) => error.code === "RUNTIME_REGISTRY_INVALID",
  );
  assert.throws(
    () => registry.register("grok", {}),
    (error) => error.code === "RUNTIME_ADAPTER_INVALID",
  );
  const unknown = {
    runtime: "grok",
    runtimeProfileId: "profile-grok",
    runtimeAccountId: "account-grok",
  };
  assert.throws(
    () => registry.acquire(unknown),
    (error) => error.code === "RUNTIME_UNSUPPORTED",
  );
  assert.throws(
    () => registry.stop(unknown),
    (error) => error.code === "RUNTIME_UNSUPPORTED",
  );
});

test("被禁用的 Claude 即使被注册也不能启动", () => {
  const registry = new RuntimeAdapterRegistry();
  let called = false;
  registry.register("claude-code", adapter({ acquire() { called = true; } }));
  assert.throws(() => registry.acquire({ runtime: "claude-code", runtimeProfileId: "saved-profile",
    runtimeAccountId: "saved-account" }), error => error.code === "RUNTIME_UNSUPPORTED");
  assert.equal(called, false);
});

test("stop 保留目标 Adapter 的清理失败", async () => {
  const expected = new Error("profile cleanup failed");
  const registry = new RuntimeAdapterRegistry();
  registry.register("codex", adapter({
    async stop() { throw expected; },
  }));
  await assert.rejects(
    registry.stop({
      runtime: "codex",
      runtimeProfileId: "profile-codex",
      runtimeAccountId: "account-codex",
    }),
    (error) => error === expected,
  );
});

test("stopAll 尝试全部 Adapter 后聚合所有清理失败", async () => {
  const calls = [];
  const firstFailure = new Error("codex cleanup failed");
  const secondFailure = new Error("future cleanup failed");
  const registry = new RuntimeAdapterRegistry();
  registry.register("codex", adapter({
    stopAll() {
      calls.push("codex");
      throw firstFailure;
    },
  }));
  registry.register("grok", adapter({
    async stopAll() { calls.push("grok"); },
  }));
  registry.register("future", adapter({
    async stopAll() {
      calls.push("future");
      throw secondFailure;
    },
  }));

  await assert.rejects(registry.stopAll(), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.code, "RUNTIME_ADAPTER_REGISTRY_STOP_FAILED");
    assert.deepEqual(error.errors, [firstFailure, secondFailure]);
    assert.deepEqual(error.failures.map(({ runtime, error: failure }) => [runtime, failure]), [
      ["codex", firstFailure],
      ["future", secondFailure],
    ]);
    return true;
  });
  assert.deepEqual(calls, ["codex", "grok", "future"]);
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth runtime adapter registry (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
