"use strict";
const { execFile } = require("node:child_process");

// Hermes retains a durable attempt ledger independently of chat sessions. This
// includes preflight/script failures and supplies a real outcome for every row.
function readHermesCronHistory(filePath, sinceMs = 0) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-readonly", "-batch", "-json", filePath,
      "PRAGMA query_only=ON; SELECT id,job_id,status,claimed_at,started_at,finished_at,error FROM executions;"],
    { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Hermes execution history unavailable"));
      try {
        const records = JSON.parse(stdout || "[]");
        const items = records.map(row => ({ id: row.id, jobId: row.job_id,
          startedAt: Date.parse(row.started_at || row.claimed_at), finishedAt: row.finished_at ? Date.parse(row.finished_at) : null,
          status: row.status === "completed" ? "ok" : row.status === "failed" ? "error" : row.status === "unknown" ? "unknown" : "running",
          error: row.error || undefined }));
        if (items.some(row => typeof row.id !== "string" || typeof row.jobId !== "string"
          || !Number.isFinite(row.startedAt) || (row.finishedAt !== null && !Number.isFinite(row.finishedAt)))) throw new Error();
        const terminal = items.filter(row => row.finishedAt !== null);
        resolve({ items: items.filter(row => (row.finishedAt ?? row.startedAt) >= sinceMs),
          // Upstream keeps only the latest 1000 terminal attempts; if all retained
          // rows are today, older attempts from today may have been pruned.
          truncated: terminal.length >= 1000 && terminal.every(row => row.finishedAt >= sinceMs) });
      } catch { reject(new Error("Hermes execution history invalid")); }
    });
  });
}
module.exports = { readHermesCronHistory };
