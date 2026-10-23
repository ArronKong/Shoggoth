"use strict";

const { pathToFileURL } = require("node:url");
const { IMAGE_TYPES, MAX_TEXT_BYTES, isText, utf8, attachmentText } = require("./chat-attachment-text");

function nativeAttachmentParts(attachments) {
  return attachments.filter(item => IMAGE_TYPES.has(item.mimeType)).map(item => ({
    type: "file", url: pathToFileURL(item.path).href, mime: item.mimeType, filename: item.name,
  }));
}

function legacyAttachmentText(part, maxBytes = MAX_TEXT_BYTES) {
  let text = null;
  // Native OpenCode already materialized the submitted bytes in the original
  // file part. Decode only bounded text data; never fetch URLs or read a path
  // supplied by history while normalizing a continuation.
  if (isText(part.filename, part.mime) && typeof part.url === "string"
    && part.url.length <= Math.ceil(maxBytes / 3) * 4 + 512) {
    const match = /^data:[^;,]{1,256};base64,([A-Za-z0-9+/]*={0,2})$/u.exec(part.url);
    if (match) {
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length <= maxBytes && bytes.toString("base64") === match[1]) text = utf8(bytes);
    }
  }
  return attachmentText(part.filename || "attachment", part.mime || "application/octet-stream", text);
}

module.exports = { IMAGE_TYPES, nativeAttachmentParts, legacyAttachmentText };
