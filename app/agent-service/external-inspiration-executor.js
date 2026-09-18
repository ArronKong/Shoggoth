"use strict";

const { serviceError } = require("./security");
const { validateInteractiveResponseV1 } = require("../core/shoggoth-interaction-contract");
const { EXTERNAL_TERMINAL, validateExternalInspirationResult } = require("../external-inspiration-protocol");

const fail = code => { throw serviceError(code, code); };
const common = execution => ({ executionId: execution.id, runId: execution.runId,
  backendId: execution.backendId, agentId: execution.agentId,
  sessionKey: execution.sessionKey, workspace: execution.workspace });
const bound = execution => ({ ...common(execution), mode: execution.external.mode, hostId: execution.external.hostId });

/** Persists intent before every model start; recovery only reconciles that exact run. */
class ExternalInspirationExecutor {
  constructor({ store, client, prompt, sanitizeSummary = value => value, now = Date.now, pollMs = 1500 } = {}) {
    this.store = store;
    this.client = client;
    this.prompt = prompt;
    this.sanitizeSummary = sanitizeSummary;
    this.now = now;
    this.pollMs = pollMs;
    this.opened = false;
    this.generation = 0;
    this.pending = new Map();
    this.timers = new Map();
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.generation += 1;
    for (const execution of this.store.pendingExecutions(true)) {
      if (execution.external && !this.terminal(execution)) this.schedule(execution, true);
    }
  }

  close() {
    this.opened = false;
    this.generation += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  terminal(execution) {
    return Boolean(execution.preparationFailure || EXTERNAL_TERMINAL.has(execution.external?.status));
  }

  #alive(generation) { return this.opened && this.generation === generation; }

  #serialize(runId, action) {
    const previous = this.pending.get(runId) || Promise.resolve();
    const promise = previous.catch(() => {}).then(action);
    this.pending.set(runId, promise);
    promise.finally(() => { if (this.pending.get(runId) === promise) this.pending.delete(runId); }).catch(() => {});
    return promise;
  }

  #later(runId, generation) {
    if (!this.#alive(generation) || this.timers.has(runId)) return;
    const execution = this.store.executionForRun(runId);
    if (!execution || this.terminal(execution)) return;
    const delay = execution.external.status === "unknown" ? Math.max(this.pollMs, 5000) : this.pollMs;
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      this.schedule(execution, true);
    }, delay);
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  schedule(execution, recovered = false) {
    if (!this.opened || !execution.external || this.terminal(execution)) return;
    const generation = this.generation;
    return this.#serialize(execution.runId, () => this.#advance(execution.runId, recovered, generation))
      .catch(() => {}).finally(() => this.#later(execution.runId, generation));
  }

  #save(execution, method, result) {
    if (!validateExternalInspirationResult(`inspiration.external.${method}`, result)
      || (method !== "get" && result.hostId !== execution.external.hostId)) fail("INSPIRATION_RESPONSE_INVALID");
    const sanitized = structuredClone(result);
    sanitized.snapshot.resultSummary = this.sanitizeSummary(sanitized.snapshot.resultSummary);
    return this.store.updateExternalSnapshot(execution.id, sanitized);
  }

  async #advance(runId, recovered, generation) {
    if (!this.#alive(generation)) return;
    let execution = this.store.executionForRun(runId);
    if (!execution || this.terminal(execution)) return;
    try {
      if (execution.external.phase === "preparing") {
        if (execution.external.cancelOperationId) {
          this.store.finishExternalBeforeStart(execution.id, { status: "canceled" });
          return;
        }
        if (recovered) {
          // A model start cannot precede a persisted binding and dispatched phase.
          this.store.failPreparation(execution.id, "EXTERNAL_PREPARATION_INTERRUPTED");
          return;
        }
        const prepared = await this.client.request("inspiration.external.prepare", {
          ...common(execution), operationId: execution.id,
        });
        if (!this.#alive(generation)) return;
        execution = this.store.bindExternalSession(execution.id, prepared);
      }
      if (execution.external.cancelOperationId && execution.external.phase !== "dispatched") {
        this.store.finishExternalBeforeStart(execution.id, { status: "canceled" });
        return;
      }
      if (execution.external.phase === "prepared" && !recovered) {
        await this.#start(execution, generation);
        return;
      }
      const originalHostId = execution.external.hostId;
      const result = await this.client.request("inspiration.external.get", bound(execution));
      if (!this.#alive(generation)) return;
      execution = this.#save(execution, "get", result);
      if (this.terminal(execution)) return;
      if (execution.external.cancelOperationId) {
        await this.#cancelBound(execution, generation);
      } else if (result.hostId === originalHostId && result.snapshot.status === "queued") {
        // Only this exact live host's reserved, never-started record proves that
        // a lost Service turn did not send the model prompt.
        await this.#start(execution, generation);
      } else if (execution.external.phase === "prepared") {
        this.store.failPreparation(execution.id, "EXTERNAL_PREPARATION_INTERRUPTED");
      }
    } catch (error) {
      if (!this.#alive(generation)) return;
      execution = this.store.executionForRun(runId);
      if (!execution || this.terminal(execution)) return;
      if (execution.external.phase !== "dispatched") {
        this.store.failPreparation(execution.id, typeof error?.code === "string" ? error.code : "EXTERNAL_PREPARATION_FAILED");
      } else this.store.markExternalUnknown(execution.id, "EXTERNAL_EXECUTION_UNCONFIRMED");
    }
  }

  async #start(execution, generation) {
    const prompt = this.prompt(execution);
    execution = this.store.markExternalDispatched(execution.id);
    const result = await this.client.request("inspiration.external.start", {
      ...bound(execution), operationId: execution.id, prompt,
    });
    if (this.#alive(generation)) this.#save(execution, "start", result);
  }

  async #cancelBound(execution, generation) {
    const result = await this.client.request("inspiration.external.cancel", {
      ...bound(execution), operationId: execution.external.cancelOperationId,
    });
    if (this.#alive(generation)) this.#save(execution, "cancel", result);
  }

  cancel(execution, operationId) {
    if (this.terminal(execution)) return Promise.resolve();
    this.store.setExternalCancel(execution.id, operationId);
    return this.schedule(this.store.executionForRun(execution.runId), true);
  }

  respond(execution, input) {
    const generation = this.generation;
    return this.#serialize(execution.runId, async () => {
      if (!this.#alive(generation)) fail("INSPIRATION_UNAVAILABLE");
      if (this.store.replayResponse(input)) return;
      let current = this.store.executionForRun(execution.runId);
      if (this.terminal(current) || current.external.phase !== "dispatched") fail("INSPIRATION_REQUEST_EXPIRED");
      const result = await this.client.request("inspiration.external.get", bound(current));
      if (!this.#alive(generation)) fail("INSPIRATION_UNAVAILABLE");
      current = this.#save(current, "get", result);
      const attention = current.external.attention;
      if (!attention?.active || attention.request.requestId !== input.requestId
        || (attention.request.expiresAt !== null && attention.request.expiresAt <= this.now())) fail("INSPIRATION_REQUEST_EXPIRED");
      validateInteractiveResponseV1(attention.request, input.response);
      // Persist only its digest before sending. An uncertain response is never
      // automatically replayed, and credential answers never enter the store.
      this.store.recordResponse(input);
      try {
        const response = await this.client.request("inspiration.external.respond", {
          ...bound(current), requestId: input.requestId, response: input.response, operationId: input.operationId,
        });
        if (this.#alive(generation)) this.#save(current, "respond", response);
      } catch {
        if (this.#alive(generation)) this.store.markExternalUnknown(current.id, "EXTERNAL_RESPONSE_UNCONFIRMED");
      }
    }).finally(() => this.#later(execution.runId, generation));
  }
}

module.exports = { ExternalInspirationExecutor };
