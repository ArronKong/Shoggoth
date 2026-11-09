"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { explicitPathAttachment } = require("./agent-service/chat-attachments");
const { createChatAttachmentStaging, validAttachmentName, MAX_OPEN_ATTACHMENT_BYTES } = require("./chat-attachment-open");
const CHANNEL = "shoggoth:chat:clipboard-files";
const WRITE_CHANNEL = "shoggoth:chat:write-clipboard";
const CAPTION_FORMAT = "web application/x-shoggoth-chat-caption";
const MAX_CAPTION_BYTES = 256 * 1024;

async function clipboardFilePaths(clipboard) {
  return filePathsFromItems(await clipboard.read());
}

async function filePathsFromItems(items) {
  const paths = new Set();
  let remaining = 64 * 1024;
  // Electron maps Finder's native file list to text/uri-list. Ordinary text,
  // including text that happens to look like a path, must stay in the composer.
  for (const item of items) {
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

function hermesUpload(filePath) {
  if (typeof filePath !== "string" || filePath.length > 4096) throw new Error("Invalid attachment path");
  const home = os.homedir();
  const root = path.join(home, ".hermes", "desktop-attachments");
  const absolute = path.normalize(filePath.startsWith("~/") ? path.join(home, filePath.slice(2)) : filePath);
  if (!absolute.startsWith(root + path.sep)) throw new Error("Invalid attachment path");
  const real = fs.realpathSync(absolute);
  if (!fs.lstatSync(root).isDirectory() || !real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error("Invalid attachment path");
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error("Invalid attachment file");
  return { real, size: stat.size };
}

function registerDesktopChatClipboardIpc({ ipcMain, clipboard, ClipboardItem, getWindows, getUiOrigin }) {
  const staging = createChatAttachmentStaging();
  const trusted = event => {
    const wc = event?.sender;
    return wc && !wc.isDestroyed() && event.senderFrame === wc.mainFrame
      && getWindows().some(window => window && !window.isDestroyed() && window.webContents === wc)
      && (() => { try { return new URL(wc.getURL()).origin === new URL(getUiOrigin()).origin; } catch { return false; } })();
  };
  ipcMain.handle(CHANNEL, async (event, options) => {
    if (!trusted(event)) throw new Error("Untrusted clipboard request");
    const items = await clipboard.read();
    let caption;
    if (options?.withCaption === true) {
      const item = items.find(item => item.types.includes(CAPTION_FORMAT));
      if (item) {
        const blob = await item.getType(CAPTION_FORMAT);
        if (blob.size <= MAX_CAPTION_BYTES) caption = await blob.text();
      }
      if (options.chatOnly === true && caption === undefined) {
        if (!trusted(event)) throw new Error("Untrusted clipboard request");
        return { files: [] };
      }
    }
    const paths = await filePathsFromItems(items);
    // The renderer may navigate or close while the OS clipboard read is pending.
    if (!trusted(event)) throw new Error("Untrusted clipboard request");
    if (paths.length > 8) throw new Error("最多添加 8 个附件");
    let remaining = 50 * 1024 * 1024;
    const files = [];
    for (const path of paths) {
      const file = explicitPathAttachment(path, { maxBytes: remaining });
      if (file) { remaining -= Buffer.byteLength(file.content, "base64"); files.push(file); }
    }
    return options?.withCaption === true ? { files, caption: files.length ? caption : undefined } : files;
  });
  if (ClipboardItem) ipcMain.handle(WRITE_CHANNEL, async (event, payload) => {
    if (!trusted(event)) throw new Error("Untrusted clipboard request");
    const { text, files, png } = payload ?? {};
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_CAPTION_BYTES || !Array.isArray(files) || files.length > 8
      || (!files.length && !png) || (png && (!(png instanceof ArrayBuffer) || png.byteLength > MAX_OPEN_ATTACHMENT_BYTES))) {
      throw new Error("Invalid clipboard payload");
    }
    let remaining = MAX_OPEN_ATTACHMENT_BYTES;
    const attachments = files.map(file => {
      if (!validAttachmentName(file?.name)) throw new Error("Invalid attachment name");
      const source = file.bytes instanceof ArrayBuffer ? { bytes: file.bytes, size: file.bytes.byteLength } : hermesUpload(file.path);
      remaining -= source.size;
      if (remaining < 0) throw new Error("Clipboard attachments are too large");
      return { ...source, name: file.name };
    });
    const formats = {};
    if (text) {
      formats["text/plain"] = text;
      formats[CAPTION_FORMAT] = text;
    }
    if (png) formats["image/png"] = new Blob([png], { type: "image/png" });
    if (attachments.length) {
      formats["text/uri-list"] = attachments.map(file => pathToFileURL(file.real ?? staging.stage(file.name, Buffer.from(file.bytes))).href).join("\r\n");
    }
    await clipboard.write([new ClipboardItem(formats)]);
  });
  return () => {
    ipcMain.removeHandler(CHANNEL);
    if (ClipboardItem) ipcMain.removeHandler(WRITE_CHANNEL);
    staging.dispose();
  };
}

module.exports = { CHANNEL, WRITE_CHANNEL, clipboardFilePaths, registerDesktopChatClipboardIpc };
