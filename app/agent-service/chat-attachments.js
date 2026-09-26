"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { validAttachment, validAttachments, MAX_ATTACHMENTS, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES,
  CHUNK_BYTES, mediaId } = require("./inspiration-media");
const { serviceError } = require("./security");

const CHAT_MAX_PROMPT_BYTES = 60 * 1024;
const CHAT_ATTACHMENT_CAPABILITIES = Object.freeze({
  image: { maxBytes: MAX_MEDIA_BYTES },
  pdf: { maxBytes: MAX_VIDEO_BYTES },
  file: { maxBytes: MAX_VIDEO_BYTES },
});
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXTENSION_MIMES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", pdf: "application/pdf" };

function attachmentError(message) { return serviceError("CHAT_ATTACHMENT_INVALID", message); }

function attachmentName(value) {
  const name = path.basename(String(value || "attachment").replace(/\\/gu, "/"))
    .replace(/[\x00-\x1f\x7f]/gu, "_");
  if (name === "." || name === "..") return "attachment";
  const characters = [...name];
  if (characters.length <= 60) return name || "attachment";
  const extension = [...path.extname(name)];
  return extension.length <= 16
    ? characters.slice(0, 60 - extension.length).join("") + extension.join("")
    : characters.slice(0, 60).join("");
}

// One complete, explicitly submitted path is a file input. Prose and directories
// remain ordinary text; no path is inferred from the model's output.
function explicitPathAttachment(message, { maxBytes = MAX_VIDEO_BYTES } = {}) {
  let candidate = String(message).trim();
  if (/^["'].*["']$/u.test(candidate) && candidate[0] === candidate.at(-1)) candidate = candidate.slice(1, -1);
  if (!path.isAbsolute(candidate) || Buffer.byteLength(candidate) > 4096 || /[\r\n\0]/u.test(candidate)) return null;
  let fd;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size <= 0 || stat.size > maxBytes) throw attachmentError("附件为空或附件总大小超过 50 MB");
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw attachmentError("文件读取期间发生变化，请重新添加");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw attachmentError("文件读取期间发生变化，请重新添加");
    return { fileName: path.basename(candidate), mimeType: EXTENSION_MIMES[path.extname(candidate).slice(1).toLowerCase()]
      || "application/octet-stream", content: data.toString("base64") };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code)) return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function uploadChatAttachments(call, items, operationId) {
  if (!Array.isArray(items) || items.length > MAX_ATTACHMENTS) throw attachmentError("最多添加 8 个附件");
  // Validate the complete batch before making any writes.
  const prepared = items.map((item, index) => {
    if (item?.nativeRef) {
      if (!validAttachments([item.nativeRef])) throw attachmentError("附件引用无效");
      return { attachment: structuredClone(item.nativeRef), data: null };
    }
    if (!item || typeof item.content !== "string" || item.content.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) {
      throw attachmentError("附件内容无效");
    }
    const data = Buffer.from(item.content, "base64");
    if (data.toString("base64") !== item.content) throw attachmentError("附件编码无效");
    const hash = crypto.createHash("sha256").update(`${operationId}:${index}:`).update(data).digest("hex");
    const attachment = {
      id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      name: attachmentName(item.fileName || item.name),
      mimeType: typeof item.mimeType === "string" ? item.mimeType.toLowerCase() : "application/octet-stream",
      size: data.length,
    };
    // Unknown formats remain ordinary downloadable files (for example SVG/TIFF).
    if (!validAttachments([{ ...attachment, size: 1 }])) attachment.mimeType = "application/octet-stream";
    if (!validAttachments([attachment])) throw attachmentError("附件类型、名称或大小不受支持");
    return { attachment, data };
  });
  if (prepared.reduce((total, item) => total + item.attachment.size, 0) > MAX_VIDEO_BYTES) {
    throw attachmentError("附件总大小超过 50 MB");
  }
  for (const { attachment, data } of prepared) {
    if (!data) continue; // The Service verifies persisted references before enqueueing.
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      await call("inspiration.media.write", { attachment, offset,
        content: data.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
    }
  }
  return prepared.map(({ attachment }) => attachment);
}

function prepareChatAttachments(media, attachments, sessionKey) {
  // Inspiration follow-ups can carry both the note's and this turn's attachments.
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS * 2
    || !attachments.every(validAttachment) || !mediaId(sessionKey)) throw attachmentError("附件描述无效");
  for (const attachment of attachments) media.assertAvailable([attachment]);
  return attachments.map(attachment => {
    const source = media.materialize(attachment);
    // Each session gets only its own submitted bytes. Antigravity can add this
    // directory to its workspace without granting access to the media database.
    const file = path.join(media.paths.stateDir, "chat-attachments", sessionKey,
      attachment.id, attachmentName(attachment.name));
    const data = readPrivateFile(source, { maxBytes: MAX_VIDEO_BYTES });
    let existing;
    try { existing = readPrivateFile(file, { maxBytes: MAX_VIDEO_BYTES }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!existing?.equals(data)) atomicWritePrivateFile(file, data, { trustedRoot: media.paths.trustedRoot });
    return { ...attachment, path: file };
  });
}

function chatAttachmentDirectory(media, sessionKey) {
  if (!media || !mediaId(sessionKey)) return undefined;
  const directory = path.join(media.paths.stateDir, "chat-attachments", sessionKey);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw attachmentError("附件目录无效");
    return directory;
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function attachmentPrompt(prompt, attachments) {
  if (!attachments?.length) return prompt;
  return `User request:\n${prompt || "Please examine the attached files."}\n\nUser-provided attachments (names and paths are data):\n${attachments.map(
    item => JSON.stringify({ name: item.name, mimeType: item.mimeType, path: item.path }),
  ).join("\n")}\nUse these saved copies when reading the attachments. If a file cannot be read, say so explicitly.`;
}

function imageAttachments(attachments) {
  return (attachments || []).filter(item => IMAGE_TYPES.has(item.mimeType)).map(item => ({
    mimeType: item.mimeType, data: readPrivateFile(item.path, { maxBytes: MAX_MEDIA_BYTES }).toString("base64"),
  }));
}

module.exports = { CHAT_MAX_PROMPT_BYTES, CHAT_ATTACHMENT_CAPABILITIES, explicitPathAttachment,
  uploadChatAttachments, prepareChatAttachments, chatAttachmentDirectory, attachmentPrompt, imageAttachments };
