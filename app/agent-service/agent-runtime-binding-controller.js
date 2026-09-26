"use strict";

const { serviceError } = require("./security");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("./runtime-account");
const { isRuntimeAvailable } = require("../runtime-availability");

function createAgentRuntimeBindingController({ productStore, chatSessionStore, getNativeRuntimeConfig,
  canGenerateCheckpoint, policyStore, onChanged = () => {} }) {
  function assertUnused(profileId, bindingId, { disabling = false } = {}) {
    const policy = policyStore?.get(profileId);
    if (policy && (policy.allowedBindingIds.includes(bindingId) || policy.compactionBindingId === bindingId)) {
      throw serviceError("AGENT_BINDING_IN_USE", "该 Binding 仍被 Runtime 选择或摘要策略引用");
    }
    for (const session of chatSessionStore.listSessions()) {
      if (session.profileId !== profileId) continue;
      // A retired session is still importable history. Never orphan its account.
      if ((!disabling && session.retiredRuntimeSessions?.some(item => item.bindingId === bindingId))
        || (session.runtimeBindingId === bindingId && session.status !== "delete_pending")) {
        throw serviceError("AGENT_BINDING_IN_USE", "该 Binding 仍被会话引用");
      }
    }
  }
  return {
    handle(method, rawParams) {
      const protocol = require("./agent-runtime-binding-protocol");
      const params = protocol.validateAgentBindingParams(method, rawParams);
      const profile = productStore.getAgentProfile(params.profileId);
      if (!profile) throw serviceError("AGENT_BINDING_NOT_FOUND", "Agent 不存在");
      const state = productStore.getAgentRuntimeBindings(params.profileId);
      const enabled = getNativeRuntimeConfig().flags.runtimeMultiBinding;
      let result;
      if (method === "agent.binding.list") result = state;
      else if (method === "agent.binding.sync") {
        // The App supplies only connected, installed CLI accounts. Keep this
        // additive and idempotent: disconnecting never destroys session history
        // or changes an Agent's default/explicitly disabled Binding.
        const accounts = params.runtimeAccountIds.map(id => {
          const account = productStore.getRuntimeAccount(id);
          if (!DEFAULT_RUNTIME_ACCOUNTS.some(entry => entry.id === id && entry.kind === "native-user")
            || !account || !isRuntimeAvailable(account.runtime)) {
            throw serviceError("AGENT_BINDING_INVALID", "CLI account is unavailable");
          }
          return account;
        });
        if (enabled && profile.enabled) for (const account of accounts) {
          const current = productStore.getAgentRuntimeBindings(profile.id);
          if (current.bindings.some(binding => binding.runtimeAccountId === account.id)) continue;
          productStore.addAgentRuntimeBinding(profile.id, { runtime: account.runtime, runtimeAccountId: account.id },
            { operationId: `auto-cli-v1-${account.id}-${current.revision}`, revision: current.revision });
        }
        result = productStore.getAgentRuntimeBindings(profile.id);
      }
      else if (method === "agent.binding.add") {
        if (!enabled && state.bindings.length >= 1) {
          throw serviceError("AGENT_BINDING_FEATURE_DISABLED", "多 Runtime Binding 尚未启用");
        }
        result = productStore.addAgentRuntimeBinding(params.profileId, params.spec,
          { operationId: params.operationId, revision: params.revision });
      } else if (method === "agent.binding.update") {
        if (params.patch.enabled === false) assertUnused(params.profileId, params.bindingId, { disabling: true });
        if (Object.hasOwn(params.patch, "runtimeAccountId")) assertUnused(params.profileId, params.bindingId);
        result = productStore.updateAgentRuntimeBinding(params.profileId, params.bindingId, params.patch,
          { revision: params.revision });
      } else if (method === "agent.binding.remove") {
        assertUnused(params.profileId, params.bindingId);
        result = productStore.removeAgentRuntimeBinding(params.profileId, params.bindingId, { revision: params.revision });
      } else {
        result = productStore.setAgentDefaultBinding(params.profileId, params.bindingId, { revision: params.revision });
      }
      const output = protocol.validateAgentBindingResult(method, { ...result, canAdd: enabled,
        ...(canGenerateCheckpoint ? { checkpointBindingIds: result.bindings.filter(binding => binding.enabled
          && canGenerateCheckpoint(binding.runtime)).map(binding => binding.id) } : {}) }, params);
      if (method !== "agent.binding.list" && result.revision !== state.revision) {
        try { onChanged({ profileId: profile.id, backendId: "shoggoth" }); } catch {}
      }
      return output;
    },
  };
}

module.exports = { createAgentRuntimeBindingController };
