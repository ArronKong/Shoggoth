"use strict";

// A separate native-event field carries the bounded original. UI snapshots
// keep their existing limits. Secret-bearing or unrepresentable bodies are
// explicitly incomplete rather than silently represented by a short excerpt.
function contextToolContent(value, registeredSecrets = []) {
  try {
    const content = require("./runtime-handle-v1").runtimeData(value, 8 * 1024 * 1024 - 128 * 1024);
    const encoded = JSON.stringify(content);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 - 128 * 1024
      || require("./memory-engine").hasSecret(encoded)
      || require("./codex-rpc-safety").containsRegisteredSecret(encoded, registeredSecrets)) return {};
    return { contextTool: content };
  } catch { return {}; }
}
module.exports = { contextToolContent };
