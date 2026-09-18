#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  OPENCLAW_UPDATE_PHASES,
  OPENCLAW_UPDATE_STATE_BY_EVENT,
  buildOpenClawUpdaterCommand,
  classifyOpenClawCommandResult,
  classifyOpenClawUpdateStatus,
  OpenClawUpdateController,
  parseOpenClawCommandOutput,
  verifyOpenClawGatewayStatus,
} = require("../app/core/openclaw-self-updater.js");
const { OpenClawBackend } = require("../app/core/openclaw-backend.js");

function output(value, stderr = "") {
  return { stdout: `${JSON.stringify(value, null, 2)}\n`, stderr };
}

function createFakeSpawn(responders, options = {}) {
  const calls = [];
  let nextPid = 90_000;
  const spawnImpl = (cmd, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = options.withoutPid ? undefined : nextPid++;
    child.killCalls = [];
    child.kill = (signal) => child.killCalls.push(signal);
    calls.push({ cmd, args, spawnOptions, child });
    const respond = responders.shift();
    if (!respond) throw new Error(`unexpected fake spawn: ${args.join(" ")}`);
    setImmediate(() => respond(child));
    return child;
  };
  return { spawnImpl, calls, remaining: responders };
}

function closeWithJson(child, value, options = {}) {
  const json = `${JSON.stringify(value)}\n`;
  const splitAt = options.exitBeforeStdoutClose ? Math.max(1, Math.floor(json.length / 2)) : json.length;
  child.stdout.emit("data", json.slice(0, splitAt));
  if (options.stderr) child.stderr.emit("data", options.stderr);
  child.emit("exit", options.exitCode ?? 0, options.signal ?? null);
  if (splitAt < json.length) child.stdout.emit("data", json.slice(splitAt));
  child.emit("close", options.exitCode ?? 0, options.signal ?? null);
}

function closeWithText(child, stdout, options = {}) {
  child.stdout.emit("data", stdout);
  if (options.stderr) child.stderr.emit("data", options.stderr);
  child.emit("exit", options.exitCode ?? 0, options.signal ?? null);
  child.emit("close", options.exitCode ?? 0, options.signal ?? null);
}

async function waitForController(controller, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (controller.status().running) {
    if (Date.now() >= deadline) throw new Error("OpenClawUpdateController did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return controller.status();
}

const UPDATE_OK = {
  status: "ok",
  mode: "npm",
  after: { version: "2026.8.1" },
  steps: [],
  durationMs: 10,
  postUpdate: { plugins: { status: "ok", warnings: [], npm: { outcomes: [] } } },
};
const GATEWAY_OK = {
  cli: { version: "2026.8.1" },
  gateway: { version: "2026.8.1" },
  rpc: { ok: true, server: { version: "2026.8.1" }, version: "2026.8.1" },
};
const GATEWAY_OLD = {
  cli: { version: "2026.8.1" },
  gateway: { version: "2026.7.1-2" },
  rpc: { ok: true, server: { version: "2026.7.1-2" }, version: "2026.7.1-2" },
};
const GATEWAY_PLUGIN_DRIFT = {
  ...GATEWAY_OK,
  pluginVersionDrift: {
    detected: true,
    drifts: [{
      pluginId: "brave",
      installedVersion: "2026.7.1",
      gatewayVersion: "2026.8.1",
      installPath: "/private/plugin/path-must-not-persist",
    }],
  },
};
const GATEWAY_DOWN = {
  cli: { version: "2026.8.1" },
  gateway: { version: null },
  rpc: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:18792" },
};
const DOCTOR_OK = { probesRun: ["plugin.manifest_drift"], findings: [] };
const UPDATE_STATUS_CURRENT = {
  update: {
    root: "/opt/homebrew/lib/node_modules/openclaw",
    installKind: "package",
    registry: { latestVersion: "2026.8.1", tag: "latest" },
  },
  availability: {
    available: false,
    hasGitUpdate: false,
    hasRegistryUpdate: false,
    latestVersion: null,
    gitBehind: null,
  },
};
const UPDATE_STATUS_AVAILABLE = {
  update: {
    root: "/opt/homebrew/lib/node_modules/openclaw",
    installKind: "package",
    registry: { latestVersion: "2026.8.2", tag: "latest" },
  },
  availability: {
    available: true,
    hasGitUpdate: false,
    hasRegistryUpdate: true,
    latestVersion: "2026.8.2",
    gitBehind: null,
  },
};

// Official 8.1 automation commands. Capability widening is never accepted
// implicitly; a later user-approved retry must opt in explicitly.
{
  assert.deepEqual(buildOpenClawUpdaterCommand("update"), {
    cmd: "openclaw",
    args: ["update", "--yes", "--json"],
  });
  assert.deepEqual(buildOpenClawUpdaterCommand("repair"), {
    cmd: "openclaw",
    args: ["update", "repair", "--yes", "--json"],
  });
  assert.deepEqual(buildOpenClawUpdaterCommand("update_status"), {
    cmd: "openclaw",
    args: ["update", "status", "--json"],
  });
  assert.deepEqual(buildOpenClawUpdaterCommand("doctor"), {
    cmd: "openclaw",
    args: ["doctor", "--post-upgrade", "--json"],
  });
  assert.deepEqual(buildOpenClawUpdaterCommand("gateway_status"), {
    cmd: "openclaw",
    args: ["gateway", "status", "--json", "--require-rpc"],
  });
  assert.deepEqual(buildOpenClawUpdaterCommand("gateway_status", { gatewayUrl: "ws://127.0.0.1:18792" }), {
    cmd: "openclaw",
    args: ["gateway", "status", "--json", "--require-rpc", "--url", "ws://127.0.0.1:18792"],
  });
  for (const operation of ["update", "repair", "update_status", "doctor", "gateway_status"]) {
    assert.equal(buildOpenClawUpdaterCommand(operation).args.includes("--accept-capabilities"), false);
  }
  assert.equal(
    buildOpenClawUpdaterCommand("repair", { acceptCapabilities: true }).args.includes("--accept-capabilities"),
    true,
  );
}

// Recovery uses the documented 8.1 status envelope. A registry-backed package
// with no available update is current; an available update remains pending.
{
  const current = classifyOpenClawUpdateStatus({ exitCode: 0, ...output(UPDATE_STATUS_CURRENT) });
  assert.equal(current.status, "current");
  assert.equal(current.expectedVersion, undefined);

  const available = classifyOpenClawUpdateStatus({ exitCode: 0, ...output(UPDATE_STATUS_AVAILABLE) });
  assert.equal(available.status, "available");
  assert.equal(available.expectedVersion, "2026.8.2");

  const inconclusive = classifyOpenClawUpdateStatus({ exitCode: 0, ...output({ availability: {} }) });
  assert.equal(inconclusive.status, "unavailable");
  assert.equal(inconclusive.reason, "invalid_update_status");
}

// Every approved phase has an explicit event mapping.
{
  assert.deepEqual(new Set(Object.values(OPENCLAW_UPDATE_STATE_BY_EVENT)), new Set(OPENCLAW_UPDATE_PHASES));
}

// JSON comes only from stdout. Stderr remains a separate progress tail even if
// it happens to contain JSON-looking text.
{
  const parsed = parseOpenClawCommandOutput(output(
    { status: "ok" },
    "installing...\n{\"status\":\"error\"}\n",
  ));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.status, "ok");
  assert.match(parsed.progressTail, /installing/);
}

// Successful core + plugin finalization waits for restart/version verification.
{
  const state = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 0,
    ...output({
      status: "ok",
      mode: "npm",
      after: { version: "2026.8.1" },
      steps: [],
      durationMs: 10,
      postUpdate: { plugins: { status: "ok", warnings: [], npm: { outcomes: [] } } },
    }),
  });
  assert.equal(state.phase, "restart_pending");
  assert.equal(state.expectedVersion, "2026.8.1");
}

// A plugin finalization warning is not presented as a completed update.
{
  const state = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 0,
    ...output({
      status: "ok",
      mode: "npm",
      after: { version: "2026.8.1" },
      steps: [],
      durationMs: 10,
      postUpdate: {
        plugins: {
          status: "warning",
          warnings: [{ pluginId: "example", reason: "plugin finalization incomplete" }],
          npm: { outcomes: [] },
        },
      },
    }),
  });
  assert.equal(state.phase, "repair_required");
  assert.equal(state.reason, "plugin_finalization_warning");
}

// Structured capability consent outranks the generic plugin error. The app must
// stop for review instead of retrying with --accept-capabilities.
{
  const state = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 1,
    ...output({
      status: "error",
      mode: "npm",
      reason: "post-update-plugins",
      after: { version: "2026.8.1" },
      steps: [],
      durationMs: 10,
      postUpdate: {
        plugins: {
          status: "error",
          warnings: [],
          npm: {
            outcomes: [{
              pluginId: "calendar",
              status: "error",
              code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
              message: "Plugin requires capability consent",
            }],
          },
        },
      },
    }),
  });
  assert.equal(state.phase, "capability_review_required");
  assert.deepEqual(state.capabilityReviews, [{
    pluginId: "calendar",
    message: "Plugin requires capability consent",
  }]);
}

// A repair command that itself fails is terminal for that attempt.
{
  const state = classifyOpenClawCommandResult({
    operation: "repair",
    exitCode: 1,
    ...output({
      status: "error",
      mode: "finalize",
      reason: "post-plugin-doctor-execution-failed",
      phaseTimings: [],
      postUpdate: { doctor: { status: "ok" }, plugins: { status: "error" } },
    }),
  });
  assert.equal(state.phase, "failed");
  assert.equal(state.reason, "repair_failed");
}

// Managed-service handoff is still finalizing. Restart-health pending has moved
// one phase further but is not yet verified.
{
  const handoff = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 0,
    ...output({
      status: "skipped",
      mode: "npm",
      reason: "managed-service-handoff-started",
      steps: [],
      durationMs: 10,
    }),
  });
  assert.equal(handoff.phase, "finalizing");
  assert.equal(handoff.reason, "managed_service_handoff");

  const restart = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 0,
    ...output({
      status: "skipped",
      mode: "npm",
      reason: "restart-health-pending",
      after: { version: "2026.8.1" },
      steps: [],
      durationMs: 10,
    }),
  });
  assert.equal(restart.phase, "restart_pending");
}

// Gateway verification trusts the RPC-loaded version, not only the CLI package.
{
  const mismatch = verifyOpenClawGatewayStatus({
    exitCode: 0,
    expectedVersion: "2026.8.1",
    ...output({
      cli: { version: "2026.8.1" },
      gateway: { version: "2026.7.1-2" },
      rpc: { ok: true, server: { version: "2026.7.1-2" }, version: "2026.7.1-2" },
    }),
  });
  assert.equal(mismatch.phase, "restart_pending");
  assert.equal(mismatch.reason, "loaded_version_mismatch");
  assert.equal(mismatch.loadedVersion, "2026.7.1-2");

  const verified = verifyOpenClawGatewayStatus({
    exitCode: 0,
    expectedVersion: "2026.8.1",
    ...output({
      cli: { version: "2026.8.1" },
      gateway: { version: "2026.8.1" },
      rpc: { ok: true, server: { version: "2026.8.1" }, version: "2026.8.1" },
    }),
  });
  assert.equal(verified.phase, "completed");

  const pluginDrift = verifyOpenClawGatewayStatus({
    exitCode: 0,
    expectedVersion: "2026.8.1",
    ...output(GATEWAY_PLUGIN_DRIFT),
  });
  assert.equal(pluginDrift.phase, "finalizing");
  assert.equal(pluginDrift.reason, "plugin_version_drift");
  assert.deepEqual(pluginDrift.pluginVersionDrift, [{
    pluginId: "brave",
    installedVersion: "2026.7.1",
    gatewayVersion: "2026.8.1",
  }]);
}

// Post-upgrade doctor findings require repair; malformed stdout fails closed.
{
  const doctor = classifyOpenClawCommandResult({
    operation: "doctor",
    exitCode: 0,
    ...output({ probesRun: ["plugin.manifest_drift"], findings: [{ code: "plugin.manifest_drift" }] }),
  });
  assert.equal(doctor.phase, "repair_required");
  assert.equal(doctor.reason, "doctor_findings");

  const malformed = classifyOpenClawCommandResult({
    operation: "update",
    exitCode: 0,
    stdout: "not json",
    stderr: "progress only",
  });
  assert.equal(malformed.phase, "failed");
  assert.equal(malformed.reason, "invalid_json_stdout");
}

// Controller waits for `close`, so JSON bytes delivered after `exit` are not
// lost. Public and persisted state retain only the bounded stderr progress,
// never the raw machine result/stdout/stderr.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-updater-success-"));
  const statePath = path.join(tmpDir, "state.json");
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, { ...UPDATE_OK, privateProbe: "must-not-persist" }, {
      stderr: "update progress\n",
      exitBeforeStdoutClose: true,
    }),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK, { stderr: "doctor progress\n" }),
  ]);
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    statePath,
    getGatewayUrl: () => "ws://127.0.0.1:18792",
    verifyPollMs: 0,
  });
  const started = controller.run();
  assert.equal(started.running, true);
  const state = await waitForController(controller);
  assert.equal(state.phase, "completed");
  assert.equal(state.operation, "update");
  assert.equal(state.ok, true);
  assert.equal("result" in state, false);
  assert.equal("stdout" in state, false);
  assert.equal("stderr" in state, false);
  assert.match(state.progressTail, /doctor progress/);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls[0].spawnOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(fake.calls[0].spawnOptions.detached, true);
  assert.deepEqual(fake.calls[1].args.slice(-2), ["--url", "ws://127.0.0.1:18792"]);
  const persisted = fs.readFileSync(statePath, "utf8");
  assert.equal(persisted.includes("must-not-persist"), false);
  assert.equal(persisted.includes('"result"'), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// A completed package update can replace its own CLI and still leave mixed
// stdout. The controller recovers from the documented read-only status instead
// of reporting a false failure, while an update that remains available keeps
// the original malformed-output failure.
{
  const recoveredFake = createFakeSpawn([
    (child) => closeWithText(child, "Updating OpenClaw...\n{\"status\":\"ok\"}\n"),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const recoveredController = new OpenClawUpdateController({
    spawnImpl: recoveredFake.spawnImpl,
    verifyPollMs: 0,
  });
  recoveredController.run();
  const recovered = await waitForController(recoveredController);
  assert.equal(recovered.phase, "completed");
  assert.equal(recovered.ok, true);
  assert.equal(typeof recovered.recoveryAttemptedAt, "number");
  assert.deepEqual(recoveredFake.calls[1].args, ["update", "status", "--json"]);

  const pendingFake = createFakeSpawn([
    (child) => closeWithText(child, "not json"),
    (child) => closeWithJson(child, UPDATE_STATUS_AVAILABLE),
  ]);
  const pendingController = new OpenClawUpdateController({ spawnImpl: pendingFake.spawnImpl });
  pendingController.run();
  const pending = await waitForController(pendingController);
  assert.equal(pending.phase, "failed");
  assert.equal(pending.reason, "invalid_json_stdout");
  assert.equal(pending.ok, false);
  assert.equal(pendingFake.calls.length, 2);
}

// Once the package is current, a gateway that did not return is actionable
// repair work rather than a dead-end generic failure.
{
  const fake = createFakeSpawn([
    (child) => closeWithText(child, "not json"),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, GATEWAY_DOWN, { exitCode: 1 }),
  ]);
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    verifyTimeoutMs: 0,
  });
  controller.run();
  const state = await waitForController(controller);
  assert.equal(state.phase, "repair_required");
  assert.equal(state.reason, "gateway_verification_failed");
  assert.equal(state.ok, false);
  assert.equal(fake.calls.length, 3);
}

// Existing persisted false failures self-heal on the first status poll after
// upgrading Shoggoth, so users do not have to delete the state file manually.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-updater-malformed-recovery-"));
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    running: false,
    phase: "failed",
    operation: "update",
    reason: "invalid_json_stdout",
    ok: false,
    finishedAt: 1,
  }));
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const controller = new OpenClawUpdateController({
    statePath,
    spawnImpl: fake.spawnImpl,
    verifyPollMs: 0,
  });
  assert.equal(controller.status().running, true);
  const state = await waitForController(controller);
  assert.equal(state.phase, "completed");
  assert.equal(state.ok, true);
  assert.equal(fake.calls.length, 3);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Gateway polling tolerates a temporarily loaded old daemon and completes once
// RPC reports the installed version.
{
  let sleeps = 0;
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_OK),
    (child) => closeWithJson(child, GATEWAY_OLD),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    sleep: async () => { sleeps += 1; },
    verifyTimeoutMs: 1000,
    verifyPollMs: 1,
  });
  controller.run();
  const state = await waitForController(controller);
  assert.equal(state.phase, "completed");
  assert.equal(sleeps, 1);
  assert.equal(fake.calls.filter((call) => call.args[0] === "gateway").length, 2);
}

// A managed-service handoff is only an acknowledgement. Keep the controller
// running until official update status is current and 9.1 plugin drift has
// converged; do not run Doctor against the old/mixed helper generation.
{
  let sleeps = 0;
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, {
      status: "skipped",
      mode: "npm",
      reason: "managed-service-handoff-started",
      steps: [],
      durationMs: 10,
    }),
    (child) => closeWithJson(child, UPDATE_STATUS_AVAILABLE),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, GATEWAY_PLUGIN_DRIFT),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    sleep: async () => { sleeps += 1; },
    recoveryPollMs: 1,
    verifyPollMs: 1,
  });
  controller.run();
  assert.equal(controller.run().running, true, "handoff 收敛期间必须拒绝并发更新");
  const state = await waitForController(controller);
  assert.equal(state.phase, "completed");
  assert.equal(state.ok, true);
  assert.equal(state.pluginVersionDrift, undefined);
  assert.equal(fake.calls.filter((call) => call.args[0] === "update" && call.args[1] === "status").length, 2);
  assert.equal(fake.calls.filter((call) => call.args[0] === "gateway").length, 2);
  assert.equal(fake.calls.filter((call) => call.args[0] === "doctor").length, 1);
  assert.ok(sleeps >= 2);
}

// A persistent loaded-version mismatch becomes actionable repair work and keeps
// the requested top-level operation instead of leaking gateway_status.
{
  let now = 0;
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_OK),
    (child) => closeWithJson(child, GATEWAY_OLD),
    (child) => closeWithJson(child, GATEWAY_OLD),
    (child) => closeWithJson(child, GATEWAY_OLD),
  ]);
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    verifyTimeoutMs: 2,
    verifyPollMs: 1,
  });
  controller.run();
  const state = await waitForController(controller);
  assert.equal(state.phase, "repair_required");
  assert.equal(state.reason, "loaded_version_mismatch");
  assert.equal(state.operation, "update");
  assert.equal(state.ok, false);
  assert.equal("result" in state, false);
}

// Repair with explicit capability approval forwards the switch only to repair;
// successful verification still reports the requested repair operation.
{
  const repairOk = {
    status: "ok",
    mode: "finalize",
    phaseTimings: [],
    postUpdate: { doctor: { status: "ok" }, plugins: { status: "ok", warnings: [] } },
  };
  const fake = createFakeSpawn([
    (child) => closeWithJson(child, repairOk),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const controller = new OpenClawUpdateController({ spawnImpl: fake.spawnImpl, verifyPollMs: 0 });
  controller.run({ operation: "repair", acceptCapabilities: true });
  const state = await waitForController(controller);
  assert.equal(state.phase, "completed");
  assert.equal(state.operation, "repair");
  assert.equal(fake.calls[0].args.includes("--accept-capabilities"), true);
  assert.equal(fake.calls[1].args.includes("--accept-capabilities"), false);
  assert.equal(fake.calls[2].args.includes("--accept-capabilities"), false);
}

// Capability review stops before gateway/doctor, while doctor findings retain
// the original update operation in public state.
{
  const capability = {
    ...UPDATE_OK,
    status: "error",
    reason: "post-update-plugins",
    postUpdate: {
      plugins: {
        status: "error",
        warnings: [],
        npm: { outcomes: [{ pluginId: "calendar", code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" }] },
      },
    },
  };
  const capFake = createFakeSpawn([(child) => closeWithJson(child, capability, { exitCode: 1 })]);
  const capController = new OpenClawUpdateController({ spawnImpl: capFake.spawnImpl });
  capController.run();
  const capState = await waitForController(capController);
  assert.equal(capState.phase, "capability_review_required");
  assert.equal(capState.operation, "update");
  assert.equal(capFake.calls.length, 1);
  assert.equal("result" in capState, false);

  const doctorFake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_OK),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, {
      probesRun: ["plugin.manifest_drift"],
      findings: [{ code: "plugin.manifest_drift" }],
    }),
  ]);
  const doctorController = new OpenClawUpdateController({ spawnImpl: doctorFake.spawnImpl });
  doctorController.run();
  const doctorState = await waitForController(doctorController);
  assert.equal(doctorState.phase, "repair_required");
  assert.equal(doctorState.operation, "update");
}

// Timeout settles even when kill produces no close event; the controller must
// not remain running forever.
{
  const fake = createFakeSpawn([() => {}], { withoutPid: true });
  const controller = new OpenClawUpdateController({
    spawnImpl: fake.spawnImpl,
    commandTimeoutMs: 5,
  });
  controller.run();
  assert.equal(controller.run().running, true);
  assert.equal(fake.calls.length, 1);
  const state = await waitForController(controller);
  assert.equal(state.phase, "failed");
  assert.equal(state.reason, "command_failed");
  assert.equal(state.error, "command_timeout");
  assert.deepEqual(fake.calls[0].child.killCalls, ["SIGKILL"]);
}

// Recovery starts lazily from status(), consults official status even after a
// dead PID, and resumes gateway/doctor verification when 8.1 is already current.
// Legacy private output is never exposed or re-persisted.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-updater-recovery-"));
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    running: true,
    phase: "updating",
    pid: 41_001,
    operation: "update",
    result: { secret: "legacy-private-result" },
    stdout: "legacy stdout",
    stderr: "legacy stderr",
  }));
  const completedFake = createFakeSpawn([
    (child) => closeWithJson(child, {
      ...UPDATE_STATUS_AVAILABLE,
      update: {
        ...UPDATE_STATUS_AVAILABLE.update,
        registry: { latestVersion: "2026.8.1", tag: "latest" },
      },
      availability: {
        ...UPDATE_STATUS_AVAILABLE.availability,
        latestVersion: "2026.8.1",
      },
    }),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT, { stderr: "proxy progress\n" }),
    (child) => closeWithJson(child, GATEWAY_OK),
    (child) => closeWithJson(child, DOCTOR_OK),
  ]);
  const recoveredController = new OpenClawUpdateController({
    statePath,
    spawnImpl: completedFake.spawnImpl,
    processAliveImpl: () => false,
    recoveryPollMs: 0,
    verifyPollMs: 0,
  });
  assert.equal(completedFake.calls.length, 0);
  const recovering = recoveredController.status();
  assert.equal(recovering.running, true);
  assert.equal("result" in recovering, false);
  assert.equal("stdout" in recovering, false);
  assert.equal("stderr" in recovering, false);
  const recovered = await waitForController(recoveredController);
  assert.equal(recovered.running, false);
  assert.equal(recovered.phase, "completed");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.interrupted, undefined);
  assert.deepEqual(completedFake.calls[0].args, ["update", "status", "--json"]);
  assert.deepEqual(completedFake.calls[1].args, ["update", "status", "--json"]);
  assert.equal(fs.readFileSync(statePath, "utf8").includes("legacy-private-result"), false);

  // If official status still advertises the target after the owner exited, the
  // attempt is genuinely interrupted rather than silently treated as current.
  fs.writeFileSync(statePath, JSON.stringify({
    running: true,
    phase: "updating",
    pid: 41_002,
    operation: "update",
  }));
  let interruptedNow = 0;
  const interruptedFake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_STATUS_AVAILABLE),
    (child) => closeWithJson(child, UPDATE_STATUS_AVAILABLE),
    (child) => closeWithJson(child, UPDATE_STATUS_AVAILABLE),
  ]);
  const interruptedController = new OpenClawUpdateController({
    statePath,
    spawnImpl: interruptedFake.spawnImpl,
    processAliveImpl: () => false,
    now: () => interruptedNow,
    sleep: async (ms) => { interruptedNow += ms; },
    recoveryTimeoutMs: 2,
    recoveryPollMs: 1,
  });
  interruptedController.status();
  const interrupted = await waitForController(interruptedController);
  assert.equal(interrupted.running, false);
  assert.equal(interrupted.phase, "failed");
  assert.equal(interrupted.reason, "update_interrupted");
  assert.equal(interrupted.finishedAt, 2);
  assert.equal(interruptedFake.calls.length, 3);

  // A live (or PID-reused) process cannot pin the app in running forever. The
  // persisted recovery deadline survives subsequent status() polling.
  fs.writeFileSync(statePath, JSON.stringify({
    running: true,
    phase: "updating",
    pid: 41_003,
    operation: "update",
    startedAt: 0,
  }));
  let now = 0;
  const liveFake = createFakeSpawn([
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
    (child) => closeWithJson(child, UPDATE_STATUS_CURRENT),
  ]);
  const liveController = new OpenClawUpdateController({
    statePath,
    spawnImpl: liveFake.spawnImpl,
    processAliveImpl: () => true,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    recoveryTimeoutMs: 2,
    recoveryPollMs: 1,
  });
  liveController.status();
  const timedOut = await waitForController(liveController);
  assert.equal(timedOut.running, false);
  assert.equal(timedOut.phase, "failed");
  assert.equal(timedOut.reason, "update_recovery_timeout");
  assert.equal(liveFake.calls.length, 3);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Backend contract exposes only the two 8.1 actions and forwards capability
// consent as an explicit boolean. Remote gateways remain read-only.
{
  const calls = [];
  const backend = new OpenClawBackend({ getUpstreamUrl: () => "ws://127.0.0.1:18792" });
  backend._selfUpdater = {
    run: (options) => {
      calls.push(options);
      return { running: true, phase: "finalizing", operation: options.operation };
    },
    status: () => ({ running: false, phase: "repair_required", operation: "update" }),
  };
  const started = backend.runSelfUpdate({ action: "repair", acceptCapabilities: true });
  assert.deepEqual(calls, [{ operation: "repair", acceptCapabilities: true }]);
  assert.deepEqual(started.actions, ["update", "repair"]);
  assert.equal(started.status.operation, "repair");
  assert.deepEqual(backend.getSelfUpdateStatus().actions, ["update", "repair"]);

  const remote = new OpenClawBackend({ getUpstreamUrl: () => "wss://gateway.example.test" });
  remote._selfUpdater = backend._selfUpdater;
  assert.deepEqual(remote.runSelfUpdate(), { supported: false, reason: "remote" });
}

console.log("OpenClaw self-updater unit: PASS");
