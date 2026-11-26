"use strict";
const path = require("node:path");
const { writeDesktopExport } = require("./desktop-export-file");
const { MAX_ARCHIVE_BYTES } = require("./agent-service/inspiration-media");
const CHANNEL = "shoggoth:inspiration:save-archive";

function registerDesktopInspirationIpc({ ipcMain, dialog, getMainWindow, getDesktopWindow = () => null }) {
  const ownerFor = event => [getMainWindow(), getDesktopWindow()].find(window =>
    window && !window.isDestroyed() && !window.webContents.isDestroyed()
      && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  let saving = false;
  ipcMain.handle(CHANNEL, async (event, input) => {
    const owner = ownerFor(event);
    if (!owner) return { ok: false, error: "PRIVILEGED_RENDERER_REQUIRED" };
    if (saving || !input || typeof input.name !== "string" || input.name.length > 200
      || path.basename(input.name) !== input.name || /[\\\x00-\x1f\x7f]/u.test(input.name) || !input.name.endsWith(".zip")
      || !(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_ARCHIVE_BYTES) {
      return { ok: false, error: "INVALID_ARCHIVE" };
    }
    saving = true;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        defaultPath: input.name, filters: [{ name: "Shoggoth", extensions: ["zip"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (canceled || !filePath) return { ok: true, canceled: true };
      if (ownerFor(event) !== owner || !path.isAbsolute(filePath)) return { ok: false, error: "PRIVILEGED_RENDERER_REQUIRED" };
      await writeDesktopExport(filePath, input.bytes);
      return { ok: true, canceled: false };
    } catch { return { ok: false, error: "ARCHIVE_SAVE_FAILED" }; }
    finally { saving = false; }
  });
  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { CHANNEL, registerDesktopInspirationIpc };
