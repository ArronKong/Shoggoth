"use strict";

// 本机 openclaw 侦察 + 网关代启动(host 能力,cli-scanner 先例):
// SetupOverlay 首启梯子的数据源。不进后端契约——这是"连接之前"的本机探测,
// Electron 主进程与 scripts/manage-serve.cjs 都经 static-server 直接使用。
// SECURITY: 只报存在性布尔,绝不返回 token/密钥内容。

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { resolveOpenclawBin } = require("./core/openclaw-backend");
const { readLocalGatewayTokenAsync } = require("./core/device-auth");

const DETECT_CACHE_MS = 3000;   // SetupOverlay ~1.5s 轮询;探测别放大成风暴
const VERSION_CACHE_MS = 60000; // 版本几乎不变
const TCP_PROBE_TIMEOUT_MS = 800;
const START_TIMEOUT_MS = 30000;
const OUTPUT_TAIL = 2000;

let detectCache = null; // { key, at, value }
let versionCache = null; // { bin, at, value }
let statusCache = null; // { bin, at, value: {url, running}|null }

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// openclaw bin 是 `#!/usr/bin/env node` 脚本:GUI/精简环境的 PATH 可能没有 node,
// 子进程 PATH 补上 bin 同目录与常见 node 安装位(R125 兜底)。
function childEnv(bin, overrides = {}) {
  const extra = [path.dirname(bin), "/opt/homebrew/bin", "/opt/homebrew/opt/node@22/bin", "/usr/local/bin"];
  return { ...process.env, PATH: [...extra, process.env.PATH || ""].join(":"), ...overrides };
}

// 服务/GUI 环境下 openclaw 会输出 ANSI 颜色码,先剥再解析(R125 真机踩过:
// 颜色码夹在 "Probe target:" 与 URL 之间,正则静默匹配失败)。
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function runOpenclawCommand(bin, args, { timeout = START_TIMEOUT_MS, envOverrides } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: childEnv(bin, envOverrides) }, (error, stdout, stderr) => {
      resolve({
        error,
        output: stripAnsi(`${stdout || ""}\n${stderr || ""}`).trim().slice(-OUTPUT_TAIL),
      });
    });
  });
}

function localGatewayNeedsTokenRepair(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const auth = config?.gateway?.auth;
    if (config?.gateway?.mode === "remote" || (auth?.mode && auth.mode !== "token")) return false;
    return auth?.token === undefined
      || auth.token === null
      || (typeof auth.token === "string" && !auth.token.trim());
  } catch {
    return false;
  }
}

function clearDetectionCaches() {
  detectCache = null;
  statusCache = null;
}

// resolveOpenclawBin 的兜底是裸 "openclaw"(靠 PATH);检测语义需要"确实存在"。
function resolveExistingBin(injected) {
  if (injected !== undefined) return fileExists(injected) ? injected : null;
  const bin = resolveOpenclawBin();
  if (path.isAbsolute(bin)) return fileExists(bin) ? bin : null;
  const found = (process.env.PATH || "").split(":").map((d) => path.join(d, bin)).find(fileExists);
  return found || null;
}

function probeTcp(url) {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 18792;
    try {
      const u = new URL(String(url));
      host = u.hostname || host;
      port = Number(u.port) || port;
    } catch { /* 用默认 */ }
    const sock = net.connect({ host, port });
    const done = (up) => { try { sock.destroy(); } catch { /* ignore */ } resolve(up); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(TCP_PROBE_TIMEOUT_MS, () => done(false));
  });
}

function readVersion(bin) {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_CACHE_MS) {
    return Promise.resolve(versionCache.value);
  }
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8000, env: childEnv(bin) }, (err, stdout) => {
      const m = stripAnsi(String(stdout || "")).match(/\d{4}\.\d+\.\d+[^\s)]*/);
      const value = err || !m ? null : m[0];
      versionCache = { bin, at: Date.now(), value };
      resolve(value);
    });
  });
}

// 问本机 openclaw 要网关**真实**监听地址与运行态(`gateway status` 的
// "Probe target: ws://…" + "Runtime: running" 行,新老版本都有)。端口随版本/
// 配置漂移(2026.5.x 默认 18789,6.x 默认 18792)——绝不能猜默认值,R125 真机踩过。
function readLocalGatewayStatus(bin) {
  if (statusCache && statusCache.bin === bin && Date.now() - statusCache.at < DETECT_CACHE_MS) {
    return Promise.resolve(statusCache.value);
  }
  return new Promise((resolve) => {
    // --no-probe:免 RPC 连接(Probe target/Runtime 行来自服务配置与 launchd,照常输出)。
    // 带探测的 status 会以只读 scope 连网关触发令牌轮换,把 CLI 的 operator token
    // 收窄成 read-only(R125 实测把本机写权限打没了)——检测绝不能有副作用。
    execFile(bin, ["--no-color", "gateway", "status", "--no-probe"], { timeout: 20000, env: childEnv(bin) }, (err, stdout, stderr) => {
      const text = stripAnsi(`${stdout || ""}\n${stderr || ""}`);
      const m = text.match(/Probe target:\s*(wss?:\/\/\S+)/i);
      const value = m ? { url: m[1], running: /Runtime:\s*running/i.test(text) } : null;
      statusCache = { bin, at: Date.now(), value };
      resolve(value);
    });
  });
}

/**
 * 检测本机 openclaw 状态(SetupOverlay 梯子数据源;结果缓存 3s)。
 * @param {{gatewayUrl?: string, paths?: {configPath?: string, identityPath?: string, binPath?: string}}} [opts]
 *   paths 仅测试注入,默认即线上行为。
 */
async function detectOpenclawHost({ gatewayUrl, paths } = {}) {
  const key = JSON.stringify([gatewayUrl || "", paths || null]);
  if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_CACHE_MS) {
    return detectCache.value;
  }
  const configPath = paths?.configPath ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
  const identityPath = paths?.identityPath ?? path.join(os.homedir(), ".openclaw", "identity", "device.json");
  const binPath = resolveExistingBin(paths?.binPath);
  const [version, gatewayRunning, localStatus] = await Promise.all([
    binPath ? readVersion(binPath) : Promise.resolve(null),
    probeTcp(gatewayUrl),
    binPath ? readLocalGatewayStatus(binPath) : Promise.resolve(null),
  ]);
  const value = {
    binPath,
    version,
    gatewayRunning,
    // 本机网关真实地址/运行态(status 探出);configured 端口不对时向导据此自动采用。
    localGatewayUrl: localStatus?.url ?? null,
    localGatewayRunning: localStatus?.running ?? false,
    configExists: fileExists(configPath),
    localTokenReadable: (await readLocalGatewayTokenAsync(configPath)) !== undefined,
    identityExists: fileExists(identityPath),
  };
  detectCache = { key, at: Date.now(), value };
  return value;
}

/**
 * 代跑网关启动。mode="start" → `openclaw daemon start`;"install" → `daemon install`
 * (装并启动,首装机器无 launchd 服务时的第二级)。本机明确配置 token 认证、但 token
 * 缺失时，start 先按 OpenClaw 官方修复路径生成 token，再重启服务。doctor 输出可能含
 * 凭据，任何情况下都不回传给 renderer。
 * @param {{mode?: "start"|"install", paths?: {binPath?: string, configPath?: string}}} [opts]
 *   paths 仅测试注入,默认即线上行为。
 */
async function startOpenclawGateway({ mode, paths } = {}) {
  const sub = mode === "install" ? "install" : "start";
  const bin = resolveExistingBin(paths?.binPath);
  if (!bin) return { ok: false, code: null, output: "openclaw not installed" };
  const configPath = paths?.configPath ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
  const envOverrides = paths?.configPath ? { OPENCLAW_CONFIG_PATH: configPath } : undefined;

  if (sub === "start" && localGatewayNeedsTokenRepair(configPath)) {
    // --generate-gateway-token 本身就是显式修复开关；不加 --yes，避免 doctor
    // 顺带接受其它可选修复。--non-interactive 只关闭提问，适合首启自动连接。
    const generated = await runOpenclawCommand(
      bin,
      ["--no-color", "doctor", "--generate-gateway-token", "--non-interactive"],
      { timeout: 120000, envOverrides },
    );
    clearDetectionCaches();
    if (generated.error) {
      const code = typeof generated.error.code === "number" ? generated.error.code : null;
      return { ok: false, code, output: "openclaw doctor 未能生成 gateway token" };
    }
    // 只有 Shoggoth 真能读到的新 token 才算修复成功。未来 OpenClaw 若改为写
    // 无法解析的 SecretRef，这里会明确失败，不会制造“已修复但仍认证失败”的假象。
    if ((await readLocalGatewayTokenAsync(configPath)) === undefined) {
      return { ok: false, code: null, output: "openclaw doctor 未生成可读取的 gateway token" };
    }
    const restarted = await runOpenclawCommand(
      bin,
      ["--no-color", "daemon", "restart"],
      { envOverrides },
    );
    clearDetectionCaches();
    if (restarted.error) {
      const code = typeof restarted.error.code === "number" ? restarted.error.code : null;
      return { ok: false, code, output: "gateway token 已生成，但 OpenClaw 网关重启失败" };
    }
    return { ok: true, code: 0, output: "OpenClaw gateway token 已配置并重启" };
  }

  const result = await runOpenclawCommand(
    bin,
    ["--no-color", "daemon", sub],
    { envOverrides },
  );
  clearDetectionCaches(); // 启动改变了世界;下次检测走新鲜数据
  const code = typeof result.error?.code === "number" ? result.error.code : result.error ? null : 0;
  return { ok: !result.error, code, output: result.output };
}

/** 创建 host supervisor 契约错误；生产 capability smoke 按稳定 code 断言零副作用。 */
function hostControllerError(code, message) {
  const error = new Error(message);
  error.name = "OpenClawHostControllerError";
  error.code = code;
  error.status = 409;
  return error;
}

/**
 * 创建 OpenClaw host controller。当前 CLI 只支持普通 start/install，不具备网关外
 * drain、paused-start 或可恢复 token，必须如实 fail-closed；未来 supervisor 可通过
 * 显式 remoteController 注入完整认证契约，不能偷用 daemon start 冒充安全重启。
 */
function createOpenclawHostController({ remoteController } = {}) {
  if (remoteController) {
    const capabilities = remoteController.capabilities || {};
    const complete = capabilities.drain === true
      && capabilities.restartPaused === true
      && capabilities.waitHealthy === true
      && typeof remoteController.acquireDrain === "function"
      && typeof remoteController.restartPaused === "function"
      && typeof remoteController.waitHealthy === "function";
    if (!complete) {
      throw hostControllerError(
        "runtime_restart_unavailable",
        "远程 controller 必须显式提供认证 drain/restartPaused/waitHealthy 契约",
      );
    }
    return Object.freeze({
      topology: "remote",
      capabilities: Object.freeze({
        drain: true,
        recoverDrain: capabilities.recoverDrain === true && typeof remoteController.recoverDrain === "function",
        restartPaused: true,
        waitHealthy: true,
      }),
      acquireDrain: (...args) => remoteController.acquireDrain(...args),
      recoverDrain: (...args) => remoteController.recoverDrain?.(...args) ?? null,
      restartPaused: (...args) => remoteController.restartPaused(...args),
      waitHealthy: (...args) => remoteController.waitHealthy(...args),
    });
  }

  /** 本机 CLI 不支持 supervisor drain，任何 acquire/recover 都稳定拒绝。 */
  const unsupportedDrain = async () => {
    throw hostControllerError(
      "runtime_drain_unsupported",
      "当前 OpenClaw CLI 未提供 supervisor drain/paused-start 契约",
    );
  };
  /** 本机 CLI 的普通 daemon start 不能冒充带 token 的 paused restart/health。 */
  const unavailableRestart = async () => {
    throw hostControllerError(
      "runtime_restart_unavailable",
      "当前 OpenClaw CLI 未提供安全 paused restart 契约",
    );
  };
  return Object.freeze({
    topology: "local",
    capabilities: Object.freeze({
      drain: false,
      recoverDrain: false,
      restartPaused: false,
      waitHealthy: false,
    }),
    acquireDrain: unsupportedDrain,
    recoverDrain: unsupportedDrain,
    restartPaused: unavailableRestart,
    waitHealthy: unavailableRestart,
  });
}

module.exports = { detectOpenclawHost, startOpenclawGateway, createOpenclawHostController };
