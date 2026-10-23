"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

const MAX_HISTORY_ITEM_BYTES = 48 * 1024;
const FRAGMENT_DATA_BYTES = 20 * 1024;
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
    const turnId = run?.runtimeTurnRef?.turnId;
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

function reassembleHistoryItems(items) {
  if (!Array.isArray(items)) throw adapterError("history items 无效");
  const result = [], seen = new Set(); let totalBytes = 0;
  for (let i = 0; i < items.length;) {
    const item = items[i]; let message;
    if (item.fragment === null) {
      if (!item.payload || Object.keys(item.payload).join(",") !== "message") throw adapterError("history payload 无效");
      message = cloneJson(item.payload.message); i += 1;
    } else {
      const f = item.fragment, p = item.payload;
      if (!f || f.index !== 0 || !Number.isSafeInteger(f.count) || f.count < 2 || f.count > 1024
        || !p || p.encoding !== "gateway-message-json-utf8" || !/^[a-f0-9]{64}$/u.test(p.sha256)
        || i + f.count > items.length) throw adapterError("history fragment 不完整");
      const chunks = [];
      for (let j = 0; j < f.count; j += 1) {
        const next = items[i + j];
        if (next.fragment?.messageId !== f.messageId || next.fragment?.index !== j || next.fragment?.count !== f.count
          || next.runId !== item.runId || next.role !== item.role || next.type !== item.type
          || next.payload?.encoding !== p.encoding || next.payload?.sha256 !== p.sha256
          || typeof next.payload?.data !== "string" || !next.payload.data.isWellFormed()
          || jsonlBytes(next) > MAX_HISTORY_ITEM_BYTES) throw adapterError("history fragment 无效");
        chunks.push(next.payload.data);
      }
      const serialized = chunks.join("");
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024 || crypto.createHash("sha256").update(serialized).digest("hex") !== p.sha256)
        throw adapterError("history fragment 校验失败");
      try { message = JSON.parse(serialized); } catch { throw adapterError("history fragment JSON 无效"); }
      if (message.id !== f.messageId) throw adapterError("history fragment 身份无效");
      i += f.count;
    }
    if (!message || !OPAQUE_ID_PATTERN.test(message.id) || !ROLES.has(message.role) || !Array.isArray(message.content)
      || seen.has(message.id)) throw adapterError("history message 无效");
    seen.add(message.id); totalBytes += Buffer.byteLength(JSON.stringify(message));
    if (totalBytes > 8 * 1024 * 1024) throw adapterError("history 总容量超限");
    result.push({ id: item.fragment === null ? item.id : message.id, runId: item.runId, role: item.role, type: item.type,
      payload: { message }, createdAt: item.createdAt, fragment: null });
  }
  return result;
}
function fragmentHistoryItem(item) {
  return jsonlBytes(item) <= MAX_HISTORY_ITEM_BYTES ? [item]
    : fragmentNormalMessage(item.payload.message, item.runId, item.role, item.type, item.createdAt);
}
module.exports = { adaptCodexChatHistoryPage, fragmentHistoryItem, reassembleHistoryItems };
