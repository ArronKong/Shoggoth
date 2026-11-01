"use strict";

const { supports } = require("./runtime-support");
const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const { serviceError } = require("./security");
const { validateSessionRuntimeParams, validateSessionRuntimeResult } = require("./session-runtime-protocol");
const { transcriptEventId } = require("./transcript-store");
const { isDesktopBinding } = require("./codex-desktop-session-store");
const codexSessionProvider = require("./codex-session-provider");

function createSessionRuntimeController({ productStore, chatSessionStore, transcriptStore, coordinator, getCoordinator,
  facts, getNativeRuntimeConfig, ensureTranscript = async () => {}, listBindingModels, policyStore, onChanged = () => {},
  isRetiredRuntimeSession = () => false }) {
  const currentCoordinator = () => getCoordinator ? getCoordinator() : coordinator;
  const isDesktop = session => isDesktopBinding(chatSessionStore.getBinding(session.sessionKey));
  function sessionFor(params) {
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session || session.profileId !== params.profileId) throw serviceError("CHAT_SESSION_NOT_FOUND", "会话不存在");
    return session;
  }
  function isBusy(session, excludingRunId = null) {
    return currentCoordinator().isSessionBusy?.(session.sessionKey, excludingRunId)
      || currentCoordinator().listSessionRuns(session.sessionKey).some(run => run.id !== excludingRunId
        && ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status));
  }
  function assertIdle(session, excludingRunId = null) {
    if (isBusy(session, excludingRunId)) {
      throw serviceError("SESSION_BUSY", "会话仍有排队或运行中的任务");
    }
  }
  // Model source of a choice on one Binding, normalized so that the Profile
  // default is always null. Throws when the source is unavailable.
  function providerSelectionFor(profile, binding, selection) {
    if (selection === undefined || selection === null) return null;
    const resolved = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
    const providerRef = codexSessionProvider.resolveProviderSelection(productStore, resolved, selection);
    return codexSessionProvider.selectionForProviderRef(productStore, resolved, providerRef);
  }
  // A model choice keeps the source it was picked from, stored as an explicit
  // token, so a later change of the Profile default never moves it. Readers
  // that compare with catalog rows normalize it again (providerSelectionFor).
  function pinnedSelectionFor(profile, binding, normalized) {
    const resolved = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
    if (!codexSessionProvider.supportsSessionProviders(resolved)) return normalized;
    return codexSessionProvider.sourceToken(codexSessionProvider.resolveProviderSelection(productStore, resolved, normalized));
  }
  // Codex continues one thread across OpenAI models of the same OpenAI source
  // (its own /model does this), so a model change there keeps the native
  // session, provided that session already ran an accepted turn on exactly that
  // source (runtimeModelSource). Other sources may front several vendors whose
  // private reasoning does not carry over; they, other runtimes, sessions
  // without that record and conversations still recovering a binding start a
  // fresh native session.
  function keepsNativeSessionOnModelChange(profile, binding, session, selection) {
    const record = session.runtimeModelSource;
    if (session.status !== "ready" || session.runtimeBindingId !== binding.id || !session.runtimeSessionId
      || record?.runtimeSessionId !== session.runtimeSessionId) return false;
    try {
      const resolved = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
      if (!codexSessionProvider.supportsSessionProviders(resolved)) return false;
      const providerRef = codexSessionProvider.resolveProviderSelection(productStore, resolved, selection ?? null);
      return record.source === codexSessionProvider.sourceToken(providerRef)
        && ["chatgpt", "openai-api-key"].includes(codexSessionProvider.codexModelProvider(productStore, providerRef).kind);
    } catch { return false; }
  }
  function displaySelection(profile, binding, selection) {
    try { return providerSelectionFor(profile, binding, selection); } catch { return selection; }
  }
  // A thread on a source with its own credential does not need ChatGPT sign-in.
  function skipsOpenaiAuth(profile, binding, selection) {
    try {
      const resolved = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
      if (!codexSessionProvider.supportsSessionProviders(resolved)) return false;
      const providerRef = codexSessionProvider.resolveProviderSelection(productStore, resolved, selection ?? null);
      return !codexSessionProvider.providerRequiresOpenaiAuth(productStore, providerRef);
    } catch { return false; }
  }
  function currentProviderSelection(session, binding) {
    const next = session.nextRuntimeSelection;
    if (next) return next.bindingId === binding.id ? next.modelProviderRef ?? null : null;
    return session.runtimeBindingId === binding.id ? session.modelProviderRef ?? null : null;
  }
  function permissionAdjustment(profile, session, binding) {
    let mode = session.permissionMode ?? null;
    try { resolveRuntimePermissionMode(binding.runtime, mode, profile.permissionPolicy); }
    catch {
      // An unsupported legacy restriction must make the target unavailable;
      // inheriting a writable target default would silently widen access.
      if (!["read-only", "plan", "dontAsk"].includes(mode)) {
        mode = ["full", "always-approve", "bypassPermissions", "danger-full-access"].includes(mode)
          ? "full-access" : ["auto", "workspace-auto", "acceptEdits", "accept-edits"].includes(mode)
            ? "auto-review" : "request-approval";
      }
    }
    return mode;
  }
  async function candidate(profile, session, binding, selectedModel, selectedProvider = undefined) {
    const runtimeProfile = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
    let observed = await facts.read(binding, profile);
    const providerSelection = selectedModel === undefined ? currentProviderSelection(session, binding) : selectedProvider ?? null;
    if (observed.authenticated === false && skipsOpenaiAuth(profile, binding, providerSelection)) {
      observed = { ...observed, authenticated: true };
    }
    const mode = permissionAdjustment(profile, session, binding);
    if (selectedModel !== undefined && listBindingModels) {
      let cursor = null, found = false;
      const cursors = new Set();
      for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
        const page = await listBindingModels({ profileId: profile.id, bindingId: binding.id, cursor, limit: 100 });
        if (page.models.some(model => model.id === selectedModel
          && (model.modelProviderRef ?? null) === (selectedProvider ?? null))) { found = true; break; }
        if (!page.hasMore) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) break;
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      if (!found) throw serviceError("MODEL_ROUTE_UNSUPPORTED", "模型不在所选运行环境目录中");
    }
    const clearModelOverride = selectedModel === undefined && !!session.modelOverride && !observed.models?.includes(session.modelOverride);
    const support = supports({ binding, facts: observed, requirements: {
      model: selectedModel === undefined ? (clearModelOverride ? null : session.modelOverride) ?? runtimeProfile.defaultModel
        : listBindingModels ? null : selectedModel,
      permissionMode: mode, permissionPolicy: profile.permissionPolicy, workspace: session.workspace,
    } });
    return { bindingId: binding.id, support,
      adjustments: { clearModelOverride, permissionMode: mode } };
  }
  async function snapshot(params, { preflight = true } = {}) {
    const session = sessionFor(params);
    const profile = productStore.getAgentProfile(session.profileId);
    const bindings = productStore.getAgentRuntimeBindings(profile.id);
    const current = bindings.bindings.find(binding => binding.id === (session.nextRuntimeSelection?.bindingId ?? session.runtimeBindingId));
    if (!current) throw serviceError("POLICY_REJECTED", "会话缺少 Runtime Binding");
    // Bound discovery is cached and concurrency limited; the pure supports()
    // decision never opens a runtime or performs an authentication request.
    const candidates = await Promise.all(bindings.bindings.map(binding => preflight ? candidate(profile, session, binding)
      : { bindingId: binding.id, support: { supported: false, code: "RUNTIME_FACTS_UNKNOWN" },
        adjustments: { clearModelOverride: false, permissionMode: permissionAdjustment(profile, session, binding) } }));
    const modelProviderRef = displaySelection(profile, current, currentProviderSelection(session, current));
    const runtimeProfile = productStore.resolveAgentRuntimeProfile(profile.id, current.id);
    return validateSessionRuntimeResult({ sessionKey: session.sessionKey, revision: session.revision,
      ...(modelProviderRef ? { modelProviderRef } : {}),
      bindingId: current.id, runtime: current.runtime, model: session.nextRuntimeSelection?.model ?? session.modelOverride ?? runtimeProfile.defaultModel,
      contextUsage: currentCoordinator().getRuntimeContext(session)?.contextUsage ?? null, candidates,
      canSwitch: !isDesktop(session) && getNativeRuntimeConfig().flags.runtimeConversationHandoff === true }, params);
  }
  function auditPending() {
    for (const receipt of chatSessionStore.listPendingRuntimeSwitches?.() || []) {
      const session = chatSessionStore.getSession(receipt.sessionKey);
      if (!session) continue;
      transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
      transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id,
        id: transcriptEventId("runtime-switched", receipt.sessionKey, receipt.revision), kind: "status",
        content: { transcriptType: "runtime.switched", from: receipt.fromBindingId, to: receipt.toBindingId },
        contextExcluded: true, occurredAt: receipt.switchedAt });
      chatSessionStore.markRuntimeSwitchAudited(receipt.sessionKey, receipt.revision);
      const telemetry = currentCoordinator().telemetry;
      if (receipt.fromBindingId !== receipt.toBindingId) {
        telemetry?.record("runtime.binding.changed", { sessionKey: receipt.sessionKey, bindingId: receipt.toBindingId });
        telemetry?.record("session.runtime.switched", { sessionKey: receipt.sessionKey });
      }
    }
  }
  async function switchSession(params, { excludingRunId = null } = {}) {
    auditPending();
    const before = sessionFor(params);
    if (isDesktop(before) && params.bindingId !== before.runtimeBindingId) {
      throw serviceError("CODEX_DESKTOP_RUNTIME_PINNED", "Codex Desktop 原对话需要使用原生 Codex CLI");
    }
    if (!getNativeRuntimeConfig().flags.runtimeConversationHandoff
      && (params.model === undefined || params.bindingId !== before.runtimeBindingId)) {
      throw serviceError("SESSION_RUNTIME_DISABLED", "手动续接尚未启用");
    }
    if (before.revision !== params.revision) throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "会话已更新");
    const profile = productStore.getAgentProfile(before.profileId);
    const target = productStore.getAgentRuntimeBindings(profile.id).bindings.find(binding => binding.id === params.bindingId);
    if (!profile.enabled || !target?.enabled) throw serviceError("POLICY_REJECTED", "Binding 不可用");
    const selectingCurrentModel = params.model !== undefined && target.id === before.runtimeBindingId;
    if (params.model === undefined) assertIdle(before, excludingRunId);
    // The model's source; a different source needs a new native thread.
    const modelProviderRef = params.model === undefined ? undefined
      : providerSelectionFor(profile, target, params.modelProviderRef);
    const pinnedProviderRef = modelProviderRef === undefined ? undefined
      : pinnedSelectionFor(profile, target, modelProviderRef);
    const providerChanging = modelProviderRef !== undefined
      && modelProviderRef !== (target.id === before.runtimeBindingId
        ? displaySelection(profile, target, before.modelProviderRef ?? null) : null);
    const accountGeneration = facts.generation?.(target);
    await ensureTranscript(before);
    const preferences = before.nextRuntimeSelection
      ? { ...before, permissionMode: before.nextRuntimeSelection.permissionMode } : before;
    const preflight = await candidate(profile, preferences, target, params.model, modelProviderRef);
    if (!preflight.support.supported) throw serviceError(preflight.support.code, preflight.support.code);
    const { clearModelOverride, permissionMode } = preflight.adjustments;
    if ((clearModelOverride || permissionMode !== (preferences.permissionMode ?? null)) && !params.acceptAdjustments) {
      throw serviceError("SESSION_RUNTIME_CONFIRMATION_REQUIRED", "需要确认模型或权限设置的变化");
    }
    if (selectingCurrentModel && !providerChanging && !before.nextRuntimeSelection
      && (isBusy(before, excludingRunId) || isDesktop(before))) {
      // A model pick is a next-turn default. Keep the current native session and
      // its immutable run contract; never hand off or reset a streaming turn.
      const current = sessionFor(params);
      const latestProfile = productStore.getAgentProfile(profile.id);
      const latest = productStore.getAgentRuntimeBinding(profile.id, target.id);
      if (current.revision !== before.revision) throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "会话已更新");
      if (accountGeneration !== facts.generation?.(target)) throw serviceError("ACCOUNT_AUTH_UNKNOWN", "账号认证状态已变化");
      if (!latestProfile.enabled || !latest?.enabled || latest.revision !== target.revision
        || JSON.stringify(latestProfile.permissionPolicy) !== JSON.stringify(profile.permissionPolicy)
        || latestProfile.defaultModel !== profile.defaultModel) throw serviceError("POLICY_REJECTED", "Binding 已变化");
      const saved = chatSessionStore.switchRuntime(params.sessionKey, { bindingId: target.id,
        revision: before.revision, model: params.model, modelProviderRef: pinnedProviderRef, permissionMode });
      try { onChanged({ profileId: profile.id, sessionKey: saved.sessionKey }); } catch {}
      return saved;
    }
    if (params.model !== undefined && isBusy(before, excludingRunId)) {
      const current = sessionFor(params);
      const latest = productStore.getAgentRuntimeBinding(profile.id, target.id);
      const latestProfile = productStore.getAgentProfile(profile.id);
      if (current.revision !== before.revision) throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "会话已更新");
      if (accountGeneration !== facts.generation?.(target)) throw serviceError("ACCOUNT_AUTH_UNKNOWN", "账号认证状态已变化");
      if (!latestProfile.enabled || !latest?.enabled || latest.revision !== target.revision
        || JSON.stringify(latestProfile.permissionPolicy) !== JSON.stringify(profile.permissionPolicy)) throw serviceError("POLICY_REJECTED", "Binding 已变化");
      const saved = chatSessionStore.queueRuntimeSelection(params.sessionKey, { bindingId: target.id,
        model: params.model, modelProviderRef: pinnedProviderRef, permissionMode, revision: before.revision });
      try { onChanged({ profileId: profile.id, sessionKey: saved.sessionKey }); } catch {}
      return saved;
    }
    assertIdle(before, excludingRunId);
    const reconciled = await currentCoordinator().reconcileSessionBinding?.(before, { excludingRunId }) ?? before;
    if (reconciled.status !== before.status) await ensureTranscript(reconciled);
    const modelChanging = params.model !== undefined && params.model !== (before.modelOverride ?? profile.defaultModel);
    // A kept native session needs no fresh-session context (or summary) for the target.
    const keepsNativeSession = modelChanging && !providerChanging && reconciled.status === before.status
      && keepsNativeSessionOnModelChange(profile, target, before, modelProviderRef);
    if (!isDesktop(before) && !keepsNativeSession) await currentCoordinator().prepareRuntimeHandoff?.(reconciled, target, {
      model: params.model, clearModelOverride, permissionMode, excludingRunId,
    });
    // Nothing may yield between the last busy check and the CAS. A concurrent
    // send reserves the session even while its inbox encryption is pending.
    const current = sessionFor(params);
    if (accountGeneration !== facts.generation?.(target)) throw serviceError("ACCOUNT_AUTH_UNKNOWN", "账号认证状态已变化");
    assertIdle(current, excludingRunId);
    const latestProfile = productStore.getAgentProfile(profile.id);
    const latest = productStore.getAgentRuntimeBinding(profile.id, target.id);
    if (!latestProfile.enabled || !latest?.enabled || latest.revision !== target.revision
      || JSON.stringify(latestProfile.permissionPolicy) !== JSON.stringify(profile.permissionPolicy)
      || latestProfile.defaultModel !== profile.defaultModel) throw serviceError("POLICY_REJECTED", "Binding 已变化");
    const saved = chatSessionStore.switchRuntime(params.sessionKey, { bindingId: target.id, revision: reconciled.revision,
      clearModelOverride, permissionMode, ...(params.model !== undefined ? { model: params.model, modelProviderRef: pinnedProviderRef,
        renewSession: !isDesktop(before) && (providerChanging || (modelChanging && !keepsNativeSession)) } : {}) });
    auditPending();
    try { onChanged({ profileId: profile.id, sessionKey: saved.sessionKey }); } catch {}
    return saved;
  }
  // A native session created by a retired transport can never be resumed. Move the
  // conversation to a fresh native session of the same Binding; the coordinator
  // seeds it from the transcript like any other handoff.
  function retireUnresumableSession(session) {
    const binding = session.runtimeSessionId
      && productStore.getAgentRuntimeBinding(session.profileId, session.runtimeBindingId);
    if (!binding || !isRetiredRuntimeSession(binding.runtime, session.runtimeSessionId)) return session;
    const renewed = chatSessionStore.switchRuntime(session.sessionKey, { bindingId: session.runtimeBindingId,
      revision: session.revision, clearModelOverride: false, permissionMode: session.permissionMode ?? null });
    auditPending();
    try { onChanged({ profileId: session.profileId, sessionKey: session.sessionKey }); } catch {}
    return renewed;
  }
  // A native thread never resumes on another model source. When the source a
  // conversation uses now differs from the one its native session was created
  // on (e.g. the assistant default moved), continue in a fresh native session
  // of the same Binding; the coordinator seeds it from the transcript.
  function retireSourceChangedSession(session) {
    const record = session.runtimeModelSource;
    if (!record || !session.runtimeSessionId || record.runtimeSessionId !== session.runtimeSessionId) return session;
    let source;
    try {
      const resolved = productStore.resolveAgentRuntimeProfile(session.profileId, session.runtimeBindingId);
      if (!codexSessionProvider.supportsSessionProviders(resolved)) return session;
      source = codexSessionProvider.sourceToken(
        codexSessionProvider.resolveProviderSelection(productStore, resolved, session.modelProviderRef ?? null));
    } catch { return session; } // An unavailable source fails the send itself.
    if (source === record.source) return session;
    const renewed = chatSessionStore.switchRuntime(session.sessionKey, { bindingId: session.runtimeBindingId,
      revision: session.revision, clearModelOverride: false, permissionMode: session.permissionMode ?? null });
    auditPending();
    try { onChanged({ profileId: session.profileId, sessionKey: session.sessionKey }); } catch {}
    return renewed;
  }
  const controller = {
    auditPending,
    async selectForSend(input) {
      auditPending();
      const found = chatSessionStore.getSession(input.sessionKey);
      if (!found) return;
      if (isDesktop(found)) return;
      const canSelect = () => input.excludingRunId
        ? !currentCoordinator().isSessionBusy?.(found.sessionKey, input.excludingRunId)
          && !currentCoordinator().listSessionRuns(found.sessionKey).some(run => run.id !== input.excludingRunId
            && ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status))
        : currentCoordinator().canSelectSessionBeforeSend(found.sessionKey);
      let session = found.nextRuntimeSelection ? found
        : canSelect() ? retireSourceChangedSession(retireUnresumableSession(found)) : found;
      if (session.nextRuntimeSelection && canSelect()) {
        const next = session.nextRuntimeSelection;
        const profile = productStore.getAgentProfile(session.profileId);
        const target = productStore.getAgentRuntimeBinding(profile.id, next.bindingId);
        if (!target?.enabled) throw serviceError("POLICY_REJECTED", "下一轮 Binding 已不可用");
        const generation = facts.generation?.(target);
        const preflight = await candidate(profile, { ...session, permissionMode: next.permissionMode }, target, next.model,
          providerSelectionFor(profile, target, next.modelProviderRef ?? null));
        if (!preflight.support.supported) throw serviceError(preflight.support.code, preflight.support.code);
        await ensureTranscript(session);
        await currentCoordinator().prepareRuntimeHandoff?.(session, target, { model: next.model,
          permissionMode: next.permissionMode, excludingRunId: input.excludingRunId ?? null, beforeSend: true });
        const latest = sessionFor({ profileId: profile.id, sessionKey: session.sessionKey });
        if (latest.revision !== session.revision || generation !== facts.generation?.(target)
          || !canSelect() || JSON.stringify(productStore.getAgentRuntimeBinding(profile.id, target.id)) !== JSON.stringify(target)
          || JSON.stringify(productStore.getAgentProfile(profile.id)) !== JSON.stringify(profile)) {
          throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "下一轮选择依据已变化");
        }
        session = chatSessionStore.switchRuntime(session.sessionKey, { bindingId: target.id, revision: session.revision,
          model: next.model, modelProviderRef: next.modelProviderRef ?? null, permissionMode: next.permissionMode, renewSession: true });
        session = chatSessionStore.setModelSettings(session.sessionKey, next.modelSettings);
        auditPending();
        onChanged({ profileId: profile.id, sessionKey: session.sessionKey });
        return; // Respect this explicit next-turn choice before automatic selection.
      }
      if (!policyStore) return;
      const policy = policyStore.get(session.profileId);
      if (policy.mode === "fixed" || !getNativeRuntimeConfig().flags.runtimeConversationHandoff
        || !canSelect()) return;
      const profile = productStore.getAgentProfile(session.profileId);
      const bindings = productStore.getAgentRuntimeBindings(profile.id).bindings;
      const allowed = bindings.filter(binding => policy.allowedBindingIds.includes(binding.id));
      const generations = new Map(allowed.map(binding => [binding.id, facts.generation?.(binding)]));
      const observed = Object.fromEntries(await Promise.all(allowed.map(async binding => [binding.id, await facts.read(binding, profile)])));
      const selection = require("./runtime-selection-policy").selectRuntimeBinding({ policy, bindings, facts: observed,
        currentBindingId: session.runtimeBindingId, defaultBindingId: profile.defaultBindingId,
        requirements: { model: session.modelOverride ?? profile.defaultModel, permissionMode: session.permissionMode ?? null,
          permissionPolicy: profile.permissionPolicy, workspace: session.workspace,
          attachmentKinds: (input.attachments || []).map(item => item.kind || (item.mimeType?.startsWith("image/") ? "image" : "file")) } });
      if (!selection.bindingId) throw serviceError("RUNTIME_SELECTION_UNAVAILABLE", "没有满足当前要求的已授权 Runtime");
      const target = allowed.find(binding => binding.id === selection.bindingId);
      await ensureTranscript(session);
      if (target.id !== session.runtimeBindingId) await currentCoordinator().prepareRuntimeHandoff?.(session, target, {
        permissionMode: session.permissionMode ?? null, excludingRunId: input.excludingRunId ?? null, beforeSend: true,
      });
      const latest = chatSessionStore.getSession(session.sessionKey);
      const currentProfile = productStore.getAgentProfile(profile.id);
      if (latest.revision !== session.revision || policyStore.get(profile.id).revision !== policy.revision
        || JSON.stringify(currentProfile) !== JSON.stringify(profile)
        || facts.generation?.(target) !== generations.get(target.id)) throw serviceError("RUNTIME_SELECTION_POLICY_STALE", "Runtime 选择依据已变化");
      // A second send must not change the binding selected for the first one.
      if (!canSelect()) return;
      if (target.id !== session.runtimeBindingId) {
        chatSessionStore.switchRuntime(session.sessionKey, { bindingId: target.id, revision: session.revision,
          clearModelOverride: false, permissionMode: session.permissionMode ?? null });
        auditPending();
      }
      transcriptStore.appendEvent({ profileId: profile.id, sessionId: session.id,
        id: transcriptEventId("runtime-selected", session.sessionKey, input.operationId), kind: "status", contextExcluded: true,
        content: { transcriptType: "runtime.selected", bindingId: target.id, reason: selection.reason,
          policyRevision: policy.revision, candidates: selection.candidates }, occurredAt: Date.now() });
      onChanged({ profileId: profile.id, sessionKey: session.sessionKey });
    },
    async followDefault(sessionKey, excludingRunId = null) {
      const owned = chatSessionStore.getSession(sessionKey);
      if (owned && isDesktop(owned)) return owned;
      if (policyStore && owned && policyStore.get(owned.profileId).mode !== "fixed") {
        await controller.selectForSend({ sessionKey, excludingRunId, operationId: `domain-select-${excludingRunId}` });
        return chatSessionStore.getSession(sessionKey);
      }
      const session = chatSessionStore.getSession(sessionKey);
      const profile = productStore.getAgentProfile(session.profileId);
      if (session.runtimeBindingId === profile.defaultBindingId) return session;
      // Background sources never silently clear a model or permission override.
      return switchSession({ profileId: profile.id, sessionKey, bindingId: profile.defaultBindingId,
        revision: session.revision, acceptAdjustments: false }, { excludingRunId });
    },
    async handle(method, input) {
      const params = validateSessionRuntimeParams(method, input);
      if (method === "chat.session.runtime.switch" || method === "chat.session.runtime.model.set") await switchSession(params);
      return snapshot(params, { preflight: !["chat.session.runtime.state", "chat.session.runtime.model.set"].includes(method) });
    },
  };
  return controller;
}

module.exports = { createSessionRuntimeController };
