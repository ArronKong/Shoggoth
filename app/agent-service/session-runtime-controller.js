"use strict";

const { supports, runtimeSupportFactsForHandle } = require("./runtime-support");
const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const { serviceError } = require("./security");
const { validateSessionRuntimeParams, validateSessionRuntimeResult } = require("./session-runtime-protocol");
const { transcriptEventId } = require("./transcript-store");
const { isDesktopBinding } = require("./codex-desktop-session-store");
const { settingsForModelSwitch } = require("./chat-model-settings");
const codexSessionProvider = require("./codex-session-provider");
const { captureExecutionProviderRoute, assertExecutionProviderRouteCurrent } = require("./execution-provider-route");

const CATALOG_MODEL_REUSE_MS = 60_000;
// Failures that say the queued pick itself cannot run; anything else may succeed on retry.
const QUEUED_PICK_REJECTIONS = new Set(["BINDING_DISABLED", "RUNTIME_NOT_INSTALLED", "RUNTIME_INCOMPATIBLE",
  "RUNTIME_CAPABILITY_UNSUPPORTED", "RUNTIME_RELEASE_DISABLED", "ACCOUNT_NOT_AUTHENTICATED", "MODEL_ROUTE_UNSUPPORTED",
  "PERMISSION_ENFORCEMENT_UNPROVEN", "POLICY_REJECTED", "SESSION_MODEL_PROVIDER_UNAVAILABLE", "CONTEXT_COMPACTION_REQUIRED"]);

function createSessionRuntimeController({ productStore, chatSessionStore, transcriptStore, coordinator, getCoordinator,
  facts, getNativeRuntimeConfig, ensureTranscript = async () => {}, listBindingModels, readConfiguredModel, readChatGptModel, secretStore,
  policyStore, onChanged = () => {},
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
  // Built-in Codex uses null for ChatGPT and a provider ID for other sources.
  // An unresolvable source may be displayed, but cannot be used for a model pick.
  function modelSource(runtimeProfile, selection, selectingModel) {
    if (!codexSessionProvider.supportsSessionProviders(runtimeProfile)) return undefined;
    try {
      const providerRef = codexSessionProvider.resolveProviderSelection(productStore, runtimeProfile, selection ?? null);
      return codexSessionProvider.providerRequiresOpenaiAuth(productStore, providerRef) ? null : providerRef;
    } catch (error) {
      if (selectingModel) throw error;
      return undefined;
    }
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
  async function readCatalogModel(profileId, bindingId, selectedModel, selectedProvider) {
    if (selectedModel === undefined || !listBindingModels) return;
    let cursor = null;
    const cursors = new Set();
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      const page = await listBindingModels({ profileId, bindingId, cursor, limit: 100 });
      const model = page.models.find(entry => entry.id === selectedModel
        && (entry.modelProviderRef ?? null) === (selectedProvider ?? null));
      if (model) return model;
      if (!page.hasMore || !page.nextCursor || cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw serviceError("MODEL_ROUTE_UNSUPPORTED", "模型不在所选运行环境目录中");
  }
  // A model pick re-reads the CLI catalog (OpenCode about 0.4 s each time). A model
  // found recently on the same Binding revision and account generation is reused;
  // a missing model is always read again, and execution still validates the route.
  const catalogModels = new Map();
  async function recentCatalogModel(profileId, binding, selectedModel, selectedProvider) {
    if (selectedModel === undefined || !listBindingModels) return;
    const key = JSON.stringify([profileId, binding.id, binding.revision, facts.generation?.(binding) ?? null,
      selectedModel, selectedProvider ?? null]);
    const recent = catalogModels.get(key);
    if (recent && Date.now() - recent.at < CATALOG_MODEL_REUSE_MS) return recent.model;
    const model = await readCatalogModel(profileId, binding.id, selectedModel, selectedProvider);
    catalogModels.delete(key);
    catalogModels.set(key, { model, at: Date.now() });
    while (catalogModels.size > 256) catalogModels.delete(catalogModels.keys().next().value);
    return model;
  }

  async function candidate(profile, session, binding, selectedModel, selectedProvider = undefined) {
    const runtimeProfile = productStore.resolveAgentRuntimeProfile(profile.id, binding.id);
    const selectingModel = selectedModel !== undefined;
    const providerSelection = selectingModel ? selectedProvider : currentProviderSelection(session, binding);
    const providerRef = modelSource(runtimeProfile, providerSelection, selectingModel);
    let observed, model, assertCurrent;
    if (providerRef && selectingModel && readConfiguredModel) {
      const routeError = () => serviceError("SESSION_MODEL_PROVIDER_UNAVAILABLE", "此会话选择的模型来源已不可用");
      let route;
      try {
        route = captureExecutionProviderRoute({ productStore, secretStore, profile: runtimeProfile,
          modelRef: selectedModel, providerRef });
      } catch { throw routeError(); }
      assertCurrent = () => {
        try { assertExecutionProviderRouteCurrent(route, { productStore, secretStore }); }
        catch { throw routeError(); }
      };
      const executionContract = { ...route, runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId };
      const configuredModel = readConfiguredModel(runtimeProfile, providerRef, selectedModel);
      [observed, model] = await Promise.all([facts.read(binding, profile, { executionContract }), configuredModel]);
      assertCurrent();
    } else if (providerRef === null && selectingModel && readChatGptModel) {
      // The authenticated catalog read also proves runtime availability. Use
      // its handle's capabilities instead of probing the same account and catalog again.
      let match;
      try { match = await readChatGptModel(runtimeProfile, selectedModel); }
      catch (error) {
        if (error?.code === "PROFILE_AUTH_REQUIRED") throw serviceError("ACCOUNT_NOT_AUTHENTICATED", "ACCOUNT_NOT_AUTHENTICATED");
        if (error?.code === "PROFILE_MODEL_NOT_AVAILABLE") throw serviceError("MODEL_ROUTE_UNSUPPORTED", "MODEL_ROUTE_UNSUPPORTED");
        throw error;
      }
      observed = { ...runtimeSupportFactsForHandle(binding, match.host), authenticated: true };
      model = match.model;
      assertCurrent = match.assertCurrent;
    } else {
      const catalogProvider = selectingModel ? providerSelectionFor(profile, binding, selectedProvider) : undefined;
      [observed, model] = await Promise.all([facts.read(binding, profile),
        recentCatalogModel(profile.id, binding, selectedModel, catalogProvider)]);
      if (observed.authenticated === false && providerRef) observed = { ...observed, authenticated: true };
    }
    const mode = permissionAdjustment(profile, session, binding);
    const clearModelOverride = selectedModel === undefined && !!session.modelOverride && !observed.models?.includes(session.modelOverride);
    const support = supports({ binding, facts: observed, requirements: {
      model: selectedModel === undefined ? (clearModelOverride ? null : session.modelOverride) ?? runtimeProfile.defaultModel
        : model ? null : selectedModel,
      permissionMode: mode, permissionPolicy: profile.permissionPolicy, workspace: session.workspace,
    } });
    return { bindingId: binding.id, support,
      adjustments: { clearModelOverride, permissionMode: mode },
      ...(model?.capabilities ? { modelCapabilities: model.capabilities } : {}),
      ...(assertCurrent ? { assertCurrent } : {}) };
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
    const runtimeProfile = productStore.resolveAgentRuntimeProfile(profile.id, current.id);
    const source = currentProviderSelection(session, current);
    const modelProviderRef = displaySelection(profile, current, source);
    let defaultModel = runtimeProfile.defaultModel;
    if (source && codexSessionProvider.supportsSessionProviders(runtimeProfile)) {
      try {
        const providerRef = codexSessionProvider.resolveProviderSelection(productStore, runtimeProfile, source);
        defaultModel = codexSessionProvider.applyProviderRef(productStore, runtimeProfile, providerRef).defaultModel;
      } catch { defaultModel = null; }
    }
    return validateSessionRuntimeResult({ sessionKey: session.sessionKey, revision: session.revision,
      ...(modelProviderRef ? { modelProviderRef } : {}),
      bindingId: current.id, runtime: current.runtime,
      model: (session.nextRuntimeSelection ? session.nextRuntimeSelection.model : session.modelOverride) ?? defaultModel,
      contextUsage: currentCoordinator().getRuntimeContext(session, { measurementOnly: true })?.contextUsage ?? null, candidates,
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
  async function switchSession(params, { excludingRunId = null, freshSession = false } = {}) {
    auditPending();
    const before = sessionFor(params);
    if (freshSession && (before.status !== "draft" || before.runtimeSessionId !== null
      || before.runtimeBindingId !== params.bindingId)) throw serviceError("POLICY_REJECTED", "新会话的模型绑定已变化");
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
    const preflight = await candidate(profile, preferences, target, params.model, pinnedProviderRef);
    if (!preflight.support.supported) throw serviceError(preflight.support.code, preflight.support.code);
    const { clearModelOverride, permissionMode } = preflight.adjustments;
    if ((clearModelOverride || permissionMode !== (preferences.permissionMode ?? null)) && !params.acceptAdjustments) {
      throw serviceError("SESSION_RUNTIME_CONFIRMATION_REQUIRED", "需要确认模型或权限设置的变化");
    }
    const modelSettings = params.model === undefined ? undefined : settingsForModelSwitch(before, preflight.modelCapabilities);
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
      preflight.assertCurrent?.();
      const saved = chatSessionStore.switchRuntime(params.sessionKey, { bindingId: target.id,
        revision: before.revision, model: params.model, modelProviderRef: pinnedProviderRef, permissionMode, modelSettings });
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
      preflight.assertCurrent?.();
      const saved = chatSessionStore.queueRuntimeSelection(params.sessionKey, { bindingId: target.id,
        model: params.model, modelProviderRef: pinnedProviderRef, permissionMode, modelSettings, revision: before.revision });
      try { onChanged({ profileId: profile.id, sessionKey: saved.sessionKey }); } catch {}
      return saved;
    }
    assertIdle(before, excludingRunId);
    const reconciled = await currentCoordinator().reconcileSessionBinding?.(before, { excludingRunId }) ?? before;
    if (reconciled.status !== before.status) await ensureTranscript(reconciled);
    const modelChanging = params.model !== undefined && params.model !== (before.modelOverride ?? profile.defaultModel);
    // A kept native session needs no fresh-session context (or summary) for the target.
    const keepsNativeSession = modelChanging && !providerChanging && reconciled.status === before.status
      && keepsNativeSessionOnModelChange(profile, target, before, pinnedProviderRef);
    // Picking the model already in use on the same Binding and source renews nothing, so it prepares no hand-off.
    const unchangedPick = selectingCurrentModel && !modelChanging && !providerChanging && reconciled.status === before.status;
    if (params.model !== undefined && !freshSession && !isDesktop(before) && !keepsNativeSession && !unchangedPick
      && reconciled.status === "ready" && reconciled.runtimeSessionId) {
      // A pick that would retire a native session becomes the next turn's choice, as a
      // pick during a turn does: the checks above already ran, and only the send hands off
      // to the last pick and renews the native session (selectForSend), so trying several
      // models never hands off once per pick. A conversation with no native session yet
      // switches at once; it has nothing to hand off.
      const current = sessionFor(params);
      if (current.revision !== reconciled.revision) throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "会话已更新");
      if (accountGeneration !== facts.generation?.(target)) throw serviceError("ACCOUNT_AUTH_UNKNOWN", "账号认证状态已变化");
      assertIdle(current, excludingRunId);
      const latestProfile = productStore.getAgentProfile(profile.id);
      const latest = productStore.getAgentRuntimeBinding(profile.id, target.id);
      if (!latestProfile.enabled || !latest?.enabled || latest.revision !== target.revision
        || JSON.stringify(latestProfile.permissionPolicy) !== JSON.stringify(profile.permissionPolicy)
        || latestProfile.defaultModel !== profile.defaultModel) throw serviceError("POLICY_REJECTED", "Binding 已变化");
      preflight.assertCurrent?.();
      const saved = chatSessionStore.queueRuntimeSelection(params.sessionKey, { bindingId: target.id,
        model: params.model, modelProviderRef: pinnedProviderRef, permissionMode, modelSettings, revision: current.revision });
      try { onChanged({ profileId: profile.id, sessionKey: saved.sessionKey }); } catch {}
      return saved;
    }
    if (!freshSession && !isDesktop(before) && !keepsNativeSession && !unchangedPick) await currentCoordinator().prepareRuntimeHandoff?.(reconciled, target, {
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
    preflight.assertCurrent?.();
    const saved = chatSessionStore.switchRuntime(params.sessionKey, { bindingId: target.id, revision: reconciled.revision,
      clearModelOverride, permissionMode, ...(params.model !== undefined ? { model: params.model, modelProviderRef: pinnedProviderRef, modelSettings,
        renewSession: !freshSession && !isDesktop(before) && (providerChanging || (modelChanging && !keepsNativeSession)) } : {}) });
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
  function dropQueuedPick(sessionKey, next) {
    try {
      const latest = chatSessionStore.getSession(sessionKey);
      if (!latest?.nextRuntimeSelection || JSON.stringify(latest.nextRuntimeSelection) !== JSON.stringify(next)) return;
      const dropped = chatSessionStore.dropRuntimeSelection(sessionKey, { revision: latest.revision });
      try { onChanged({ profileId: dropped.profileId, sessionKey }); } catch {}
    } catch { /* a newer pick or change already replaced it */ }
  }
  const controller = {
    auditPending,
    async selectForSend(input) {
      input.assertCurrent?.();
      auditPending();
      const found = chatSessionStore.getSession(input.sessionKey);
      if (!found) return;
      if (isDesktop(found)) return;
      const canSelect = () => input.queuedRunId
        ? currentCoordinator().canSelectSessionForQueuedSend(found.sessionKey, input.queuedRunId)
        : input.excludingRunId
        ? !currentCoordinator().isSessionBusy?.(found.sessionKey, input.excludingRunId)
          && !currentCoordinator().listSessionRuns(found.sessionKey).some(run => run.id !== input.excludingRunId
            && ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status))
        : currentCoordinator().canSelectSessionBeforeSend(found.sessionKey);
      let session = found.nextRuntimeSelection ? found
        : canSelect() ? retireSourceChangedSession(retireUnresumableSession(found)) : found;
      if (session.nextRuntimeSelection && canSelect()) {
        const next = session.nextRuntimeSelection;
        try {
          const profile = productStore.getAgentProfile(session.profileId);
          const target = productStore.getAgentRuntimeBinding(profile.id, next.bindingId);
          if (!target?.enabled) throw serviceError("POLICY_REJECTED", "下一轮 Binding 已不可用");
          const generation = facts.generation?.(target);
          const preflight = await candidate(profile, { ...session, permissionMode: next.permissionMode }, target, next.model,
            next.modelProviderRef ?? null);
          input.assertCurrent?.();
          if (!preflight.support.supported) throw serviceError(preflight.support.code, preflight.support.code);
          await ensureTranscript(session);
          input.assertCurrent?.();
          await currentCoordinator().prepareRuntimeHandoff?.(session, target, { model: next.model,
            permissionMode: next.permissionMode, excludingRunId: input.excludingRunId ?? input.queuedRunId ?? null, beforeSend: true,
            pendingOperationId: input.queuedRunId ? input.operationId : null, signal: input.signal });
          input.assertCurrent?.();
          const latest = sessionFor({ profileId: profile.id, sessionKey: session.sessionKey });
          if (latest.revision !== session.revision || generation !== facts.generation?.(target)
            || !canSelect() || JSON.stringify(productStore.getAgentRuntimeBinding(profile.id, target.id)) !== JSON.stringify(target)
            || JSON.stringify(productStore.getAgentProfile(profile.id)) !== JSON.stringify(profile)) {
            throw serviceError("CHAT_SESSION_REVISION_CONFLICT", "下一轮选择依据已变化");
          }
          preflight.assertCurrent?.();
          session = chatSessionStore.switchRuntime(session.sessionKey, { bindingId: target.id, revision: session.revision,
            model: next.model, modelProviderRef: next.modelProviderRef ?? null, permissionMode: next.permissionMode,
            modelSettings: next.modelSettings, renewSession: true });
          auditPending();
          onChanged({ profileId: profile.id, sessionKey: session.sessionKey });
        } catch (error) {
          // A queued pick this conversation cannot run on is dropped, so it stays on its
          // current model instead of failing every later send. Transient failures keep it.
          if (QUEUED_PICK_REJECTIONS.has(error?.code)) dropQueuedPick(session.sessionKey, next);
          throw error;
        }
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
      input.assertCurrent?.();
      const selection = require("./runtime-selection-policy").selectRuntimeBinding({ policy, bindings, facts: observed,
        currentBindingId: session.runtimeBindingId, defaultBindingId: profile.defaultBindingId,
        requirements: { model: session.modelOverride ?? profile.defaultModel, permissionMode: session.permissionMode ?? null,
          permissionPolicy: profile.permissionPolicy, workspace: session.workspace,
          attachmentKinds: (input.attachments || []).map(item => item.kind || (item.mimeType?.startsWith("image/") ? "image" : "file")) } });
      if (!selection.bindingId) throw serviceError("RUNTIME_SELECTION_UNAVAILABLE", "没有满足当前要求的已授权 Runtime");
      const target = allowed.find(binding => binding.id === selection.bindingId);
      await ensureTranscript(session);
      input.assertCurrent?.();
      if (target.id !== session.runtimeBindingId) await currentCoordinator().prepareRuntimeHandoff?.(session, target, {
        permissionMode: session.permissionMode ?? null, excludingRunId: input.excludingRunId ?? input.queuedRunId ?? null, beforeSend: true,
        pendingOperationId: input.queuedRunId ? input.operationId : null, signal: input.signal,
      });
      input.assertCurrent?.();
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
    selectInspirationModel({ profileId, sessionKey, modelSelection }, runId) {
      const session = sessionFor({ profileId, sessionKey });
      return switchSession({ profileId, sessionKey, ...modelSelection, revision: session.revision, acceptAdjustments: false },
        { excludingRunId: runId, freshSession: true });
    },
    async handle(method, input) {
      const params = validateSessionRuntimeParams(method, input);
      if (method === "chat.session.runtime.switch" || method === "chat.session.runtime.model.set") {
        const change = () => switchSession(params);
        await (currentCoordinator().trackSessionSelectionWrite?.(params.sessionKey, change) ?? change());
      }
      return snapshot(params, { preflight: !["chat.session.runtime.state", "chat.session.runtime.model.set"].includes(method) });
    },
  };
  return controller;
}

module.exports = { createSessionRuntimeController };
