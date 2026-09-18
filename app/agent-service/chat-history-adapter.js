"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const MAX_HISTORY_ITEM_BYTES = 48 * 1024;
const FRAGMENT_DATA_BYTES = 24 * 1024;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ROLES = new Set(["user", "assistant", "toolResult", "system"]);
const TOOL_ITEM_TYPES = new Set([
  "commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange",
  "collabAgentToolCall", "webSearch", "imageView", "imageGeneration",
]);
const STATUS_ITEM_TYPES = new Set([
  "contextCompaction", "enteredReviewMode", "exitedReviewMode", "turnStatus",
]);

function adapterError(message) {
  return serviceError("CHAT_RESPONSE_INVALID", message);
}

function cloneJson(value) {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("not json");
    return JSON.parse(encoded);
  } catch {
    throw adapterError("Codex history adapter 输入不是稳定 JSON");
  }
}

function jsonlBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function historyType(message) {
  if (message.isError === true) return "error";
  const itemType = message.codex?.itemType;
  if (itemType === "reasoning") return "thinking";
  if (itemType === "plan") return "plan";
  if (itemType === "hookPrompt") return "prompt";
  if (TOOL_ITEM_TYPES.has(itemType)
    || message.content?.some((entry) => entry?.type === "toolCall" || entry?.type === "tool_result")) {
    return "tool";
  }
  if (STATUS_ITEM_TYPES.has(itemType)) return "status";
  return "text";
}

function uniqueRunByTurn(runs) {
  const byTurn = new Map();
  for (const run of runs) {
    const turnId = run?.runtimeTurnRef?.turnId ?? run?.codexTurnId;
    if (typeof turnId !== "string" || turnId.length === 0) continue;
    const existing = byTurn.get(turnId);
    if (existing === undefined) byTurn.set(turnId, run.id);
    else byTurn.set(turnId, null);
  }
  return byTurn;
}

function splitString(value, maxBytes) {
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += codePoint;
    bytes += size;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function fragmentItem(input) {
  const identity = input.fragment;
  if (!identity || !OPAQUE_ID_PATTERN.test(identity.messageId)
    || !Number.isSafeInteger(identity.index) || identity.index < 0
    || !Number.isSafeInteger(identity.count) || identity.count <= 1
    || identity.index >= identity.count
    || identity.encoding !== "gateway-message-json-utf8"
    || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256)
    || typeof input.data !== "string" || !input.data.isWellFormed()
    || !ROLES.has(input.role)) {
    throw adapterError("Codex history fragment 无效");
  }
  const item = {
    id: `${identity.messageId}.fragment.${identity.index}`,
    runId: null,
    role: input.role,
    type: "text",
    payload: {
      encoding: identity.encoding,
      sha256: identity.sha256,
      data: input.data,
    },
    createdAt: 0,
    fragment: {
      messageId: identity.messageId,
      index: identity.index,
      count: identity.count,
    },
  };
  if (jsonlBytes(item) > MAX_HISTORY_ITEM_BYTES) {
    throw serviceError("CHAT_HISTORY_ITEM_TOO_LARGE", "Codex history fragment 超过协议限制");
  }
  return item;
}

function fragmentNormalMessage(message, runId, role, type, createdAt) {
  const serialized = JSON.stringify(message);
  const chunks = splitString(serialized, FRAGMENT_DATA_BYTES);
  const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
  return chunks.map((data, index) => {
    const item = {
      id: `${message.id}.fragment.${index}`,
      runId,
      role,
      type,
      payload: { encoding: "gateway-message-json-utf8", sha256, data },
      createdAt,
      fragment: { messageId: message.id, index, count: chunks.length },
    };
    if (chunks.length <= 1 || jsonlBytes(item) > MAX_HISTORY_ITEM_BYTES) {
      throw serviceError("CHAT_HISTORY_ITEM_TOO_LARGE", "Codex history item 超过协议限制");
    }
    return item;
  });
}

function adaptMessage(rawMessage, runByTurn) {
  const message = cloneJson(rawMessage);
  if (message?.kind === "fragment") return [fragmentItem(message)];
  if (!message || !OPAQUE_ID_PATTERN.test(message.id) || !ROLES.has(message.role)) {
    throw adapterError("Codex Gateway history message 无效");
  }
  const turnId = typeof message.codex?.turnId === "string" ? message.codex.turnId : null;
  const runId = turnId === null ? null : (runByTurn.get(turnId) ?? null);
  const type = historyType(message);
  const createdAt = safeTimestamp(message.timestamp);
  const item = {
    id: message.id,
    runId,
    role: message.role,
    type,
    payload: { message },
    createdAt,
    fragment: null,
  };
  return jsonlBytes(item) <= MAX_HISTORY_ITEM_BYTES
    ? [item]
    : fragmentNormalMessage(message, runId, message.role, type, createdAt);
}

function adaptCodexChatHistoryPage(rawPage, options = {}) {
  const page = cloneJson(rawPage);
  if (!page || !Array.isArray(page.messages) || typeof page.hasMore !== "boolean"
    || (page.nextCursor !== null && typeof page.nextCursor !== "string")
    || (page.hasMore ? page.nextCursor === null : page.nextCursor !== null)
    || !Array.isArray(options.runs)) {
    throw adapterError("Codex history page 无效");
  }
  const runByTurn = uniqueRunByTurn(options.runs);
  const messages = page.messages.flatMap((message) => adaptMessage(message, runByTurn));
  return Object.freeze({
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}

module.exports = { adaptCodexChatHistoryPage };
