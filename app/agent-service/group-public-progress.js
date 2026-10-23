"use strict";

const { validText } = require("../group-result-content");
const { redactGrantTokens } = require("./group-tool-grant");

// Transport adapters pass only public assistant paragraphs, never reasoning or
// tool payloads. Keep paragraph boundaries and replace a paragraph's own deltas.
class GroupPublicProgress {
  constructor() { this.items = new Map(); this.bytes = 0; this.truncated = false; }
  put(id, text) {
    if (!validText(text) || !text.trim()) return;
    text = redactGrantTokens(text);
    const bytes = this.bytes - Buffer.byteLength(this.items.get(id) ?? "") + Buffer.byteLength(text);
    if (bytes > 32 * 1024 * 1024 || !this.items.has(id) && this.items.size >= 4096) { this.truncated = true; return; }
    this.items.set(id, text); this.bytes = bytes;
  }
  text(excludeId = null) {
    return [...[...this.items].filter(([id]) => id !== excludeId).map(([, text]) => text),
      ...(this.truncated ? ["[公开过程过长，后续段落未保留]"] : [])].join("\n\n");
  }
}

module.exports = { GroupPublicProgress };
