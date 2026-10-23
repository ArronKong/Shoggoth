"use strict";

const { serviceError } = require("./security");

// Local Runtime callbacks deliver accumulated text, never IPC callbacks. Keep
// one pending snapshot while a private transcript write is in progress.
function createMemoryModelTextStream({ consume, check, abort, maxBytes }) {
  let pending = null, running = null, closed = false, error = null;
  const fail = value => { error ??= value; pending = null; abort(); };
  const start = () => {
    if (running || pending === null || error) return;
    running = Promise.resolve().then(async () => {
      while (pending !== null && !error) {
        const text = pending; pending = null;
        try { check(); await consume(text); check(); } catch (value) { fail(value); }
      }
    }).finally(() => { running = null; start(); });
  };
  return {
    push(text) {
      if (closed || error) return;
      try {
        check();
        if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")
          || Buffer.byteLength(text) > maxBytes) {
          throw serviceError("MEMORY_IMPORT_OUTPUT_INVALID", "记忆模型的流式文本无效或超过预算");
        }
        pending = text; start();
      } catch (value) { fail(value); }
    },
    async close() { closed = true; while (running) await running; },
    get error() { return error; },
  };
}

module.exports = { createMemoryModelTextStream };
