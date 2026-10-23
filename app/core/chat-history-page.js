"use strict";

const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const secrets = new WeakMap();
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
function historyError(code = "CHAT_HISTORY_CURSOR_INVALID") {
  return Object.assign(new Error(code === "CHAT_HISTORY_CURSOR_INVALID"
    ? "历史位置已变化，请重新读取" : "无法完整读取这页历史，请重试"), { code });
}
function historySource(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function secret(owner) {
  if (!secrets.has(owner)) secrets.set(owner, randomBytes(32));
  return secrets.get(owner);
}
function historyPageOptions(options = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (options.cursor != null && (typeof options.cursor !== "string" || options.cursor.length > 16384))) {
    throw historyError("INVALID_PARAMS");
  }
  return { limit, cursor: options.cursor ?? null };
}
function encodeHistoryCursor(owner, scope, position) {
  const body = Buffer.from(JSON.stringify({ scope, position })).toString("base64url");
  const mac = createHmac("sha256", secret(owner)).update(body).digest("base64url");
  if (body.length + mac.length + 1 > 16384) throw historyError("CHAT_HISTORY_TOO_LARGE");
  return `${body}.${mac}`;
}
function decodeHistoryCursor(owner, scope, cursor) {
  if (cursor == null) return null;
  try {
    if (typeof cursor !== "string" || cursor.length > 16384) throw 0;
    const [body, mac, extra] = cursor.split(".");
    if (!body || !mac || extra !== undefined) throw 0;
    const expected = createHmac("sha256", secret(owner)).update(body).digest();
    const actual = Buffer.from(mac, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw 0;
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (value.scope !== scope || !value.position || typeof value.position !== "object") throw 0;
    return value.position;
  } catch { throw historyError(); }
}
function historyRowId(row) {
  if (typeof row?.__openclaw?.id === "string" && row.__openclaw.id) return row.__openclaw.id;
  if ((typeof row?.id === "string" && row.id) || Number.isSafeInteger(row?.id)) return String(row.id);
  // Older gateways omit IDs on timeline markers. Content + timestamp binds the
  // overlap check without minting a new user-visible message identity.
  return historySource(row);
}
function historyPage(messages, hasMore, nextCursor, sourceId) {
  if (!Array.isArray(messages) || typeof hasMore !== "boolean"
    || (hasMore ? typeof nextCursor !== "string" || !nextCursor : nextCursor !== null)) {
    throw historyError("CHAT_HISTORY_INVALID");
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > MAX_PAGE_BYTES) throw historyError("CHAT_HISTORY_TOO_LARGE");
  return { messages, hasMore, nextCursor, sourceId };
}

module.exports = { MAX_PAGE_BYTES, historyError, historySource, historyPageOptions,
  encodeHistoryCursor, decodeHistoryCursor, historyRowId, historyPage };
