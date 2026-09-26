"use strict";

const {
  containsRegisteredSecret,
  redactDiagnostic,
  validateRegisteredSecrets,
} = require("./codex-rpc-safety");

const DEFAULT_MAX_ARRAY_ITEMS = 128;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_KEYS = 128;
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024;
const MIN_MAX_SNAPSHOT_BYTES = 512;
const DEFAULT_MAX_STRING_BYTES = 24 * 1024;
const MAX_KEY_BYTES = 256;
const MAX_SINGLE_STRING_BYTES = 8 * 1024;

function jsonEncodedPrefix(value, maxBytes) {
  if (maxBytes <= 0) return "";
  const output = [];
  let used = 0;
  for (const character of value) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (used + encodedBytes > maxBytes) break;
    output.push(character);
    used += encodedBytes;
  }
  return output.join("");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function protectedObjectKey(root, path, key) {
  if (path.length === 0) {
    const identity = new Set([
      "known", "type", "method", "requestId", "threadId", "turnId", "itemId", "toolCallId",
    ]);
    if (identity.has(key)) return true;
    if (root.type === "prompt") {
      return new Set([
        "questions", "message", "requestedSchema", "serverName", "mode", "url", "elicitationId", "isBlocking",
      ]).has(key);
    }
    return root.type === "approval" && key === "command";
  }
  return path[0] === "questions" && path.length === 2
    && new Set(["id", "header", "question"]).has(key);
}

function pruneOneCollection(root, value, path = []) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (pruneOneCollection(root, value[index], [...path, index])) return true;
    }
    const minimum = path.length === 1 && path[0] === "questions" ? 1 : 0;
    if (value.length > minimum) {
      value.pop();
      return true;
    }
    return false;
  }
  const keys = Object.keys(value);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (pruneOneCollection(root, value[key], [...path, key])) return true;
  }
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (protectedObjectKey(root, path, key)) continue;
    delete value[key];
    return true;
  }
  return false;
}

function truncateLargestString(root) {
  let selected = null;
  function visit(value, parent, key) {
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(JSON.stringify(value)) - 2;
      if (!selected || bytes > selected.bytes) selected = { parent, key, value, bytes };
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const childKey of Object.keys(value)) visit(value[childKey], value, childKey);
  }
  visit(root, null, null);
  if (!selected || selected.bytes === 0) return false;
  selected.parent[selected.key] = jsonEncodedPrefix(selected.value, Math.floor(selected.bytes / 2));
  return true;
}

function enforceSnapshotByteLimit(snapshot, maxSnapshotBytes) {
  while (jsonBytes(snapshot) > maxSnapshotBytes && pruneOneCollection(snapshot, snapshot)) {}
  while (jsonBytes(snapshot) > maxSnapshotBytes && truncateLargestString(snapshot)) {}
  if (jsonBytes(snapshot) > maxSnapshotBytes) {
    const error = new Error("Codex normalized event cannot fit its configured byte limit");
    error.code = "CODEX_EVENT_SNAPSHOT_LIMIT_FAILED";
    throw error;
  }
  return snapshot;
}

function safeSnapshot(value, rawOptions = {}) {
  const registeredSecrets = validateRegisteredSecrets(rawOptions.registeredSecrets || []);
  const configuredMax = rawOptions.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(configuredMax) || configuredMax < MIN_MAX_SNAPSHOT_BYTES) {
    const error = new Error(`Codex normalized event byte limit must be at least ${MIN_MAX_SNAPSHOT_BYTES}`);
    error.code = "CODEX_EVENT_SNAPSHOT_LIMIT_INVALID";
    throw error;
  }
  const maxSnapshotBytes = configuredMax;
  const limits = {
    maxArrayItems: Math.max(0, rawOptions.maxSnapshotArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS),
    maxDepth: Math.max(1, rawOptions.maxSnapshotDepth ?? DEFAULT_MAX_DEPTH),
    maxKeys: Math.max(0, rawOptions.maxSnapshotKeys ?? DEFAULT_MAX_KEYS),
    maxStringBytes: Math.min(
      Math.max(0, rawOptions.maxSnapshotStringBytes ?? DEFAULT_MAX_STRING_BYTES),
      Math.floor(maxSnapshotBytes / 2),
    ),
  };
  const state = {
    arrayItems: 0,
    keys: 0,
    remainingKeyBytes: Math.floor(maxSnapshotBytes / 8),
    remainingStringBytes: limits.maxStringBytes,
    seen: new WeakSet(),
  };

  function stringSnapshot(input, maxBytes = MAX_SINGLE_STRING_BYTES) {
    if (state.remainingStringBytes <= 0) return "";
    const redacted = redactDiagnostic(input, registeredSecrets);
    const allowed = Math.min(maxBytes, state.remainingStringBytes);
    const output = jsonEncodedPrefix(redacted, allowed);
    state.remainingStringBytes -= Buffer.byteLength(JSON.stringify(output)) - 2;
    return output;
  }

  function keySnapshot(input) {
    if (state.remainingKeyBytes <= 0) return "";
    const redacted = redactDiagnostic(input, registeredSecrets);
    const output = jsonEncodedPrefix(redacted, Math.min(MAX_KEY_BYTES, state.remainingKeyBytes));
    state.remainingKeyBytes -= Buffer.byteLength(JSON.stringify(output)) - 2;
    return output;
  }

  function visit(input, depth) {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return stringSnapshot(input);
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "bigint") return stringSnapshot(input.toString());
    if (typeof input !== "object") return undefined;
    if (depth >= limits.maxDepth) return "[Truncated]";
    if (state.seen.has(input)) return "[Circular]";
    state.seen.add(input);

    if (Array.isArray(input)) {
      const remaining = Math.max(0, limits.maxArrayItems - state.arrayItems);
      const count = Math.min(input.length, remaining);
      state.arrayItems += count;
      const output = [];
      for (let index = 0; index < count; index += 1) {
        let child;
        try { child = visit(input[index], depth + 1); } catch { child = "[Unreadable]"; }
        output.push(child === undefined ? null : child);
      }
      if (count < input.length && state.arrayItems < limits.maxArrayItems) output.push("[Truncated]");
      return output;
    }

    const output = {};
    let keys;
    try { keys = Object.keys(input); } catch { return "[Unreadable]"; }
    for (const rawKey of keys) {
      if (state.keys >= limits.maxKeys) break;
      state.keys += 1;
      const key = keySnapshot(rawKey);
      if (!key || Object.hasOwn(output, key)) continue;
      let child;
      try { child = visit(input[rawKey], depth + 1); } catch { child = "[Unreadable]"; }
      if (child !== undefined) output[key] = child;
    }
    return output;
  }

  const snapshot = enforceSnapshotByteLimit(visit(value, 0), maxSnapshotBytes);
  return containsRegisteredSecret(JSON.stringify(snapshot), registeredSecrets) ? {} : snapshot;
}

module.exports = {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  MIN_MAX_SNAPSHOT_BYTES,
  safeSnapshot,
};
