"use strict";

const { getUtcDay, validateTelemetrySignal } = require("./core/product-telemetry-schema");
const { writeDesktopExport } = require("./desktop-export-file");

const CHANNELS = Object.freeze({
  signal: "shoggoth:telemetry:signal",
  getSettings: "shoggoth:telemetry:get-settings",
  setEnabled: "shoggoth:telemetry:set-enabled",
  saveDiagnosticFile: "shoggoth:telemetry:save-diagnostic-file",
});

function registerDesktopTelemetryIpc({ ipcMain, getMainWindow, getUiOrigin, powerMonitor, telemetry, dialog, diagnosticSummary, now = Date.now }) {
  let disposed = false;
  let locked = false;
  let suspended = false;
  let inactive = false;
  let lastActivity = { at: -Infinity, day: null, epoch: null };
  let detailWindowStart = -Infinity;
  let detailCount = 0;
  let savingDiagnostic = false;
  let foregroundBeforeSleep = null;
  function rememberForeground() {
    const w = getMainWindow();
    if (w && !w.isDestroyed() && w.isVisible() && w.isFocused() && !w.isMinimized()) foregroundBeforeSleep = w;
  }
  const powerHandlers = {
    "lock-screen": () => { rememberForeground(); locked = true; },
    "unlock-screen": () => { locked = false; },
    suspend: () => { rememberForeground(); suspended = true; },
    resume: () => { suspended = false; },
    "user-did-resign-active": () => { rememberForeground(); inactive = true; },
    "user-did-become-active": () => { inactive = false; },
  };
  for (const [name, handler] of Object.entries(powerHandlers)) powerMonitor.on(name, handler);

  function trustedWindow(event) {
    if (disposed) return null;
    const w = getMainWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed() || event?.sender !== w.webContents
      || !event.senderFrame || event.senderFrame !== w.webContents.mainFrame) return null;
    const url = new URL(event.senderFrame.url);
    return url.origin === getUiOrigin() && (url.pathname === "/" || url.pathname === "/index.html") ? w : null;
  }

  function foreground(w) {
    if (locked || suspended || inactive || !w.isVisible() || !w.isFocused() || w.isMinimized()) return false;
    const idle = powerMonitor.getSystemIdleState(1);
    return idle === "active" || idle === "idle";
  }

  function observeWindow(w) {
    const opened = () => {
      try {
        if (!disposed && !savingDiagnostic && foregroundBeforeSleep !== w && getMainWindow() === w && !w.isDestroyed() && foreground(w)) {
          telemetry.recordActivity();
        }
      } catch { /* window closed or unavailable while changing focus */ }
    };
    // Re-focusing an already visible window on wake does not indicate a new
    // open. Actual input still counts, as does the next ordinary return to it.
    const left = () => { if (!locked && !suspended && !inactive && foregroundBeforeSleep === w) foregroundBeforeSleep = null; };
    w.on("show", opened);
    w.on("focus", opened);
    w.on("blur", left);
    w.on("hide", left);
    w.once("closed", () => {
      if (foregroundBeforeSleep === w) foregroundBeforeSleep = null;
      w.removeListener("show", opened);
      w.removeListener("focus", opened);
      w.removeListener("blur", left);
      w.removeListener("hide", left);
    });
    opened(); // BrowserWindow can already be visible before listeners are attached.
  }

  const onSignal = (event, ...args) => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== "object") return;
    const [signal] = args;
    try {
      const w = trustedWindow(event);
      const completion = signal.kind === "feature_end"
        || (signal.kind === "onboarding_step" && signal.payload?.step === "connection_verified");
      if (!w || (!completion && !foreground(w)) || !validateTelemetrySignal(signal)) return;
      const at = now();
      const day = getUtcDay(at);
      if (!day) return;
      if (signal.kind === "activity") {
        if (day === lastActivity.day && signal.collectionEpoch === lastActivity.epoch && at - lastActivity.at < 1000) return;
        lastActivity = { day, at, epoch: signal.collectionEpoch };
      } else {
        if (at < detailWindowStart || at - detailWindowStart >= 1000) {
          detailWindowStart = at;
          detailCount = 0;
        }
        if (detailCount++ >= 120) return;
      }
      telemetry.recordSignal(signal);
    } catch { /* invalid or stale document */ }
  };

  const getSettings = (event, ...args) => {
    try { return args.length === 0 && trustedWindow(event) ? telemetry.getSettings() : null; }
    catch { return null; }
  };
  const change = field => (event, ...args) => {
    try {
      const w = trustedWindow(event);
      return args.length === 1 && typeof args[0] === "boolean" && w && foreground(w)
        ? telemetry.setPreference(field, args[0]) : null;
    } catch { return null; }
  };

  ipcMain.on(CHANNELS.signal, onSignal);
  ipcMain.handle(CHANNELS.getSettings, getSettings);
  ipcMain.handle(CHANNELS.setEnabled, change("enabled"));
  ipcMain.handle(CHANNELS.saveDiagnosticFile, async (event, ...args) => {
    if (savingDiagnostic || args.length) return "failed";
    try {
      const owner = trustedWindow(event);
      if (!owner || !foreground(owner)) return "failed";
      savingDiagnostic = true;
      const choice = await dialog.showSaveDialog(owner, { defaultPath: "Shoggoth-diagnostics.txt",
        filters: [{ name: "Shoggoth", extensions: ["txt"] }], properties: ["createDirectory", "showOverwriteConfirmation"] });
      if (choice.canceled || !choice.filePath) return "canceled";
      if (trustedWindow(event) !== owner) return "failed";
      await writeDesktopExport(choice.filePath, diagnosticSummary());
      return "saved";
    } catch { return "failed"; }
    finally { savingDiagnostic = false; }
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(CHANNELS.signal, onSignal);
    for (const channel of [CHANNELS.getSettings, CHANNELS.setEnabled, CHANNELS.saveDiagnosticFile]) ipcMain.removeHandler(channel);
    for (const [name, handler] of Object.entries(powerHandlers)) powerMonitor.removeListener(name, handler);
  }
  return { observeWindow, dispose };
}

module.exports = { CHANNELS, registerDesktopTelemetryIpc };
