"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
    let temporary;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        defaultPath: input.name, filters: [{ name: "Shoggoth", extensions: ["zip"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (canceled || !filePath) return { ok: true, canceled: true };
      if (ownerFor(event) !== owner || !path.isAbsolute(filePath)) return { ok: false, error: "PRIVILEGED_RENDERER_REQUIRED" };
      temporary = path.join(path.dirname(filePath), `.shoggoth-export-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(input.bytes); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, filePath); temporary = undefined;
      return { ok: true, canceled: false };
    } catch { return { ok: false, error: "ARCHIVE_SAVE_FAILED" }; }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); saving = false; }
  });
  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { CHANNEL, registerDesktopInspirationIpc };
