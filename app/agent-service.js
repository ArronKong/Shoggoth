"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAgentService } = require("./agent-service/server");
const { inferAppPath } = require("./agent-service/bundle-paths");
const { McpCryptoBroker } = require("./agent-service/mcp-crypto-broker");
const { PackagedMcpCryptoBroker } = require("./agent-service/packaged-mcp-crypto-broker");
const { resolveServicePaths } = require("./agent-service/paths");
const { RuntimeMcpGateIssuer } = require("./agent-service/runtime-mcp-gate");
const { ensurePrivateDirectoryTree } = require("./agent-service/security");
const { createCuaSdkLoader } = require("./cua-sdk-loader");
const {
  hideBackgroundDock,
  prohibitBackgroundActivation,
} = require("./background-role-activation");

function createComputerImageTransformer(nativeImage) {
  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") return null;
  return async ({ data }) => {
    const source = nativeImage.createFromBuffer(data);
    if (!source || source.isEmpty()) throw new Error("computer_snapshot_image_invalid");
    const original = source.getSize();
    let width = Math.min(original.width, 960);
    for (const quality of [72, 60, 48, 36]) {
      const resized = width < original.width ? source.resize({ width, quality: "good" }) : source;
      const encoded = resized.toJPEG(quality);
      if (encoded.length > 0 && encoded.length <= 36 * 1024) {
        return { data: encoded, mimeType: "image/jpeg" };
      }
      width = Math.max(320, Math.floor(width * 0.75));
    }
    throw new Error("computer_snapshot_thumbnail_too_large");
  };
}

function loadComputerDriverConfiguration(options) {
  if (!options.electronApp || options.explicitPaths) return null;
  const packaged = options.electronApp.isPackaged === true;
  if (packaged && (typeof options.resourcesPath !== "string"
    || !path.isAbsolute(options.resourcesPath))) return null;
  const binaryPath = packaged
    ? path.join(options.resourcesPath, "cua-driver", "cua-driver")
    : path.join(__dirname, "..", ".vendor", "cua", "package", "cua-driver");
  const manifestPath = packaged
    ? path.join(options.resourcesPath, "cua-driver", "manifest.json")
    : path.join(__dirname, "..", "build", "cua-driver-manifest.json");
  try {
    return {
      binaryPath,
      manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    };
  } catch {
    return null;
  }
}

async function startAgentServiceProcess(options = {}) {
  const paths = options.paths || resolveServicePaths();
  // Native CLI homes remain owned by their official tools. New installations
  // resolve those homes in place and never copy them into Shoggoth state.
  const nativeRuntimeImportHome = options.nativeRuntimeImportHome ?? null;
  const signalEmitter = options.signalEmitter || process;
  const exitProcess = options.exitProcess || ((code) => process.exit(code));
  let requestedExitCode = 0;
  let exitScheduled = false;
  let shuttingDown = false;
  let activateHandler = null;
  let uiOpenInFlight = null;
  const reportShutdownError = async (error) => {
    requestedExitCode = 1;
    try {
      if (typeof options.onShutdownError === "function") await options.onShutdownError(error);
      else console.error("[agent-service] shutdown failure: SERVICE_STOP_FAILED");
    } catch {
      console.error("[agent-service] shutdown failure reporter failed");
    }
  };
  const scheduleExit = () => {
    if (!options.exitOnStop || exitScheduled) return;
    exitScheduled = true;
    setImmediate(() => exitProcess(requestedExitCode));
  };
  let electronApp = options.electronApp || null;
  let ElectronNotification = options.Notification || null;
  let ElectronShell = options.shell || null;
  let ElectronNativeImage = options.nativeImage || null;
  let ElectronPowerMonitor = options.powerMonitor || null;
  if (!options.paths && !electronApp) {
    ({
      app: electronApp,
      Notification: ElectronNotification,
      shell: ElectronShell,
      nativeImage: ElectronNativeImage,
      powerMonitor: ElectronPowerMonitor,
    } = require("electron"));
  }

  if (electronApp) {
    prohibitBackgroundActivation(electronApp, options.platform);
    // Utility Service 必须在 Electron ready 前就切到自己的 profile/cache，避免碰 UI userData。
    ensurePrivateDirectoryTree(paths.cacheDir, paths.trustedRoot);
    ensurePrivateDirectoryTree(paths.stateDir, paths.trustedRoot);
    ensurePrivateDirectoryTree(paths.profileDir, paths.trustedRoot);
    ensurePrivateDirectoryTree(path.join(paths.profileDir, "session"), paths.trustedRoot);
    electronApp.setPath("userData", paths.profileDir);
    electronApp.setPath("sessionData", path.join(paths.profileDir, "session"));
    electronApp.setPath("cache", paths.cacheDir);
    await electronApp.whenReady();
    hideBackgroundDock(electronApp, options.platform);
  }
  const grokBuildResolveProxy = options.grokBuildResolveProxy
    ?? (typeof electronApp?.resolveProxy === "function"
      ? (url) => electronApp.resolveProxy(url)
      : undefined);

  const notificationSender = options.notificationSender || (ElectronNotification
    ? async ({ title, body }) => {
      if (typeof ElectronNotification.isSupported !== "function"
        || ElectronNotification.isSupported() !== true) {
        throw new Error("native_notification_unsupported");
      }
      const notification = new ElectronNotification({ title, body });
      if (!notification || typeof notification.show !== "function") {
        throw new Error("native_notification_invalid");
      }
      notification.show();
    }
    : undefined);
  const systemHostAdapter = options.systemHostAdapter || (ElectronShell
    && typeof ElectronShell.openPath === "function"
    && typeof ElectronShell.openExternal === "function"
    && typeof ElectronShell.showItemInFolder === "function" ? {
      openPath: (target) => ElectronShell.openPath(target),
      openExternal: async (target) => { await ElectronShell.openExternal(target); return true; },
      showItemInFolder: (target) => { ElectronShell.showItemInFolder(target); return true; },
    } : undefined);
  const computerDriverConfiguration = options.computerDriverConfiguration
    || loadComputerDriverConfiguration({
      electronApp,
      explicitPaths: Boolean(options.paths),
      resourcesPath: options.resourcesPath || process.resourcesPath,
    });
  let screenLocked = false;

  const packageVersion = options.version || JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ).version;
  let mcpCryptoBroker = options.mcpCryptoBroker || null;
  const usePackagedSelector = !options.paths
    && electronApp?.isPackaged === true
    && process.defaultApp !== true
    && process.env.NODE_ENV !== "test";
  const packagedExternalCrypto = !options.paths && Boolean(electronApp)
    && process.env.NODE_ENV !== "test";
  const openUiApp = options.openUiApp || (packagedExternalCrypto && process.platform === "darwin"
    ? () => new Promise((resolve, reject) => {
      const appPath = inferAppPath(process.execPath);
      if (!appPath) {
        reject(new Error("stable_app_path_unavailable"));
        return;
      }
      const childEnv = { ...process.env };
      delete childEnv.SHOGGOTH_INTERNAL_LAUNCH;
      delete childEnv.SHOGGOTH_LAUNCHD_LABEL;
      delete childEnv.SHOGGOTH_BOOTSTRAP_PATH;
      const child = spawn("/usr/bin/open", ["-n", appPath], {
        env: childEnv,
        stdio: "ignore",
        detached: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    })
    : null);
  const detachActivationHandler = () => {
    if (activateHandler && typeof electronApp?.off === "function") {
      electronApp.off("activate", activateHandler);
    }
    activateHandler = null;
  };
  // 真实 packaged Service 先按当前 App 身份选择本地文件或一次性 worker；
  // 显式 paths/source/defaultApp 与 Node 单测继续沿用原有可注入路径。
  if (!mcpCryptoBroker && !options.safeStorage && electronApp && !options.paths
    && typeof electronApp.getAppPath === "function") {
    const cryptoOptions = {
      paths,
      callerRole: "agent-service",
      executablePath: process.execPath,
      appRoot: electronApp.getAppPath(),
      defaultApp: process.defaultApp === true,
      parentEnv: process.env,
      // macOS 首次创建独立后台 Keychain 项时会等待用户处理系统对话框；
      // worker 与主 Service 隔离，允许一个较长但有界的一次性窗口。
      requestTimeoutMs: options.mcpCryptoRequestTimeoutMs
        ?? (packagedExternalCrypto ? 60_000 : undefined),
      termGraceMs: options.mcpCryptoTermGraceMs,
      killConfirmMs: options.mcpCryptoKillConfirmMs,
    };
    mcpCryptoBroker = usePackagedSelector
      ? new PackagedMcpCryptoBroker({
        ...cryptoOptions,
        resourcesPath: options.resourcesPath || process.resourcesPath,
        applicationsRoot: options.applicationsRoot || "/Applications",
      })
      : new McpCryptoBroker(cryptoOptions);
  }
  // Codex continues to launch the packaged Electron MCP helper directly. Grok's
  // Runtime gate uses the same signed executable but enters through the ASAR
  // bootstrap in ELECTRON_RUN_AS_NODE mode, so the two launch contracts stay separate.
  const mcpHelperLaunch = options.mcpHelperLaunch || {
    command: process.execPath,
    argsPrefix: process.defaultApp === true && typeof electronApp?.getAppPath === "function"
      ? [electronApp.getAppPath()] : [],
  };
  const runtimeMcpGateIssuer = options.runtimeMcpGateIssuer || new RuntimeMcpGateIssuer({
    paths,
    mcpHelperLaunch,
    now: options.now,
    bootstrapPath: path.join(
      typeof electronApp?.getAppPath === "function"
        ? electronApp.getAppPath() : path.join(__dirname, ".."),
      "app",
      "bootstrap.js",
    ),
  });
  const service = createAgentService({
    paths,
    version: packageVersion,
    builtinCliProfiles: options.builtinCliProfiles ?? true,
    nativeRuntimeImportHome,
    runtimePool: options.runtimePool,
    grokBuildRuntimePool: options.grokBuildRuntimePool,
    grokBuildBinaryPath: options.grokBuildBinaryPath,
    grokBuildResolveProxy,
    runtimeManager: options.runtimeManager,
    runtimeMcpGateIssuer,
    parentEnv: options.parentEnv || process.env,
    safeStorage: options.safeStorage,
    cryptoBroker: mcpCryptoBroker || undefined,
    mcpCryptoBroker: mcpCryptoBroker || undefined,
    mcpAuthInitTimeoutMs: options.mcpAuthInitTimeoutMs
      ?? (packagedExternalCrypto ? 65_000 : undefined),
    prewarmMcpAuth: options.prewarmMcpAuth ?? packagedExternalCrypto,
    notificationSender,
    systemHostAdapter,
    computerUseController: options.computerUseController,
    computerDriverPath: computerDriverConfiguration?.binaryPath,
    computerDriverManifest: computerDriverConfiguration?.manifest,
    computerHostBundleId: "ai.shoggoth.desktop",
    computerSdkLoader: options.computerSdkLoader || (computerDriverConfiguration
      ? createCuaSdkLoader({
        packaged: electronApp?.isPackaged === true,
        resourcesPath: options.resourcesPath || process.resourcesPath,
      })
      : undefined),
    computerPermissionStatus: options.computerPermissionStatus,
    computerGetSystemIdleTime: options.computerGetSystemIdleTime || (
      typeof ElectronPowerMonitor?.getSystemIdleTime === "function"
        ? () => ElectronPowerMonitor.getSystemIdleTime() : undefined
    ),
    computerIsScreenLocked: options.computerIsScreenLocked || (() => screenLocked),
    computerImageTransformer: options.computerImageTransformer
      || createComputerImageTransformer(ElectronNativeImage),
    computerMaxSessions: options.computerMaxSessions,
    computerVerifyBinary: options.computerVerifyBinary,
    platform: options.platform || process.platform,
    homeDirectory: options.homeDirectory,
    applicationRoots: options.applicationRoots,
    folderRoots: options.folderRoots,
    allowedUrlProtocols: options.allowedUrlProtocols,
    readApplicationPlist: options.readApplicationPlist,
    repoRoot: options.repoRoot,
    packaged: options.packaged ?? Boolean(electronApp?.isPackaged),
    resourcesPath: options.resourcesPath || process.resourcesPath,
    mcpHelperLaunch,
    cleanupFs: options.cleanupFs,
    onNativeRuntimeImport: options.onNativeRuntimeImport || ((summary) => {
      const failures = summary.results.filter((result) => result.status === "failed");
      if (failures.length > 0) {
        console.warn("[agent-service] native Runtime import incomplete:", failures
          .map((result) => `${result.runtime}:${result.code}`).join(","));
      }
    }),
    onServerReady: options.onServerReady,
    onRuntimeError: async (error, cleanupError) => {
      await reportShutdownError(cleanupError || error);
      if (electronApp && typeof electronApp.exit === "function") electronApp.exit(1);
      else if (electronApp) electronApp.quit();
      else if (options.exitOnStop) exitProcess(1);
      else process.exitCode = 1;
    },
    onStop: async () => {
      detachActivationHandler();
      if (electronApp) electronApp.quit();
      scheduleExit();
    },
    onStopError: async (error) => {
      await reportShutdownError(error);
      scheduleExit();
    },
  });
  await service.start();

  const powerHandlers = [];
  const addPowerHandler = (event, handler) => {
    if (typeof ElectronPowerMonitor?.on !== "function") return;
    ElectronPowerMonitor.on(event, handler);
    powerHandlers.push([event, handler]);
  };
  const pauseComputer = (reason) => {
    try { service.computerUseController?.pauseAll(reason); } catch {}
  };
  addPowerHandler("lock-screen", () => { screenLocked = true; pauseComputer("screen_locked"); });
  addPowerHandler("unlock-screen", () => { screenLocked = false; });
  addPowerHandler("suspend", () => pauseComputer("system_suspended"));
  const detachPowerHandlers = () => {
    for (const [event, handler] of powerHandlers.splice(0)) {
      if (typeof ElectronPowerMonitor?.off === "function") ElectronPowerMonitor.off(event, handler);
    }
  };

  if (electronApp && typeof electronApp.on === "function" && typeof openUiApp === "function") {
    activateHandler = () => {
      hideBackgroundDock(electronApp, options.platform);
      if (shuttingDown || uiOpenInFlight) return;
      uiOpenInFlight = Promise.resolve()
        .then(() => openUiApp())
        .catch(() => console.error("[agent-service] failed to open UI: UI_OPEN_FAILED"))
        .finally(() => { uiOpenInFlight = null; });
    };
    electronApp.on("activate", activateHandler);
  }

  const stopService = service.stop.bind(service);
  service.stop = async (...args) => {
    detachActivationHandler();
    detachPowerHandlers();
    return stopService(...args);
  };

  let signalHandler = null;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signalHandler) {
      signalEmitter.off("SIGTERM", signalHandler);
      signalEmitter.off("SIGINT", signalHandler);
    }
    try {
      await service.stop({ notify: false });
    } catch (error) {
      await reportShutdownError(error);
    } finally {
      detachActivationHandler();
      detachPowerHandlers();
      if (electronApp) electronApp.quit();
      if (options.exitOnStop) exitProcess(requestedExitCode);
    }
  };
  signalHandler = () => { void shutdown(); };
  signalEmitter.once("SIGTERM", signalHandler);
  signalEmitter.once("SIGINT", signalHandler);
  return service;
}

module.exports = {
  createComputerImageTransformer,
  loadComputerDriverConfiguration,
  startAgentServiceProcess,
};
