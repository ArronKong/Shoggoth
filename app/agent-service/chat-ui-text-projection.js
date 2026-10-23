"use strict";

// Runtime deltas are transient. A UI publication seals the visible prefix into
// Transcript before the artifact, so a later full-item snapshot cannot move that
// prefix to the other side of the card. The full runtime text remains context.
class ChatUiTextProjection {
  constructor() { this.runs = new Map(); }
  run(runId, seed = 0) {
    if (!this.runs.has(runId)) this.runs.set(runId, { serial: seed, items: new Map(), flushed: new Set() });
    return this.runs.get(runId);
  }
  observe(runId, type, payload, seed = 0) {
    const run = this.run(runId, seed), key = payload.itemId || "default";
    let item = run.items.get(key);
    if (!item) { item = { full: "", sealed: "", segmentId: `native-text:${runId}:${++run.serial}`, text: "", committed: false }; run.items.set(key, item); }
    if (type === "text.delta") item.full += payload.delta;
    else item.full = payload.text;
    // A changed prefix is a correction, not authority to rewrite earlier
    // canonical segments. Keep the correction in a fresh visible segment.
    item.text = item.full.startsWith(item.sealed) ? item.full.slice(item.sealed.length) : item.full;
    const value = { ...payload, segmentId: item.segmentId,
      ...(type === "text" ? { text: item.text } : {}) };
    if (type === "text") item.committed = true;
    if (type === "text" && payload.phase === "commentary") run.items.delete(key);
    return value;
  }
  flush(runId, publicationId, append) {
    const run = this.runs.get(runId); if (!run || run.flushed.has(publicationId)) return [];
    const events = [];
    for (const item of run.items.values()) {
      if (item.text && !item.committed) events.push(append({ text: item.text, segmentId: item.segmentId }));
      item.sealed = item.full; item.text = ""; item.committed = false;
      item.segmentId = `native-text:${runId}:${++run.serial}`;
    }
    run.flushed.add(publicationId); return events.filter(Boolean);
  }
  forget(runId) { this.runs.delete(runId); }
}
module.exports = { ChatUiTextProjection };
