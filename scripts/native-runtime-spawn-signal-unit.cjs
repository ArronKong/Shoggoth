"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// An invalid ChildProcess handle can signal PID 0. Each regression therefore
// runs in its own process group, so a broken implementation cannot kill the
// test runner, Service, or another task.
async function worker(runtime, failure, root) {
  const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
  const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
  const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
  const { PiRpcProcess } = require("../app/agent-service/pi-rpc-process");
  const { DeepSeekHarnessProcess } = require("../app/agent-service/deepseek-harness-process");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  let child, closed, killCalls = 0, revocations = 0;
  const spawnProcess = (_command, _args, options = {}) => {
    child = spawn(failure === "missing-executable" ? path.join(root, "absent-executable") : process.execPath,
      ["-e", ""], { ...options,
        cwd: failure === "missing-directory" ? path.join(root, "absent-directory") : workspace });
    const kill = child.kill.bind(child);
    child.kill = (...args) => { killCalls++; return kill(...args); };
    closed = new Promise(resolve => child.once("close", resolve));
    // No fixture error listener: production code must contain the OS error.
    return child;
  };
  const gate = {
    reserveMcpServer: () => ({ reservationId: "fixture", env: [], command: process.execPath, args: [], name: "fixture" }),
    bindMcpServer: () => { throw new Error("Failed spawn must not receive execution authority"); },
    revokeMcpServer: () => { revocations++; },
  };
  const policy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
  const common = { spawnProcess, mcpGateIssuer: gate, permissionPolicy: policy,
    workspace, userHome: workspace, launch: { command: process.execPath, argsPrefix: [] },
    runtimeEnvironment: { spawnEnv: { DSH_HOME: workspace } },
    _spawnEnvironment: () => ({}), requestTimeoutMs: 1000,
    ledger: { sessionDir: workspace }, extensionPath: path.join(root, "extension.mjs"),
  };
  const active = { cwd: workspace, permissionPolicy: policy, model: null,
    remoteSessionId: "00000000-0000-4000-8000-000000000000" };
  if (runtime === "pi-turn") {
    const host = Object.assign(Object.create(PiRuntimeHost.prototype), common);
    assert.throws(() => host._spawnTurn(active), { code: "PI_PROCESS_SPAWN_FAILED" });
    assert.equal(active.process, undefined);
    assert.equal(revocations, 1);
  } else if (runtime === "deepseek-bridge") {
    const host = Object.assign(Object.create(DeepSeekHarnessRuntimeHost.prototype), common,
      { integration: { profile: "fixture", patchPath: path.join(root, "patch") } });
    assert.throws(() => host._spawnBridge(), { code: "DEEPSEEK_HARNESS_PROCESS_SPAWN_FAILED" });
    assert.equal(host.process, undefined);
    assert.equal(revocations, 1);
  } else if (runtime === "claude-turn") {
    const host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), common,
      { fs, binaryPath: fs.realpathSync(process.execPath), _sdkEnvironment: () => ({}) });
    assert.throws(() => host._spawnSdkTurnProcess(active, { command: process.execPath, args: [] }),
      { code: "CLAUDE_CODE_PROCESS_SPAWN_FAILED" });
    assert.equal(active.child, undefined);
  } else if (runtime === "pi-control-abort") {
    const host = Object.assign(Object.create(PiRuntimeHost.prototype), common,
      { binaryPath: process.execPath, controlProcesses: new Map() });
    await assert.rejects(host._runControl(["--version"], { signal: AbortSignal.abort() }),
      { code: "PI_PROCESS_FAILED" });
  } else {
    const Process = runtime === "pi-rpc-stop" ? PiRpcProcess : DeepSeekHarnessProcess;
    const rpc = new Process({ child: spawnProcess(null, null, { stdio: ["pipe", "pipe", "pipe"] }) });
    rpc.kill("SIGKILL");
    await rpc.closedPromise;
  }
  assert.equal(child.pid, undefined);
  await closed;
  assert.equal(killCalls, 0, "A spawn without a PID must never call ChildProcess.kill");
  if (["pi-turn", "deepseek-bridge", "claude-turn"].includes(runtime)) {
    assert.equal(child.listenerCount("error"), 0, "retirement listener must end at physical close");
  }
  process.stdout.write(JSON.stringify({ runtime, failure, killCalls, scopedFailure: true }) + "\n");
}

if (process.argv[2] === "--worker") {
  worker(...process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { test } = require("node:test");
  for (const runtime of ["pi-turn", "deepseek-bridge", "claude-turn", "pi-control-abort", "pi-rpc-stop", "deepseek-rpc-stop"]) {
    for (const failure of ["missing-directory", "missing-executable"]) {
      test(`${runtime} survives ${failure} without signaling the owning process`, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-signal-safety-")));
        fs.chmodSync(root, 0o700);
        try {
          const child = spawn(process.execPath, [__filename, "--worker", runtime, failure, root],
            { detached: true, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "", stderr = "";
          child.stdout.on("data", chunk => { stdout += chunk; });
          child.stderr.on("data", chunk => { stderr += chunk; });
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          const result = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
          }).finally(() => clearTimeout(timer));
          assert.deepEqual(result, { code: 0, signal: null }, `${runtime}: ${stdout}${stderr}`);
          assert.equal(JSON.parse(stdout).killCalls, 0);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}
