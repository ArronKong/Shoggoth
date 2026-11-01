"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => { throw serviceError(code, message); };
const POLICY = Object.freeze({ approvalPolicy: "never", sandbox: "read-only" });

// Resolve a text-only memory lane from an explicit saved Binding or the owning
// Agent's default. A chat's temporary Binding/model/permissions never route it.
function createMemoryTextRouteResolver({ productStore, chatSessionStore, getConfigProjection,
  captureProviderRoute, assertProviderRoute }) {
  return function resolve(input) {
    const projection = getConfigProjection();
    const owner = productStore.getAgentProfile(input.profileId);
    if (!owner?.enabled) fail("MEMORY_IMPORT_PROFILE_UNAVAILABLE", "记忆所属助理不可用");
    const session = input.sessionKey === undefined ? null : chatSessionStore.getSession(input.sessionKey);
    if (input.sessionKey !== undefined && (!session || session.profileId !== input.profileId
      || !["draft", "binding", "ready"].includes(session.status))) {
      fail("MEMORY_IMPORT_SOURCE_UNAVAILABLE", "记忆来源会话不可用");
    }
    const config = projection.config;
    const selection = config.agents?.entries?.[input.profileId]?.memory?.textModel
      ?? config.memory?.textModel ?? { source: "agent-default" };
    if (selection.source === "local") fail("MEMORY_TEXT_MODEL_DISABLED", "记忆已配置为仅使用本地检索");
    let origin;
    try { origin = productStore.resolveAgentRuntimeProfile(
      selection.source === "binding" ? selection.profileId : input.profileId,
      selection.source === "binding" ? selection.bindingId : undefined); }
    catch { fail("MEMORY_TEXT_MODEL_UNAVAILABLE", "独立记忆模型的助理或账号绑定不可用"); }
    const defaultModel = selection.model ?? origin.defaultModel ?? null;
    const model = input.model ?? defaultModel;
    const providerRoute = captureProviderRoute?.(origin, model) ?? null;
    const account = productStore.getRuntimeAccount(origin.runtimeAccountId);
    if (!account || account.runtime !== origin.runtime) fail("MEMORY_TEXT_MODEL_UNAVAILABLE", "独立记忆模型账号不可用");
    const providerIdentity = digest([origin.id, origin.selectedBindingId, origin.runtime, origin.runtimeAccountId,
      origin.providerRef, defaultModel, account, providerRoute && { ...providerRoute, provider: { ...providerRoute.provider, modelRef: null } }]);
    const profile = { ...origin, id: input.profileId, defaultModel, permissionPolicy: POLICY,
      runtimeProfileId: `memory-${digest([input.profileId, providerIdentity]).slice(0, 48)}` };
    const fingerprint = digest([projection.revision, selection, owner.id, owner.enabled, providerIdentity, model,
      session && [session.id, session.profileId, session.workspace]]);
    return { profile, session, model, providerRoute, providerIdentity, fingerprint, independent: true,
      assertCurrent() {
        if (resolve(input).fingerprint !== fingerprint) fail("MEMORY_IMPORT_BINDING_STALE", "独立记忆模型配置或来源已变化");
        if (providerRoute) assertProviderRoute?.(providerRoute);
      } };
  };
}

module.exports = { createMemoryTextRouteResolver };
