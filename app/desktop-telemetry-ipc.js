"use strict";

const { getUtcDay } = require("./core/product-telemetry-schema");
const CHANNELS = Object.freeze({ activity: "shoggoth:telemetry:activity" });

// One UI-only fire-and-forget signal. No payload, status/identity, preferences,
// arbitrary event names, HTTP endpoint or Agent/Widget capability is exposed.
function registerDesktopTelemetryIpc({ ipcMain, getMainWindow, getUiOrigin, powerMonitor, telemetry, now = Date.now }) {
  if (!ipcMain?.on || !ipcMain?.removeListener || !powerMonitor?.on || !powerMonitor?.removeListener
    || typeof getMainWindow !== "function" || typeof getUiOrigin !== "function"
    || typeof telemetry?.recordActivity !== "function") throw new TypeError("TELEMETRY_IPC_DEPENDENCIES");
  let disposed = false;
  let locked = false;
  let suspended = false;
  let inactive = false;
  let lastAt = -Infinity;
  let lastDay = null;
  const powerHandlers = {
    "lock-screen": () => { locked = true; },
    "unlock-screen": () => { locked = false; },
    suspend: () => { suspended = true; },
    resume: () => { suspended = false; },
    "user-did-resign-active": () => { inactive = true; },
    "user-did-become-active": () => { inactive = false; },
  };
  for (const [name, handler] of Object.entries(powerHandlers)) powerMonitor.on(name, handler);

  const onActivity = (event, ...args) => {
    if (disposed || args.length !== 0 || locked || suspended || inactive) return;
    try {
      const w = getMainWindow();
      if (!w || w.isDestroyed() || !w.isVisible() || !w.isFocused() || w.isMinimized()
        || w.webContents.isDestroyed() || event?.sender !== w.webContents
        || !event.senderFrame || event.senderFrame !== w.webContents.mainFrame) return;
      // Pin the document as well as its frame identity; a navigated main frame
      // is not automatically an authorized product document.
      const url = new URL(event.senderFrame.url);
      if (url.origin !== getUiOrigin() || (url.pathname !== "/" && url.pathname !== "/index.html")) return;
      const idleState = powerMonitor.getSystemIdleState(1);
      if (idleState !== "active" && idleState !== "idle") return;
      const at = now();
      const day = getUtcDay(at);
      if (!day || (day === lastDay && at - lastAt < 1000)) return;
      lastAt = at;
      lastDay = day;
      telemetry.recordActivity();
    } catch { /* telemetry must never surface native/config/runtime errors to UI */ }
  };
  ipcMain.on(CHANNELS.activity, onActivity);
  return () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(CHANNELS.activity, onActivity);
    for (const [name, handler] of Object.entries(powerHandlers)) powerMonitor.removeListener(name, handler);
  };
}

module.exports = { CHANNELS, registerDesktopTelemetryIpc };
