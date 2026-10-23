"use strict";

const { SYSTEM_ISSUE_CODES, storageIssueCode } = require("./system-issue");
const CHANNELS = Object.freeze({ ready: "shoggoth:system-issue:ready", notice: "shoggoth:system-issue" });
const CODES = new Set(Object.values(SYSTEM_ISSUE_CODES));

// Only caught, recoverable failures enter this channel. Store recovery gates
// and the process's uncaughtException handling retain their existing behavior.
function createDesktopSystemIssueReporter({ ipcMain, getMainWindow, getUiOrigin, now = Date.now }) {
  const pending = new Set();
  const lastReported = new Map();
  let readyWindow = null;
  let disposed = false;
  function trusted(event) {
    try {
      const window = getMainWindow();
      const contents = window?.webContents;
      if (!window || window.isDestroyed() || !contents || contents.isDestroyed()
        || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
      const url = new URL(event.senderFrame.url);
      return url.origin === getUiOrigin() && ["/", "/index.html"].includes(url.pathname);
    } catch { return false; }
  }
  function flush() {
    const window = getMainWindow();
    if (disposed || !window || window !== readyWindow || window.isDestroyed()
      || window.webContents.isDestroyed()) return;
    for (const code of pending) {
      try {
        window.webContents.send(CHANNELS.notice, { code });
        pending.delete(code);
      } catch { break; }
    }
  }
  const onReady = (event, ...args) => {
    if (disposed || args.length || !trusted(event)) return;
    readyWindow = getMainWindow();
    flush();
  };
  ipcMain.on(CHANNELS.ready, onReady);
  return {
    report(error, fallbackCode) {
      if (disposed) return null;
      const code = storageIssueCode(error) || (CODES.has(fallbackCode) ? fallbackCode : null);
      if (!code) return null;
      const at = now();
      const previous = lastReported.get(code);
      if (previous !== undefined && at - previous < 30_000) return code;
      lastReported.set(code, at);
      pending.add(code);
      flush();
      return code;
    },
    reset() { readyWindow = null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      readyWindow = null;
      pending.clear();
      ipcMain.removeListener(CHANNELS.ready, onReady);
    },
  };
}

module.exports = { CHANNELS, createDesktopSystemIssueReporter };
