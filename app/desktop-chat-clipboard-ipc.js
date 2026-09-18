"use strict";

const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");
const { explicitPathAttachment } = require("./agent-service/chat-attachments");
const CHANNEL = "shoggoth:chat:clipboard-files";

function clipboardFilePaths(clipboard, decodePlist = buffer => {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"],
    { input: buffer, encoding: "utf8", timeout: 1500, maxBuffer: 64 * 1024 });
  return result.status === 0 ? JSON.parse(result.stdout) : [];
}) {
  const formats = clipboard.availableFormats();
  if (formats.includes("NSFilenamesPboardType")) {
    const buffer = clipboard.readBuffer("NSFilenamesPboardType");
    if (buffer.length > 64 * 1024) throw new Error("剪贴板文件列表过大");
    const paths = decodePlist(buffer);
    if (Array.isArray(paths) && paths.every(value => typeof value === "string")) return [...new Set(paths)];
  }
  const format = ["public.file-url", "text/uri-list"].find(value => formats.includes(value));
  if (!format) return [];
  const buffer = clipboard.readBuffer(format);
  if (buffer.length > 64 * 1024) throw new Error("剪贴板文件列表过大");
  return [...new Set(buffer.toString("utf8").replace(/\0+$/u, "").split(/\r?\n/u)
    .filter(value => value.startsWith("file://")).map(value => fileURLToPath(value)))];
}

function registerDesktopChatClipboardIpc({ ipcMain, clipboard, getWindows, getUiOrigin }) {
  ipcMain.handle(CHANNEL, event => {
    const wc = event?.sender;
    const trusted = wc && !wc.isDestroyed() && event.senderFrame === wc.mainFrame
      && getWindows().some(window => window && !window.isDestroyed() && window.webContents === wc)
      && (() => { try { return new URL(wc.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; } })();
    if (!trusted) throw new Error("Untrusted clipboard request");
    const paths = clipboardFilePaths(clipboard);
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
