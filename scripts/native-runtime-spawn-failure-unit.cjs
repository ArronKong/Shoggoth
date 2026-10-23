"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { GrokBuildRuntimeHost } = require("../app/agent-service/grok-build-runtime-host");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");

const ROOT = path.resolve(__dirname, "..");
for (const [runtime, Host, account, code] of [
  ["codex", CodexRuntimeHost, "shoggoth-internal-codex-default-v1", "CODEX_PROCESS_INVALID"],
  ["grok-build", GrokBuildRuntimeHost, "native-grok-build-default-v1", "GROK_BUILD_PROCESS_INVALID"],
  ["antigravity", AntigravityAcpRuntimeHost, "native-antigravity-default-v1", "ANTIGRAVITY_ACP_PROCESS_INVALID"],
]) for (const failure of ["missing-directory", "missing-executable"]) {
  test(`${runtime} contains the asynchronous OS error after ${failure}`, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-spawn-failure-")));
    fs.chmodSync(root, 0o700);
    const stateDir = path.join(root, "state"), home = path.join(root, "home");
    const userHome = path.join(root, "user"), workspace = path.join(root, "workspace");
    const binaryPath = path.join(root, "runtime"), harnessPath = path.join(root, "harness");
    for (const directory of [stateDir, home, userHome, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
    for (const file of [binaryPath, harnessPath]) fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    let child, childClosed;
    const managed = runtime === "codex";
    const nativeHome = managed ? null : path.join(userHome, runtime === "antigravity" ? ".gemini" : ".grok");
    if (nativeHome) fs.mkdirSync(nativeHome, { mode: 0o700 });
    const runtimeEnvironment = Object.freeze({ runtime, runtimeAccountId: account,
      kind: managed ? "shoggoth-managed" : "native-user", installationKind: managed ? "bundled" : "system",
      homeKind: managed ? "managed-shared" : "integration", strategy: managed ? "managed-shared" : "account-integration",
      home, nativeHome, integrationRoot: managed ? null : root, binaryPath,
      launchArgs: Object.freeze(managed ? ["app-server", "--stdio"] : []),
      spawnEnv: Object.freeze(managed ? { HOME: userHome, CODEX_HOME: home }
        : runtime === "grok-build" ? { HOME: userHome, GROK_HOME: home } : { HOME: home }),
      configurationMode: managed ? "overlay" : runtime === "grok-build" ? "native" : "integration",
    });
    const host = new Host({ paths: { stateDir, trustedRoot: root }, repoRoot: ROOT,
      runtimeProfileId: "spawn-failure", runtimeAccountId: account, runtimeEnvironment,
      workspace, cwd: workspace, parentEnv: { HOME: userHome, PATH: process.env.PATH }, platform: "linux",
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      probeBinary: async () => ({ version: "0.159.2" }),
      verifyServer: async () => ({ version: "1.2.1", serverPath: binaryPath, harnessPath }),
      mcpGateIssuer: { createMcpServer() { throw new Error("No task or MCP call should start"); } },
      spawnProcess(_command, _args, options) {
        child = spawn(failure === "missing-executable" ? path.join(root, "absent-program") : process.execPath,
          ["-e", ""], { ...options, cwd: failure === "missing-directory" ? path.join(root, "absent-directory") : workspace });
        childClosed = new Promise(resolve => child.once("close", resolve));
        // Do not add an error listener here: that would hide the production bug.
        return child;
      },
    });
    t.after(async () => { await host.stop().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
    await assert.rejects(host.initialize(), { code });
    assert.equal(child.pid, undefined);
    await childClosed;
    assert.equal(child.listenerCount("error"), 0, "retired startup guard must release its listener after physical close");
    assert.equal(host.child, null, "failed spawn must not become an admitted runtime");
  });
}
