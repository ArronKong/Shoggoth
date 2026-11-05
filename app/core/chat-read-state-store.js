"use strict";

// App-owned presentation state, shared by every UI connected to this data root.
// Replies remain derived from each backend's canonical history. Only the first
// launch cutoff and explicit read acknowledgements are persisted here.
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readPrivateFile, atomicWritePrivateFile, recoverInterruptedPrivateFile } = require("../agent-service/private-file");

const MAX_BATCH = 256;
const validTime = value => Number.isSafeInteger(value) && value > 0;
const validKey = key => typeof key === "string" && /^agent:[^\s:]+:.+$/u.test(key)
  && key.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(key);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function fail(code) { throw Object.assign(new Error(code), { code }); }

function validateState(value) {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "installationId,read,revision,since,version"
    || value.version !== 1 || typeof value.installationId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.installationId) || !validTime(value.since)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !plain(value.read)
    || Object.entries(value.read).some(([key, at]) => !validKey(key) || !validTime(at))) {
    fail("CHAT_READ_STATE_UNAVAILABLE");
  }
  return value;
}

function createChatReadStateStore({ trustedRoot, directory = "ui-state", now = Date.now } = {}) {
  const filePath = path.join(trustedRoot, directory, "chat-read-state.json");
  let initialized = false;
  function load() { return validateState(JSON.parse(readPrivateFile(filePath).toString("utf8"))); }
  function ensure() {
    if (initialized) return;
    // Runs at app startup, before any backend history is loaded. Existing
    // installations adopt this cutoff once; old client-only v1/v2 dots are not
    // imported. Later windows, reloads and upgrades keep the same identity.
    recoverInterruptedPrivateFile(filePath, { trustedRoot });
    try { load(); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      atomicWritePrivateFile(filePath, JSON.stringify({ version: 1, installationId: randomUUID(),
        since: now(), revision: 0, read: {} }), { trustedRoot });
    }
    initialized = true;
  }
  function read() { ensure(); return load(); }
  function merge(input) {
    if (!plain(input) || Object.keys(input).sort().join(",") !== "installationId,read"
      || typeof input.installationId !== "string" || !plain(input.read)
      || Object.keys(input.read).length > MAX_BATCH
      || Object.entries(input.read).some(([key, at]) => !validKey(key) || !validTime(at))) {
      fail("CHAT_READ_STATE_INVALID");
    }
    const current = read();
    if (input.installationId !== current.installationId) fail("CHAT_READ_STATE_STALE");
    const next = { ...current, read: { ...current.read } };
    let changed = false;
    for (const [key, at] of Object.entries(input.read)) {
      if (at <= Math.max(current.since, current.read[key] || 0)) continue;
      next.read[key] = at; changed = true;
    }
    if (!changed) return current;
    next.revision += 1;
    // The desktop owns the only writer. Synchronous merge + atomic replacement
    // keeps overlapping browser requests monotonic and crash-safe.
    atomicWritePrivateFile(filePath, JSON.stringify(next), { trustedRoot });
    return next;
  }
  return { ensure, read, merge, filePath };
}

module.exports = { createChatReadStateStore, MAX_BATCH };
