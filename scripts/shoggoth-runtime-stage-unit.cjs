#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  STARTUP_STAGES,
  isRetryablePreTurnStageError,
  runtimeAccountBackoffError,
  runtimeAccountRetryAt,
  runtimeOperationalError,
  runtimeStageCode,
  runtimeStageError,
  runtimeStageFromError,
} = require("../app/agent-service/runtime-stage-error");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");

assert.deepEqual(STARTUP_STAGES, [
  "runtime_acquire",
  "process_spawn",
  "bootstrap_role",
  "rpc_initialize",
  "mcp_initialize",
  "session_start_or_resume",
  "turn_start",
  "running",
]);

for (const stage of STARTUP_STAGES.slice(0, -1)) {
  const cause = Object.assign(new Error("private detail"), { code: "PRIVATE_FAILURE" });
  const error = runtimeStageError(stage, cause);
  assert.equal(runtimeStageCode(stage), `RUNTIME_START_${stage.toUpperCase()}_FAILED`);
  assert.equal(error.code, runtimeStageCode(stage));
  assert.equal(error.stage, stage);
  assert.equal(error.message.includes("private detail"), false);
  assert.equal(runtimeStageFromError(error), stage);
  assert.equal(isRetryablePreTurnStageError(error), stage !== "turn_start");
  assert.equal(runtimeStageError("runtime_acquire", error), error, "已分阶段错误不得被二次覆盖");

  const legacy = Object.assign(new Error("legacy persisted error"), {
    code: `CODEX_START_${stage.toUpperCase()}_FAILED`,
  });
  assert.equal(runtimeStageFromError(legacy), stage);
  assert.equal(isRetryablePreTurnStageError(legacy), stage !== "turn_start");
  assert.equal(runtimeStageError("runtime_acquire", legacy), legacy, "旧错误码必须继续可读");
}
assert.throws(() => runtimeStageCode("unknown"), TypeError);

const rawAuthRequired = Object.assign(new Error("private auth detail"), { code: "AUTH_REQUIRED" });
const normalizedAuthRequired = runtimeOperationalError(rawAuthRequired);
assert.equal(normalizedAuthRequired.code, "RUNTIME_AUTH_REQUIRED");
assert.equal(normalizedAuthRequired.message.includes("private auth detail"), false);
assert.equal(runtimeStageError("session_start_or_resume", rawAuthRequired).code, "RUNTIME_AUTH_REQUIRED");
const publicAuthRequired = Object.assign(new Error("RUNTIME_AUTH_REQUIRED"), {
  code: "RUNTIME_AUTH_REQUIRED",
});
assert.equal(runtimeOperationalError(publicAuthRequired), publicAuthRequired);
assert.equal(runtimeStageError("session_start_or_resume", publicAuthRequired), publicAuthRequired);
const unrelatedOperationalError = Object.assign(new Error("unrelated"), { code: "UNRELATED" });
assert.equal(runtimeOperationalError(unrelatedOperationalError), unrelatedOperationalError);

const rateLimited = runtimeAccountBackoffError(
  Object.assign(new Error("private retry detail"), { code: "RPC_REMOTE_ERROR" }),
  1_234,
);
const stagedRateLimit = runtimeStageError("runtime_acquire", rateLimited);
assert.equal(runtimeAccountRetryAt(rateLimited), 1_234);
assert.equal(runtimeAccountRetryAt(stagedRateLimit), 1_234);
assert.equal(runtimeAccountRetryAt(Object.assign(new Error("untrusted"), { retryAt: 1_234 })), null);
assert.throws(() => runtimeAccountBackoffError(new Error("bad"), -1), TypeError);

async function adapterFailureStage(diagnostic) {
  const remoteError = Object.assign(new Error("private remote failure"), { code: "RPC_REMOTE_ERROR" });
  const host = {
    terminated: new Promise(() => {}),
    rpc: { stderrDiagnostic: () => diagnostic },
    threadStart: async () => { throw remoteError; },
  };
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host } });
  const handle = await adapter.acquire({
    runtime: "codex",
    runtimeProfileId: "stage-test",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  });
  let captured;
  await assert.rejects(
    handle.sessionStart({ source: "stage-test", persistent: true }),
    (error) => {
      captured = error;
      return typeof error?.stage === "string";
    },
  );
  return captured;
}

async function poolFailureStage(stage) {
  let stopCalls = 0;
  const pool = new CodexRuntimePool({
    runtimeAccountResolver: {
      resolve(binding) {
        return Object.freeze({
          runtime: binding.runtime,
          runtimeAccountId: binding.runtimeAccountId,
          home: "/tmp",
          binaryPath: process.execPath,
          launchArgs: Object.freeze([]),
          spawnEnv: Object.freeze({ HOME: "/tmp", CODEX_HOME: "/tmp" }),
          configurationMode: "overlay",
        });
      },
    },
    hostFactory: () => ({
      startupStage: stage,
      initialize: async () => { throw new Error("private startup failure"); },
      stop: async () => { stopCalls += 1; },
    }),
  });
  await assert.rejects(
    pool.get(`pool-${stage}`),
    (error) => error?.stage === stage && !error.message.includes("private startup failure"),
  );
  assert.equal(stopCalls, 1, `${stage} 失败后必须清理 Host`);
}

(async () => {
  await poolFailureStage("process_spawn");
  await poolFailureStage("rpc_initialize");

  assert.equal((await adapterFailureStage(
    "[bootstrap] startup failure: BOOTSTRAP_ROLE_REJECTED",
  )).stage, "bootstrap_role");
  assert.equal((await adapterFailureStage(
    "[bootstrap] startup failure: MCP_HELPER_AUTH_FAILED",
  )).stage, "mcp_initialize");
  assert.equal((await adapterFailureStage("")).stage, "session_start_or_resume");

  console.log("Shoggoth Runtime stage unit tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
