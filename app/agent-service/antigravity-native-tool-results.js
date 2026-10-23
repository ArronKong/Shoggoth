"use strict";

// Compatibility reader for the verified ACP 1.2.1 distribution. Its terminal
// tool updates lose native success, failure bodies and successful MCP outputs.
// Read only this account/session's native SQLite store, including its live WAL. Never
// replay a tool, read a reported output path, or interpret assistant prose.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { assertPrivateDirectory } = require("./security");
const { sqliteNativeBinding } = require("./sqlite-native-binding");

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ROWS = 2048;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const CALL_TYPE = "type.googleapis.com/antigravity.localharness.ToolCall";
const RESPONSE_TYPE = "type.googleapis.com/antigravity.localharness.ToolResponse";

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonical(value, depth = 0) {
  if (depth > 32) throw new Error("Native input is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (!plain(value)) throw new Error("Native input is invalid");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
}

function nativeToolCall({ id, name, server = null, input }) {
  try {
    if (typeof id !== "string" || !id.length || id.length > 512
      || typeof name !== "string" || !name.length || name.length > 128
      || (server !== null && (typeof server !== "string" || !server.length || server.length > 128))
      || !plain(input) || Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) return null;
    return { id, name, server,
      inputKey: crypto.createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex") };
  } catch { return null; }
}

// Decode only selected singular protobuf fields. Bounds, duplicate fields and
// unsupported wire types fail closed; opaque context/stack blobs stay opaque.
function field(buffer, wanted) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error("Invalid protobuf");
  let offset = 0;
  let found;
  let count = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (offset >= buffer.length) throw new Error("Truncated protobuf");
      const byte = buffer[offset++];
      value += (byte & 127) * scale;
      if (!Number.isSafeInteger(value)) throw new Error("Oversized protobuf integer");
      if (byte < 128) return value;
      scale *= 128;
    }
    throw new Error("Invalid protobuf integer");
  };
  while (offset < buffer.length) {
    if (++count > 4096) throw new Error("Too many protobuf fields");
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number < 1) throw new Error("Invalid protobuf field");
    let value;
    if (wire === 0) value = varint();
    else {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || length > buffer.length - offset) throw new Error("Invalid protobuf length");
      value = buffer.subarray(offset, offset + length);
      offset += length;
    }
    if (number === wanted) {
      if (found !== undefined) throw new Error("Duplicate protobuf field");
      found = value;
    }
  }
  return found;
}

function text(buffer) {
  if (!(buffer instanceof Uint8Array)) throw new Error("Missing protobuf text");
  const bytes = Buffer.from(buffer);
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes) || value.includes("\0")) throw new Error("Invalid native text");
  return value;
}

function nativeTimestamp(bytes) {
  if (bytes === undefined) return null;
  const seconds = field(bytes, 1) ?? 0, nanos = field(bytes, 2) ?? 0;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1e9) return null;
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  return Number.isSafeInteger(ms) ? ms : null;
}

function nativeTiming(payload) {
  const metadata = field(payload, 5);
  if (!metadata) return undefined;
  const startedAt = nativeTimestamp(field(metadata, 32)), completedAt = nativeTimestamp(field(metadata, 8));
  return startedAt !== null && completedAt !== null && completedAt >= startedAt
    && completedAt - startedAt <= 24 * 60 * 60 * 1000
    ? { source: "antigravity-native", startedAt, completedAt } : undefined;
}

function decodeDeniedRow(row, sessionId) {
  if (row.status !== 7) return null;
  const metadata = field(row.step_payload, 5);
  if (!metadata) return null;
  const source = field(metadata, 20);
  if (!source || text(field(source, 1)) !== sessionId || text(field(source, 4)) !== sessionId
    || (field(source, 2) ?? 0) !== row.idx) return null;
  const call = field(metadata, 4);
  if (!call) return null;
  const input = JSON.parse(text(field(call, 3)));
  const identity = nativeToolCall({ id: text(field(call, 1)), name: text(field(call, 2)), input });
  if (!identity || (field(call, 9) !== undefined && text(field(call, 9)) !== identity.name)) return null;
  const body = field(row.step_payload, 24), error = field(row.step_payload, 31);
  if (!body || !error || !Buffer.from(field(body, 3) || []).equals(Buffer.from(error))) return null;
  if (row.error_details?.length && !Buffer.from(row.error_details).equals(Buffer.from(error))) return null;
  const output = text(field(error, 1) ?? field(error, 2));
  if (!output || Buffer.byteLength(output) > MAX_INPUT_BYTES) return null;
  return { ...identity, input, unannouncedFailure: true,
    result: { status: "failed", output, timing: nativeTiming(row.step_payload) } };
}

function decodeRow(row, sessionId) {
  const payload = row.step_payload;
  if (field(payload, 1) !== row.step_type || field(payload, 4) !== row.status) throw new Error("Native step mismatch");
  if (row.step_type === 17) return decodeDeniedRow(row, sessionId);
  const external = row.step_type === 103;
  const body = field(payload, external ? 116 : 47);
  const wrappedCall = external ? field(body, 3) : null;
  if (external && text(field(wrappedCall, 1)) !== CALL_TYPE) throw new Error("Unknown native call schema");
  const call = external ? field(wrappedCall, 2) : field(body, 2);
  const identity = nativeToolCall({ id: text(field(call, 1)), name: text(field(call, 2)),
    server: external ? null : text(field(body, 1)), input: JSON.parse(text(field(call, 3))) });
  if (!identity || (external && text(field(body, 2)) !== identity.name)) throw new Error("Invalid native identity");
  let result = null;
  if ([3, 7].includes(row.status)) {
    if (row.status === 3 && row.error_details?.length) throw new Error("Native success contains an error");
    let output;
    if (external) {
      const wrappedResponse = field(body, 4);
      if (wrappedResponse === undefined && row.status === 7 && row.error_details?.length) {
        output = text(field(row.error_details, 2) ?? field(row.error_details, 1));
      } else {
        if (text(field(wrappedResponse, 1)) !== RESPONSE_TYPE) throw new Error("Unknown native response schema");
        const response = field(wrappedResponse, 2);
        if (text(field(response, 1)) !== identity.name) throw new Error("Native response tool mismatch");
        output = JSON.parse(text(field(response, 2)));
      }
    } else {
      const raw = text(field(body, 3));
      try { output = JSON.parse(raw); } catch { output = raw; }
    }
    result = { status: row.status === 3 && output?.isError !== true ? "completed" : "failed", output, timing: nativeTiming(payload) };
  }
  return { ...identity, result };
}

function validateNativeStat(stat, directory) {
  // Native leaves use 0644 inside the already-private account home. Reject
  // symlinks, hard links, foreign ownership and writable-by-others paths.
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
    || (!directory && stat.nlink !== 1)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o022) !== 0) throw new Error("Unsafe native store path");
}

function openReadOnly(file) {
  let Database;
  let builtin = true;
  try { Database = require("node:sqlite").DatabaseSync; }
  catch (error) {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    Database = require("better-sqlite3");
    builtin = false;
  }
  const nativeBinding = !builtin ? sqliteNativeBinding() : null;
  return new Database(file, { [builtin ? "readOnly" : "readonly"]: true,
    ...(process.versions.electron && nativeBinding && !builtin ? { nativeBinding } : {}) });
}

class AntigravityNativeToolResults {
  constructor({ home }) { this.home = home; }

  _read(sessionId, read) {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid native session");
    assertPrivateDirectory(this.home);
    let folder = this.home;
    for (const part of [".gemini", "antigravity-acp", "conversations"]) {
      folder = path.join(folder, part);
      validateNativeStat(fs.lstatSync(folder), true);
    }
    const file = path.join(folder, `${sessionId}.db`);
    const before = fs.lstatSync(file);
    validateNativeStat(before, false);
    if (before.size > 512 * 1024 * 1024) throw new Error("Native store is too large");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { validateNativeStat(fs.lstatSync(file + suffix), false); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const db = openReadOnly(file);
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=25; BEGIN;");
      const result = read(db);
      const after = fs.lstatSync(file);
      validateNativeStat(after, false);
      if (after.dev !== before.dev || after.ino !== before.ino) throw new Error("Native store changed identity");
      return result;
    } finally { db.close(); }
  }

  _session(db, sessionId) {
    const rows = db.prepare("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 2").all();
    return rows.length === 1 && rows[0].trajectory_id === sessionId && rows[0].cascade_id === sessionId;
  }

  cursor(sessionId, { fresh = false } = {}) {
    try {
      return this._read(sessionId, (db) => {
        const cursor = db.prepare("SELECT coalesce(max(idx), -1) AS last FROM steps").get().last;
        if (!Number.isSafeInteger(cursor) || cursor < -1 || !this._session(db, sessionId)) return null;
        return cursor;
      });
    } catch (error) { return fresh && error.code === "ENOENT" ? -1 : null; }
  }

  recover(sessionId, cursor, calls) { return this.reconcile(sessionId, cursor, calls).results; }

  reconcile(sessionId, cursor, calls) {
    const recovered = { results: new Map(), failures: [] };
    if (!Number.isSafeInteger(cursor) || cursor < -1 || calls.length > MAX_ROWS) return recovered;
    try {
      return this._read(sessionId, (db) => {
        if (!this._session(db, sessionId)) return recovered;
        const headers = db.prepare("SELECT idx, step_type, status, length(step_payload) AS bytes, length(error_details) AS errorBytes FROM steps WHERE idx > ? AND step_type IN (17, 38, 103) ORDER BY idx LIMIT ?")
          .all(cursor, MAX_ROWS + 1);
        if (headers.length > MAX_ROWS || headers.some((row) => !Number.isSafeInteger(row.bytes)
          || row.bytes < 1 || row.bytes > MAX_BLOB_BYTES || row.errorBytes > MAX_BLOB_BYTES)
          || headers.reduce((sum, row) => sum + row.bytes + (row.errorBytes || 0), 0) > MAX_SCAN_BYTES) return recovered;
        const select = db.prepare("SELECT step_payload, error_details FROM steps WHERE idx = ?");
        const native = headers.map((row) => decodeRow({ ...row, ...select.get(row.idx) }, sessionId)).filter(Boolean);
        const key = (call) => JSON.stringify([call.server, call.name, call.inputKey, call.server === null ? call.id : null]);
        const nativeByKey = new Map();
        const callsByKey = new Map();
        for (const row of native) {
          const identity = key(row);
          nativeByKey.set(identity, nativeByKey.has(identity) ? null : row);
        }
        for (const call of calls) {
          const identity = key(call);
          callsByKey.set(identity, (callsByKey.get(identity) || 0) + 1);
        }
        for (const call of calls) {
          const identity = key(call);
          const match = nativeByKey.get(identity);
          // ACP changes MCP IDs. A current-turn tuple must be unique on both
          // sides; repeated identical calls are deliberately not guessed.
          if (match?.result && callsByKey.get(identity) === 1) {
            recovered.results.set(call.id, match.result);
          }
        }
        const countsById = new Map();
        for (const row of native) countsById.set(row.id, (countsById.get(row.id) || 0) + 1);
        recovered.failures = native.filter(row => row.unannouncedFailure && countsById.get(row.id) === 1
          && !calls.some(call => call.id === row.id));
        return recovered;
      });
    } catch { return { results: new Map(), failures: [] }; }
  }
}

module.exports = { AntigravityNativeToolResults, nativeToolCall };
