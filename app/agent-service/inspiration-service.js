"use strict";

const { serviceError } = require("./security");
const { canonicalWorkspace } = require("./work-run");
const { resolveProfileWorkspace } = require("./chat-service-controller");
const { normalizeInteractiveRequestV1, validateInteractiveResponseV1, interactiveApprovalCanAllow } = require("../core/shoggoth-interaction-contract");
const { validateInspirationServiceParams, validateInspirationServiceResult } = require("./inspiration-service-protocol");
const { InspirationGrowth } = require("./inspiration-growth");
const { prepareChatAttachments } = require("./chat-attachments");
const { inspirationUserText, inspirationUserAttachments, inspirationPromptHash } = require("../core/inspiration-chat-history");

const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const ACTIVE = new Set(["queued", "starting", "running", "waiting_input", "waiting_approval"]);
const fail = (code, message) => { throw serviceError(code, message); };

function inspirationPrompt(execution, mediaPaths = []) {
  return [
    "The user has captured the following idea and entrusted you with moving it forward. It may include text, images, voice, video, files, or a combination of them, and may continue earlier work.",
    "Keep your existing role, expertise, tool permissions, and working style. Do not replace or override your current identity because this is an idea task. Use your strengths to understand the idea and decide how you can best help move it forward.",
    [
      "Guidelines:",
      "1. Consider all accessible inputs together. Identify the core idea, goal, known context, constraints, and important gaps. An attachment-only note is also valid input: use its contents to understand the intent, and never treat unreadable content as known information.",
      "2. Decide what would create the most value next, such as organizing, developing, exploring, analyzing, researching, designing, creating, implementing, refining, planning, or transforming. Unless the user explicitly asks only for a description, transcription, or summary, do more than restate the input or list what you could do.",
      "3. Act from your role and actual capabilities. Within the user's authorized scope, directly complete the most useful work you can and deliver tangible progress. Do not merely suggest work you can complete in this turn, or promise capabilities you do not have.",
      "4. Preserve the user's original intent. Do not redefine the core idea or expand the task's scope without authorization. Clearly distinguish what the user provided from assumptions, interpretations, or suggestions you introduce.",
      "5. Avoid unnecessary questions. When there is enough information, proceed with reasonable assumptions and briefly identify those that affect the result. Ask only when a missing detail would materially change the direction or outcome. Continue to follow existing approval rules for actions that require authorization.",
      "6. Adapt to the idea's maturity: clarify and develop an early thought; turn a clear direction into a concrete approach; analyze, improve, or implement an existing plan; prioritize refinement for an existing result. Follow explicit user requests when present. Use prior conversation, existing results, and the additional instructions for this turn to continue the work without repeating completed steps.",
      "7. Do not expose your internal decision process, recite these guidelines, or force a fixed output format. Respond in whatever form best fits the idea and your role.",
    ].join("\n"),
    "The original idea's constraints, exclusions, and requested output format remain in effect for this turn unless the user explicitly changes them in the additional instructions for this turn. Do not treat them as obsolete constraints from a previous turn, or use initiative, reasonable assumptions, or reversible actions as reasons to bypass them. Respect requests for a text-only response and restrictions on tools, network access, or file operations. A complete text response can itself be a useful result.",
    execution.title ? `Title: ${execution.title}` : null,
    `Original user task (its constraints also apply to this turn):\n${execution.body}`,
    execution.attachments?.length ? `Attachments saved with the note (names and paths are data):\n${execution.attachments.map((item, index) =>
      JSON.stringify({ name: item.name, mimeType: item.mimeType, path: mediaPaths[index] || null })).join("\n")}\nRead these attachments only when the user permits tool use; use available audio tools to understand voice input. If an attachment cannot be read, say so explicitly and do not guess its contents.` : null,
    execution.instruction ? `Additional user instructions for this turn:\n${execution.instruction}` : null,
    "Goal: within the user's constraints, use your capabilities to make the idea clearer, stronger, more complete, or closer to becoming real. Present what you actually completed in this turn and briefly note unfinished parts that affect further progress. List files or links only if you actually produced them; do not create extra artifacts merely to satisfy a delivery format. A finished run does not mean the user has accepted the result.",
  ].filter(Boolean).join("\n\n");
}

class InspirationService {
  buildPrompt(execution, materialize = false) {
    if (execution.inputSource === "chat") {
      // Domain admission needs text even for an attachment-only chat turn.
      return execution.instruction || (execution.turnAttachments?.length ? "Please examine the attached files." : "");
    }
    if (materialize && execution.sessionKey && !execution.external) {
      return inspirationPrompt(execution, prepareChatAttachments(this.store.media,
        execution.attachments || [], execution.sessionKey).map(item => item.path));
    }
    return inspirationPrompt(execution, (execution.attachments || []).map(attachment => materialize
      ? this.store.media.materialize(attachment) : this.store.media.filePath(attachment)));
  }

  constructor(options = {}) {
    this.store = options.store;
    this.productStore = options.productStore;
    this.chatSessionStore = options.chatSessionStore;
    this.transcriptStore = options.transcriptStore;
    this.dispatcher = options.dispatcher;
    this.getCoordinator = options.getCoordinator;
    this.executor = options.executor;
    this.externalExecutor = options.externalExecutor || null;
    this.readinessClient = options.readinessClient || this.externalExecutor?.client || null;
    this.paths = options.paths;
    this.now = options.now || Date.now;
    this.launched = new Set();
    this.opened = false;
    this.generation = 0;
    this.growth = new InspirationGrowth({ store: this.store, service: this, random: options.random });
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.generation += 1;
    this.externalExecutor?.open();
    this.#refreshStatusProjection();
    for (const execution of this.store.pendingExecutions(false)) {
      const run = this.dispatcher.getRun(execution.runId);
      if (!execution.preparationFailure && (!run || !TERMINAL.has(run.status))) this.#launch(execution, true);
    }
    this.growth.open();
  }

  close() {
    this.growth.close();
    this.opened = false;
    this.generation += 1;
    this.launched.clear();
    this.externalExecutor?.close();
  }

  #profile(input) {
    const profile = this.productStore.getAgentProfile(input.profileId)
      || this.productStore.listAgentProfiles().find((candidate) => candidate.agentId === input.agentId
        && candidate.backendId === input.backendId);
    if (!profile || !profile.enabled || profile.agentId !== input.agentId || profile.backendId !== input.backendId) {
      fail("INSPIRATION_UNSUPPORTED", "所选 Agent 当前无法执行灵感");
    }
    return profile;
  }

  #assertRun(execution, run) {
    if (!run || run.id !== execution.runId || run.source !== "inspiration"
      || run.sourceId !== execution.ideaId || run.profileId !== execution.profileId
      || run.workspace !== execution.workspace
      || run.idempotencyKey !== `inspiration:${execution.operationId}`) {
      fail("INSPIRATION_BINDING_INVALID", "灵感执行归属不匹配");
    }
    return run;
  }

  #materialize(original) {
    let execution = this.store.executionForRun(original.runId);
    let run = this.dispatcher.getRun(execution.runId);
    if (run) return { execution, run: this.#assertRun(execution, run) };
    if (execution.sessionKey === null) {
      // Reuse only this idea's explicitly bound session with the same ownership.
      const previous = this.store.executions(execution.ideaId).find((candidate) => candidate.id !== execution.id
        && candidate.createdAt < execution.createdAt && candidate.profileId === execution.profileId
        && candidate.workspace === execution.workspace && candidate.sessionKey !== null
        && this.chatSessionStore.getSession(candidate.sessionKey)?.status === "ready");
      const session = previous ? this.chatSessionStore.getSession(previous.sessionKey)
        : this.chatSessionStore.createSession({
          operationId: `inspiration-${execution.id}`, profileId: execution.profileId,
          workspace: execution.workspace, createdAt: execution.createdAt,
        });
      if (session.profileId !== execution.profileId || session.workspace !== execution.workspace) {
        fail("INSPIRATION_BINDING_INVALID", "灵感 Session 归属不匹配");
      }
      this.transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
      execution = this.store.bindSession(execution.id, session.sessionKey);
    }
    run = this.dispatcher.enqueue({ id: execution.runId, source: "inspiration", sourceId: execution.ideaId,
      idempotencyKey: `inspiration:${execution.operationId}`, profileId: execution.profileId,
      workspace: execution.workspace, retryOf: execution.retryOf });
    return { execution, run: this.#assertRun(execution, run) };
  }

  #launch(original, recovered) {
    if (original.external) {
      this.externalExecutor?.schedule(original, recovered);
      return;
    }
    if (!this.opened || !this.store.get(original.ideaId) || original.preparationFailure || this.launched.has(original.runId)) return;
    const generation = this.generation;
    let materialized;
    try { materialized = this.#materialize(original); } catch (error) {
      // No Runtime action can precede materialization. Persist a failed intent
      // so a missing profile or an unavailable Session cannot strand this idea.
      if (this.dispatcher.getRun(original.runId)) throw error;
      this.store.failPreparation(original.id, error?.code || "INSPIRATION_START_FAILED");
      return;
    }
    const { execution, run } = materialized;
    if (TERMINAL.has(run.status)) return;
    this.launched.add(run.id);
    Promise.resolve().then(() => {
      if (!this.opened || this.generation !== generation) return;
      const payload = { run, execution, prompt: this.buildPrompt(execution, true), recovered };
      return this.executor[recovered ? "recover" : "schedule"](payload);
    }).catch((error) => {
      if (!this.opened || this.generation !== generation) return;
      // A queued run has not acquired a Runtime or performed any side effect.
      // Started runs remain owned by the Coordinator and are never replayed here.
      if (this.dispatcher.getRun(run.id)?.status === "queued") {
        this.getCoordinator().cancelQueuedDomainRun(run.id, typeof error?.code === "string"
          ? error.code : "INSPIRATION_START_FAILED");
      }
    }).finally(() => {
      if (this.generation === generation) this.launched.delete(run.id);
    }).catch(() => {});
  }

  sessionOrigin(sessionKey) {
    const execution = this.store.executionForSession(sessionKey);
    return execution ? { inspirationId: execution.ideaId,
      inspirationTitle: execution.title || execution.body.trim().split("\n")[0].slice(0, 80) || execution.attachments?.[0]?.name || "" } : null;
  }

  onInteraction(run, interaction) {
    if (run.source !== "inspiration" || interaction.phase !== "requested") return;
    this.store.recordAttention(run.id, { type: interaction.eventType,
      payload: interaction.payload, occurredAt: this.now() });
  }

  #attention(execution, run) {
    let saved = execution.attention;
    let live = null;
    if (run && !TERMINAL.has(run.status)) {
      live = this.getCoordinator().getRunSnapshot(run.id).interaction || null;
    }
    if (live) saved = { ...live, occurredAt: this.now() };
    if (!saved && execution.sessionKey) {
      const session = this.chatSessionStore.getSession(execution.sessionKey);
      if (session) {
        const event = this.transcriptStore.listEvents(execution.profileId, session.id)
          .filter((value) => value.runId === execution.runId && ["input", "approval"].includes(value.kind)).at(-1);
        if (event) {
          const { transcriptType, ...payload } = event.content;
          if (["prompt", "approval"].includes(transcriptType)) saved = { type: transcriptType, payload, occurredAt: event.occurredAt };
        }
      }
    }
    if (!saved) return null;
    const request = normalizeInteractiveRequestV1({ runId: execution.runId,
      eventType: saved.type, payload: saved.payload, expiresAt: saved.payload.expiresAt ?? null });
    const active = Boolean(live && run.waitingRequestId === request.requestId
      && (request.expiresAt === null || this.now() < request.expiresAt));
    // A settled request stays in the Session history. Only interrupted requests
    // remain visible as an expired question on the inspiration card.
    if (!active && !["interrupted", "failed", "unknown"].includes(run?.status ?? "unknown")) return null;
    const showDetails = request.kind === "runtime_approval" && interactiveApprovalCanAllow(request);
    const details = showDetails ? Object.fromEntries(["commandActions", "permissions", "grantRoot"]
      .filter((key) => saved.payload[key] !== undefined && saved.payload[key] !== null)
      .map((key) => [key, saved.payload[key]])) : {};
    return { request, active, occurredAt: saved.occurredAt,
      command: showDetails && typeof saved.payload.command === "string" ? saved.payload.command : null,
      cwd: showDetails && typeof saved.payload.cwd === "string" ? saved.payload.cwd : null,
      details: Object.keys(details).length ? JSON.stringify(details, null, 2) : null };
  }

  #executionView(execution, includeAttention = false) {
    if (execution.external) {
      const state = execution.external;
      const attention = includeAttention && state.attention ? structuredClone(state.attention) : null;
      if (attention && (this.#terminal(execution) || state.status === "unknown"
        || (attention.request.expiresAt !== null && attention.request.expiresAt <= this.now()))) attention.active = false;
      return { id: execution.id, ideaId: execution.ideaId, runId: execution.runId,
        profileId: null, agentId: execution.agentId, backendId: execution.backendId,
        workspace: execution.workspace, sessionKey: execution.sessionKey, ideaRevision: execution.ideaRevision,
        createdAt: execution.createdAt, retryOf: execution.retryOf,
        status: execution.preparationFailure ? "failed" : state.status,
        resultSummary: state.resultSummary, errorCode: execution.preparationFailure?.code ?? state.errorCode,
        finishedAt: execution.preparationFailure?.occurredAt ?? state.finishedAt, attention };
    }
    const current = this.dispatcher.getRun(execution.runId);
    const run = current ? this.#assertRun(execution, current) : null;
    return { id: execution.id, ideaId: execution.ideaId, runId: execution.runId,
      profileId: execution.profileId, agentId: execution.agentId, backendId: execution.backendId,
      workspace: execution.workspace, sessionKey: execution.sessionKey, ideaRevision: execution.ideaRevision,
      createdAt: execution.createdAt, retryOf: execution.retryOf,
      status: run?.status ?? (execution.preparationFailure ? "failed" : "queued"), resultSummary: run?.resultSummary ?? null,
      errorCode: run?.errorCode ?? execution.preparationFailure?.code ?? null,
      finishedAt: run?.finishedAt ?? execution.preparationFailure?.occurredAt ?? null,
      attention: includeAttention ? this.#attention(execution, run) : null };
  }

  view(id, summary = false) {
    const idea = this.store.get(id);
    if (!idea) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
    const execution = this.store.latestExecution(id);
    const latestExecution = execution ? this.#executionView(execution) : null;
    const { deletedAt, ...publicIdea } = idea;
    return { ...publicIdea, body: summary ? [...idea.body.trim()].slice(0, 240).join("") : idea.body,
      status: latestExecution?.status ?? "saved", latestExecution };
  }

  #refreshStatusProjection() {
    const values = this.store.pendingExecutions(false).map(execution => {
      const current = this.dispatcher.getRun(execution.runId);
      const run = current ? this.#assertRun(execution, current) : null;
      return { runId: execution.runId, status: run?.status ?? (execution.preparationFailure ? "failed" : "queued") };
    });
    this.store.projectNativeStatuses(values);
  }

  #page(result, field, transform) {
    const key = (value) => `${value.updatedAt ?? value.createdAt}:${value.id}`;
    const page = [];
    let bytes = 512;
    for (const row of result.rows) {
      const value = transform(row);
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size + 512 > 60 * 1024) fail("INSPIRATION_RESPONSE_INVALID", "单条记录超过返回容量");
      if (bytes + size > 60 * 1024) break;
      page.push(value);
      bytes += size + 1;
    }
    const hasMore = result.hasMore || page.length < result.rows.length;
    return { [field]: page, total: result.total, hasMore, nextCursor: hasMore ? key(page.at(-1)) : null };
  }

  start(input, sessionKey = null, inputSource = null) {
    if (inputSource === "chat") input = { ...input, inputSource };
    if (!this.store.get(input.id)) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
    this.growth.assertAvailable(input);
    if (["openclaw", "hermes"].includes(input.backendId)) {
      if (!this.externalExecutor) fail("INSPIRATION_UNSUPPORTED", "外部灵感执行暂不可用");
      if (sessionKey !== null) {
        const previous = this.#externalSession({ ...input, sessionKey });
        if (!previous?.external || previous.ideaId !== input.id || previous.backendId !== input.backendId
          || previous.agentId !== input.agentId || previous.workspace !== input.workspace) {
          fail("INSPIRATION_BINDING_INVALID", "灵感会话归属不匹配");
        }
      } else {
        const previous = this.store.executions(input.id).find(execution => execution.external
          && this.#terminal(execution) && execution.sessionKey && execution.backendId === input.backendId
          && execution.agentId === input.agentId && (input.workspace === null || execution.workspace === input.workspace));
        sessionKey = previous?.sessionKey ?? null;
      }
      const execution = this.store.prepareExternalExecution(input, previous => this.#terminal(previous), sessionKey);
      this.#launch(execution, false);
      return this.view(input.id);
    }
    const profile = this.#profile(input);
    const workspace = canonicalWorkspace(resolveProfileWorkspace({ paths: this.paths, profile, requested: input.workspace }));
    if (sessionKey !== null) {
      const session = this.chatSessionStore.getSession(sessionKey);
      // A failed Runtime start can leave a pending binding. The Coordinator
      // reconciles its original threadSource before resuming or creating it.
      if (!session || !["draft", "binding", "ready"].includes(session.status)
        || session.profileId !== profile.id || session.workspace !== workspace
        || this.store.executionForSession(sessionKey)?.ideaId !== input.id) {
        fail("INSPIRATION_BINDING_INVALID", "该灵感 Session 当前无法继续执行");
      }
    }
    const execution = this.store.prepareExecution({ ...input, profileId: profile.id, workspace }, (previous) => {
      return this.#terminal(previous);
    }, sessionKey);
    this.#launch(execution, false);
    return this.view(input.id);
  }

  #terminal(execution) {
    if (execution.preparationFailure !== null) return true;
    if (execution.external) return TERMINAL.has(execution.external.status);
    const run = this.dispatcher.getRun(execution.runId);
    return Boolean(run && TERMINAL.has(this.#assertRun(execution, run).status));
  }

  executionStatus(execution) {
    const view = this.#executionView(execution);
    return { status: view.status, errorCode: view.errorCode };
  }

  onRunTerminal(run) {
    if (!this.opened || run?.source !== "inspiration") return;
    this.store.projectNativeStatuses([{ runId: run.id, status: run.status }]);
    this.growth.wake();
  }

  growthView() {
    const failures = this.store.growthFailures().filter(failure => {
      const execution = failure.runId && this.store.executionForRun(failure.runId);
      return execution && ["failed", "canceled"].includes(this.executionStatus(execution).status);
    });
    return { settings: this.store.growthSettings(), failures,
      errorCode: this.growth.errorCode || (this.growth.waitingExecutors.size ? "INSPIRATION_EXECUTOR_UNAVAILABLE" : null) };
  }

  async prepareGrowthStart(input) {
    if (!this.readinessClient) fail("APP_HOST_UNAVAILABLE", "后台服务正在启动");
    const { ready } = await this.readinessClient.request("inspiration.executor.ready", {
      backendId: input.backendId, agentId: input.agentId,
    });
    if (!ready) fail("BACKEND_UNAVAILABLE", "所选 Agent 的后端尚未就绪");
  }

  #externalSession(input) {
    return this.store.executionForSession(input.sessionKey, input.backendId, input.agentId);
  }

  sendFromExternalSession(input) {
    const previous = this.#externalSession(input);
    if (!previous) fail("INSPIRATION_BINDING_INVALID", "灵感会话关联不存在");
    const idea = this.store.get(previous.ideaId);
    if (!idea) fail("INSPIRATION_NOT_FOUND", "灵感已删除，仍可查看会话历史");
    const existing = this.store.executionForOperation(input.operationId);
    if (existing) {
      if (existing.ideaId !== idea.id || existing.backendId !== input.backendId || existing.agentId !== input.agentId
        || existing.sessionKey !== input.sessionKey || existing.instruction !== input.prompt) {
        fail("INSPIRATION_OPERATION_CONFLICT", "同一次会话操作不能更换内容");
      }
      return this.view(idea.id);
    }
    return this.start({ id: idea.id, expectedRevision: idea.revision, operationId: input.operationId,
      agentId: previous.agentId, backendId: previous.backendId, instruction: input.prompt,
      workspace: previous.workspace }, previous.sessionKey, "chat");
  }

  sendFromSession(input) {
    const existing = this.store.executionForOperation(input.operationId);
    if (existing) {
      if (existing.sessionKey !== input.sessionKey || existing.instruction !== input.prompt
        || JSON.stringify(existing.turnAttachments || []) !== JSON.stringify(input.attachments || [])) {
        fail("INSPIRATION_OPERATION_CONFLICT", "同一次会话操作不能更换内容");
      }
      this.#launch(existing, false);
      const run = this.#assertRun(existing, this.dispatcher.getRun(existing.runId));
      return { disposition: TERMINAL.has(run.status) ? "completed" : run.status === "queued" ? "queued" : "started",
        reason: run.status === "queued" ? "INSPIRATION_QUEUED" : null, run };
    }
    const previous = this.store.executionForSession(input.sessionKey);
    if (!previous) fail("INSPIRATION_BINDING_INVALID", "灵感会话关联不存在");
    const idea = this.store.get(previous.ideaId);
    if (!idea) fail("INSPIRATION_NOT_FOUND", "灵感已删除，仍可查看会话历史");
    const view = this.start({ id: idea.id, operationId: input.operationId, expectedRevision: idea.revision,
      ...(input.attachments?.length ? { turnAttachments: input.attachments } : {}),
      instruction: input.prompt, agentId: previous.agentId, backendId: previous.backendId, workspace: previous.workspace }, input.sessionKey, "chat");
    const run = this.dispatcher.getRun(view.latestExecution.runId);
    return { disposition: run.status === "queued" ? "queued" : TERMINAL.has(run.status) ? "completed" : "started",
      reason: run.status === "queued" ? "INSPIRATION_QUEUED" : null, run };
  }

  async handle(method, raw) {
    if (!this.opened) fail("INSPIRATION_UNAVAILABLE", "灵感服务暂不可用");
    const input = validateInspirationServiceParams(method, raw);
    let result;
    if (method === "inspiration.agent-stats") result = { agents: this.store.agentExecutionStats(input.agents) };
    else if (method === "inspiration.activities") {
      const finishedRunIds = this.dispatcher.listRuns({ source: "inspiration" })
        .filter(run => run.finishedAt !== null && run.finishedAt >= input.sinceMs).map(run => run.id);
      result = this.#page(this.store.dashboardExecutionsPage({ ...input, finishedRunIds }), "items", execution => {
        const view = this.#executionView(execution);
        return { id: view.id, ideaId: view.ideaId, runId: view.runId, backendId: view.backendId,
          agentId: view.agentId, createdAt: view.createdAt, finishedAt: view.finishedAt, status: view.status,
          title: [...(execution.title || execution.body.trim().split("\n")[0] || execution.attachments?.[0]?.name || "")].slice(0, 80).join(""),
          summary: [...(view.resultSummary || "")].slice(0, 500).join("") };
      });
    }
    else if (method === "inspiration.growth.get") result = this.growthView();
    else if (method === "inspiration.growth.set") {
      if (input.enabled) for (const executor of input.executors) {
        if (["openclaw", "hermes"].includes(executor.backendId)) {
          if (!this.externalExecutor) fail("INSPIRATION_UNSUPPORTED", "外部灵感执行暂不可用");
        } else this.#profile(executor);
      }
      this.store.updateGrowthSettings(input);
      result = this.growthView();
    } else if (method === "inspiration.session.get") {
      const execution = this.#externalSession(input);
      result = { origin: execution ? { inspirationId: execution.ideaId,
        inspirationTitle: execution.title || execution.body.trim().split("\n")[0].slice(0, 80) || execution.attachments?.[0]?.name || "" } : null };
    } else if (method === "inspiration.session.messages") {
      result = this.#page(this.store.sessionExecutionsPage(input), "items", execution => ({
        id: execution.id, createdAt: execution.createdAt,
        promptHash: inspirationPromptHash(this.buildPrompt(execution)), text: inspirationUserText(execution),
        attachments: inspirationUserAttachments(execution),
      }));
    } else if (method === "inspiration.session.send") {
      result = { idea: this.sendFromExternalSession(input) };
    } else if (method === "inspiration.list") {
      this.#refreshStatusProjection();
      result = this.#page(this.store.listPage(input), "items", idea => this.view(idea.id, true));
    } else if (method === "inspiration.executions") {
      if (!this.store.get(input.id)) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      result = this.#page(this.store.executionsPage(input), "executions", value => this.#executionView(value, true));
    } else if (method === "inspiration.activity.binding") {
      if (!this.store.get(input.id)) fail("INSPIRATION_NOT_FOUND", "灵感不存在");
      const execution = this.store.executionForRun(input.runId);
      if (!execution || execution.ideaId !== input.id) fail("INSPIRATION_BINDING_INVALID", "运行不属于这条灵感");
      if (!execution.external && execution.sessionKey) {
        const session = this.chatSessionStore.getSession(execution.sessionKey);
        if (!session || session.profileId !== execution.profileId || session.workspace !== execution.workspace) {
          fail("INSPIRATION_BINDING_INVALID", "灵感会话归属不匹配");
        }
      }
      result = { execution: this.#executionView(execution), prompt: this.buildPrompt(execution) };
    } else if (method === "inspiration.get") result = { idea: this.view(input.id) };
    else if (method === "inspiration.media.write") result = this.store.media.write(input);
    else if (method === "inspiration.media.read") result = input.preview ? await this.store.media.readPreview(input) : this.store.media.read(input);
    else if (method === "inspiration.create") result = { idea: this.view(this.store.create(input).id) };
    else if (method === "inspiration.import") result = { idea: this.view(this.store.importArchive(input).id) };
    else if (method === "inspiration.update") result = { idea: this.view(this.store.update(input, (idea) => {
      if (input.patch.archived === true && this.view(idea.id).status !== "completed") {
        fail("INSPIRATION_NOT_COMPLETED", "灵感完成后才能归档");
      }
    }).id) };
    else if (method === "inspiration.delete") {
      const idea = this.store.delete(input, (execution) => {
        return this.#terminal(execution);
      });
      result = { id: idea.id, deleted: true };
    }
    else if (method === "inspiration.start") result = { idea: this.start(input) };
    else {
      const execution = this.store.executionForRun(input.runId);
      if (!execution || execution.ideaId !== input.id) fail("INSPIRATION_BINDING_INVALID", "运行不属于这条灵感");
      if (execution.external) {
        if (!this.externalExecutor) fail("INSPIRATION_UNAVAILABLE", "外部灵感执行暂不可用");
        if (method === "inspiration.cancel") await this.externalExecutor.cancel(execution, input.operationId);
        else await this.externalExecutor.respond(execution, input);
        return validateInspirationServiceResult(method, { idea: this.view(input.id) });
      }
      const run = this.#assertRun(execution, this.dispatcher.getRun(input.runId));
      if (method === "inspiration.cancel") {
        if (run.status === "queued") this.getCoordinator().cancelQueuedDomainRun(run.id);
        else if (!TERMINAL.has(run.status)) await this.getCoordinator().abort({
          operationId: input.operationId, sessionKey: execution.sessionKey, runId: run.id,
        });
      } else {
        if (this.store.replayResponse(input)) return validateInspirationServiceResult(method, { idea: this.view(input.id) });
        const attention = this.#attention(execution, run);
        if (!attention?.active || attention.request.requestId !== input.requestId) {
          fail("INSPIRATION_REQUEST_EXPIRED", "这个请求已失效，请查看最新执行状态");
        }
        const response = validateInteractiveResponseV1(attention.request, input.response);
        const common = { operationId: input.operationId, runId: run.id, requestId: input.requestId };
        if (attention.request.kind === "runtime_approval") {
          await this.getCoordinator().respondApproval({ ...common, choice: response.choice });
        } else if (attention.request.kind === "mcp_permission") {
          await this.getCoordinator().respondInput({ ...common,
            action: response.choice === "deny" ? "cancel" : "submit", answers: {} });
        } else await this.getCoordinator().respondInput({ ...common, action: response.action, answers: response.answers });
        this.store.recordResponse(input);
      }
      result = { idea: this.view(input.id) };
    }
    if (["inspiration.cancel", "inspiration.respond"].includes(method)) this.growth.wake();
    return validateInspirationServiceResult(method, result);
  }
}

module.exports = { InspirationService, inspirationPrompt };
