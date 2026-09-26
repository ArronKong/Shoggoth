"use strict";
const CHANNEL = "shoggoth:microphone:request";
const STATUS_CHANNEL = "shoggoth:microphone:status";

// Permission checks (including Chromium device probes) never display a macOS
// dialog. Only the recording button's trusted main-frame IPC can request it.
function registerDesktopMicrophoneIpc({ ipcMain, session, systemPreferences, getWindows, getUiOrigin, platform = process.platform, now = Date.now }) {
  const grants = new WeakMap();
  const trusted = wc => getWindows().some(window => window && !window.isDestroyed() && window.webContents === wc)
    && !wc.isDestroyed() && (() => { try { return new URL(wc.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; } })();
  const granted = wc => {
    const grant = wc && grants.get(wc);
    return trusted(wc) && grant?.frame === wc.mainFrame && grant.until > now();
  };
  session.setPermissionCheckHandler((wc, permission, _origin, details) => permission !== "media"
    || (details?.mediaType === "audio" && granted(wc)));
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== "media") { callback(true); return; }
    callback(details?.isMainFrame !== false && details?.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio" && granted(wc));
  });
  ipcMain.handle(STATUS_CHANNEL, event => {
    const wc = event?.sender;
    if (!wc || !trusted(wc) || event.senderFrame !== wc.mainFrame) throw new Error("Untrusted microphone status request");
    return platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted";
  });
  ipcMain.handle(CHANNEL, async event => {
    const wc = event?.sender;
    if (!wc || !trusted(wc) || event.senderFrame !== wc.mainFrame) throw new Error("Untrusted microphone request");
    const frame = wc.mainFrame;
    let allowed = true;
    if (platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      allowed = status === "granted" || (status === "not-determined" && await systemPreferences.askForMediaAccess("microphone"));
    }
    if (!allowed || !trusted(wc) || wc.mainFrame !== frame) return false;
    grants.set(wc, { frame, until: now() + 15_000 });
    return true;
  });
  return () => { ipcMain.removeHandler(CHANNEL); ipcMain.removeHandler(STATUS_CHANNEL); session.setPermissionCheckHandler(null); session.setPermissionRequestHandler(null); };
}
module.exports = { registerDesktopMicrophoneIpc, CHANNEL, STATUS_CHANNEL };
