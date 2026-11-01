"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { readPrivateFile, statIfExists } = require("./private-file");
const { openDatabase } = require("./inspiration-database");
const { serviceError } = require("./security");
const { validateExternalPluginAuditPage } = require("../core/plugin-external-audit-dto");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const COLUMNS = Object.freeze({ callId: "call_id", backendId: "backend_id", instanceId: "instance_id",
  agentId: "agent_id", sessionId: "session_id", runId: "run_id", taskId: "task_id", turnId: "turn_id",
  toolCallId: "tool_call_id", bindingId: "binding_id", installationId: "installation_id", componentId: "component_id",
  connectionId: "connection_id", toolIdentity: "tool_identity", toolName: "tool_name", status: "status",
  cancelRequested: "cancel_requested", resultDigest: "result_digest", resultBytes: "result_bytes", errorCode: "error_code",
  approvalRequestId: "approval_request_id", approvalOutcome: "approval_outcome", approvalUpdatedAt: "approval_updated_at",
  createdAt: "created_at", updatedAt: "updated_at" });
function fail(code = "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE") { throw serviceError(code, "旧插件历史记录暂不可读；原始数据已保留"); }
function validateQuery(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some(key => !["backendId", "agentId", "sessionId", "toolCallId", "cursor", "limit"].includes(key))) fail("PLUGIN_REQUEST_INVALID");
  const { backendId = null, agentId = null, sessionId = null, toolCallId = null, cursor = null, limit = 10 } = input;
  if (backendId !== null && !["openclaw", "hermes"].includes(backendId)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 20
    || cursor !== null && (!cursor || Object.getPrototypeOf(cursor) !== Object.prototype || Object.keys(cursor).sort().join() !== "callId,createdAt"
      || !ID.test(cursor.callId) || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0)
    || [agentId, sessionId, toolCallId].some(value => value !== null) && (backendId === null
      || ![agentId, sessionId, toolCallId].every(value => typeof value === "string" && OPAQUE.test(value))
      || Buffer.byteLength(agentId) > 128)) fail("PLUGIN_REQUEST_INVALID");
  return { backendId, agentId, sessionId, toolCallId, cursor, limit };
}
function snapshotDatabase(source, scratch, name) {
  if (!statIfExists(fs, source)) return null;
  const evidence = [];
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = source + suffix, before = statIfExists(fs, file);
    if (!before) continue;
    const bytes = readPrivateFile(file, { maxBytes: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(scratch, name + suffix), bytes, { mode: 0o600, flag: "wx" });
    evidence.push({ file, before });
  }
  for (const { file, before } of evidence) {
    const after = fs.lstatSync(file);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) fail();
  }
  return path.join(scratch, name);
}
function readLegacyPluginCalls(paths, input) {
  const query = validateQuery(input), directory = paths.pluginsDir || path.join(paths.stateDir, "plugins");
  if (!statIfExists(fs, path.join(directory, "external-provenance.sqlite"))) return { items: [], nextCursor: null };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-retired-history-")); fs.chmodSync(scratch, 0o700);
  let db, journal;
  try {
    const source = snapshotDatabase(path.join(directory, "external-provenance.sqlite"), scratch, "history.sqlite");
    db = openDatabase(source, { readOnly: true });
    if (![1, 2, 3, 4].includes(db.prepare("PRAGMA user_version").get().user_version)) fail();
    const columns = new Set(db.prepare("PRAGMA table_info(external_plugin_calls)").all().map(row => row.name));
    const projection = Object.values(COLUMNS).map(column => columns.has(column) ? column
      : column.startsWith("approval_") ? `NULL AS ${column}` : fail()).join(", ");
    const rows = db.prepare(`SELECT ${projection} FROM external_plugin_calls
      WHERE (? IS NULL OR backend_id = ?) AND (? IS NULL OR agent_id = ?)
      AND (? IS NULL OR session_id = ?) AND (? IS NULL OR tool_call_id = ?)
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND call_id < ?))
      ORDER BY created_at DESC, call_id DESC LIMIT ?`).all(query.backendId, query.backendId, query.agentId, query.agentId,
      query.sessionId, query.sessionId, query.toolCallId, query.toolCallId, query.cursor?.createdAt ?? null,
      query.cursor?.createdAt ?? null, query.cursor?.createdAt ?? null, query.cursor?.callId ?? null, query.limit + 1);
    const journalPath = snapshotDatabase(path.join(directory, "external-approval-journal.sqlite"), scratch, "approval.sqlite");
    if (journalPath) {
      journal = openDatabase(journalPath, { readOnly: true });
      if (journal.prepare("PRAGMA user_version").get().user_version !== 1) fail();
    }
    const visible = rows.slice(0, query.limit), items = visible.map(row => {
      const result = Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [key, row[column]]));
      result.cancelRequested = row.cancel_requested === 1;
      const event = journal?.prepare("SELECT request_id, outcome, updated_at FROM approval_events WHERE call_id = ?").get(row.call_id);
      if (event) {
        if (result.approvalOutcome !== null && (result.approvalRequestId !== event.request_id || result.approvalOutcome !== event.outcome)) fail();
        result.approvalRequestId = event.request_id; result.approvalOutcome = event.outcome;
        result.approvalUpdatedAt = event.updated_at; result.updatedAt = Math.max(result.updatedAt, event.updated_at);
      }
      // Retirement cannot prove whether a formerly pending call reached its
      // provider. Preserve uncertainty without opening the legacy call ledger.
      if (result.status === "pending") result.status = result.cancelRequested ? "canceled_outcome_unknown" : "outcome_unknown";
      return result;
    });
    const last = visible.at(-1);
    return validateExternalPluginAuditPage({ items, nextCursor: rows.length > query.limit
      ? { createdAt: last.created_at, callId: last.call_id } : null });
  } catch { fail(); }
  finally { try { journal?.close(); } finally { try { db?.close(); } finally { fs.rmSync(scratch, { recursive: true, force: true }); } } }
}
module.exports = { readLegacyPluginCalls };
