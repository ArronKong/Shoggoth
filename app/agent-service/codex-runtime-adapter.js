"use strict";

const {
  assertRuntimeAdapter,
  runtimeBinding,
  runtimeCapabilities,
} = require("./runtime-adapter");
const { serviceError } = require("./security");
const { runtimeStageError } = require("./runtime-stage-error");
const { normalizeRuntimeCommands } = require("./runtime-commands");
const { mergeNativeCommands, requireRuntimeCommand } = require("./native-cli-commands");
const { codexRuntimeContextUsage, unknownRuntimeContextUsage } = require("./runtime-context-usage");

const CODEX_COMMANDS = normalizeRuntimeCommands([
  { name: "compact", description: "Compact the current Codex conversation" },
  {
    name: "goal",
    description: "Show, set, pause, resume, or clear the current Codex goal",
    args: "[objective|edit <objective>|pause|resume|clear]",
  },
  { name: "mcp", description: "List MCP servers and tools available to Codex", args: "[verbose]" },
  { name: "skills", description: "List or select an available Codex skill", args: "[skill]" },
  { name: "pwd", description: "Show the current working directory", aliases: ["cwd"] },
]);

const CODEX_CAPABILITIES = runtimeCapabilities(Object.fromEntries([
  "session.start",
  "session.resume",
  "session.read",
  "session.read.scoped",
  "session.list",
  "session.rename",
  "session.archive",
  "session.unarchive",
  "session.delete",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "models.list",
  "model.session.release",
  "model.resolve.toolFree",
  "model.resolve.explicit",
  "model.generate.settings",
  "commands.list",
  "commands.execute",
  "account.read",
  "account.login",
  "account.logout",
  "events",
  "serverRequests",
  "context.usage.exact",
  "context.compact.native",
  "context.compact.auto",
].map((key) => [key, true])));

function adapterError(code, message) {
  return serviceError(code, message);
}

// Stable presentation/routing flags can be forced on by the Runtime. None adds
// a model tool; MCP inventories are checked separately.
const PRESENTATION_FEATURES = Object.freeze(["item_ids", "terminal_resize_reflow",
  "resize_all_images", "tool_search_always_defer_mcp_tools", "tui_app_server"]);

function definedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function codexApprovalPolicy(policy) {
  return policy === "on-failure" ? "on-request" : policy;
}

function approvalsReviewer(mode) {
  return mode == null ? undefined : mode === "auto-review" ? "auto_review" : "user";
}

function assertApprovalsReviewer(input, response) {
  if (input.permissionMode === "auto-review" && response?.approvalsReviewer !== "auto_review") {
    throw adapterError("RUNTIME_APPROVAL_UNAVAILABLE", "Codex did not confirm automatic approval review");
  }
}

function permissionParams(policy, mode) {
  return definedProperties({
    approvalPolicy: codexApprovalPolicy(policy?.approvalPolicy),
    sandbox: policy?.sandbox,
    approvalsReviewer: approvalsReviewer(mode),
  });
}

function mapThread(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return thread;
  const { threadSource, ...rest } = thread;
  return definedProperties({ ...rest, source: threadSource });
}

function mapThreadEnvelope(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  const { thread, ...rest } = response;
  return { ...rest, session: mapThread(thread) };
}

function mapEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  return Object.freeze(definedProperties({
    ...event,
    sessionId: event.sessionId ?? event.threadId,
  }));
}

class CodexRuntimeHandle {
  constructor(binding, host) {
    this.runtime = "codex";
    this.runtimeProfileId = binding.runtimeProfileId;
    this.runtimeAccountId = binding.runtimeAccountId;
    this.capabilities = CODEX_CAPABILITIES;
    this.host = host;
    this.sessionInstructions = new Map();
    this.modelOnlySessions = new Set();
    this.promptLedger = new (require("./native-instruction-delivery").PromptBlockLedger)();
  }

  get terminated() { return this.host.terminated; }

  assertExecutionProviderCurrent() { this.host.assertExecutionProviderCurrent?.(); }

  get registeredSecrets() {
    return Array.isArray(this.host.registeredSecrets) ? [...this.host.registeredSecrets] : [];
  }

  subscribe(listener) {
    return this.host.subscribe((event) => {
      const mapped = mapEvent(event);
      if (mapped.known === true && typeof mapped.sessionId === "string" && mapped.sessionId.length > 0) {
        if (mapped.type === "usage") listener({ known: true, type: "context_usage",
          sessionId: mapped.sessionId, ...(mapped.turnId ? { turnId: mapped.turnId } : {}),
          contextUsage: codexRuntimeContextUsage(mapped.sessionId, mapped) });
        if (mapped.type === "context_compacted") {
          // Compacted history may no longer hold earlier injected rules/context.
          this.promptLedger.reset(mapped.sessionId);
          listener({ known: true, type: "context_compacted", sessionId: mapped.sessionId,
            ...(mapped.turnId ? { turnId: mapped.turnId } : {}),
            contextUsage: unknownRuntimeContextUsage(mapped.sessionId) });
          return;
        }
      }
      listener(mapped);
    });
  }

  subscribeAccountAuth(listener) {
    return this.host.subscribeAccountAuth((event) => listener(mapEvent(event)));
  }

  registerServerRequestHandler(method, handler) {
    return this.host.registerServerRequestHandler(method, (params, context) => handler(
      params && typeof params === "object"
        ? definedProperties({ ...params, sessionId: params.sessionId ?? params.threadId })
        : params,
      context,
    ));
  }

  async resolveModelOnly(input) {
    return require("./runtime-model-resolution").runBoundedModelResolution(input, async signal => {
      const config = await this._isolatedGenerationConfig();
      this.assertExecutionProviderCurrent();
      if (signal.aborted) throw adapterError("MODEL_ONLY_CANCELED", "Model discovery canceled");
      let response;
      try {
        // Keep ownership of the startup response even when cancellation arrives
        // during the RPC, so that its ephemeral thread can still be unloaded.
        try {
          response = await this.host.threadStart({ ephemeral: true, approvalPolicy: "never", sandbox: "read-only", config,
            ...(input.model === undefined ? {} : { model: input.model }) });
        } catch (error) {
          if (error?.code === "RPC_REMOTE_ERROR") throw error;
          // Lost startup acceptance leaves no owned thread ID to release.
          throw adapterError("RUNTIME_STOP_UNCONFIRMED", "Model discovery startup acceptance is unknown");
        }
        await this.assertIsolatedGeneration(response);
        this.assertExecutionProviderCurrent();
        if (signal.aborted) throw adapterError("MODEL_ONLY_CANCELED", "Model discovery canceled");
        return { model: response.model, provider: response.modelProvider };
      } finally {
        if (response?.thread?.id) {
          try {
            const result = await this.host.threadUnsubscribe({ threadId: response.thread.id }, { timeoutMs: 4_000 });
            if (!["notLoaded", "notSubscribed", "unsubscribed"].includes(result?.status)) throw new Error("Unconfirmed unsubscribe");
          } catch { throw adapterError("RUNTIME_STOP_UNCONFIRMED", "Model discovery thread did not unload"); }
        }
      }
    });
  }

  async sessionStart(input) {
    if (input.isolatedGeneration && input.persistent !== false) {
      throw adapterError("MODEL_ONLY_SESSION_INVALID", "Isolated generation requires an ephemeral thread");
    }
    const reviewConfig = input.proactiveReview ? await this._proactiveReviewConfig()
      : input.isolatedGeneration ? await this._isolatedGenerationConfig() : undefined;
    const response = await this._sessionStartOrResumeRequest(() => this.host.threadStart(definedProperties({
      threadSource: input.source,
      ephemeral: input.persistent === undefined ? undefined : !input.persistent,
      developerInstructions: input.developerInstructions,
      model: input.model,
      cwd: input.cwd,
      ...(reviewConfig ? { config: reviewConfig } : {}),
      ...permissionParams(input.permissionPolicy, input.permissionMode),
    })));
    assertApprovalsReviewer(input, response);
    if (typeof input.developerInstructions === "string") {
      this.sessionInstructions.set(response.thread.id, {
        current: input.developerInstructions, applied: input.developerInstructions,
      });
    }
    if (input.proactiveReview) await this.assertProactiveReviewIsolation(response, { requireResponseTool: input.proactiveResponseRequired !== false });
    if (input.isolatedGeneration) {
      this.modelOnlySessions.add(response.thread.id);
      try { await this.assertIsolatedGeneration(response); }
      catch (error) { await this.releaseModelOnlySession({ sessionId: response.thread.id }); throw error; }
    }
    return mapThreadEnvelope(response);
  }

  async releaseModelOnlySession({ sessionId }) {
    if (!this.modelOnlySessions.has(sessionId)) {
      throw adapterError("MODEL_ONLY_SESSION_UNAVAILABLE", "Model-only thread is not owned by this handle");
    }
    try {
      const result = await this.host.threadUnsubscribe({ threadId: sessionId }, { timeoutMs: 4_000 });
      if (!["notLoaded", "notSubscribed", "unsubscribed"].includes(result?.status)) throw new Error("Unconfirmed unsubscribe");
      this.sessionInstructions.delete(sessionId);
      this.modelOnlySessions.delete(sessionId);
      return { sessionId, released: true };
    } catch { throw adapterError("RUNTIME_STOP_UNCONFIRMED", "Model-only thread did not unload"); }
  }

  async sessionResume(input) {
    const reviewConfig = input.proactiveReview ? await this._proactiveReviewConfig() : undefined;
    const response = await this._sessionStartOrResumeRequest(() => this.host.threadResume(definedProperties({
      threadId: input.sessionId,
      excludeTurns: true,
      developerInstructions: input.developerInstructions,
      model: input.model,
      cwd: input.cwd,
      ...(reviewConfig ? { config: reviewConfig } : {}),
      ...permissionParams(input.permissionPolicy, input.permissionMode),
    })));
    assertApprovalsReviewer(input, response);
    if (typeof input.developerInstructions === "string") {
      const previous = this.sessionInstructions.get(response.thread.id);
      this.sessionInstructions.set(response.thread.id, {
        current: input.developerInstructions, applied: previous?.applied,
      });
    }
    if (input.proactiveReview) await this.assertProactiveReviewIsolation(response, { requireResponseTool: input.proactiveResponseRequired !== false });
    return mapThreadEnvelope(response);
  }

  async _sessionStartOrResumeRequest(request) {
    try {
      return await request();
    } catch (error) {
      // Another native client can keep the writer after its turn becomes idle.
      // Retrying or discarding the lock cannot transfer that client's ownership.
      if (error?.code === "RPC_REMOTE_ERROR" && error.remoteClassification === "SESSION_WRITER_BUSY") {
        throw adapterError("RUNTIME_SESSION_WRITER_BUSY", "RUNTIME_SESSION_WRITER_BUSY");
      }
      let diagnostic = "";
      try { diagnostic = error?.startupDiagnostic || this.host.rpc?.stderrDiagnostic?.() || ""; } catch {}
      const stage = /\b(?:BOOTSTRAP_ROLE_REJECTED|BOOTSTRAP_CODE_IDENTITY_(?:TIMEOUT|INVALID))\b/u.test(diagnostic)
        ? "bootstrap_role"
        : /(?:MCP_INITIALIZE_FAILED|BOOTSTRAP_MCP_START_FAILED|MCP_HELPER_[A-Z0-9_]+)/u.test(diagnostic)
          ? "mcp_initialize"
          : "session_start_or_resume";
      throw runtimeStageError(stage, error);
    }
  }

  // isolatedGeneration also disables Shoggoth's own MCP server and project
  // instruction files; its thread has no tool at all.
  async _proactiveReviewConfig({ isolatedGeneration = false } = {}) {
    const config = { "web_search": "disabled" };
    const features = await this._proactiveFeatures(null, { allowDottedNames: true });
    // Disable every feature for this ephemeral review. The built-in product
    // MCP server supplies its one permitted response tool; no shell, browser,
    // plugins, apps, hooks, subagents or image tools are needed. A dotted name
    // cannot be addressed by a config override; the thread check proves it is off.
    for (const feature of features) if (!feature.name.includes(".")) config[`features.${feature.name}`] = false;
    config.project_doc_max_bytes = 0;
    if (typeof this.host.configRead !== "function") {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Cannot inspect Runtime MCP transport configuration");
    }
    const nativeConfig = await this.host.configRead({ includeLayers: false });
    const transports = nativeConfig?.config?.mcp_servers ?? {};
    if (!nativeConfig?.config || typeof nativeConfig.config !== "object" || Array.isArray(nativeConfig.config)
      || !transports || typeof transports !== "object" || Array.isArray(transports)
      || Object.keys(transports).length > 1600) {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Invalid Runtime MCP transport configuration");
    }
    // Runtime inventories also contain plugin and synthesized servers with no
    // user transport table. Creating enabled-only tables for those names makes
    // Codex reject thread/start. Override only actual configuration entries;
    // feature switches and the post-start inventory still prove isolation.
    for (const name of Object.keys(transports)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name)) {
        throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Invalid Runtime MCP identity");
      }
      if (name !== "shoggoth" || isolatedGeneration) config[`mcp_servers.${name}.enabled`] = false;
      else config["mcp_servers.shoggoth.enabled_tools"] = ["proactive_respond"];
    }
    if (isolatedGeneration) {
      // All configured transports and tool features are disabled above. The
      // thread-specific post-start inventory is the execution authority; a
      // global inventory would wait for unrelated user MCP startup/auth.
      config["features.apps"] = false;
      return config;
    }
    let cursor = null; const seen = new Set();
    for (let page = 0; page < 16; page++) {
      const result = await this.host.mcpServerStatusList({ cursor, limit: 100, detail: "toolsAndAuthOnly", threadId: null });
      if (!result || !Array.isArray(result.data)) throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Cannot verify Runtime MCP isolation");
      for (const server of result.data) {
        if (typeof server.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(server.name)) {
          throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Invalid Runtime MCP identity");
        }
        // Keep the Apps switch explicit for older Runtime feature inventories.
        if (server.name === "codex_apps") { config["features.apps"] = false; continue; }
      }
      if (!result.nextCursor) return config;
      if (seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime MCP inventory is incomplete");
  }
  // Codex 0.159 lists namespaced feature names such as "guardianv2.thread_context".
  async _proactiveFeatures(threadId, { allowDottedNames = false } = {}) {
    if (typeof this.host.experimentalFeatureList !== "function") throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime feature inspection is unavailable");
    const name = allowDottedNames ? /^[a-z0-9_]{1,128}(?:\.[a-z0-9_]{1,128}){0,3}$/u : /^[a-z0-9_]{1,128}$/u;
    const features = [], seen = new Set(); let cursor = null;
    for (let page = 0; page < 16; page++) {
      const result = await this.host.experimentalFeatureList({ threadId, cursor, limit: 100 });
      if (!result || !Array.isArray(result.data) || result.data.some(feature => !name.test(feature.name) || typeof feature.enabled !== "boolean")) {
        throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime feature evidence is invalid");
      }
      features.push(...result.data);
      if (!result.nextCursor) return features;
      if (seen.has(result.nextCursor)) break; seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime feature inventory is incomplete");
  }
  async assertProactiveReviewIsolation(response, { requireResponseTool = true } = {}) {
    if (response?.sandbox?.type !== "readOnly" || response.sandbox.networkAccess !== false || response.approvalPolicy !== "on-request") {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime did not confirm restricted sandbox and MCP binding policy");
    }
    const threadId = response.thread.id, features = await this._proactiveFeatures(threadId, { allowDottedNames: true });
    // As with isolated generation, Codex 0.159 reports unified_exec as enabled
    // even when disabled. shell_tool=false removes the actual execution tools;
    // the synthetic native provider fixture asserts the model-visible tool set.
    if (!features.some(feature => feature.name === "shell_tool" && feature.enabled === false)
      || features.some(feature => feature.enabled && feature.name !== "unified_exec" && !PRESENTATION_FEATURES.includes(feature.name))) {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime has an enabled feature outside the review scope");
    }
    const result = await this.host.mcpServerStatusList({ threadId, cursor: null, limit: 100, detail: "toolsAndAuthOnly" });
    if (!result || !Array.isArray(result.data) || result.nextCursor) {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime MCP inventory is incomplete");
    }
    const active = result.data.filter(server => !(server.runtimeStatus === "disabled"
      && (!server.tools || typeof server.tools === "object" && !Array.isArray(server.tools) && Object.keys(server.tools).length === 0)));
    if (active.some(server => server.name !== "shoggoth")) {
      throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime has an MCP server outside the review scope");
    }
    if (requireResponseTool) {
      const server = active[0], tools = server?.tools;
      if (active.length !== 1 || !tools || typeof tools !== "object" || Array.isArray(tools)
        || Object.keys(tools).length !== 1 || Object.values(tools)[0]?.name !== "proactive_respond") {
        throw adapterError("PROACTIVE_RUNTIME_UNVERIFIED", "Runtime did not expose its sole structured response tool");
      }
    }
    return { sandbox: "read-only", network: false, features: features.length, servers: result.data.length };
  }
  // A text-only turn for importing memories: the review restrictions, plus no
  // MCP server at all (not even Shoggoth's) and no project instruction files.
  async _isolatedGenerationConfig() {
    try { return await this._proactiveReviewConfig({ isolatedGeneration: true }); }
    catch (error) {
      if (error?.code !== "PROACTIVE_RUNTIME_UNVERIFIED") throw error;
      throw adapterError("RUNTIME_ISOLATION_UNVERIFIED", "Runtime isolation cannot be configured");
    }
  }
  async assertIsolatedGeneration(response) {
    if (response?.sandbox?.type !== "readOnly" || response.sandbox.networkAccess !== false
      || response.approvalPolicy !== "never") {
      throw adapterError("RUNTIME_ISOLATION_UNVERIFIED", "Runtime did not confirm a read-only sandbox without approvals");
    }
    const threadId = response.thread.id;
    let features;
    try { features = await this._proactiveFeatures(threadId, { allowDottedNames: true }); }
    catch { throw adapterError("RUNTIME_ISOLATION_UNVERIFIED", "Runtime feature inventory is unavailable"); }
    // Codex 0.159 keeps reporting unified_exec as enabled after it is turned
    // off. With shell_tool off it adds no model tool: a local Responses fixture
    // receives only the built-in request_user_input tool for this thread.
    if (!features.some(feature => feature.name === "shell_tool" && feature.enabled === false)
      || features.some(feature => feature.enabled && feature.name !== "unified_exec"
        && !PRESENTATION_FEATURES.includes(feature.name))) {
      throw adapterError("RUNTIME_ISOLATION_UNVERIFIED", "Runtime has an enabled tool feature");
    }
    // Codex 0.149 omits disabled servers; 0.159 lists them as disabled with no tools.
    const result = await this.host.mcpServerStatusList({ threadId, cursor: null, limit: 100, detail: "toolsAndAuthOnly" });
    if (!result || !Array.isArray(result.data) || result.nextCursor || result.data.some(server => server?.runtimeStatus !== "disabled"
      || (server.tools && (typeof server.tools !== "object" || Object.keys(server.tools).length !== 0)))) {
      throw adapterError("RUNTIME_ISOLATION_UNVERIFIED", "Runtime has an MCP server enabled");
    }
  }
  async verifyProactiveReview({ requireResponseTool = true } = {}) {
    const response = await this.sessionStart({ persistent: false, proactiveReview: true,
      proactiveResponseRequired: requireResponseTool,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
      developerInstructions: "Inspect restricted runtime configuration only. No model turn, user data or task execution is authorized." });
    return { verified: true, responseToolRequired: requireResponseTool, runtime: this.runtime, runtimeAccountId: this.runtimeAccountId, sessionId: response.session.id };
  }

  async sessionRead(input) {
    if (input.includeTurns === true && (input.includeItems === false || input.operationId)
      && typeof this.host.threadTurnsList === "function" && typeof this.host.threadItemsList === "function") {
      const response = await this.host.threadRead({ threadId: input.sessionId, includeTurns: false });
      // Inline/ephemeral histories do not have a persisted item cursor. Keep
      // the existing complete read as the stronger operation proof there.
      if (response.thread.historyMode !== "paginated") {
        return mapThreadEnvelope(await this.host.threadRead({ threadId: input.sessionId, includeTurns: true }));
      }
      const reader = require("./codex-thread-history-reader");
      if (input.operationId) {
        return mapThreadEnvelope(await reader.readCodexOperationThread(this.host, response,
          { operationId: input.operationId, turnId: input.turnId ?? null }));
      }
      const turns = await reader.readCodexHistoryTurns(this.host, input.sessionId);
      return mapThreadEnvelope({ ...response, thread: { ...response.thread,
        turns: [...turns.values()].map(turn => ({ ...turn, itemsView: "notLoaded" })) } });
    }
    const response = await this.host.threadRead(definedProperties({
      threadId: input.sessionId,
      includeTurns: input.includeTurns,
    }));
    return mapThreadEnvelope(response);
  }

  async sessionList(input = {}) {
    const response = await this.host.threadList(definedProperties({
      limit: input.limit,
      cursor: input.cursor,
      sourceKinds: ["appServer"],
      archived: input.archived,
      useStateDbOnly: false,
    }));
    if (!response || typeof response !== "object" || !Array.isArray(response.data)) return response;
    return { ...response, data: response.data.map(mapThread) };
  }

  sessionRename(input) {
    return this.host.threadSetName({ threadId: input.sessionId, name: input.name });
  }

  sessionArchive(input) { return this.host.threadArchive({ threadId: input.sessionId }); }
  sessionUnarchive(input) { return this.host.threadUnarchive({ threadId: input.sessionId }); }
  sessionDelete(input) { return this.host.threadDelete({ threadId: input.sessionId }); }

  async turnStart(input) {
    const delivery = require("./native-instruction-delivery");
    const turn = delivery.splitTurnInstructions(delivery.turnInstructions(input));
    // Injected items stay in the thread's history, so unchanged Run rules and
    // dynamic context are not injected again (see PromptBlockLedger); a
    // context_compacted event resets this. The Run ID is sent every turn.
    const plan = this.promptLedger.plan(input.sessionId, { rules: turn.rules,
      context: typeof input.context === "string" ? input.context : "" });
    const turnInstructions = [plan.send.rules, delivery.unchangedBlocksNotice(plan.omitted), turn.run]
      .filter(Boolean).join("\n\n");
    const instructions = this.sessionInstructions.get(input.sessionId);
    if (instructions && instructions.current !== instructions.applied) {
      // 0.149.0 accepts developerInstructions on resume but leaves model-visible
      // history unchanged. Append the current trusted policy before the next turn,
      // never while reattaching to a running turn. Failed injection blocks dispatch.
      await this.host.threadInjectItems({ threadId: input.sessionId, items: [{
        type: "message", role: "developer", content: [{ type: "input_text", text:
          "These are the current Shoggoth developer instructions. They supersede earlier Shoggoth developer instructions; retain the conversation history as context.\n\n"
          + instructions.current }],
      }] });
      instructions.applied = instructions.current;
    }
    if (turnInstructions) {
      await this.host.threadInjectItems({ threadId: input.sessionId, items: [{
        type: "message", role: "developer", content: [{ type: "input_text", text: turnInstructions }],
      }] });
    }
    let effort = input.thinkingLevel;
    // A null effort in turn/start means "keep the previous override". Resolve
    // the catalog default explicitly when the user selects inherited settings.
    // Custom Responses models use the endpoint's settings and need not exist
    // in Codex's GPT catalog. Their inherited effort carries no native override.
    if (effort === null && this.host.modelProviderKind === "custom-responses") effort = undefined;
    if (effort === null) {
      let cursor = null;
      const seen = new Set();
      for (let index = 0; index < 32; index++) {
        const page = await this.host.modelList({ cursor, limit: 100 });
        const model = page.data.find(item => input.model ? item.model === input.model : item.isDefault);
        if (model) { effort = model.defaultReasoningEffort ?? undefined; break; }
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      if (effort === null) throw adapterError("RUNTIME_MODEL_CATALOG_INVALID", "Cannot resolve default reasoning effort");
    }
    if (plan.send.context) {
      // Raw Responses items are model-visible history, separate from the
      // native userMessage projection. Keep dynamic data at user authority;
      // never put memory/transcripts/catalog data into developer instructions.
      // Failed injection must block dispatch rather than omit frozen context.
      await this.host.threadInjectItems({ threadId: input.sessionId, items: [{
        type: "message", role: "user", content: [{ type: "input_text", text: plan.send.context }],
      }] });
    }
    const started = await this.host.turnStart({ ...definedProperties({
      threadId: input.sessionId,
      clientUserMessageId: input.operationId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }, ...(input.attachments || [])
        .filter(item => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mimeType))
        .map(item => ({ type: "localImage", path: item.path }))],
      model: input.model,
      effort,
      cwd: input.cwd,
      approvalPolicy: codexApprovalPolicy(input.permissionPolicy?.approvalPolicy),
      approvalsReviewer: approvalsReviewer(input.permissionMode),
    }), ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}) });
    plan.commit();
    return started;
  }

  turnSteer(input) {
    return this.host.turnSteer({
      threadId: input.sessionId,
      expectedTurnId: input.turnId,
      clientUserMessageId: input.operationId,
      input: [{ type: "text", text: input.message, text_elements: [] }],
    });
  }

  turnInterrupt(input) {
    return this.host.turnInterrupt({ threadId: input.sessionId, turnId: input.turnId });
  }

  modelsList(input) { return this.host.modelList(input); }

  commandsList() {
    return Promise.resolve({ supported: true, reason: null, commands: mergeNativeCommands("codex", CODEX_COMMANDS) });
  }

  async commandExecute(input) {
    const parsed = requireRuntimeCommand(input?.text, (await this.commandsList()).commands, "codex");
    if (parsed.command.name === "pwd") {
      if (parsed.args) throw adapterError("RUNTIME_COMMAND_PARAMS_INVALID", "Usage: /pwd");
      if (typeof input.cwd !== "string" || !input.cwd) {
        throw adapterError("RUNTIME_COMMAND_SESSION_REQUIRED", "A conversation workspace is required");
      }
      return { kind: "output", text: input.cwd, warning: null };
    }
    if (parsed.command.name === "skills") return this._executeSkillsCommand(parsed.args, input);
    if (parsed.command.name === "mcp") return this._executeMcpCommand(parsed.args, input);
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      throw adapterError(
        "RUNTIME_COMMAND_SESSION_REQUIRED",
        "Start the Codex conversation before using this command",
      );
    }
    if (parsed.command.name === "compact") {
      if (parsed.args.length > 0) {
        throw adapterError("RUNTIME_COMMAND_PARAMS_INVALID", "Usage: /compact");
      }
      await this.host.threadCompactStart({ threadId: input.sessionId });
      return { kind: "output", text: "Codex conversation compaction started.", warning: null };
    }
    const goalAction = parsed.args.toLowerCase();
    if (goalAction === "clear") {
      const response = await this.host.threadGoalClear({ threadId: input.sessionId });
      return {
        kind: "output",
        text: response.cleared ? "Codex goal cleared." : "No Codex goal was set.",
        warning: null,
      };
    }
    if (goalAction === "pause" || goalAction === "resume") {
      const current = await this.host.threadGoalGet({ threadId: input.sessionId });
      if (!current.goal) {
        return { kind: "output", text: "No Codex goal is set.", warning: null };
      }
      const status = goalAction === "pause" ? "paused" : "active";
      const response = await this.host.threadGoalSet({ threadId: input.sessionId, status });
      return {
        kind: "output",
        text: `Codex goal ${goalAction}d: ${response.goal.objective}`,
        warning: null,
      };
    }
    if (parsed.args.length > 0) {
      const objective = /^edit(?:\s+|$)/iu.test(parsed.args)
        ? parsed.args.replace(/^edit\s*/iu, "") : parsed.args;
      if (objective.length === 0 || objective.length > 4_000) {
        throw adapterError(
          "RUNTIME_COMMAND_PARAMS_INVALID",
          "Codex goal objectives must contain 1 to 4000 characters",
        );
      }
      const response = await this.host.threadGoalSet({
        threadId: input.sessionId,
        objective,
        status: "active",
      });
      return {
        kind: "output",
        text: `Codex goal set: ${response.goal.objective}`,
        warning: null,
      };
    }
    const response = await this.host.threadGoalGet({ threadId: input.sessionId });
    const goal = response.goal;
    return {
      kind: "output",
      text: goal
        ? `Codex goal (${goal.status}): ${goal.objective}`
        : "No Codex goal is set.",
      warning: null,
    };
  }

  async _executeMcpCommand(args, input) {
    const verbose = args.toLowerCase() === "verbose";
    if (args.length > 0 && !verbose) {
      throw adapterError("RUNTIME_COMMAND_PARAMS_INVALID", "Usage: /mcp [verbose]");
    }
    const response = await this.host.mcpServerStatusList({
      cursor: null,
      detail: verbose ? "full" : "toolsAndAuthOnly",
      limit: 100,
      threadId: input?.sessionId ?? null,
    });
    const servers = response.data.slice(0, 100);
    const lines = [];
    for (const server of servers) {
      const name = String(server.serverInfo?.title || server.name)
        .replace(/\s+/gu, " ").trim().slice(0, 160);
      const toolNames = Object.keys(server.tools || {});
      lines.push(`- ${name} — ${server.authStatus}; ${toolNames.length} tool(s)`);
      if (verbose) {
        for (const toolName of toolNames.slice(0, 100)) {
          lines.push(`  - ${toolName.replace(/\s+/gu, " ").trim().slice(0, 160)}`);
        }
      }
    }
    const rawOutput = lines.length > 0
      ? `Codex MCP servers:\n${lines.join("\n")}`
      : "No Codex MCP servers are configured.";
    const output = rawOutput.slice(0, 12_000).toWellFormed();
    const truncated = typeof response.nextCursor === "string"
      || response.data.length > servers.length || rawOutput.length > output.length
      || (verbose && servers.some((server) => Object.keys(server.tools || {}).length > 100));
    return {
      kind: "output",
      text: output,
      warning: truncated ? "MCP output was truncated." : null,
    };
  }

  async _executeSkillsCommand(args, input) {
    const cwd = typeof input?.cwd === "string" && input.cwd.length > 0 ? input.cwd : null;
    const response = await this.host.skillsList({
      cwds: cwd === null ? [] : [cwd],
      forceReload: false,
    });
    const skills = response.data.flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled !== false);
    if (args.length > 0) {
      const query = args.toLowerCase();
      const skill = skills.find((candidate) => candidate.name.toLowerCase() === query);
      if (!skill) {
        return { kind: "output", text: `Codex skill not found: ${args}`, warning: null };
      }
      return { kind: "prefill", text: `$${skill.name} `, warning: null };
    }
    const lines = skills.slice(0, 100).map((skill) => {
      const description = String(skill.interface?.shortDescription
        || skill.shortDescription || skill.description || "")
        .replace(/\s+/gu, " ").trim().slice(0, 240);
      return description ? `- $${skill.name} — ${description}` : `- $${skill.name}`;
    });
    return {
      kind: "output",
      text: lines.length > 0 ? `Available Codex skills:\n${lines.join("\n")}` : "No Codex skills are available.",
      warning: skills.length > 100 ? "Showing the first 100 skills." : null,
    };
  }

  accountRead(input) { return this.host.accountRead(input); }
  accountLoginStart(input) { return this.host.accountLoginStart(input); }
  accountLoginApiKey(input) { return this.host.accountLoginApiKey(input); }
  accountLoginCancel(input) { return this.host.accountLoginCancel(input); }
  accountLogout(input) { return this.host.accountLogout(input); }
}

class CodexRuntimeAdapter {
  constructor(options = {}) {
    if (!options.runtimePool || ["get"]
      .some((method) => typeof options.runtimePool[method] !== "function")) {
      throw adapterError("RUNTIME_ADAPTER_INVALID", "Codex adapter requires a RuntimePool");
    }
    this.runtimePool = options.runtimePool;
    this.handles = new Map();
    assertRuntimeAdapter(this);
  }

  async acquire(value, options = {}) {
    const binding = runtimeBinding(value);
    if (binding.runtime !== "codex") {
      throw adapterError("RUNTIME_UNSUPPORTED", `Codex adapter cannot run ${binding.runtime}`);
    }
    const host = await this.runtimePool.get(binding, options);
    const key = JSON.stringify([binding.runtimeProfileId, binding.runtimeAccountId]);
    const existing = this.handles.get(key);
    if (existing?.host === host) return existing.handle;
    const handle = Object.freeze(new CodexRuntimeHandle(binding, host));
    const entry = { host, handle };
    this.handles.set(key, entry);
    if (host.terminated && typeof host.terminated.then === "function") {
      Promise.resolve(host.terminated).then(
        () => { if (this.handles.get(key) === entry) this.handles.delete(key); },
        () => { if (this.handles.get(key) === entry) this.handles.delete(key); },
      );
    }
    return handle;
  }

  get(binding, options = {}) {
    return this.runtimePool.get(binding, options);
  }

  stop(value) {
    let runtimeProfileId;
    if (typeof value === "string") {
      runtimeProfileId = value;
    } else {
      const binding = runtimeBinding(value);
      if (binding.runtime !== "codex") {
        throw adapterError("RUNTIME_UNSUPPORTED", `Codex adapter cannot stop ${binding.runtime}`);
      }
      runtimeProfileId = binding.runtimeProfileId;
    }
    for (const [key, entry] of this.handles) {
      if (entry.handle.runtimeProfileId === runtimeProfileId) this.handles.delete(key);
    }
    if (typeof this.runtimePool.stop !== "function") {
      throw adapterError("RUNTIME_STOP_UNAVAILABLE", "Codex RuntimePool does not support targeted stop");
    }
    return this.runtimePool.stop(runtimeProfileId);
  }

  stopAll() {
    this.handles.clear();
    if (typeof this.runtimePool.stopAll !== "function") {
      throw adapterError("RUNTIME_STOP_UNAVAILABLE", "Codex RuntimePool does not support stopAll");
    }
    return this.runtimePool.stopAll();
  }
}

module.exports = {
  CODEX_CAPABILITIES,
  CodexRuntimeAdapter,
};
