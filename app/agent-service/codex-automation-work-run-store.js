"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateWorkRun, storeError } = require("./product-store");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { OWNER, ACCOUNT_ID } = require("./codex-automation-store");
const ACTIVE = new Set(["starting", "running", "waiting_approval", "waiting_input"]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RUNS = 4096;
const live = run => run.status === "queued" || ACTIVE.has(run.status);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message = code) => { throw storeError(code, message); };

// Private feature data is deliberately kept outside ProductStore schema 15.
// Older builds can reopen their existing snapshot/log after a branch rollback.
// The Agent Service's instance writer lease covers both stores.
class CodexAutomationWorkRunStore {
  constructor({ productStore, paths, now = Date.now, assertSecretSafe = () => true }) {
    Object.assign(this, { productStore, paths, now, assertSecretSafe });
    this.file = path.join(paths.stateDir, "codex-automation-work-runs.v1.json");
    this.runs = new Map(); this.idempotency = new Map(); this.opened = false; this.uncertain = false;
  }
  validate(record) {
    const run = validateWorkRun(record, "automation");
    if (!/^automation-[a-f0-9-]{36}$/u.test(run.id)
      || !/^codex-automation:[a-f0-9]{24}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(run.sourceId)
      || !run.idempotencyKey.startsWith("codex-automation:") || run.idempotencyKey.length > 320
      || run.contextSnapshotId !== null || run.retryOf !== null) {
      fail("CODEX_AUTOMATION_WORK_RUN_INVALID");
    }
    for (const ref of [run.runtimeSessionRef, run.runtimeTurnRef]) {
      if (ref && (ref.runtime !== "codex" || ref.runtimeAccountId !== ACCOUNT_ID)) fail("WORK_RUN_BINDING_INVALID");
    }
    if (this.assertSecretSafe(run) !== true) fail("RUN_EVENT_SECRET_REJECTED");
    return run;
  }
  open() {
    if (this.opened) return;
    const recovery = recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot });
    if (recovery === "uncertain") fail("STORE_COMMIT_UNCERTAIN");
    const runs = new Map(), idempotency = new Map();
    if (fs.existsSync(this.file)) {
      const value = JSON.parse(readPrivateFile(this.file, { maxBytes: MAX_BYTES }));
      if (!value || Object.keys(value).length !== 2 || value.version !== 1
        || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) fail("CODEX_AUTOMATION_WORK_RUN_INVALID");
      for (const record of value.runs) {
        const run = this.validate(record);
        if (runs.has(run.id) || idempotency.has(run.idempotencyKey)) fail("WORK_RUN_IDEMPOTENCY_CONFLICT");
        if (ACTIVE.has(run.status) && run.runtimeSessionRef && [...runs.values()].some(prior =>
          ACTIVE.has(prior.status) && same(prior.runtimeSessionRef, run.runtimeSessionRef))) fail("THREAD_ACTIVE_TURN_CONFLICT");
        runs.set(run.id, run); idempotency.set(run.idempotencyKey, run.id);
      }
    }
    this.runs = runs; this.idempotency = idempotency; this.uncertain = false; this.opened = true;
  }
  close() { this.opened = false; this.runs.clear(); this.idempotency.clear(); }
  assertOpen() {
    if (!this.opened) fail("STORE_CLOSED");
    if (this.uncertain) fail("STORE_COMMIT_UNCERTAIN");
  }
  getWorkRun(id) { this.assertOpen(); return structuredClone(this.runs.get(id) || null); }
  getWorkRunByIdempotencyKey(key) { this.assertOpen(); return this.getWorkRun(this.idempotency.get(key)); }
  listWorkRuns(query = {}) {
    this.assertOpen();
    return [...this.runs.values()].filter(run =>
      ["source", "sourceId", "profileId", "workspace", "status", "retryOf"].every(key => query[key] === undefined || run[key] === query[key])
      && (query.runtimeSessionId === undefined || run.runtimeSessionRef?.sessionId === query.runtimeSessionId)).map(run => structuredClone(run));
  }
  putWorkRun(record) {
    this.assertOpen();
    const run = this.validate(record), existing = this.runs.get(run.id);
    const profile = this.productStore.getAgentProfile(run.profileId);
    if (!existing && (!profile || !profile.enabled)) fail(profile ? "AGENT_PROFILE_DISABLED" : "UNKNOWN_AGENT_PROFILE");
    if (live(run)) {
      // Each run keeps the owner that started it; ownership may move later.
      if (!profile || profile.backendId !== OWNER.backendId) fail("WORK_RUN_BINDING_INVALID");
      for (const ref of [run.runtimeSessionRef, run.runtimeTurnRef]) {
        if (ref && !(profile.bindings || [profile]).some(binding => binding.runtime === ref.runtime
          && binding.runtimeAccountId === ref.runtimeAccountId && binding.runtimeProfileId === ref.runtimeProfileId)) fail("WORK_RUN_BINDING_INVALID");
      }
    }
    if (existing) {
      for (const field of ["source", "sourceId", "idempotencyKey", "profileId", "workspace", "retryOf"]) {
        if (run[field] !== existing[field]) fail("WORK_RUN_IDENTITY_IMMUTABLE");
      }
      for (const field of ["runtimeSessionRef", "runtimeTurnRef"]) {
        if (existing[field] !== null && !same(existing[field], run[field])) fail("WORK_RUN_BINDING_IMMUTABLE");
      }
    }
    if (run.eventSeq !== (existing?.eventSeq || 0) + 1) fail("WORK_RUN_EVENT_SEQ_CONFLICT");
    const priorId = this.idempotency.get(run.idempotencyKey);
    if ((priorId && priorId !== run.id) || this.productStore.getWorkRun(run.id)
      || this.productStore.getWorkRunByIdempotencyKey(run.idempotencyKey)) fail("WORK_RUN_IDEMPOTENCY_CONFLICT");
    if (ACTIVE.has(run.status) && run.runtimeSessionRef && [...this.runs.values(), ...this.productStore.listWorkRuns()].some(prior =>
      prior.id !== run.id && ACTIVE.has(prior.status) && same(prior.runtimeSessionRef, run.runtimeSessionRef))) fail("THREAD_ACTIVE_TURN_CONFLICT");
    const updated = new Map(this.runs); updated.set(run.id, run);
    const data = JSON.stringify({ version: 1, runs: [...updated.values()] });
    if (updated.size > MAX_RUNS || Buffer.byteLength(data) > MAX_BYTES) fail("CODEX_AUTOMATION_CAPACITY");
    try { atomicWritePrivateFile(this.file, data, { trustedRoot: this.paths.trustedRoot }); }
    catch (error) {
      if (error.committedUncertain || error.code === "PRIVATE_FILE_COMMIT_UNCERTAIN") {
        this.uncertain = true; fail("STORE_COMMIT_UNCERTAIN");
      }
      throw error;
    }
    this.runs = updated; this.idempotency.set(run.idempotencyKey, run.id);
    return structuredClone(run);
  }
  recoverActiveRunAfterServiceRestart(id) {
    const run = this.getWorkRun(id);
    if (!run || !ACTIVE.has(run.status)) fail(run ? "WORK_RUN_NOT_ACTIVE" : "WORK_RUN_NOT_FOUND");
    return this.putWorkRun({ ...run, status: "interrupted", eventSeq: run.eventSeq + 1, waitingRequestId: null,
      finishedAt: Math.max(this.now(), run.startedAt || 0), errorCode: "SERVICE_RESTARTED" });
  }
}

function createAutomationWorkRunStore({ productStore, automationStore }) {
  return {
    getAgentProfile: id => productStore.getAgentProfile(id),
    getWorkRun: id => productStore.getWorkRun(id) || automationStore.getWorkRun(id),
    getWorkRunByIdempotencyKey: key => productStore.getWorkRunByIdempotencyKey(key) || automationStore.getWorkRunByIdempotencyKey(key),
    listWorkRuns: query => [...productStore.listWorkRuns(query), ...automationStore.listWorkRuns(query)],
    putWorkRun: run => run.source === "automation" ? automationStore.putWorkRun(run) : productStore.putWorkRun(run),
    recoverActiveRunAfterServiceRestart: id => (productStore.getWorkRun(id) ? productStore : automationStore).recoverActiveRunAfterServiceRestart(id),
  };
}
module.exports = { CodexAutomationWorkRunStore, createAutomationWorkRunStore };
