"use strict";

const {
  federationInputProvenanceForOperationId,
} = require("../federation-chat-provenance");

const SESSION_DERIVED_TITLE_MAX_CHARS = 60;

function deriveSessionTitle(text) {
  if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")) return null;
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, SESSION_DERIVED_TITLE_MAX_CHARS).join("");
}

function textFromParts(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((part) => {
    if (typeof part === "string") return part;
    return part && typeof part === "object" && typeof part.text === "string"
      ? part.text : "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function importedUserText(content) {
  const item = content?.historyItem;
  if (!item || typeof item !== "object" || item.role !== "user") return null;
  if (typeof item.payload?.text === "string") return item.payload.text;
  const message = item.payload?.message;
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object" || message.role !== "user") return null;
  return textFromParts(message.content);
}

function deriveSessionTitleFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (!event || event.kind !== "user") continue;
    if (federationInputProvenanceForOperationId(event.content?.operationId)) continue;
    if (event.content?.historyItem?.payload?.message?.provenance?.kind === "inter_session") {
      continue;
    }
    const directText = typeof event.content?.text === "string"
      ? event.content.text
      : typeof event.content?.message === "string" ? event.content.message : null;
    const title = deriveSessionTitle(directText ?? importedUserText(event.content));
    if (title !== null) return title;
  }
  return null;
}

module.exports = {
  SESSION_DERIVED_TITLE_MAX_CHARS,
  deriveSessionTitle,
  deriveSessionTitleFromEvents,
};
