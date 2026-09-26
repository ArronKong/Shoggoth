"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHANNELS = Object.freeze({
  getState: "shoggoth:app-update:get-state",
  check: "shoggoth:app-update:check",
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
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    progress: null,
    canCheck: support.supported,
    canInstall: false,
  };
  let updater = null;
  let checkPromise = null;
  let initialTimer = null;
  let intervalTimer = null;
  let disposed = false;
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
  const bind = (name, handler) => {
    updater.on(name, handler);
    updaterListeners.push([name, handler]);
  };

  const check = () => {
    if (disposed || !updater || !state.supported || state.canInstall) {
      return Promise.resolve(publicState());
    }
    if (checkPromise) return checkPromise.then(publicState);
    updateState({ status: "checking", progress: null, canCheck: false, canInstall: false });
    checkPromise = Promise.resolve(updater.checkForUpdates())
      .catch(() => {
        updateState({ status: "error", progress: null, canCheck: true, canInstall: false });
      })
      .finally(() => { checkPromise = null; });
    return checkPromise.then(publicState);
  };

  const authorize = (event) => trustedRenderer(event, getMainWindow);
  ipcMain.handle(CHANNELS.getState, (event) => authorize(event) ? publicState() : null);
  ipcMain.handle(CHANNELS.check, (event) => authorize(event) ? check() : null);
  ipcMain.handle(CHANNELS.install, (event) => {
    if (!authorize(event) || !updater || !state.canInstall) return false;
    updateState({ status: "installing", canCheck: false, canInstall: false });
    defer(() => { if (!disposed) updater.quitAndInstall(); });
    return true;
  });

  if (support.supported) {
    try {
      updater = loadUpdater();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = false;
      updater.logger = {
        info: () => {},
        warn: () => console.warn("[app-update] updater warning"),
        error: () => console.error("[app-update] updater error"),
      };
      bind("checking-for-update", () => updateState({ status: "checking", progress: null, canCheck: false, canInstall: false }));
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
        updateState({
          status: "downloaded",
          availableVersion: typeof info.version === "string" ? info.version : state.availableVersion,
          releaseName: typeof info.releaseName === "string" ? info.releaseName : state.releaseName,
          releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : state.releaseDate,
          progress: 100,
          canCheck: false,
          canInstall: true,
        });
        try { onDownloaded(publicState()); } catch { /* notification failure is non-fatal */ }
      });
      bind("update-cancelled", () => updateState({
        status: "idle", progress: null, canCheck: true, canInstall: false,
      }));
      bind("error", () => updateState({
        status: "error", progress: null, canCheck: true, canInstall: false,
      }));
      initialTimer = setTimeoutFn(() => { void check(); }, INITIAL_CHECK_DELAY_MS);
      initialTimer?.unref?.();
      intervalTimer = setIntervalFn(() => { void check(); }, CHECK_INTERVAL_MS);
      intervalTimer?.unref?.();
    } catch {
      updater = null;
      state = { ...state, supported: false, reason: "updater-unavailable", status: "unsupported", canCheck: false };
    }
  }

  return {
    getState: publicState,
    check,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (initialTimer) clearTimeoutFn(initialTimer);
      if (intervalTimer) clearIntervalFn(intervalTimer);
      for (const [name, handler] of updaterListeners) updater?.removeListener?.(name, handler);
      ipcMain.removeHandler(CHANNELS.getState);
      ipcMain.removeHandler(CHANNELS.check);
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
