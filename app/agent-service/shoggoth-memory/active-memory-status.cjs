"use strict";
const { core } = require("./host.cjs");
const { sha256 } = require("./migration.cjs");
const { STATUS_NAMESPACE } = require("./active-memory-state.cjs");
const protocol = require("../active-memory-status-protocol");
const { normalizeBorrowedMemoryRefs } = require("./borrowed-memory-provenance.cjs");
const { validEvidence } = require("./active-memory-evidence.cjs");
const PROOF_NAMESPACE = "active-memory-status-proof";
const MAX_SOURCES = 2048, MAX_BYTES = 256 * 1024;

// The upstream lines may include a recalled summary. A separate bounded host
// receipt ties those exact bytes to their source hashes and Product scope;
// display never reuses an expired in-process model execution capability.
class ActiveMemoryStatus {
  constructor(active) { this.active = active; this.service = active.service; }
  row(database, namespace, key) {
    return database.db.prepare(`SELECT version,expires_at,
      CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END AS value
      FROM memory_state WHERE namespace=? AND key=? AND value IS NOT NULL`).get(MAX_BYTES, namespace, key);
  }
  guard(scope) {
    scope.assertCurrent();
    const { service } = this, profileId = scope.session.profileId;
    const policy = scope.database.db.prepare("SELECT version FROM memory_state WHERE namespace='active-memory-session-toggles' AND key=?").get(scope.key);
    const route = service.resolveModelContext?.({ profileId, sessionKey: scope.session.sessionKey });
    route?.assertCurrent();
    return sha256(JSON.stringify([profileId, scope.session.id, scope.session.workspace,
      service.profiles().find(profile => profile.id === profileId), service.store.getRevision(profileId),
      service.recallPolicy.getRevision(profileId), service.config(profileId), policy?.version ?? 0, route?.fingerprint ?? null]));
  }
  async capture({ input, runtime, evidence, borrowedMemoryRefs = [], check }) {
    if (!runtime.statusVersion || evidence.length > MAX_SOURCES) return;
    check();
    const scope = this.service.activeMemoryCommands.scope(input.run.sourceId || input.session.sessionKey, check);
    const key = sha256(scope.session.sessionKey), row = this.row(scope.database, STATUS_NAMESPACE, key);
    if (!row?.value || row.version !== runtime.statusVersion || row.expires_at !== null
      || JSON.parse(row.value).owner !== runtime.owner) return;
    const proof = { profileId: scope.session.profileId, sessionId: scope.session.id, sessionKey: scope.canonical,
      guard: this.guard(scope), statusVersion: row.version, statusHash: sha256(row.value),
      outcome: runtime.nativeResult?.status ?? null, evidence, borrowedMemoryRefs };
    if (Buffer.byteLength(JSON.stringify(proof)) > MAX_BYTES) return;
    await scope.database.openKeyedStore({ namespace: PROOF_NAMESPACE, maxEntries: core.ACTIVE_MEMORY_MAX_CACHE_ENTRIES }, check).register(key, proof);
    check();
  }
  async read(raw) {
    const input = protocol.validateParams(raw), { service, active } = this;
    if (service.chatSessionStore.getSession(input.sessionKey)?.profileId !== input.profileId) protocol.fail("MEMORY_STATUS_UNAVAILABLE");
    const scope = service.activeMemoryCommands.scope(input.sessionKey);
    if (scope.session.profileId !== input.profileId) protocol.fail("MEMORY_STATUS_UNAVAILABLE");
    const empty = phase => protocol.validateResult({ supported: true, phase, outcome: null,
      updatedAt: null, statusLines: [], traceLines: [] }, input);
    const policy = await service.activeMemoryCommands.policy(input.sessionKey); scope.assertCurrent(); policy.assertCurrent();
    const config = active.configuration(input.profileId);
    if (!config || !config.enabled || config.mode === "off" || policy.disabled
      || !(core.isActiveMemoryEnabledForAgent(config, input.profileId)
        || core.resolveRememberAcrossConversations(service.config(input.profileId), input.profileId))) return empty("disabled");
    if (scope.host.activeMemoryRecovery?.unresolved) return empty("recovery_pending");
    const runs = [...active.runs.values()].filter(run => run.profileId === input.profileId && run.sessionKey === input.sessionKey);
    if (runs.some(run => run.cleanup)) return empty("cleaning");
    if ([...active.runtimes].some(runtime => runtime.host.profileId === input.profileId
      && runtime.input.session?.sessionKey === input.sessionKey && runtime.finished && !runtime.closed)) return empty("cleaning");
    if (runs.some(run => run.statusPhase === "recalling")) return empty("recalling");
    if (runs.some(run => run.statusPhase === "preparing")) return empty("preparing");
    const key = sha256(input.sessionKey), row = this.row(scope.database, STATUS_NAMESPACE, key);
    if (!row) return empty("idle");
    try {
      if (!row.value || row.expires_at !== null) return empty("stale");
      const record = JSON.parse(row.value), proofRow = this.row(scope.database, PROOF_NAMESPACE, key);
      if (!proofRow?.value || proofRow.expires_at !== null) return empty("stale");
      const proof = JSON.parse(proofRow.value);
      const borrowedMemoryRefs = normalizeBorrowedMemoryRefs(proof.borrowedMemoryRefs || []);
      if (proof.profileId !== input.profileId || proof.sessionId !== scope.session.id || proof.sessionKey !== scope.canonical
        || record.sessionId !== scope.session.id || record.sessionKey !== scope.canonical
        || proof.statusVersion !== row.version || proof.statusHash !== sha256(row.value) || proof.guard !== this.guard(scope)
        || !Array.isArray(proof.evidence) || proof.evidence.length > MAX_SOURCES
        || proof.evidence.some(item => !validEvidence(item))
        || !active.evidenceCurrent(input.profileId, proof.evidence, borrowedMemoryRefs, scope.session.id)) return empty("stale");
      const statusLines = core.resolveSessionPluginStatusLines(record.entry);
      const traceLines = input.includeTrace ? core.resolveSessionPluginTraceLines(record.entry) : [];
      scope.assertCurrent(); policy.assertCurrent();
      return protocol.validateResult({ supported: true, phase: statusLines.length || traceLines.length ? "complete" : "idle",
        outcome: statusLines.length || traceLines.length ? proof.outcome : null,
        updatedAt: statusLines.length || traceLines.length ? record.updatedAt : null, statusLines, traceLines }, input);
    } catch { return empty("stale"); }
  }
}
module.exports = { ActiveMemoryStatus, PROOF_NAMESPACE };
