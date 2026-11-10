"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");

const MAX_RECORDS = 2048, MAX_BYTES = 1024 * 1024;
const hash = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  ? crypto.createHash("sha256").update(value).digest("hex") : undefined;

// Closed diagnostic projection: never persist prompts, errors, account names,
// paths or raw operation identifiers. Overlapping spans retain their endpoints.
function normalize(input) {
  if (!input || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(input.stage || "")
    || !["success", "error", "unknown"].includes(input.outcome)
    || !Number.isFinite(input.durationMs) || input.durationMs < 0) return null;
  const record = { stage: input.stage, outcome: input.outcome, durationMs: Math.round(input.durationMs) };
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
    if (this.pending.length > MAX_RECORDS) this.pending.shift();
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

if (!isMainThread && workerData?.latencyWriter === true) {
  const { paths, fileName, generation, version } = workerData;
  const file = path.join(paths.runtimeDir, fileName);
  let records = [];
  try {
    const previous = JSON.parse(readPrivateFile(file, { maxBytes: MAX_BYTES }));
    if (previous.version === 1 && Array.isArray(previous.records)) {
      records = previous.records.slice(-MAX_RECORDS).flatMap(row => {
        const clean = normalize(row);
        return clean && /^[a-f0-9-]{36}$/u.test(row.generation || "") ? [{ ...clean, generation: row.generation,
          version: /^[a-zA-Z0-9._-]{1,80}$/u.test(row.version || "") ? row.version : "unknown" }] : [];
      });
    }
  } catch { /* A missing/invalid diagnostic file has no authority. */ }
  parentPort.on("message", input => {
    try {
      records.push(...input.slice(-MAX_RECORDS).map(normalize).filter(Boolean).map(row => ({ ...row, generation, version })));
      records = records.slice(-MAX_RECORDS);
      let body = JSON.stringify({ version: 1, records });
      while (Buffer.byteLength(body) > MAX_BYTES && records.length) { records.shift(); body = JSON.stringify({ version: 1, records }); }
      atomicWritePrivateFile(file, body + "\n", { trustedRoot: paths.trustedRoot });
    } catch { /* Best-effort, without retrying a failed durable user operation. */ }
    parentPort.postMessage({ done: true });
  });
}

module.exports = { SendLatencyDiagnostics, normalize, MAX_RECORDS, MAX_BYTES };
