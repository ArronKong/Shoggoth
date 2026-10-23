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

function failure(code) { return Object.assign(new Error(code), { code }); }
function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--mode", "--codex-bin", "--codex-auth", "--model", "--output", "--proxy"].includes(key)
      || values.has(key) || !value || value.startsWith("--")) throw failure("MEMORY_SHARING_LIVE_ARGS_INVALID");
    values.set(key, value);
  }
  const mode = values.get("--mode") || "plan";
  if (!["plan", "live", "probe", "opencode-catalog", "opencode"].includes(mode)) throw failure("MEMORY_SHARING_LIVE_ARGS_INVALID");
  const required = ["--codex-bin", "--codex-auth", "--model", "--output"];
  if (mode === "live" && required.some((key) => !values.has(key))) throw failure("MEMORY_SHARING_LIVE_ARGS_INVALID");
  if (["probe", "opencode-catalog", "opencode"].includes(mode) && !values.has("--output")) throw failure("MEMORY_SHARING_LIVE_ARGS_INVALID");
  for (const key of ["--codex-bin", "--codex-auth", "--output"]) {
    if (values.has(key) && !path.isAbsolute(values.get(key))) throw failure("MEMORY_SHARING_LIVE_ABSOLUTE_PATH_REQUIRED");
  }
  const model = values.get("--model");
  if (model && !/^[a-zA-Z0-9._:/-]{1,256}$/u.test(model)) throw failure("MEMORY_SHARING_LIVE_MODEL_INVALID");
  return { mode, codexBin: values.get("--codex-bin"), codexAuth: values.get("--codex-auth"),
    model, output: values.get("--output"),
    proxy: validateProxy(values.get("--proxy") || process.env.HTTPS_PROXY) };
}
function hashFile(target) { return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"); }

async function execute(options) {
  if (options.mode === "plan") return { mode: "plan", credentialFilesRead: false,
    providerCalls: 0, isolation: "Private disposable HOME and Product Service; auth copy only.",
    intendedSteps: ["Codex reader queries static Claude owner", "real MCP search/get and cited answer", "revoke source and rebuild native session", "verify no reader memory/index copies", "source Electron renders real Service history", "probe remaining released native adapters without importing production sessions"],
    blockedRuntime: { runtime: "claude-code", reason: "release policy disabled; no forced enable" } };
  if (process.platform !== "darwin") throw failure("MEMORY_SHARING_LIVE_MACOS_REQUIRED");
  if (fs.existsSync(options.output)) throw failure("MEMORY_SHARING_LIVE_OUTPUT_EXISTS");
  const live = options.mode === "live";
  if (live) {
    const stat = fs.statSync(options.codexBin);
    if (!stat.isFile()) throw failure("MEMORY_SHARING_LIVE_CLI_INVALID");
    fs.accessSync(options.codexBin, fs.constants.X_OK);
  }
  const before = live ? hashFile(options.codexAuth) : null;
  const auth = live ? readCodexAuth(options.codexAuth) : null;
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sgmemlive-"));
  const owned = new Map();
  let child, closed = false, timeout, sampleTimer;
  try {
    fs.chmodSync(root, 0o700);
    for (const name of [".codex", "bin", "workspaces"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    if (live) {
      fs.writeFileSync(path.join(root, ".codex", "auth.json"), JSON.stringify(auth), { flag: "wx", mode: 0o600 });
      fs.writeFileSync(path.join(root, ".codex", "config.toml"),
        `cli_auth_credentials_store = "file"\nmodel = ${JSON.stringify(options.model)}\n`, { mode: 0o600 });
      fs.symlinkSync(fs.realpathSync(options.codexBin), path.join(root, "bin", "codex"));
    }
    // Use only installed executables, with an empty disposable native HOME.
    // Importing executable paths does not import any Runtime credentials/session.
    for (const command of ["grok", "pi", "opencode", "dsh"]) {
      for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        try { const target = fs.realpathSync(path.join(directory, command));
          if (!fs.statSync(target).isFile()) continue; fs.accessSync(target, fs.constants.X_OK);
          fs.symlinkSync(target, path.join(root, "bin", command)); break;
        } catch {}
      }
    }
    const configPath = path.join(root, "worker.json");
    fs.writeFileSync(configPath, JSON.stringify({ root, mode: options.mode, model: options.model, output: options.output,
      electron: require("electron") }), { mode: 0o600 });
    child = spawn(process.execPath, [path.join(__dirname, "native-memory-sharing-live-worker.cjs"), configPath], {
      cwd: root, env: isolatedEnv(root, options.proxy), detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const sampleOwned = () => {
      if (!child?.pid || closed) return;
      try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {}
    };
    sampleOwned(); sampleTimer = setInterval(sampleOwned, 1000);
    const stagePattern = /^MEMORY_SHARING_LIVE_STAGE (?:configure|codex-baseline|codex-borrow|codex-revoke|codex-refreshed|opencode-catalog|opencode-borrow|opencode-revoke|source-ui|runtime-probe)$/u;
    let pending = "", outputBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk); pending = (pending + chunk).slice(-4096);
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (stagePattern.test(line)) process.stdout.write(`${line}\n`);
      }
      if (outputBytes > 2 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) child.kill("SIGTERM");
    });
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", () => reject(failure("MEMORY_SHARING_LIVE_SPAWN_FAILED")));
        child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
      }),
      new Promise((_, reject) => {
        // Real Chat turns, source UI, adapter probes and shutdown each
        // have bounded waits; the entire worker has an additional ceiling.
        timeout = setTimeout(() => reject(failure("MEMORY_SHARING_LIVE_TOTAL_TIMEOUT")), 14 * 60_000);
      }),
    ]);
    clearTimeout(timeout); clearInterval(sampleTimer);
    const resultPath = path.join(root, "result.json");
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8"))
      : { status: "failed", errorCode: "MEMORY_SHARING_LIVE_WORKER_NO_RESULT" };
    result.naturalExit = outcome;
    result.sourceAuthUnchanged = !live || before === hashFile(options.codexAuth);
    result.credentialFilesRead = live;
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
    status: value.status, codex: value.codex?.status, renderer: value.renderer?.status,
    errorCode: value.errorCode, output: parse(process.argv.slice(2)).output,
  })}\n`);
  if (value.status === "failed") process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${/^MEMORY_SHARING_LIVE_[A-Z0-9_]+$/u.test(error?.code || "")
    ? error.code : "MEMORY_SHARING_LIVE_LOCAL_FAILED"}\n`);
  process.exitCode = 1;
});

module.exports = { parse, execute };
