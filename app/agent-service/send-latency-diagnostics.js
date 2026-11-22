"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_RECORDS = 2048, MAX_BYTES = 1024 * 1024;
// High-frequency spans (per crypto call, tool call or history read) keep their
// own ring, so a long tool loop cannot evict the send-path spans of earlier turns.
const ACTIVITY_STAGE = /^(?:crypto_.+|tool_execution|session_read)$/u;
const ACTIVITY_MAX_RECORDS = 1024, ACTIVITY_MAX_BYTES = 512 * 1024;
// One compact row per send, folded from its spans, for multi-day comparisons.
const TURN_MAX = 4000, TURN_MAX_BYTES = 2 * 1024 * 1024, TURN_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const TURN_MAX_STAGES = 64, TURN_MAX_CODES = 8;
const QUEUE_REASONS = Object.freeze(["SERVICE_QUIESCED", "CHAT_SESSION_BUSY", "CONTEXT_PREPARING", "CONTEXT_COMPACTING",
  "RUNTIME_HOST_CAPACITY", "WORKSPACE_WRITE_BUSY", "GLOBAL_CAPACITY", "PROFILE_ACTIVE_LIMIT", "PROFILE_WORKSPACE_WRITE_LIMIT",
  "BACKEND_ACTIVE_LIMIT", "BACKEND_BACKGROUND_ACTIVE_LIMIT", "STARTUP_BACKPRESSURE", "RUNTIME_ACCOUNT_ACTIVE_LIMIT",
  "RUNTIME_ACCOUNT_BACKOFF", "RUNTIME_ACCOUNT_MUTATION_BUSY", "OTHER"]);
// Only these closed codes are persisted, never a free-form error code.
const STAGE_CODES = new Map([
  ["borrowed_output_scan_failed", ["MEMORY_SCAN_BUSY", "MEMORY_SCAN_UNAVAILABLE", "MEMORY_SCAN_TOO_LARGE", "MEMORY_REVISION_CONFLICT", "MEMORY_READ_VIEW_STALE"]],
  ["admission_queued", QUEUE_REASONS],
  ["memory_recall_cache", ["HIT", "MISS"]],
]);
const hash = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
const companionFile = (fileName, suffix) => fileName.replace(/(?:\.json)?$/u, `-${suffix}.json`);

// Closed diagnostic projection: never persist prompts, errors, account names,
// paths or raw operation identifiers. Overlapping spans retain their endpoints.
function normalize(input) {
  if (!input || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(input.stage || "")
    || !["success", "error", "unknown"].includes(input.outcome)
    || !Number.isFinite(input.durationMs) || input.durationMs < 0) return null;
  const record = { stage: input.stage, outcome: input.outcome, durationMs: Math.round(input.durationMs) };
  const codes = STAGE_CODES.get(input.stage);
  if (codes?.includes(input.code)) record.code = input.code;
  else if (input.stage === "admission_queued" && input.code !== undefined) record.code = "OTHER";
  if (Number.isSafeInteger(input.bytes) && input.bytes >= 0) record.bytes = input.bytes;
  for (const key of ["at", "startedAt", "finishedAt", "attempt"]) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0) record[key] = input[key];
  }
  for (const key of ["runId", "operationId", "sessionKey", "bindingId"]) {
    const value = hash(input[key]);
    if (value) record[`${key}Hash`] = value;
    else if (/^[a-f0-9]{64}$/u.test(input[`${key}Hash`] || "")) record[`${key}Hash`] = input[`${key}Hash`];
  }
  for (const key of ["source", "hostState"]) {
    if (/^[a-zA-Z0-9_.-]{1,40}$/u.test(input[key] || "")) record[key] = input[key];
  }
  return record;
}

// Atomic, private-file persistence runs outside the shared Service event loop.
// Diagnostics are lossy and bounded; they never hold up admission or recovery.
class SendLatencyDiagnostics {
  constructor({ paths, fileName = "send-latency.json", flushMs = 1000, version = "unknown" } = {}) {
    this.paths = paths; this.fileName = fileName; this.flushMs = flushMs;
    this.pending = []; this.worker = null; this.flight = null; this.timer = null;
    this.generation = crypto.randomUUID(); this.closed = false;
    this.version = /^[a-zA-Z0-9._-]{1,80}$/u.test(version) ? version : "unknown";
  }
  record(input) {
    if (this.closed || !path.isAbsolute(this.paths?.runtimeDir || "")) return;
    const record = normalize(input);
    if (!record) return;
    this.pending.push(record);
    if (this.pending.length > MAX_RECORDS) {
      const busy = this.pending.findIndex(row => ACTIVITY_STAGE.test(row.stage));
      this.pending.splice(busy >= 0 ? busy : 0, 1);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
  }
  open() { this.closed = false; this.generation = crypto.randomUUID(); }
  async flush() {
    if (this.flight) { await this.flight; if (this.pending.length) return this.flush(); return; }
    if (!this.pending.length) return;
    const records = this.pending.splice(0);
    try {
      if (!this.worker) {
        this.worker = new Worker(__filename, { workerData: { latencyWriter: true, paths: {
          runtimeDir: this.paths.runtimeDir, trustedRoot: this.paths.trustedRoot,
        }, fileName: this.fileName, generation: this.generation, version: this.version } });
        this.worker.on("error", () => {});
        this.worker.unref();
      }
      const worker = this.worker;
      this.flight = new Promise(resolve => {
        let timer;
        const finish = () => {
          clearTimeout(timer); worker.off("message", finish); worker.off("error", failed); worker.off("exit", failed);
          resolve();
        };
        const failed = () => { if (this.worker === worker) this.worker = null; void worker.terminate(); finish(); };
        worker.once("message", finish); worker.once("error", failed); worker.once("exit", failed);
        timer = setTimeout(failed, 5000);
        worker.postMessage(records);
      });
      await this.flight;
    } catch { /* A support record is never execution authority. */ }
    finally { this.flight = null; }
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    await this.flush();
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}

const validVersion = value => /^[a-zA-Z0-9._-]{1,80}$/u.test(value || "") ? value : "unknown";
const validGeneration = value => /^[a-f0-9-]{36}$/u.test(value || "");
const nonNegative = value => Number.isSafeInteger(value) && value >= 0;

// Oldest rows go first until the serialized file fits its byte budget.
function boundedBody(key, rows, maxBytes) {
  let body = JSON.stringify({ version: 1, [key]: rows });
  while (Buffer.byteLength(body) > maxBytes && rows.length) {
    rows.splice(0, Math.max(1, Math.ceil(rows.length / 16)));
    body = JSON.stringify({ version: 1, [key]: rows });
  }
  return body;
}

// A turn row is { operationIdHash, runIdHash?, startedAt, updatedAt, source?,
// hostState?, generation, version, stages: { [stage]: [offsetMs, durationMs,
// count, endMs, outcome?, codes?] } }. Offsets are relative to the earliest
// span of the send; a repeated stage keeps its first offset, total duration,
// count and last end, so queue retries stay visible without being re-added.
function sanitizeTurn(row) {
  if (!row || !/^[a-f0-9]{64}$/u.test(row.operationIdHash || "") || !nonNegative(row.startedAt)
    || !nonNegative(row.updatedAt) || !validGeneration(row.generation) || !row.stages || typeof row.stages !== "object") return null;
  const stages = {};
  for (const [stage, value] of Object.entries(row.stages).slice(0, TURN_MAX_STAGES)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/u.test(stage) || !Array.isArray(value) || !value.slice(0, 4).every(nonNegative)) continue;
    const entry = value.slice(0, 4);
    const outcome = ["error", "unknown"].includes(value[4]) ? value[4] : null;
    const codes = Array.isArray(value[5]) ? value[5].filter(code => STAGE_CODES.get(stage)?.includes(code)).slice(0, TURN_MAX_CODES) : [];
    if (outcome || codes.length) entry.push(outcome);
    if (codes.length) entry.push(codes);
    stages[stage] = entry;
  }
  const turn = { operationIdHash: row.operationIdHash, startedAt: row.startedAt, updatedAt: row.updatedAt,
    generation: row.generation, version: validVersion(row.version), stages };
  if (/^[a-f0-9]{64}$/u.test(row.runIdHash || "")) turn.runIdHash = row.runIdHash;
  for (const key of ["source", "hostState"]) if (/^[a-zA-Z0-9_.-]{1,40}$/u.test(row[key] || "")) turn[key] = row[key];
  return turn;
}

function foldTurns(turns, rows, now) {
  const byOperation = new Map(turns.map(turn => [turn.operationIdHash, turn]));
  const operationByRun = new Map(turns.filter(turn => turn.runIdHash).map(turn => [turn.runIdHash, turn.operationIdHash]));
  for (const row of rows) {
    const operation = row.operationIdHash ?? operationByRun.get(row.runIdHash);
    const start = row.startedAt ?? row.at ?? row.finishedAt;
    if (!operation || !nonNegative(start)) continue;
    const end = Math.max(start, row.finishedAt ?? start + row.durationMs);
    let turn = byOperation.get(operation);
    if (!turn) {
      turn = { operationIdHash: operation, startedAt: start, updatedAt: end, stages: {} };
      byOperation.set(operation, turn); turns.push(turn);
    }
    if (row.runIdHash && !turn.runIdHash) { turn.runIdHash = row.runIdHash; operationByRun.set(row.runIdHash, operation); }
    if (start < turn.startedAt) {
      const shift = turn.startedAt - start;
      for (const entry of Object.values(turn.stages)) { entry[0] += shift; entry[3] += shift; }
      turn.startedAt = start;
    }
    turn.updatedAt = Math.max(turn.updatedAt, end);
    turn.generation = row.generation; turn.version = row.version;
    if (row.source) turn.source = row.source;
    if (row.hostState) turn.hostState = row.hostState;
    let entry = turn.stages[row.stage];
    if (!entry) {
      if (Object.keys(turn.stages).length >= TURN_MAX_STAGES) continue;
      entry = turn.stages[row.stage] = [start - turn.startedAt, 0, 0, end - turn.startedAt];
    }
    entry[0] = Math.min(entry[0], start - turn.startedAt);
    entry[1] += row.durationMs; entry[2] += 1; entry[3] = Math.max(entry[3], end - turn.startedAt);
    const outcome = row.outcome === "success" ? entry[4] ?? null : row.outcome;
    const codes = entry[5] ?? [];
    if (row.code && !codes.includes(row.code) && codes.length < TURN_MAX_CODES) codes.push(row.code);
    entry.length = 4;
    if (outcome || codes.length) entry.push(outcome);
    if (codes.length) entry.push(codes);
  }
  return turns.filter(turn => turn.updatedAt >= now - TURN_MAX_AGE_MS).slice(-TURN_MAX);
}

if (!isMainThread && workerData?.latencyWriter === true) {
  const { paths, fileName, generation, version } = workerData;
  const files = { records: fileName, activity: companionFile(fileName, "activity"), turns: companionFile(fileName, "turns") };
  const target = name => path.join(paths.runtimeDir, name);
  const load = (name, key, maxBytes) => {
    try {
      const previous = JSON.parse(readPrivateFile(target(name), { maxBytes }));
      return previous.version === 1 && Array.isArray(previous[key]) ? previous[key] : [];
    } catch { return []; /* A missing/invalid diagnostic file has no authority. */ }
  };
  const loadRecords = (name, max, maxBytes) => load(name, "records", maxBytes).slice(-max).flatMap(row => {
    const clean = normalize(row);
    return clean && validGeneration(row.generation) ? [{ ...clean, generation: row.generation, version: validVersion(row.version) }] : [];
  });
  // Files written before the split keep their records in the send-path ring.
  let records = loadRecords(files.records, MAX_RECORDS, MAX_BYTES);
  let activity = loadRecords(files.activity, ACTIVITY_MAX_RECORDS, ACTIVITY_MAX_BYTES);
  let turns = load(files.turns, "turns", TURN_MAX_BYTES).slice(-TURN_MAX).map(sanitizeTurn).filter(Boolean);
  const write = (name, body) => atomicWritePrivateFile(target(name), body + "\n", { trustedRoot: paths.trustedRoot });
  parentPort.on("message", input => {
    const rows = input.slice(-MAX_RECORDS).map(normalize).filter(Boolean).map(row => ({ ...row, generation, version }));
    const sendPath = rows.filter(row => !ACTIVITY_STAGE.test(row.stage));
    const busy = rows.filter(row => ACTIVITY_STAGE.test(row.stage));
    // Each file is independent best effort, without retrying a failed durable user operation.
    if (sendPath.length) {
      try { records = records.concat(sendPath).slice(-MAX_RECORDS); write(files.records, boundedBody("records", records, MAX_BYTES)); } catch {}
      try { turns = foldTurns(turns, sendPath, Date.now()); write(files.turns, boundedBody("turns", turns, TURN_MAX_BYTES)); } catch {}
    }
    if (busy.length) {
      try {
        activity = activity.concat(busy).slice(-ACTIVITY_MAX_RECORDS);
        write(files.activity, boundedBody("records", activity, ACTIVITY_MAX_BYTES));
      } catch {}
    }
    parentPort.postMessage({ done: true });
  });
}

module.exports = { SendLatencyDiagnostics, normalize, foldTurns, sanitizeTurn, companionFile, QUEUE_REASONS,
  MAX_RECORDS, MAX_BYTES, TURN_MAX, TURN_MAX_AGE_MS };
