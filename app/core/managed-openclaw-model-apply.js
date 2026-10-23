"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { createOpenClawModelChange } = require("./openclaw-model-change");
const { modelChangeRequestDigest } = require("./model-change-validation");
const { externalProviderOperationScope } = require("../agent-service/external-provider-credential-controller");
const credentialEffect = require("../managed-openclaw-provider-credential-policy");
const { nativeAuthProviderScope } = require("../managed-openclaw-auth-profile-scope");

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PROJECTED_REVISION = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/;
const READ_METHODS = new Set(["config.get", "models.list", "sessions.list", "cron.list", "cron.get", "tasks.list"]);
const WRITE_METHODS = new Set(["config.patch", "config.set", "models.authSetApiKey", "models.authLogout", "sessions.patch", "cron.update", "references.lease.acquire", "references.lease.renew", "references.lease.release"]);
const CONFIG_WRITES = new Set(["config.patch", "config.set", "models.authSetApiKey", "models.authLogout", "sessions.patch", "cron.update"]);
const REQUIRED_LEASE_METHODS = ["modelRpc", "assertIdle", "renew", "restartPaused", "waitHealthy", "verifyTarget", "convergeAfterRetire", "finish", "abandon"];
const SAFE_FIELDS = new Set(["kind", "providerMode", "providerKey", "sourceModelId", "sourceKey", "targetKey", "target", "baseUrl", "api", "model", "patch", "agentId", "credentialScope", "baseHash"]);
const MODEL_FIELDS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoning", "advanced"]);
const PATCH_FIELDS = new Set(["baseUrl", "api", "clearBaseUrl", "clearApiKey", "renameTo", "modelIds", "items", "advanced"]);
const KINDS = new Set(["create", "update", "rename", "delete-model", "delete-provider", "update-provider", "save-provider", "batch"]);

class ManagedModelApplyError extends Error {
  constructor(code, stage = "runtime-apply") {
    super("受管模型事务无法安全继续");
    this.name = "ManagedModelApplyError";
    this.code = code;
    this.stage = stage;
    this.status = 409;
  }
}

function fail(code) { throw new ManagedModelApplyError(code); }

/** Capture data before any await. Preserve undefined own keys used by the coordinator digest. */
function captureData(value, limits = { nodes: 12000, bytes: 2 * 1024 * 1024 }, depth = 0) {
  if (--limits.nodes < 0 || depth > 24) fail("managed_model_data_limit");
  if (value === undefined || value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("managed_model_invalid_data"); return value; }
  if (typeof value === "string") {
    limits.bytes -= Buffer.byteLength(value);
    if (limits.bytes < 0) fail("managed_model_data_limit");
    return value;
  }
  if (typeof value !== "object") fail("managed_model_invalid_data");
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail("managed_model_invalid_data");
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) fail("managed_model_invalid_data");
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !Object.hasOwn(desc, "value") || desc.enumerable !== true) fail("managed_model_invalid_data");
    limits.bytes -= Buffer.byteLength(key);
    if (limits.bytes < 0) fail("managed_model_data_limit");
    result[key] = captureData(desc.value, limits, depth + 1);
  }
  return Object.freeze(result);
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) fail("managed_model_invalid_spec");
}

function captureSpec(raw) {
  const spec = captureData(raw);
  exactKeys(spec, SAFE_FIELDS);
  if (!KINDS.has(spec.kind) || typeof spec.providerKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.providerKey)) fail("managed_model_invalid_spec");
  if (spec.model !== undefined) {
    exactKeys(spec.model, MODEL_FIELDS);
    if (typeof spec.model.id !== "string" || !spec.model.id || spec.model.id.length > 512) fail("managed_model_invalid_spec");
  }
  if (spec.patch !== undefined) exactKeys(spec.patch, PATCH_FIELDS);
  if (spec.credentialScope !== undefined && (spec.credentialScope !== "provider" || spec.agentId !== undefined)) fail("managed_model_invalid_spec");
  return spec;
}

/** A recovery journal does not contain the original endpoint/credential. Never reconstruct them. */
function recoverySpec(entry) {
  const fields = {};
  for (const key of MODEL_FIELDS) if (Object.hasOwn(entry.modelDiff?.after || {}, key)) fields[key] = entry.modelDiff.after[key];
  return captureSpec({
    kind: entry.kind,
    providerKey: entry.providerKey,
    providerMode: entry.createdProvider === true ? "new" : "existing",
    sourceModelId: entry.source?.modelId || null,
    ...(Object.keys(fields).length ? { model: fields } : {}),
  });
}

/** Remove static provider keys from every Main config projection; hash is the
 * actual source revision and is deliberately preserved unchanged. */
function projectConfigResponse(raw) {
  const captured = captureData(raw);
  const output = { ...captured };
  const clean = config => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return config;
    const providers = config.models?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return config;
    return { ...config, models: { ...config.models, providers: Object.fromEntries(Object.entries(providers).map(([key, provider]) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [key, provider];
      const projected = { ...provider }; delete projected.apiKey; return [key, projected];
    })) } };
  };
  for (const key of ["parsed", "config"]) if (Object.hasOwn(output, key)) output[key] = clean(output[key]);
  if (Object.hasOwn(output, "raw")) {
    const projected = output.parsed || output.config;
    if (projected && typeof projected === "object") output.raw = JSON.stringify(projected);
    else delete output.raw;
  }
  return captureData(output);
}

/** Base's legacy null means deletion, but private Worker wire accepts no
 * apiKey field. Only a currently bound clear candidate can project that intent;
 * the independently authenticated Service action performs the actual removal. */
function projectCredentialPatch(params, scope, phase) {
  let patch; try { patch = JSON.parse(params.raw); } catch { fail("managed_model_invalid_data"); }
  for (const [key, provider] of Object.entries(patch.models?.providers || {})) {
    if (!provider || !Object.hasOwn(provider, "apiKey")) continue;
    if (provider.apiKey !== null || !scope.credentialPermit || scope.credentialPlan?.action !== "clear"
      || phase !== "candidate" || key !== scope.safeSpec.providerKey
      || key !== scope.credentialPermit.scope.providerKey) fail("managed_credential_main_key_forbidden");
    delete provider.apiKey;
  }
  credentialEffect.assertNoWireSecrets(patch);
  return captureData({ ...params, raw: JSON.stringify(patch) });
}

/** A public revision can be mapped only by this acquired, authenticated
 * Runtime snapshot. Neither a catalogue nor sanitized config bytes prove it. */
function acquiredConfigRevision(snapshot) {
  const source = snapshot?.managedConfigSource;
  if (!source || !Object.hasOwn(source, "loadedProjectedHash")) return null;
  if (Object.getPrototypeOf(source) !== Object.prototype || Reflect.ownKeys(source).length !== 5
    || !["version", "persistedRawHash", "loadedRawHash", "loaded", "loadedProjectedHash"].every(key => Object.hasOwn(source, key))
    || source.version !== 1 || source.loaded !== true
    || typeof snapshot.hash !== "string" || !DIGEST.test(snapshot.hash)
    || source.persistedRawHash !== snapshot.hash || source.loadedRawHash !== snapshot.hash
    || typeof source.loadedProjectedHash !== "string" || !PROJECTED_REVISION.test(source.loadedProjectedHash))
    fail("managed_model_revision_unverified");
  return Object.freeze({ rawHash: snapshot.hash, projectedHash: source.loadedProjectedHash });
}

/** This is evaluated only from config.get on the actual acquired lease. */
function deriveCredentialPlan(spec, snapshot, identity, secretIntent, nativeConfig = false) {
  const provider = snapshot?.parsed?.models?.providers?.[spec.providerKey];
  const creating = spec.kind === "create" && spec.providerMode === "new" || spec.kind === "save-provider" && !provider;
  const patch = ["update-provider", "save-provider"].includes(spec.kind) ? spec.patch || {} : {};
  if (nativeConfig && !secretIntent && patch.clearApiKey !== true) return null;
  if (nativeConfig) {
    if (secretIntent && patch.clearApiKey === true) fail("managed_credential_conflicting_intent");
    if (secretIntent && !["create", "update", "update-provider", "save-provider"].includes(spec.kind)) fail("managed_credential_secret_intent_unsupported");
    const scope = externalProviderOperationScope({ ...nativeAuthProviderScope(spec, snapshot.parsed), ...identity });
    return Object.freeze({ scope, action: secretIntent ? "set" : "clear" });
  }
  if (patch.clearBaseUrl === true) fail("managed_credential_clear_base_url_unsupported");
  if (secretIntent && !["create", "update", "update-provider", "save-provider"].includes(spec.kind)) fail("managed_credential_secret_intent_unsupported");
  // Match the fixed Runtime domain contract when the loaded provider omits api.
  // A catalogue hint cannot replace the actual acquired configuration.
  const existingApi = provider?.api || "openai-completions";
  const changingDomain = Object.hasOwn(patch, "baseUrl") && patch.baseUrl !== provider?.baseUrl
    || Object.hasOwn(patch, "api") && patch.api !== provider?.api;
  const clearing = patch.clearApiKey === true || !nativeConfig && spec.kind === "delete-provider";
  if (secretIntent && clearing) fail("managed_credential_conflicting_intent");
  if (changingDomain && !secretIntent && !clearing) fail("managed_credential_domain_change_requires_intent");
  if (!secretIntent && !clearing && !creating && !changingDomain) return null;
  const baseUrl = creating ? patch.baseUrl || spec.baseUrl : Object.hasOwn(patch, "baseUrl") ? patch.baseUrl : provider?.baseUrl;
  const api = creating ? patch.api || spec.api || "openai-completions" : Object.hasOwn(patch, "api") ? patch.api : existingApi;
  let scope;
  try { scope = externalProviderOperationScope({ backendId: "openclaw", providerKey: nativeConfig ? patch.renameTo || spec.providerKey : spec.providerKey, baseUrl, api, ...identity }); }
  catch { fail("managed_credential_scope_unavailable"); }
  return Object.freeze({ scope, action: secretIntent ? "set" : "clear" });
}

/**
 * Core-only transaction facade. Its authority comes from the injected Worker brand verifier,
 * not from capability flags, a lease-shaped object, or renderer-supplied metadata.
 * Ordinary Backend requests remain outside this AsyncLocalStorage instance.
 */
function createManagedOpenClawModelApply({ backend, modelController, admissionGate, credentialBroker, drainTimeoutMs = 5000, configurationMode } = {}) {
  if (!backend || typeof backend.request !== "function"
    || !modelController || ["isModelApplySupported", "acquireModelLease", "assertModelLease"].some((key) => typeof modelController[key] !== "function")
    || !admissionGate || typeof admissionGate.beginDrain !== "function") fail("managed_model_invalid_dependency");
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60000) fail("managed_model_invalid_dependency");
  if (credentialBroker !== undefined && (!credentialBroker
    || ["createContext", "prepareAndOpen", "renew", "advance", "observeFinished", "observeRetainedOperation"].some(key => typeof credentialBroker[key] !== "function"))) fail("managed_credential_invalid_dependency");
  const storage = new AsyncLocalStorage(), credentialPhases = new AsyncLocalStorage();
  const activeOperations = new Set();
  const activeScopes = new Set();
  const unresolvedOperations = new Map();
  let connectionGeneration = 0;

  const checkpoint = (scope) => {
    if (!scope || scope.active !== true || scope.ownedExited === true || scope.generation !== connectionGeneration) fail("managed_model_scope_expired");
    if (scope.providerLeaseSignal?.aborted) fail("managed_model_canceled");
    if (typeof modelController.isModelOwnerCurrent === "function") {
      let ownerCurrent = false; try { ownerCurrent = modelController.isModelOwnerCurrent(scope.modelOwner) === true; } catch {}
      if (!ownerCurrent) fail("managed_model_owner_retired");
    }
    const providerCurrent = scope.assertProviderLease();
    if (providerCurrent !== undefined && providerCurrent !== true) fail("managed_model_provider_lease_invalid");
    if (scope.heartbeatError) fail("managed_model_lease_lost");
    if (scope.credentialEffectUnverified) fail("managed_credential_write_receipt_unverified");
    if (scope.lease && scope.expiresAt <= Date.now()) fail("managed_model_lease_expired");
  };
  const assertBrand = async (scope) => {
    checkpoint(scope);
    if (!scope.lease || await modelController.assertModelLease(scope.lease, scope.identity) !== true) fail("managed_model_lease_untrusted");
    checkpoint(scope);
  };
  const validateDeadline = (expiresAt) => {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300000) fail("managed_model_invalid_deadline");
    return expiresAt;
  };
  const serializeCredential = (scope, action) => {
    const work = scope.credentialQueue.then(async () => { checkpoint(scope); return action(); });
    scope.credentialQueue = work.catch(() => {}); return work;
  };
  const writerAndBind = async (scope, mode) => {
    await assertBrand(scope);
    const writer = await scope.lease.getCredentialOwner();
    await assertBrand(scope);
    const permit = mode === "open"
      ? await credentialBroker.prepareAndOpen({ ...scope.credentialPlan, writer,
        ...(scope.secretIntent ? { secret: scope.pendingSecret } : {}) }, scope.credentialContext)
      : await credentialBroker[mode](scope.credentialPermit, writer, scope.credentialContext);
    await assertBrand(scope);
    if (await scope.lease.bindCredentialPermit(permit) !== true) fail("managed_credential_bind_unverified");
    await assertBrand(scope); scope.credentialPermit = permit;
  };
  const initializeCredentials = async scope => {
    const snapshot = await scope.lease.modelRpc("config.get", Object.freeze({}));
    await assertBrand(scope);
    const capturedSnapshot = captureData(snapshot);
    scope.configRevision = acquiredConfigRevision(capturedSnapshot);
    if (scope.publicConfigRevision && (!scope.configRevision
      || scope.configRevision.projectedHash !== scope.publicConfigRevision)) fail("managed_model_revision_changed");
    scope.credentialPlan = deriveCredentialPlan(scope.safeSpec, capturedSnapshot, scope.identity, scope.secretIntent, scope.nativeConfig);
    if (!scope.credentialPlan) return;
    if (!credentialBroker || ["getCredentialOwner", "bindCredentialPermit"].some(key => typeof scope.lease[key] !== "function")) fail("managed_credential_broker_unavailable");
    scope.credentialContext = credentialBroker.createContext({ modelOwner: scope.modelOwner, nativeAuth: scope.nativeConfig,
      signal: scope.providerLeaseSignal, assertProviderLease: () => checkpoint(scope) });
    await writerAndBind(scope, "open"); scope.pendingSecret = null;
  };

  const privateConfigPatch = async (scope, params) => {
    if (!PROJECTED_REVISION.test(params.baseHash)) return params;
    const original = scope.configRevision;
    if (!original || params.baseHash !== original.projectedHash) fail("managed_model_revision_unverified");
    // Check again immediately before the raw CAS. A staged file or another
    // incarnation cannot inherit the original public revision's authority.
    const current = captureData(await scope.lease.modelRpc("config.get", Object.freeze({})));
    await assertBrand(scope);
    const verified = acquiredConfigRevision(current);
    if (!verified || verified.rawHash !== original.rawHash || verified.projectedHash !== original.projectedHash)
      fail("managed_model_revision_changed");
    return captureData({ ...params, baseHash: original.rawHash });
  };

  const scheduleRenew = (scope) => {
    if (!scope.active || scope.finishing) return;
    scope.timer = setTimeout(() => {
      scope.renewal = (async () => {
        await assertBrand(scope);
        await serializeCredential(scope, async () => {
          const renewed = await scope.lease.renew();
          checkpoint(scope); scope.expiresAt = validateDeadline(renewed?.expiresAt);
          await assertBrand(scope);
          if (scope.credentialPermit) await writerAndBind(scope, "renew");
        });
      })().catch(() => { scope.heartbeatError = true; });
      scope.renewal.finally(() => { if (!scope.heartbeatError) scheduleRenew(scope); });
    }, Math.max(10, Math.floor((scope.expiresAt - Date.now()) / 3)));
    scope.timer.unref?.();
  };

  const acquire = (scope) => {
    checkpoint(scope);
    if (scope.acquirePromise) return scope.acquirePromise;
    scope.acquirePromise = (async () => {
      scope.drain = admissionGate.beginDrain("openclaw", `managed-model:${scope.operationId}`);
      if (await scope.drain.waitForIdle(drainTimeoutMs) !== true) fail("managed_model_admissions_busy");
      checkpoint(scope);
      // Ordinary availability is deliberately false while the product is paused/needs_verification.
      // Recovery carries the exact durable journal identity; only the trusted controller/Worker
      // may admit that retained owning operation. It is not a new apply capability.
      if (!scope.recovery && await modelController.isModelApplySupported() !== true) fail("managed_model_apply_unsupported");
      checkpoint(scope);
      if (scope.recovery && typeof modelController.canRecoverModelLease === "function") {
        if (await modelController.canRecoverModelLease(scope.identity) !== true) fail("managed_model_recovery_unavailable");
        checkpoint(scope);
      }
      scope.acquireAttempted = true;
      const raw = await modelController.acquireModelLease(Object.freeze({
        ...scope.identity, safeSpec: scope.safeSpec, recovery: scope.recovery,
        signal: scope.providerLeaseSignal,
      }));
      // Keep the actual object for abandonment even if the post-acquire guard fails.
      scope.lease = raw;
      if (!raw || REQUIRED_LEASE_METHODS.some((key) => typeof raw[key] !== "function")) fail("managed_model_invalid_lease");
      scope.expiresAt = validateDeadline(raw.expiresAt);
      await assertBrand(scope);
      if (await raw.assertIdle() !== true) fail("managed_model_work_busy");
      await assertBrand(scope);
      if (!scope.recovery) {
        try { await initializeCredentials(scope); }
        catch (error) { scope.credentialAdmissionFailed = true; throw error; }
      }
      scheduleRenew(scope);
      return raw;
    })();
    return scope.acquirePromise;
  };

  const callLease = async (scope, method, params) => {
    const captured = captureData(params);
    await acquire(scope);
    await assertBrand(scope);
    if (method === "convergeAfterRetire" && scope.credentialPermit && scope.credentialRequiresRestart) {
      if (await callLease(scope, "restartPaused") !== true || await callLease(scope, "waitHealthy") !== true) fail("managed_credential_restart_unverified");
    }
    const invoke = async () => {
      const result = await scope.lease[method](captured);
      if (result === true && ["restartPaused", "convergeAfterRetire"].includes(method)) scope.expiresAt = validateDeadline(scope.lease.expiresAt);
      await assertBrand(scope);
      if (method === "restartPaused" && scope.credentialPermit) {
        if (result !== true) fail("managed_credential_restart_unverified");
        await writerAndBind(scope, "advance"); scope.credentialRequiresRestart = false;
      }
      return result;
    };
    return scope.credentialPermit ? serializeCredential(scope, invoke) : invoke();
  };

  const facade = Object.freeze({
    noteCredentialMutation() { backend.noteCredentialMutation?.(); },
    async request(method, params = {}) {
      if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) fail("managed_model_rpc_unsupported");
      const captured = captureData(params);
      const scope = storage.getStore();
      if (scope) checkpoint(scope);
      if (WRITE_METHODS.has(method) && !scope) fail("managed_model_write_outside_transaction");
      if (["config.set", "models.authSetApiKey", "models.authLogout"].includes(method) && !scope?.nativeConfig) fail("managed_model_rpc_unsupported");
      if (scope?.nativeConfig && method === "config.get" && scope.configNeedsReload) {
        if (await callLease(scope, "restartPaused") !== true || await callLease(scope, "waitHealthy") !== true) fail("managed_model_restart_unverified");
        scope.configNeedsReload = false;
      }
      if (scope && (scope.acquirePromise || WRITE_METHODS.has(method))) {
        await acquire(scope);
        await assertBrand(scope);
        // An uncertain write must never authorize a blocked/no-write finish.
        const priorWriteAttempted = scope.writeAttempted;
        if (CONFIG_WRITES.has(method)) scope.writeAttempted = true;
        const invoke = async () => {
          const phase = credentialPhases.getStore() || "candidate";
          const wire = ["config.patch", "config.set"].includes(method)
            ? await privateConfigPatch(scope, method === "config.patch" ? projectCredentialPatch(captured, scope, phase) : captured) : captured;
          const result = method === "config.patch" && scope.credentialPermit
            ? await scope.lease.modelRpc(method, wire, Object.freeze({ credentialPhase: phase }))
            : await scope.lease.modelRpc(method, wire);
          await assertBrand(scope);
          if (scope.nativeConfig && method === "config.set" && result?.noWrite === true) scope.writeAttempted = priorWriteAttempted;
          if (scope.nativeConfig && CONFIG_WRITES.has(method) && result?.noWrite !== true) scope.configNeedsReload = true;
          if (["models.authSetApiKey", "models.authLogout"].includes(method)) {
            if (!scope.credentialPermit || result?.provider?.toLowerCase() !== (scope.safeSpec.patch?.renameTo || scope.safeSpec.providerKey).toLowerCase()) fail("managed_credential_write_receipt_unverified");
            scope.credentialRequiresRestart = true;
            scope.credentialCandidateApplied = true;
          }
          if (method === "config.patch" && scope.credentialPermit) {
            if (!result || Object.getPrototypeOf(result) !== Object.prototype
              || Reflect.ownKeys(result).length !== 3 || result.ok !== true || result.restartRequired !== true
              || typeof result.hash !== "string" || !result.hash || result.hash.length > 128 || /[\0\r\n]/u.test(result.hash)) {
              scope.credentialEffectUnverified = true; fail("managed_credential_write_receipt_unverified");
            }
            scope.credentialRequiresRestart = true;
            if (phase === "candidate" && scope.secretIntent) scope.credentialCandidateApplied = true;
          }
          if (method === "config.get" && scope.nativeConfig) {
            const projected = { ...projectConfigResponse(result) };
            for (const key of ["parsed", "config"]) if (projected[key]) projected[key] = require("../managed-openclaw-model-policy").nativeModelProjection(projected[key]);
            if (projected.parsed) projected.raw = JSON.stringify(projected.parsed);
            return projected;
          }
          return ["config.get", "config.patch", "config.set"].includes(method) ? projectConfigResponse(result) : result;
        };
        return scope.credentialPermit ? serializeCredential(scope, invoke) : invoke();
      }
      const result = await backend.request(method, captured);
      if (scope) checkpoint(scope);
      const projected = ["config.get", "config.patch"].includes(method) ? projectConfigResponse(result) : result;
      if (scope && method === "config.get" && PROJECTED_REVISION.test(projected.hash)) scope.publicConfigRevision = projected.hash;
      return projected;
    },
    async getModelReferenceCapabilities() {
      const scope = storage.getStore();
      if (scope) checkpoint(scope);
      if (scope?.acquirePromise) {
        await acquire(scope);
        await assertBrand(scope);
        const result = typeof scope.lease.getModelReferenceCapabilities === "function"
          ? await scope.lease.getModelReferenceCapabilities() : {};
        await assertBrand(scope);
        return captureData(result);
      }
      const owner = typeof modelController.getModelReferenceCapabilities === "function" ? modelController : backend;
      const result = typeof owner.getModelReferenceCapabilities === "function" ? await owner.getModelReferenceCapabilities() : {};
      if (scope) checkpoint(scope);
      return captureData(result);
    },
  });

  const currentScope = (operationId) => {
    const scope = storage.getStore();
    checkpoint(scope);
    if (scope.operationId !== operationId) fail("managed_model_operation_mismatch");
    return scope;
  };
  const borrowLease = async (operationId) => {
    const scope = currentScope(operationId);
    await acquire(scope);
    await assertBrand(scope);
    let released = false;
    const checkBorrow = () => { if (released) fail("managed_model_borrow_released"); checkpoint(scope); };
    const verify = async () => {
      checkBorrow();
      const methods = scope.nativeConfig && !scope.configNeedsReload ? [["waitHealthy"], ["verifyTarget", scope.safeSpec]]
        : [["restartPaused"], ["waitHealthy"], ["verifyTarget", scope.safeSpec]];
      for (const [method, params] of methods) {
        if (await callLease(scope, method, params) !== true) fail("managed_model_target_unverified");
      }
      scope.configNeedsReload = false;
      checkBorrow();
      return true;
    };
    return Object.freeze({
      checkpoint: checkBorrow,
      verifyTarget: verify,
      async convergeAfterRetire() {
        checkBorrow();
        if (await callLease(scope, "convergeAfterRetire", scope.safeSpec) !== true) return false;
        checkBorrow();
        return true;
      },
      async release() {
        // The base adapter's finally lacks the outcome. It may only return its borrow.
        released = true;
      },
    });
  };
  const releaseAfterOwnedExit = proof => {
    // Private brand verification is synchronous and never reads network state.
    // An invalidation, ready DTO, forged JSON or unknown exit carries no proof.
    if (typeof modelController.isOwnedExitProof !== "function" || typeof modelController.matchesOwnedExitProof !== "function"
      || modelController.isOwnedExitProof(proof) !== true) fail("managed_model_owned_exit_untrusted");
    let released = 0;
    for (const [operationId, record] of unresolvedOperations) {
      if (modelController.matchesOwnedExitProof(proof, record.modelOwner) !== true) continue;
      if (record.drain) { record.drain.release(); released += 1; }
      // Preserve the original uncertain operation fence; this does not approve
      // replay or change its durable model-change journal/terminal outcome.
      unresolvedOperations.set(operationId, Object.freeze({ ...record, drain: null, ownedExited: true }));
    }
    for (const scope of activeScopes) {
      if (modelController.matchesOwnedExitProof(proof, scope.modelOwner) !== true) continue;
      scope.ownedExited = true;
      clearTimeout(scope.timer);
      if (scope.drain) { scope.drain.release(); scope.drain = null; released += 1; }
    }
    return Object.freeze({ released });
  };
  const runtimeApply = Object.freeze({
    async inspect() {
      const supported = await modelController.isModelApplySupported() === true;
      return Object.freeze({ mode: supported ? "restart-required" : "unsupported", safeApply: supported });
    },
    async acquireForApply({ operationId } = {}) { return borrowLease(operationId); },
    async recoverLease(operationId) { return borrowLease(operationId); },
    async verifyTarget() {
      const scope = storage.getStore();
      checkpoint(scope);
      return callLease(scope, "verifyTarget", scope.safeSpec);
    },
    async convergeAfterRetire() {
      const scope = storage.getStore();
      checkpoint(scope);
      return callLease(scope, "convergeAfterRetire", scope.safeSpec);
    },
    invalidateConnectionGeneration() { connectionGeneration += 1; },
    releaseAfterOwnedExit,
  });
  const base = createOpenClawModelChange({ backend: facade, runtimeApply, credentialApply: Object.freeze({
    hasSecretIntent() { const scope = storage.getStore(); checkpoint(scope); return scope.secretIntent === true; },
    wasCandidateApplied() { const scope = storage.getStore(); checkpoint(scope); return scope.credentialCandidateApplied === true; },
    withPhase(phase, action) {
      if (!["candidate", "previous"].includes(phase) || typeof action !== "function") fail("managed_credential_phase_invalid");
      const scope = storage.getStore(); checkpoint(scope);
      return credentialPhases.run(phase, async () => { checkpoint(scope); const value = await action(); checkpoint(scope); return value; });
    },
  }) });
  const nativeBase = configurationMode === "native-config" ? createOpenClawModelChange({ backend: facade, runtimeApply,
    configurationMode, requiresRuntimeLease: true, credentialApply: Object.freeze({
      hasSecretIntent() { const scope = storage.getStore(); checkpoint(scope); return scope.secretIntent === true; },
      async applyNative({ provider, agentId, clear, credentialScope }) {
        const scope = storage.getStore(); checkpoint(scope);
        if (!scope.credentialPermit) fail("managed_credential_broker_unavailable");
        return facade.request(clear ? "models.authLogout" : "models.authSetApiKey", { provider, agentId,
          ...(credentialScope ? { credentialScope } : {}) });
      },
    }) }) : null;

  const captureContext = (source, spec, entry) => {
    if (!source || !OPERATION_ID.test(source.operationId || "") || !DIGEST.test(source.requestDigest || "")) fail("managed_model_invalid_identity");
    if (["assertProviderLease", "recordStage", "markCommitting", "markCommitted"].some((key) => typeof source[key] !== "function")) fail("managed_model_context_incomplete");
    const operationId = source.operationId;
    const requestDigest = source.requestDigest;
    if (entry && (entry.operationId !== operationId || entry.requestDigest !== requestDigest)) fail("managed_model_operation_mismatch");
    if (!entry && modelChangeRequestDigest(spec) !== requestDigest) fail("managed_model_digest_mismatch");
    const scope = {
      operationId, requestDigest, identity: Object.freeze({ operationId, requestDigest }), safeSpec: spec,
      recovery: Boolean(entry), active: true, generation: connectionGeneration, ownedExited: false,
      modelOwner: typeof modelController.captureModelOwner === "function" ? modelController.captureModelOwner() : null,
      providerLeaseSignal: source.providerLeaseSignal,
      assertProviderLease: source.assertProviderLease.bind(source),
      lease: null, acquirePromise: null, drain: null, expiresAt: 0,
      secretIntent: false, pendingSecret: null, credentialPlan: null, credentialPermit: null,
      credentialContext: null, credentialQueue: Promise.resolve(), credentialCandidateApplied: false, credentialRequiresRestart: false,
      heartbeatError: false, renewal: Promise.resolve(), timer: null, finishing: false, writeAttempted: false, acquireAttempted: false,
      commitState: entry?.commitState || source.journalEntry?.commitState || "precommit",
    };
    const context = {
      operationId, requestDigest,
      journalEntry: entry || captureData(source.journalEntry || {}),
      providerLeaseSignal: scope.providerLeaseSignal,
      assertProviderLease: () => checkpoint(scope),
      ...(source.recoveryMode ? { recoveryMode: source.recoveryMode } : {}),
      ...(source.forwardOnly === true ? { forwardOnly: true } : {}),
    };
    for (const name of ["recordStage", "recordStep", "markCommitting", "markCommitted"]) {
      if (typeof source[name] !== "function") continue;
      const hook = source[name].bind(source);
      context[name] = async (...args) => {
        const captured = captureData(args);
        checkpoint(scope);
        const result = await hook(...captured);
        checkpoint(scope);
        if (name === "markCommitting") scope.commitState = "committing";
        if (name === "markCommitted") scope.commitState = "committed";
        return result;
      };
    }
    return { scope, context: Object.freeze(context) };
  };

  const settle = async (scope, result) => {
    if (!scope.lease) {
      if (scope.acquireAttempted) fail("managed_model_acquire_unverified");
      return result;
    }
    if (scope.credentialAdmissionFailed || scope.credentialPlan && !scope.credentialPermit) fail("managed_credential_admission_unverified");
    await assertBrand(scope);
    scope.finishing = true;
    clearTimeout(scope.timer);
    await scope.renewal;
    await assertBrand(scope);
    const nativeRejected = scope.nativeConfig && result?.status === "failed" && result?.noWrite === true && !scope.writeAttempted;
    const settledOutcome = nativeRejected ? "blocked" : result?.status;
    const resumable = nativeRejected || result?.status === "applied" || result?.status === "compensated"
      || (result?.status === "blocked" && !scope.writeAttempted);
    if (!resumable) {
      if (await scope.lease.abandon(Object.freeze({ reason: "nonterminal_outcome" })) !== true) fail("managed_model_abandon_unverified");
      scope.settled = true;
      return result?.status === "blocked" && scope.writeAttempted
        ? { ...result, status: scope.commitState === "precommit" ? "partial" : "cleanup_pending", needsVerification: true }
        : result;
    }
    if (scope.credentialPermit) scope.credentialTerminal = Object.freeze({
      providerKey: scope.safeSpec.providerKey, kind: scope.safeSpec.kind,
      result: captureData({ status: settledOutcome, stage: result.stage || "runtime-apply",
        ...(typeof result.code === "string" && OPERATION_ID.test(result.code) ? { code: result.code } : {}) }),
    });
    if (scope.credentialPermit && scope.credentialRequiresRestart) {
      if (await callLease(scope, "restartPaused") !== true || await callLease(scope, "waitHealthy") !== true) fail("managed_credential_restart_unverified");
    }
    if (await scope.lease.finish(Object.freeze({
      ...scope.identity, outcome: settledOutcome, safeSpec: scope.safeSpec,
    })) !== true) fail("managed_model_finish_unverified");
    // finish may retire the lease. Check local cancellation, not its retired Worker brand.
    checkpoint(scope);
    if (scope.credentialPermit) await credentialBroker.observeFinished(scope.credentialPermit, settledOutcome, scope.credentialContext, true);
    checkpoint(scope); scope.settled = true;
    return result;
  };

  const execute = async (spec, context, entry, secretEnvelope) => {
    let capturedSecret = secretEnvelope == null ? null : captureData(secretEnvelope, { nodes: 4, bytes: 65536 });
    if (capturedSecret && (Object.keys(capturedSecret).some((key) => key !== "apiKey") || typeof capturedSecret.apiKey !== "string")) fail("managed_model_invalid_secret_envelope");
    if (capturedSecret && !credentialBroker) fail("managed_credential_broker_unavailable");
    const retainedSpec = entry?.mode === "native-config" ? unresolvedOperations.get(entry.operationId)?.safeSpec : null;
    if (retainedSpec) spec = retainedSpec;
    const { scope, context: capturedContext } = captureContext(context, spec, entry);
    scope.nativeConfig = Boolean(nativeBase && (entry || context.journalEntry)?.mode === "native-config");
    scope.configNeedsReload = false;
    scope.secretIntent = Boolean(capturedSecret?.apiKey); scope.pendingSecret = capturedSecret?.apiKey || null;
    if (activeOperations.has(scope.operationId)) fail("managed_model_operation_in_progress");
    const unresolved = unresolvedOperations.get(scope.operationId);
    if (unresolved && unresolved.requestDigest !== scope.requestDigest) fail("managed_model_operation_mismatch");
    if (unresolved && !entry) fail("managed_model_requires_recovery");
    if (!unresolved && activeOperations.size + unresolvedOperations.size >= 128) fail("managed_model_unresolved_limit");
    activeOperations.add(scope.operationId); activeScopes.add(scope);
    return storage.run(scope, async () => {
      let result;
      try {
        checkpoint(scope);
        // Credential recovery requires its retained immutable private operation;
        // a public journal does not reconstruct the original domain or key.
        if (entry && (unresolved?.credentialOperation || (scope.nativeConfig
          ? ["pending", "applied"].includes(entry.secretStep)
          : entry.secretStep || entry.createdProvider || ["update-provider", "delete-provider"].includes(entry.kind)))) {
          if (credentialBroker) {
            const observer = credentialBroker.createContext({ modelOwner: scope.modelOwner, nativeAuth: scope.nativeConfig,
              signal: scope.providerLeaseSignal, assertProviderLease: () => checkpoint(scope) });
            const observed = await credentialBroker.observeRetainedOperation(scope.identity, observer);
            checkpoint(scope);
            const terminal = unresolved?.credentialTerminal;
            if (terminal && unresolved.modelOwner === scope.modelOwner && terminal.providerKey === entry.providerKey
              && terminal.kind === entry.kind && typeof modelController.canRecoverCredentialTerminal === "function"
              && modelController.canRecoverCredentialTerminal(scope.identity) === true
              && typeof modelController.recoverCredentialTerminal === "function"
              && typeof credentialBroker.observeRecoveredTerminal === "function") {
              if (observed.state !== terminal.result.status) fail("managed_credential_terminal_outcome_mismatch");
              // Use the original immutable Worker operation. No acquire, model
              // RPC, secret reprepare, renewal, new writer or settle replay.
              scope.credentialRecoveryAttempted = true;
              const recovered = captureData(await modelController.recoverCredentialTerminal(scope.identity));
              checkpoint(scope);
              if (!recovered || Object.keys(recovered).length !== 4 || recovered.outcome !== terminal.result.status
                || recovered.paused !== false || recovered.resumed !== true || recovered.healthVerified !== true)
                fail("managed_credential_terminal_recovery_unverified");
              await capturedContext.recordStage("credential-terminal-recovered");
              checkpoint(scope);
              await credentialBroker.observeRecoveredTerminal(scope.identity, recovered.outcome, observer, true);
              checkpoint(scope); scope.settled = true; scope.credentialTerminalRecovered = true;
              return terminal.result;
            }
          }
          return { status: "partial", code: "managed_credential_recovery_observation_only", stage: "runtime-apply", needsVerification: true };
        }
        // Metadata recovery while Gateway is paused begins with a private read.
        if (entry) await acquire(scope);
        if (entry && scope.nativeConfig) {
          if (await callLease(scope, "restartPaused") !== true || await callLease(scope, "waitHealthy") !== true) fail("managed_model_restart_unverified");
        }
        const adapter = scope.nativeConfig ? nativeBase : base;
        result = entry ? await adapter.recover(entry, capturedContext) : await adapter.apply(spec, capturedContext, null);
        return await settle(scope, result);
      } catch (error) {
        if (!scope.lease && !scope.writeAttempted && !scope.acquireAttempted && !scope.credentialRecoveryAttempted) throw error;
        return {
          status: scope.commitState === "committed" || result?.status === "applied" ? "cleanup_pending" : "partial",
          code: error instanceof ManagedModelApplyError ? error.code : "managed_model_outcome_unverified",
          stage: "runtime-apply", needsVerification: true,
          ...(result?.configSaved === true ? { configSaved: true } : {}),
        };
      } finally {
        scope.finishing = true;
        clearTimeout(scope.timer);
        await scope.renewal;
        if (scope.lease && !scope.settled) {
          // Best effort only; failure still leaves the owning Worker paused and result nonterminal.
          try {
            if (await modelController.assertModelLease(scope.lease, scope.identity) === true) {
              scope.settled = await scope.lease.abandon(Object.freeze({ reason: "transaction_unverified" })) === true;
            }
          } catch { /* Never resume on uncertain cleanup. */ }
        }
        scope.pendingSecret = null; capturedSecret = null;
        scope.active = false;
        if (scope.ownedExited && scope.acquireAttempted && !scope.settled) {
          // A settled physical exit can race a still-active Core finally. Keep
          // the operation tombstone, but do not re-create a stale admission hold.
          if (!unresolved || unresolved.modelOwner === scope.modelOwner) unresolvedOperations.set(scope.operationId, Object.freeze({
            requestDigest: scope.requestDigest, drain: null, modelOwner: scope.modelOwner, ownedExited: true,
            credentialOperation: Boolean(scope.credentialPlan), credentialTerminal: scope.credentialTerminal || null,
            ...(scope.nativeConfig ? { safeSpec: scope.safeSpec } : {}),
          }));
        }
        if (scope.drain) {
          if (scope.settled || !scope.acquireAttempted) {
            scope.drain.release();
            if (scope.settled && unresolved) {
              unresolved.drain?.release();
              unresolvedOperations.delete(scope.operationId);
            }
          } else if (unresolved) {
            // Keep the original hold; no extra unbounded drain token per failed recovery.
            scope.drain.release();
          } else {
            unresolvedOperations.set(scope.operationId, Object.freeze({
              requestDigest: scope.requestDigest, drain: scope.drain, modelOwner: scope.modelOwner,
              credentialOperation: Boolean(scope.credentialPlan), credentialTerminal: scope.credentialTerminal || null,
              ...(scope.nativeConfig ? { safeSpec: scope.safeSpec } : {}),
            }));
          }
        }
        if (scope.credentialTerminalRecovered && scope.settled && unresolvedOperations.get(scope.operationId) === unresolved) {
          unresolved.drain?.release(); unresolvedOperations.delete(scope.operationId);
        }
        activeScopes.delete(scope); activeOperations.delete(scope.operationId);
      }
    });
  };

  return Object.freeze({
    ...(nativeBase ? { configurationSemantics: "native-config" } : {}),
    releaseAfterOwnedExit,
    getCapabilities: (nativeBase || base).getCapabilities,
    preview(spec) { return (nativeBase || base).preview(captureSpec(spec)); },
    apply(spec, context, secretEnvelope) { return execute(captureSpec(spec), context, null, secretEnvelope); },
    recover(rawEntry, context) {
      const entry = captureData(rawEntry);
      return execute(recoverySpec(entry), context, entry, null);
    },
    runtimeApply,
  });
}

module.exports = { ManagedModelApplyError, createManagedOpenClawModelApply,
  _credentialProtocol: Object.freeze({ projectConfigResponse, projectCredentialPatch, deriveCredentialPlan }) };
