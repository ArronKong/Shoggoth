"use strict";

// Trusted desktop composition owns the client factory and mode persistence.
// HTTP callers select an operation only; they cannot choose a runtime, policy,
// executable, private directory, Gateway credential or activation authority.
const { createManagedOpenClawProductModelApi } = require("./managed-openclaw-product-model-api");
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STATES = new Set(["idle", "preparing", "activating", "running", "stopping", "stopped", "failed", "needs_verification"]);
function fail(code, status = 409) { return Object.assign(new Error(code), { code, status }); }
function operation(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, "operationId")
    || typeof input.operationId !== "string" || !OP.test(input.operationId)) throw fail("MANAGED_HOST_OPERATION_INVALID", 400);
  return input.operationId;
}
function publicError(error) {
  return typeof error?.code === "string" && /^(?:RUNTIME|MANAGED_HOST)_[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code : "MANAGED_HOST_ACTION_FAILED";
}
function projectManagedOpenClawHostStatus(value = {}) {
  const state = STATES.has(value.state) ? value.state : "needs_verification";
  return Object.freeze({ version: 1, backendId: "openclaw", mode: value.mode === "managed" ? "managed" : "existing",
    state, operationId: typeof value.operationId === "string" && OP.test(value.operationId) ? value.operationId : null,
    selectionSupported: state === "running" && value.selectionSupported === true,
    errorCode: value.errorCode ? publicError({ code: value.errorCode }) : null });
}

function createManagedOpenClawProductHost({ getMode, setManagedMode, createClient, getEnabled = () => true,
  onReady = async () => {}, onUnavailable = async () => {}, onModelUnavailable = onUnavailable, onOwnedExit = async () => {} } = {}) {
  if ([getMode, setManagedMode, createClient, getEnabled, onReady, onUnavailable, onModelUnavailable, onOwnedExit].some(fn => typeof fn !== "function")) {
    throw new TypeError("Invalid managed OpenClaw product composition");
  }
  let client = null, busy = null, closing = false, suspended = false, modelBusy = false;
  let state = getMode() === "managed" ? "stopped" : "idle";
  let currentOperation = null, errorCode = null;
  const operations = new Map();
  // Keep bounded receipts separately from accepted ids. Eviction must never
  // turn a retry of an uncertain operation into a new activation.
  const acceptedOperations = new Set();
  const MAX_ACCEPTED_OPERATIONS = 4096;
  const isManaged = () => getMode() === "managed";
  function verified() {
    if (closing || suspended || modelBusy || !isManaged() || getEnabled() !== true || state !== "running" || !client) return false;
    const actual = client.getStatus();
    return actual?.state === "running" && actual.ownership === "managed"
      && actual.selectionSupported === true && !!client.getEndpoint() && !!client.getExecution();
  }
  function status() {
    const ready = verified();
    if (state === "running" && !ready) { state = "needs_verification"; errorCode = "MANAGED_HOST_ENDPOINT_UNVERIFIED"; }
    const value = projectManagedOpenClawHostStatus({ mode: isManaged() ? "managed" : "existing", state,
      operationId: currentOperation, selectionSupported: ready, errorCode });
    const record = operations.get(currentOperation);
    if (record) record.status = value;
    return value;
  }
  function operationStatus(operationId) {
    if (typeof operationId !== "string" || !OP.test(operationId)) throw fail("MANAGED_HOST_OPERATION_INVALID", 400);
    const record = operations.get(operationId);
    if (!record) throw fail("MANAGED_HOST_OPERATION_NOT_FOUND", 404);
    if (operationId === currentOperation) return status();
    // A past operation receipt never supplies current execution readiness.
    return projectManagedOpenClawHostStatus({ ...record.status, selectionSupported: false });
  }
  function ensureClient() {
    if (!client) client = createClient();
    if (!client || !client.ready || typeof client.controller?.prepareCandidate !== "function"
      || typeof client.controller?.activateCandidate !== "function" || typeof client.close !== "function") {
      throw fail("MANAGED_HOST_CLIENT_INVALID");
    }
    return client;
  }
  function schedule(kind, input) {
    const operationId = operation(input);
    if (closing && kind !== "stop") throw fail("MANAGED_HOST_CLOSING");
    if (kind !== "stop" && getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
    const previous = operations.get(operationId);
    if (previous) {
      if (previous.kind !== kind) throw fail("MANAGED_HOST_OPERATION_CONFLICT");
      return operationStatus(operationId);
    }
    if (acceptedOperations.has(operationId)) throw fail("MANAGED_HOST_OPERATION_EXPIRED");
    if (acceptedOperations.size >= MAX_ACCEPTED_OPERATIONS) throw fail("MANAGED_HOST_OPERATION_CAPACITY");
    if (busy || (modelBusy && kind !== "stop")) throw fail("MANAGED_HOST_OPERATION_BUSY");
    if (kind === "restart" && !isManaged()) throw fail("MANAGED_HOST_NOT_PREPARED");
    if (kind === "prepare") setManagedMode();
    if (!isManaged()) throw fail("MANAGED_HOST_MODE_NOT_SAVED");
    if (kind === "stop") modelBridge.retire();
    currentOperation = operationId; errorCode = null;
    state = kind === "stop" ? "stopping" : "preparing";
    const record = { kind, promise: null };
    operations.set(operationId, record);
    acceptedOperations.add(operationId);
    while (operations.size > 128) operations.delete(operations.keys().next().value);
    const task = Promise.resolve().then(async () => {
      await onUnavailable();
      if (closing && kind !== "stop") throw fail("MANAGED_HOST_CLOSING");
      if (kind !== "stop" && getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
      if (closing && kind === "stop") {
        if (client) await client.close({ operationId, timeoutMs: 60000 });
        if (client) await publishOwnedExit(client); else await modelBridge.settle(); modelBusy = false;
        state = "stopped";
        releaseSuspendedClient();
        return status();
      }
      const owned = ensureClient();
      await owned.ready;
      if (closing) throw fail("MANAGED_HOST_CLOSING");
      if (kind !== "stop" && getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
      if (kind === "stop") {
        await owned.controller.stopOwned({ operationId, timeoutMs: 60000 });
        await publishOwnedExit(owned); modelBusy = false;
        state = "stopped";
        return status();
      }
      // Reuse the fixed immutable candidate after the worker checks its full
      // descriptor/tree. Never treat its persistent active pointer as ownership.
      let candidate = await owned.controller.getCandidate({});
      if (closing) throw fail("MANAGED_HOST_CLOSING");
      if (getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
      if (!candidate) candidate = await owned.controller.prepareCandidate({});
      if (getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
      if (closing || !candidate || !HASH.test(candidate.candidateId)) throw fail("MANAGED_HOST_CANDIDATE_INVALID");
      state = "activating";
      status();
      const activated = await owned.controller.activateCandidate({ candidateId: candidate.candidateId, operationId });
      if (closing || getEnabled() !== true || activated?.healthVerified !== true) throw fail("MANAGED_HOST_ENDPOINT_UNVERIFIED");
      state = "running";
      if (!verified()) throw fail("MANAGED_HOST_ENDPOINT_UNVERIFIED");
      await onReady();
      return status();
    }).catch(async error => {
      state = "needs_verification"; errorCode = publicError(error);
      try { await onUnavailable(); } catch { /* original failure remains */ }
      return status();
    }).finally(() => { if (busy === task) busy = null; });
    record.promise = task; busy = task;
    return status();
  }
  async function publishOwnedExit(owned) {
    const proof = await modelBridge.proveOwnedExit(owned);
    await onOwnedExit(proof);
    modelBridge.acknowledgeOwnedExit(proof);
  }
  function releaseSuspendedClient() {
    if (!suspended) return;
    if (client && client.getStatus()?.state !== "closed") throw fail("MANAGED_HOST_OWNED_STOP_UNVERIFIED");
    client = null; suspended = false; closing = false;
  }
  async function close({ operationId = "desktop-owned-close", timeoutMs = 60000 } = {}) {
    closing = true;
    modelBridge.retire();
    state = "stopping";
    try {
      await onUnavailable();
      if (client) await client.close({ operationId, timeoutMs });
      // Canceled activation continuations settle before the final stop receipt.
      if (busy) await busy;
      if (client) await publishOwnedExit(client); else await modelBridge.settle(); modelBusy = false;
      state = "stopped"; errorCode = null;
      return status();
    } catch (error) {
      state = "needs_verification"; errorCode = publicError(error); status();
      throw error;
    }
  }
  const modelBridge = createManagedOpenClawProductModelApi({
    getClient: () => client,
    canAcquire: () => !busy && !modelBusy && verified(),
    canContinue: owned => owned === client && isManaged() && getEnabled() === true && !closing && !suspended,
    begin: scope => { modelBusy = true; state = "activating"; errorCode = null; currentOperation = scope.operationId; return onModelUnavailable(); },
    resumed: async owned => {
      const actual = owned.getStatus();
      if (closing || suspended || getEnabled() !== true || owned !== client || actual?.state !== "running"
        || actual.ownership !== "managed" || actual.selectionSupported !== true || !owned.getEndpoint() || !owned.getExecution()) {
        throw fail("MANAGED_HOST_MODEL_RESUME_UNVERIFIED");
      }
      modelBusy = false; state = "running"; errorCode = null;
      await onReady();
    },
    failed: async (owned, error) => {
      if (owned !== client || closing || suspended) return;
      modelBusy = true; state = "needs_verification"; errorCode = publicError(error);
      await onUnavailable();
    },
  });
  return Object.freeze({
    getModelApplyApi: () => modelBridge.api,
    getStatus: status,
    getOperationStatus: operationStatus,
    isManaged,
    getEndpoint: () => verified() ? client.getEndpoint() : null,
    getExecution: () => isManaged() ? verified() ? client.getExecution() : null : undefined,
    prepare: input => schedule("prepare", input),
    restart: input => schedule("restart", input),
    stop: input => schedule("stop", input),
    async waitForOperation(operationId) {
      if (!OP.test(operationId) || !operations.has(operationId)) throw fail("MANAGED_HOST_OPERATION_NOT_FOUND", 404);
      await operations.get(operationId).promise;
      return operationStatus(operationId);
    },
    close,
    async suspend(options = {}) {
      // Trusted desktop disabled-backend lifecycle only. A fresh client becomes
      // possible only after the previous client's exact owned exit is proved.
      suspended = true;
      await close(options);
      releaseSuspendedClient();
      return status();
    },
  });
}
module.exports = { createManagedOpenClawProductHost, projectManagedOpenClawHostStatus };
