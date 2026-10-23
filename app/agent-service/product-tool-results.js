"use strict";

const crypto = require("node:crypto");

// A large product tool result enters the CLI's history and is resent with every
// later model call of that session. The MCP helper therefore returns a preview
// plus a resultRef for results above LARGE_RESULT_BYTES and keeps the full text
// in this helper process; product_result_read pages through it. Nothing is sent
// to the Service again, and a restarted helper simply reports the ref expired.

const LARGE_RESULT_BYTES = 24 * 1024;
const PREVIEW_CHARACTERS = 6_000;
const MAX_READ_CHARACTERS = 16_000;
const MAX_CACHED_RESULTS = 32;
const MAX_CACHED_CHARACTERS = 4 * 1024 * 1024;
const PRODUCT_RESULT_READ = "product_result_read";
const REF_PATTERN = /^res-[0-9a-f]{24}$/u;

// Results these tools return must stay whole: they carry their own truncation
// and images (browser/computer), host UI state, user answers, command exits, or
// group protocol references used by later calls.
function keepsWholeResult(toolName) {
  return toolName === "browser_tool_call" || toolName === "request_user_input" || toolName === "workspace_execute"
    || toolName.startsWith("computer_") || toolName.startsWith("group_")
    || ["render_ui", "update_ui", "get_ui_state"].includes(toolName);
}

const PRODUCT_RESULT_READ_DEFINITION = Object.freeze({
  name: PRODUCT_RESULT_READ,
  description: "Read more of a large Shoggoth tool result that was returned as a preview with a resultRef. Pass the resultRef and the offset from nextOffset; each read returns up to 16000 characters and the next offset, or null at the end. A ref expires when the session's tool helper restarts; call the original tool again then.",
  inputSchema: Object.freeze({ type: "object", additionalProperties: false, required: ["resultRef", "offset"], properties: Object.freeze({
    resultRef: Object.freeze({ type: "string", pattern: "^res-[0-9a-f]{24}$" }),
    offset: Object.freeze({ type: "integer", minimum: 0 }),
    length: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_READ_CHARACTERS }),
  }) }),
  annotations: Object.freeze({ title: "Shoggoth tool result read", readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false }),
});

class ProductResultCache {
  #entries = new Map();
  #characters = 0;

  constructor({ randomBytes = crypto.randomBytes } = {}) { this.randomBytes = randomBytes; }

  put(text) {
    const ref = `res-${this.randomBytes(12).toString("hex")}`;
    this.#entries.set(ref, text);
    this.#characters += text.length;
    while (this.#entries.size > MAX_CACHED_RESULTS || this.#characters > MAX_CACHED_CHARACTERS) {
      const [oldest, value] = this.#entries.entries().next().value;
      this.#entries.delete(oldest);
      this.#characters -= value.length;
    }
    return ref;
  }

  read(ref, offset, length = MAX_READ_CHARACTERS) {
    const text = this.#entries.get(ref);
    if (text === undefined) return null;
    const start = Math.min(offset, text.length);
    const end = Math.min(text.length, start + length);
    return { resultRef: ref, offset: start, text: text.slice(start, end), totalCharacters: text.length,
      nextOffset: end < text.length ? end : null };
  }
}

function validReadArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => ["resultRef", "offset", "length"].includes(key))
    && typeof value.resultRef === "string" && REF_PATTERN.test(value.resultRef)
    && Number.isSafeInteger(value.offset) && value.offset >= 0
    && (value.length === undefined || (Number.isSafeInteger(value.length) && value.length >= 1
      && value.length <= MAX_READ_CHARACTERS));
}

// Returns a preview object for a large result, or null to keep it whole.
function pagedResult(cache, toolName, result) {
  if (keepsWholeResult(toolName)) return null;
  const text = JSON.stringify(result);
  if (text === undefined || Buffer.byteLength(text, "utf8") <= LARGE_RESULT_BYTES) return null;
  const resultRef = cache.put(text);
  return { truncated: true, tool: toolName, resultRef, totalCharacters: text.length,
    preview: text.slice(0, PREVIEW_CHARACTERS), nextOffset: Math.min(PREVIEW_CHARACTERS, text.length),
    note: "Large result: this is the first part of its JSON text. Read the rest with product_result_read." };
}

module.exports = { LARGE_RESULT_BYTES, PREVIEW_CHARACTERS, MAX_READ_CHARACTERS, PRODUCT_RESULT_READ,
  PRODUCT_RESULT_READ_DEFINITION, ProductResultCache, keepsWholeResult, validReadArguments, pagedResult };
