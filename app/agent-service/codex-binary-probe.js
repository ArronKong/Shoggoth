"use strict";

const { spawn } = require("node:child_process");
const { CODEX_VERSION } = require("./codex-schema-contract");
const { runtimeError } = require("./codex-runtime-paths");

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER_BYTES = 16 * 1024;
const PROBE_KILL_GRACE_MS = 250;
const PROBE_HARD_SETTLE_MS = 1_000;

function defaultKillProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function defaultProcessGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function probeError(cleanupIncomplete = false) {
  const error = runtimeError("CODEX_RUNTIME_VERSION_PROBE_FAILED", "Codex binary version probe failed");
  if (cleanupIncomplete) error.cleanupIncomplete = true;
  return error;
}

function supportedSystemVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  if (!actual.every(Number.isSafeInteger)) return false;
  // Native CLIs may update independently. Keep the stable protocol baseline;
  // every RPC still passes the same generated request/response validation.
  const minimum = CODEX_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return match[4] === undefined;
}

function probeCodexBinaryVersion(runtimePath, options = {}) {
  const installationKind = options.installationKind ?? "bundled";
  if (installationKind !== "bundled" && installationKind !== "system") {
    return Promise.reject(probeError());
  }
  const spawnImpl = options.spawnImpl || spawn;
  const killProcessGroup = options.killProcessGroup || defaultKillProcessGroup;
  const processGroupExists = options.processGroupExists || defaultProcessGroupExists;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? PROBE_KILL_GRACE_MS;
  const hardSettleMs = options.hardSettleMs ?? PROBE_HARD_SETTLE_MS;
  const maxBufferBytes = options.maxBufferBytes ?? PROBE_MAX_BUFFER_BYTES;
  if (options.signal?.aborted) return Promise.reject(probeError());

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let terminating = false;
    let failureCode = null;
    let outputBytes = 0;
    const stdoutChunks = [];
    let timeoutTimer;
    let killTimer;
    let hardSettleTimer;
    let groupProbeTimer;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardSettleTimer);
      clearTimeout(groupProbeTimer);
      options.signal?.removeEventListener("abort", beginTermination);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(value);
    };
    const kill = (signal) => {
      try {
        killProcessGroup(child.pid, signal, child);
      } catch {}
    };
    const groupExists = () => {
      try { return processGroupExists(child.pid, child); } catch { return null; }
    };
    const confirmAfterKill = () => {
      if (settled) return;
      if (groupExists() === false) {
        finish(probeError());
        return;
      }
      groupProbeTimer = setTimeout(confirmAfterKill, Math.max(1, Math.min(25, hardSettleMs)));
    };
    function beginTermination() {
      if (settled || terminating) return;
      terminating = true;
      failureCode ||= "CODEX_RUNTIME_VERSION_PROBE_FAILED";
      if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) {
        finish(probeError());
        return;
      }
      kill("SIGTERM");
      if (settled) return;
      killTimer = setTimeout(() => {
        const exists = groupExists();
        if (exists === false) {
          finish(probeError());
          return;
        }
        kill("SIGKILL");
        confirmAfterKill();
      }, killGraceMs);
      hardSettleTimer = setTimeout(() => {
        finish(probeError(groupExists() !== false));
      }, killGraceMs + hardSettleMs);
    }

    try {
      child = spawnImpl(runtimePath, ["--version"], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(probeError());
      return;
    }
    child.once("error", beginTermination);
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || !child.stdout || !child.stderr) {
      beginTermination();
      return;
    }

    const consume = (chunk, capture) => {
      if (settled || terminating) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxBufferBytes) {
        failureCode = "CODEX_RUNTIME_VERSION_PROBE_FAILED";
        beginTermination();
        return;
      }
      if (capture) stdoutChunks.push(bytes);
    };
    child.stdout.on("data", (chunk) => consume(chunk, true));
    child.stderr.on("data", (chunk) => consume(chunk, false));
    child.stdout.once("error", beginTermination);
    child.stderr.once("error", beginTermination);
    child.once("close", (code) => {
      if (settled) return;
      if (terminating) return;
      if (failureCode || code !== 0) return finish(probeError());
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const version = /^codex-cli (\S+)$/u.exec(stdout)?.[1];
      const compatible = installationKind === "system"
        ? typeof version === "string" && supportedSystemVersion(version)
        : version === CODEX_VERSION;
      if (!compatible) {
        finish(runtimeError("CODEX_RUNTIME_VERSION_MISMATCH", "Codex binary version is incompatible"));
        return;
      }
      finish(null, Object.freeze({ version }));
    });
    options.signal?.addEventListener("abort", beginTermination, { once: true });
    timeoutTimer = setTimeout(beginTermination, timeoutMs);
  });
}

module.exports = {
  PROBE_HARD_SETTLE_MS,
  PROBE_KILL_GRACE_MS,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
  probeCodexBinaryVersion,
};
