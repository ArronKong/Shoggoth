import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const name = "shoggoth-runtime-bridge";
export const inject = [
  "agentDefaultModel",
  "agents",
  "approval",
  "commands",
  "credentials",
  "llm",
  "permissionPresets",
  "sessionPersistence",
  "sessions",
  "systemPrompt",
  "userQuestions",
];

const PROTOCOL = "shoggoth-dsh-runtime";
const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const WRITE_TOOL_PATTERN = /(?:write|edit|replace|patch|notebook|delete|move|rename|mkdir)/iu;
const SHELL_TOOL_PATTERN = /(?:bash|pwsh|shell|terminal|exec|command)/iu;
const AUTH_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "NVIDIA_API_KEY",
  "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
];

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeString(value, maxBytes = 1024, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value.isWellFormed()
    && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeError(error) {
  const code = safeString(error?.code, 128) ? error.code : "DEEPSEEK_HARNESS_BRIDGE_FAILED";
  const message = safeString(error?.message, 4096)
    ? error.message : "DeepSeek Harness Bridge request failed";
  return { code, message };
}

function turnErrorCode(error) {
  if (error?.status === 401 || ["AUTH", "MISSING_CREDENTIAL"].includes(error?.code)) {
    return "RUNTIME_AUTH_REQUIRED";
  }
  return serializeError(error).code;
}

function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function messageText(message) {
  if (!plain(message) || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function reasoningText(message) {
  if (!plain(message) || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block?.type === "reasoning" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function normalizeUsage(value) {
  const usage = plain(value) ? value : {};
  const number = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  const inputTokens = number(usage.inputTokens);
  const outputTokens = number(usage.outputTokens);
  const cachedInputTokens = number(usage.cacheReadTokens);
  const cacheWriteInputTokens = number(usage.cacheWriteTokens);
  const reasoningOutputTokens = number(usage.reasoningTokens);
  const derivedTotal = inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0
      ? usage.totalTokens : derivedTotal,
  };
}

function modelRef(selection) {
  return `${selection.provider}/${selection.model}`;
}

function parseModelRef(value) {
  if (!safeString(value, 640)) return null;
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return null;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function sessionNotFound(error, sessionId) {
  return error?.name === "SessionPersistenceNotFoundError"
    || (error instanceof Error && error.message === `session "${sessionId}" not found`);
}

function userMessage(id, text, source) {
  return Object.freeze({
    id,
    role: "user",
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    source: Object.freeze(source),
  });
}

function turnStatus(reason) {
  if (reason?.kind === "completed" || reason?.kind === "max-tokens") return "completed";
  if (["aborted", "interrupted", "disposed"].includes(reason?.kind)) return "interrupted";
  return "failed";
}

function toolResultText(event) {
  const block = event?.data?.message?.content?.[0];
  if (block?.type !== "tool-result" || !Array.isArray(block.content)) return "";
  return block.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("");
}

function commandFromToolCall(call) {
  if (!call) return null;
  let input = null;
  try { input = JSON.parse(call.arguments); } catch {}
  if (typeof input?.command === "string") return input.command;
  if (typeof input?.cmd === "string") return input.cmd;
  return `${call.name}(${call.arguments || "{}"})`;
}

export class BridgeRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.pendingServerRequests = new Map();
    this.writeChain = Promise.resolve();
    this.requestChain = Promise.resolve();
    this.nextServerRequest = 0;
    this.closed = false;
    this.ready = false;
  }

  start() {
    this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event));
    this.ctx.on("approval/request", (request) => this.onApprovalRequest(request), { prepend: true });
    this.ctx.on("user-questions/request", (request) => this.onUserQuestionsRequest(request), {
      prepend: true,
    });
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    lines.on("close", () => this.onInputClosed());
    void this.waitUntilReady().catch((error) => this.fatal(error));
  }

  async waitUntilReady() {
    await this.ctx.get("loader")?.await();
    if (this.closed) return;
    this.ready = true;
    await this.write({ type: "ready", protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION });
  }

  onLine(line) {
    if (this.closed) return;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.fatal(bridgeError("DEEPSEEK_HARNESS_FRAME_TOO_LARGE", "Bridge input exceeds its limit"));
      return;
    }
    let message;
    try { message = JSON.parse(line); } catch {
      this.fatal(bridgeError("DEEPSEEK_HARNESS_FRAME_INVALID", "Bridge input is malformed JSON"));
      return;
    }
    if (message?.type === "server_response") {
      this.onServerResponse(message);
      return;
    }
    this.requestChain = this.requestChain.then(() => this.onRequest(message), () => this.onRequest(message));
    this.requestChain.catch((error) => this.fatal(error));
  }

  async onRequest(message) {
    if (!plain(message) || message.type !== "request" || !safeString(message.id, 256)
      || !safeString(message.command, 128) || !plain(message.params || {})) {
      throw bridgeError("DEEPSEEK_HARNESS_REQUEST_INVALID", "Bridge request is invalid");
    }
    try {
      const data = await this.dispatch(message.command, message.params || {});
      await this.write({
        type: "response",
        id: message.id,
        command: message.command,
        success: true,
        data: data ?? {},
      });
      if (message.command === "turn/start") {
        await this.releaseAcceptedTurn(message.params.remoteSessionId, message.params.turnId);
      } else if (message.command === "shutdown") {
        queueMicrotask(() => this.ctx.get("appExit")?.(0));
      }
    } catch (error) {
      await this.write({
        type: "response",
        id: message.id,
        command: message.command,
        success: false,
        error: serializeError(error),
      });
    }
  }

  dispatch(command, params) {
    switch (command) {
      case "models/list": return this.modelsList();
      case "commands/list": return this.commandsList(params);
      case "auth/read": return this.authRead();
      case "session/start": return this.sessionStart(params);
      case "session/resume": return this.sessionResume(params);
      case "session/read": return this.sessionRead(params);
      case "session/delete": return this.sessionDelete(params);
      case "turn/start": return this.turnStart(params);
      case "turn/steer": return this.turnSteer(params);
      case "turn/interrupt": return this.turnInterrupt(params);
      case "shutdown": return this.shutdown();
      default: throw bridgeError("DEEPSEEK_HARNESS_COMMAND_UNSUPPORTED", "Bridge command is unsupported");
    }
  }

  async modelsList() {
    const providers = this.ctx.llm.listProviders();
    const selected = this.ctx.agentDefaultModel.currentSelection();
    const models = [];
    for (const provider of providers) {
      const listed = await this.ctx.llm.listModels(provider.id);
      for (const model of listed) {
        models.push({
          model: `${provider.id}/${model.id}`,
          provider: provider.id,
          modelId: model.id,
          displayName: model.name || `${provider.id}/${model.id}`,
          description: model.description || provider.name || provider.id,
          input: Array.isArray(model.inputModalities) ? [...model.inputModalities] : ["text"],
          isDefault: provider.id === selected.provider && model.id === selected.model,
        });
      }
    }
    if (!models.some((model) => model.isDefault)) {
      models.unshift({
        model: modelRef(selected),
        provider: selected.provider,
        modelId: selected.model,
        displayName: selected.model,
        description: selected.provider,
        input: ["text"],
        isDefault: true,
      });
    }
    return { models };
  }

  commandsList(params) {
    const record = params.remoteSessionId == null ? null : this.sessions.get(params.remoteSessionId);
    if (params.remoteSessionId != null && !safeString(params.remoteSessionId, 256)) {
      throw bridgeError("RUNTIME_SESSION_PARAMS_INVALID", "DeepSeek Harness session id is invalid");
    }
    // ScopedLayers explicitly supports undefined as the global registry view;
    // draft discovery must not create a persisted conversation or run inference.
    return { commands: this.ctx.commands.list(record?.agent), scoped: !!record };
  }

  async authRead() {
    const descriptions = await Promise.all(
      AUTH_ENV_KEYS.map((key) => this.ctx.credentials.describe(key)),
    );
    const records = await this.ctx.credentials.listRecords();
    const credentialPresent = descriptions.some((description) => description?.configured === true)
      || records.length > 0;
    return { authenticated: credentialPresent, credentialPresent };
  }

  validateSessionParams(params) {
    if (!safeString(params.remoteSessionId, 256) || !safeString(params.cwd, 4096)
      || !path.isAbsolute(params.cwd)
      || !safeString(params.developerInstructions ?? "", 1024 * 1024, true)) {
      throw bridgeError("RUNTIME_SESSION_PARAMS_INVALID", "DeepSeek Harness session input is invalid");
    }
    const selection = params.model == null
      ? this.ctx.agentDefaultModel.currentSelection() : parseModelRef(params.model);
    const permissionMode = params.permissionMode || "workspace-write";
    if (!selection) {
      throw bridgeError("RUNTIME_MODEL_UNAVAILABLE", "DeepSeek Harness model reference is invalid");
    }
    if (!["workspace-write", "danger-full-access"].includes(permissionMode)) {
      throw bridgeError("RUNTIME_PERMISSION_POLICY_INVALID", "DeepSeek Harness permission mode is invalid");
    }
    return {
      remoteSessionId: params.remoteSessionId,
      cwd: params.cwd,
      developerInstructions: params.developerInstructions || "",
      selection,
      permissionMode,
    };
  }

  setupAgent(agentCtx, developerInstructions) {
    if (!agentCtx.systemPrompt || typeof agentCtx.systemPrompt.section !== "function") {
      throw bridgeError(
        "DEEPSEEK_HARNESS_API_INCOMPATIBLE",
        "DeepSeek Harness system prompt API is unavailable",
      );
    }
    agentCtx.systemPrompt.section({
      name: "shoggoth:developer-instructions",
      order: 0,
      text: developerInstructions,
      complete: true,
    });
  }

  async createHandle(config, resume) {
    const agentOptions = { provider: config.selection.provider, model: config.selection.model };
    const setup = (agentCtx) => this.setupAgent(agentCtx, config.developerInstructions);
    const handle = resume
      ? await this.ctx.agents.resume({
        resumeSessionId: config.remoteSessionId,
        agentOptions,
        setup,
      })
      : await this.ctx.agents.create({
        sessionId: config.remoteSessionId,
        meta: { cwd: config.cwd },
        agentOptions,
        setup,
      });
    const record = {
      handle,
      agent: handle.agent,
      config,
      key: JSON.stringify([config.cwd, config.developerInstructions, config.selection]),
    };
    this.sessions.set(config.remoteSessionId, record);
    await this.ctx.permissionPresets.set(record.agent.session, config.permissionMode);
    return record;
  }

  async replaceHandle(config, resume) {
    const existing = this.sessions.get(config.remoteSessionId);
    const key = JSON.stringify([config.cwd, config.developerInstructions, config.selection]);
    if (existing?.key === key) return existing;
    if (existing) {
      await existing.agent.whenIdle();
      await this.ctx.sessions.flush(existing.agent.session);
      await existing.handle.dispose();
      this.sessions.delete(config.remoteSessionId);
      resume = true;
    }
    return this.createHandle(config, resume);
  }

  async sessionStart(params) {
    const config = this.validateSessionParams(params);
    const existing = this.sessions.get(config.remoteSessionId);
    if (existing) {
      await this.ctx.permissionPresets.set(existing.agent.session, config.permissionMode);
      return { remoteSessionId: config.remoteSessionId };
    }
    let resume = false;
    try {
      await this.ctx.sessionPersistence.inspect(config.remoteSessionId);
      resume = true;
    } catch (error) {
      if (!sessionNotFound(error, config.remoteSessionId)) throw error;
    }
    const record = await this.createHandle(config, resume);
    if (typeof this.ctx.sessionPersistence.ensureMaterialized === "function") {
      await this.ctx.sessionPersistence.ensureMaterialized(record.agent.session);
    } else {
      await this.ctx.sessions.flush(record.agent.session);
    }
    return { remoteSessionId: config.remoteSessionId };
  }

  async sessionResume(params) {
    const config = this.validateSessionParams(params);
    const record = await this.replaceHandle(config, true);
    await this.ctx.permissionPresets.set(record.agent.session, config.permissionMode);
    return { remoteSessionId: config.remoteSessionId };
  }

  async sessionRead(params) {
    if (!safeString(params.remoteSessionId, 256)) {
      throw bridgeError("RUNTIME_SESSION_PARAMS_INVALID", "DeepSeek Harness session id is invalid");
    }
    const live = this.sessions.get(params.remoteSessionId);
    if (live) await this.ctx.sessions.flush(live.agent.session);
    let inspection;
    try {
      inspection = await this.ctx.sessionPersistence.inspect(params.remoteSessionId);
    } catch (error) {
      if (!live || !sessionNotFound(error, params.remoteSessionId)) throw error;
      inspection = { meta: live.agent.session.header, events: [] };
    }
    return {
      remoteSessionId: params.remoteSessionId,
      createdAt: inspection.meta.createdAt,
      cwd: inspection.meta.cwd || null,
      eventCount: inspection.events.length,
    };
  }

  async sessionDelete(params) {
    if (!safeString(params.remoteSessionId, 256)) {
      throw bridgeError("RUNTIME_SESSION_PARAMS_INVALID", "DeepSeek Harness session id is invalid");
    }
    const active = this.activeTurns.get(params.remoteSessionId);
    if (active) throw bridgeError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active");
    const live = this.sessions.get(params.remoteSessionId);
    let inspection;
    if (live) {
      await this.ctx.sessions.flush(live.agent.session);
      inspection = {
        meta: live.agent.session.header,
      };
      await live.handle.dispose();
      this.sessions.delete(params.remoteSessionId);
    } else {
      inspection = await this.ctx.sessionPersistence.inspect(params.remoteSessionId);
    }
    const location = this.ctx.sessionPersistence.locate(inspection.meta);
    if (!location || location.kind !== "jsonl" || !path.isAbsolute(location.path)) {
      throw bridgeError(
        "DEEPSEEK_HARNESS_SESSION_DELETE_FAILED",
        "DeepSeek Harness session artifact cannot be deleted safely",
      );
    }
    const sessionsRoot = path.resolve(process.env.DSH_HOME, "sessions");
    const target = path.resolve(location.path);
    const relative = path.relative(sessionsRoot, target);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw bridgeError(
        "DEEPSEEK_HARNESS_SESSION_DELETE_FAILED",
        "DeepSeek Harness session artifact escapes managed storage",
      );
    }
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe file");
      fs.unlinkSync(target);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw bridgeError(
          "DEEPSEEK_HARNESS_SESSION_DELETE_FAILED",
          "DeepSeek Harness session artifact could not be deleted safely",
        );
      }
    }
    return {};
  }

  findOperation(events, operationId) {
    const messageId = stableUuid(`shoggoth-dsh-user:${operationId}`);
    const index = events.findIndex((event) => event.type === "user/message"
      && event.data?.id === messageId);
    if (index < 0) return null;
    let start = index;
    while (start > 0 && events[start].type !== "turn/start") start -= 1;
    let end = index;
    while (end < events.length && events[end].type !== "turn/end") end += 1;
    const selected = events.slice(start, Math.min(end + 1, events.length));
    return { messageId, events: selected };
  }

  async turnStart(params) {
    if (!safeString(params.remoteSessionId, 256) || !safeString(params.sessionId, 512)
      || !safeString(params.turnId, 512) || !safeString(params.operationId, 512)
      || !safeString(params.prompt, 1024 * 1024, true)
      || !safeString(params.context ?? "", 4 * 1024 * 1024, true)) {
      throw bridgeError("RUNTIME_TURN_PARAMS_INVALID", "DeepSeek Harness turn input is invalid");
    }
    const record = this.sessions.get(params.remoteSessionId);
    if (!record) throw bridgeError("RUNTIME_SESSION_NOT_FOUND", "DeepSeek Harness session is not active");
    if (this.activeTurns.has(params.remoteSessionId)) {
      throw bridgeError("RUNTIME_SESSION_BUSY", "DeepSeek Harness session is active");
    }
    if (params.prompt.trimStart().startsWith("/")) {
      return this.commandTurnStart(record, params);
    }
    await this.ctx.sessions.flush(record.agent.session);
    let replay = null;
    try {
      const inspection = await this.ctx.sessionPersistence.inspect(params.remoteSessionId);
      replay = this.findOperation(inspection.events, params.operationId);
    } catch (error) {
      if (!sessionNotFound(error, params.remoteSessionId)) throw error;
    }
    const active = {
      remoteSessionId: params.remoteSessionId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      operationId: params.operationId,
      agent: record.agent,
      toolCalls: new Map(),
      accepting: true,
      buffered: [],
      settled: false,
      userMessageId: replay?.messageId || stableUuid(`shoggoth-dsh-user:${params.operationId}`),
      appended: null,
      resolveAppended: null,
    };
    if (replay) {
      this.activeTurns.set(params.remoteSessionId, active);
      queueMicrotask(() => {
        for (const event of replay.events) this.publishMappedEvent(active, event);
      });
      void record.agent.whenIdle().then(
        () => this.ensureTurnSettled(active),
        (error) => this.failTurn(active, error),
      );
      return { turnId: params.turnId, replayed: true };
    }
    active.appended = new Promise((resolve) => { active.resolveAppended = resolve; });
    this.activeTurns.set(params.remoteSessionId, active);
    if (params.context) {
      record.agent.inject(userMessage(
        stableUuid(`shoggoth-dsh-context:${params.operationId}`),
        params.context,
        { kind: "plugin", plugin: "shoggoth-dynamic-context", form: "snapshot", sections: [] },
      ));
    }
    try {
      record.agent.followup(userMessage(active.userMessageId, params.prompt, { kind: "user" }));
      await active.appended;
      await this.ctx.sessions.flush(record.agent.session);
    } catch (error) {
      if (this.activeTurns.get(params.remoteSessionId) === active) {
        this.activeTurns.delete(params.remoteSessionId);
      }
      throw error;
    }
    void record.agent.whenIdle().then(
      () => this.ensureTurnSettled(active),
      (error) => this.failTurn(active, error),
    );
    return { turnId: params.turnId, replayed: false };
  }

  commandTurnStart(record, params) {
    const name = /^\/([a-z0-9][a-z0-9._:-]*)(?:\s|$)/u.exec(params.prompt.trim())?.[1];
    if (!name || !this.ctx.commands.find(record.agent, name)) {
      throw bridgeError("RUNTIME_COMMAND_NOT_FOUND", "DeepSeek Harness command is not available");
    }
    const active = {
      remoteSessionId: params.remoteSessionId, sessionId: params.sessionId,
      turnId: params.turnId, operationId: params.operationId,
      agent: record.agent, toolCalls: new Map(), accepting: true, buffered: [],
      settled: false, commandTurn: true, abortController: new AbortController(),
    };
    this.activeTurns.set(params.remoteSessionId, active);
    const publish = (event) => {
      const value = { known: true, method: "deepseek-harness/command", sessionId: active.sessionId, turnId: active.turnId, ...event };
      if (active.accepting) active.buffered.push(value);
      else void this.write({ type: "event", event: value }).catch((error) => this.fatal(error));
    };
    // Admit immediately to the existing run coordinator. It owns cancellation,
    // approvals and transcript persistence even when the command starts work.
    queueMicrotask(async () => {
      let status = "completed";
      try {
        if (params.context) record.agent.inject(userMessage(
          stableUuid(`shoggoth-dsh-context:${params.operationId}`), params.context,
          { kind: "plugin", plugin: "shoggoth-dynamic-context", form: "snapshot", sections: [] },
        ));
        const execution = await this.ctx.commands.execute(record.agent, params.prompt, [], active.abortController.signal);
        if (!execution) throw bridgeError("RUNTIME_COMMAND_NOT_FOUND", "DeepSeek Harness command disappeared");
        await record.agent.whenIdle();
        await this.ctx.sessions.flush(record.agent.session);
        status = execution.result.kind === "error" ? "failed" : "completed";
        publish({ type: "text", itemId: `deepseek-harness-command-${params.turnId}`, text: execution.result.text || `/${name} completed.`, phase: "final_answer", delivery: "local" });
      } catch (error) {
        status = active.abortController.signal.aborted ? "interrupted" : "failed";
        publish({ type: "text", itemId: `deepseek-harness-command-${params.turnId}`, text: error.message || "Command failed", phase: "final_answer", delivery: "local" });
      } finally {
        if (active.abortController.signal.aborted) status = "interrupted";
        publish({ type: "complete", status });
        active.settled = true;
        if (!active.accepting && this.activeTurns.get(active.remoteSessionId) === active) this.activeTurns.delete(active.remoteSessionId);
      }
    });
    return { turnId: params.turnId, replayed: false };
  }

  async releaseAcceptedTurn(remoteSessionId, turnId) {
    const active = this.activeTurns.get(remoteSessionId);
    if (!active || active.turnId !== turnId) return;
    active.accepting = false;
    for (const event of active.buffered.splice(0)) await this.write({ type: "event", event });
    if (active.settled && this.activeTurns.get(remoteSessionId) === active) {
      this.activeTurns.delete(remoteSessionId);
    }
  }

  async turnSteer(params) {
    if (!safeString(params.remoteSessionId, 256) || !safeString(params.turnId, 512)
      || !safeString(params.message, 1024 * 1024)) {
      throw bridgeError("RUNTIME_TURN_PARAMS_INVALID", "DeepSeek Harness steer input is invalid");
    }
    const active = this.activeTurns.get(params.remoteSessionId);
    if (!active || active.turnId !== params.turnId || active.settled) {
      throw bridgeError("RUNTIME_TURN_NOT_ACTIVE", "DeepSeek Harness turn is not active");
    }
    active.agent.steer(userMessage(
      stableUuid(`shoggoth-dsh-steer:${params.operationId || crypto.randomUUID()}`),
      params.message,
      { kind: "user" },
    ));
    return { turnId: params.turnId };
  }

  async turnInterrupt(params) {
    if (!safeString(params.remoteSessionId, 256) || !safeString(params.turnId, 512)) {
      throw bridgeError("RUNTIME_TURN_PARAMS_INVALID", "DeepSeek Harness interrupt input is invalid");
    }
    const active = this.activeTurns.get(params.remoteSessionId);
    if (!active) return {};
    if (active.turnId !== params.turnId) {
      throw bridgeError("RUNTIME_TURN_STALE", "DeepSeek Harness turn is stale");
    }
    active.abortController?.abort();
    active.agent.cancel({ kind: "user" });
    await active.agent.whenIdle();
    await this.ctx.sessions.flush(active.agent.session);
    return {};
  }

  onSessionEvent(session, event) {
    const active = this.activeTurns.get(session.id);
    if (!active || active.settled) return;
    if (event.type === "user/message" && event.data?.id === active.userMessageId) {
      active.resolveAppended?.();
      active.resolveAppended = null;
    }
    if (event.type === "tool/call") {
      active.toolCalls.set(event.data.callId, {
        name: event.data.name,
        arguments: event.data.arguments,
      });
    }
    this.publishMappedEvent(active, event);
  }

  publishMappedEvent(active, event) {
    const mapped = this.mapEvent(active, event);
    for (const item of mapped) {
      if (active.commandTurn && item.type === "complete") continue;
      if (active.accepting) active.buffered.push(item);
      else void this.write({ type: "event", event: item }).catch((error) => this.fatal(error));
    }
    if (event.type === "turn/end" && !active.commandTurn) {
      active.settled = true;
      if (!active.accepting && this.activeTurns.get(active.remoteSessionId) === active) {
        this.activeTurns.delete(active.remoteSessionId);
      }
    }
  }

  mapEvent(active, event) {
    const base = {
      known: true,
      sessionId: active.sessionId,
      turnId: active.turnId,
    };
    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      const itemId = `deepseek-harness-message-${active.turnId}-${event.data?.step || 0}`;
      if (chunk?.type === "text-delta" && safeString(chunk.text, MAX_TEXT_BYTES, true)) {
        return [{ ...base, method: "deepseek-harness/assistant_chunk", type: "text_delta", itemId, delta: chunk.text }];
      }
      if (chunk?.type === "reasoning-delta" && safeString(chunk.text, MAX_TEXT_BYTES, true)) {
        return [{
          ...base,
          method: "deepseek-harness/assistant_chunk",
          type: "reasoning_delta",
          itemId: `${itemId}-reasoning`,
          delta: chunk.text,
        }];
      }
      return [];
    }
    if (event.type === "assistant/message") {
      const output = [];
      const itemId = `deepseek-harness-message-${active.turnId}-${event.data?.step || 0}`;
      const text = messageText(event.data?.message);
      const reasoning = reasoningText(event.data?.message);
      if (reasoning) output.push({
        ...base,
        method: "deepseek-harness/assistant_message",
        type: "reasoning",
        itemId: `${itemId}-reasoning`,
        text: reasoning,
      });
      if (text) output.push({
        ...base,
        method: "deepseek-harness/assistant_message",
        type: "text",
        itemId,
        text,
        phase: "final_answer",
        delivery: "local",
      });
      if (event.data?.usage) {
        const source = event.data.message?.source || {};
        output.push({
          ...base,
          method: "deepseek-harness/usage",
          type: "usage",
          responseId: `deepseek-harness-response-${active.remoteSessionId}-${event.data?.turn || 0}-${event.data?.step || 0}`,
          provider: safeString(source.provider, 128) ? source.provider : null,
          model: safeString(source.model, 512) ? source.model : null,
          usage: normalizeUsage(event.data.usage),
        });
      }
      return output;
    }
    if (event.type === "tool/call") {
      return [{
        ...base,
        method: "deepseek-harness/tool_call",
        type: "tool_start",
        itemId: event.data.callId,
        toolCallId: event.data.callId,
        tool: {
          kind: "function",
          name: event.data.name,
          status: "in_progress",
          input: event.data.arguments,
        },
      }];
    }
    if (event.type === "tool/result") {
      const callId = event.data?.message?.source?.callId;
      const call = active.toolCalls.get(callId);
      return [{
        ...base,
        method: "deepseek-harness/tool_result",
        type: "tool_result",
        itemId: callId,
        toolCallId: callId,
        tool: {
          kind: "function",
          name: call?.name || "tool",
          status: event.data.error ? "failed" : "completed",
          success: !event.data.error,
          output: toolResultText(event),
          errorCode: event.data.error?.code,
        },
      }];
    }
    if (event.type === "turn/end") {
      const status = turnStatus(event.data?.reason);
      return [{
        ...base,
        method: "deepseek-harness/turn_end",
        type: "complete",
        status,
        ...(status === "failed" ? { errorCode: turnErrorCode(event.data?.reason?.error) } : {}),
      }];
    }
    return [];
  }

  async ensureTurnSettled(active) {
    if (active.settled) return;
    await this.ctx.sessions.flush(active.agent.session);
    if (!active.settled) {
      await this.failTurn(active, bridgeError(
        "DEEPSEEK_HARNESS_TURN_INCOMPLETE",
        "DeepSeek Harness became idle without a durable turn end",
      ));
    }
  }

  async failTurn(active, error) {
    if (active.settled) return;
    active.settled = true;
    if (this.activeTurns.get(active.remoteSessionId) === active) {
      this.activeTurns.delete(active.remoteSessionId);
    }
    await this.write({
      type: "event",
      event: {
        known: true,
        method: "deepseek-harness/error",
        type: "complete",
        sessionId: active.sessionId,
        turnId: active.turnId,
        status: "failed",
        errorCode: turnErrorCode(error),
      },
    });
  }

  async onApprovalRequest(request) {
    const active = request?.agent ? this.activeTurns.get(request.agent.id) : null;
    if (!active || active.settled) return "unavailable";
    const call = request.callId ? active.toolCalls.get(request.callId) : null;
    const fileChange = WRITE_TOOL_PATTERN.test(request.toolName || "")
      && !SHELL_TOOL_PATTERN.test(request.toolName || "");
    const cwd = active.agent?.session?.header?.cwd || process.cwd();
    const method = fileChange
      ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const params = method === "item/fileChange/requestApproval"
      ? {
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: request.callId,
        grantRoot: cwd,
        reason: request.reason || `${request.toolName} requires approval`,
        sessionApprovalAvailable: true,
      }
      : {
        sessionId: active.sessionId,
        turnId: active.turnId,
        itemId: request.callId,
        command: commandFromToolCall(call) || `${request.toolName}()`,
        cwd,
        reason: request.reason || `${request.toolName} requires approval`,
        sessionApprovalAvailable: true,
      };
    try {
      const response = await this.serverRequest(method, params, request.signal);
      if (["accept", "acceptForSession"].includes(response?.decision)) return "allowed-once";
      return response?.decision === "cancel" ? "cancelled" : "rejected";
    } catch {
      return request.signal?.aborted ? "cancelled" : "unavailable";
    }
  }

  async onUserQuestionsRequest(request) {
    const active = request?.agent ? this.activeTurns.get(request.agent.id) : null;
    if (!active || active.settled) throw bridgeError("ASK_UNAVAILABLE", "User input is unavailable");
    const properties = {};
    const required = [];
    for (const question of request.questions || []) {
      if (!safeString(question.id, 128) || !safeString(question.question, 4096)) continue;
      const labels = Array.isArray(question.options)
        ? question.options.map((option) => option?.label).filter((label) => safeString(label, 1024)) : [];
      properties[question.id] = question.multiSelect
        ? { type: "array", title: question.question, items: labels.length ? { type: "string", enum: labels } : { type: "string" } }
        : { type: "string", title: question.question, ...(labels.length ? { enum: labels } : {}) };
      required.push(question.id);
    }
    const response = await this.serverRequest("mcpServer/elicitation/request", {
      sessionId: active.sessionId,
      turnId: active.turnId,
      serverName: "deepseek-harness",
      mode: "form",
      message: "DeepSeek Harness 需要补充信息",
      requestedSchema: { type: "object", properties, required },
    }, request.signal);
    if (response?.action !== "accept" || !plain(response.content)) {
      throw bridgeError("ASK_CANCELLED", "User cancelled the question");
    }
    return {
      answers: (request.questions || []).map((question) => {
        const value = response.content[question.id];
        const selected = Array.isArray(value)
          ? value.filter((item) => typeof item === "string")
          : typeof value === "string" ? [value] : [];
        return { id: question.id, selected };
      }),
    };
  }

  serverRequest(method, params, signal) {
    if (this.closed || signal?.aborted) {
      return Promise.reject(bridgeError("DEEPSEEK_HARNESS_REQUEST_ABORTED", "Bridge request was aborted"));
    }
    const id = `dsh-server-${++this.nextServerRequest}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pendingServerRequests.delete(id);
        reject(bridgeError("DEEPSEEK_HARNESS_REQUEST_ABORTED", "Bridge request was aborted"));
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.pendingServerRequests.set(id, { resolve, reject, signal, abort });
      this.write({ type: "server_request", id, method, params }).catch((error) => {
        this.pendingServerRequests.delete(id);
        if (signal) signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  onServerResponse(message) {
    if (!safeString(message.id, 256) || typeof message.success !== "boolean") return;
    const pending = this.pendingServerRequests.get(message.id);
    if (!pending) return;
    this.pendingServerRequests.delete(message.id);
    if (pending.signal) pending.signal.removeEventListener("abort", pending.abort);
    if (message.success) pending.resolve(message.data);
    else pending.reject(bridgeError(
      safeString(message.error?.code, 128) ? message.error.code : "DEEPSEEK_HARNESS_SERVER_REQUEST_FAILED",
      safeString(message.error?.message, 4096)
        ? message.error.message : "Shoggoth rejected the Bridge request",
    ));
  }

  async shutdown() {
    for (const active of [...this.activeTurns.values()]) {
      active.agent.cancel({ kind: "disposed" });
    }
    for (const record of [...this.sessions.values()]) {
      try { await record.handle.dispose(); } catch {}
    }
    this.sessions.clear();
    return {};
  }

  async write(value) {
    const frame = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_LINE_BYTES) {
      throw bridgeError("DEEPSEEK_HARNESS_FRAME_TOO_LARGE", "Bridge output exceeds its limit");
    }
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      process.stdout.write(frame, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }

  onInputClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingServerRequests.values()) {
      pending.reject(bridgeError("DEEPSEEK_HARNESS_BRIDGE_CLOSED", "Bridge input closed"));
    }
    this.pendingServerRequests.clear();
    const exit = this.ctx.get("appExit");
    const ready = this.ctx.get("appReady");
    if (ready?.onReady) ready.onReady(() => exit?.(0));
    else exit?.(0);
  }

  fatal(error) {
    if (this.closed) return;
    this.closed = true;
    process.stderr.write(`shoggoth-dsh-bridge: ${serializeError(error).message}\n`);
    this.ctx.get("appExit")?.(1);
  }
}

export function apply(ctx) {
  new BridgeRuntime(ctx).start();
}
