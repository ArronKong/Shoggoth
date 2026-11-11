"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConfigStore } = require("../app/core/config-store");
const { createDesktopAppInstallPreparation } = require("../app/desktop-app-install-preparation");
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

function fixture({ packaged = true, marker = "official", config = true,
  automaticUpdates = true, saveAutomaticUpdates, quit,
  prepareInstall = async () => null, restoreAfterInstallFailure = async () => {} } = {}) {
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
    app: { isPackaged: packaged, getVersion: () => "0.8.125", quit },
    platform: "darwin",
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
    automaticUpdates,
    saveAutomaticUpdates,
    prepareInstall,
    restoreAfterInstallFailure,
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-update-pref-"));
    try {
      const file = path.join(dir, "config.json");
      const store = createConfigStore(file);
      const fromStore = () => fixture({
        automaticUpdates: createConfigStore(file).read().autoAppUpdates,
        saveAutomaticUpdates: (enabled) => store.write({ autoAppUpdates: enabled }),
      });
      const initial = fromStore();
      assert.equal(initial.controller.getState().automaticUpdates, false);
      assert.equal(initial.timeouts[0].ms, INITIAL_CHECK_DELAY_MS);
      assert.equal(initial.intervals[0].ms, CHECK_INTERVAL_MS);
      initial.timeouts[0].callback();
      assert.equal(initial.updater.checks, 1);
      assert.equal(initial.updater.autoDownload, false, "reminders only check release metadata");
      initial.updater.emit("update-available", { version: "0.8.126" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(initial.controller.getState().availableVersion, "0.8.126");
      assert.equal(initial.controller.getState().canCheck, true, "a detected update can be downloaded manually");
      assert.equal(initial.notifications.length, 0);
      const set = initial.handlers.get(CHANNELS.setAutomatic);
      assert.equal(set({ ...initial.event, senderFrame: {} }, true), null);
      assert.equal(set(initial.event, "true"), null);
      assert.equal(set(initial.event, true).automaticUpdates, true);
      initial.controller.dispose();

      const reopened = fromStore();
      assert.equal(reopened.controller.getState().automaticUpdates, true);
      assert.equal(reopened.intervals[0].ms, CHECK_INTERVAL_MS);
      reopened.intervals[0].callback();
      assert.equal(reopened.updater.autoDownload, true);
      const disable = reopened.handlers.get(CHANNELS.setAutomatic);
      assert.equal(disable(reopened.event, false).automaticUpdates, false);
      assert.equal(reopened.timeouts[0].cleared && reopened.intervals[0].cleared, true);
      assert.equal(reopened.updater.autoDownload, false, "turning off automatic updates applies to an in-flight background check");
      assert.equal(reopened.intervals[1].ms, CHECK_INTERVAL_MS);
      reopened.updater.emit("update-available", { version: "0.8.126" });
      await new Promise((resolve) => setImmediate(resolve));
      await reopened.handlers.get(CHANNELS.check)(reopened.event);
      assert.equal(reopened.updater.checks, 2, "turning off automatic updates preserves manual checking");
      assert.equal(reopened.updater.autoDownload, true, "a manual check starts the download");
      reopened.updater.emit("update-downloaded", { version: "0.8.126" });
      assert.equal(reopened.controller.handleBeforeQuit({ preventDefault: assert.fail }), false);
      assert.equal(await reopened.handlers.get(CHANNELS.install)(reopened.event), true);
      reopened.deferred.shift()();
      assert.equal(reopened.updater.autoRunAppAfterInstall, true);
      assert.equal(createConfigStore(file).read().autoAppUpdates, false);
      reopened.controller.dispose();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const item = fixture({ automaticUpdates: false });
    item.timeouts[0].callback();
    assert.equal(item.updater.autoDownload, false);
    const manual = item.handlers.get(CHANNELS.check)(item.event);
    assert.equal(item.updater.checks, 1, "a manual request shares the in-flight check");
    assert.equal(item.updater.autoDownload, true);
    item.updater.emit("update-available", { version: "0.8.126" });
    assert.equal((await manual).canCheck, false, "the download disables further checks");
    item.controller.dispose();
  }

  for (const outcome of ["ready", "busy", "installer-error"]) {
    let stops = 0;
    let resumes = 0;
    let restores = 0;
    const preparation = createDesktopAppInstallPreparation({
      launchAgent: {
        whenIdle: async () => {},
        status: async () => ({ supported: true, loaded: true }),
        stop: async () => { stops += 1; },
        start: async () => { restores += 1; },
      },
      serviceRequest: async (name) => {
        if (name === "service.stopImpact") return {
          availability: "available", revision: "b".repeat(64), totalCount: outcome === "busy" ? 1 : 0,
          runs: outcome === "busy" ? [{ runId: "run-1", source: "chat", status: "running", agentName: null, title: null }] : [],
        };
        if (name === "service.status") return { instanceNonce: "a".repeat(48) };
        assert.equal(name, "service.quiesceIdle");
        return { quiesced: true, instanceNonce: "a".repeat(48) };
      },
      suspendBackgroundActions: () => () => {},
    });
    const item = fixture({ ...preparation, quit: () => {
      resumes += 1;
      assert.equal(item.controller.handleBeforeQuit({ preventDefault: assert.fail }), false);
    } });
    item.timeouts[0].callback();
    assert.equal(item.updater.checks, 1, "an enabled setting runs the startup check");
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(stops, 0, "automatic download must never stop the service before quitting");
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    assert.equal(item.controller.handleBeforeQuit(event), true);
    assert.equal(item.controller.handleBeforeQuit(event), true);
    assert.equal(prevented, 2);
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome === "busy") {
      assert.equal(item.controller.getState().installBlockReason, "active-runs");
      assert.equal(stops, 0);
      assert.equal(resumes, 1, "active background work should skip installation and quit normally");
      assert.equal(item.deferred.length, 0);
    } else {
      assert.equal(stops, 1);
      item.deferred.shift()();
      assert.equal(item.updater.installs, 1);
      assert.equal(item.updater.autoRunAppAfterInstall, false, "auto-install should not relaunch after quitting");
      if (outcome === "installer-error") {
        item.updater.emit("error", new Error("native installer failed"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(restores, 1);
        assert.equal(resumes, 1);
      } else {
        assert.equal(item.controller.handleBeforeQuit({ preventDefault: assert.fail }), false, "the updater must be allowed to finish quitting");
      }
    }
    item.controller.dispose();
  }

  {
    const item = fixture();
    assert.equal(item.controller.getState().supported, true);
    assert.equal(item.updater.autoDownload, true);
    assert.equal(item.updater.autoInstallOnAppQuit, false);
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
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), true);
    assert.equal(item.updater.installs, 0, "install should be deferred until IPC can return");
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);

    item.controller.dispose();
    assert.equal(item.handlers.size, 0);
    assert.equal(item.timeouts[0].cleared, true);
    assert.equal(item.intervals[0].cleared, true);
    assert.equal(item.updater.listenerCount("update-downloaded"), 0);
  }

  {
    let finishStop;
    let stops = 0;
    let serviceRequests = 0;
    let held = false;
    const stopping = new Promise((resolve) => { finishStop = resolve; });
    const preparation = createDesktopAppInstallPreparation({
      launchAgent: {
        whenIdle: async () => {},
        status: async () => ({ supported: true, loaded: true }),
        stop: async () => { stops += 1; await stopping; },
        start: async () => {},
      },
      serviceRequest: async () => {
        serviceRequests += 1;
        throw Object.assign(new Error("unresponsive old Service"), { code: "REQUEST_TIMEOUT" });
      },
      suspendBackgroundActions: () => {
        held = true;
        return () => { held = false; };
      },
    });
    const item = fixture(preparation);
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(stops, 0, "downloading an update must not stop background work");
    assert.equal(await item.handlers.get(CHANNELS.install)({ sender: {}, senderFrame: {} }), false);
    assert.equal(stops, 0, "only the trusted manual action can stop background work");
    const install = item.handlers.get(CHANNELS.install)(item.event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 1, "the manual install action must stop an unresponsive old Service");
    assert.equal(serviceRequests, 0);
    assert.equal(item.controller.getState().status, "preparing");
    assert.equal(item.deferred.length, 0, "the installer must wait for the confirmed stop");
    finishStop();
    assert.equal(await install, true);
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);
    assert.equal(held, true, "background restarts stay blocked until installation finishes or fails");
    item.controller.dispose();
    await preparation.restoreAfterInstallFailure();
    assert.equal(held, false);
  }

  {
    let stopFails = true;
    let starts = 0;
    let held = false;
    const preparation = createDesktopAppInstallPreparation({
      launchAgent: {
        whenIdle: async () => {},
        status: async () => ({ supported: true, loaded: true }),
        stop: async () => { if (stopFails) throw new Error("stop not confirmed"); },
        start: async () => { starts += 1; },
      },
      suspendBackgroundActions: () => {
        held = true;
        return () => { held = false; };
      },
    });
    const item = fixture(preparation);
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), false);
    assert.equal(item.controller.getState().installBlockReason, "background-stop-failed");
    assert.equal(item.deferred.length, 0, "an unconfirmed stop must not start installation");
    assert.equal(held, false);
    assert.equal(starts, 0);
    stopFails = false;
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), true);
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);
    item.updater.emit("error", new Error("installer failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1, "an installer failure restores the background stopped by this update");
    assert.equal(held, false);
    assert.equal(item.controller.getState().installBlockReason, "install-failed");
    item.controller.dispose();
  }

  {
    let reason = "background-stop-failed";
    const item = fixture({ prepareInstall: async () => reason });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), false);
    assert.equal(item.controller.getState().status, "downloaded");
    assert.equal(item.controller.getState().installBlockReason, "background-stop-failed");
    assert.equal(item.controller.getState().canInstall, true);
    assert.equal(item.deferred.length, 0, "blocked install must leave the app running");
    reason = null;
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), true);
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);
    item.controller.dispose();
  }

  {
    let restores = 0;
    const item = fixture({ restoreAfterInstallFailure: async () => { restores += 1; } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), true);
    item.deferred.shift()();
    item.updater.emit("error", new Error("native installer failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restores, 1, "an asynchronous installer error must restore the stopped background service");
    assert.equal(item.controller.getState().status, "downloaded");
    assert.equal(item.controller.getState().canInstall, true);
    assert.equal(item.controller.getState().installBlockReason, "install-failed");
    item.controller.dispose();
  }

  {
    let finishPreparation;
    let preparations = 0;
    const preparation = new Promise((resolve) => { finishPreparation = resolve; });
    const item = fixture({ prepareInstall: async () => { preparations += 1; return preparation; } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(await item.handlers.get(CHANNELS.install)({ sender: {}, senderFrame: {} }), false);
    assert.equal(preparations, 0, "untrusted renderers cannot stop the background service");
    const install = item.handlers.get(CHANNELS.install)(item.event);
    assert.equal(item.controller.getState().status, "preparing");
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), false);
    await item.controller.check();
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(item.controller.getState().canInstall, false);
    assert.equal(preparations, 1, "concurrent install clicks must share one preparation");
    assert.equal(item.updater.checks, 0, "scheduled checks must not run during preparation");
    finishPreparation(null);
    assert.equal(await install, true);
    item.deferred.shift()();
    assert.equal(item.updater.installs, 1);
    item.controller.dispose();
  }

  {
    const item = fixture({ prepareInstall: async () => { throw new Error("stop failed"); } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), false);
    assert.equal(item.controller.getState().installBlockReason, "background-stop-failed");
    assert.equal(item.controller.getState().canInstall, true);
    assert.equal(item.deferred.length, 0);
    item.controller.dispose();
  }

  {
    let restores = 0;
    let releaseRestore;
    const restored = new Promise((resolve) => { releaseRestore = resolve; });
    const item = fixture({ restoreAfterInstallFailure: async () => {
      restores += 1;
      await restored;
    } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    await item.handlers.get(CHANNELS.install)(item.event);
    item.updater.quitAndInstall = () => { throw new Error("installer could not start"); };
    item.deferred.shift()();
    item.updater.emit("error", new Error("the same failure also arrived as an event"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.controller.getState().status, "recovering");
    assert.equal(await item.handlers.get(CHANNELS.install)(item.event), false);
    await item.controller.check();
    assert.equal(item.updater.checks, 0);
    assert.equal(restores, 1, "one installer failure must trigger one background restore");
    releaseRestore();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.controller.getState().installBlockReason, "install-failed");
    assert.equal(item.controller.getState().canInstall, true);
    item.controller.dispose();
  }

  {
    const item = fixture({ restoreAfterInstallFailure: async () => { throw new Error("restart failed"); } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    await item.handlers.get(CHANNELS.install)(item.event);
    item.deferred.shift()();
    item.updater.emit("error", new Error("native installer failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(item.controller.getState().installBlockReason, "background-restore-failed");
    assert.equal(item.controller.getState().canInstall, true);
    item.controller.dispose();
  }

  {
    let rejectCheck;
    const item = fixture();
    item.updater.pendingCheck = new Promise((resolve, reject) => { rejectCheck = reject; });
    const check = item.controller.check();
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    await item.handlers.get(CHANNELS.install)(item.event);
    rejectCheck(new Error("the completed download's check rejected late"));
    await check;
    assert.equal(item.controller.getState().status, "installing");
    assert.equal(item.controller.getState().canInstall, false);
    item.controller.dispose();
    item.deferred.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }

  {
    let restores = 0;
    let finishPreparation;
    const preparation = new Promise((resolve) => { finishPreparation = resolve; });
    const item = fixture({ prepareInstall: async () => preparation,
      restoreAfterInstallFailure: async () => { restores += 1; } });
    item.updater.emit("update-downloaded", { version: "0.8.126" });
    const install = item.handlers.get(CHANNELS.install)(item.event);
    item.controller.dispose();
    finishPreparation(null);
    assert.equal(await install, false);
    assert.equal(restores, 1, "closing the controller during preparation must restore its stopped service");
    assert.equal(item.deferred.length, 0);
  }

  console.log("Desktop App update controller unit: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
