"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { MAX_WINDOWS, quotaSnapshot } = require("../core/oauth-account-quota");
const { googleRequirement } = require("./antigravity-acp-distribution");
const { resolveAntigravityCli } = require("./antigravity-runtime-paths");
const { PROXY_ENV_PAIRS, readMacSystemProxyEnvironmentAsync } = require("./proxy-environment");

const exec = promisify(execFile);
const cliRequirement = googleRequirement("cli");
const minutesByWindow = new Map([["5h", 300], ["weekly", 10_080]]);
let lastCli;

function executableStamp(binary) {
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) return null;
  return JSON.stringify([binary, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

function supportedVersion(output) {
  // Earlier versions can send /usage as a model prompt.
  const match = /^(?:agy\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u.exec(output.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger)
    && (major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11))));
}

function parseJson(output) {
  try { return JSON.parse(output); } catch { return null; }
}

function commandResult(stdout) {
  const result = parseJson(stdout);
  if (result) return result;
  // Some releases put a diagnostic line before the JSON result.
  const lines = stdout.split(/\r?\n/u).filter(line => line.trimStart().startsWith("{"));
  return lines.length === 1 ? parseJson(lines[0]) : null;
}

function enteredConversation(result) {
  return Boolean(result?.conversation_id)
    || (result?.num_turns !== undefined && result.num_turns !== 0)
    || Object.values(result?.usage || {}).some(value => typeof value === "number" && value !== 0);
}

function usageSnapshot(result) {
  if (result?.status !== "SUCCESS" || result.num_turns !== 0 || result.command?.name !== "usage"
    || !Array.isArray(result.command.data?.groups)) return { status: "unavailable" };
  const windows = [];
  for (const group of result.command.data.groups) {
    if (typeof group?.name !== "string" || !group.name.trim() || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const remaining = bucket?.remaining_fraction;
      if (bucket?.disabled === true || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      windows.push({
        label: group.name,
        durationMinutes: minutesByWindow.get(bucket.window),
        usedPercent: (1 - remaining) * 100,
        resetsAt: typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : null,
      });
      if (windows.length === MAX_WINDOWS) return quotaSnapshot(windows);
    }
  }
  return quotaSnapshot(windows);
}

function unavailable(reason) {
  return reason ? { status: "unavailable", reason } : { status: "unavailable" };
}

function commandFailure(stdout, stderr, result) {
  // Keep provider output inside the Service. It can contain account or login details.
  for (const match of `${stdout}\n${stderr}`.matchAll(/AGY_ERROR:\s*(\{[^\r\n]*\})\s*$/gmu)) {
    const error = parseJson(match[1]);
    if (error?.status === "UNAUTHENTICATED" || error?.error_code === 401) return unavailable("antigravity-cli-sign-in-required");
    if (error?.status === "PERMISSION_DENIED" || error?.error_code === 403) return unavailable("antigravity-cli-permission-denied");
  }
  if (/authentication required|not (?:logged|signed) in|not authenticated|no credentials/iu.test(`${result?.error || ""}\n${stderr}`)) {
    return unavailable("antigravity-cli-sign-in-required");
  }
  return unavailable();
}

async function readAntigravityCliQuota({ homedir = os.homedir(), parentEnv = process.env, platform = process.platform,
  execute = exec, readSystemProxy = readMacSystemProxyEnvironmentAsync } = {}) {
  if (platform !== "darwin") return { status: "unsupported" };
  const binary = resolveAntigravityCli({ homedir, parentEnv });
  if (!binary) return unavailable("antigravity-cli-missing");
  let cwd;
  try {
    const stamp = executableStamp(binary);
    if (!stamp) return unavailable();
    if (lastCli?.stamp !== stamp) lastCli = { stamp };
    const cli = lastCli;
    if (cli.incompatible) return unavailable("antigravity-cli-update-required");

    const signal = AbortSignal.timeout(25_000);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-quota-"));
    const inheritedProxy = {};
    for (const key of PROXY_ENV_PAIRS.flat()) {
      const value = parentEnv[key];
      if (typeof value === "string" && value.length <= 8192 && !value.includes("\0") && value) inheritedProxy[key] = value;
    }
    const proxy = PROXY_ENV_PAIRS.slice(0, -1).flat().some(key => inheritedProxy[key])
      ? inheritedProxy : { ...await readSystemProxy({ platform, signal }), ...inheritedProxy };
    // Use the CLI's own login and an empty workspace. Do not inherit Agent
    // credentials, settings overrides, or shell startup scripts.
    const env = { ...proxy, HOME: homedir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      BROWSER: "/usr/bin/true", AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
    const options = { cwd, env, signal, encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 512 * 1024 };
    if (!cli.verified) {
      await execute("/usr/bin/codesign", ["--verify", "--strict", `-R=${cliRequirement}`, binary], { ...options, timeout: 10_000 });
      if (executableStamp(binary) !== stamp) return unavailable();
      cli.verified = true;
    }
    if (!cli.supported) {
      const version = await execute(binary, ["--version"], { ...options, timeout: 4_000 });
      cli.supported = supportedVersion(version.stdout.trim() || version.stderr || "");
      if (!cli.supported) {
        cli.incompatible = true;
        return unavailable("antigravity-cli-update-required");
      }
    }
    if (executableStamp(binary) !== stamp) return unavailable();
    const { stdout = "", stderr = "", failed = false } = await execute(binary,
      ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s", "--log-file", path.join(cwd, "agy.log")],
      { ...options, timeout: 17_000 }).catch(error => ({ stdout: error.stdout, stderr: error.stderr, failed: true }));
    if (executableStamp(binary) !== stamp) return unavailable();

    const result = commandResult(stdout);
    const failure = failed || result?.status === "ERROR" ? commandFailure(stdout, stderr, result) : null;
    if (failure?.reason) return failure;
    if (enteredConversation(result)) {
      cli.incompatible = true;
      return unavailable("antigravity-cli-update-required");
    }
    return failure || usageSnapshot(result);
  } catch {
    return unavailable();
  } finally {
    if (cwd) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = { readAntigravityCliQuota };
