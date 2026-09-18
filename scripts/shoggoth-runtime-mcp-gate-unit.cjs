#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main, resolveRole } = require("../app/bootstrap-role");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-mcp-gate-"));
const paths = resolveServicePaths({ homeDir: root });
const helper = path.join(root, "Shoggoth");
const grok = path.join(root, "grok");
const bootstrap = path.join(root, "app.asar", "app", "bootstrap.js");
const runtimeAccountId = "runtime-account-fixture";
fs.writeFileSync(helper, "helper\n", { mode: 0o700 });
fs.writeFileSync(grok, "grok\n", { mode: 0o700 });
fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
fs.writeFileSync(bootstrap, "bootstrap\n", { mode: 0o600 });

let timerCallback = null;
let nonceByte = 0xaa;
let forcedUnlinkPath = null;
const diagnostics = [];
const gateFs = Object.create(fs);
gateFs.unlinkSync = (target) => {
  if (target === forcedUnlinkPath) {
    const error = new Error("injected expiry unlink failure");
    error.code = "EIO";
    throw error;
  }
  return fs.unlinkSync(target);
};
const issuer = new RuntimeMcpGateIssuer({
  paths,
  fs: gateFs,
  mcpHelperLaunch: { command: helper, argsPrefix: ["/Applications/Shoggoth.app"] },
  bootstrapPath: bootstrap,
  now: () => 10_000,
  randomBytes: () => Buffer.alloc(32, ++nonceByte),
  getProcessIdentity: (pid) => pid === 9527 ? "stable-parent-9527" : "",
  setTimeout(callback) { timerCallback = callback; return { unref() {} }; },
  clearTimeout() {},
  onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
}).open();

(async () => {
try {
  const reservation = issuer.reserveMcpServer({
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId,
    parentExecutable: grok,
  });
  const reservationEnv = Object.fromEntries(
    reservation.env.map(({ name, value }) => [name, value]),
  );
  const reservationGatePath = reservationEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  assert.equal(fs.existsSync(reservationGatePath), false,
    "reserve must not publish a usable gate before the child PID is known");
  assert.throws(() => issuer.consume({
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId,
    gatePath: reservationGatePath,
    nonce: reservationEnv.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
    parentPid: 9527,
  }));
  issuer.bindMcpServer({ reservationId: reservation.reservationId, parentPid: 9527 });
  assert.equal(fs.existsSync(reservationGatePath), true);
  assert.deepEqual(issuer.consume({
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId,
    gatePath: reservationGatePath,
    nonce: reservationEnv.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
    parentPid: 9527,
  }), { consumed: true });

  const descriptor = issuer.createMcpServer({
    runtime: "grok-build",
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    parentPid: 9527,
    parentExecutable: grok,
    operation: "session.start",
    cwd: root,
  });
  assert.equal(descriptor.name, "shoggoth");
  assert.equal(descriptor.command, fs.realpathSync(helper));
  assert.deepEqual(descriptor.args, [
    bootstrap,
    "--shoggoth-internal-role=mcp",
    "--shoggoth-runtime-profile=runtime-grok",
    `--shoggoth-runtime-account=${runtimeAccountId}`,
  ]);
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  const gatePath = env.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  assert.equal(path.dirname(gatePath), path.join(paths.runtimeDir, "mcp-gates"));
  assert.equal(fs.lstatSync(gatePath).mode & 0o777, 0o600);
  assert.equal(resolveRole(descriptor.args, env, {
    defaultApp: true,
    ppid: 9527,
    now: () => 10_001,
    userInfo: () => ({ homedir: root }),
    parent: { executable: fs.realpathSync(grok), command: `${grok} agent --no-leader stdio` },
  }), "mcp");
  assert.equal(fs.existsSync(gatePath), true, "bootstrap validation must remain read-only");
  const expectedBridge = Object.freeze({
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    socket: Object.freeze({ tag: "service.sock" }),
  });
  let dispatchedBridge = null;
  const runtime = {
    defaultApp: true,
    ppid: 9527,
    now: () => 10_001,
    userInfo: () => ({ homedir: root }),
    parent: { executable: fs.realpathSync(grok), command: `${grok} agent --no-leader stdio` },
    openRuntimeMcpBridge: async (context) => {
      assert.equal(context.runtimeProfileId, "runtime-grok");
      assert.equal(context.runtimeAccountId, runtimeAccountId);
      assert.equal(context.servicePaths.socketPath, paths.socketPath);
      issuer.consume({
        runtimeProfileId: context.runtimeProfileId,
        runtimeAccountId: context.runtimeAccountId,
        gatePath: context.gatePath,
        nonce: context.nonce,
        parentPid: context.parentPid,
      });
      return expectedBridge;
    },
  };
  await main(descriptor.args, env, runtime, {
    runtimeMcpRelay(bridge) { dispatchedBridge = bridge; return "started"; },
  });
  assert.equal(dispatchedBridge, expectedBridge);
  assert.equal(fs.existsSync(gatePath), false, "Service must consume the gate before dispatch");
  assert.equal(env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, undefined);
  assert.equal(env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, undefined);
  assert.throws(() => issuer.consume({
    runtimeProfileId: "runtime-grok", runtimeAccountId, gatePath,
    nonce: "ab".repeat(32), parentPid: 9527,
  }));

  const wrongNodeMode = issuer.createMcpServer({
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    parentPid: 9527,
    parentExecutable: grok,
  });
  const wrongNodeModeEnv = Object.fromEntries(
    wrongNodeMode.env.map(({ name, value }) => [name, value]),
  );
  delete wrongNodeModeEnv.ELECTRON_RUN_AS_NODE;
  assert.throws(() => resolveRole(wrongNodeMode.args, wrongNodeModeEnv, {
    defaultApp: true,
    ppid: 9527,
    now: () => 10_001,
    userInfo: () => ({ homedir: root }),
    parent: { executable: fs.realpathSync(grok), command: `${grok} agent --no-leader stdio` },
  }), "Runtime gate must require ELECTRON_RUN_AS_NODE=1");

  const expiring = issuer.createMcpServer({
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    parentPid: 9527,
    parentExecutable: grok,
  });
  const expiringEnv = Object.fromEntries(expiring.env.map(({ name, value }) => [name, value]));
  assert.equal(fs.existsSync(expiringEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE), true);
  timerCallback();
  assert.equal(fs.existsSync(expiringEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE), false);

  const cleanupFailure = issuer.createMcpServer({
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    parentPid: 9527,
    parentExecutable: grok,
  });
  const cleanupFailureEnv = Object.fromEntries(
    cleanupFailure.env.map(({ name, value }) => [name, value]),
  );
  forcedUnlinkPath = cleanupFailureEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  assert.doesNotThrow(() => timerCallback(), "expiry cleanup errors must not escape the timer");
  assert.deepEqual(diagnostics, [{ code: "RUNTIME_MCP_GATE_CLEANUP_FAILED" }]);
  assert.throws(() => issuer.consume({
    runtimeProfileId: "runtime-grok",
    runtimeAccountId,
    gatePath: cleanupFailureEnv.SHOGGOTH_RUNTIME_MCP_GATE_FILE,
    nonce: cleanupFailureEnv.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
    parentPid: 9527,
  }), "an expiry cleanup failure must still revoke the one-shot ticket");
  forcedUnlinkPath = null;
  assert.throws(() => issuer.createMcpServer({
    runtimeProfileId: "../escape", runtimeAccountId, parentPid: 9527, parentExecutable: grok,
  }));
  assert.throws(() => issuer.createMcpServer({
    runtimeProfileId: "runtime-grok", parentPid: 9527, parentExecutable: grok,
  }), "legacy profile-only gate requests must fail closed");
  console.log("PASS runtime MCP one-shot gate issuer");
} finally {
  issuer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
