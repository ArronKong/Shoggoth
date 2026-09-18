#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const bootstrap = require("../app/bootstrap-role");
const { readCodeIdentity, CODEX_TEAM_IDENTIFIER, CODEX_DESIGNATED_REQUIREMENT } = require("../app/agent-service/code-identity");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { configOverridesFor } = require("../app/agent-service/codex-runtime-config");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID: runtimeAccountId } = require("../app/agent-service/runtime-account");

const identity = { teamIdentifier: CODEX_TEAM_IDENTIFIER, designatedRequirement: CODEX_DESIGNATED_REQUIREMENT };
const resourcesPath = "/Applications/Shoggoth.app/Contents/Resources";
const executable = `${resourcesPath}/codex/package/bin/codex`;

async function main() {
  const calls = [];
  const slowCodesign = (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === "--verify" && options.timeout < 25_000) {
      return { status: null, error: Object.assign(new Error("private timeout detail"), { code: "ETIMEDOUT" }) };
    }
    return { status: 0, stderr: `TeamIdentifier=${CODEX_TEAM_IDENTIFIER}\n# designated => ${CODEX_DESIGNATED_REQUIREMENT}` };
  };
  // Model a 25-second cold signature read without sleeping or weakening codesign.
  assert.deepEqual(readCodeIdentity(executable, { spawnSync: slowCodesign, verifyTimeoutMs: 60_000 }), identity);
  assert.equal(calls[0].options.timeout, 60_000);
  assert.equal(calls[1].options.timeout, 20_000);
  assert.throws(() => readCodeIdentity(executable, { spawnSync: slowCodesign }), { code: "CODE_IDENTITY_TIMEOUT" });
  for (const timeout of [null, Infinity, 0, 60_001]) {
    assert.throws(() => readCodeIdentity(executable, { verifyTimeoutMs: timeout, spawnSync: slowCodesign }), { code: "CODE_IDENTITY_INVALID" });
  }

  const runtime = {
    platform: "darwin", defaultApp: false, ppid: 481, resourcesPath,
    parent: { executable, command: `${executable} app-server` },
    verifyCodeIdentity: () => identity,
  };
  const argv = ["--shoggoth-internal-role=mcp"];
  for (const [code, expected] of [
    ["CODE_IDENTITY_TIMEOUT", "BOOTSTRAP_CODE_IDENTITY_TIMEOUT"],
    ["CODE_IDENTITY_INVALID", "BOOTSTRAP_CODE_IDENTITY_INVALID"],
  ]) {
    assert.throws(() => bootstrap.main(argv, {}, {
      ...runtime,
      verifyCodeIdentity() { throw Object.assign(new Error("private identity detail"), { code }); },
    }), (error) => error.code === expected && error.message === expected
      && bootstrap.bootstrapFailureCode(error) === expected);
  }
  assert.throws(() => bootstrap.main(argv, {}, {
    ...runtime, parent: { executable: "/tmp/codex", command: "codex" },
  }), { code: "BOOTSTRAP_ROLE_REJECTED" });

  const host = new CodexRuntimeHost({ runtimeProfileId: "startup-budget", runtimeAccountId, schemaContract: {},
    runtimeEnvironment: Object.freeze({ runtime: "codex", runtimeAccountId,
      home: "/tmp", binaryPath: executable, launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: "/tmp", CODEX_HOME: "/tmp" }), configurationMode: "overlay" }) });
  const operations = [];
  host._request = async (operation, params, options) => operations.push({ operation, params, options });
  await host.threadStart({});
  await host.threadResume({});
  await host.threadRead({});
  const controller = new AbortController();
  await host.threadStart({}, { signal: controller.signal, timeoutMs: 10 });
  const { CODEX_MCP_STARTUP_TIMEOUT_SEC, CODEX_PARENT_VERIFY_TIMEOUT_MS } = require("../app/agent-service/codex-startup-timeouts");
  assert.ok(CODEX_MCP_STARTUP_TIMEOUT_SEC * 1_000 > CODEX_PARENT_VERIFY_TIMEOUT_MS + 80_000);
  assert.ok(operations[0].options.timeoutMs > CODEX_MCP_STARTUP_TIMEOUT_SEC * 1_000);
  assert.equal(operations[1].options.timeoutMs, operations[0].options.timeoutMs);
  assert.equal(operations[2].options, undefined);
  assert.equal(host.requestTimeoutMs, 30_000);
  assert.deepEqual(operations[3].options, { timeoutMs: 10, signal: controller.signal });
  const overrides = configOverridesFor(null, { runtimeProfileId: "startup-budget", runtimeAccountId: host.runtimeAccountId,
    launch: { command: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth", argsPrefix: [] } });
  assert.ok(overrides.includes(`mcp_servers.shoggoth.startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC}`));

  for (const [message, expected, stage] of [
    ["private-canary BOOTSTRAP_CODE_IDENTITY_TIMEOUT", "BOOTSTRAP_CODE_IDENTITY_TIMEOUT", "bootstrap_role"],
    ["private-canary BOOTSTRAP_CODE_IDENTITY_INVALID", "BOOTSTRAP_CODE_IDENTITY_INVALID", "bootstrap_role"],
    ["private-canary required MCP servers failed to initialize: shoggoth", "MCP_INITIALIZE_FAILED", "mcp_initialize"],
    ["private-canary unknown remote failure", undefined, "session_start_or_resume"],
  ]) {
    for (const method of ["thread/start", "thread/resume", "thread/read"]) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const rpc = new CodexJsonlRpcClient(child);
      const result = rpc.request(method, {});
      child.stdout.write(`${JSON.stringify({ id: 1, error: { code: -32603, message } })}\n`);
      let captured;
      await assert.rejects(result, (error) => {
        captured = error;
        assert.equal(error.code, "RPC_REMOTE_ERROR");
        assert.equal(error.startupDiagnostic, method === "thread/read" ? undefined : expected);
        assert.equal(JSON.stringify(error).includes("private-canary"), false);
        assert.equal(error.message.includes("private-canary"), false);
        return true;
      });
      if (method !== "thread/read") {
        const failingHost = {
          terminated: new Promise(() => {}), rpc: { stderrDiagnostic: () => "" },
          threadStart: async () => { throw captured; }, threadResume: async () => { throw captured; },
        };
        const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => failingHost } });
        const handle = await adapter.acquire({ runtime: "codex", runtimeProfileId: "startup-budget", runtimeAccountId: host.runtimeAccountId });
        await assert.rejects(method === "thread/start" ? handle.sessionStart({}) : handle.sessionResume({ sessionId: "test" }),
          (error) => error.stage === stage && !JSON.stringify(error).includes("private-canary"));
      }
      await rpc.terminate();
    }
  }
  console.log("Shoggoth Codex startup regression passed: cold signatures, nested budgets, safe diagnostics, start/resume");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
