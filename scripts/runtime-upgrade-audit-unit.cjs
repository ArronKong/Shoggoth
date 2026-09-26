#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { audit, compare } = require("./runtime-upgrade-audit.cjs");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { snapshotChecksum } = require("../app/agent-service/product-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-upgrade-audit-unit-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const product = { schemaVersion: 12, lastSeq: 1, modelProviders: [], runtimeAccounts: [], runtimeAccountTombstones: [],
    agentProfiles: [], workRuns: [{ id: "old-run", profileId: "profile-a", source: "inspiration", idempotencyKey: "inspiration:old-op", status: "completed" }],
    runNotes: [], mcpToolCalls: [] };
  const saveProduct = () => fs.writeFileSync(paths.stateSnapshotPath, JSON.stringify({ ...product, checksum: snapshotChecksum(product) }), { mode: 0o600 });
  saveProduct(); fs.writeFileSync(paths.eventLogPath, "", { mode: 0o600 });
  fs.writeFileSync(path.join(paths.stateDir, "chat-sessions.json"), JSON.stringify({ version: 7, sessions: {}, createOperations: {}, bindingOperations: {}, remoteOperations: {}, cronRuns: {} }), { mode: 0o600 });
  const store = new TranscriptStore({ paths }); store.open(); t.after(() => store.close());
  const append = (id, runId, operationId, occurredAt) => store.appendEvent({ profileId: "profile-a", sessionId: "session-a",
    id, runId, kind: "user", content: { operationId, text: `private fixture ${id}` }, occurredAt });
  append("old-event", "old-run", "old-op", 1);
  const before = audit(paths); before.observedAt = new Date(10).toISOString();
  const logPath = path.join(paths.agentsDir, "profile-a", "transcripts", "session-a", "events.jsonl");
  const manifestPath = path.join(path.dirname(logPath), "manifest.json");
  function grow({ persistRun = true, operationId = `domain-${sha(JSON.stringify(["inspiration", "new-run", "inspiration:new-op"]))}` } = {}) {
    if (persistRun) { product.workRuns.push({ id: "new-run", profileId: "profile-a", source: "inspiration", idempotencyKey: "inspiration:new-op", status: "completed" }); saveProduct(); }
    append("new-event", "new-run", operationId, 20);
  }
  const result = () => { const after = audit(paths, { baseline: before }); return { after, comparison: compare(before, after) }; };
  return { paths, before, grow, result, logPath, manifestPath };
}
test("unchanged audit compares exact without exposing transcript content", t => {
  const f = fixture(t), { after, comparison } = f.result();
  assert.equal(comparison.matches, true); assert.equal(comparison.originalRecordsPreserved, true);
  assert.equal(JSON.stringify(after).includes("private fixture"), false);
});
test("real TranscriptStore append preserves old bytes and attributes tail plus derived manifest", t => {
  const f = fixture(t); f.grow(); const { after, comparison } = f.result();
  assert.equal(comparison.comparable, true); assert.equal(comparison.matches, false);
  assert.equal(comparison.originalRecordsPreserved, true);
  assert.equal(comparison.collections.transcripts.originalPreserved, 2);
  assert.equal(comparison.collections.transcripts.appended.length, 1);
  assert.equal(comparison.collections.transcripts.derivedManifestUpdates.length, 1);
  assert.deepEqual(after.transcriptAppendProofs[0].addedRunIds, ["new-run"]);
  assert.equal(after.transcriptAppendProofs[0].verified, true);
});
test("rewritten historical content cannot be accepted as an append", t => {
  const f = fixture(t); f.grow();
  const lines = fs.readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse);
  lines[0].payload.content.text = "rewritten private content";
  const { checksum, ...body } = lines[0]; lines[0].checksum = sha(stable(body));
  fs.writeFileSync(f.logPath, lines.map(stable).join("\n") + "\n");
  assert.equal(f.result().comparison.originalRecordsPreserved, false);
});
test("tail needs a new persisted Run with matching user operation identity", t => {
  for (const options of [{ persistRun: false }, { operationId: "different-operation" }, { operationId: "new-op" }]) {
    const f = fixture(t); f.grow(options); const { after, comparison } = f.result();
    assert.equal(after.transcriptAppendProofs[0].tailAttributedToNewRuns, false);
    assert.equal(comparison.originalRecordsPreserved, false);
  }
});
test("validly rechecksummed but incorrect derived manifest is a real difference", t => {
  const f = fixture(t); f.grow(); const manifest = JSON.parse(fs.readFileSync(f.manifestPath, "utf8"));
  manifest.eventCount += 1; const { checksum, ...body } = manifest; manifest.checksum = sha(stable(body));
  fs.writeFileSync(f.manifestPath, stable(manifest));
  assert.equal(f.result().comparison.originalRecordsPreserved, false);
});
test("invalid tail checksum cannot preserve the original collection", t => {
  const f = fixture(t); f.grow(); const lines = fs.readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse);
  lines[1].payload.content.text = "tampered tail";
  fs.writeFileSync(f.logPath, lines.map(stable).join("\n") + "\n");
  const { after, comparison } = f.result();
  assert.equal(after.transcriptAppendProofs[0].checksumsValid, false);
  assert.equal(comparison.originalRecordsPreserved, false);
});
test("per-field differences cannot hide behind unchanged aggregate summaries", t => {
  const f = fixture(t); const after = structuredClone(f.before);
  after.inventory["product.workRuns"][0].fields.status = "changed";
  const comparison = compare(f.before, after);
  assert.equal(comparison.matches, false); assert.equal(comparison.originalRecordsPreserved, false);
});
test("writer markers prevent a coherent comparison", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.paths.stateDir, "chat-sessions.writer.lock"), "fixture");
  assert.equal(f.result().comparison.comparable, false);
});
