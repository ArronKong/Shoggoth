"use strict";

const { fileURLToPath } = require("node:url");
const { explicitPathAttachment } = require("./agent-service/chat-attachments");
const CHANNEL = "shoggoth:chat:clipboard-files";

async function clipboardFilePaths(clipboard) {
  const paths = new Set();
  let remaining = 64 * 1024;
  // Electron maps Finder's native file list to text/uri-list. Ordinary text,
  // including text that happens to look like a path, must stay in the composer.
  for (const item of await clipboard.read()) {
    if (!item.types.includes("text/uri-list")) continue;
    const blob = await item.getType("text/uri-list");
    if (blob.size > remaining) throw new Error("剪贴板文件列表过大");
    remaining -= blob.size;
    const uris = (await blob.text()).replace(/\0+$/u, "").split(/\r?\n/u);
    for (const uri of uris) {
      if (uri.startsWith("file://")) paths.add(fileURLToPath(uri));
    }
  }
  return [...paths];
}

function registerDesktopChatClipboardIpc({ ipcMain, clipboard, getWindows, getUiOrigin }) {
  ipcMain.handle(CHANNEL, async event => {
    const wc = event?.sender;
    const trusted = () => wc && !wc.isDestroyed() && event.senderFrame === wc.mainFrame
      && getWindows().some(window => window && !window.isDestroyed() && window.webContents === wc)
      && (() => { try { return new URL(wc.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; } })();
    if (!trusted()) throw new Error("Untrusted clipboard request");
    const paths = await clipboardFilePaths(clipboard);
    // The renderer may navigate or close while the OS clipboard read is pending.
    if (!trusted()) throw new Error("Untrusted clipboard request");
    if (paths.length > 8) throw new Error("最多添加 8 个附件");
    let remaining = 50 * 1024 * 1024;
    const files = [];
    for (const path of paths) {
      const file = explicitPathAttachment(path, { maxBytes: remaining });
      if (file) { remaining -= Buffer.byteLength(file.content, "base64"); files.push(file); }
    }
    return files;
  });
  return () => ipcMain.removeHandler(CHANNEL);
}

module.exports = { CHANNEL, clipboardFilePaths, registerDesktopChatClipboardIpc };
