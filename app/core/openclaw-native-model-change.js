"use strict";

// The existing coordinator owns admission, IDs, locks and recovery. This adapter
// delegates definition and credential semantics to the official Gateway APIs.
const { NATIVE_CONFIG_MODE, buildOpenClawModelDraft, observeOpenClawModelDraft } = require("./openclaw-model-config-draft");
const { ModelChangeError } = require("./model-change-validation");
const { resolveNativeAuthAgent, nativeAuthAgentIds } = require("../managed-openclaw-auth-profile-scope");
const { applyProviderCredentialOperation } = require("../openclaw-provider-credential-operation");

async function snapshot(backend) {
  const result = await backend.request("config.get", {});
  if (!result || result.valid === false || !result.parsed || typeof result.hash !== "string" || !result.hash) {
    throw new ModelChangeError("config_enumeration_incomplete", "官方配置快照不可用", { stage: "preflight", status: 409 });
  }
  return result;
}
const publicModel = value => value ? Object.fromEntries(Object.entries(value).filter(([key]) =>
  ["id", "name", "contextWindow", "maxTokens", "reasoning"].includes(key))) : undefined;
const warning = value => typeof value?.warning === "string" && value.warning.trim()
  ? ["配置或凭据已保存，网关刷新尚未完成"] : [];

function createNativeOpenClawModelChange({ backend, runtimeApply, requiresRuntimeLease = false, credentialApply } = {}) {
  if (!backend || typeof backend.request !== "function") throw new TypeError("backend.request required");

  const getCapabilities = async () => {
    const native = !requiresRuntimeLease && typeof backend.getNativeModelMethodSupport === "function"
      ? await backend.getNativeModelMethodSupport() : { config: true, credentials: true };
    const supported = requiresRuntimeLease ? (await runtimeApply.inspect())?.safeApply === true : native.config === true;
    return { supported, create: supported, update: supported, rename: supported, delete: supported,
      updateProvider: supported, renameProvider: supported, configurationDraft: supported,
      credentialManagement: supported && native.credentials === true,
      mutationSemantics: NATIVE_CONFIG_MODE,
      blockers: supported ? [] : [requiresRuntimeLease ? "runtime_apply_unsupported" : "native_config_unsupported"] };
  };
  const preview = async spec => {
    const current = await snapshot(backend);
    if (!(await getCapabilities()).supported) {
      return { references: [], blockers: [{ code: requiresRuntimeLease ? "runtime_apply_unsupported" : "native_config_unsupported", store: "runtime" }],
        runtimeApply: "unsupported", fingerprints: { config: current.hash, nativeConfigVersion: 1 } };
    }
    try {
      if (spec.baseHash && spec.baseHash !== current.hash) throw new ModelChangeError("preview_stale", "配置已变化，请刷新后核对", { status: 409 });
      if (spec.agentId) {
        try { resolveNativeAuthAgent(spec, current.parsed); }
        catch { throw new ModelChangeError("auth_agent_not_found", "所选 Agent 已不存在，请刷新", { status: 409 }); }
      }
      const plan = buildOpenClawModelDraft(current.parsed, spec);
      const row = current.parsed.models?.providers?.[spec.providerKey]?.models?.find(model => model.id === spec.sourceModelId);
      return { references: [], blockers: [], runtimeApply: requiresRuntimeLease ? "restart-required" : "gateway",
        fingerprints: { config: current.hash, nativeConfigVersion: 1, nativeTargetProvider: plan.targetKey, nativeProviders: plan.providerKeys, nativeTargetDigest: plan.targetDigest },
        ...(row ? { sourceSnapshot: publicModel(row) } : {}) };
    } catch (error) {
      if (!(error instanceof ModelChangeError)) throw error;
      return { references: [], blockers: [{ code: error.code, store: "config" }],
        runtimeApply: "gateway", fingerprints: { config: current.hash, nativeConfigVersion: 1 } };
    }
  };

  const apply = async (spec, context, secretEnvelope) => {
    if (context.journalEntry?.mode !== NATIVE_CONFIG_MODE) throw new ModelChangeError("operation_mode_mismatch", "模型操作版本不匹配", { status: 409 });
    if (context.journalEntry.stage !== "preflight") return recover(context.journalEntry, context);
    const initial = await snapshot(backend);
    if (initial.hash !== context.journalEntry.fingerprints.config) {
      return { status: "failed", code: "preview_stale", stage: "preflight", noWrite: true };
    }
    let lease = null, configSaved = false;
    const warnings = [];
    try {
      if ((secretEnvelope?.apiKey || credentialApply?.hasSecretIntent?.() || spec.patch?.clearApiKey === true)
        && !(await getCapabilities()).credentialManagement) {
        return { status: "failed", code: "native_auth_unsupported", stage: "preflight", noWrite: true };
      }
      if (requiresRuntimeLease) lease = await runtimeApply.acquireForApply({ operationId: context.operationId });
      const current = lease ? await snapshot(backend) : initial;
      const plan = buildOpenClawModelDraft(current.parsed, spec);
      const fingerprints = { ...context.journalEntry.fingerprints, nativeTargetProvider: plan.targetKey, nativeProviders: plan.providerKeys, nativeTargetDigest: plan.targetDigest };
      await context.recordStage("config-save", { fingerprints });
      if (plan.changed) {
        context.assertProviderLease();
        await context.markCommitting();
        let saved;
        try { saved = await backend.request("config.set", { raw: JSON.stringify(plan.config), baseHash: current.hash }); }
        catch (error) {
          if (error?.code !== "INVALID_REQUEST") throw error;
          const observed = await snapshot(backend);
          if (observed.hash !== current.hash) throw error;
          saved = { noWrite: true, code: "config_rejected" };
        }
        context.assertProviderLease();
        if (saved?.noWrite === true) return { status: "failed", code: saved.code || "config_rejected", stage: "preflight", configSaved: false, noWrite: true };
        if (saved?.ok !== true) return { status: "partial", code: "config_write_unverified", stage: "config-save", retryable: true };
        configSaved = true;
        warnings.push(...warning(saved));
        await context.markCommitted();
      } else configSaved = true;

      const clearing = spec.patch?.clearApiKey === true;
      const hasSecret = Boolean(secretEnvelope?.apiKey || credentialApply?.hasSecretIntent?.());
      if (hasSecret || clearing) {
        await context.recordStage("credential-write");
        if (!plan.changed) await context.markCommitting();
        context.assertProviderLease();
        const agentId = resolveNativeAuthAgent(spec, current.parsed);
        const providerScope = spec.credentialScope === "provider";
        const agentIds = nativeAuthAgentIds(current.parsed);
        const configuredConnection = Object.keys(plan.config.models?.providers || {})
          .some(key => key.toLowerCase() === plan.targetKey.toLowerCase());
        const receipt = credentialApply?.applyNative
          ? await credentialApply.applyNative({ provider: plan.targetKey, agentId, clear: clearing,
            ...(providerScope ? { credentialScope: "provider" } : {}) })
          : providerScope ? await applyProviderCredentialOperation({
            provider: plan.targetKey, agentIds, configuredConnection, clear: clearing, apiKey: secretEnvelope?.apiKey,
            request: async (method, params) => {
              context.assertProviderLease();
              const result = await backend.request(method, params, 120000);
              context.assertProviderLease();
              backend.noteCredentialMutation?.();
              return result;
            },
          }) : await backend.request(clearing ? "models.authLogout" : "models.authSetApiKey", {
            provider: plan.targetKey, agentId,
            ...(clearing ? { credentialType: "api_key" } : { apiKey: secretEnvelope.apiKey }),
          }, 120000);
        context.assertProviderLease();
        if (providerScope) {
          const targets = !clearing && configuredConnection ? agentIds.slice(0, 1) : agentIds;
          if (receipt?.credentialScope !== "provider" || receipt.complete !== true
            || JSON.stringify(receipt.agentIds) !== JSON.stringify(targets)) {
            return { status: "partial", code: "provider_credentials_incomplete", stage: "credential-write", configSaved, retryable: false };
          }
        }
        if (!receipt || receipt.provider?.toLowerCase() !== plan.targetKey.toLowerCase() || (clearing
          ? !Array.isArray(receipt.removedProfiles) : typeof receipt.profileId !== "string" || !receipt.profileId)) {
          return { status: "partial", code: "auth_write_unverified", stage: "credential-write", configSaved, retryable: false };
        }
        await context.recordStage("credential-saved", { secretStep: "applied" });
        await context.markCommitted();
        warnings.push(...warning(receipt));
        backend.noteCredentialMutation?.();
        // Auth profile binding is outside the definition digest. A successful
        // official Key receipt needs no second config read or credential replay.
      }
      if (lease) {
        if (await lease.verifyTarget() !== true) return { status: "cleanup_pending", code: "runtime_target_unverified", stage: "runtime-apply", configSaved, retryable: true };
      }
      return { status: "applied", stage: "config-saved", configSaved,
        ...(warnings.length ? { warnings } : {}) };
    } catch (error) {
      if (String(error?.code || "").startsWith("journal_")) throw error;
      if (!configSaved && error instanceof ModelChangeError && error.stage === "preflight") {
        return { status: "failed", code: error.code, stage: "preflight", noWrite: true };
      }
      // No automatic compensation or credential replay. The coordinator keeps
      // the original identity and checkpoints for read-only observation.
      return { status: "partial", code: configSaved ? "credential_or_activation_pending" : "config_save_pending",
        stage: configSaved ? "post-save" : "config-save", configSaved, retryable: false };
    } finally { await lease?.release(); }
  };

  const recover = async (entry, context) => {
    if (entry.mode !== NATIVE_CONFIG_MODE) throw new ModelChangeError("operation_mode_mismatch", "模型操作版本不匹配", { status: 409 });
    if (entry.secretStep === "pending") return { status: "partial", code: "credential_outcome_unknown", stage: "credential-write", retryable: false };
    const current = await snapshot(backend);
    context.assertProviderLease();
    if (!observeOpenClawModelDraft(current.parsed, entry)) return { status: "partial", code: "config_outcome_unknown", stage: "recovery", retryable: false };
    return { status: "applied", stage: "config-saved", configSaved: true };
  };

  return Object.freeze({ configurationSemantics: NATIVE_CONFIG_MODE, getCapabilities, preview, apply, recover });
}

module.exports = { createNativeOpenClawModelChange };
