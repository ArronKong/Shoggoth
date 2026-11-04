"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHANNELS = Object.freeze({
  getState: "shoggoth:app-update:get-state",
  check: "shoggoth:app-update:check",
  setAutomatic: "shoggoth:app-update:set-automatic",
  install: "shoggoth:app-update:install",
  state: "shoggoth:app-update:state",
});
const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function readReleaseMarker(resourcesPath, readFileSync = fs.readFileSync) {
  try {
    const value = JSON.parse(readFileSync(
      path.join(resourcesPath, "shoggoth-release.json"),
      "utf8",
    ));
    if (value?.schemaVersion !== 1
      || !["official", "internal"].includes(value.distribution)
      || !["developer-id", "local", "adhoc"].includes(value.signingMode)
      || (value.updateChannel !== null && value.updateChannel !== "stable")) return null;
    return value;
  } catch {
    return null;
  }
}

function supportStatus({ platform, isPackaged, resourcesPath, existsSync = fs.existsSync, readFileSync }) {
  if (platform !== "darwin") return { supported: false, reason: "platform" };
  if (!isPackaged) return { supported: false, reason: "development-build" };
  const marker = readReleaseMarker(resourcesPath, readFileSync);
  if (!marker) return { supported: false, reason: "invalid-release-marker" };
  if (marker.distribution !== "official" || marker.signingMode !== "developer-id"
    || marker.updateChannel !== "stable") return { supported: false, reason: "internal-build" };
  if (!existsSync(path.join(resourcesPath, "app-update.yml"))) {
    return { supported: false, reason: "missing-update-config" };
  }
  return { supported: true, reason: null };
}

function trustedRenderer(event, getMainWindow) {
  let window;
  try { window = getMainWindow(); } catch { return false; }
  if (!window || window.isDestroyed?.() === true || !window.webContents
    || window.webContents.isDestroyed?.() === true) return false;
  return event?.sender === window.webContents
    && Boolean(event.senderFrame && event.senderFrame === window.webContents.mainFrame);
}

function createDesktopAppUpdateController(options = {}) {
  const {
    app,
    ipcMain,
    getMainWindow,
    resourcesPath = process.resourcesPath,
    platform = process.platform,
    loadUpdater = () => require("electron-updater").autoUpdater,
    existsSync,
    readFileSync,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    defer = setImmediate,
    onDownloaded = () => {},
    automaticUpdates = false,
    saveAutomaticUpdates = () => {},
    prepareInstall = async () => null,
    restoreAfterInstallFailure = async () => {},
  } = options;
  if (!app || typeof app.getVersion !== "function" || !ipcMain?.handle
    || !ipcMain?.removeHandler || typeof getMainWindow !== "function") {
    throw new TypeError("APP_UPDATE_DEPENDENCIES");
  }

  const support = supportStatus({
    platform,
    isPackaged: app.isPackaged === true,
    resourcesPath,
    existsSync,
    readFileSync,
  });
  let state = {
    supported: support.supported,
    reason: support.reason,
    status: support.supported ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    automaticUpdates: automaticUpdates === true,
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    progress: null,
    canCheck: support.supported,
    canInstall: false,
    installBlockReason: null,
  };
  let updater = null;
  let checkPromise = null;
  let installRecoveryPromise = null;
  let initialTimer = null;
  let intervalTimer = null;
  let disposed = false;
  let installingOnQuit = false;
  let skipQuitInstall = false;
  const updaterListeners = [];

  const publicState = () => ({ ...state });
  const broadcast = () => {
    if (disposed) return;
    const window = getMainWindow();
    if (!window || window.isDestroyed?.() === true || window.webContents?.isDestroyed?.() === true) return;
    window.webContents.send(CHANNELS.state, publicState());
  };
  const updateState = (patch) => {
    state = { ...state, ...patch };
    broadcast();
  };
  const resumeQuit = () => {
    installingOnQuit = false;
    if (disposed) return;
    skipQuitInstall = true;
    try { app.quit(); }
    finally { skipQuitInstall = false; }
  };
  const recoverInstall = () => {
    if (installRecoveryPromise) return installRecoveryPromise;
    updateState({ status: "recovering", canCheck: false, canInstall: false });
    installRecoveryPromise = Promise.resolve().then(restoreAfterInstallFailure)
      .then(() => "install-failed", () => "background-restore-failed")
      .then((installBlockReason) => {
        updateState({ status: "downloaded", canCheck: false, canInstall: true, installBlockReason });
        if (installingOnQuit) resumeQuit();
      })
      .finally(() => { installRecoveryPromise = null; });
    return installRecoveryPromise;
  };
  const bind = (name, handler) => {
    updater.on(name, handler);
    updaterListeners.push([name, handler]);
  };

  const check = () => {
    if (disposed || !updater || !state.supported || state.canInstall
      || ["preparing", "installing", "recovering"].includes(state.status)) {
      return Promise.resolve(publicState());
    }
    if (checkPromise) return checkPromise.then(publicState);
    if (!state.canCheck) return Promise.resolve(publicState());
    updateState({ status: "checking", progress: null, canCheck: false, canInstall: false });
    checkPromise = Promise.resolve(updater.checkForUpdates())
      .then((result) => { void result?.downloadPromise?.catch(() => {}); })
      .catch(() => {
        if (["preparing", "installing", "recovering"].includes(state.status)) return;
        updateState({ status: "error", progress: null, canCheck: true, canInstall: false });
      })
      .finally(() => { checkPromise = null; });
    return checkPromise.then(publicState);
  };

  const clearSchedule = () => {
    if (initialTimer !== null) clearTimeoutFn(initialTimer);
    if (intervalTimer !== null) clearIntervalFn(intervalTimer);
    initialTimer = intervalTimer = null;
  };
  const schedule = () => {
    if (!updater || !state.automaticUpdates) return;
    const automaticCheck = () => { if (state.automaticUpdates) void check(); };
    initialTimer = setTimeoutFn(() => {
      initialTimer = null;
      automaticCheck();
    }, INITIAL_CHECK_DELAY_MS);
    initialTimer?.unref?.();
    intervalTimer = setIntervalFn(automaticCheck, CHECK_INTERVAL_MS);
    intervalTimer?.unref?.();
  };

  const authorize = (event) => trustedRenderer(event, getMainWindow);
  ipcMain.handle(CHANNELS.getState, (event) => authorize(event) ? publicState() : null);
  ipcMain.handle(CHANNELS.check, (event) => authorize(event) ? check() : null);
  ipcMain.handle(CHANNELS.setAutomatic, (event, enabled) => {
    if (!authorize(event) || !updater || typeof enabled !== "boolean"
      || ["preparing", "installing", "recovering"].includes(state.status)) return null;
    if (enabled !== state.automaticUpdates) {
      saveAutomaticUpdates(enabled);
      updateState({ automaticUpdates: enabled });
      clearSchedule();
      schedule();
    }
    return publicState();
  });
  const install = async ({ automatic = false } = {}) => {
    if (!updater || !state.canInstall) return false;
    updateState({ status: "preparing", canCheck: false, canInstall: false, installBlockReason: null });
    let blockReason;
    try { blockReason = await prepareInstall({ automatic }); }
    catch { blockReason = "background-stop-failed"; }
    if (disposed) {
      try { await restoreAfterInstallFailure(); } catch { /* the renderer has already closed */ }
      return false;
    }
    if (blockReason) {
      updateState({ status: "downloaded", canCheck: false, canInstall: true,
        installBlockReason: blockReason });
      return false;
    }
    updateState({ status: "installing", canCheck: false, canInstall: false });
    defer(() => {
      if (disposed) {
        void Promise.resolve().then(restoreAfterInstallFailure).catch(() => {});
        return;
      }
      try {
        // On a normal quit, let the macOS installer apply the update without relaunching.
        updater.autoRunAppAfterInstall = !automatic;
        updater.quitAndInstall();
      }
      catch { void recoverInstall(); }
    });
    return true;
  };
  ipcMain.handle(CHANNELS.install, (event) => authorize(event) ? install() : false);

  if (support.supported) {
    try {
      updater = loadUpdater();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.logger = {
        info: () => {},
        warn: () => console.warn("[app-update] updater warning"),
        error: () => console.error("[app-update] updater error"),
      };
      bind("checking-for-update", () => updateState({ status: "checking", progress: null, canCheck: false, canInstall: false,
        installBlockReason: null }));
      bind("update-available", (info = {}) => updateState({
        status: "available",
        availableVersion: typeof info.version === "string" ? info.version : null,
        releaseName: typeof info.releaseName === "string" ? info.releaseName : null,
        releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : null,
        progress: 0,
        canCheck: false,
        canInstall: false,
      }));
      bind("download-progress", (info = {}) => updateState({
        status: "downloading",
        progress: Math.max(0, Math.min(100, Number.isFinite(info.percent) ? info.percent : 0)),
        canCheck: false,
        canInstall: false,
      }));
      bind("update-not-available", () => updateState({
        status: "up-to-date", availableVersion: null, releaseName: null,
        releaseDate: null, progress: null, canCheck: true, canInstall: false,
      }));
      bind("update-downloaded", (info = {}) => {
        if (["preparing", "installing", "recovering"].includes(state.status)) return;
        updateState({
          status: "downloaded",
          availableVersion: typeof info.version === "string" ? info.version : state.availableVersion,
          releaseName: typeof info.releaseName === "string" ? info.releaseName : state.releaseName,
          releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : state.releaseDate,
          progress: 100,
          canCheck: false,
          canInstall: true,
          installBlockReason: null,
        });
        try { onDownloaded(publicState()); } catch { /* notification failure is non-fatal */ }
      });
      bind("update-cancelled", () => updateState({
        status: "idle", progress: null, canCheck: true, canInstall: false,
      }));
      bind("error", () => {
        if (state.status === "installing" || installRecoveryPromise) {
          void recoverInstall();
          return;
        }
        updateState({ status: "error", progress: null, canCheck: true, canInstall: false });
      });
      schedule();
    } catch {
      updater = null;
      state = { ...state, supported: false, reason: "updater-unavailable", status: "unsupported", canCheck: false };
    }
  }

  return {
    getState: publicState,
    check,
    handleBeforeQuit(event) {
      if (disposed || skipQuitInstall || !state.automaticUpdates) return false;
      if (installingOnQuit && ["preparing", "recovering"].includes(state.status)) {
        event.preventDefault();
        return true;
      }
      if (!state.canInstall) return false;
      event.preventDefault();
      installingOnQuit = true;
      void install({ automatic: true }).then((started) => {
        if (!started) resumeQuit();
      });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSchedule();
      for (const [name, handler] of updaterListeners) updater?.removeListener?.(name, handler);
      ipcMain.removeHandler(CHANNELS.getState);
      ipcMain.removeHandler(CHANNELS.check);
      ipcMain.removeHandler(CHANNELS.setAutomatic);
      ipcMain.removeHandler(CHANNELS.install);
    },
  };
}

module.exports = {
  CHANNELS,
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  createDesktopAppUpdateController,
  readReleaseMarker,
  supportStatus,
  trustedRenderer,
};
