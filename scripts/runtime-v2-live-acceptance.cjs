#!/usr/bin/env node
"use strict";

// This is an explicit real-provider acceptance entrypoint. Default plan mode
// neither reads credentials nor creates a Service/CLI/provider request.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { readPiAuth, writePiOAuthHome, validateProxy, explicitProxyEnv } = require("./runtime-handoff-pi-evaluator.cjs");

function fail(code) { return Object.assign(new Error(code), { code }); }
function parseOptions(args) {
  const keys = new Set(["--mode", "--phase", "--codex-bin", "--pi-cli", "--codex-auth", "--pi-auth", "--model", "--proxy", "--output"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!keys.has(key) || values.has(key) || !value || value.startsWith("--")) throw fail("S6_ARGS_INVALID");
    values.set(key, value);
  }
  const mode = values.get("--mode") || "plan", phase = values.get("--phase") || "all";
  if (!["plan", "live"].includes(mode) || !["all", "handoff", "mixed", "compaction"].includes(phase)) throw fail("S6_ARGS_INVALID");
  for (const key of ["--codex-bin", "--pi-cli", "--codex-auth", "--pi-auth", "--output"]) {
    if ((mode === "live" && !values.has(key)) || (values.has(key) && !path.isAbsolute(values.get(key)))) throw fail("S6_ABSOLUTE_PATH_REQUIRED");
  }
  const model = values.get("--model");
  if ((mode === "live" && !model) || (model !== undefined && !/^[a-zA-Z0-9._:/-]{1,256}$/u.test(model))) throw fail("S6_MODEL_REQUIRED");
  return { mode, phase, codexBin: values.get("--codex-bin"), piCli: values.get("--pi-cli"),
    codexAuth: values.get("--codex-auth"), piAuth: values.get("--pi-auth"), model,
    proxy: validateProxy(values.get("--proxy")), output: values.get("--output") };
}

function readCodexAuth(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw fail("S6_PRIVATE_CODEX_AUTH_REQUIRED");
  const input = JSON.parse(fs.readFileSync(target, "utf8"));
  const tokens = input?.tokens;
  if (input?.auth_mode !== "chatgpt" || !tokens || Object.getPrototypeOf(tokens) !== Object.prototype
    || !["id_token", "access_token", "refresh_token", "account_id"].every(key => typeof tokens[key] === "string"
      && tokens[key].length > 0 && tokens[key].length <= 65536 && !/[\r\n\0]/u.test(tokens[key]))
    || (input.last_refresh !== undefined && input.last_refresh !== null && typeof input.last_refresh !== "string")) throw fail("S6_CODEX_AUTH_INVALID");
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: Object.fromEntries(["id_token", "access_token", "refresh_token", "account_id"].map(key => [key, tokens[key]])),
    ...(input.last_refresh !== undefined ? { last_refresh: input.last_refresh } : {}) };
}

function isolatedEnv(root, proxy) {
  return { HOME: root, CODEX_HOME: path.join(root, ".codex"), PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent"),
    TMPDIR: root, TMP: root, TEMP: root, LANG: "en_US.UTF-8",
    PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...explicitProxyEnv(proxy) };
}
const hashFile = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function probe(file, args, { allowPartial = false } = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" } });
  if (allowPartial && result.status === 1 && /^p\d+$/mu.test(result.stdout || "")) return result.stdout;
  if (result.status !== 0) throw fail(file.endsWith("/lsof") ? "S6_FD_PROBE_FAILED"
    : file.endsWith("/memory_pressure") ? "S6_MEMORY_PROBE_FAILED" : "S6_PROCESS_PROBE_FAILED");
  return result.stdout;
}
function resourceSample(pid, startedAt) {
  const rows = probe("/bin/ps", ["-axo", "pid=,ppid=,rss="]).trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number));
  const selected = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [candidate, parent] of rows) if (selected.has(parent) && !selected.has(candidate)) { selected.add(candidate); changed = true; }
  }
  const processes = rows.filter(([candidate]) => selected.has(candidate));
  let numericFds = 0, sampledFdProcesses = 0;
  if (processes.length) {
    // lsof returns 1 when a short-lived version/catalog probe exits between ps
    // and lsof. Keep its valid rows as an explicitly partial snapshot.
    const fdRows = probe("/usr/sbin/lsof", ["-n", "-P", "-a", "-p",
      processes.map(([candidate]) => candidate).join(","), "-Fpf"], { allowPartial: true }).split("\n");
    numericFds = fdRows.filter(line => /^f\d+/u.test(line)).length;
    sampledFdProcesses = fdRows.filter(line => /^p\d+$/u.test(line)).length;
  }
  const match = probe("/usr/bin/memory_pressure", ["-Q"]).match(/System-wide memory free percentage:\s*(\d+)%/u);
  if (!match) throw fail("S6_MEMORY_PROBE_INVALID");
  return { atMs: Date.now() - startedAt, aggregateRssKiB: processes.reduce((total, row) => total + row[2], 0),
    processCount: processes.length, childProcessCount: Math.max(0, processes.length - 1), numericFds,
    sampledFdProcesses, fdCoverage: sampledFdProcesses === processes.length ? "all-observed-processes" : "partial-process-exit",
    memoryFreePercent: Number(match[1]) };
}

function descendantIdentities(pid) {
  const lines = probe("/bin/ps", ["-axo", "pid=,ppid=,lstart="]).trim().split("\n");
  const rows = lines.map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), born: match[3].trim() } : null;
  }).filter(Boolean);
  const ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter(row => ids.has(row.pid));
}
function stillOwned(record) {
  const result = spawnSync("/bin/ps", ["-p", String(record.pid), "-o", "lstart="], {
    encoding: "utf8", timeout: 2000, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } });
  return result.status === 0 && result.stdout.trim() === record.born;
}

async function killOwnedProcesses(records) {
  for (const record of [...records].reverse()) if (stillOwned(record)) {
    try { process.kill(record.pid, "SIGKILL"); } catch {}
  }
  const deadline = Date.now() + 5000;
  let remaining;
  do {
    remaining = records.filter(stillOwned);
    if (!remaining.length) return 0;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return remaining.length;
}

async function execute(options) {
  if (options.mode !== "live") return { mode: "plan", credentialFilesRead: false, providerCalls: 0,
    intendedPhase: options.phase, plannedPromptCalls: options.phase === "compaction" ? 8 : options.phase === "all" ? 23 : options.phase === "mixed" ? 20 : 3,
    mixedRuntimes: { codex: 10, pi: 10 }, model: options.model ?? null,
    isolation: "Disposable Service HOME, Runtime auth copies, encrypted temporary stores and distinct empty workspaces.",
    evidence: "not-run", limitation: "Explicit --mode live is required. Actual running overlap is measured, not inferred from 20 submissions." };
  if (process.platform !== "darwin") throw fail("S6_MACOS_REQUIRED");
  if (fs.existsSync(options.output)) throw fail("S6_OUTPUT_ALREADY_EXISTS");
  const disk = fs.statfsSync("/private/tmp");
  if (disk.bavail * disk.bsize < 1024 ** 3) throw fail("S6_DISK_SPACE_LOW");
  for (const binary of [options.codexBin, options.piCli]) {
    if (!fs.statSync(binary).isFile()) throw fail("S6_BINARY_INVALID");
    fs.accessSync(binary, fs.constants.X_OK);
  }
  const before = { codex: hashFile(options.codexAuth), pi: hashFile(options.piAuth) };
  const codexAuth = readCodexAuth(options.codexAuth), piAuth = readPiAuth(options.piAuth);
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sglive-"));
  const samples = [];
  const resourceProbeErrors = [];
  const owned = new Map();
  let child, exited = false, workerExited = false, consecutiveProbeFailures = 0, interval, timeout, hardKill, stopCode = null, result;
  const startedAt = Date.now();
  const stop = code => {
    stopCode ||= code;
    if (!child?.pid || exited) return;
    try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
    // Let Service.stop close even independently detached native process groups.
    try { child.kill("SIGTERM"); } catch {}
    if (!hardKill) hardKill = setTimeout(() => {
      try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
      for (const record of [...owned.values()].reverse()) if (stillOwned(record)) {
        try { process.kill(record.pid, "SIGKILL"); } catch {}
      }
    }, 10_000);
  };
  try {
    fs.chmodSync(root, 0o700);
    for (const dir of [".codex", "bin", "workspaces"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
    fs.writeFileSync(path.join(root, ".codex", "auth.json"), JSON.stringify(codexAuth), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), `cli_auth_credentials_store = "file"\nmodel = ${JSON.stringify(options.model)}\n`, { mode: 0o600 });
    writePiOAuthHome(path.join(root, ".pi", "agent"), piAuth, options.model, { maxTokens: options.phase === "compaction" ? 4096 : 1024 });
    fs.writeFileSync(path.join(root, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "openai-codex",
      defaultModel: options.model, enableInstallTelemetry: false, defaultProjectTrust: "never" }), { mode: 0o600 });
    fs.symlinkSync(fs.realpathSync(options.codexBin), path.join(root, "bin", "codex"));
    const configPath = path.join(root, "worker.json");
    fs.writeFileSync(configPath, JSON.stringify({ root, piCli: fs.realpathSync(options.piCli), model: options.model,
      phase: options.phase }), { mode: 0o600 });
    child = spawn(process.execPath, [path.join(__dirname, "runtime-v2-live-worker.cjs"), configPath], {
      cwd: root, env: isolatedEnv(root, options.proxy), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let outputBytes = 0;
    // Raw CLI/Service diagnostics can contain private endpoint/auth context.
    // Only fixed workflow stage strings are ever forwarded to the caller.
    let lines = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      outputBytes += Buffer.byteLength(chunk); lines = (lines + chunk).slice(-8192);
      for (let newline; (newline = lines.indexOf("\n")) >= 0;) {
        const line = lines.slice(0, newline); lines = lines.slice(newline + 1);
        if (/^S6_STAGE (?:handoff|mixed-prepare|mixed-dispatch|mixed-running|compaction-seed|compaction-auto|compaction-handoff)$/u.test(line)) console.log(line);
      }
      if (outputBytes > 8 * 1024 * 1024) stop("S6_WORKER_OUTPUT_LIMIT");
    });
    child.stderr.on("data", chunk => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) stop("S6_WORKER_OUTPUT_LIMIT"); });
    const exit = new Promise((resolve, reject) => {
      child.once("error", () => reject(fail("S6_WORKER_SPAWN_FAILED")));
      child.once("exit", () => { workerExited = true; });
      child.once("close", (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    const sample = () => {
      if (workerExited || exited || stopCode) return;
      try {
        for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record);
        const value = resourceSample(child.pid, startedAt); samples.push(value);
        consecutiveProbeFailures = 0;
        if (value.memoryFreePercent < 15) stop("S6_MEMORY_PRESSURE_STOP"); }
      catch (error) {
        const code = /^S6_(?:FD|MEMORY|PROCESS)_PROBE_(?:FAILED|INVALID)$/u.test(error?.code || "")
          ? error.code : "S6_RESOURCE_PROBE_FAILED";
        resourceProbeErrors.push({ atMs: Date.now() - startedAt, code });
        // Synchronous ps/lsof may observe the worker's final zombie before Node
        // receives its exit event. Do not overwrite its real failure with that
        // one disappearing-process sample; persistent probe loss still fails.
        if (++consecutiveProbeFailures >= 3 && !workerExited && !exited) stop(code);
      }
    };
    sample(); interval = setInterval(sample, 1000);
    timeout = setTimeout(() => stop("S6_TOTAL_TIMEOUT"), 15 * 60_000);
    const naturalExit = await exit;
    clearInterval(interval); clearTimeout(timeout); clearTimeout(hardKill);
    const resultPath = path.join(root, "result.json");
    result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
      : { version: 1, evidence: "isolated-source-service-real-native-provider", status: "failed", errorCode: stopCode || "S6_WORKER_NO_RESULT" };
    Object.assign(result, { naturalExit, durationMs: Date.now() - startedAt, samples, resourceProbeErrors,
      peakAggregateRssKiB: Math.max(0, ...samples.map(sample => sample.aggregateRssKiB)),
      peakNumericFds: Math.max(0, ...samples.map(sample => sample.numericFds)),
      peakProcessCount: Math.max(0, ...samples.map(sample => sample.processCount)),
      sourceAuthUnchanged: before.codex === hashFile(options.codexAuth) && before.pi === hashFile(options.piAuth),
      limitation: "Source Service + real native CLI + explicit Provider; MCP uses a no-tools transport fixture. Does not prove business MCP, packaged/installed App or GUI behavior." });
    const remaining = [...owned.values()].filter(record => stillOwned(record));
    result.remainingOwnedProcesses = remaining.length;
    if (remaining.length) { stopCode ||= "S6_NATIVE_CLEANUP_INCOMPLETE";
      result.remainingAfterForcedCleanup = await killOwnedProcesses(remaining); }
    result.processCleanupVerified = (result.remainingAfterForcedCleanup ?? remaining.length) === 0;
    if (naturalExit.code !== 0 || naturalExit.signal !== null || stopCode || !result.sourceAuthUnchanged) {
      result.status = "failed"; result.errorCode = stopCode || result.errorCode || "S6_EXIT_OR_AUTH_CHANGED";
    }
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return result;
  } finally {
    clearInterval(interval); clearTimeout(timeout); clearTimeout(hardKill);
    if (child?.pid && !exited) {
      try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
    }
    await killOwnedProcesses([...owned.values()]);
    if (child?.pid && !exited) {
      try { child.kill("SIGKILL"); } catch {}
      if (!exited) await new Promise(resolve => child.once("close", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) Promise.resolve().then(() => execute(parseOptions(process.argv.slice(2)))).then(result => {
  console.log(JSON.stringify(result.mode === "plan" ? result : { status: result.status, evidence: result.evidence,
    errorCode: result.errorCode, naturalExit: result.naturalExit, output: parseOptions(process.argv.slice(2)).output }));
  if (result.status === "failed") process.exitCode = 1;
}).catch(error => {
  console.error(/^(?:S6|HANDOFF)_[A-Z0-9_]+$/u.test(error?.code || error?.message || "")
    ? error.code || error.message : "S6_LOCAL_RUN_FAILED"); process.exitCode = 1;
});

module.exports = { parseOptions, readCodexAuth, isolatedEnv, execute, resourceSample, descendantIdentities, stillOwned, killOwnedProcesses };
