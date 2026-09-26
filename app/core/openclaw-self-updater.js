"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROGRESS_TAIL_MAX = 8 * 1024;
const CAPABILITY_CONSENT_CODE = "PLUGIN_CAPABILITY_CONSENT_REQUIRED";
const COMMAND_OUTPUT_MAX = 4 * 1024 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 60 * 1000;
const DEFAULT_VERIFY_POLL_MS = 2500;
const DEFAULT_COMMAND_TIMEOUT_MS = 35 * 60 * 1000;

const OPENCLAW_UPDATE_PHASES = Object.freeze([
  "updating",
  "finalizing",
  "restart_pending",
  "verifying",
  "repair_required",
  "capability_review_required",
  "completed",
  "failed",
]);

// The orchestration layer owns timing/process lifetime. This table keeps its
// user-visible transitions explicit and prevents "command exited 0" from being
// treated as the completed state before plugin/restart verification finishes.
const OPENCLAW_UPDATE_STATE_BY_EVENT = Object.freeze({
  started: "updating",
  handoff_started: "finalizing",
  restart_needed: "restart_pending",
  verification_started: "verifying",
  plugin_repair_needed: "repair_required",
  capability_review_needed: "capability_review_required",
  verified: "completed",
  command_failed: "failed",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Build only the documented OpenClaw 8.1 non-interactive commands. */
function buildOpenClawUpdaterCommand(operation, options = {}) {
  const cmd = nonBlank(options.bin) || "openclaw";
  let args;
  if (operation === "update") args = ["update", "--yes", "--json"];
  else if (operation === "repair") args = ["update", "repair", "--yes", "--json"];
  else if (operation === "update_status") args = ["update", "status", "--json"];
  else if (operation === "doctor") args = ["doctor", "--post-upgrade", "--json"];
  else if (operation === "gateway_status") args = ["gateway", "status", "--json", "--require-rpc"];
  else throw new Error(`unsupported OpenClaw updater operation: ${operation}`);

  // Capability widening always requires a separate, user-approved invocation.
  // The default path deliberately never adds this switch.
  if (options.acceptCapabilities === true) {
    if (operation !== "update" && operation !== "repair") {
      throw new Error("--accept-capabilities is only valid for update or repair");
    }
    args.push("--accept-capabilities");
  }
  const gatewayUrl = nonBlank(options.gatewayUrl);
  if (gatewayUrl) {
    if (operation !== "gateway_status") {
      throw new Error("gatewayUrl is only valid for gateway_status");
    }
    args.push("--url", gatewayUrl);
  }
  return { cmd, args };
}

/** Parse machine output without ever treating stderr progress as JSON. */
function parseOpenClawCommandOutput({ stdout, stderr } = {}) {
  const progressTail = String(stderr || "").slice(-PROGRESS_TAIL_MAX);
  const raw = String(stdout || "").trim();
  if (!raw) return { ok: false, error: "empty_json_stdout", progressTail };
  try {
    const result = JSON.parse(raw);
    if (!isRecord(result)) return { ok: false, error: "invalid_json_stdout", progressTail };
    return { ok: true, result, progressTail };
  } catch {
    return { ok: false, error: "invalid_json_stdout", progressTail };
  }
}

function expectedVersionOf(result) {
  return nonBlank(result?.after?.version) || nonBlank(result?.targetVersion);
}

function capabilityReviewsOf(result) {
  const outcomes = result?.postUpdate?.plugins?.npm?.outcomes;
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((outcome) => {
    if (!isRecord(outcome) || outcome.code !== CAPABILITY_CONSENT_CODE) return [];
    const review = {};
    const pluginId = nonBlank(outcome.pluginId);
    const message = nonBlank(outcome.message);
    if (pluginId) review.pluginId = pluginId;
    if (message) review.message = message;
    return [review];
  });
}

function withOutput(operation, parsed, patch) {
  const state = {
    operation,
    ...patch,
    result: parsed.result,
  };
  if (parsed.progressTail) state.progressTail = parsed.progressTail;
  const expectedVersion = expectedVersionOf(parsed.result);
  if (expectedVersion) state.expectedVersion = expectedVersion;
  return state;
}

/** Classify a completed update/repair/doctor process into the approved states. */
function classifyOpenClawCommandResult({ operation, exitCode, stdout, stderr } = {}) {
  if (operation !== "update" && operation !== "repair" && operation !== "doctor") {
    throw new Error(`unsupported OpenClaw updater result operation: ${operation}`);
  }
  const parsed = parseOpenClawCommandOutput({ stdout, stderr });
  if (!parsed.ok) {
    return {
      operation,
      phase: "failed",
      reason: parsed.error,
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }

  const result = parsed.result;
  if (result.reason === "managed-service-handoff-started") {
    return withOutput(operation, parsed, { phase: "finalizing", reason: "managed_service_handoff" });
  }
  if (result.reason === "restart-health-pending") {
    return withOutput(operation, parsed, { phase: "restart_pending", reason: "restart_health_pending" });
  }

  const capabilityReviews = capabilityReviewsOf(result);
  if (capabilityReviews.length > 0) {
    return withOutput(operation, parsed, {
      phase: "capability_review_required",
      reason: "plugin_capability_widening",
      capabilityReviews,
    });
  }

  if (operation === "repair" && (exitCode !== 0 || result.status === "error")) {
    return withOutput(operation, parsed, { phase: "failed", reason: "repair_failed", exitCode });
  }
  if (operation === "doctor") {
    if (exitCode !== 0 || result.status === "error") {
      return withOutput(operation, parsed, { phase: "failed", reason: "doctor_failed", exitCode });
    }
    if (Array.isArray(result.findings) && result.findings.length > 0) {
      return withOutput(operation, parsed, {
        phase: "repair_required",
        reason: "doctor_findings",
        findings: result.findings,
      });
    }
    return withOutput(operation, parsed, { phase: "verifying" });
  }

  const pluginUpdate = result?.postUpdate?.plugins;
  const pluginWarnings = Array.isArray(pluginUpdate?.warnings) ? pluginUpdate.warnings : [];
  if (pluginUpdate?.status === "warning" || pluginWarnings.length > 0) {
    return withOutput(operation, parsed, {
      phase: "repair_required",
      reason: "plugin_finalization_warning",
      pluginWarnings,
    });
  }
  if (pluginUpdate?.status === "error" || result.reason === "post-update-plugins") {
    return withOutput(operation, parsed, { phase: "repair_required", reason: "plugin_finalization_failed" });
  }
  if (exitCode !== 0 || result.status === "error") {
    return withOutput(operation, parsed, { phase: "failed", reason: "update_failed", exitCode });
  }
  if (result.status === "skipped" && result.reason !== "already-current") {
    return withOutput(operation, parsed, { phase: "failed", reason: "update_skipped" });
  }
  return withOutput(operation, parsed, { phase: "restart_pending" });
}

function normalizeVersion(value) {
  const version = nonBlank(value);
  return version?.replace(/^v(?=\d)/, "");
}

function pluginVersionDriftOf(result) {
  const drifts = result?.pluginVersionDrift?.drifts;
  if (!Array.isArray(drifts)) return [];
  return drifts.flatMap((drift) => {
    if (!isRecord(drift)) return [];
    const pluginId = nonBlank(drift.pluginId) || nonBlank(drift.id);
    if (!pluginId) return [];
    const row = { pluginId };
    const installedVersion = normalizeVersion(drift.installedVersion);
    const gatewayVersion = normalizeVersion(drift.gatewayVersion);
    if (installedVersion) row.installedVersion = installedVersion;
    if (gatewayVersion) row.gatewayVersion = gatewayVersion;
    return [row];
  });
}

/** Read the documented `openclaw update status --json` recovery evidence. */
function classifyOpenClawUpdateStatus({ exitCode, stdout, stderr, error } = {}) {
  const progressTail = String(stderr || "").slice(-PROGRESS_TAIL_MAX);
  if (error && !String(stdout || "").trim()) {
    return {
      status: "unavailable",
      reason: error === "command_timeout" ? "update_status_timeout" : "update_status_failed",
      ...(progressTail ? { progressTail } : {}),
    };
  }
  const parsed = parseOpenClawCommandOutput({ stdout, stderr });
  if (!parsed.ok) {
    return {
      status: "unavailable",
      reason: parsed.error,
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }
  if (exitCode !== 0) {
    return {
      status: "unavailable",
      reason: "update_status_failed",
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }

  const result = parsed.result;
  const availability = result.availability;
  if (!isRecord(availability) || typeof availability.available !== "boolean") {
    return {
      status: "unavailable",
      reason: "invalid_update_status",
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }
  const update = isRecord(result.update) ? result.update : {};
  const latestVersion = normalizeVersion(availability.latestVersion)
    || normalizeVersion(update?.registry?.latestVersion);
  if (availability.available) {
    return {
      status: "available",
      ...(latestVersion ? { expectedVersion: latestVersion } : {}),
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }

  const packageStatusIsCurrent = update.installKind === "package" && Boolean(latestVersion);
  const gitStatusIsCurrent = update.installKind === "git"
    && isRecord(update.git)
    && Boolean(nonBlank(update.git.sha))
    && availability.hasGitUpdate === false;
  if (!packageStatusIsCurrent && !gitStatusIsCurrent) {
    return {
      status: "unavailable",
      reason: "update_status_inconclusive",
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }
  // Registry latest proves that the package check completed, but is not the
  // installed version when a local build is ahead. Gateway verification reads
  // the CLI's own version when the interrupted command did not persist a target.
  return {
    status: "current",
    ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
  };
}

/** Verify the version actually loaded by Gateway RPC, not only the CLI package. */
function verifyOpenClawGatewayStatus({ exitCode, stdout, stderr, expectedVersion } = {}) {
  const parsed = parseOpenClawCommandOutput({ stdout, stderr });
  if (!parsed.ok) {
    return {
      operation: "gateway_status",
      phase: "failed",
      reason: parsed.error,
      ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
    };
  }
  const result = parsed.result;
  const base = {
    operation: "gateway_status",
    result,
    ...(parsed.progressTail ? { progressTail: parsed.progressTail } : {}),
  };
  if (exitCode !== 0 || result?.rpc?.ok !== true) {
    return { ...base, phase: "failed", reason: "gateway_verification_failed", exitCode };
  }

  const expected = normalizeVersion(expectedVersion) || normalizeVersion(result?.cli?.version);
  const loaded = normalizeVersion(result?.rpc?.server?.version)
    || normalizeVersion(result?.rpc?.version)
    || normalizeVersion(result?.gateway?.version);
  if (!expected || !loaded) {
    return {
      ...base,
      phase: "failed",
      reason: !expected ? "expected_version_missing" : "loaded_version_missing",
    };
  }
  if (loaded !== expected) {
    return {
      ...base,
      phase: "restart_pending",
      reason: "loaded_version_mismatch",
      expectedVersion: expected,
      loadedVersion: loaded,
    };
  }
  const pluginVersionDrift = pluginVersionDriftOf(result);
  if (pluginVersionDrift.length > 0) {
    return {
      ...base,
      phase: "finalizing",
      reason: "plugin_version_drift",
      expectedVersion: expected,
      loadedVersion: loaded,
      pluginVersionDrift,
    };
  }
  return { ...base, phase: "completed", expectedVersion: expected, loadedVersion: loaded };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process owns the PID. Only ESRCH proves it is
    // gone; treating permission failure as dead could start a concurrent update.
    return error?.code !== "ESRCH";
  }
}

function isMalformedUpdateResult(state) {
  return (state?.operation === "update" || state?.operation === "repair")
    && (state?.reason === "invalid_json_stdout" || state?.reason === "empty_json_stdout");
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state || { running: false }));
}

function publicClassification(classified) {
  const {
    result: _privateResult,
    stdout: _privateStdout,
    stderr: _privateStderr,
    ...safe
  } = classified || {};
  return safe;
}

class OpenClawUpdateController {
  constructor(options = {}) {
    this._bin = nonBlank(options.bin) || "openclaw";
    this._getGatewayUrl = typeof options.getGatewayUrl === "function" ? options.getGatewayUrl : null;
    this._statePath = nonBlank(options.statePath);
    this._spawn = options.spawnImpl || spawn;
    this._now = options.now || Date.now;
    this._sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this._verifyPollMs = options.verifyPollMs ?? DEFAULT_VERIFY_POLL_MS;
    this._commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this._recoveryTimeoutMs = options.recoveryTimeoutMs ?? this._commandTimeoutMs;
    this._recoveryPollMs = options.recoveryPollMs ?? DEFAULT_VERIFY_POLL_MS;
    this._processAlive = options.processAliveImpl || processAlive;
    this._state = this._load();
    this._active = null;
  }

  _load() {
    if (!this._statePath) return { running: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(this._statePath, "utf8"));
      return isRecord(parsed) ? publicClassification(parsed) : { running: false };
    } catch {
      return { running: false };
    }
  }

  _persist() {
    if (!this._statePath) return;
    try {
      fs.mkdirSync(path.dirname(this._statePath), { recursive: true });
      const tmp = `${this._statePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(publicClassification(this._state)), { mode: 0o600 });
      fs.renameSync(tmp, this._statePath);
    } catch {
      // Update state is diagnostic; a persistence failure must not interrupt npm.
    }
  }

  status() {
    if (this._state.running && !this._active) this._startRecovery();
    if (
      !this._state.running
      && !this._active
      && !this._state.recoveryAttemptedAt
      && isMalformedUpdateResult(this._state)
    ) {
      this._startMalformedResultRecovery();
    }
    return cloneState(publicClassification(this._state));
  }

  _startRecovery() {
    let active;
    active = this._recoverPersistedRun()
      .catch(() => {
        this._finish({
          phase: "failed",
          reason: "update_recovery_failed",
          error: "Unable to recover the previous OpenClaw update",
          ok: false,
        });
      })
      .finally(() => {
        if (this._active === active) this._active = null;
      });
    this._active = active;
  }

  _startMalformedResultRecovery() {
    const {
      running: _running,
      finishedAt: _finishedAt,
      recoveryAttemptedAt: _recoveryAttemptedAt,
      ...fallback
    } = publicClassification(this._state);
    this._set({ running: true, phase: "verifying", recoveryAttemptedAt: this._now() });
    let active;
    active = this._recoverMalformedUpdateResult(fallback.operation, fallback)
      .catch(() => {
        this._finish({
          ...fallback,
          recoveryAttemptedAt: this._state.recoveryAttemptedAt,
          ok: false,
        });
      })
      .finally(() => {
        if (this._active === active) this._active = null;
      });
    this._active = active;
  }

  run({ operation = "update", acceptCapabilities = false } = {}) {
    if (operation !== "update" && operation !== "repair") {
      throw new Error("OpenClaw updater action must be update or repair");
    }
    const current = this.status();
    if (current.running) return current;
    const command = buildOpenClawUpdaterCommand(operation, {
      bin: this._bin,
      acceptCapabilities: acceptCapabilities === true,
    });
    const startedAt = this._now();
    this._state = {
      running: true,
      phase: operation === "update" ? "updating" : "finalizing",
      operation,
      startedAt,
      recoveryDeadlineAt: startedAt + this._recoveryTimeoutMs,
      command: [command.cmd, ...command.args].join(" "),
    };
    this._persist();
    this._active = this._execute({ operation, acceptCapabilities: acceptCapabilities === true })
      .catch((error) => {
        this._finish({
          phase: "failed",
          reason: "controller_error",
          error: error?.message || String(error),
          ok: false,
        });
      })
      .finally(() => {
        this._active = null;
      });
    return this.status();
  }

  _set(patch) {
    this._state = publicClassification({ ...this._state, ...patch });
    this._persist();
  }

  _finish(patch) {
    this._set({ running: false, finishedAt: this._now(), ...patch });
  }

  _runCommand(operation, options = {}) {
    const command = buildOpenClawUpdaterCommand(operation, {
      bin: this._bin,
      acceptCapabilities: options.acceptCapabilities === true,
      ...(operation === "gateway_status" && this._getGatewayUrl
        ? { gatewayUrl: this._getGatewayUrl() }
        : {}),
    });
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(command.cmd, command.args, {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        resolve({ exitCode: null, stdout: "", stderr: "", error: error?.message || String(error) });
        return;
      }
      if (options.trackPid !== false && Number.isInteger(child?.pid)) this._set({ pid: child.pid });
      let stdout = "";
      let stderr = "";
      let outputTooLarge = false;
      const appendStdout = (chunk) => {
        if (outputTooLarge) return;
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > COMMAND_OUTPUT_MAX) {
          outputTooLarge = true;
          stdout = "";
        }
      };
      const appendStderr = (chunk) => {
        stderr = (stderr + String(chunk)).slice(-PROGRESS_TAIL_MAX);
        this._set({ progressTail: stderr, logTail: stderr });
      };
      child.stdout?.on("data", appendStdout);
      child.stderr?.on("data", appendStderr);
      let settled = false;
      let timer = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          ...value,
          stdout: outputTooLarge ? "" : stdout,
          stderr,
          ...(outputTooLarge ? { error: "json_stdout_too_large" } : {}),
        });
      };
      child.on("error", (error) => done({ exitCode: null, error: error?.message || String(error) }));
      // `exit` may fire before stdout/stderr close. Classifying there can parse a
      // truncated JSON document, so settle only after the stdio-backed `close`.
      child.on("close", (code, signal) => done({
        exitCode: code,
        ...(signal ? { error: `terminated by ${signal}` } : {}),
      }));
      timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {
          try { child.kill?.("SIGKILL"); } catch { /* already gone */ }
        }
        // Do not rely on a misbehaving child to emit close after SIGKILL.
        done({ exitCode: null, error: "command_timeout", timedOut: true });
      }, this._commandTimeoutMs);
    });
  }

  async _verifyLoadedVersion(expectedVersion, timeoutMs = this._verifyTimeoutMs) {
    const deadline = this._now() + Math.max(0, timeoutMs);
    let last = null;
    do {
      const output = await this._runCommand("gateway_status");
      last = verifyOpenClawGatewayStatus({ ...output, expectedVersion });
      if (last.phase === "completed") return last;
      if (this._now() >= deadline) break;
      await this._sleep(this._verifyPollMs);
    } while (true);
    return last || { phase: "failed", reason: "gateway_verification_failed" };
  }

  async _completeVerification(operation, expectedVersion, options = {}) {
    this._set({ phase: "verifying", reason: undefined, error: undefined, interrupted: undefined });
    const verified = await this._verifyLoadedVersion(expectedVersion, options.verifyTimeoutMs);
    const safeVerified = publicClassification(verified);
    const { operation: _verificationOperation, ...verificationState } = safeVerified;
    if (verified.phase !== "completed") {
      this._finish({
        ...verificationState,
        phase: "repair_required",
        operation,
        ok: false,
      });
      return;
    }
    this._set({ ...verificationState, phase: "verifying", operation });

    const doctorOutput = await this._runCommand("doctor");
    const doctor = classifyOpenClawCommandResult({ operation: "doctor", ...doctorOutput });
    const safeDoctor = publicClassification(doctor);
    const { operation: _doctorOperation, ...doctorState } = safeDoctor;
    if (doctor.phase !== "verifying") {
      this._finish({
        ...doctorState,
        ...(doctor.phase === "failed" ? { phase: "repair_required" } : {}),
        operation,
        ok: false,
      });
      return;
    }
    this._finish({
      phase: "completed",
      operation,
      reason: undefined,
      error: undefined,
      ok: true,
      expectedVersion: verified.expectedVersion,
      loadedVersion: verified.loadedVersion,
      pluginVersionDrift: undefined,
      progressTail: this._state.progressTail,
      logTail: this._state.logTail,
    });
  }

  async _recoverManagedHandoff(operation, expectedVersion) {
    const recoveryDeadlineAt = Number.isFinite(this._state.recoveryDeadlineAt)
      ? this._state.recoveryDeadlineAt
      : this._now() + this._recoveryTimeoutMs;
    this._set({ phase: "finalizing", reason: "managed_service_handoff", recoveryDeadlineAt });

    while (this._state.running) {
      const output = await this._runCommand("update_status", { trackPid: false });
      const official = classifyOpenClawUpdateStatus(output);
      this._set({
        phase: "finalizing",
        reason: "managed_service_handoff",
        recoveryCheckedAt: this._now(),
        recoveryStatus: official.status,
        ...(official.progressTail ? { progressTail: official.progressTail, logTail: official.progressTail } : {}),
      });

      if (official.status === "current") {
        await this._completeVerification(operation, expectedVersion || official.expectedVersion, {
          verifyTimeoutMs: Math.max(0, recoveryDeadlineAt - this._now()),
        });
        return;
      }
      if (this._now() >= recoveryDeadlineAt) {
        if (official.status === "available") {
          this._finish({
            phase: "failed",
            reason: "update_interrupted",
            error: "OpenClaw managed-service update stopped before the available version was installed",
            interrupted: true,
            ok: false,
          });
        } else {
          this._finish({
            phase: "failed",
            reason: "update_recovery_status_failed",
            error: "Unable to determine whether the OpenClaw managed-service update completed",
            ok: false,
          });
        }
        return;
      }
      await this._sleep(this._recoveryPollMs);
    }
  }

  async _recoverPersistedRun() {
    const operation = this._state.operation;
    if (operation !== "update" && operation !== "repair") {
      this._finish({
        phase: "failed",
        reason: "update_recovery_invalid_state",
        error: "The previous OpenClaw update state is invalid",
        ok: false,
      });
      return;
    }
    const originalPid = this._state.pid;
    const startedAt = Number.isFinite(this._state.startedAt) ? this._state.startedAt : this._now();
    const recoveryDeadlineAt = Number.isFinite(this._state.recoveryDeadlineAt)
      ? this._state.recoveryDeadlineAt
      : startedAt + this._recoveryTimeoutMs;
    this._set({ recoveryDeadlineAt });

    while (this._state.running) {
      const output = await this._runCommand("update_status", { trackPid: false });
      const official = classifyOpenClawUpdateStatus(output);
      const ownerAlive = this._processAlive(originalPid);
      this._set({
        recoveryCheckedAt: this._now(),
        recoveryStatus: official.status,
        ...(official.progressTail ? { progressTail: official.progressTail, logTail: official.progressTail } : {}),
      });

      if (!ownerAlive && official.status === "current") {
        await this._completeVerification(
          operation,
          normalizeVersion(this._state.expectedVersion) || official.expectedVersion,
          { verifyTimeoutMs: Math.max(0, recoveryDeadlineAt - this._now()) },
        );
        return;
      }

      if (this._now() >= recoveryDeadlineAt) {
        if (!ownerAlive && official.status === "available") {
          this._finish({
            phase: "failed",
            reason: "update_interrupted",
            error: "OpenClaw update stopped before the available version was installed",
            interrupted: true,
            ok: false,
          });
          return;
        }
        if (official.status === "unavailable") {
          this._finish({
            phase: "failed",
            reason: "update_recovery_status_failed",
            error: "Unable to determine whether the previous OpenClaw update completed",
            ok: false,
          });
          return;
        }
        this._finish({
          phase: "failed",
          reason: "update_recovery_timeout",
          error: "The previous OpenClaw update did not finish within the recovery window",
          ok: false,
        });
        return;
      }
      await this._sleep(this._recoveryPollMs);
    }
  }

  async _recoverMalformedUpdateResult(operation, fallback) {
    this._set({ recoveryAttemptedAt: this._state.recoveryAttemptedAt || this._now() });
    const output = await this._runCommand("update_status", { trackPid: false });
    const official = classifyOpenClawUpdateStatus(output);
    if (official.status !== "current") {
      this._finish({
        ...fallback,
        recoveryAttemptedAt: this._state.recoveryAttemptedAt,
        ok: false,
      });
      return;
    }
    await this._completeVerification(operation, official.expectedVersion);
  }

  async _execute({ operation, acceptCapabilities }) {
    const output = await this._runCommand(operation, { acceptCapabilities });
    if (output.error && !output.stdout) {
      this._finish({ phase: "failed", reason: "command_failed", error: output.error, ok: false });
      return;
    }
    const classified = classifyOpenClawCommandResult({ operation, ...output });
    const safe = publicClassification(classified);
    this._set(safe);
    if (isMalformedUpdateResult(classified)) {
      await this._recoverMalformedUpdateResult(operation, safe);
      return;
    }
    if (["failed", "repair_required", "capability_review_required"].includes(classified.phase)) {
      this._finish({ ...safe, ok: false });
      return;
    }

    if (classified.reason === "managed_service_handoff") {
      await this._recoverManagedHandoff(operation, classified.expectedVersion);
      return;
    }

    await this._completeVerification(operation, classified.expectedVersion);
  }
}

module.exports = {
  CAPABILITY_CONSENT_CODE,
  OPENCLAW_UPDATE_PHASES,
  OPENCLAW_UPDATE_STATE_BY_EVENT,
  buildOpenClawUpdaterCommand,
  classifyOpenClawCommandResult,
  classifyOpenClawUpdateStatus,
  parseOpenClawCommandOutput,
  verifyOpenClawGatewayStatus,
  OpenClawUpdateController,
};
