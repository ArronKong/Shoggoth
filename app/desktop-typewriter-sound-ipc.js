"use strict";
const { spawn } = require("node:child_process");

const START_CHANNEL = "shoggoth:typewriter-sound:start";
const STOP_CHANNEL = "shoggoth:typewriter-sound:stop";

// afplay opens an output stream without creating Chromium's Web Audio context.
// Keep the file path fixed in the main process; the renderer only controls when
// its own sound starts and stops.
function registerDesktopTypewriterSoundIpc({ ipcMain, getWindows, getUiOrigin, audioPath, spawnProcess = spawn }) {
  const players = new Map();
  const watchers = new Map();
  const trusted = event => {
    const wc = event?.sender;
    return wc && !wc.isDestroyed() && event.senderFrame === wc.mainFrame
      && getWindows().some(window => window && !window.isDestroyed() && window.webContents === wc)
      && (() => { try { return new URL(wc.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; } })();
  };
  const stop = wc => {
    const child = players.get(wc);
    if (!child) return;
    players.delete(wc);
    try { child.kill(); } catch { /* The player may have exited already. */ }
  };
  const watch = wc => {
    if (watchers.has(wc)) return;
    const onNavigation = (details, _url, _sameDocument, legacyMainFrame) => {
      const mainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : legacyMainFrame;
      if (mainFrame !== false) stop(wc);
    };
    const onDestroyed = () => {
      stop(wc);
      wc.removeListener("did-start-navigation", onNavigation);
      watchers.delete(wc);
    };
    wc.on("did-start-navigation", onNavigation);
    wc.once("destroyed", onDestroyed);
    watchers.set(wc, { onNavigation, onDestroyed });
  };
  const start = event => {
    if (!trusted(event)) return;
    const wc = event.sender;
    stop(wc);
    watch(wc);
    try {
      const child = spawnProcess("/usr/bin/afplay", ["-v", "0.3", "-r", "2.5", audioPath], { stdio: "ignore" });
      players.set(wc, child);
      child.once("error", () => { if (players.get(wc) === child) players.delete(wc); });
      child.once("exit", () => { if (players.get(wc) === child) players.delete(wc); });
    } catch { /* An unavailable output device must not interrupt typing. */ }
  };
  const stopFromRenderer = event => { if (trusted(event)) stop(event.sender); };
  ipcMain.on(START_CHANNEL, start);
  ipcMain.on(STOP_CHANNEL, stopFromRenderer);
  return () => {
    ipcMain.removeListener(START_CHANNEL, start);
    ipcMain.removeListener(STOP_CHANNEL, stopFromRenderer);
    for (const wc of players.keys()) stop(wc);
    for (const [wc, { onNavigation, onDestroyed }] of watchers) {
      wc.removeListener("did-start-navigation", onNavigation);
      wc.removeListener("destroyed", onDestroyed);
    }
    watchers.clear();
  };
}

module.exports = { registerDesktopTypewriterSoundIpc, START_CHANNEL, STOP_CHANNEL };
