"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");

const identity = value => `${value.backendId}/${value.agentId}`;
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const RETRYABLE = new Set(["failed", "interrupted", "skipped"]);
const uncertain = code => /UNKNOWN|UNCONFIRMED|UNCERTAIN/u.test(code || "");

function validExecutors(values) {
  return Array.isArray(values) && values.length <= 32
    && values.every(value => exact(value, ["agentId", "backendId"]) && id(value.agentId) && id(value.backendId))
    && new Set(values.map(identity)).size === values.length;
}

function validGrowthSettings(value) {
  return exact(value, ["revision", "enabled", "executors"]) && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.enabled === "boolean" && validExecutors(value.executors) && (!value.enabled || value.executors.length > 0);
}

function validGrowthJob(value) {
  return exact(value, ["ideaId", "attempt", "input", "state", "runId", "errorCode"])
    && id(value.ideaId) && [1, 2].includes(value.attempt)
    && ["pending", "running", "retry", "blocked", "done"].includes(value.state)
    && (value.runId === null || id(value.runId)) && (value.errorCode === null || id(value.errorCode))
    && exact(value.input, ["id", "operationId", "expectedRevision", "agentId", "backendId", "instruction", "workspace"])
    && value.input.id === value.ideaId && id(value.input.operationId) && id(value.input.agentId) && id(value.input.backendId)
    && Number.isSafeInteger(value.input.expectedRevision) && value.input.expectedRevision > 0
    && typeof value.input.instruction === "string" && Buffer.byteLength(JSON.stringify(value.input.instruction)) <= 16 * 1024
    && (value.input.workspace === null || (typeof value.input.workspace === "string" && path.isAbsolute(value.input.workspace)));
}

/** A single Service-owned queue. No timer or model call is needed for an empty queue. */
class InspirationGrowth {
  constructor({ store, service, random = Math.random }) {
    this.store = store;
    this.service = service;
    this.random = random;
    this.opened = false;
    this.scheduled = null;
    this.errorCode = null;
    this.generation = 0;
    this.checking = new Set();
    this.waitingExecutors = new Set();
    this.reconnectTimer = null;
    this.wake = this.wake.bind(this);
  }

  open() {
    this.opened = true;
    this.generation += 1;
    this.store.on("changed", this.wake);
    this.wake();
  }

  close() {
    this.opened = false;
    this.generation += 1;
    this.store.off("changed", this.wake);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    this.checking.clear();
    this.waitingExecutors.clear();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  wake() {
    if (!this.opened || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      if (!this.opened) return;
      try { this.drain(); this.errorCode = null; }
      catch (error) { this.errorCode = /^INSPIRATION_[A-Z_]+$/u.test(error?.code || "") ? error.code : "INSPIRATION_UNAVAILABLE"; }
    });
  }

  busyAgents(operationId = null) {
    const busy = new Set();
    for (const execution of [...this.store.pendingExecutions(false), ...this.store.pendingExecutions(true)]) {
      if (execution.operationId !== operationId && !TERMINAL.has(this.service.executionStatus(execution).status)) busy.add(identity(execution));
    }
    for (const job of this.store.growthJobs(["pending"])) {
      if (job.input.operationId !== operationId) busy.add(identity(job.input));
    }
    return busy;
  }

  assertAvailable(input) {
    const settings = this.store.growthSettings();
    const managed = settings.enabled && settings.executors.some(value => identity(value) === identity(input))
      || this.store.growthJobs(["running"]).some(job => identity(job.input) === identity(input));
    if (managed
      && this.busyAgents(input.operationId).has(identity(input))) {
      throw serviceError("INSPIRATION_AGENT_BUSY", "这个 Agent 正在处理另一条灵感，完成后才能接下一条");
    }
  }

  drain() {
    const settings = this.store.growthSettings();
    // Settle finished attempts even while paused, but never dispatch while paused.
    for (const job of this.store.growthJobs(["pending", "running", "retry"])) {
      const idea = this.store.get(job.ideaId);
      if (!idea || idea.archivedAt !== null) { this.store.saveGrowthJob({ ...job, state: "done" }); continue; }
      const execution = this.store.executionForOperation(job.input.operationId);
      const latest = this.store.latestExecution(job.ideaId);
      if (!execution) {
        // Manual work can supersede an unstarted assignment while growth is paused.
        if ((latest?.runId ?? null) !== job.runId) this.store.saveGrowthJob({ ...job, state: "done" });
        else if (latest && this.service.executionStatus(latest).status === "canceled") {
          this.store.saveGrowthJob({ ...job, state: "blocked", errorCode: "INSPIRATION_CANCELED" });
        }
        continue;
      }
      if (latest?.id !== execution.id) { this.store.saveGrowthJob({ ...job, state: "done" }); continue; }
      const { status, errorCode } = this.service.executionStatus(execution);
      const state = status === "completed" ? "done" : status === "canceled" ? "blocked" : RETRYABLE.has(status)
        ? job.attempt < 2 && !uncertain(errorCode) ? "retry" : "blocked" : "running";
      const next = { ...job, state, runId: execution.runId, errorCode: status === "canceled" ? "INSPIRATION_CANCELED"
        : RETRYABLE.has(status) ? errorCode || `INSPIRATION_${status.toUpperCase()}` : null };
      if (JSON.stringify(next) !== JSON.stringify(job)) this.store.saveGrowthJob(next);
    }
    const pendingOperations = new Set(this.store.growthJobs(["pending"]).map(job => job.input.operationId));
    for (const operationId of this.waitingExecutors) {
      if (!settings.enabled || !pendingOperations.has(operationId)) this.waitingExecutors.delete(operationId);
    }
    if (!this.waitingExecutors.size) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (!settings.enabled) return;
    // Randomize the available executors once per drain, then assign oldest seeds first.
    const executors = [...settings.executors];
    for (let index = executors.length - 1; index > 0; index--) {
      const other = Math.floor(this.random() * (index + 1));
      [executors[index], executors[other]] = [executors[other], executors[index]];
    }
    for (const job of this.store.growthJobs(["pending"])) {
      if (this.store.executionForOperation(job.input.operationId)) continue;
      if (!settings.executors.some(value => identity(value) === identity(job.input))) {
        const agent = executors.find(value => !this.busyAgents(job.input.operationId).has(identity(value)));
        if (!agent) continue;
        const idea = this.store.get(job.ideaId);
        this.startJob(this.reserve(idea, agent, job.attempt));
      } else if (!this.busyAgents(job.input.operationId).has(identity(job.input))) this.startJob(job);
    }
    for (const agent of executors) {
      if (this.busyAgents().has(identity(agent))) continue;
      const retry = this.store.growthJobs(["retry"]).find(job => {
        const idea = this.store.get(job.ideaId);
        if (!idea || idea.archivedAt !== null || (this.store.latestExecution(job.ideaId)?.runId ?? null) !== job.runId) {
          this.store.saveGrowthJob({ ...job, state: "done" }); return false;
        }
        // A retry keeps its executor/session context while that executor remains selected.
        if (settings.executors.some(value => identity(value) === identity(job.input))
          && identity(agent) !== identity(job.input)) return false;
        return true;
      });
      const idea = retry ? this.store.get(retry.ideaId) : this.store.nextGrowthSeed();
      if (!idea) continue;
      this.startJob(this.reserve(idea, agent, retry ? retry.attempt + 1 : this.store.latestExecution(idea.id) ? 2 : 1));
    }
  }

  reserve(idea, agent, attempt) {
    const previous = this.store.latestExecution(idea.id);
    const job = { ideaId: idea.id, attempt, state: "pending", runId: previous?.runId ?? null, errorCode: null,
      input: { id: idea.id, operationId: `growth-${crypto.randomUUID()}`, expectedRevision: idea.revision,
        agentId: agent.agentId, backendId: agent.backendId, instruction: previous?.instruction || "",
        workspace: previous && identity(previous) === identity(agent) ? previous.workspace : null } };
    this.store.saveGrowthJob(job); // Persist the exact operation before any side effect.
    return job;
  }

  startJob(job) {
    const operationId = job.input.operationId;
    if (this.checking.has(operationId) || this.waitingExecutors.has(operationId)) return;
    const generation = this.generation;
    const current = () => this.opened && generation === this.generation && this.store.growthSettings().enabled
      && this.store.growthJobs(["pending"]).some(value => value.input.operationId === operationId)
      && this.store.growthSettings().executors.some(value => identity(value) === identity(job.input));
    this.checking.add(operationId);
    // All backends (including native Runtimes) must finish desktop registration
    // and recovery before dispatch. Keep the durable intent pending meanwhile,
    // without creating failed runs or consuming either attempt.
    this.service.prepareGrowthStart(job.input).then(() => {
      if (current()) this.launchJob(job);
    }, error => {
      if (!current()) return;
      if (["APP_HOST_UNAVAILABLE", "BACKEND_UNAVAILABLE"].includes(error?.code)) {
        this.waitingExecutors.add(operationId);
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.waitingExecutors.clear();
            this.wake();
          }, 5000);
          this.reconnectTimer.unref?.();
        }
      } else this.failJob(job, error);
    }).catch(() => { if (this.opened && generation === this.generation) this.errorCode = "INSPIRATION_UNAVAILABLE"; })
      .finally(() => { if (generation === this.generation) this.checking.delete(operationId); });
  }

  launchJob(job) {
    try {
      const idea = this.service.start(job.input);
      this.store.saveGrowthJob({ ...job, state: "running", runId: idea.latestExecution.runId });
    } catch (error) {
      // If start committed before reporting an error, reconcile that operation.
      const execution = this.store.executionForOperation(job.input.operationId);
      if (execution) { this.store.saveGrowthJob({ ...job, state: "running", runId: execution.runId }); return; }
      this.failJob(job, error);
    }
  }

  failJob(job, error) {
    if (error.code === "INSPIRATION_AGENT_BUSY") return;
    if (error.code === "INSPIRATION_REVISION_CONFLICT") {
      const idea = this.store.get(job.ideaId);
      // Editing/favoriting a waiting seed is not a failed execution. Refresh
      // its unstarted intent without spending the automatic retry.
      if (idea && idea.archivedAt === null) { this.reserve(idea, job.input, job.attempt); return; }
    }
    const code = id(error.code) ? error.code : "INSPIRATION_START_FAILED";
    this.store.saveGrowthJob({ ...job, state: job.attempt < 2 && !uncertain(code) ? "retry" : "blocked", errorCode: code });
  }
}

module.exports = { InspirationGrowth, validExecutors, validGrowthSettings, validGrowthJob };
