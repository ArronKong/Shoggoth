"use strict";
// A private, fixed-root Worker owns full inventory and pinned byte validation.
// The Service keeps only bounded stamps and retirement guards, never 40k stats.
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { serviceError } = require("./security");
const HASH = /^[a-f0-9]{64}$/u;
function createExternalProviderRuntimeAttestor({ stateDir, resourcesRoot, timeoutMs = 30000 }) {
  let worker = null, current = true, sequence = 0, closeResult = null, resolveExit, rejectClose, exitCode = null;
  let workerFault = false, closeRequested = false, unexpectedExit = false;
  const pending = new Map(), codes = new Map();
  const failure = code => serviceError(code, code);
  const invalidate = code => {
    current = false; for (const record of codes.values()) record.current = false;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(failure(code)); } pending.clear();
  };
  function ensureWorker() {
    if (!current) throw failure("EXTERNAL_PROVIDER_RUNTIME_RETIRED");
    if (worker) return;
    worker = new Worker(path.join(__dirname, "external-provider-credential-writer-worker.js"), {
      workerData: { stateDir, resourcesRoot }, execArgv: [],
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    worker.on("message", value => {
      if (value?.type === "invalidate") { const record = codes.get(value.key); if (record) record.current = false; return; }
      const job = value?.type === "result" && pending.get(value.id);
      if (!job) { if (current) invalidate("EXTERNAL_PROVIDER_RUNTIME_RECEIPT_INVALID"); return; }
      pending.delete(value.id); clearTimeout(job.timer);
      if (value.ok !== true || value.key !== job.key || !HASH.test(value.stamp || "")) {
        const record = codes.get(job.key); if (record) record.current = false;
        job.reject(failure(/^EXTERNAL_PROVIDER_[A-Z_]+$/u.test(value.code || "") ? value.code : "EXTERNAL_PROVIDER_RUNTIME_UNVERIFIED"));
      } else if (!current) job.reject(failure("EXTERNAL_PROVIDER_RUNTIME_RETIRED"));
      else {
        let record = codes.get(job.key);
        if (record && (!record.current || record.stamp !== value.stamp)) job.reject(failure("EXTERNAL_PROVIDER_RUNTIME_CHANGED"));
        else {
          if (!record) { record = { current: true, stamp: value.stamp }; codes.set(job.key, record); }
          job.resolve(() => {
            if (!current || !record.current || codes.get(job.key) !== record) throw failure("EXTERNAL_PROVIDER_RUNTIME_RETIRED");
            return true;
          });
        }
      }
      if (pending.size === 0) worker.unref();
    });
    worker.once("error", () => {
      workerFault = true; invalidate("EXTERNAL_PROVIDER_RUNTIME_UNVERIFIED");
      rejectClose?.(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
    });
    worker.once("exit", code => {
      exitCode = code; unexpectedExit = !closeRequested;
      invalidate("EXTERNAL_PROVIDER_RUNTIME_RETIRED"); resolveExit?.(code);
    });
    worker.unref();
  }
  return Object.freeze({
    async verify(writer) {
      ensureWorker();
      if (pending.size >= 16) throw failure("EXTERNAL_PROVIDER_RUNTIME_CAPACITY");
      const id = ++sequence, key = writer.runtimeRoot + "\0" + writer.interpreterPath;
      worker.ref();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { invalidate("EXTERNAL_PROVIDER_RUNTIME_TIMEOUT"); void worker.terminate(); }, timeoutMs);
        pending.set(id, { key, resolve, reject, timer }); worker.postMessage({ type: "attest", id, writer });
      });
    },
    close() {
      if (closeResult) return closeResult;
      invalidate("EXTERNAL_PROVIDER_RUNTIME_RETIRED");
      if (!worker) return closeResult = Promise.resolve();
      if (exitCode !== null) return closeResult = Promise.reject(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
      const captured = worker;
      closeRequested = true; captured.ref();
      closeResult = new Promise((resolve, reject) => {
        let settled = false, terminating = false;
        const finish = error => {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        rejectClose = error => finish(error);
        const timer = setTimeout(() => {
          // This captured Worker has no Host, vault or write authority. A
          // synchronous first inventory can delay its close message; explicitly
          // cancel that read and await its actual exit, never a guessed ACK.
          if (workerFault || unexpectedExit) return finish(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
          terminating = true;
          void captured.terminate().then(code => {
            if (worker !== captured || workerFault || unexpectedExit || exitCode !== code
              || ![0, 1].includes(code)) return finish(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
            finish();
          }, () => finish(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED")));
        }, 5000);
        resolveExit = code => {
          if (worker !== captured || workerFault || unexpectedExit) return finish(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
          if (terminating) return; // The termination promise confirms this exit.
          finish(code === 0 ? null : failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED"));
        };
        try { captured.postMessage({ type: "close" }); }
        catch { finish(failure("EXTERNAL_PROVIDER_RUNTIME_CLOSE_UNVERIFIED")); }
      });
      return closeResult;
    }
  });
}
module.exports = { createExternalProviderRuntimeAttestor };
