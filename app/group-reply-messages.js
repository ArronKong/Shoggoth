"use strict";

const MAX_MESSAGES = 32;
const MAX_TEXT_BYTES = 4096;
function prefix(text, limit = MAX_TEXT_BYTES) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return bytes.subarray(0, limit).toString("utf8").replace(/\uFFFD+$/u, "");
}

/** Preserve source message identities; equal text in different messages is intentional. */
function groupReplyMessages(value, { maxTextBytes = MAX_TEXT_BYTES, maxTotalBytes = MAX_MESSAGES * MAX_TEXT_BYTES } = {}) {
  if (!Array.isArray(value)) return [];
  const messages = new Map();
  let remaining = maxTotalBytes;
  for (const item of value.slice(-MAX_MESSAGES)) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 512 || !item.id.isWellFormed() || item.id.includes("\0")
      || typeof item.text !== "string" || !item.text.trim() || !item.text.isWellFormed() || item.text.includes("\0")) continue;
    if (remaining <= 0) break;
    const text = prefix(item.text, Math.min(maxTextBytes, remaining));
    remaining -= Buffer.byteLength(text);
    messages.set(item.id, { id: item.id, text,
      ...(typeof item.pending === "boolean" ? { pending: item.pending } : {}),
      ...(typeof item.final === "boolean" ? { final: item.final } : {}) });
  }
  return [...messages.values()];
}

module.exports = { groupReplyMessages, MAX_MESSAGES, MAX_TEXT_BYTES };
