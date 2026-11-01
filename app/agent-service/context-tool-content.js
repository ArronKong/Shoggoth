"use strict";

// A separate native-event field carries the bounded original. UI snapshots
// keep their existing limits. Conversation originals retain user information;
// diagnostic redaction and memory admission are separate boundaries.
function contextToolContent(value) {
  try {
    const content = require("./runtime-handle-v1").runtimeData(value, 8 * 1024 * 1024 - 128 * 1024);
    const encoded = JSON.stringify(content);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 - 128 * 1024) return {};
    return { contextTool: content };
  } catch { return {}; }
}
module.exports = { contextToolContent };
