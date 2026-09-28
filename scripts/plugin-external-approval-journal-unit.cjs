"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { sqliteNativeBinding } = require("../app/agent-service/sqlite-native-binding");
const { ExternalPluginProvenance } = require("../app/agent-service/external-plugin-provenance");
const { ExternalPluginApprovalBroker } = require("../app/agent-service/external-plugin-approval-broker");

const nativeBinding = sqliteNativeBinding();
const sqlite = file => new Database(file, nativeBinding ? { nativeBinding } : undefined);
const primaryReceipts = new Map();
const store = { getCapabilityCall: id => primaryReceipts.get(id) || null };
const identity = toolCallId => ({ backendId: "openclaw", instanceId: "fixture-host",
  agentId: "fixture-agent", sessionId: "fixture-session", runId: "fixture-run", toolCallId });
const token = Buffer.alloc(32, 7).toString("base64url");
const marker = `SECRET_ARGUMENT_${"z".repeat(48)}`;
const outcomes = ["approved", "denied", "expired", "withdrawn"];
const callId = outcome => `journal-${outcome}`;
const requestId = outcome => `request-${outcome}`;

function pathsFor(root) {
  return resolveServicePaths({ stateRoot: path.join(root, "state"),
    userDataRoot: root, profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
}
function begin(provenance, name) {
  provenance.begin({ callId: callId(name), identity: identity(`tool-${name}`),
    bindingId: "fixture-binding", installationId: "fixture-installation",
    componentId: "a".repeat(64), connectionId: "fixture-connection",
    toolIdentity: `plugin:fixture-binding:${"a".repeat(64)}:read:${"b".repeat(64)}`,
    toolName: "read", approvalRequired: true });
}
function journalRows(file) {
  const db = sqlite(file);
  try { return db.prepare(`SELECT call_id, request_id, outcome FROM approval_events
    ORDER BY call_id`).all(); }
  finally { db.close(); }
}

async function writeChild(root) {
  const paths = pathsFor(root);
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  const db = sqlite(provenance.path);
  try {
    for (const outcome of outcomes) begin(provenance, outcome);
    db.exec(`CREATE TRIGGER block_approval BEFORE UPDATE OF approval_outcome
      ON external_plugin_calls BEGIN SELECT RAISE(ABORT, 'temporary write failure'); END;`);
    const broker = new ExternalPluginApprovalBroker();
    for (const outcome of ["approved", "denied"]) {
      const controller = new AbortController();
      const pending = broker.request({ token, identity: identity(`tool-${outcome}`),
        callId: callId(outcome), bindingId: "fixture-binding",
        connectionId: "fixture-connection", connectionAuthRevision: 1,
        packageName: "Fixture", toolName: "read", arguments: { marker },
        signal: controller.signal, assertCurrent: () => {},
        recordDecision: (id, request, decision) =>
          provenance.journalApproval(id, request, decision) });
      const actualRequest = broker.list().items[0].requestId;
      const challenge = broker.prepare({ requestId: actualRequest,
        operationId: `operation-${outcome}`,
        decision: outcome === "approved" ? "once" : "deny" }).challenge;
      broker.commit({ challenge, approved: outcome === "approved" });
      assert.equal((await pending).requestId, actualRequest);
      assert.equal(journalRows(provenance.journalPath).some(row =>
        row.call_id === callId(outcome) && row.request_id === actualRequest
          && row.outcome === outcome), true);
      // Simulate termination between broker delivery and the tool service's
      // subsequent recordApproval call. The broker's journal must suffice.
    }
    for (const outcome of ["expired", "withdrawn"]) {
      provenance.journalApproval(callId(outcome), requestId(outcome), outcome);
      assert.throws(() => provenance.recordApproval(callId(outcome), requestId(outcome), outcome),
        error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    }
    const rows = journalRows(provenance.journalPath);
    assert.equal(rows.length, 4);
    const raw = fs.readFileSync(provenance.journalPath);
    assert.equal(raw.includes(Buffer.from(marker)), false);
    assert.equal(raw.includes(Buffer.from(token)), false);
    assert.equal(fs.statSync(provenance.journalPath).mode & 0o077, 0);
    // No close hooks run: recovery must survive abrupt Service termination.
    process.kill(process.pid, "SIGKILL");
  } finally { db.close(); provenance.close(); }
}

function recoverChild(root) {
  const paths = pathsFor(root);
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  const db = sqlite(provenance.path);
  try {
    const blocked = provenance.list({ limit: 20 }).items;
    for (const outcome of outcomes) {
      const row = blocked.find(item => item.callId === callId(outcome));
      assert.equal(row.status, "pending");
      assert.equal(row.approvalOutcome, null);
    }
    const pendingEvents = new Map(journalRows(provenance.journalPath)
      .map(event => [event.call_id, event]));
    assert.equal(pendingEvents.size, 4);
    db.exec("DROP TRIGGER block_approval");
    provenance.reconcile();
    const restored = provenance.list({ limit: 20 }).items;
    for (const outcome of outcomes) {
      const row = restored.find(item => item.callId === callId(outcome));
      assert.equal(row.approvalRequestId, pendingEvents.get(callId(outcome)).request_id);
      assert.equal(row.approvalOutcome, outcome);
      assert.equal(row.status, "outcome_unknown", "approval alone never proves a remote result");
    }
    assert.equal(journalRows(provenance.journalPath).length, 0);

    // A mismatching decision cannot rewrite an already recovered audit row.
    assert.throws(() => provenance.journalApproval(callId("approved"),
      "different-request", "denied"),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    assert.equal(journalRows(provenance.journalPath).length, 0);

    // At capacity, a new decision is not acknowledged or recorded as approved.
    const limited = new ExternalPluginProvenance({ paths, store, maxJournal: 1 }).open();
    try {
      limited.begin({ callId: "limited-first", identity: identity("limited-first"),
        bindingId: "fixture-binding", installationId: "fixture-installation",
        componentId: "a".repeat(64), connectionId: "fixture-connection",
        toolIdentity: `plugin:fixture-binding:${"a".repeat(64)}:read:${"b".repeat(64)}`,
        toolName: "read", approvalRequired: true });
      limited.begin({ callId: "limited-second", identity: identity("limited-second"),
        bindingId: "fixture-binding", installationId: "fixture-installation",
        componentId: "a".repeat(64), connectionId: "fixture-connection",
        toolIdentity: `plugin:fixture-binding:${"a".repeat(64)}:read:${"b".repeat(64)}`,
        toolName: "read", approvalRequired: true });
      limited.journalApproval("limited-first", "limited-request-first", "approved");
      assert.throws(() => limited.journalApproval("limited-first",
        "conflicting-request", "denied"),
      error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
      assert.deepEqual(journalRows(limited.journalPath).map(row => row.request_id),
        ["limited-request-first"]);
      assert.throws(() => limited.journalApproval("limited-second",
        "limited-request-second", "approved"),
      error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
      const second = limited.list({ limit: 20 }).items.find(row => row.callId === "limited-second");
      assert.equal(second.approvalOutcome, null);
    } finally { limited.close(); }
  } finally { db.close(); provenance.close(); }
}

function mismatchChild(root) {
  const paths = pathsFor(root);
  const db = sqlite(path.join(paths.pluginsDir, "external-provenance.sqlite"));
  const journal = sqlite(path.join(paths.pluginsDir, "external-approval-journal.sqlite"));
  try {
    // Simulate divergent disk state: recovery must surface an error rather
    // than present one database's decision as a verified joint record.
    db.prepare(`UPDATE external_plugin_calls SET approval_request_id = ?,
      approval_outcome = ? WHERE call_id = ?`).run("main-request", "denied", "limited-second");
    journal.prepare(`INSERT INTO approval_events
      (call_id, request_id, outcome, updated_at) VALUES (?, ?, ?, ?)`)
      .run("limited-second", "journal-request", "approved", Date.now());
  } finally { journal.close(); db.close(); }
  assert.throws(() => new ExternalPluginProvenance({ paths, store }).open(),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
}

function pressureWriteChild(root) {
  const paths = pathsFor(root);
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  const journal = sqlite(provenance.journalPath);
  journal.exec(`CREATE TRIGGER block_journal BEFORE INSERT ON approval_events
    BEGIN SELECT RAISE(ABORT, 'journal disk failure'); END;`);
  for (let index = 0; index < 256; index += 1) {
    const name = `pressure-${index}`;
    begin(provenance, name);
    assert.throws(() => provenance.journalApproval(callId(name), requestId(name), "approved"),
      error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    // Terminate before ToolService's catch can settle the failed request.
  }
  assert.throws(() => begin(provenance, "pressure-overflow"),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
  process.kill(process.pid, "SIGKILL");
}

function pressureRecoverChild(root) {
  const paths = pathsFor(root);
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  const db = sqlite(provenance.path);
  const journal = sqlite(provenance.journalPath);
  try {
    const recovered = db.prepare(`SELECT status, approval_request_id, approval_outcome,
      approval_journal_gate FROM external_plugin_calls
      WHERE call_id LIKE 'journal-pressure-%'`).all();
    assert.equal(recovered.length, 256);
    assert(recovered.every(row => row.status === "outcome_unknown"
      && row.approval_request_id === null && row.approval_outcome === null
      && row.approval_journal_gate === 1));
    begin(provenance, "pressure-after-restart");
    assert.throws(() => provenance.journalApproval(callId("pressure-after-restart"),
      requestId("pressure-after-restart"), "approved"),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    journal.exec("DROP TRIGGER block_journal");
    provenance.journalApproval(callId("pressure-after-restart"),
      requestId("pressure-after-restart"), "approved");
    provenance.recordApproval(callId("pressure-after-restart"),
      requestId("pressure-after-restart"), "approved");
    assert.equal(provenance.list().items.find(row =>
      row.callId === callId("pressure-after-restart")).approvalOutcome, "approved");
    begin(provenance, "impossible-live-receipt");
    primaryReceipts.set(callId("impossible-live-receipt"), { phase: "result_confirmed" });
    provenance.settle(callId("impossible-live-receipt"), {
      error: Object.assign(new Error("audit unavailable"),
        { code: "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE", approvalJournalUnavailable: true }) });
    const impossible = provenance.list({ limit: 20 }).items.find(row =>
      row.callId === callId("impossible-live-receipt"));
    assert.equal(impossible.status, "outcome_unknown");
    assert.equal(impossible.approvalOutcome, null);
  } finally { journal.close(); db.close(); provenance.close(); }
}

function lossWriteChild(root) {
  const paths = pathsFor(root);
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  begin(provenance, "lost-journal");
  provenance.journalApproval(callId("lost-journal"), requestId("lost-journal"), "approved");
  begin(provenance, "lost-journal-send-started");
  begin(provenance, "lost-journal-confirmed");
  assert.equal(journalRows(provenance.journalPath).length, 1);
  process.kill(process.pid, "SIGKILL");
}

function lossRecoverChild(root) {
  const paths = pathsFor(root);
  primaryReceipts.set(callId("lost-journal-send-started"), { phase: "send_started" });
  primaryReceipts.set(callId("lost-journal-confirmed"), { phase: "result_confirmed" });
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  try {
    const rows = provenance.list().items;
    for (const name of ["lost-journal", "lost-journal-send-started",
      "lost-journal-confirmed"]) {
      const row = rows.find(item => item.callId === callId(name));
      assert.equal(row.status, "outcome_unknown");
      assert.equal(row.approvalRequestId, null);
      assert.equal(row.approvalOutcome, null);
    }
    assert.equal(journalRows(provenance.journalPath).length, 0);
    begin(provenance, "after-lost-journal");
  } finally { provenance.close(); }
}

async function main() {
  const phase = process.argv[2];
  if (phase === "write") return writeChild(process.argv[3]);
  if (phase === "recover") return recoverChild(process.argv[3]);
  if (phase === "mismatch") return mismatchChild(process.argv[3]);
  if (phase === "pressure-write") return pressureWriteChild(process.argv[3]);
  if (phase === "pressure-recover") return pressureRecoverChild(process.argv[3]);
  if (phase === "loss-write") return lossWriteChild(process.argv[3]);
  if (phase === "loss-recover") return lossRecoverChild(process.argv[3]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-approval-journal-"));
  try {
    for (const [childPhase, stateRoot] of [
      ["write", root], ["recover", root], ["mismatch", root],
      ["pressure-write", path.join(root, "pressure")],
      ["pressure-recover", path.join(root, "pressure")],
      ["loss-write", path.join(root, "loss")],
      ["loss-recover", path.join(root, "loss")],
    ]) {
      if (childPhase === "loss-recover") {
        fs.unlinkSync(path.join(pathsFor(stateRoot).pluginsDir, "external-approval-journal.sqlite"));
      }
      if (childPhase === "pressure-write" || childPhase === "loss-write") {
        fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      }
      const child = spawnSync(process.execPath, [__filename, childPhase, stateRoot],
        { encoding: "utf8", timeout: 15_000 });
      if (["write", "pressure-write", "loss-write"].includes(childPhase)) {
        assert.equal(child.signal, "SIGKILL",
          `${childPhase}: ${child.stderr || child.error || "failed"}`);
      } else {
        assert.equal(child.status, 0, `${childPhase}: ${child.stderr || child.error || "failed"}`);
      }
    }
    console.log("plugin-external-approval-journal-unit: durable decisions, bounded recovery and divergence fail closed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
