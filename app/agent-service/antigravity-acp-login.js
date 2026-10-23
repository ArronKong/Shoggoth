"use strict";

// Settings sign-in for Antigravity, run by the user in Terminal through the
// Shoggoth executable in Node mode. It installs the pinned official ACP server
// when missing, then runs the server's Google sign-in. Unlike background hosts,
// this is the one place the server may open a browser window.
const { spawn } = require("node:child_process");
const { AcpJsonlClient } = require("./acp-jsonl-client");
const {
  ANTIGRAVITY_ACP_SERVER_VERSION,
  antigravityAcpInstallState,
  installAntigravityAcpServer,
  verifyAntigravityAcpServer,
} = require("./antigravity-acp-distribution");
const { ACP_NAMING, antigravityAcpSpawnEnvironment } = require("./antigravity-acp-runtime-host");
const { antigravityAcpAuthType, prepareAntigravityAcpHome } = require("./antigravity-runtime-config");
const {
  prepareAntigravityKeychainContext,
  prepareAntigravityRuntimeAccountHome,
} = require("./antigravity-runtime-paths");
const { resolveCanonicalServicePaths, systemHome } = require("./paths");
const { serviceError } = require("./security");

const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/u;
const INITIALIZE_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const STOP_GRACE_MS = 3_000;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

async function stopServer(child, closed) {
  try { child.stdin?.end?.(); } catch {}
  if (await Promise.race([closed.then(() => true), delay(STOP_GRACE_MS).then(() => false)])) return;
  killGroup(child.pid, "SIGTERM");
  if (await Promise.race([closed.then(() => true), delay(STOP_GRACE_MS).then(() => false)])) return;
  killGroup(child.pid, "SIGKILL");
}

function canceled() {
  return serviceError("AUTH_LOGIN_CANCELED", "登录已取消");
}

// The Settings sign-in runs this inside the Service (`signal` cancels it,
// `onStage`/`onAuthUrl` report progress); the terminal fallback only logs.
async function loginAntigravityAcp(options = {}) {
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  const onStage = options.onStage || (() => {});
  const signal = options.signal;
  const paths = options.paths || resolveCanonicalServicePaths();
  const parentEnv = options.parentEnv || process.env;
  const userHome = options.userHome || systemHome();
  if (signal?.aborted) throw canceled();
  const install = await (options.installState || antigravityAcpInstallState)({ paths });
  if (install.state === "unsupported") {
    throw serviceError("ANTIGRAVITY_ACP_PLATFORM_UNSUPPORTED", "当前设备平台暂不支持 Antigravity 官方服务端");
  }
  if (install.state !== "installed") {
    onStage("installing");
    log(`正在下载并校验 Antigravity 官方服务端 ${ANTIGRAVITY_ACP_SERVER_VERSION}（约 107 MB）…`);
    try {
      await (options.installServer || installAntigravityAcpServer)({ paths, parentEnv, signal });
    } catch (error) {
      if (signal?.aborted) throw canceled();
      throw error;
    }
    log("安装完成，签名与文件摘要校验通过。");
  }
  if (signal?.aborted) throw canceled();
  onStage("starting");
  const server = await (options.verifyServer || verifyAntigravityAcpServer)({ paths });
  const home = prepareAntigravityRuntimeAccountHome(paths, options.runtimeAccountId);
  prepareAntigravityKeychainContext({
    home,
    userHome,
    trustedRoot: paths.trustedRoot,
    platform: options.platform,
    execFileSync: options.securityExecFileSync,
  });
  const acpHome = prepareAntigravityAcpHome({ home, trustedRoot: paths.trustedRoot });
  const child = (options.spawnProcess || spawn)(server.serverPath, [], {
    cwd: home,
    env: antigravityAcpSpawnEnvironment({
      parentEnv, userHome, home, geminiHome: acpHome.geminiHome, openBrowser: true,
    }),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let pending = "";
  let shownUrl = false;
  child.stderr.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const url = AUTH_URL_PATTERN.exec(pending.slice(0, newline))?.[0];
      pending = pending.slice(newline + 1);
      if (url && !shownUrl) {
        shownUrl = true;
        options.onAuthUrl?.(url);
        log("已在浏览器中打开 Google 登录页；如果没有自动打开，请复制下面的链接到浏览器：");
        log(url);
      }
    }
    if (pending.length > 64 * 1024) pending = pending.slice(-8 * 1024);
  });
  const client = new AcpJsonlClient(child, { naming: ACP_NAMING, stderrAuthHints: false });
  // Canceling rejects the pending request; `finally` then stops the server.
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(canceled());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const request = (method, params, requestOptions) => Promise.race([
    client.request(method, params, requestOptions), aborted,
  ]);
  try {
    if (signal?.aborted) throw canceled();
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shoggoth", version: String(options.packageVersion || "0.0.0") },
    }, { timeoutMs: options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS });
    onStage("waiting");
    log("正在登录 Google 账号，请在浏览器中完成授权…");
    await request("authenticate", { methodId: "oauth-personal" }, {
      timeoutMs: options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    });
    const authType = antigravityAcpAuthType({ settingsPath: acpHome.settingsPath, trustedRoot: paths.trustedRoot });
    if (authType === null) {
      throw serviceError("RUNTIME_AUTH_REQUIRED", "Antigravity 没有记录登录方式，请重新登录");
    }
    log("登录成功。请回到 Shoggoth，点击「我已登录」。");
    return { authType };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await client.terminate(); } catch {}
    await stopServer(child, closed);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--account") {
    throw serviceError("ANTIGRAVITY_LOGIN_ARGS_INVALID", "用法：antigravity-acp-login.js --account <runtimeAccountId>");
  }
  return { runtimeAccountId: argv[1] };
}

if (require.main === module) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  loginAntigravityAcp(options).then(() => process.exit(0), (error) => {
    // This is the user's own terminal: show the server's reason when it gave one.
    const detail = typeof error?.rpcDetail === "string" ? `\n${error.rpcDetail}` : "";
    process.stderr.write(`登录未完成（${error?.code || "ANTIGRAVITY_LOGIN_FAILED"}）：${error?.message || "未知错误"}${detail}\n`);
    process.exit(1);
  });
}

module.exports = { loginAntigravityAcp };
