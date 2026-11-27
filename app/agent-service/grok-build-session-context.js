"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Grok owns these small session metadata files and may write them as 0644.
function readMetadata(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const data = Buffer.alloc(stat.size);
    if (fs.readSync(fd, data, 0, data.length, 0) !== data.length) return null;
    return { text: data.toString("utf8"), observedAt: Math.floor(stat.mtimeMs) };
  } finally { fs.closeSync(fd); }
}

function sessionDirectory(home, cwd, sessionId) {
  const root = path.join(fs.realpathSync(home), "sessions");
  if (fs.realpathSync(root) !== root) return null;
  const encoded = encodeURIComponent(cwd).replace(/[!'()*]/gu,
    char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  if (encoded.length <= 255) return path.join(root, encoded, sessionId);
  // Long workspaces use a slug with a hash. Grok records the original path in .cwd.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const group = path.join(root, entry.name);
    const dir = path.join(group, sessionId);
    const marker = path.join(group, ".cwd");
    if (fs.existsSync(dir) && fs.existsSync(marker) && readMetadata(marker, 32 * 1024)?.text === cwd) return dir;
  }
  return null;
}

function readGrokSessionContext({ home, cwd, sessionId, model, sinceMs, untilMs }) {
  try {
    if (!Number.isSafeInteger(sinceMs) || !Number.isSafeInteger(untilMs) || untilMs < sinceMs
      || !path.isAbsolute(home) || !path.isAbsolute(cwd)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(sessionId)) return null;
    const dir = sessionDirectory(home, cwd, sessionId);
    if (!dir || fs.realpathSync(dir) !== dir) return null;
    const metadata = readMetadata(path.join(dir, "summary.json"), 128 * 1024);
    if (!metadata) return null;
    const summary = JSON.parse(metadata.text);
    if (summary?.info?.id !== sessionId || summary.info.cwd !== cwd
      || (model && summary.current_model_id !== model)) return null;
    const signals = readMetadata(path.join(dir, "signals.json"), 128 * 1024);
    if (!signals || signals.observedAt < sinceMs || signals.observedAt > untilMs) return null;
    const { contextTokensUsed: usedTokens, contextWindowTokens: contextWindow } = JSON.parse(signals.text);
    if (!Number.isSafeInteger(usedTokens) || usedTokens < 0
      || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
    return { runtimeSessionId: sessionId, usedTokens, contextWindow, quality: "estimated",
      source: "session_stats", observedAt: signals.observedAt };
  } catch { return null; }
}

module.exports = { readGrokSessionContext };
