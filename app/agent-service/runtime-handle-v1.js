"use strict";
const crypto = require("node:crypto");
const { runtimeBinding } = require("./runtime-adapter");
const { validateRuntimeContextUsage } = require("./runtime-context-usage");
const { runtimeCapabilityEvidence, capabilitiesFromEvidence, assertRuntimeOperation, assertRuntimeAttachments } = require("./runtime-capability-evidence");
const { serviceError } = require("./security");
const METHODS = Object.freeze({
  sessionStart: "session.start", sessionResume: "session.resume", sessionRead: "session.read", sessionList: "session.list",
  sessionRename: "session.rename", sessionArchive: "session.archive", sessionUnarchive: "session.unarchive", sessionDelete: "session.delete",
  turnStart: "turn.start", turnSteer: "turn.steer", turnInterrupt: "turn.interrupt", modelsList: "models.list",
  commandsList: "commands.list", commandExecute: "commands.execute", accountRead: "account.read",
  accountLogin: "account.login", accountLogout: "account.logout", generateModelOnly: "model.generate.toolFree",
  resolveModelOnly: "model.resolve.toolFree", releaseModelOnlySession: "model.session.release",
});
const EVENT_TYPES = new Set(["text", "text_delta", "reasoning", "reasoning_delta", "plan", "tool_start", "tool_update", "tool_result", "status",
  "complete", "usage", "context_usage", "context_compacted", "error", "warning", "account_backoff", "account_unavailable", "rate_limits"]);
const IDENTITY_FENCED_METHODS = new Set(["sessionStart", "sessionResume", "turnStart", "turnSteer",
  "sessionRename", "sessionArchive", "sessionUnarchive", "sessionDelete", "commandExecute", "commandsList",
  "modelsList", "accountRead", "accountLogin", "accountLogout", "generateModelOnly", "resolveModelOnly"]);
const PREPARATION_READS = new Set(["modelsList", "accountRead"]);
const ACCOUNT_STATE_WRITES = new Set(["accountLogin", "accountLogout", "commandExecute"]);
const fail = (code = "RUNTIME_HANDLE_INVALID") => serviceError(code, "Runtime V1 contract rejected the operation");
function data(value, maxBytes = 8 * 1024 * 1024) {
  let size = 0, nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100_000 || depth > 32) throw fail("RUNTIME_PROTOCOL_INVALID");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") { size += Buffer.byteLength(item); if (!item.isWellFormed() || size > maxBytes) throw fail("RUNTIME_PROTOCOL_INVALID"); return item; }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw fail("RUNTIME_PROTOCOL_INVALID");
    if (Array.isArray(item) && (item.length > 100_000 || Object.keys(item).length !== item.length
      || Object.keys(item).some(key => !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) throw fail("RUNTIME_PROTOCOL_INVALID");
    const output = Array.isArray(item) ? [] : {};
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key === "string") { size += Buffer.byteLength(key); if (size > maxBytes) throw fail("RUNTIME_PROTOCOL_INVALID"); }
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !property.enumerable || !Object.hasOwn(property, "value")) throw fail("RUNTIME_PROTOCOL_INVALID");
      // Legacy native envelopes omit optional undefined values in JSON.
      if (property.value === undefined) continue;
      Object.defineProperty(output, key, { value: visit(property.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return visit(value, 0);
}
const id = value => typeof value === "string" && value.length > 0 && value.length <= 512 && value.isWellFormed() && !value.includes("\0");
function validateResult(method, value, input = {}) {
  let result;
  try { result = data(value ?? null); }
  catch (error) { if (method === "releaseModelOnlySession") throw fail("RUNTIME_STOP_UNCONFIRMED"); throw error; }
  if (["sessionStart", "sessionResume", "sessionRead"].includes(method)) {
    if (!result?.session || !id(result.session.id)
      || (method !== "sessionStart" && input.sessionId && result.session.id !== input.sessionId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  } else if (method === "turnStart" && !id(result?.turn?.id)) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
  else if (method === "sessionList" && !Array.isArray(result?.data ?? result?.sessions)) throw fail("RUNTIME_PROTOCOL_INVALID");
  else if (method === "modelsList" && !Array.isArray(result?.data ?? result?.models)) throw fail("RUNTIME_PROTOCOL_INVALID");
  else if (method === "commandsList" && !Array.isArray(result?.commands)) throw fail("RUNTIME_PROTOCOL_INVALID");
  else if (method === "resolveModelOnly") require("./runtime-model-resolution").validateModelResolution(result);
  else if (method === "releaseModelOnlySession" && (!result || result.released !== true
    || result.sessionId !== input.sessionId || Object.keys(result).length !== 2)) throw fail("RUNTIME_STOP_UNCONFIRMED");
  return result;
}
function validateEvent(value) {
  const event = data(value);
  if (event?.known !== true || !EVENT_TYPES.has(event.type)) return null;
  if (!["warning", "error", "account_backoff", "account_unavailable", "rate_limits"].includes(event.type)
    && !id(event.sessionId ?? event.threadId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.turnId !== undefined && event.turnId !== null && !id(event.turnId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.type === "text" && typeof event.text !== "string") throw fail("RUNTIME_PROTOCOL_INVALID");
  if (["text_delta", "reasoning_delta"].includes(event.type) && typeof event.delta !== "string") throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.type === "reasoning" && event.reasoning !== undefined
    && typeof event.reasoning !== "string" && !Array.isArray(event.reasoning)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (["context_usage", "context_compacted"].includes(event.type)) validateRuntimeContextUsage(event.contextUsage);
  if (event.compactionId !== undefined && (event.type !== "context_compacted" || !id(event.compactionId)
    || event.compaction?.id !== event.compactionId || event.compaction?.status !== "completed")) throw fail("RUNTIME_PROTOCOL_INVALID");
  return Object.freeze(event);
}

// These callbacks belong to the Coordinator, not a remote Runtime. Read only
// own data properties so accessors cannot execute during contract validation.
function localTurnObserver(value, expectedSessionId, expectedOperationId, assertAlive, isCurrentCall) {
  if (value === undefined) return undefined;
  const keys = ["version", "attemptId", "onPrepared", "onDispatchAttempt", "assertCurrent"];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
    }) || value.version !== 1 || !id(value.attemptId)
    || ["onPrepared", "onDispatchAttempt", "assertCurrent"].some(key => typeof value[key] !== "function")) {
    throw fail("RUNTIME_PROTOCOL_INVALID");
  }
  let prepared = null, preparationStarted = false, dispatchAttempted = false;
  const fence = () => {
    assertAlive(); if (!isCurrentCall()) throw fail("RUNTIME_HANDLE_TERMINATED");
    const current = value.assertCurrent();
    if (current && typeof current.then === "function") {
      Promise.resolve(current).catch(() => {}); throw fail("RUNTIME_PROTOCOL_INVALID");
    }
  };
  const receipt = input => {
    const checked = data(input, 8 * 1024);
    if (!checked || Object.keys(checked).sort().join(",") !== "attemptId,fingerprint,operationId,sessionId,turnId"
      || checked.attemptId !== value.attemptId || checked.sessionId !== expectedSessionId
      || checked.operationId !== expectedOperationId || !id(checked.turnId)
      || !/^[a-f0-9]{64}$/u.test(checked.fingerprint)) throw fail("RUNTIME_PROTOCOL_INVALID");
    return Object.freeze(checked);
  };
  return Object.freeze({ version: 1, attemptId: value.attemptId, assertCurrent: fence,
    async onPrepared(input) {
      fence(); const checked = receipt(input);
      if (preparationStarted || dispatchAttempted) throw fail("RUNTIME_PROTOCOL_INVALID");
      preparationStarted = true;
      await value.onPrepared(checked); fence();
      prepared = checked;
    },
    onDispatchAttempt(input) {
      fence(); const checked = receipt(input);
      if (!prepared || dispatchAttempted || Object.keys(checked).some(key => checked[key] !== prepared[key])) {
        throw fail("RUNTIME_PROTOCOL_INVALID");
      }
      const result = value.onDispatchAttempt(checked);
      if (result && typeof result.then === "function") throw fail("RUNTIME_PROTOCOL_INVALID");
      fence(); dispatchAttempted = true;
    },
  });
}

// One facade per pooled transport. It owns no run authority; the Coordinator's
// per-attempt leases still fence every execution and host capability call.
function runtimeHandleV1(raw, expectedBinding, { onViolation = () => {}, onCapabilityDifference = () => {} } = {}) {
  const binding = runtimeBinding(expectedBinding);
  if (!raw || ["runtime", "runtimeProfileId", "runtimeAccountId"].some(key => raw[key] !== binding[key])
    || typeof raw.subscribe !== "function" || !raw.terminated || typeof raw.terminated.then !== "function") throw fail();
  const capabilityEvidence = runtimeCapabilityEvidence(raw, binding, crypto.randomUUID());
  const capabilities = capabilitiesFromEvidence(capabilityEvidence);
  for (const [name, supported] of Object.entries(raw.capabilities || {})) {
    if (supported !== capabilities[name]) onCapabilityDifference({ runtime: binding.runtime, capability: name,
      previous: supported, current: capabilities[name] });
  }
  const nativeMethod = method => method === "accountLogin" && !raw.accountLogin ? "accountLoginStart" : method;
  for (const [method, capability] of Object.entries(METHODS)) if (capabilities[capability] && typeof raw[nativeMethod(method)] !== "function") throw fail();
  if (capabilities.serverRequests && typeof raw.registerServerRequestHandler !== "function") throw fail();
  const home = raw.host?.home ?? raw.host?.runtimeEnvironment?.userHome ?? raw.homeIdentity ?? null;
  if (home !== null && typeof home !== "string") throw fail();
  const identity = Object.freeze({ ...binding, homeIdentity: crypto.createHash("sha256")
    .update(JSON.stringify([binding.runtime, binding.runtimeAccountId, home])).digest("hex") });
  let alive = true, terminatedCleanly = false;
  const cleanups = new Set(), observations = new Map(), pendingReads = new Map();
  let readEpoch = 0;
  const assertAlive = () => { if (!alive) throw fail("RUNTIME_HANDLE_TERMINATED"); };
  const invalidateReads = () => { readEpoch += 1; pendingReads.clear(); };
  // Only overlapping, identical read-only probes of this exact transport may
  // share work. Every caller validates its own result; nothing stays cached.
  const preparationRead = async (method, input, load, share = true) => {
    const key = share ? JSON.stringify([method, input], (_name, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value) : null;
    const canShare = key !== null && key.length <= 8192 && (pendingReads.size < 32 || pendingReads.has(key));
    const epoch = readEpoch;
    let pending = canShare ? pendingReads.get(key) : load();
    if (canShare && !pending) {
      pending = Promise.resolve().then(() => {
        assertAlive();
        if (epoch !== readEpoch) throw fail(method === "modelsList" ? "RUNTIME_MODEL_CATALOG_CHANGED" : "RUNTIME_AUTH_STATUS_UNAVAILABLE");
        return load();
      });
      pendingReads.set(key, pending);
      pending.finally(() => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }).catch(() => {});
    }
    const result = await pending;
    assertAlive(); raw.host?.assertRuntimeIdentityCurrent?.();
    if (epoch !== readEpoch) throw fail(method === "modelsList" ? "RUNTIME_MODEL_CATALOG_CHANGED" : "RUNTIME_AUTH_STATUS_UNAVAILABLE");
    return result;
  };
  const finish = () => { alive = false; invalidateReads(); for (const unsubscribe of cleanups) { try { unsubscribe(); } catch {} } cleanups.clear(); observations.clear(); };
  const terminated = Promise.resolve(raw.terminated).then(value => { terminatedCleanly = true; finish(); return value; }, error => { finish(); throw error; });
  terminated.catch(() => {});
  const facade = { kind: "shoggoth-runtime-handle", version: 1, ...binding, identity, capabilities, capabilityEvidence, terminated,
    host: raw.host, workspace: raw.workspace, controlInstance: raw.controlInstance === true,
    get registeredSecrets() { return raw.registeredSecrets || []; },
    assertExecutionProviderCurrent() { assertAlive(); raw.assertExecutionProviderCurrent?.(); },
    // Service-owned managed tools can wait for a user or run a bounded command.
    // Suspend only this native turn's outer deadline; this grants no tool access
    // and does not change cancellation or the managed command's own deadline.
    pauseManagedToolTimeout(input) {
      assertAlive(); const checked = data(input);
      if (!checked || Object.keys(checked).sort().join(",") !== "sessionId,turnId"
        || !id(checked.sessionId) || !id(checked.turnId)) throw fail("RUNTIME_PROTOCOL_INVALID");
      const target = typeof raw.pauseManagedToolTimeout === "function" ? raw : raw.host;
      const release = typeof target?.pauseManagedToolTimeout === "function"
        ? target.pauseManagedToolTimeout(checked) : () => {};
      if (typeof release !== "function") throw fail("RUNTIME_PROTOCOL_INVALID");
      let released = false;
      return () => { if (!released) { released = true; release(); } };
    },
    async authenticationState(input) { assertAlive(); raw.host?.assertRuntimeIdentityCurrent?.();
      if (typeof raw.authenticationState !== "function") throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      const checked = data(input || {});
      const result = await preparationRead("authenticationState", checked, () => raw.authenticationState(checked));
      assertAlive(); return data(result); },
    subscribe(listener) {
      assertAlive();
      const unsubscribe = raw.subscribe(value => {
        if (!alive) return;
        let event;
        try {
          event = validateEvent(value); if (!event) return;
        } catch (error) {
          onViolation({ runtime: binding.runtime, code: error.code || "RUNTIME_PROTOCOL_INVALID",
            type: Object.getOwnPropertyDescriptor(value || {}, "type")?.value });
          // A broken event stream cannot prove execution completion. Retire it;
          // the coordinator records unknown acceptance instead of replaying.
          void Promise.resolve().then(() => raw.stop ? raw.stop() : raw.host?.stop?.()).catch(() => {});
          return;
        }
        if (event.contextUsage) { observations.set(event.sessionId ?? event.threadId, event.contextUsage);
          while (observations.size > 512) observations.delete(observations.keys().next().value); }
        listener(event);
      });
      const dispose = typeof unsubscribe === "function" ? unsubscribe : () => unsubscribe?.unsubscribe?.();
      cleanups.add(dispose); return () => { cleanups.delete(dispose); dispose(); };
    },
    registerServerRequestHandler(method, handler) {
      assertAlive(); if (!capabilities.serverRequests) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      const remove = raw.registerServerRequestHandler(method, async (params, context) => {
        assertAlive(); const result = await handler(data(params), context); assertAlive(); return result;
      });
      cleanups.add(remove); return () => { cleanups.delete(remove); remove(); };
    },
    subscribeAccountAuth(listener) {
      assertAlive(); if (typeof raw.subscribeAccountAuth !== "function") return () => {};
      const remove = raw.subscribeAccountAuth(value => { if (alive) listener(data(value)); });
      cleanups.add(remove); return () => { cleanups.delete(remove); remove(); };
    },
    async contextUsage({ sessionId }) { assertAlive(); if (!id(sessionId)) throw fail("RUNTIME_PROTOCOL_INVALID");
      return observations.get(sessionId) || null; },
    async compact({ sessionId, cwd }) { assertAlive(); if (!capabilities["context.compact.native"]) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      return facade.commandExecute({ text: "/compact", sessionId, cwd }); },
    async stop() { if (!alive) return; if (typeof raw.host?.stop !== "function" && typeof raw.stop !== "function") throw fail("RUNTIME_STOP_UNCONFIRMED");
      await (raw.stop ? raw.stop() : raw.host.stop()); finish(); },
  };
  const recordSessionHandleFailure = (method, input, phase, error) => {
    if (binding.runtime !== "codex" || !["sessionStart", "sessionResume"].includes(method)) return;
    try {
      require("./codex-session-diagnostics").recordCodexSessionFailure({
        paths: raw.host?.paths, binding, phase, error,
        operationName: method === "sessionStart" ? "threadStart" : "threadResume",
        params: { threadId: input?.sessionId, developerInstructions: input?.developerInstructions },
      });
    } catch { /* Diagnostics cannot replace a V1 contract failure. */ }
  };
  for (const [method, capability] of Object.entries(METHODS)) {
    if (!capabilities[capability]) continue;
    facade[method] = async (input, turnObserver) => {
    assertAlive(); if (!capabilities[capability]) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    const operation = method === "sessionResume" ? "resume" : method === "generateModelOnly" ? "modelOnly"
      : method === "resolveModelOnly" ? "modelResolve" : method === "commandExecute" && input?.text?.trim() === "/compact"
        ? "compact" : null;
    if (operation) assertRuntimeOperation(facade, operation);
    if (IDENTITY_FENCED_METHODS.has(method)) raw.host?.assertRuntimeIdentityCurrent?.();
    // Model-only observers and dispatch fences stay local to this call; they
    // must never be serialized into a Runtime or provider RPC.
    const { signal, onText, assertCurrent, ...payload } = input || {};
    if (onText !== undefined && (method !== "generateModelOnly" || typeof onText !== "function")) throw fail("RUNTIME_PROTOCOL_INVALID");
    if (assertCurrent !== undefined && (method !== "generateModelOnly" || typeof assertCurrent !== "function")) throw fail("RUNTIME_PROTOCOL_INVALID");
    let checked;
    try { checked = data(payload); }
    catch (error) { recordSessionHandleFailure(method, payload, "handle_request", error); throw error; }
    if (turnObserver !== undefined && (method !== "turnStart" || !capabilities["turn.start.prepare"])) {
      throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    let observing = true;
    const preparedObserver = method === "turnStart"
      ? localTurnObserver(turnObserver, checked.sessionId, checked.operationId, assertAlive, () => observing) : undefined;
    if (method === "turnStart") assertRuntimeAttachments(facade, checked.attachments);
    if (method === "releaseModelOnlySession" && (Object.keys(checked).length !== 1 || !id(checked.sessionId))) {
      throw fail("RUNTIME_PROTOCOL_INVALID");
    }
    if (method === "resolveModelOnly" && checked.model !== undefined && !capabilities["model.resolve.explicit"]) {
      throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    }
    const fence = assertCurrent && (() => {
      assertAlive();
      if (!observing || signal?.aborted) throw fail("MODEL_ONLY_CANCELED");
      assertCurrent();
    });
    const observer = onText && (text => {
      if (!observing || !alive || signal?.aborted) return;
      if (typeof text !== "string") throw fail("RUNTIME_PROTOCOL_INVALID");
      onText(data(text, 64 * 1024));
    });
    try {
      if (ACCOUNT_STATE_WRITES.has(method)) invalidateReads();
      const invoke = () => raw[nativeMethod(method)]({ ...checked, ...(signal ? { signal } : {}),
        ...(observer ? { onText: observer } : {}), ...(fence ? { assertCurrent: fence } : {}) }, preparedObserver);
      const result = await (PREPARATION_READS.has(method)
        ? preparationRead(method, checked, invoke, !signal && checked.refreshToken !== true) : invoke());
      try {
        // Dedicated ACP model workers return only after their process group
        // has stopped. Accept that one completed result, never a later call
        // or a result from cancellation/failed cleanup. This is a trusted
        // adapter contract, not a remotely advertised Runtime capability.
        const ownedModelStop = method === "generateModelOnly" && raw.modelOnlyStopsHost === true
          && raw.host?.modelOnlyInstance === true && raw.host.state === "stopped" && terminatedCleanly;
        if (!ownedModelStop) assertAlive();
        if (method === "generateModelOnly" && signal?.aborted) throw fail("MODEL_ONLY_CANCELED");
        return validateResult(method, result, checked);
      }
      catch (error) {
        if (method === "releaseModelOnlySession") throw fail("RUNTIME_STOP_UNCONFIRMED");
        recordSessionHandleFailure(method, checked, "handle_response", error); throw error;
      }
    } finally { observing = false; }
  };
  }
  if (facade.accountLogin) facade.accountLoginStart = facade.accountLogin;
  for (const method of ["accountLoginApiKey", "accountLoginCancel"]) if (capabilities["account.login"] && typeof raw[method] === "function") {
    facade[method] = async input => { assertAlive(); if (method !== "accountLoginCancel") raw.host?.assertRuntimeIdentityCurrent?.();
      const checked = data(input); invalidateReads();
      const result = await raw[method](checked); assertAlive(); return data(result); };
  }
  // Settings sign-in into model providers (OpenCode); a waiting callback keeps its abort signal.
  for (const method of ["providerLoginOptions", "providerLoginAuthorize", "providerLoginCallback", "providerLoginApiKey"]) if (typeof raw[method] === "function") {
    facade[method] = async input => { assertAlive(); raw.host?.assertRuntimeIdentityCurrent?.(); const { signal, ...payload } = input || {};
      const checked = data(payload);
      if (method !== "providerLoginOptions") invalidateReads();
      const result = await raw[method]({ ...checked, ...(signal ? { signal } : {}) }); assertAlive(); return data(result ?? null); };
  }
  return Object.freeze(facade);
}
module.exports = { runtimeHandleV1, validateRuntimeHandleResult: validateResult, validateRuntimeEvent: validateEvent, runtimeData: data, RUNTIME_V1_METHODS: METHODS };
