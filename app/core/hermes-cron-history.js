"use strict";

// Hermes retains a durable attempt ledger independently of chat sessions. This
// includes preflight/script failures and supplies a real outcome for every row.
async function readHermesCronHistory(filePath, sinceMs = 0, { jobId } = {}) {
  let db;
  let records;
  try {
    // macOS's sqlite3 CLI -readonly fails on a closed WAL database without
    // sidecars. Use the bundled SQLite and keep lock waits short on the App host.
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(filePath, { readOnly: true, timeout: 25 });
    db.exec("PRAGMA query_only=ON;");
    const errorColumn = jobId === undefined ? "error" : "substr(error,1,4096) AS error";
    const columns = `id,job_id,status,claimed_at,started_at,finished_at,${errorColumn}`;
    const query = `SELECT ${columns} FROM executions`;
    const stmt = db.prepare(jobId === undefined ? query : `${query} WHERE job_id=?`);
    records = jobId === undefined ? stmt.all() : stmt.all(jobId);
  } catch {
    throw new Error("Hermes execution history unavailable");
  } finally {
    db?.close();
  }
  const items = records.map(row => ({ id: row.id, jobId: row.job_id,
    startedAt: Date.parse(row.started_at || row.claimed_at), finishedAt: row.finished_at ? Date.parse(row.finished_at) : null,
    status: row.status === "completed" ? "ok" : row.status === "failed" ? "error" : row.status === "unknown" ? "unknown" : "running",
    error: row.error || undefined }));
  if (items.some(row => typeof row.id !== "string" || typeof row.jobId !== "string"
    || !Number.isFinite(row.startedAt) || (row.finishedAt !== null && !Number.isFinite(row.finishedAt)))) {
    throw new Error("Hermes execution history invalid");
  }
  const terminal = items.filter(row => row.finishedAt !== null);
  return { items: items.filter(row => (row.finishedAt ?? row.startedAt) >= sinceMs),
    // Upstream keeps only the latest 1000 terminal attempts; if all retained
    // rows are today, older attempts from today may have been pruned.
    truncated: terminal.length >= 1000 && terminal.every(row => row.finishedAt >= sinceMs) };
}
module.exports = { readHermesCronHistory };
