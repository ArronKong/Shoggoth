#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const {
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");

const cycles = Number(process.argv[2] || 50);
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 1_000) {
  throw new TypeError("cycles must be an integer between 1 and 1000");
}

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

let created = 0;
let initialized = 0;
let stopped = 0;

function makeHost(runtimeProfileId) {
  const instance = ++created;
  return {
    startupStage: "process_spawn",
    terminated: new Promise(() => {}),
    registeredSecrets: [],
    rpc: { stderrDiagnostic: () => "" },
    async initialize() {
      initialized += 1;
      this.startupStage = "rpc_initialize";
      await Promise.resolve();
      this.startupStage = "running";
    },
    async stop() { stopped += 1; },
    subscribe: () => () => {},
    subscribeAccountAuth: () => () => {},
    registerServerRequestHandler: () => () => {},
    async threadStart(input) {
      return { thread: { id: `${runtimeProfileId}-thread-${instance}`, threadSource: input.threadSource } };
    },
    async threadResume(input) {
      return { thread: { id: input.threadId, threadSource: `source-${runtimeProfileId}` } };
    },
  };
}

(async () => {
  const pool = new CodexRuntimePool({
    failureThreshold: cycles * 4,
    hostFactory: ({ runtimeProfileId }) => makeHost(runtimeProfileId),
  });
  const adapter = new CodexRuntimeAdapter({ runtimePool: pool });

  for (let index = 0; index < cycles; index += 1) {
    const runtimeProfileId = `soak-${index}`;
    const binding = {
      runtime: "codex",
      runtimeProfileId,
      runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    };
    const cold = await bounded(adapter.acquire(binding), `cold acquire ${index}`);
    const warm = await bounded(adapter.acquire(binding), `warm acquire ${index}`);
    assert.equal(warm, cold, "warm acquire 必须复用同一 handle");

    const started = await bounded(cold.sessionStart({
      source: `source-${runtimeProfileId}`,
      persistent: true,
    }), `cold session start ${index}`);
    assert.equal(started.session.source, `source-${runtimeProfileId}`);

    await bounded(adapter.stop(binding), `stop ${index}`);
    const restarted = await bounded(adapter.acquire(binding), `restart acquire ${index}`);
    assert.notEqual(restarted, cold, "restart 必须取得新 generation handle");
    const resumed = await bounded(restarted.sessionResume({
      sessionId: started.session.id,
    }), `restart resume ${index}`);
    assert.equal(resumed.session.id, started.session.id);
    await bounded(adapter.stop(binding), `restart stop ${index}`);
  }

  await bounded(adapter.stopAll(), "stopAll");
  assert.equal(created, cycles * 2);
  assert.equal(initialized, created);
  assert.equal(stopped, created);
  assert.equal(pool.entries.size, 0);
  assert.equal(adapter.handles.size, 0);
  console.log(`PASS Runtime cold/warm/restart soak ${cycles}/${cycles}; hosts=${created}; residual=0`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
