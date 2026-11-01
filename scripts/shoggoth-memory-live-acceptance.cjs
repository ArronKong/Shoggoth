#!/usr/bin/env node
"use strict";

// Explicit real-provider smoke. Default plan mode reads no credentials.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readCodexAuth, isolatedEnv, descendantIdentities, stillOwned,
  killOwnedProcesses } = require("./runtime-v2-live-acceptance.cjs");
const { validateProxy } = require("./runtime-handoff-pi-evaluator.cjs");
const runtimeAuth = require("./shoggoth-memory-live-runtime-auth.cjs");

function failure(code) { return Object.assign(new Error(code), { code }); }
function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--mode", "--codex-bin", "--codex-auth", "--model", "--output", "--proxy", "--suite", "--rollback-source",
      "--runtime", "--runtime-bin", "--runtime-auth", "--runtime-config", "--runtime-socket-directory",
      "--memory-codex-bin", "--memory-codex-auth", "--memory-model"].includes(key)
      || values.has(key) || !value || value.startsWith("--")) throw failure("MEMORY_LIVE_ARGS_INVALID");
    values.set(key, value);
  }
  const mode = values.get("--mode") || "plan";
  if (!["plan", "live"].includes(mode)) throw failure("MEMORY_LIVE_ARGS_INVALID");
  const suite = values.get("--suite") || "default";
  if (!["default", "repair"].includes(suite)) throw failure("MEMORY_LIVE_ARGS_INVALID");
  const runtime = values.get("--runtime") || "codex";
  if (runtime !== "codex" && (!Object.hasOwn(runtimeAuth.RUNTIMES, runtime) || suite !== "repair")) throw failure("MEMORY_LIVE_RUNTIME_UNSUPPORTED");
  const memoryKeys = ["--memory-codex-bin", "--memory-codex-auth", "--memory-model"];
  if (memoryKeys.some(key => values.has(key)) && (memoryKeys.some(key => !values.has(key))
    || suite !== "repair" || runtime === "codex")) throw failure("MEMORY_LIVE_ARGS_INVALID");
  const required = ["--model", "--output", ...(runtime === "codex" ? ["--codex-bin", "--codex-auth"] : ["--runtime-bin", "--runtime-auth"]),
    ...(runtime === "opencode" ? ["--runtime-config"] : [])];
  if (mode === "live" && required.some((key) => !values.has(key))) throw failure("MEMORY_LIVE_ARGS_INVALID");
  for (const key of ["--codex-bin", "--codex-auth", "--output", "--rollback-source", "--runtime-bin", "--runtime-auth", "--runtime-config", "--runtime-socket-directory", "--memory-codex-bin", "--memory-codex-auth"]) {
    if (values.has(key) && !path.isAbsolute(values.get(key))) throw failure("MEMORY_LIVE_ABSOLUTE_PATH_REQUIRED");
  }
  const model = values.get("--model");
  if ([model, values.get("--memory-model")].some(value => value && !/^[a-zA-Z0-9._:/-]{1,256}$/u.test(value))) throw failure("MEMORY_LIVE_MODEL_INVALID");
  if (values.has("--runtime-socket-directory") && runtime !== "grok-build") throw failure("MEMORY_LIVE_ARGS_INVALID");
  return { mode, suite, runtime, runtimeSocketDirectory: values.get("--runtime-socket-directory"), runtimeBin: values.get("--runtime-bin"), runtimeAuth: values.get("--runtime-auth"), runtimeConfig: values.get("--runtime-config"),
    rollbackSource: values.get("--rollback-source"), codexBin: values.get("--codex-bin"), codexAuth: values.get("--codex-auth"),
    memoryCodexBin: values.get("--memory-codex-bin"), memoryCodexAuth: values.get("--memory-codex-auth"), memoryModel: values.get("--memory-model"),
    model, output: values.get("--output"),
    proxy: validateProxy(values.get("--proxy") || process.env.HTTPS_PROXY) };
}
function hashFile(target) { return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"); }

async function execute(options) {
  if (options.mode === "plan") return { mode: "plan", credentialFilesRead: false,
    providerCalls: 0, isolation: "Disposable HOME and Profile; source auth copied, not modified.",
    intendedSteps: options.suite === "repair" ? ["save-new-session", "chinese-recall", "correct-restart", "borrow-revoke",
      "distinct-question-signals", "forget-no-revival", "diagnostics", "source-downgrade"] : options.suite === "p4" ? ["e5-save", "e5-save-other", "e5-bilingual",
      "e5-forget", "e5-after-forget", "e5-unknown"] : ["chat-save", "chat-new-session-original-search", "chat-correct", "chat-forget",
      "chat-new-session-after-forget-search", "inspiration-chat-save",
      "inspiration-chat-new-session-original-search", "inspiration-chat-correct",
      "inspiration-chat-forget", "inspiration-chat-new-session-after-forget-search",
      "model-only-candidate"] };
  if (process.platform !== "darwin") throw failure("MEMORY_LIVE_MACOS_REQUIRED");
  if (fs.existsSync(options.output)) throw failure("MEMORY_LIVE_OUTPUT_EXISTS");
  const runtime = options.runtime || "codex", binary = runtime === "codex" ? options.codexBin : options.runtimeBin;
  const stat = fs.statSync(binary);
  if (!stat.isFile()) throw failure("MEMORY_LIVE_CLI_INVALID");
  fs.accessSync(binary, fs.constants.X_OK);
  const independent = options.memoryModel !== undefined;
  if (independent && (runtime === "codex" || options.suite !== "repair" || !options.memoryCodexBin || !options.memoryCodexAuth)) throw failure("MEMORY_LIVE_ARGS_INVALID");
  const sourceFiles = [...(runtime === "codex" ? [options.codexAuth] : runtimeAuth.sources(options)),
    ...(independent ? [options.memoryCodexAuth] : [])];
  const before = sourceFiles.map(file => hashFile(file));
  const auth = runtime === "codex" ? readCodexAuth(options.codexAuth) : null;
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgmemlive-"));
  const owned = new Map();
  let child, closed = false, timeout, sampleTimer;
  try {
    fs.chmodSync(root, 0o700);
    for (const name of [".codex", "bin", "workspaces"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    let runtimeConfig = {};
    if (runtime === "codex") {
      fs.writeFileSync(path.join(root, ".codex", "auth.json"), JSON.stringify(auth), { flag: "wx", mode: 0o600 });
      fs.writeFileSync(path.join(root, ".codex", "config.toml"),
        `cli_auth_credentials_store = "file"\nmodel = ${JSON.stringify(options.model)}\n`, { mode: 0o600 });
      fs.symlinkSync(fs.realpathSync(binary), path.join(root, "bin", "codex"));
    } else runtimeConfig = await runtimeAuth.prepare(root, options);
    if (independent) {
      const memoryAuth = readCodexAuth(options.memoryCodexAuth);
      fs.accessSync(options.memoryCodexBin, fs.constants.X_OK);
      fs.writeFileSync(path.join(root, ".codex", "auth.json"), JSON.stringify(memoryAuth), { flag: "wx", mode: 0o600 });
      fs.writeFileSync(path.join(root, ".codex", "config.toml"),
        `cli_auth_credentials_store = "file"\nmodel = ${JSON.stringify(options.memoryModel)}\n`, { flag: "wx", mode: 0o600 });
      fs.symlinkSync(fs.realpathSync(options.memoryCodexBin), path.join(root, "bin", "codex"));
      runtimeConfig.authFiles = [...runtimeConfig.authFiles, ".codex/auth.json"];
      runtimeConfig.memoryText = { model: options.memoryModel };
    }
    const runtimeSandbox = runtime === "antigravity"
      ? require("./shoggoth-memory-live-isolation.cjs").antigravityRuntimeSandbox(root, path.resolve(__dirname, ".."), options.rollbackSource) : null;
    if (runtimeSandbox) Object.assign(runtimeConfig.isolation, { sandboxPolicy: runtimeSandbox.policyPath, osSandbox: runtimeSandbox.evidence });
    const configPath = path.join(root, "worker.json");
    fs.writeFileSync(configPath, JSON.stringify({ root, model: options.model, ...runtimeConfig,
      ...(options.preflightOnly === true ? { preflightOnly: true } : {}),
      ...(options.suite === "p4" ? { suite: "p4" } : {}),
      ...(options.suite === "repair" ? { suite: "repair", rollbackSource: options.rollbackSource } : {}) }), { mode: 0o600 });
    child = spawn(process.execPath, [path.join(__dirname, options.suite === "repair" ? "shoggoth-memory-repair-live-worker.cjs" : "shoggoth-memory-live-worker.cjs"), configPath], {
      cwd: root, env: { ...isolatedEnv(root, options.proxy), XDG_DATA_HOME: path.join(root, ".local/share"),
        XDG_CONFIG_HOME: path.join(root, ".config"), GROK_HOME: path.join(root, ".grok"), DSH_HOME: path.join(root, ".dsh") },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const sampleOwned = () => {
      if (!child?.pid || closed) return;
      try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
    };
    sampleOwned(); sampleTimer = setInterval(sampleOwned, 1000);
    const stagePattern = /^MEMORY_LIVE_STAGE (?:e5-(?:save|save-other|bilingual|forget|after-forget|unknown)|p1-save|p1-search-original|p1-correct|p1-forget|p1-search-after-forget|p1-inspiration-bootstrap-(?:save|search|after-forget)|p1-inspiration-(?:save|search-original|correct|forget|search-after-forget)|p3-seed|p3-extract)$/u;
    let pending = "", outputBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk); pending = (pending + chunk).slice(-4096);
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (stagePattern.test(line) || options.suite === "repair" && /^MEMORY_LIVE_STAGE repair-[a-z0-9-]{1,64}$/u.test(line)) process.stdout.write(`${line}\n`);
      }
      if (outputBytes > 2 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) child.kill("SIGTERM");
    });
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", () => reject(failure("MEMORY_LIVE_SPAWN_FAILED")));
        child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
      }),
      new Promise((_, reject) => {
        // Five Chat turns, three Inspiration bootstrap Runs, five direct
        // Inspiration turns and P3 each have their own bounded waits. Allow
        // those ceilings plus product IPC and shutdown without an open-ended run.
        timeout = setTimeout(() => reject(failure("MEMORY_LIVE_TOTAL_TIMEOUT")), 32 * 60_000);
      }),
    ]);
    clearTimeout(timeout); clearInterval(sampleTimer);
    const resultPath = path.join(root, "result.json");
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
      : { status: "failed", errorCode: "MEMORY_LIVE_WORKER_NO_RESULT" };
    result.naturalExit = outcome;
    result.sourceFilesUnchanged = sourceFiles.map((file, index) => ({ path: file, unchanged: before[index] === hashFile(file) }));
    result.sourceAuthUnchanged = result.sourceFilesUnchanged.every(value => value.unchanged);
    result.remainingOwnedProcesses = [...owned.values()].filter(stillOwned).length;
    if (outcome.code !== 0 || outcome.signal !== null || !result.sourceAuthUnchanged
      || result.remainingOwnedProcesses) result.status = "failed";
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return result;
  } finally {
    clearTimeout(timeout); clearInterval(sampleTimer);
    if (child?.pid && !closed) {
      try { child.kill("SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (child?.pid) {
      try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
    }
    await killOwnedProcesses([...owned.values()]);
    if (child?.pid && !closed) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) Promise.resolve().then(() => execute(parse(process.argv.slice(2)))).then((value) => {
  process.stdout.write(`${JSON.stringify(value.mode === "plan" ? value : {
    status: value.status, p1: value.p1?.status, p1Inspiration: value.p1Inspiration?.status,
    p3: value.p3?.status, repair: value.scenarios,
    errorCode: value.errorCode, output: parse(process.argv.slice(2)).output,
  })}\n`);
  if (value.status === "failed") process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${/^MEMORY_LIVE_[A-Z0-9_]+$/u.test(error?.code || "")
    ? error.code : "MEMORY_LIVE_LOCAL_FAILED"}\n`);
  process.exitCode = 1;
});

module.exports = { parse, execute };
