#!/usr/bin/env node
"use strict";
// Real Service rollback drill. Disable only the controlled catalog entry, revoke
// its actual Run lease, confirm its concrete process stops, and retain history.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createFixture, sourceFingerprint, hash, until } = require("./fixtures/generic-acp-service-fixture.cjs");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
const { legacyAcpReader, openLegacyAcpReader } = require("./fixtures/runtime-prepared-legacy-acp-reader.cjs");
const active = run => ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status);
const bindingFor = profile => ({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId });
const ledgerFor = (fixture, profile, workspace) => path.join(fixture.paths.stateDir, "runtime-acp-ledgers", hash(JSON.stringify([bindingFor(profile), workspace])) + ".json");
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
const readHistory = (fixture, index) => fixture.rpc("chat.history", { sessionKey: fixture.chats[index].sessionKey, cursor: null, limit: 100 });
function historyText(value) { return JSON.stringify(value); }

test("real Generic ACP rollback disables admission, revokes Run authority, confirms stop and preserves read-only unknown history", { timeout: 55000 }, async t => {
  const before = sourceFingerprint(), oldReader = legacyAcpReader();
  let f = await createFixture({ agents: 2 }), reopened, closed = false;
  const receipt = { version: 1, contract: "Generic ACP actual Service rollback; controlled signed process; no Provider or installed App", root: f.root,
    sourceBefore: before.digest, oldReader: { sourceCommit: oldReader.sourceCommit, sha256: oldReader.sha256 }, steps: [], passed: false };
  const output = path.join(f.root, "rollback-operation-receipt.json");
  const step = (operation, evidence) => receipt.steps.push({ operation, ...evidence });
  t.after(async () => { try { if (reopened) receipt.finalResources = await reopened.closeAndObserve(); else if (!closed) receipt.finalResources = await f.closeAndObserve(); }
    catch (error) { receipt.cleanupError = { code: error.code || null, message: error.message }; throw error; }
    finally { receipt.sourceAfter = sourceFingerprint().digest; fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); console.log(`Rollback evidence: ${output}`); } });
  const historical = await f.send(0, "rollback-history"); assert.equal(historical.run.status, "completed");
  const unknown = await f.send(1, "rollback-unknown", "[ACP_EXIT]");
  assert.equal(unknown.run.status, "interrupted"); assert.equal(unknown.run.errorCode, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
  assert.equal(unknown.run.runtimeAttemptRef.dispatchState, "write_attempted"); assert.equal(unknown.run.runtimeTurnRef, null);
  step("record-before-withdrawal", { historyRunId: historical.run.id, unknownRunId: unknown.run.id,
    unknownAttempt: unknown.run.runtimeAttemptRef, promptCount: f.auditRows().filter(row => row.kind === "prompt").length });

  const ack = await f.rpc("chat.send", { sessionKey: f.chats[0].sessionKey, operationId: "rollback-active-wait", createdAt: Date.now(), prompt: "[ACP_PROBE:rollback-active] [ACP_APPROVAL] controlled rollback wait" });
  const waiting = await until(() => { const run = f.service.productStore.getWorkRun(ack.run.id); return run?.status === "waiting_approval" && run; }, "active rollback approval");
  const coordinator = f.service.workRunCoordinator, lease = coordinator.runCapabilityLeases.get(waiting.id), assignment = coordinator.runHostAssignments.get(waiting.id);
  assert(lease); assert(assignment); const host = assignment.host, pid = host.host.child.pid;
  coordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp", sessionId: waiting.runtimeAttemptRef.sessionId, turnId: waiting.runtimeAttemptRef.turnId });
  assert.equal(alive(pid), true);
  const catalog = new RuntimeExtensionCatalog(f.paths); catalog.setEnabled(f.runtime, false);
  assert.equal(catalog.read({ verifyEnabled: false }).find(entry => entry.envelope.manifest.runtime === f.runtime).enabled, false);
  const startsBefore = f.auditRows().filter(row => row.kind === "started").length;
  await assert.rejects(f.service.runtimeManager.acquire(bindingFor(f.profiles[0]), { workspace: f.metadata.workspaces[0], permissionPolicy: f.profiles[0].permissionPolicy }),
    { code: "RUNTIME_EXTENSION_UNTRUSTED" });
  assert.equal(f.auditRows().filter(row => row.kind === "started").length, startsBefore, "Catalog withdrawal must reject before spawning a new process");
  step("catalog.setEnabled(false)", { runtime: f.runtime, rejectedNewAdmission: "RUNTIME_EXTENSION_UNTRUSTED", newProcessCount: 0 });

  assert.equal(coordinator.hostCapabilityIssuer.revoke(lease), true);
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => coordinator.hostCapabilityIssuer.assert(lease, { kind: "mcp" }), { code: "HOST_CAPABILITY_REVOKED" });
  await host.stop(); await host.terminated; await until(() => !alive(pid), "withdrawn Generic process physically exits", 6000);
  const terminal = await until(() => { const run = f.service.productStore.getWorkRun(waiting.id); return !active(run) && run; }, "withdrawn active execution terminal");
  assert.notEqual(terminal.status, "completed");
  await assert.rejects(coordinator.respondApproval({ operationId: "rollback-late-approval", runId: waiting.id, requestId: waiting.waitingRequestId, choice: "once" }));
  assert.equal(f.auditRows().some(row => row.kind === "permission-response" && row.token === "rollback-active" && row.optionId === "controlled-allow-once"), false);
  step("revoke-lease-and-confirm-stop", { runId: waiting.id, pid, leaseRevoked: true, lateApprovalRejected: true, processAlive: alive(pid), terminalStatus: terminal.status, errorCode: terminal.errorCode });

  const firstHistory = await readHistory(f, 0), unknownHistory = await readHistory(f, 1);
  assert(historyText(firstHistory).includes("ACP answer rollback-history")); assert(historyText(unknownHistory).includes("rollback-unknown"));
  const ledgers = f.profiles.map((profile, index) => ({ profile, workspace: f.metadata.workspaces[index], file: ledgerFor(f, profile, f.metadata.workspaces[index]) }));
  const baseline = ledgers.map(value => ({ ...value, bytes: fs.readFileSync(value.file) }));
  for (const value of baseline) {
    assert.equal(JSON.parse(value.bytes).version, 2);
    await assert.rejects(openLegacyAcpReader({ binding: bindingFor(value.profile), workspace: value.workspace, stateDir: f.paths.stateDir, trustedRoot: f.paths.trustedRoot }), { code: "RUNTIME_LEDGER_INVALID" });
    assert.deepEqual(fs.readFileSync(value.file), value.bytes, "Old binary refusal may not restore or rewrite the V2 facts");
  }
  const uncertain = JSON.parse(baseline[1].bytes).sessions.flatMap(session => session.turns).find(turn => turn.operationId === unknown.input.operationId);
  assert(uncertain); assert.equal(uncertain.facts.unknown, true); assert.equal(uncertain.facts.remoteAccepted, false); assert.equal(uncertain.facts.terminal, false);
  const originalUnknownPrompts = f.auditRows().filter(row => row.kind === "prompt" && row.token === "rollback-unknown").length;
  assert.equal(originalUnknownPrompts, 1);
  const duplicate = await f.rpc("chat.send", unknown.input); assert.equal(duplicate.run.id, unknown.run.id);
  assert.equal(duplicate.run.status, "interrupted");
  assert.equal(f.auditRows().filter(row => row.kind === "prompt" && row.token === "rollback-unknown").length, 1);
  step("read-only-history-and-old-reader-refusal", { historicalVisible: true, unknownVisible: true, unknownNotReplayed: true,
    rejectedReaderCode: "RUNTIME_LEDGER_INVALID", ledgers: baseline.map(value => ({ sha256: hash(value.bytes), version: 2, rawUnchanged: true })) });

  receipt.resourcesBeforeRestart = await f.closeAndObserve(); closed = true;
  reopened = await createFixture({ root: f.root, agents: 2 });
  const afterHistory = await readHistory(reopened, 0), afterUnknown = await readHistory(reopened, 1);
  assert(historyText(afterHistory).includes("ACP answer rollback-history")); assert(historyText(afterUnknown).includes("rollback-unknown"));
  assert.equal(reopened.service.productStore.getWorkRun(unknown.run.id).status, "interrupted");
  const duplicateAfterRestart = await reopened.rpc("chat.send", unknown.input); assert.equal(duplicateAfterRestart.run.id, unknown.run.id);
  assert.equal(reopened.auditRows().filter(row => row.kind === "prompt" && row.token === "rollback-unknown").length, 1);
  assert.equal(reopened.auditRows().filter(row => row.kind === "started").length, startsBefore);
  for (const value of baseline) assert.deepEqual(fs.readFileSync(value.file), value.bytes);
  assert.equal(fs.existsSync(path.join(f.root, "home")), true);
  assert.equal(reopened.service.runtimeManager.statistics().hosts, 0);
  step("restart-with-withdrawn-catalog", { historicalVisible: true, unknownRetained: true, unknownPromptCount: 1,
    noNewProcess: true, homePreserved: true, ledgerRawUnchanged: true, registryHosts: 0 });
  assert.equal(sourceFingerprint().digest, before.digest, "Production source changed during rollback proof");
  receipt.passed = true;
});
