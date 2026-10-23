"use strict";
// Trusted desktop composition owns all private inputs. Public operations never
// choose code, credentials, directories, policy, or an activation authority.
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STATES = new Set(["idle", "preparing", "activating", "running", "stopping", "stopped", "failed", "needs_verification"]);
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
function operation(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 1
    || !Object.hasOwn(input, "operationId") || !Object.getOwnPropertyDescriptor(input, "operationId")?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, "operationId"), "value")
    || typeof input.operationId !== "string" || !OP.test(input.operationId)) throw fail("MANAGED_HOST_OPERATION_INVALID", 400);
  return input.operationId;
}
function publicError(error) {
  return typeof error?.code === "string" && /^(?:RUNTIME|MANAGED_HOST|MANAGED_HERMES|MANAGED_WORKER|HERMES)_[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code : "MANAGED_HOST_ACTION_FAILED";
}
function projectManagedHermesHostStatus(value = {}) {
  const state = STATES.has(value.state) ? value.state : "needs_verification";
  return Object.freeze({ version: 1, backendId: "hermes", mode: value.mode === "managed" ? "managed" : "existing", state,
    operationId: typeof value.operationId === "string" && OP.test(value.operationId) ? value.operationId : null,
    selectionSupported: state === "running" && value.selectionSupported === true,
    errorCode: value.errorCode ? publicError({ code: value.errorCode }) : null });
}
function createManagedHermesProductHost({ getMode, setManagedMode, createClient, getEnabled = () => true,
  onReady = async () => {}, onUnavailable = async () => {} } = {}) {
  if ([getMode, setManagedMode, createClient, getEnabled, onReady, onUnavailable].some(fn => typeof fn !== "function")) {
    throw new TypeError("Invalid managed Hermes product composition");
  }
  let client = null, busy = null, closing = false, suspended = false;
  let state = getMode() === "managed" ? "stopped" : "idle", currentOperation = null, errorCode = null;
  const operations = new Map(), acceptedOperations = new Set();
  const isManaged = () => getMode() === "managed";
  function verified() {
    if (closing || suspended || !isManaged() || getEnabled() !== true || state !== "running" || !client) return false;
    const actual = client.getStatus(), endpoint = client.getEndpoint(), execution = client.getExecution();
    return actual?.state === "running" && actual.ownership === "managed" && actual.selectionSupported === true
      && typeof actual.generation === "string" && HASH.test(actual.generation)
      && typeof actual.adapterGeneration === "string" && OP.test(actual.adapterGeneration)
      && endpoint && /^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint.baseUrl) && HASH.test(endpoint.token)
      && actual.identity && Number.isSafeInteger(actual.identity.pid) && actual.identity.pid > 1
      && endpoint.identity?.pid === actual.identity.pid && endpoint.identity?.nonce === actual.identity.nonce
      && HASH.test(actual.identity.nonce) && endpoint.identity?.startIdentity === actual.identity.startIdentity
      && typeof actual.identity.startIdentity === "string" && !!actual.identity.startIdentity
      && endpoint.dataRoot === actual.dataRoot && endpoint.runtimeRoot === actual.runtimeRoot
      && execution && execution.runtimeRoot === endpoint.runtimeRoot && execution.stateDir === endpoint.dataRoot
      && execution.interpreterPath === endpoint.interpreterPath && execution.entryPath === endpoint.entryPath;
  }
  function status() {
    const ready = verified();
    if (state === "running" && !ready) { state = "needs_verification"; errorCode = "MANAGED_HOST_ENDPOINT_UNVERIFIED"; }
    const value = projectManagedHermesHostStatus({ mode: isManaged() ? "managed" : "existing", state,
      operationId: currentOperation, selectionSupported: ready, errorCode });
    const record = operations.get(currentOperation); if (record) record.status = value;
    return value;
  }
  function operationStatus(operationId) {
    if (typeof operationId !== "string" || !OP.test(operationId)) throw fail("MANAGED_HOST_OPERATION_INVALID", 400);
    const record = operations.get(operationId);
    if (!record) throw fail("MANAGED_HOST_OPERATION_NOT_FOUND", 404);
    return operationId === currentOperation ? status() : projectManagedHermesHostStatus({ ...record.status, selectionSupported: false });
  }
  function ensureClient() {
    if (!client) client = createClient();
    if (!client || !client.ready || typeof client.controller?.prepareCandidate !== "function"
      || typeof client.controller?.activateCandidate !== "function" || typeof client.controller?.getCandidate !== "function"
      || typeof client.close !== "function") throw fail("MANAGED_HOST_CLIENT_INVALID");
    return client;
  }
  function assertAvailable(kind) {
    if (closing && kind !== "stop") throw fail("MANAGED_HOST_CLOSING");
    if (kind !== "stop" && getEnabled() !== true) throw fail("MANAGED_HOST_BACKEND_DISABLED");
  }
  function releaseSuspendedClient() {
    if (!suspended) return;
    if (client && client.getStatus()?.state !== "closed") throw fail("MANAGED_HOST_OWNED_STOP_UNVERIFIED");
    client = null; suspended = false; closing = false;
  }
  function schedule(kind, input) {
    const operationId = operation(input), previous = operations.get(operationId);
    if (previous) {
      if (previous.kind !== kind) throw fail("MANAGED_HOST_OPERATION_CONFLICT");
      return operationStatus(operationId);
    }
    if (acceptedOperations.has(operationId)) throw fail("MANAGED_HOST_OPERATION_EXPIRED");
    assertAvailable(kind);
    if (acceptedOperations.size >= 4096) throw fail("MANAGED_HOST_OPERATION_CAPACITY");
    if (busy) throw fail("MANAGED_HOST_OPERATION_BUSY");
    if (kind === "restart" && !isManaged()) throw fail("MANAGED_HOST_NOT_PREPARED");
    if (kind === "prepare") setManagedMode();
    if (!isManaged()) throw fail("MANAGED_HOST_MODE_NOT_SAVED");
    currentOperation = operationId; errorCode = null; state = kind === "stop" ? "stopping" : "preparing";
    const record = { kind, promise: null };
    operations.set(operationId, record); acceptedOperations.add(operationId);
    while (operations.size > 128) operations.delete(operations.keys().next().value);
    record.status = status();
    const task = Promise.resolve().then(async () => {
      await onUnavailable(); assertAvailable(kind);
      if (closing && kind === "stop") {
        if (client) await client.close({ operationId, timeoutMs: 60000 });
        state = "stopped"; releaseSuspendedClient(); return status();
      }
      const owned = ensureClient(); await owned.ready;
      if (closing) throw fail("MANAGED_HOST_CLOSING"); assertAvailable(kind);
      if (kind === "stop") {
        const result = await owned.controller.stopOwned({ operationId, timeoutMs: 60000 });
        if (result?.ownership !== "absent") throw fail("MANAGED_HOST_OWNED_STOP_UNVERIFIED");
        state = "stopped"; return status();
      }
      let candidate = await owned.controller.getCandidate({}); assertAvailable(kind);
      if (closing) throw fail("MANAGED_HOST_CLOSING");
      if (!candidate) candidate = await owned.controller.prepareCandidate({}); assertAvailable(kind);
      if (closing || !candidate || !HASH.test(candidate.candidateId)) throw fail("MANAGED_HOST_CANDIDATE_INVALID");
      state = "activating"; status();
      const activated = await owned.controller.activateCandidate({ candidateId: candidate.candidateId, operationId });
      assertAvailable(kind);
      if (closing || activated?.healthVerified !== true) throw fail("MANAGED_HOST_ENDPOINT_UNVERIFIED");
      state = "running";
      if (!verified()) throw fail("MANAGED_HOST_ENDPOINT_UNVERIFIED");
      await onReady(); assertAvailable(kind);
      if (closing || !verified()) throw fail("MANAGED_HOST_ENDPOINT_UNVERIFIED");
      return status();
    }).catch(async error => {
      state = "needs_verification"; errorCode = publicError(error);
      try { await onUnavailable(); } catch { /* preserve original failure */ }
      return status();
    }).finally(() => { if (busy === task) busy = null; });
    record.promise = task; busy = task; return status();
  }
  async function close({ operationId = "desktop-owned-close", timeoutMs = 60000 } = {}) {
    operation({ operationId }); closing = true; state = "stopping";
    try {
      await onUnavailable();
      if (client) await client.close({ operationId, timeoutMs });
      if (busy) await busy;
      if (client && client.getStatus()?.state !== "closed") throw fail("MANAGED_HOST_OWNED_STOP_UNVERIFIED");
      state = "stopped"; errorCode = null; return status();
    } catch (error) { state = "needs_verification"; errorCode = publicError(error); status(); throw error; }
  }
  return Object.freeze({ getStatus: status, getOperationStatus: operationStatus, isManaged,
    getEndpoint: () => verified() ? client.getEndpoint() : null,
    getExecution: () => isManaged() ? verified() ? client.getExecution() : null : undefined,
    prepare: input => schedule("prepare", input), restart: input => schedule("restart", input), stop: input => schedule("stop", input),
    async waitForOperation(operationId) {
      if (typeof operationId !== "string" || !OP.test(operationId) || !operations.has(operationId)) throw fail("MANAGED_HOST_OPERATION_NOT_FOUND", 404);
      await operations.get(operationId).promise; return operationStatus(operationId);
    }, close,
    async suspend(options = {}) { suspended = true; await close(options); releaseSuspendedClient(); return status(); },
  });
}
module.exports = { createManagedHermesProductHost, projectManagedHermesHostStatus };
