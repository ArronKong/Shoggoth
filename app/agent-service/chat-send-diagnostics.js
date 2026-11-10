"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { PUBLIC_MESSAGES } = require("./chat-service-protocol");

const context = new AsyncLocalStorage();
const APP_ROOT = path.resolve(__dirname, "..");
const MAX_BYTES = 64 * 1024, MAX_RECORDS = 32;
const PHASES = new Set(["request_validation", "controller", "response_validation", "secret_preparation",
  "send_validation", "ui_validation", "desktop_preflight", "runtime_selection", "memory_context",
  "memory_preflight", "run_input", "command_enqueue", "run_enqueue", "transcript_append", "runtime_admission",
  "app_preflight", "attachment_upload", "recall_observation", "service_request", "receipt_validation", "run_observation"]);
const CODES = new Set([...Object.keys(PUBLIC_MESSAGES), "UNKNOWN_LOCAL_ERROR", "WORK_RUN_SEND_FAILED",
  "ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "ENOENT", "EMFILE", "ENFILE", "ENOMEM",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE", "ERR_SQLITE_ERROR", "SQLITE_FULL",
  "SQLITE_BUSY", "SQLITE_READONLY", "SQLITE_IOERR", "PRIVATE_FILE_COMMIT_UNCERTAIN",
  "PENDING_COMMAND_COMMIT_UNCERTAIN", "PENDING_COMMAND_CAPACITY", "PENDING_COMMAND_INVALID",
  "WORK_RUN_SEND_INVALID", "WORK_RUN_SEND_CANCELED", "WORK_RUN_STORE_CLOSED", "WORK_RUN_IDEMPOTENCY_RECORD_MISSING",
  "WORK_RUN_COMMAND_ID_CONFLICT", "WORK_RUN_COMMAND_SOURCE_CONFLICT", "WORK_RUN_OPERATION_CONFLICT",
  "WORKSPACE_REQUIRED_FOR_WRITABLE_RUN", "MEMORY_SCOPE_REVOKED", "MEMORY_SOURCE_REVOKED",
  "RECALL_POLICY_UNAVAILABLE", "credentials_locked", "pending_commands_locked"]);
const NAMES = new Set(["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "AggregateError"]);
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

function data(value, key) {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function hash(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
}
function sourceFrame(value) {
  if (!value || typeof value.file !== "string" || !/^(?:agent-service|core)\/[a-z0-9/-]+\.(?:js|cjs)$/u.test(value.file)
    || !Number.isSafeInteger(value.line) || value.line < 1 || value.line > 1_000_000
    || !Number.isSafeInteger(value.column) || value.column < 1 || value.column > 1_000_000
    || !fs.existsSync(path.join(APP_ROOT, value.file))) return null;
  return { file: value.file, line: value.line, column: value.column };
}
function errorRecord(error) {
  let stack = data(error, "stack");
  // V8 can expose Error.stack through its native accessor. Never invoke an
  // arbitrary getter supplied by an error or serialize arbitrary properties.
  const getter = error && Object.getOwnPropertyDescriptor(error, "stack")?.get;
  if (typeof stack !== "string" && nativeStackGetter && getter === nativeStackGetter) stack = getter.call(error);
  const frames = typeof stack === "string" ? stack.slice(0, 32 * 1024).split("\n").slice(1, 33).flatMap(line => {
    const start = line.indexOf(`${APP_ROOT}${path.sep}`);
    if (start < 0) return [];
    const match = /^(.+):(\d+):(\d+)\)?$/u.exec(line.slice(start + APP_ROOT.length + 1).trim());
    const frame = match && sourceFrame({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
    return frame ? [frame] : [];
  }).slice(0, 8) : [];
  const name = data(error, "name") ?? data(Object.getPrototypeOf(error || {}), "name");
  return { name: NAMES.has(name) ? name : "Error", code: CODES.has(data(error, "code")) ? data(error, "code") : "UNKNOWN_LOCAL_ERROR", frames };
}
function normalize(value) {
  if (!value || !["chat.send", "chat.secret.prepare"].includes(value.method) || !PHASES.has(value.phase)
    || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || !Array.isArray(value.errors) || value.errors.length === 0) return null;
  const record = { timeMs: value.timeMs, elapsedMs: value.elapsedMs, method: value.method, phase: value.phase,
    errors: value.errors.slice(0, 3).map(error => ({ name: NAMES.has(error?.name) ? error.name : "Error",
      code: CODES.has(error?.code) ? error.code : "UNKNOWN_LOCAL_ERROR",
      frames: Array.isArray(error?.frames) ? error.frames.slice(0, 8).map(sourceFrame).filter(Boolean) : [] })) };
  for (const field of ["operationHash", "sessionHash"]) {
    if (typeof value[field] === "string" && /^[a-f0-9]{64}$/u.test(value[field])) record[field] = value[field];
  }
  if (value.admissionAccepted === false) record.admissionAccepted = false;
  return record;
}

// A local support record, never a public error or retry authorization. Keep
// only closed error codes and source locations; omit messages, function names,
// absolute paths, request text, attachments, credentials and raw identifiers.
function recordChatSendFailure({ paths, method, phase, input, error, startedAt = Date.now(), client = false }) {
  try {
    if (!path.isAbsolute(paths?.runtimeDir || "") || !path.isAbsolute(paths?.trustedRoot || "")) return false;
    const errors = [], seen = new Set();
    for (let current = error; current && !seen.has(current) && errors.length < 3; current = data(current, "cause")) {
      seen.add(current); errors.push(errorRecord(current));
    }
    if (!errors.length) errors.push(errorRecord(null));
    const timeMs = Date.now();
    const record = normalize({ timeMs, elapsedMs: Math.max(0, timeMs - startedAt), method, phase, errors,
      operationHash: hash(input?.operationId), sessionHash: hash(input?.sessionKey),
      admissionAccepted: data(error, "admissionAccepted") });
    if (!record) return false;
    const target = path.join(paths.runtimeDir, client ? "chat-send-client-diagnostics.json" : "chat-send-diagnostics.json");
    let records = [];
    try {
      const previous = JSON.parse(readPrivateFile(target, { maxBytes: MAX_BYTES }).toString("utf8"));
      if (previous?.version !== 1 || !Array.isArray(previous.records)) return false;
      records = previous.records.slice(-(MAX_RECORDS - 1)).map(normalize).filter(Boolean);
    } catch (failure) { if (failure?.code !== "ENOENT") return false; }
    records.push(record);
    let body = `${JSON.stringify({ version: 1, records })}\n`;
    while (Buffer.byteLength(body) > MAX_BYTES && records.length > 1) {
      records.shift(); body = `${JSON.stringify({ version: 1, records })}\n`;
    }
    if (Buffer.byteLength(body) > MAX_BYTES) return false;
    atomicWritePrivateFile(target, body, { trustedRoot: paths.trustedRoot });
    return true;
  } catch { return false; } // Diagnostics cannot affect admission or recovery.
}
function setChatSendDiagnosticPhase(phase) {
  const current = context.getStore();
  if (current && PHASES.has(phase) && current.phase !== phase) {
    finishPhase(current, "success");
    current.phase = phase; current.phaseAt = Date.now(); current.phaseMono = performance.now();
  }
}
function finishPhase(current, outcome) {
  try { current.latency?.record({ stage: current.phase, outcome, operationId: current.input?.operationId,
    sessionKey: current.input?.sessionKey, startedAt: current.phaseAt, finishedAt: Date.now(),
    durationMs: performance.now() - current.phaseMono }); } catch {}
}
function withChatSendDiagnostics({ paths, method, input, latency }, action) {
  if (!["chat.send", "chat.secret.prepare"].includes(method)) return action();
  const current = { paths, method, input, latency, phase: "request_validation", startedAt: Date.now(),
    phaseAt: Date.now(), phaseMono: performance.now() };
  return context.run(current, async () => {
    let outcome = "success";
    try { return await action(); }
    catch (error) { outcome = "error"; recordChatSendFailure({ ...current, error }); throw error; }
    finally { finishPhase(current, outcome); current.latency = null; }
  });
}

module.exports = { recordChatSendFailure, setChatSendDiagnosticPhase, withChatSendDiagnostics };
