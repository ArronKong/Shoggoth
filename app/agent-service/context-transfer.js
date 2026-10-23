"use strict";
const crypto = require("node:crypto");

// Receipts live with the source transcript, so a restart never invents an
// accepted target request or loses the source/configuration revision.
function readContextTransfer(store, session, active = false) {
  if (typeof store?.listEvents !== "function") return null;
  const receipt = store.listEvents(session.profileId, session.id).findLast(event => event.kind === "status"
    && event.contextExcluded && event.content?.transcriptType === "context.transfer")?.content.transfer ?? null;
  return receipt && !active && (receipt.state === "preparing"
    || (receipt.state === "ready" && session.revision === receipt.sourceSessionRevision))
    ? { ...receipt, state: "failed", errorCode: "CONTEXT_HANDOFF_INTERRUPTED" } : receipt;
}
function recordContextTransfer(store, session, transfer) {
  store.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `context-transfer-${crypto.randomUUID()}`, kind: "status", contextExcluded: true,
    occurredAt: transfer.updatedAt, content: { transcriptType: "context.transfer", transfer } });
  return transfer;
}
// Private maintenance receipts share Transcript's writer and recovery. They
// never enter model context or the public (strict) transfer DTO.
function maintenanceScope(session, profile) {
  return { nativeSessionId: session.runtimeSessionId ?? session.codexThreadId ?? null,
    bindingId: session.runtimeBindingId, runtime: profile.runtime,
    runtimeAccountId: profile.runtimeAccountId, runtimeProfileId: profile.runtimeProfileId };
}
function sameMaintenanceScope(left, right) {
  return !!left && !!right && ["nativeSessionId", "bindingId", "runtime", "runtimeAccountId", "runtimeProfileId"]
    .every(key => left[key] === right[key]);
}
function validRestorePolicy(policy) {
  return policy?.kind === "working_target" && policy.retainedTokens === require("./conversation-context-budget").RETAINED_TAIL_TOKENS
    && Object.keys(policy).length === 2;
}
function maintenanceRecords(events) {
  const records = new Map();
  for (const event of events) {
    if (!event.contextExcluded || event.kind !== "status" || event.content?.transcriptType !== "context.maintenance") continue;
    const record = event.content.maintenance;
    if (record?.version !== 1 || record.advisory !== true || typeof record.id !== "string"
      || !/^(?:native-compaction-advisory|working-context)-[a-f0-9]{64}$/u.test(record.id)
      || typeof record.waitingRunId !== "string" || !record.waitingRunId.length || record.waitingRunId.length > 256
      || !["native_compaction", "session_renewal"].includes(record.action)
      || (record.action === "native_compaction") !== record.id.startsWith("native-compaction-advisory-")
      || !["planned", "paused", "ready"].includes(record.state)
      || !Object.values(record.scope || {}).every(value => typeof value === "string" && value.length > 0)
      || Object.keys(record.scope || {}).sort().join(",") !== "bindingId,nativeSessionId,runtime,runtimeAccountId,runtimeProfileId"
      || !Number.isSafeInteger(record.sourceSessionRevision) || record.sourceSessionRevision < 1
      || !Number.isSafeInteger(record.baseline?.usedTokens) || record.baseline.usedTokens < 0
      || !Number.isSafeInteger(record.baseline?.throughSeq) || record.baseline.throughSeq < 0
      || (record.restorePolicy !== undefined && !validRestorePolicy(record.restorePolicy))
      || (record.state === "ready" && (record.action !== "session_renewal" || !validRestorePolicy(record.restorePolicy)
        || typeof record.snapshotId !== "string" || !record.snapshotId.length))) {
      throw Object.assign(new Error("Context maintenance receipt is invalid"), { code: "CONTEXT_MAINTENANCE_INVALID" });
    }
    const previous = records.get(record.id);
    if (previous && ["action", "waitingRunId", "scope", "sourceSessionRevision", "baseline"]
      .some(key => JSON.stringify(previous[key]) !== JSON.stringify(record[key]))) {
      throw Object.assign(new Error("Context maintenance identity changed"), { code: "CONTEXT_MAINTENANCE_INVALID" });
    }
    records.set(record.id, { ...record, seq: event.seq, occurredAt: event.occurredAt });
  }
  return records;
}
function recordMaintenance(store, session, record) {
  const { seq: _seq, occurredAt: _time, ...saved } = record;
  store.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `context-maintenance-${saved.id}-${saved.state}`, kind: "status", contextExcluded: true,
    content: { transcriptType: "context.maintenance", maintenance: saved } });
  return saved;
}
function workingRestorePolicy(store, session, profile) {
  if (!session || session.runtimeSessionId || !session.retiredRuntimeSessions?.length) return null;
  const events = store.listEvents(session.profileId, session.id);
  const transfer = readContextTransfer(store, session);
  const source = session.retiredRuntimeSessions.at(-1);
  const record = [...maintenanceRecords(events).values()].findLast(item => item.action === "session_renewal"
    && item.state === "ready" && item.scope.nativeSessionId === source.runtimeSessionId
    && item.scope.bindingId === session.runtimeBindingId && item.sourceSessionRevision < session.revision
    && item.scope.runtime === source.runtime && item.scope.runtimeAccountId === source.runtimeAccountId
    && sameMaintenanceScope(item.scope, maintenanceScope({ ...session, runtimeSessionId: source.runtimeSessionId }, profile))
    && item.snapshotId === transfer?.snapshotId && item.sourceSessionRevision === transfer?.sourceSessionRevision);
  return record?.restorePolicy ?? null;
}
module.exports = { readContextTransfer, recordContextTransfer, maintenanceScope, sameMaintenanceScope,
  validRestorePolicy, maintenanceRecords, recordMaintenance, workingRestorePolicy };
