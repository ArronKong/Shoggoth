"use strict";


const crypto = require("node:crypto");
const path = require("node:path");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const { DEFAULT_AGENT_PROFILE_ID } = require("./product-store");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { runtimeBinding } = require("./runtime-adapter");
const { serviceError } = require("./security");
const {
  PUBLIC_MESSAGES,
  mapAgentLifecycleError,
  validateAgentLifecycleParams,
  validateAgentLifecycleResult,
} = require("./agent-lifecycle-service-protocol");

const MAX_OPERATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const NON_TERMINAL_RUN_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
]);
const BACKEND_BINDINGS = Object.freeze({ shoggoth: Object.freeze({ runtime: "codex" }) });
const PROTECTED_PROFILE_IDS = new Set([
  DEFAULT_AGENT_PROFILE_ID,
  ...BUILTIN_CLI_AGENT_PROFILES.map((profile) => profile.id),
]);
const RETRYABLE_CODES = new Set([
  "AGENT_RETENTION_FAILED",
  "AGENT_INITIALIZATION_FAILED", "AGENT_RUNTIME_CLEANUP_FAILED", "AGENT_COMMIT_UNCERTAIN",
  "AGENT_PLUGIN_REVOKE_FAILED",
  "AGENT_SERVICE_CLOSED",
]);

function lifecycleError(code, message = PUBLIC_MESSAGES[code]) {
  return serviceError(code, message || PUBLIC_MESSAGES.INTERNAL_ERROR);
}

function dataErrorCode(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "string" ? descriptor.value : null;
  } catch {
    return null;
  }
}

function requireMethods(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw lifecycleError("AGENT_SERVICE_CLOSED", `${label} dependency is invalid`);
  }
}

function stableUuid(namespace, value) {
  const bytes = crypto.createHash("sha256")
    .update(namespace, "utf8").update("\0", "utf8").update(value, "utf8")
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSnapshot(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizedName(value) {
  const name = value.normalize("NFKC").trim();
  if (!name || Buffer.byteLength(name, "utf8") > 128) throw lifecycleError("INVALID_PARAMS");
  return name;
}

function nameKey(value) {
  return normalizedName(value).toLocaleLowerCase("und");
}

function normalizedWorkspace(value) {
  if (value === null) return null;
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw lifecycleError("INVALID_PARAMS");
  return value;
}

function createIdentity(params) {
  const binding = BACKEND_BINDINGS[params.backendId];
  if (!binding || !require("../runtime-availability").isRuntimeAvailable(binding.runtime)) {
    throw lifecycleError("AGENT_BACKEND_NOT_SUPPORTED");
  }
  const id = stableUuid("shoggoth-agent-profile-v2", params.operationId);
  const agentId = `shoggoth-agent-${id}`;
  return Object.freeze({
    id,
    agentId,
    runtime: binding.runtime,
    runtimeProfileId: `${agentId}-runtime-v1`,
  });
}

function canonicalParams(method, rawParams) {
  const params = validateAgentLifecycleParams(method, rawParams);
  if (method === "agent.lifecycle.list") return params;
  if (method === "agent.create") {
    return {
      ...params,
      name: normalizedName(params.name),
      defaultCwd: normalizedWorkspace(params.defaultCwd),
    };
  }
  if (method === "agent.update") {
    return {
      ...params,
      name: normalizedName(params.name),
      defaultCwd: normalizedWorkspace(params.defaultCwd),
    };
  }
  return params;
}

function operationIdentity(method, params) {
  const fingerprint = crypto.createHash("sha256")
    .update(stableJson({ method, ...params }), "utf8").digest("hex");
  return {
    callId: stableUuid("shoggoth-agent-lifecycle-call-v1", params.operationId),
    fingerprint,
  };
}

function durableBinding(method, params) {
  if (method === "agent.create") {
    const identity = createIdentity(params);
    return {
      method,
      operationId: params.operationId,
      targetProfileId: identity.id,
      backendId: params.backendId,
      name: params.name,
      defaultCwd: params.defaultCwd,
      expectedUpdatedAt: null,
      createdAt: params.createdAt,
      identity,
      ...(params.initialIdentity !== undefined ? { initialIdentity: params.initialIdentity } : {}),
    };
  }
  return {
    method,
    operationId: params.operationId,
    targetProfileId: params.profileId,
    backendId: null,
    name: method === "agent.update" ? params.name : null,
    defaultCwd: method === "agent.update" ? params.defaultCwd : null,
    expectedUpdatedAt: params.expectedUpdatedAt,
    createdAt: params.createdAt,
    identity: null,
  };
}

function validateDurableBinding(method, value) {
  const fields = [
    "method", "operationId", "targetProfileId", "backendId", "name", "defaultCwd",
    "expectedUpdatedAt", "createdAt", "identity",
  ];
  if (method === "agent.create" && value && Object.hasOwn(value, "initialIdentity")) fields.push("initialIdentity");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || value.method !== method) throw lifecycleError("AGENT_COMMIT_UNCERTAIN");
  return structuredClone(value);
}

function createAgentLifecycleServiceController(options = {}) {
  requireMethods(options.productStore, [
    "listAgentProfiles", "getAgentProfile", "putAgentProfile", "listWorkRuns",
    "listMcpToolCalls", "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall",
  ], "ProductStore");
  requireMethods(options.runtimeManager, ["stop"], "RuntimeManager");
  if (typeof options.initializeProfile !== "function"
    || typeof options.activateProfile !== "function"
    || (options.onProfileChanged !== undefined && typeof options.onProfileChanged !== "function")
    || (options.revokePluginProfile !== undefined
      && typeof options.revokePluginProfile !== "function")) {
    throw lifecycleError("AGENT_SERVICE_CLOSED", "Profile lifecycle callbacks are invalid");
  }
  const productStore = options.productStore;
  const now = options.now || Date.now;
  let state = "closed";
  let generation = 0;
  let tail = Promise.resolve();
  let poisonError = null;
  const inFlight = new Map();

  function assertOpen(expectedGeneration = generation) {
    if (poisonError) throw poisonError;
    if (state !== "open" || expectedGeneration !== generation) {
      throw lifecycleError("AGENT_SERVICE_CLOSED");
    }
  }

  function poison(error) {
    if (!poisonError) {
      poisonError = lifecycleError("AGENT_COMMIT_UNCERTAIN");
      poisonError.cause = error;
    }
    return poisonError;
  }

  function assertTimestamp(createdAt) {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0
      || createdAt < timestamp - MAX_OPERATION_AGE_MS
      || createdAt > timestamp + MAX_FUTURE_SKEW_MS) {
      throw lifecycleError("AGENT_OPERATION_EXPIRED");
    }
  }


  function loadProfile(profileId) {
    const profile = productStore.getAgentProfile(profileId);
    if (!profile) throw lifecycleError("AGENT_NOT_FOUND");
    if (!BACKEND_BINDINGS[profile.backendId]) throw lifecycleError("AGENT_BACKEND_NOT_SUPPORTED");
    try {
      runtimeBinding({
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      });
    } catch {
      throw lifecycleError("AGENT_PROFILE_CONFLICT");
    }
    return profile;
  }

  function assertCas(profile, expectedUpdatedAt) {
    if (profile.updatedAt !== expectedUpdatedAt) throw lifecycleError("AGENT_PROFILE_CONFLICT");
  }

  function assertNoOtherPending(profileId, callId) {
    const conflict = productStore.listMcpToolCalls().find((call) => call.status === "pending"
      && typeof call.name === "string" && call.name.startsWith("agent.")
      && call.callId !== callId && call.binding?.targetProfileId === profileId);
    if (conflict) throw lifecycleError("AGENT_OPERATION_BUSY");
  }

  function putProfile(input) {
    try { return productStore.putAgentProfile(input); }
    catch (error) {
      const code = dataErrorCode(error);
      if (code === "STORE_COMMIT_UNCERTAIN" || code?.endsWith("COMMIT_UNCERTAIN")) throw poison(error);
      if (code === "AGENT_PROFILE_IDENTITY_CONFLICT") throw lifecycleError("AGENT_PROFILE_CONFLICT");
      throw error;
    }
  }

  function revokePluginProfile(profileId) {
    if (!options.revokePluginProfile) return;
    try {
      const result = options.revokePluginProfile(profileId);
      if (result && typeof result.then === "function") {
        throw new TypeError("plugin revocation must complete synchronously");
      }
    } catch {
      throw lifecycleError("AGENT_PLUGIN_REVOKE_FAILED");
    }
  }

  async function initialize(profile, expectedGeneration, initialIdentity) {
    assertOpen(expectedGeneration);
    try { await options.initializeProfile(structuredClone(profile), { initialIdentity }); }
    catch (error) {
      throw lifecycleError("AGENT_INITIALIZATION_FAILED", error?.message);
    }
    assertOpen(expectedGeneration);
  }

  async function activate(profile, expectedGeneration) {
    assertOpen(expectedGeneration);
    try { await options.activateProfile(structuredClone(profile)); }
    catch (error) {
      throw lifecycleError("AGENT_INITIALIZATION_FAILED", error?.message);
    }
    assertOpen(expectedGeneration);
  }

  async function create(binding, expectedGeneration) {
    const { identity } = binding;
    let profile = productStore.getAgentProfile(identity.id);
    if (!profile) {
      profile = putProfile({
        id: identity.id,
        backendId: binding.backendId,
        agentId: identity.agentId,
        name: binding.name,
        runtime: identity.runtime,
        runtimeProfileId: identity.runtimeProfileId,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        providerRef: null,
        defaultModel: null,
        defaultCwd: binding.defaultCwd,
        permissionPolicy: {
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
        },
        concurrency: { maxActive: null, maxWorkspaceWrites: null },
        isDefault: false,
        enabled: false,
        createdAt: binding.createdAt,
        updatedAt: binding.createdAt,
      });
    } else if (profile.backendId !== binding.backendId || profile.agentId !== identity.agentId
      || profile.runtime !== identity.runtime || profile.runtimeProfileId !== identity.runtimeProfileId
      || profile.name !== binding.name || profile.defaultCwd !== binding.defaultCwd
      || profile.isDefault !== false) {
      throw lifecycleError("AGENT_OPERATION_CONFLICT");
    }
    await initialize(profile, expectedGeneration, binding.initialIdentity);
    await activate(profile, expectedGeneration);
    profile = loadProfile(identity.id);
    if (!profile.enabled) profile = putProfile({ ...profile, enabled: true });
    return validateAgentLifecycleResult("agent.create", { profile });
  }

  async function update(binding) {
    const profile = loadProfile(binding.targetProfileId);
    if (profile.name === binding.name && profile.defaultCwd === binding.defaultCwd
      && profile.updatedAt !== binding.expectedUpdatedAt) {
      return validateAgentLifecycleResult("agent.update", { profile });
    }
    assertCas(profile, binding.expectedUpdatedAt);
    const saved = putProfile({ ...profile, name: binding.name, defaultCwd: binding.defaultCwd });
    return validateAgentLifecycleResult("agent.update", { profile: saved });
  }

  async function archive(binding, expectedGeneration) {
    let profile = loadProfile(binding.targetProfileId);
    if (PROTECTED_PROFILE_IDS.has(profile.id) || profile.isDefault) throw lifecycleError("AGENT_PROTECTED");
    if (profile.enabled) {
      assertCas(profile, binding.expectedUpdatedAt);
      if (productStore.listWorkRuns({ profileId: profile.id })
        .some((run) => NON_TERMINAL_RUN_STATUSES.has(run.status))) {
        throw lifecycleError("AGENT_ACTIVE_RUNS");
      }
      // Revoke in the plugin Store before publishing disabled Product state.
      // A failed plugin transaction must not leave a frozen dispatch ticket
      // authorized while the UI reports this Profile as archived.
      revokePluginProfile(profile.id);
      // No await between the final run check and disabled commit. ProductStore
      // independently rejects new WorkRuns for disabled Profiles.
      profile = putProfile({ ...profile, enabled: false });
    } else {
      // Repair a disabled Profile left by an older interrupted archive.
      revokePluginProfile(profile.id);
    }
    options.archiveRetention?.recordArchive(profile);
    assertOpen(expectedGeneration);
    try {
      for (const view of require("./agent-runtime-profile-views").agentRuntimeProfileViews(productStore, profile.id)) {
        await options.runtimeManager.stop(runtimeBinding({ runtime: view.runtime,
          runtimeProfileId: view.runtimeProfileId, runtimeAccountId: view.runtimeAccountId }));
      }
    } catch (error) {
      throw lifecycleError("AGENT_RUNTIME_CLEANUP_FAILED", error?.message);
    }
    assertOpen(expectedGeneration);
    return validateAgentLifecycleResult("agent.archive", { profile });
  }

  async function restore(binding, expectedGeneration) {
    let profile = loadProfile(binding.targetProfileId);
    options.archiveRetention?.assertRestorable(profile.id);
    if (!require("../runtime-availability").isRuntimeAvailable(profile.runtime)) {
      throw lifecycleError("AGENT_BACKEND_NOT_SUPPORTED");
    }
    if (profile.enabled) {
      await activate(profile, expectedGeneration);
      options.archiveRetention?.cancel(profile.id);
      return validateAgentLifecycleResult("agent.restore", { profile });
    }
    assertCas(profile, binding.expectedUpdatedAt);
    // An interrupted archive may have disabled ProductStore before revoking
    // plugin authority. Never restore the Profile before fencing those Grants.
    revokePluginProfile(profile.id);
    await initialize(profile, expectedGeneration);
    await activate(profile, expectedGeneration);
    profile = loadProfile(profile.id);
    if (!profile.enabled) profile = putProfile({ ...profile, enabled: true });
    options.archiveRetention?.cancel(profile.id);
    return validateAgentLifecycleResult("agent.restore", { profile });
  }

  function replayOutcome(method, outcome) {
    if (outcome && Object.getPrototypeOf(outcome) === Object.prototype
      && Object.keys(outcome).length === 2 && outcome.ok === true && Object.hasOwn(outcome, "result")) {
      return validateAgentLifecycleResult(method, outcome.result);
    }
    if (outcome && Object.getPrototypeOf(outcome) === Object.prototype
      && Object.keys(outcome).length === 2 && outcome.ok === false
      && Object.hasOwn(PUBLIC_MESSAGES, outcome.publicCode)) {
      throw lifecycleError(outcome.publicCode);
    }
    throw poison(lifecycleError("AGENT_RESPONSE_INVALID"));
  }

  function route(method, binding, expectedGeneration) {
    if (method === "agent.create") return create(binding, expectedGeneration);
    if (method === "agent.update") return update(binding, expectedGeneration);
    if (method === "agent.archive") return archive(binding, expectedGeneration);
    if (method === "agent.restore") return restore(binding, expectedGeneration);
    throw lifecycleError("INVALID_PARAMS");
  }

  function complete(durable, outcome) {
    try { return productStore.completeMcpToolCall({ id: durable.id, outcome }); }
    catch (error) { throw poison(error); }
  }

  function executeDurable(durable) {
    const active = inFlight.get(durable.callId);
    if (active) return active.then(structuredClone);
    const expectedGeneration = generation;
    let operation;
    operation = tail.then(async () => {
      assertOpen(expectedGeneration);
      let binding;
      try { binding = validateDurableBinding(durable.name, durable.binding); }
      catch (error) { throw poison(error); }
      assertNoOtherPending(binding.targetProfileId, durable.callId);
      try {
        const result = await route(durable.name, binding, expectedGeneration);
        const saved = complete(durable, { ok: true, result });
        return replayOutcome(durable.name, saved.result);
      } catch (error) {
        const code = dataErrorCode(error);
        if (poisonError || RETRYABLE_CODES.has(code) || code === "STORE_COMMIT_UNCERTAIN") {
          throw poisonError || error;
        }
        const mapped = mapAgentLifecycleError(error);
        const saved = complete(durable, { ok: false, publicCode: mapped.code });
        return replayOutcome(durable.name, saved.result);
      } finally {
        // Publish after the durable outcome, including a partially completed
        // archive. Observers cannot invalidate a committed lifecycle operation.
        try {
          const profile = productStore.getAgentProfile(binding.targetProfileId);
          if (profile) options.onProfileChanged?.({ profileId: profile.id, backendId: profile.backendId });
        } catch {}
      }
    }).finally(() => {
      inFlight.delete(durable.callId);
    });
    inFlight.set(durable.callId, operation);
    tail = operation.catch(() => {});
    return operation.then(structuredClone);
  }

  function lifecycleList(params) {
    assertOpen();
    const pending = new Map();
    for (const call of productStore.listMcpToolCalls()) {
      if (call.status !== "pending" || typeof call.name !== "string"
        || !call.name.startsWith("agent.") || typeof call.binding?.targetProfileId !== "string") continue;
      pending.set(call.binding.targetProfileId, call);
    }
    const agents = productStore.listAgentProfiles()
      .filter((profile) => profile.backendId === params.backendId)
      .map((profile) => {
        const call = pending.get(profile.id) || null;
        let lifecycleState = profile.enabled ? "active" : "archived";
        if (call?.name === "agent.create") lifecycleState = "provisioning";
        else if (call?.name === "agent.update") lifecycleState = "updating";
        else if (call?.name === "agent.restore") lifecycleState = "restoring";
        else if (call?.name === "agent.archive") {
          lifecycleState = profile.enabled ? "archiving" : "archive-repair";
        }
        return {
          profile,
          state: lifecycleState,
          pendingOperationId: call?.binding?.operationId || null,
        };
      });
    return validateAgentLifecycleResult("agent.lifecycle.list", { agents });
  }

  function prepareDurable(method, params) {
    assertTimestamp(params.createdAt);
    const identity = operationIdentity(method, params);
    const binding = durableBinding(method, params);
    if (method !== "agent.create") loadProfile(binding.targetProfileId);
    // Every lifecycle operation uses the same durable owner so operationId is
    // globally single-use across create/update/archive/restore.
    const ownerProfileId = DEFAULT_AGENT_PROFILE_ID;
    const lookup = {
      profileId: ownerProfileId,
      callId: identity.callId,
      name: method,
      fingerprint: identity.fingerprint,
    };
    let durable;
    try { durable = productStore.lookupMcpToolCall(lookup); }
    catch (error) {
      if (dataErrorCode(error) === "MCP_TOOL_CALL_CONFLICT") {
        throw lifecycleError("AGENT_OPERATION_CONFLICT");
      }
      throw error;
    }
    if (durable) return durable;
    assertNoOtherPending(binding.targetProfileId, identity.callId);
    try {
      return productStore.beginMcpToolCall({
        ...lookup,
        binding,
        createdAt: params.createdAt,
      });
    } catch (error) {
      const code = dataErrorCode(error);
      if (code === "MCP_TOOL_CALL_CONFLICT") throw lifecycleError("AGENT_OPERATION_CONFLICT");
      if (code === "STORE_COMMIT_UNCERTAIN" || code?.endsWith("COMMIT_UNCERTAIN")) throw poison(error);
      throw error;
    }
  }

  const controller = {
    runMaintenance(action) {
      const expectedGeneration = generation;
      const operation = tail.then(() => { assertOpen(expectedGeneration); return action(); });
      tail = operation.catch(() => {});
      return operation;
    },
    open() {
      if (state === "open") return controller;
      if (poisonError) throw poisonError;
      generation += 1;
      state = "open";
      for (const durable of productStore.listMcpToolCalls()) {
        if (durable.status === "pending" && typeof durable.name === "string"
          && durable.name.startsWith("agent.")) {
          void executeDurable(durable).catch(() => {});
        }
      }
      return controller;
    },

    close() {
      if (state === "closed") return tail;
      generation += 1;
      state = "closed";
      return tail;
    },

    handle(method, rawParams) {
      let params;
      try {
        params = canonicalParams(method, rawParams);
        assertOpen();
        if (method === "agent.lifecycle.list") return Promise.resolve(lifecycleList(params));
        const durable = prepareDurable(method, params);
        if (durable.status === "completed") {
          return Promise.resolve(structuredClone(replayOutcome(method, durable.result)));
        }
        if (!sameSnapshot(durable.binding, durableBinding(method, params))) {
          throw lifecycleError("AGENT_OPERATION_CONFLICT");
        }
        return executeDurable(durable);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return controller;
}

module.exports = {
  BACKEND_BINDINGS,
  MAX_OPERATION_AGE_MS,
  createAgentLifecycleServiceController,
  stableUuid,
};
