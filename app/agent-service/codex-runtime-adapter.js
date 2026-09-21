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
  "session.list",
  "session.rename",
  "session.archive",
  "session.unarchive",
  "session.delete",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "models.list",
  "commands.list",
  "commands.execute",
  "account.read",
  "account.login",
  "account.logout",
  "events",
  "serverRequests",
].map((key) => [key, true])));

function adapterError(code, message) {
  return serviceError(code, message);
}

function definedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function codexApprovalPolicy(policy) {
  return policy === "on-failure" ? "on-request" : policy;
}

function permissionParams(policy) {
  return definedProperties({
    approvalPolicy: codexApprovalPolicy(policy?.approvalPolicy),
    sandbox: policy?.sandbox,
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
  }

  get terminated() { return this.host.terminated; }

  get registeredSecrets() {
    return Array.isArray(this.host.registeredSecrets) ? [...this.host.registeredSecrets] : [];
  }

  subscribe(listener) {
    return this.host.subscribe((event) => listener(mapEvent(event)));
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

  async sessionStart(input) {
    const response = await this._sessionStartOrResumeRequest(() => this.host.threadStart(definedProperties({
      threadSource: input.source,
      ephemeral: input.persistent === undefined ? undefined : !input.persistent,
      developerInstructions: input.developerInstructions,
      model: input.model,
      cwd: input.cwd,
      ...permissionParams(input.permissionPolicy),
    })));
    if (typeof input.developerInstructions === "string") {
      this.sessionInstructions.set(response.thread.id, {
        current: input.developerInstructions, applied: input.developerInstructions,
      });
    }
    return mapThreadEnvelope(response);
  }

  async sessionResume(input) {
    const response = await this._sessionStartOrResumeRequest(() => this.host.threadResume(definedProperties({
      threadId: input.sessionId,
      developerInstructions: input.developerInstructions,
      model: input.model,
      cwd: input.cwd,
      ...permissionParams(input.permissionPolicy),
    })));
    if (typeof input.developerInstructions === "string") {
      const previous = this.sessionInstructions.get(response.thread.id);
      this.sessionInstructions.set(response.thread.id, {
        current: input.developerInstructions, applied: previous?.applied,
      });
    }
    return mapThreadEnvelope(response);
  }

  async _sessionStartOrResumeRequest(request) {
    try {
      return await request();
    } catch (error) {
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

  async sessionRead(input) {
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
    let effort = input.thinkingLevel;
    // A null effort in turn/start means "keep the previous override". Resolve
    // the catalog default explicitly when the user selects inherited settings.
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
    const text = typeof input.context === "string" && input.context.length > 0
      ? `${input.context}\n\nCURRENT USER REQUEST\n${input.prompt}`
      : input.prompt;
    return this.host.turnStart({ ...definedProperties({
      threadId: input.sessionId,
      clientUserMessageId: input.operationId,
      input: [{ type: "text", text, text_elements: [] }, ...(input.attachments || [])
        .filter(item => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mimeType))
        .map(item => ({ type: "localImage", path: item.path }))],
      model: input.model,
      effort,
      cwd: input.cwd,
      approvalPolicy: codexApprovalPolicy(input.permissionPolicy?.approvalPolicy),
    }), ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}) });
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
