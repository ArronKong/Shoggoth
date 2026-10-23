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
const acpServer = path.join(root, "agy_acp_server.par");
const harness = path.join(root, "localharness_external");
const bootstrap = path.join(root, "app.asar", "app", "bootstrap.js");
const runtimeAccountId = "runtime-account-fixture";
fs.writeFileSync(helper, "helper\n", { mode: 0o700 });
fs.writeFileSync(grok, "grok\n", { mode: 0o700 });
fs.writeFileSync(acpServer, "server\n", { mode: 0o700 });
fs.writeFileSync(harness, "harness\n", { mode: 0o700 });
// pid -> { ppid, executable } as observed by the Service for harness-child tickets.
const processLinks = new Map();
let ancestorIdentity = "stable-ancestor-9600";
fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
fs.writeFileSync(bootstrap, "bootstrap\n", { mode: 0o600 });

let timerCallback = null;
let clockNow = 10_000;
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
  now: () => clockNow,
  randomBytes: () => Buffer.alloc(32, ++nonceByte),
  getProcessIdentity: (pid) => pid === 9527 ? "stable-parent-9527" : pid === 9600 ? ancestorIdentity : "",
  getProcessLink: (pid) => processLinks.get(pid) || { ppid: 0, executable: "" },
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
    executionRunId: "execution-bound-only-in-service-memory",
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
  assert.equal(fs.readFileSync(reservationGatePath, "utf8").includes("execution-bound-only-in-service-memory"), false);
  assert.equal(JSON.stringify(reservation).includes("execution-bound-only-in-service-memory"), false);
  assert.deepEqual(issuer.consume({
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId,
    gatePath: reservationGatePath,
    nonce: reservationEnv.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
    parentPid: 9527,
    executionRunId: "forged-bridge-run",
  }), { consumed: true, executionRunId: "execution-bound-only-in-service-memory" });

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

  // Harness-child (v3): the ACP server (ancestor) delegates MCP launch to its harness.
  const harnessTicket = () => {
    const created = issuer.createMcpServer({
      runtimeProfileId: "runtime-antigravity",
      runtimeAccountId,
      parentExecutable: harness,
      ancestorExecutable: acpServer,
      ancestorPid: 9600,
    });
    return { created, env: Object.fromEntries(created.env.map(({ name, value }) => [name, value])) };
  };
  const harnessRuntime = (overrides = {}) => ({
    defaultApp: true,
    ppid: 9700,
    now: () => 10_001,
    userInfo: () => ({ homedir: root }),
    parent: { executable: fs.realpathSync(harness), command: harness, ppid: 9600 },
    ancestor: { executable: fs.realpathSync(acpServer) },
    ...overrides,
  });
  const v3 = harnessTicket();
  const v3Gate = JSON.parse(fs.readFileSync(v3.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, "utf8"));
  assert.equal(v3Gate.schemaVersion, 3);
  assert.equal(v3Gate.parentPid, null);
  assert.equal(v3Gate.ancestorPid, 9600);
  assert.equal(v3Gate.parentExecutable, fs.realpathSync(harness));
  assert.equal(v3Gate.ancestorExecutable, fs.realpathSync(acpServer));
  assert.equal(resolveRole(v3.created.args, v3.env, harnessRuntime()), "mcp");
  assert.throws(() => resolveRole(v3.created.args, v3.env, harnessRuntime({
    parent: { executable: fs.realpathSync(harness), command: harness, ppid: 9601 },
  })), "a harness under a different runtime process must be rejected");
  assert.throws(() => resolveRole(v3.created.args, v3.env, harnessRuntime({
    parent: { executable: fs.realpathSync(grok), command: grok, ppid: 9600 },
  })), "only the pinned harness executable may launch the helper");
  assert.throws(() => resolveRole(v3.created.args, v3.env, harnessRuntime({
    ancestor: { executable: fs.realpathSync(grok) },
  })), "the ancestor must be the bound ACP server executable");
  const consumeV3 = (ticket, parentPid = 9700) => issuer.consume({
    runtimeProfileId: "runtime-antigravity",
    runtimeAccountId,
    gatePath: ticket.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE,
    nonce: ticket.env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE,
    parentPid,
  });
  processLinks.set(9700, { ppid: 9601, executable: fs.realpathSync(harness) });
  assert.throws(() => consumeV3(v3), "Service must reject a harness under another process");
  processLinks.set(9700, { ppid: 9600, executable: fs.realpathSync(grok) });
  assert.throws(() => consumeV3(v3), "Service must reject a non-harness parent");
  processLinks.set(9700, { ppid: 9600, executable: fs.realpathSync(harness) });
  ancestorIdentity = "restarted-ancestor";
  assert.throws(() => consumeV3(v3), "Service must reject a recycled ancestor PID");
  ancestorIdentity = "stable-ancestor-9600";
  assert.deepEqual(consumeV3(v3), { consumed: true });
  assert.throws(() => consumeV3(v3), "harness-child tickets remain one-shot");
  const mixedReservation = issuer.reserveMcpServer({
    runtimeProfileId: "runtime-antigravity", runtimeAccountId,
    parentExecutable: harness, ancestorExecutable: acpServer,
  });
  assert.throws(() => issuer.bindMcpServer({ reservationId: mixedReservation.reservationId, parentPid: 9600 }),
    "a harness-child reservation cannot be bound as a direct-parent ticket");
  issuer.revokeMcpServer({ reservationId: mixedReservation.reservationId });
  const directReservation = issuer.reserveMcpServer({
    runtimeProfileId: "runtime-grok", runtimeAccountId, parentExecutable: grok,
  });
  assert.throws(() => issuer.bindMcpServer({ reservationId: directReservation.reservationId, ancestorPid: 9527 }),
    "a direct-parent reservation cannot be bound through an ancestor");
  issuer.revokeMcpServer({ reservationId: directReservation.reservationId });

  // The harness starts the helper at the first prompt, which may come after a
  // slow session/new: an unused harness-child ticket lapses and can be renewed.
  const lazy = harnessTicket();
  assert.match(lazy.created.reservationId, /^[a-f0-9]{64}$/u);
  assert.equal(descriptor.reservationId, undefined, "direct-parent descriptors carry no renewal handle");
  const lazyGate = lazy.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE;
  clockNow = 60_000;
  timerCallback();
  assert.equal(fs.existsSync(lazyGate), false, "a lapsed ticket leaves no file");
  assert.throws(() => consumeV3(lazy), "a lapsed ticket cannot be consumed");
  assert.deepEqual(issuer.renewMcpServer({ reservationId: lazy.created.reservationId }), { renewed: true });
  assert.equal(JSON.parse(fs.readFileSync(lazyGate, "utf8")).expiresAt, 60_000 + 45_000);
  assert.equal(fs.lstatSync(lazyGate).mode & 0o777, 0o600);
  assert.equal(resolveRole(lazy.created.args, lazy.env, harnessRuntime({ now: () => 60_001 })), "mcp");
  assert.deepEqual(consumeV3(lazy), { consumed: true });
  assert.deepEqual(issuer.renewMcpServer({ reservationId: lazy.created.reservationId }), { renewed: false, consumed: true },
    "a consumed ticket is never renewed");
  const direct = issuer.createMcpServer({
    runtimeProfileId: "runtime-grok", runtimeAccountId, parentPid: 9527, parentExecutable: grok,
  });
  const directNonce = direct.env.find(({ name }) => name === "SHOGGOTH_RUNTIME_MCP_GATE_NONCE").value;
  assert.deepEqual(issuer.renewMcpServer({ reservationId: directNonce }), { renewed: false },
    "direct-parent tickets keep their fixed TTL");
  const stale = harnessTicket();
  clockNow = 60_000 + 10 * 60_000;
  assert.throws(() => issuer.renewMcpServer({ reservationId: stale.created.reservationId }),
    { code: "RUNTIME_MCP_GATE_EXPIRED" });
  assert.equal(fs.existsSync(stale.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE), false,
    "the renewal window closes the reservation and removes its file");
  console.log("PASS runtime MCP one-shot gate issuer");
} finally {
  issuer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
