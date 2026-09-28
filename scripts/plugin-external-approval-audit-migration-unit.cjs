"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { sqliteNativeBinding } = require("../app/agent-service/sqlite-native-binding");
const { ExternalPluginProvenance } = require("../app/agent-service/external-plugin-provenance");
const { validateExternalPluginAuditPage } = require("../app/core/plugin-external-audit-dto");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-approval-audit-"));
try {
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
    userDataRoot: temp, profileRoot: path.join(temp, "profile"),
    cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  const file = path.join(paths.pluginsDir, "external-provenance.sqlite");
  const nativeBinding = sqliteNativeBinding();
  const db = new Database(file, nativeBinding ? { nativeBinding } : undefined);
  const now = Date.now();
  try {
    db.exec(`CREATE TABLE external_plugin_calls (
      call_id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT,
      task_id TEXT, turn_id TEXT, tool_call_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, installation_id TEXT NOT NULL,
      component_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      tool_identity TEXT NOT NULL, tool_name TEXT NOT NULL,
      status TEXT NOT NULL, cancel_requested INTEGER NOT NULL,
      result_digest TEXT, result_bytes INTEGER, error_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX external_plugin_calls_order
        ON external_plugin_calls(created_at DESC, call_id DESC);
      PRAGMA user_version = 1;`);
    db.prepare(`INSERT INTO external_plugin_calls VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("external-legacy", "openclaw", "instance-legacy", "agent-legacy",
        "session-legacy", "run-legacy", null, null, "tool-legacy",
        "binding-legacy", "installation-legacy", "a".repeat(64),
        "connection-legacy", `plugin:binding-legacy:${"a".repeat(64)}:read:${"b".repeat(64)}`,
        "read", "confirmed", 0, "c".repeat(64), 12, null, now - 1_000, now - 900);
  } finally { db.close(); }
  fs.chmodSync(file, 0o600);

  const store = { getCapabilityCall: () => ({ phase: "result_confirmed" }) };
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  try {
    const legacy = provenance.list().items.find(row => row.callId === "external-legacy");
    assert.equal(legacy.status, "confirmed");
    assert.equal(legacy.approvalRequestId, null);
    assert.equal(legacy.approvalOutcome, null);
    assert.equal(legacy.approvalUpdatedAt, null);
    const identity = { backendId: "hermes", instanceId: "instance-new",
      agentId: "agent-new", sessionId: "session-new", taskId: "task-new",
      turnId: "turn-new", toolCallId: "tool-new" };
    provenance.begin({ callId: "external-new", identity, bindingId: "binding-new",
      installationId: "installation-new", componentId: "a".repeat(64),
      connectionId: "connection-new",
      toolIdentity: `plugin:binding-new:${"a".repeat(64)}:read:${"b".repeat(64)}`,
      toolName: "read" });
    provenance.recordApproval("external-new", "request-new", "approved");
    assert.throws(() => provenance.recordApproval("external-new", "request-other", "denied"),
      error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    provenance.settle("external-new", { result: { content: [{ type: "text", text: "ok" }] } });
    const row = provenance.list().items.find(item => item.callId === "external-new");
    assert.equal(row.status, "confirmed");
    assert.equal(row.approvalRequestId, "request-new");
    assert.equal(row.approvalOutcome, "approved");
    assert(row.approvalUpdatedAt >= row.createdAt);
    validateExternalPluginAuditPage({ items: [row, legacy], nextCursor: null });
  } finally { provenance.close(); }
  const reopened = new ExternalPluginProvenance({ paths, store }).open();
  try {
    assert.equal(reopened.list().items.find(row => row.callId === "external-new").approvalOutcome,
      "approved");
  } finally { reopened.close(); }
  const migrated = new Database(file, nativeBinding ? { nativeBinding } : undefined);
  try { assert.equal(migrated.pragma("user_version", { simple: true }), 4); }
  finally { migrated.close(); }
  console.log("plugin-external-approval-audit-migration-unit: legacy audit and exact approval outcome survived restart");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
