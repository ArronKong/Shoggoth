"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  CHANNELS,
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  createDesktopAppUpdateController,
  supportStatus,
} = require("../app/desktop-app-update");

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checks = 0;
    this.installs = 0;
    this.pendingCheck = null;
  }
  checkForUpdates() {
    this.checks += 1;
    if (!this.pendingCheck) this.pendingCheck = Promise.resolve(null);
    return this.pendingCheck;
  }
  quitAndInstall() { this.installs += 1; }
}

function fixture({ packaged = true, marker = "official", config = true } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(name, handler) { handlers.set(name, handler); },
    removeHandler(name) { handlers.delete(name); },
  };
  const sends = [];
  const webContents = { mainFrame: {}, send: (...args) => sends.push(args), isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const updater = new FakeUpdater();
  const timeouts = [];
  const intervals = [];
  const deferred = [];
  const notifications = [];
  const markerValue = marker === "official"
    ? { schemaVersion: 1, distribution: "official", signingMode: "developer-id", updateChannel: "stable" }
    : { schemaVersion: 1, distribution: "internal", signingMode: "adhoc", updateChannel: null };
  const controller = createDesktopAppUpdateController({
    app: { isPackaged: packaged, getVersion: () => "0.8.125" },
    ipcMain,
    getMainWindow: () => window,
    resourcesPath: "/app/Resources",
    existsSync: (target) => config && target.endsWith("app-update.yml"),
    readFileSync: (target) => {
      if (!target.endsWith("shoggoth-release.json")) throw new Error("unexpected read");
      return JSON.stringify(markerValue);
    },
    loadUpdater: () => updater,
    setTimeoutFn: (callback, ms) => { const timer = { callback, ms, unref() {} }; timeouts.push(timer); return timer; },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
    setIntervalFn: (callback, ms) => { const timer = { callback, ms, unref() {} }; intervals.push(timer); return timer; },
    clearIntervalFn: (timer) => { timer.cleared = true; },
    defer: (callback) => deferred.push(callback),
    onDownloaded: (state) => notifications.push(state),
  });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { controller, handlers, sends, updater, timeouts, intervals, deferred, notifications, event, webContents };
}

async function main() {
  assert.deepEqual(supportStatus({
    platform: "linux", isPackaged: true, resourcesPath: "/app",
  }), { supported: false, reason: "platform" });

  {
    const item = fixture({ packaged: false });
    assert.equal(item.controller.getState().reason, "development-build");
    assert.equal(item.updater.checks, 0);
    assert.equal(item.timeouts.length, 0);
    item.controller.dispose();
  }

  {
    const item = fixture({ marker: "internal" });
    assert.equal(item.controller.getState().reason, "internal-build");
    assert.equal(item.handlers.get(CHANNELS.check)(item.event).then instanceof Function, true);
    assert.equal(item.updater.checks, 0);
    item.controller.dispose();
  }

  {
    const item = fixture();
    assert.equal(item.controller.getState().supported, true);
    assert.equal(item.updater.autoDownload, true);
    assert.equal(item.updater.autoInstallOnAppQuit, true);
    assert.equal(item.updater.allowPrerelease, false);
    assert.equal(item.timeouts[0].ms, INITIAL_CHECK_DELAY_MS);
    assert.equal(item.intervals[0].ms, CHECK_INTERVAL_MS);
    const untrusted = { sender: {}, senderFrame: {} };
    assert.equal(item.handlers.get(CHANNELS.getState)(untrusted), null);
    assert.equal(item.handlers.get(CHANNELS.check)(untrusted), null);

    let releaseCheck;
    item.updater.pendingCheck = new Promise((resolve) => { releaseCheck = resolve; });
    const first = item.handlers.get(CHANNELS.check)(item.event);
    const second = item.handlers.get(CHANNELS.check)(item.event);
    assert.equal(item.updater.checks, 1, "concurrent checks must share one updater request");
    releaseCheck(null);
    const [firstState, secondState] = await Promise.all([first, second]);
    assert.equal(firstState.status, "checking");
    assert.equal(secondState.status, "checking");

    item.updater.emit("update-available", { version: "0.8.126", releaseName: "Stable", releaseDate: "2026-09-22" });
    item.updater.emit("download-progress", { percent: 140 });
    assert.equal(item.controller.getState().progress, 100);
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(item.controller.getState().canInstall, true);
    assert.equal(item.controller.getState().canCheck, false);
    assert.equal(item.notifications.length, 1);
    assert.equal(item.handlers.get(CHANNELS.install)(item.event), true);
    assert.equal(item.updater.installs, 0, "install should be deferred until IPC can return");
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);

    item.controller.dispose();
    assert.equal(item.handlers.size, 0);
    assert.equal(item.timeouts[0].cleared, true);
    assert.equal(item.intervals[0].cleared, true);
    assert.equal(item.updater.listenerCount("update-downloaded"), 0);
  }

  console.log("Desktop App update controller unit: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
