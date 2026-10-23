"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
const { OpenCodeRuntimeHost, commandEnvironment } = require("../app/agent-service/opencode-runtime-host");
const { DEFAULT_MCP_TOOL_TIMEOUT_MS } = require("../app/agent-service/interactive-timeouts");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const binding = { runtime: "pi", runtimeProfileId: "fixture-pi", runtimeAccountId: "fixture-account" };
  let pauses = 0, resumed = 0;
  const facade = runtimeHandleV1({ ...binding, capabilities: {}, subscribe() {}, terminated: new Promise(() => {}),
    host: { pauseManagedToolTimeout(input) { assert.deepEqual(input, { sessionId: "s", turnId: "t" }); pauses++; return () => { resumed++; }; } } }, binding);
  const resume = facade.pauseManagedToolTimeout({ sessionId: "s", turnId: "t" });
  assert.equal(pauses, 1); resume(); resume(); assert.equal(resumed, 1);
  assert.throws(() => facade.pauseManagedToolTimeout({ sessionId: "s", turnId: "t", runId: "foreign" }), { code: "RUNTIME_PROTOCOL_INVALID" });
  console.log("PASS V1 managed-tool timeout scope and once-only release");

  let timedOut = 0;
  const active = { sessionId: "s", turnId: "t", settled: false, promptTimer: null, promptTimeoutPaused: false };
  const pi = { activeTurns: new Map([["s", active]]), now: Date.now,
    _armPromptTimeout: PiRuntimeHost.prototype._armPromptTimeout,
    _pausePromptTimeout: PiRuntimeHost.prototype._pausePromptTimeout,
    _resumePromptTimeout: PiRuntimeHost.prototype._resumePromptTimeout,
    _killActiveProcess() {}, _failActive() { active.settled = true; timedOut++; } };
  pi._armPromptTimeout(active, 80);
  const release = PiRuntimeHost.prototype.pauseManagedToolTimeout.call(pi, { sessionId: "s", turnId: "t" });
  pi._pausePromptTimeout(active); // A concurrent native confirmation also owns a pause.
  pi._resumePromptTimeout(active);
  await delay(120); assert.equal(timedOut, 0); assert.equal(active.promptTimeoutPaused, true);
  release(); release(); await delay(120); assert.equal(timedOut, 1);
  console.log("PASS Pi nested native/tool waits preserve and resume the remaining turn deadline");

  let acpPaused = 0;
  const agy = { activeTurns: new Map([["s", { turnId: "t" }]]), rpc: {
    pauseRequestTimeout(method, predicate) { assert.equal(method, "session/prompt"); assert.equal(predicate({ sessionId: "s" }), true);
      assert.equal(predicate({ sessionId: "foreign" }), false); acpPaused++; return () => { acpPaused--; }; },
  } };
  const acpRelease = AntigravityAcpRuntimeHost.prototype.pauseManagedToolTimeout.call(agy, { sessionId: "s", turnId: "t" });
  assert.equal(acpPaused, 1); acpRelease(); assert.equal(acpPaused, 0);
  assert.throws(() => AntigravityAcpRuntimeHost.prototype.pauseManagedToolTimeout.call(agy, { sessionId: "s", turnId: "foreign" }), { code: "RUNTIME_SESSION_BUSY" });
  console.log("PASS Antigravity pauses only the assigned ACP prompt");

  let now = 0;
  const openActive = { sessionId: "s", turnId: "t", done: false };
  const open = { activeTurns: new Map([["s", openActive]]), now: () => now };
  const first = OpenCodeRuntimeHost.prototype.pauseManagedToolTimeout.call(open, { sessionId: "s", turnId: "t" });
  now = 100;
  const second = OpenCodeRuntimeHost.prototype.pauseManagedToolTimeout.call(open, { sessionId: "s", turnId: "t" });
  now = 200; first(); assert.equal(openActive.managedToolWaitDepth, 1);
  now = 500; second(); second();
  assert.equal(openActive.managedToolWaitDepth, 0); assert.equal(openActive.managedToolWaitMs, 500);
  const env = commandEnvironment({}, { spawnEnv: {} }, "/private/config", "a".repeat(64),
    { approvalPolicy: "on-request", sandbox: "danger-full-access" }, { command: "/bin/true", args: [], env: [] });
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp.shoggoth.timeout, DEFAULT_MCP_TOOL_TIMEOUT_MS);
  const extension = fs.readFileSync(require.resolve("../resources/pi/shoggoth-pi-extension.mjs"), "utf8");
  assert.match(extension, /WORKSPACE_REQUEST_TIMEOUT_MS = 2_147_000_000/u);
  assert.match(extension, /params\?\.name === "workspace_execute" \? WORKSPACE_REQUEST_TIMEOUT_MS/u);
  console.log("PASS OpenCode waits count elapsed time once; MCP/Pi outer deadlines cover managed commands");
})().catch(error => { console.error(error); process.exitCode = 1; });
