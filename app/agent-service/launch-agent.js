"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { assertStableAppPaths, inferAppPath } = require("./bundle-paths");
const { readClientToken, requestService } = require("./client");
const { resolveServicePaths, resolveCanonicalServicePaths, systemHome } = require("./paths");
const { normalizeProxyEnvironment } = require("./proxy-environment");
const { PROTOCOL_VERSION } = require("./server");
const { ensurePrivateDirectory, lstatIfExists, rejectSymlink, serviceError } = require("./security");

const LAUNCH_AGENT_LABEL = "com.shoggoth.agent-service";
const ROLE_ARGUMENT = "--shoggoth-internal-role=agent-service";
const DEFAULT_LAUNCHCTL_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;
// bootout 返回成功后，真实 launchd 在带 Electron/Codex 子进程的 App 上可用
// 两秒以上才从 print 域消失。保留有界五秒确认窗，避免 Service 已停止但 UI
// 收到 503；权限错误仍由 disable/bootout 原样 fail closed。
const DEFAULT_STOP_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_CONFIRM_INTERVAL_MS = 50;
const MAX_SCUTIL_PROXY_BYTES = 64 * 1024;

function boundedHealthOption(value, fallback, min, max, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new TypeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return resolved;
}

function healthClockOption(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "function") throw new TypeError(`${name} must be a function`);
  return resolved;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function proxyError() {
  return serviceError("LAUNCH_AGENT_PROXY_INVALID", "LaunchAgent proxy configuration is invalid");
}

function normalizeLaunchAgentProxyEnvironment(value = {}) {
  return normalizeProxyEnvironment(value, proxyError);
}

function parseMacSystemProxyOutput(output) {
  if (Buffer.isBuffer(output)) output = output.toString("utf8");
  if (typeof output !== "string" || !output.isWellFormed()
    || Buffer.byteLength(output, "utf8") > MAX_SCUTIL_PROXY_BYTES) {
    throw proxyError();
  }
  const fields = {};
  const exceptions = [];
  let readingExceptions = false;
  for (const line of output.split(/\r?\n/u)) {
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{\s*$/u.test(line)) {
      readingExceptions = true;
      continue;
    }
    if (readingExceptions) {
      if (/^\s*\}\s*$/u.test(line)) {
        readingExceptions = false;
        continue;
      }
      const match = line.match(/^\s*\d+\s*:\s*(.*?)\s*$/u);
      if (match) exceptions.push(match[1]);
      continue;
    }
    const match = line.match(/^\s*(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|SOCKSEnable|SOCKSProxy|SOCKSPort)\s*:\s*(.*?)\s*$/u);
    if (match) fields[match[1]] = match[2];
  }
  const endpoint = (prefix, scheme) => {
    if (fields[`${prefix}Enable`] !== "1") return null;
    const host = fields[`${prefix}Proxy`];
    const port = Number(fields[`${prefix}Port`]);
    if (typeof host !== "string" || host.length === 0 || host.length > 1024
      || /[\s\u0000-\u001f\u007f\/@?#]/u.test(host)
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    const hostLiteral = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `${scheme}://${hostLiteral}:${port}`;
  };
  const raw = {};
  const http = endpoint("HTTP", "http");
  const https = endpoint("HTTPS", "http");
  const socks = endpoint("SOCKS", "socks5");
  if (http) raw.HTTP_PROXY = http;
  if (https) raw.HTTPS_PROXY = https;
  if (socks) raw.ALL_PROXY = socks;
  const noProxy = exceptions
    .filter((item) => item !== "<local>" && item.length > 0
      && item.length <= 1024 && !/[,\s\u0000-\u001f\u007f]/u.test(item))
    .map((item) => item.startsWith("*.") ? item.slice(1) : item);
  if (noProxy.length > 0) raw.NO_PROXY = [...new Set(noProxy)].join(",");
  return normalizeLaunchAgentProxyEnvironment(raw);
}

function readMacSystemProxyEnvironment(options = {}) {
  if ((options.platform || process.platform) !== "darwin") return {};
  const run = options.execFileSync || execFileSync;
  try {
    const output = run("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      maxBuffer: MAX_SCUTIL_PROXY_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseMacSystemProxyOutput(output);
  } catch {
    return {};
  }
}

function buildLaunchAgentPlist(config) {
  const strings = [config.executablePath, ROLE_ARGUMENT]
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const proxyEnvironment = normalizeLaunchAgentProxyEnvironment(config.proxyEnvironment || {});
  const proxyStrings = Object.entries(proxyEnvironment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  // This service handles user-initiated chat over Unix sockets, so XPC cannot
  // promote an Adaptive job. Background throttling is inherited by native CLIs
  // and can stall even agy --version in dyld beyond its startup deadline.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SHOGGOTH_INTERNAL_LAUNCH</key>
    <string>launch-agent-v1</string>
    <key>SHOGGOTH_LAUNCHD_LABEL</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>SHOGGOTH_BOOTSTRAP_PATH</key>
    <string>${xmlEscape(config.bootstrapPath)}</string>
${proxyStrings ? `${proxyStrings}\n` : ""}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

function writePrivateFile(target, contents) {
  rejectSymlink(target);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    // 目标若被并发替换成 symlink，rename 只会替换目录项，不会跟随链接。
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function defaultRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", signal: options.signal }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

function isLaunchctlNotFound(error) {
  const detail = `${error?.message || ""}\n${error?.stderr || ""}`;
  return [
    /Could not find service/i,
    /No such process/i,
    /service is not loaded/i,
    /not found in domain/i,
  ].some((pattern) => pattern.test(detail));
}

function isLaunchctlAlreadyLoaded(error) {
  const detail = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /service already loaded/i.test(detail);
}

function createLaunchAgentController(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = path.resolve(options.homeDir || systemHome());
  const uid = options.uid ?? os.userInfo().uid;
  const runner = options.runner || defaultRunner;
  const clearExtendedAttributes = options.clearExtendedAttributes || ((target) => {
    // macOS 可能给由下载 App 创建的 plist 继承 com.apple.provenance；launchd
    // 会对该 plist 直接返回 EIO。plist 是本应用刚生成的固定配置，加载前清除
    // 它自身的扩展属性，不触碰 App 或用户数据。
    execFileSync("/usr/bin/xattr", ["-c", target], { stdio: "ignore" });
  });
  const resolveProxyEnvironment = options.resolveProxyEnvironment
    || (() => readMacSystemProxyEnvironment({ platform }));
  if (typeof resolveProxyEnvironment !== "function") {
    throw new TypeError("resolveProxyEnvironment must be a function");
  }
  const serviceVersion = String(options.serviceVersion || require("../../package.json").version);
  const servicePaths = options.servicePaths || (platform !== "darwin" ? resolveServicePaths({ homeDir }) : options.homeDir
    ? resolveCanonicalServicePaths({ userInfo: () => ({ homedir: homeDir }) })
    : resolveCanonicalServicePaths());
  const healthTimeoutMs = boundedHealthOption(
    options.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 1, 45_000, "healthTimeoutMs",
  );
  const healthIntervalMs = boundedHealthOption(
    options.healthIntervalMs, 100, 1, 1_000, "healthIntervalMs",
  );
  const healthNow = healthClockOption(options.healthNow, Date.now, "healthNow");
  const healthDelay = healthClockOption(
    options.healthDelay,
    (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    "healthDelay",
  );
  const launchctlTimeoutMs = options.launchctlTimeoutMs ?? DEFAULT_LAUNCHCTL_TIMEOUT_MS;
  const stopConfirmTimeoutMs = options.stopConfirmTimeoutMs ?? DEFAULT_STOP_CONFIRM_TIMEOUT_MS;
  const stopConfirmIntervalMs = options.stopConfirmIntervalMs ?? DEFAULT_STOP_CONFIRM_INTERVAL_MS;
  const healthProbe = options.healthProbe || (async ({ timeoutMs }) => {
    const token = readClientToken(servicePaths);
    return requestService(servicePaths, {
      method: "service.status",
      token,
      version: PROTOCOL_VERSION,
    }, { timeoutMs });
  });
  const processExecutablePath = options.processExecutablePath || process.execPath;
  const resourcesPath = options.resourcesPath || process.resourcesPath || "";
  const appConfig = {
    appPath: options.appPath || inferAppPath(processExecutablePath, options.applicationsRoot),
    executablePath: options.executablePath || processExecutablePath,
    resourcesPath,
    bootstrapPath: options.bootstrapPath || path.join(resourcesPath, "app.asar", "app", "bootstrap.js"),
  };
  const stateDir = path.join(homeDir, "Library", "Application Support", "Shoggoth Agent Service", "launch-agent");
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const paths = Object.freeze({
    stateDir,
    statusPath: path.join(stateDir, "status.json"),
    plistPath: path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
  });

  function unsupported() {
    return { supported: false, reason: "unsupported-platform" };
  }

  function config() {
    const stablePaths = assertStableAppPaths(appConfig, {
      applicationsRoot: options.applicationsRoot,
    });
    return {
      ...stablePaths,
      proxyEnvironment: normalizeLaunchAgentProxyEnvironment(resolveProxyEnvironment()),
    };
  }

  function desiredPlist() {
    return buildLaunchAgentPlist(config());
  }

  function writeStatus(enabled) {
    const current = config();
    writePrivateFile(paths.statusPath, `${JSON.stringify({
      label: LAUNCH_AGENT_LABEL,
      appPath: current.appPath,
      executablePath: current.executablePath,
      bootstrapPath: current.bootstrapPath,
      enabled,
      updatedAt: Date.now(),
    }, null, 2)}\n`);
  }

  async function runLaunchctl(args, ignoreFailure = false) {
    const abortController = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => runner("/bin/launchctl", args, {
          signal: abortController.signal,
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(serviceError("LAUNCHCTL_TIMEOUT", "launchctl 操作超时"));
          }, launchctlTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (ignoreFailure) return { code: error.code ?? 1, ignored: true };
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function queryLaunchState() {
    const domain = `gui/${uid}`;
    const disabledResult = await runLaunchctl(["print-disabled", domain]);
    const escapedLabel = LAUNCH_AGENT_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const disabledMatch = String(disabledResult.stdout || "").match(
      new RegExp(`[\"']?${escapedLabel}[\"']?\\s*=>\\s*(true|false|enabled|disabled)`, "i"),
    );
    const disabledValue = disabledMatch?.[1]?.toLowerCase();
    const disabled = disabledValue === "true" || disabledValue === "disabled";
    let loaded = false;
    let loadedExecutable = null;
    try {
      const loadedResult = await runLaunchctl(["print", `${domain}/${LAUNCH_AGENT_LABEL}`]);
      loaded = true;
      const programMatch = String(loadedResult.stdout || "").match(/^\s*program\s*=\s*(.+?)\s*$/im);
      if (programMatch) {
        loadedExecutable = programMatch[1].replace(/^['"]|['"]$/g, "");
      }
    } catch (error) {
      if (!isLaunchctlNotFound(error)) throw error;
    }
    return { disabled, loaded, loadedExecutable };
  }

  async function waitForStoppedState() {
    const deadline = Date.now() + stopConfirmTimeoutMs;
    for (;;) {
      const state = await queryLaunchState();
      if (state.disabled && !state.loaded) return state;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return state;
      const delayMs = Math.min(stopConfirmIntervalMs, remaining);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  function healthNotConfirmed() {
    return serviceError("SERVICE_HEALTH_NOT_CONFIRMED", "LaunchAgent Service 健康状态未确认");
  }

  function assertHealthBudget(deadline) {
    if (healthNow() >= deadline) throw healthNotConfirmed();
  }

  function createStartBudget() {
    const startedAt = healthNow();
    const deadline = startedAt + healthTimeoutMs;
    // 默认 45 秒预算给已 loaded job 完整 40 秒自行恢复，并保留至多 5 秒
    // 给安全 stop/bootstrap；小预算按 20% 缩放，避免恢复预算吃光总 deadline。
    const recoveryReserveMs = healthTimeoutMs <= 1 ? 0 : Math.min(
      5_000,
      healthTimeoutMs - 1,
      Math.max(1, Math.floor(healthTimeoutMs / 5)),
    );
    const loadedGraceMs = healthTimeoutMs - recoveryReserveMs;
    return {
      deadline,
      loadedHealthDeadline: Math.min(deadline, startedAt + loadedGraceMs),
    };
  }

  async function confirmServiceHealthy(deadline, allowFinalImmediateProbe = false) {
    let nextAttemptAt = healthNow();
    let finalImmediateProbeAttempted = false;
    for (;;) {
      const remaining = deadline - healthNow();
      if (remaining < 0) break;
      if (remaining === 0) {
        if (!allowFinalImmediateProbe || finalImmediateProbeAttempted) break;
        finalImmediateProbeAttempted = true;
      }
      const attemptTimeoutMs = Math.max(1, Math.min(500, remaining));
      let timer;
      try {
        const status = await Promise.race([
          Promise.resolve(healthProbe({
            paths: servicePaths,
            protocolVersion: PROTOCOL_VERSION,
            serviceVersion,
            timeoutMs: attemptTimeoutMs,
          })),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(serviceError("HEALTH_PROBE_TIMEOUT", "probe timeout")), attemptTimeoutMs);
          }),
        ]);
        if (status?.healthy === true
          && status.protocolVersion === PROTOCOL_VERSION
          && status.serviceVersion === serviceVersion) return status;
      } catch {
        // launchctl loaded 只表示 job 已注册；socket 可能尚未发布或处于 crash loop。
      } finally {
        if (timer) clearTimeout(timer);
      }
      // 按 probe 起点维持固定节拍；若把每次 JS 调度耗时叠加到 interval，
      // 接近 deadline 时会少做本应落在预算内的最后一次健康确认。
      nextAttemptAt += healthIntervalMs;
      if (nextAttemptAt > deadline || healthNow() > deadline) break;
      if (!allowFinalImmediateProbe && (nextAttemptAt === deadline || healthNow() === deadline)) break;
      const delayMs = Math.min(
        Math.max(0, nextAttemptAt - healthNow()),
        Math.max(0, deadline - healthNow()),
      );
      if (delayMs > 0) await healthDelay(delayMs);
    }
    throw healthNotConfirmed();
  }

  async function confirmAndRecordHealthy(deadline, allowFinalImmediateProbe = false) {
    try {
      await confirmServiceHealthy(deadline, allowFinalImmediateProbe);
    } catch (error) {
      // 旧 status 可能来自上一次健康实例；本次 crash loop 不能继续展示 enabled=true。
      writeStatus(false);
      throw error;
    }
    writeStatus(true);
  }

  function throwCollectedStopErrors(errors) {
    if (errors.length === 0) return;
    if (errors.length === 1) throw errors[0];
    const aggregate = new AggregateError(errors, "LaunchAgent stop 未能安全完成");
    aggregate.code = "LAUNCH_AGENT_STOP_FAILED";
    throw aggregate;
  }

  async function bootstrapAndConfirm(current, domain, installed, deadline) {
    assertHealthBudget(deadline);
    await runLaunchctl(["enable", `${domain}/${LAUNCH_AGENT_LABEL}`]);
    assertHealthBudget(deadline);
    try {
      await runLaunchctl(["bootstrap", domain, paths.plistPath]);
    } catch (error) {
      if (!isLaunchctlAlreadyLoaded(error)) throw error;
    }
    const state = await queryLaunchState();
    if (state.disabled || !state.loaded || state.loadedExecutable !== current.executablePath) {
      throw serviceError("START_NOT_CONFIRMED", "LaunchAgent 未确认 enabled+loaded");
    }
    await confirmAndRecordHealthy(deadline);
    return installed;
  }

  const rawController = {
    paths,

    async status() {
      if (platform !== "darwin") return unsupported();
      let current;
      try {
        current = config();
      } catch (error) {
        const codeDescriptor = error && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")
          : null;
        if (codeDescriptor && Object.prototype.hasOwnProperty.call(codeDescriptor, "value")
          && codeDescriptor.value === "UNSTABLE_INSTALL_LOCATION") {
          return { supported: false, reason: "unstable-install-location" };
        }
        throw error;
      }
      const plistStat = rejectSymlink(paths.plistPath);
      if (!plistStat) {
        // 首次安装时磁盘上没有任何本产品的 LaunchAgent 声明；这是权威的
        // “尚未安装”状态，不应依赖 launchctl 可用性。真正启动仍会查询并
        // 对账 launchd，能发现手工删 plist 后残留的旧 job，安全门禁不放宽。
        return {
          supported: true,
          installed: false,
          enabled: false,
          loaded: false,
          needsRepair: false,
        };
      }
      const installed = plistStat?.isFile() === true;
      const configMatches = installed
        && fs.readFileSync(paths.plistPath, "utf8") === buildLaunchAgentPlist(current);
      const state = await queryLaunchState();
      const executableMatches = !state.loaded || state.loadedExecutable === current.executablePath;
      return {
        supported: true,
        installed,
        enabled: state.disabled === false,
        loaded: state.loaded,
        needsRepair: Boolean(
          (plistStat && !installed) || (installed && !configMatches)
          || (state.loaded && (!installed || !executableMatches)),
        ),
      };
    },

    async install() {
      if (platform !== "darwin") return unsupported();
      config();
      ensurePrivateDirectory(paths.stateDir);
      const launchDirStat = lstatIfExists(launchAgentsDir);
      if (launchDirStat?.isSymbolicLink()) throw serviceError("UNSAFE_SYMLINK", "LaunchAgents 目录不能是符号链接");
      if (launchDirStat && !launchDirStat.isDirectory()) throw serviceError("UNSAFE_PATH", "LaunchAgents 路径不是目录");
      fs.mkdirSync(launchAgentsDir, { recursive: true, mode: 0o700 });
      rejectSymlink(paths.plistPath);
      rejectSymlink(paths.statusPath);
      writePrivateFile(paths.plistPath, desiredPlist());
      clearExtendedAttributes(paths.plistPath);
      if (!lstatIfExists(paths.statusPath)) writeStatus(false);
      return { supported: true, label: LAUNCH_AGENT_LABEL, ...paths };
    },

    async start(budget = createStartBudget()) {
      if (platform !== "darwin") return unsupported();
      const current = config();
      const desired = buildLaunchAgentPlist(current);
      const previousStat = rejectSymlink(paths.plistPath);
      if (previousStat && !previousStat.isFile()) {
        throw serviceError("UNSAFE_PATH", "plist 路径不是普通文件");
      }
      const configUnchanged = previousStat?.isFile()
        && fs.readFileSync(paths.plistPath, "utf8") === desired;
      const domain = `gui/${uid}`;
      // 先查询 launchd 的实际 job，再写 plist。否则查询失败会抹掉仍在运行的旧配置证据。
      let state = await queryLaunchState();
      if (state.loaded && configUnchanged && state.loadedExecutable === current.executablePath) {
        const installed = await rawController.install();
        if (state.disabled) {
          await runLaunchctl(["enable", `${domain}/${LAUNCH_AGENT_LABEL}`]);
          state = await queryLaunchState();
          if (state.disabled || !state.loaded || state.loadedExecutable !== current.executablePath) {
            throw serviceError("START_NOT_CONFIRMED", "LaunchAgent 未确认 enabled+loaded");
          }
        }
        try {
          await confirmAndRecordHealthy(budget.loadedHealthDeadline, true);
          return installed;
        } catch (error) {
          if (error?.code !== "SERVICE_HEALTH_NOT_CONFIRMED") throw error;
        }
        try {
          // destructive stop 前再做一次无等待权威确认：它不延长 grace，却能避免
          // Service 恰在最后一次常规采样之后变健康时被无谓重注册。
          await confirmAndRecordHealthy(Math.min(budget.deadline, healthNow() + 1), true);
          return installed;
        } catch (error) {
          if (error?.code !== "SERVICE_HEALTH_NOT_CONFIRMED") throw error;
        }
        // Finder 覆盖安装 App 时 executable 会短暂消失；launchd 虽仍保留 loaded job，
        // 却可能已经进入 spawn-failed/penalty 状态。真实 launchd 在该状态下会让
        // kickstart 长时间等待，因此只做一次完整 stop→bootstrap，清除 penalty 后
        // 走下面同一套 program/socket/protocol/version 健康确认，不形成恢复循环。
        assertHealthBudget(budget.deadline);
        await rawController.stop();
        assertHealthBudget(budget.deadline);
        return bootstrapAndConfirm(current, domain, installed, budget.deadline);
      }
      if (state.loaded) {
        await rawController.stop();
      }
      const installed = await rawController.install();
      // install 不应凭磁盘配置推断运行态；完成新 job 健康确认前保持 disabled 状态。
      writeStatus(false);
      return bootstrapAndConfirm(current, domain, installed, budget.deadline);
    },

    async stop() {
      if (platform !== "darwin") return unsupported();
      const domain = `gui/${uid}`;
      // 必须先禁用再 bootout；否则 KeepAlive 可在两个命令之间重新拉起 job。
      const errors = [];
      for (const args of [
        ["disable", `${domain}/${LAUNCH_AGENT_LABEL}`],
        ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`],
      ]) {
        try {
          await runLaunchctl(args);
        } catch (error) {
          if (!isLaunchctlNotFound(error)) errors.push(error);
        }
      }
      let state = null;
      try {
        // launchctl bootout 返回 0 只表示已接受请求，真实 job 移除是异步的；
        // 有界等待 launchd 权威状态，避免“已经停止却提示失败”。
        state = await waitForStoppedState();
      } catch (error) {
        errors.push(error);
      }
      if (state && (!state.disabled || state.loaded)) {
        errors.push(serviceError("STOP_NOT_CONFIRMED", "LaunchAgent 未确认 disabled+unloaded"));
      }
      throwCollectedStopErrors(errors);
      ensurePrivateDirectory(paths.stateDir);
      rejectSymlink(paths.statusPath);
      writeStatus(false);
      return { supported: true, stopped: true };
    },

    async repair() {
      if (platform !== "darwin") return unsupported();
      const desired = desiredPlist();
      const existingStat = rejectSymlink(paths.plistPath);
      let existing = null;
      if (existingStat) {
        if (!existingStat.isFile()) throw serviceError("UNSAFE_PATH", "plist 路径不是普通文件");
        existing = fs.readFileSync(paths.plistPath, "utf8");
      }
      const repaired = existing !== desired;
      if (repaired) await rawController.stop();
      await rawController.start(createStartBudget());
      return { supported: true, repaired, label: LAUNCH_AGENT_LABEL, ...paths };
    },
  };

  let mutationTail = Promise.resolve();
  let lastQueuedMutation = null;
  function scheduleMutation(kind, operation) {
    // 只合并当前队尾的同类请求。若中间已排入 stop/repair 等异类 mutation，
    // 后续同类请求必须成为新 segment，不能复用更早的 Promise 形成 ABA。
    if (lastQueuedMutation?.kind === kind) return lastQueuedMutation.promise;
    const promise = mutationTail.then(operation);
    const segment = { kind, promise };
    lastQueuedMutation = segment;
    // 前一项失败不能毒化队列；原始 promise 仍按原错误拒绝给所有同种调用者。
    mutationTail = promise.then(() => undefined, () => undefined);
    const clear = () => {
      if (lastQueuedMutation === segment) lastQueuedMutation = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  const controller = {
    paths,
    status: () => rawController.status(),
    install: () => scheduleMutation("install", () => rawController.install()),
    start: () => scheduleMutation("start", () => rawController.start(createStartBudget())),
    stop: () => scheduleMutation("stop", () => rawController.stop()),
    repair: () => scheduleMutation("repair", () => rawController.repair()),
  };
  return controller;
}

module.exports = {
  LAUNCH_AGENT_LABEL,
  ROLE_ARGUMENT,
  buildLaunchAgentPlist,
  createLaunchAgentController,
  normalizeLaunchAgentProxyEnvironment,
  parseMacSystemProxyOutput,
  readMacSystemProxyEnvironment,
};
