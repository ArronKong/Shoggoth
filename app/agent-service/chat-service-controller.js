"use strict";


const crypto = require("node:crypto");
const path = require("node:path");
const { managedChatWorkspace } = require("./chat-workspace");
const {
  federationInputProvenanceForOperationId,
} = require("../federation-chat-provenance");
const {
  MAX_FRAME_BYTES,
  createQueryCursorCodec,
  paginateChatServiceItems,
  paginateRunSubscription,
  validateChatServiceParams,
  validateChatServiceResult,
} = require("./chat-service-protocol");
const { createCodexChatHistoryMapper } = require("./codex-chat-history");
const { adaptCodexChatHistoryPage } = require("./chat-history-adapter");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const { normalizeInteractiveRequestV1, mcpElicitationUsesApprovalWait } = require("../core/shoggoth-interaction-contract");

const RESTART_INTERRUPTION_CODES = new Set([
  "SERVICE_RESTARTED", "EXECUTION_CONTRACT_LOST", "RUNTIME_HOST_RESTARTED",
]);

function isRestartInterruption(run) {
  return run?.status === "interrupted" && RESTART_INTERRUPTION_CODES.has(run.errorCode);
}

const IMPLEMENTED_METHODS = new Set([
  "profile.list",
  "chat.session.list",
  "chat.session.create",
  "chat.session.model.set",
  "chat.session.settings.set",
  "chat.session.permission.set",
  "chat.session.rename",
  "chat.session.archive",
  "chat.session.delete",
  "chat.history",
  "chat.search",
  "chat.command.list",
  "chat.command.exec",
  "chat.send",
  "chat.steer",
  "chat.abort",
  "run.list",
  "run.get",
  "run.subscribe",
  "run.approval.respond",
  "run.input.respond",
]);

function requireMethods(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`ChatServiceController 需要 ${name}`);
  }
}

function controllerError(code, message) {
  return serviceError(code, message);
}

function stableEntries(items, keyOf) {
  return items.map((item) => ({ key: keyOf(item), item }));
}

function provesNoRemoteTurnWasAccepted(runs) {
  const preTurnTerminalStatuses = new Set(["failed", "canceled", "interrupted", "skipped"]);
  return runs.length > 0 && runs.every((run) => (
    (run.runtimeTurnRef?.turnId ?? null) === null
      && preTurnTerminalStatuses.has(run.status)
  ));
}

function runtimeSessionIdOf(session) {
  return session?.runtimeSessionId ?? null;
}

function transcriptMessageText(event) {
  if (typeof event.content?.text === "string") return event.content.text;
  if (typeof event.content?.message === "string") return event.content.message;
  if (typeof event.content?.explanation === "string") return event.content.explanation;
  if (typeof event.content?.reason === "string") return event.content.reason;
  if (typeof event.content?.resultSummary === "string") return event.content.resultSummary;
  if (typeof event.content?.errorCode === "string") return event.content.errorCode;
  return "";
}

function transcriptStructuredText(value) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.step === "string") return item.step;
    return "";
  }).filter(Boolean).join("\n");
}

function transcriptPlanEntries(event) {
  const entries = (Array.isArray(event.content?.plan) ? event.content.plan : []).map((item) => {
    if (!item || typeof item !== "object") return null;
    const content = typeof item.step === "string" ? item.step
      : typeof item.content === "string" ? item.content : "";
    if (!content) return null;
    return {
      content,
      status: item.status === "inProgress" ? "in_progress"
        : typeof item.status === "string" ? item.status : "pending",
    };
  }).filter(Boolean);
  const delta = typeof event.content?.delta === "string" && event.content.delta
    ? event.content.delta : typeof event.content?.text === "string" ? event.content.text : "";
  if (delta && !entries.some((entry) => entry.content === delta)) {
    entries.push({ content: delta, status: "in_progress" });
  }
  return entries;
}

function transcriptMessage(event, role, content) {
  const provenance = role === "user"
    ? federationInputProvenanceForOperationId(event.content?.operationId)
    : null;
  return {
    id: event.id,
    role,
    content,
    timestamp: event.occurredAt,
    ...(provenance ? { provenance } : {}),
    shoggoth: {
      transcriptSeq: event.seq,
      contextExcluded: event.contextExcluded,
      ...(role === "user" && event.content?.attachments?.length
        ? { attachments: structuredClone(event.content.attachments) } : {}),
    },
  };
}

function transcriptHistoryItem(event) {
  if (event.content?.importedFrom === "codex" && event.content.historyItem) {
    return structuredClone(event.content.historyItem);
  }
  const transcriptType = event.content?.transcriptType;
  let role;
  let type;
  let message;
  if (["user", "assistant"].includes(event.kind)) {
    const text = transcriptMessageText(event);
    if (!text && !event.content?.attachments?.length) return null;
    role = event.kind;
    type = "text";
    message = transcriptMessage(event, role, [{ type: "text", text }]);
  } else if (event.kind === "error") {
    const text = transcriptMessageText(event);
    if (!text) return null;
    role = "system";
    type = "error";
    message = transcriptMessage(event, role, [{ type: "text", text }]);
    if (transcriptType === "terminal" && isRestartInterruption(event.content)) {
      message.notice = "runInterrupted";
    }
  } else if (transcriptType === "reasoning") {
    const text = transcriptStructuredText(event.content?.reasoning);
    if (!text) return null;
    role = "assistant";
    type = "thinking";
    message = transcriptMessage(event, role, [{ type: "thinking", thinking: text }]);
  } else if (transcriptType === "plan") {
    const planEntries = transcriptPlanEntries(event);
    if (!planEntries.length) return null;
    role = "assistant";
    type = "plan";
    message = transcriptMessage(event, role, [{ type: "plan", planEntries }]);
  } else if (event.kind === "tool_call") {
    const tool = event.content?.tool;
    const toolName = typeof tool?.name === "string" && tool.name
      ? tool.name : typeof tool?.kind === "string" && tool.kind ? tool.kind : "tool";
    const args = tool?.displayArgs && typeof tool.displayArgs === "object"
      && !Array.isArray(tool.displayArgs) ? structuredClone(tool.displayArgs) : undefined;
    role = "assistant";
    type = "tool";
    message = transcriptMessage(event, role, [{
      type: "toolCall", toolName,
      ...(typeof event.content?.toolCallId === "string" ? { toolCallId: event.content.toolCallId } : {}),
      ...(args === undefined ? {} : { arguments: args }),
    }]);
  } else if (event.kind === "tool_result") {
    const tool = event.content?.tool;
    const toolName = typeof tool?.name === "string" && tool.name
      ? tool.name : typeof tool?.kind === "string" && tool.kind ? tool.kind : "tool";
    const failed = tool?.status === "failed";
    const result = typeof tool?.resultSummary === "string" && tool.resultSummary
      ? tool.resultSummary : typeof tool?.errorCode === "string" ? tool.errorCode : "";
    const args = tool?.displayArgs && typeof tool.displayArgs === "object"
      && !Array.isArray(tool.displayArgs) ? structuredClone(tool.displayArgs) : undefined;
    const durationS = Number.isSafeInteger(tool?.durationMs) && tool.durationMs > 0
      ? tool.durationMs / 1000 : undefined;
    role = "toolResult";
    type = "tool";
    message = transcriptMessage(event, role, [{
      type: "toolResult", name: toolName, content: result, is_error: failed,
      ...(require("../core/plugin-app-call-reference").pluginAppCallId(tool?.pluginAppCallId)
        ? { pluginAppCallId: tool.pluginAppCallId } : {}),
      ...(typeof event.content?.toolCallId === "string" ? { toolCallId: event.content.toolCallId } : {}),
      ...(args === undefined ? {} : { arguments: args }),
      ...(durationS === undefined ? {} : { durationS }),
    }]);
  } else if (event.kind === "input") {
    const { transcriptType: requestType, ...payload } = event.content || {};
    let text;
    try {
      const request = normalizeInteractiveRequestV1({ runId: event.runId, eventType: requestType,
        payload, expiresAt: payload.expiresAt ?? null });
      text = [request.title, request.message, ...request.fields.map((field) => [field.label,
        ...(field.options || []).map((option) => `${option.label}${option.description ? ` — ${option.description}` : ""}`),
      ].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
    } catch { text = "交互请求详情未保留"; }
    role = "assistant";
    type = "text";
    message = transcriptMessage(event, role, [{ type: "text", text }]);
  } else if (event.kind === "artifact") {
    const text = transcriptMessageText(event);
    if (!text) return null;
    role = "assistant";
    type = "text";
    message = transcriptMessage(event, role, [{ type: "text", text }]);
  } else {
    return null;
  }
  return {
    id: event.id,
    runId: event.runId,
    role,
    type,
    payload: { message },
    createdAt: event.occurredAt,
    fragment: null,
  };
}

function paginateTranscriptEvents(options) {
  const { params, responseId, cursorCodec } = options;
  // Approval requests and decisions remain in the transcript for audit/context,
  // but are not conversation messages. Live cards come from run subscriptions.
  // Resolve request identities across the full transcript before pagination so
  // decisions stay hidden even when their request is on another page.
  const isApproval = (event) => event.kind === "approval"
    || (event.kind === "input" && mcpElicitationUsesApprovalWait(event.content));
  const requestKey = (event) => JSON.stringify([event.runId, event.content?.requestId]);
  const approvalRequests = new Set(options.events.filter(isApproval).map(requestKey));
  const query = {
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit },
  };
  let beforeSeq = Number.MAX_SAFE_INTEGER;
  if (params.cursor !== null) {
    try {
      const position = cursorCodec.decode(params.cursor, query).position;
      if (!/^[1-9][0-9]*$/u.test(position)) throw new Error("invalid cursor");
      beforeSeq = Number(position);
      if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) throw new Error("invalid cursor");
    } catch {
      throw controllerError("CHAT_HISTORY_CURSOR_INVALID", "Transcript history cursor 无效");
    }
  }
  const available = options.events
    .filter((event) => event.seq < beforeSeq)
    .filter((event) => !isApproval(event)
      && !(event.content?.transcriptType === "interaction.response" && approvalRequests.has(requestKey(event))))
    .map((event) => ({ seq: event.seq, item: transcriptHistoryItem(event) }))
    .filter((entry) => entry.item !== null);
  let selected = available.slice(Math.max(0, available.length - params.limit));
  while (selected.length > 0) {
    const hasMore = available.length > selected.length;
    const nextCursor = hasMore ? cursorCodec.encode({
      query,
      position: String(selected[0].seq),
    }) : null;
    const result = validateChatServiceResult("chat.history", {
      messages: selected.map((entry) => entry.item),
      nextCursor,
      hasMore,
    });
    if (Buffer.byteLength(`${JSON.stringify({ id: responseId, ok: true, result })}\n`, "utf8")
      <= MAX_FRAME_BYTES) return result;
    selected = selected.slice(1);
  }
  if (available.length > 0) {
    throw controllerError("CHAT_HISTORY_ITEM_TOO_LARGE", "Transcript history item 超过协议限制");
  }
  return validateChatServiceResult("chat.history", {
    messages: [], nextCursor: null, hasMore: false,
  });
}

function resolveProfileWorkspace(options = {}) {
  const { paths, profile, requested } = options;
  const errorCode = options.errorCode || "CHAT_SESSION_INVALID";
  if (!paths?.defaultWorkspaceDir || !paths?.trustedRoot || !profile?.id) {
    throw controllerError(errorCode, "AgentProfile workspace 解析参数无效");
  }
  if (options.sessionOperationId !== undefined && (typeof options.sessionOperationId !== "string"
    || options.sessionOperationId.length === 0 || options.sessionOperationId.length > 512
    || !options.sessionOperationId.isWellFormed() || options.sessionOperationId.includes("\0"))) {
    throw controllerError(errorCode, "ChatSession workspace 标识无效");
  }
  const candidate = requested ?? profile.defaultCwd;
  if (candidate !== null) {
    if (!path.isAbsolute(candidate)) {
      throw controllerError(errorCode, "workspace 必须是绝对路径");
    }
    return path.normalize(candidate);
  }

  ensurePrivateDirectoryTree(paths.defaultWorkspaceDir, paths.trustedRoot);
  const workspaceRoot = path.resolve(paths.defaultWorkspaceDir);
  const profileRoot = path.resolve(workspaceRoot, profile.id);
  const target = options.sessionOperationId === undefined ? profileRoot
    : managedChatWorkspace(profileRoot, options.sessionOperationId);
  if (path.dirname(profileRoot) !== workspaceRoot) {
    throw controllerError(errorCode, "AgentProfile workspace 标识无效");
  }
  ensurePrivateDirectoryTree(target, paths.trustedRoot);
  return target;
}

function createChatServiceController(options = {}) {
  const inspiration = () => options.getInspirationService?.() || null;
  const sessionRuns = (key, query = {}) => typeof options.coordinator?.listSessionRuns === "function"
    ? options.coordinator.listSessionRuns(key, query)
    : options.coordinator.listRuns({ ...query, source: "chat", sourceId: key });
  const runSessionKey = (run) => typeof options.coordinator?.getRunSessionKey === "function"
    ? options.coordinator.getRunSessionKey(run) : run?.source === "chat" ? run.sourceId : null;
  if (!options.paths?.defaultWorkspaceDir || !options.paths?.trustedRoot) {
    throw new TypeError("ChatServiceController 需要 Service paths");
  }
  requireMethods(options.productStore, ["listAgentProfiles", "getAgentProfile"], "ProductStore");
  requireMethods(options.chatSessionStore, ["listSessions", "createSession"], "ChatSessionStore");
  requireMethods(options.coordinator, [
    "listRuns", "getRun", "send", "subscribeRun",
  ], "WorkRunCoordinator");
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("ChatServiceController now 必须是函数");
  }
  if (options.randomUUID !== undefined && typeof options.randomUUID !== "function") {
    throw new TypeError("ChatServiceController randomUUID 必须是函数");
  }
  const productStore = options.productStore;
  const chatSessionStore = options.chatSessionStore;
  const coordinator = options.coordinator;
  const transcriptStore = options.transcriptStore || null;
  if (transcriptStore) {
    requireMethods(transcriptStore, [
      "ensureSession", "listEvents", "importHistoryItems", "getSessionDerivedTitle",
    ], "TranscriptStore");
  }
  if (options.runtimeSessionOwnershipStore !== undefined) {
    requireMethods(
      options.runtimeSessionOwnershipStore,
      ["assertOwned", "mark"],
      "RuntimeSessionOwnershipStore",
    );
  }
  const runtimeSessionOwnershipStore = options.runtimeSessionOwnershipStore || null;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const cursorCodec = createQueryCursorCodec({ secret: options.cursorSecret });
  let historyMapper = null;
  let lifecycleState = "constructed";
  let lifecycleGeneration = 0;
  let openPromise = null;
  let closePromise = null;
  const inFlight = new Set();
  const remoteOperationsInFlight = new Map();

  async function acquireRuntime(profile, workspace) {
    const binding = {
      runtime: profile.runtime,
      runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId,
    };
    const acquireOptions = { permissionPolicy: profile.permissionPolicy, workspace };
    if (typeof options.runtimeManager?.acquire === "function") {
      return options.runtimeManager.acquire(binding, acquireOptions);
    }
    if (typeof options.runtimePool?.acquire === "function") {
      return options.runtimePool.acquire(binding, acquireOptions);
    }
    requireMethods(options.runtimePool, ["get"], "RuntimeManager");
    return options.runtimePool.get(binding, acquireOptions);
  }

  function lifecycleError(commitUncertain = false) {
    return controllerError(
      commitUncertain ? "CHAT_SESSION_COMMIT_UNCERTAIN" : "SERVICE_UNAVAILABLE",
      commitUncertain
        ? "远端线程可能已完成，但 Controller 已进入关闭阶段"
        : "ChatServiceController 当前不可接受请求",
    );
  }

  function fence(generation, commitUncertain = false) {
    if (generation !== lifecycleGeneration
      || !["opening", "open"].includes(lifecycleState)) {
      throw lifecycleError(commitUncertain);
    }
  }

  function getHistoryMapper() {
    if (historyMapper) return historyMapper;
    if (!options.schemaContract) {
      throw controllerError("BACKEND_NOT_READY", "Codex history schema contract 未就绪");
    }
    historyMapper = createCodexChatHistoryMapper({
      schemaContract: options.schemaContract,
      cursorSecret: options.cursorSecret,
    });
    return historyMapper;
  }

  function profileForSession(session) {
    const profile = productStore.resolveAgentRuntimeProfile?.(session.profileId, session.runtimeBindingId ?? undefined)
      || productStore.getAgentProfile(session.profileId);
    if (!profile || profile.id !== session.profileId || profile.enabled !== true
      || typeof profile.backendId !== "string" || typeof profile.runtime !== "string"
      || typeof profile.runtimeProfileId !== "string"
      || typeof profile.runtimeAccountId !== "string") {
      throw controllerError("BACKEND_NOT_READY", "ChatSession 没有唯一 Runtime Profile binding");
    }
    return profile;
  }

  function ownershipInput(profile, session, runtimeSessionId) {
    return {
      binding: {
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
      },
      sessionId: runtimeSessionId,
      profileId: profile.id,
      workspace: session.workspace,
    };
  }

  function assertSessionOwned(profile, session, runtimeSessionId) {
    if (!runtimeSessionOwnershipStore) return null;
    return runtimeSessionOwnershipStore.assertOwned(
      ownershipInput(profile, session, runtimeSessionId),
    );
  }

  async function runRemoteOperation(method, params, generation) {
    requireMethods(chatSessionStore, [
      "getSession", "requestRename", "requestArchive", "requestDelete",
      "completeRemoteOperation",
    ], "ChatSessionStore remote operations");
    const kind = method.slice("chat.session.".length);
    let preparedHost = null;
    let preparedProfile = null;
    const preparedSession = chatSessionStore.getSession(params.sessionKey);
    if (preparedSession && runtimeSessionIdOf(preparedSession) !== null) {
      preparedProfile = profileForSession(preparedSession);
      assertSessionOwned(
        preparedProfile,
        preparedSession,
        runtimeSessionIdOf(preparedSession),
      );
      if (kind === "delete") {
        preparedHost = await acquireRuntime(preparedProfile, preparedSession.workspace);
        fence(generation);
        if (preparedHost.capabilities
          && preparedHost.capabilities["session.delete"] !== true) {
          throw controllerError(
            "RUNTIME_CAPABILITY_UNSUPPORTED",
            "The bound Runtime does not support physical session deletion",
          );
        }
      }
    }
    let operation;
    if (kind === "rename") {
      operation = chatSessionStore.requestRename(
        params.sessionKey, params.title, params.operationId, params.createdAt,
      );
    } else if (kind === "archive") {
      operation = chatSessionStore.requestArchive(
        params.sessionKey, params.operationId, params.createdAt,
      );
    } else {
      operation = chatSessionStore.requestDelete(
        params.sessionKey, params.operationId, params.createdAt,
      );
    }
    if (operation.state === "completed") {
      return validateChatServiceResult(method, {
        session: chatSessionStore.getSession(params.sessionKey), operation,
      });
    }
    const existing = remoteOperationsInFlight.get(operation.operationId);
    if (existing) return existing;
    const execution = (async () => {
      const session = chatSessionStore.getSession(params.sessionKey);
      const runtimeSessionId = runtimeSessionIdOf(session);
      if (!session) {
        throw controllerError("CHAT_SESSION_NOT_READY", "ChatSession 尚未绑定 Codex thread");
      }
      const detached = runtimeSessionId === null
        && ["ready", "archived", "delete_pending"].includes(session.status);
      if (runtimeSessionId === null && !detached) {
        throw controllerError("CHAT_SESSION_NOT_READY", "ChatSession 尚未绑定 Codex thread");
      }
      // title=null 表示清空 Shoggoth 本地标签。Codex thread/name/set 只接受 string，
      // 因此该操作确定性地跳过远端调用；crash recovery 重放时也采用相同策略。
      const localTitleClear = kind === "rename" && operation.title === null;
      if (!localTitleClear && !detached) {
        const profile = preparedProfile || profileForSession(session);
        assertSessionOwned(profile, session, runtimeSessionId);
        const host = preparedHost || await acquireRuntime(profile, session.workspace);
        fence(generation);
        const runtimeMethod = kind === "rename" ? "sessionRename"
          : kind === "archive" ? "sessionArchive" : "sessionDelete";
        const legacyMethod = kind === "rename" ? "threadSetName"
          : kind === "archive" ? "threadArchive" : "threadDelete";
        const hostParams = kind === "rename"
          ? { sessionId: runtimeSessionId, name: operation.title }
          : { sessionId: runtimeSessionId };
        let response;
        if (typeof host[runtimeMethod] === "function") {
          response = await host[runtimeMethod](hostParams);
        } else {
          requireMethods(host, [legacyMethod], `RuntimeHandle ${runtimeMethod}`);
          response = await host[legacyMethod](kind === "rename"
            ? { threadId: runtimeSessionId, name: operation.title }
            : { threadId: runtimeSessionId });
        }
        fence(generation, true);
        if (profile.runtime === "codex" && typeof options.schemaContract?.validateResponse === "function"
          && typeof host[runtimeMethod] !== "function") {
          options.schemaContract.validateResponse(legacyMethod, response);
        }
      }
      if (runtimeSessionOwnershipStore && (kind === "archive" || kind === "delete")) {
        for (const retired of session.retiredRuntimeSessions || []) {
          const binding = productStore.getAgentRuntimeBinding(session.profileId, retired.bindingId);
          if (!binding || binding.runtime !== retired.runtime || binding.runtimeAccountId !== retired.runtimeAccountId) {
            throw controllerError("CHAT_SESSION_COMMIT_UNCERTAIN", "历史会话 Binding 无法核验");
          }
          runtimeSessionOwnershipStore.mark({ binding: { runtime: binding.runtime,
            runtimeProfileId: binding.runtimeProfileId, runtimeAccountId: binding.runtimeAccountId },
            profileId: session.profileId, sessionId: retired.runtimeSessionId, workspace: session.workspace,
            status: kind === "archive" ? "archived" : "deleted" });
        }
      }
      let completedSession;
      try {
        completedSession = chatSessionStore.completeRemoteOperation(operation.operationId);
        operation = kind === "rename"
          ? chatSessionStore.requestRename(
            params.sessionKey, params.title, params.operationId, params.createdAt,
          )
          : kind === "archive"
            ? chatSessionStore.requestArchive(params.sessionKey, params.operationId, params.createdAt)
            : chatSessionStore.requestDelete(params.sessionKey, params.operationId, params.createdAt);
      } catch (error) {
        const uncertain = controllerError(
          "CHAT_SESSION_COMMIT_UNCERTAIN",
          "ChatSession operation 本地提交结果不确定",
        );
        uncertain.cause = error;
        throw uncertain;
      }
      if (runtimeSessionOwnershipStore && runtimeSessionId !== null
        && (kind === "archive" || kind === "delete")) {
        const profile = preparedProfile || profileForSession(session);
        runtimeSessionOwnershipStore.mark({
          ...ownershipInput(profile, session, runtimeSessionId),
          status: kind === "archive" ? "archived" : "deleted",
        });
      }
      return validateChatServiceResult(method, { session: completedSession, operation });
    })();
    remoteOperationsInFlight.set(operation.operationId, execution);
    void execution.finally(() => {
      if (remoteOperationsInFlight.get(operation.operationId) === execution) {
        remoteOperationsInFlight.delete(operation.operationId);
      }
    }).catch(() => {});
    return execution;
  }

  async function readCodexHistory(params, responseId, generation) {
    requireMethods(chatSessionStore, ["getSession"], "ChatSessionStore getSession");
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    const runtimeSessionId = runtimeSessionIdOf(session);
    if (!["ready", "archived"].includes(session.status) || runtimeSessionId === null) {
      throw controllerError("CHAT_SESSION_NOT_READY", "ChatSession 尚未准备好读取历史");
    }
    const profile = profileForSession(session);
    if (profile.runtime !== "codex") {
      throw controllerError("BACKEND_NOT_READY", "Runtime native history import is unavailable");
    }
    assertSessionOwned(profile, session, runtimeSessionId);
    const runtimeHandle = await acquireRuntime(profile, session.workspace);
    const host = runtimeHandle?.host || runtimeHandle;
    fence(generation);
    requireMethods(host, ["threadRead"], "CodexHost threadRead");
    const runs = sessionRuns(session.sessionKey);
    let response;
    try {
      response = await host.threadRead({
        threadId: runtimeSessionId,
        includeTurns: true,
      });
      fence(generation);
    } catch (error) {
      fence(generation);
      // Codex 0.149 的新 thread 在第一个 turn/start 成功前不可 thread/read。
      // 仅当 durable Run 全部证明没有任何远端 turn 被接受时，才能把它视为
      // 空历史并放开首轮发送；已有 turn 或未知来源仍原样失败，避免隐藏数据。
      if (provesNoRemoteTurnWasAccepted(runs)) {
        return validateChatServiceResult("chat.history", {
          messages: [], nextCursor: null, hasMore: false,
        });
      }
      throw error;
    }
    const mapper = getHistoryMapper();
    const handle = mapper.validateCodexThreadRead(response);
    let limit = params.limit;
    while (limit >= 1) {
      const page = mapper.createCodexChatHistoryPage(handle, {
        cursor: params.cursor,
        limit,
        registeredSecrets: Array.isArray(host.registeredSecrets)
          ? [...host.registeredSecrets] : [],
      });
      const adapted = adaptCodexChatHistoryPage(page, { runs });
      let result;
      try {
        result = validateChatServiceResult("chat.history", adapted);
      } catch (error) {
        if (error?.code !== "CHAT_RESPONSE_INVALID" || limit === 1) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      const frame = { id: responseId, ok: true, result };
      if (Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8") <= MAX_FRAME_BYTES) return result;
      if (limit === 1) {
        throw controllerError("RESPONSE_TOO_LARGE", "Codex history 响应超过协议限制");
      }
      limit = Math.max(1, Math.floor(limit / 2));
    }
    throw controllerError("RESPONSE_TOO_LARGE", "Codex history 响应超过协议限制");
  }

  async function importCodexHistory(session, generation) {
    const profile = profileForSession(session);
    if (profile.runtime !== "codex") return false;
    const items = [];
    let cursor = null;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
      const page = await readCodexHistory({
        sessionKey: session.sessionKey,
        cursor,
        limit: 100,
      }, null, generation);
      items.unshift(...page.messages);
      if (!page.hasMore) break;
      if (page.nextCursor === null || page.nextCursor === cursor || seen.has(page.nextCursor)) {
        throw controllerError("CHAT_HISTORY_CURSOR_INVALID", "Codex history migration 游标无效");
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
      if (pageIndex === 999) {
        throw controllerError("CHAT_HISTORY_CURSOR_INVALID", "Codex history migration 页数超限");
      }
    }
    transcriptStore.importHistoryItems({
      profileId: session.profileId,
      sessionId: session.id,
      items,
      runtimeRef: runtimeSessionIdOf(session) === null ? null : {
        runtime: profile.runtime,
        runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId,
        sessionId: runtimeSessionIdOf(session),
      },
    });
    return true;
  }

  async function readHistory(params, responseId, generation) {
    if (!transcriptStore) return readCodexHistory(params, responseId, generation);
    requireMethods(chatSessionStore, ["getSession"], "ChatSessionStore getSession");
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    transcriptStore.ensureSession({ profileId: session.profileId, sessionId: session.id });
    let events = transcriptStore.listEvents(session.profileId, session.id);
    if (events.length === 0 && ["ready", "archived"].includes(session.status)
      && runtimeSessionIdOf(session) !== null) {
      const profile = profileForSession(session);
      if (profile.runtime === "codex") {
        await importCodexHistory(session, generation);
        fence(generation);
        events = transcriptStore.listEvents(session.profileId, session.id);
      }
    }
    return paginateTranscriptEvents({
      params, responseId, cursorCodec, events,
    });
  }

  function enabledProfile(profileId) {
    const profile = productStore.getAgentProfile(profileId);
    if (!profile) throw controllerError("UNKNOWN_AGENT_PROFILE", "AgentProfile 不存在");
    if (!profile.enabled) throw controllerError("AGENT_PROFILE_DISABLED", "AgentProfile 已停用");
    return profile;
  }

  function resolveWorkspace(profile, requested) {
    return resolveProfileWorkspace({ paths: options.paths, profile, requested });
  }

  async function setSessionModel(params, generation) {
    requireMethods(chatSessionStore, ["getSession", "setModelOverride"], "ChatSessionStore model");
    if (typeof options.listProfileModels !== "function") {
      throw controllerError("BACKEND_NOT_READY", "Agent model catalog 不可用");
    }
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    enabledProfile(session.profileId);
    const busy = sessionRuns(session.sessionKey)
      .some((run) => [
        "queued", "starting", "running", "waiting_approval", "waiting_input",
      ].includes(run.status));
    if (busy) throw controllerError("THREAD_ACTIVE_TURN_CONFLICT", "ChatSession 已有待执行任务");

    let cursor = null;
    const cursors = new Set();
    let available = false;
    try {
      for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
        const listModels = session.runtimeBindingId && options.listBindingModels ? options.listBindingModels : options.listProfileModels;
        const page = await listModels({
          profileId: session.profileId,
          ...(session.runtimeBindingId && options.listBindingModels ? { bindingId: session.runtimeBindingId } : {}),
          cursor,
          limit: 100,
        });
        fence(generation);
        if (page.models.some((model) => model.id === params.model)) {
          available = true;
          break;
        }
        if (!page.hasMore) break;
        if (page.nextCursor === null || page.nextCursor === cursor || cursors.has(page.nextCursor)) {
          throw controllerError("BACKEND_NOT_READY", "Agent model catalog 游标无效");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (error?.code === "THREAD_ACTIVE_TURN_CONFLICT") throw error;
      if (error?.code === "PROFILE_MODEL_NOT_AVAILABLE") {
        throw controllerError("CHAT_SESSION_MODEL_NOT_AVAILABLE", "该模型不在当前账号目录中");
      }
      if (error?.code === "BACKEND_NOT_READY") throw error;
      throw controllerError("BACKEND_NOT_READY", "无法读取当前 Agent 的模型目录");
    }
    if (!available) {
      throw controllerError("CHAT_SESSION_MODEL_NOT_AVAILABLE", "该模型不在当前账号目录中");
    }
    fence(generation);
    if (sessionRuns(session.sessionKey)
      .some((run) => [
        "queued", "starting", "running", "waiting_approval", "waiting_input",
      ].includes(run.status))) {
      throw controllerError("THREAD_ACTIVE_TURN_CONFLICT", "ChatSession 已有待执行任务");
    }
    const current = chatSessionStore.getSession(params.sessionKey);
    if (!current || current.runtimeBindingId !== session.runtimeBindingId || current.revision !== session.revision) {
      throw controllerError("CHAT_SESSION_NOT_READY", "会话已变化，请重试");
    }
    return { session: chatSessionStore.setModelOverride(params.sessionKey, params.model) };
  }

  async function setSessionSettings(params, generation) {
    requireMethods(chatSessionStore, ["getSession", "setModelSettings"], "ChatSessionStore settings");
    const initial = chatSessionStore.getSession(params.sessionKey);
    if (!initial) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    const profile = enabledProfile(initial.profileId);
    const assertIdle = () => {
      if (sessionRuns(params.sessionKey).some(run => ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(run.status))) {
        throw controllerError("THREAD_ACTIVE_TURN_CONFLICT", "ChatSession 已有待执行任务");
      }
    };
    assertIdle();
    if (typeof options.listProfileModels !== "function") throw controllerError("BACKEND_NOT_READY", "模型目录不可用");
    const selected = initial.modelOverride || profile.defaultModel;
    let model, cursor = null;
    const cursors = new Set();
    for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
      const listModels = initial.runtimeBindingId && options.listBindingModels ? options.listBindingModels : options.listProfileModels;
      const page = await listModels({ profileId: profile.id, cursor, limit: 100,
        ...(initial.runtimeBindingId && options.listBindingModels ? { bindingId: initial.runtimeBindingId } : {}) });
      fence(generation);
      model = page.models.find(item => selected ? item.id === selected : item.isDefault);
      if (model || !page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw controllerError("BACKEND_NOT_READY", "模型目录游标无效");
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    if (!model) throw controllerError("CHAT_SESSION_MODEL_NOT_AVAILABLE", "当前模型不在目录中");
    assertIdle();
    const current = chatSessionStore.getSession(params.sessionKey);
    const currentProfile = enabledProfile(initial.profileId);
    if (!current || current.runtimeBindingId !== initial.runtimeBindingId
      || current.revision !== initial.revision || current.modelOverride !== initial.modelOverride
      || currentProfile.defaultModel !== profile.defaultModel) {
      throw controllerError("CHAT_SESSION_NOT_READY", "模型已变化，请重试");
    }
    const settings = { thinkingLevel: null, serviceTier: null, ...current.modelSettings };
    const caps = model.capabilities;
    if (Object.hasOwn(params.patch, "thinkingLevel")) {
      const level = params.patch.thinkingLevel;
      if (level !== null && !caps?.thinkingOptions.includes(level)) {
        throw controllerError("CHAT_SESSION_MODEL_SETTINGS_INVALID", "思考强度不可用");
      }
      settings.thinkingLevel = level;
    }
    if (Object.hasOwn(params.patch, "fastMode")) {
      if (params.patch.fastMode && !caps?.fastTier) {
        throw controllerError("CHAT_SESSION_MODEL_SETTINGS_INVALID", "快速模式不可用");
      }
      settings.serviceTier = params.patch.fastMode ? caps.fastTier : null;
    }
    return { session: chatSessionStore.setModelSettings(params.sessionKey, settings) };
  }

  function searchChat(params, generation) {
    enabledProfile(params.profileId);
    if (!transcriptStore) throw controllerError("BACKEND_NOT_READY", "本地聊天记录不可用");
    const sessions = chatSessionStore.listSessions()
      .filter(session => session.profileId === params.profileId && !["archived", "delete_pending"].includes(session.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const results = [], needle = params.query.trim().toLocaleLowerCase();
    // Bound work on the service's main loop and return an explicit partial flag.
    const deadline = Date.now() + 1500;
    for (const session of sessions) {
      fence(generation);
      if (Date.now() > deadline) return { results, truncated: true };
      const events = transcriptStore.listEvents(session.profileId, session.id);
      for (let index = events.length - 1; index >= 0; index--) {
        if (Date.now() > deadline) return { results, truncated: true };
        const event = events[index];
        if (!["user", "assistant"].includes(event.kind) && !event.content?.historyItem) continue;
        const item = transcriptHistoryItem(event), message = item?.payload?.message;
        if (!message || !["user", "assistant"].includes(message.role)) continue;
        const text = [...(message.content || []).filter(part => part.type === "text").map(part => part.text),
          ...(event.content?.attachments || []).map(file => file.name)].join("\n");
        const match = text.toLocaleLowerCase().indexOf(needle);
        if (match < 0) continue;
        if (results.length === params.limit) return { results, truncated: true };
        // Code points keep snippets valid UTF-8 even next to emoji.
        const start = Math.max(0, match - 60);
        const prefix = text.slice(0, start);
        const chars = Array.from(text), offset = Array.from(prefix).length;
        const snippet = `${offset ? "…" : ""}${chars.slice(offset, offset + 180).join("")}${chars.length > offset + 180 ? "…" : ""}`;
        results.push({ sessionKey: session.sessionKey, messageId: message.id || item.id,
          role: message.role, ts: item.createdAt, snippet });
      }
    }
    return { results, truncated: false };
  }

  function setSessionPermission(params, generation) {
    requireMethods(chatSessionStore, ["getSession", "setPermissionMode"], "ChatSessionStore permission");
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    const profile = profileForSession(session);
    resolveRuntimePermissionMode(profile.runtime || "codex", params.mode, profile.permissionPolicy);
    const busy = sessionRuns(session.sessionKey)
      .some((run) => [
        "queued", "starting", "running", "waiting_approval", "waiting_input",
      ].includes(run.status));
    if (busy) throw controllerError("THREAD_ACTIVE_TURN_CONFLICT", "ChatSession 已有待执行任务");
    fence(generation);
    return { session: chatSessionStore.setPermissionMode(params.sessionKey, params.mode) };
  }

  async function listRuntimeCommands(params, generation) {
    requireMethods(chatSessionStore, ["getSession"], "ChatSessionStore getSession");
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (session.status === "delete_pending") {
      throw controllerError("CHAT_SESSION_NOT_READY", "ChatSession 当前不可读取命令目录");
    }
    const profile = profileForSession(session);
    const runtimeSessionId = runtimeSessionIdOf(session);
    if (runtimeSessionId !== null) assertSessionOwned(profile, session, runtimeSessionId);
    const runtimeHandle = await acquireRuntime(profile, session.workspace);
    fence(generation);
    if (runtimeHandle.capabilities?.["commands.list"] !== true) {
      return { supported: false, reason: "当前 Agent Runtime 未提供原生命令目录", commands: [] };
    }
    requireMethods(runtimeHandle, ["commandsList"], "RuntimeHandle commandsList");
    const result = await runtimeHandle.commandsList({
      sessionId: runtimeSessionId,
      cwd: session.workspace,
    });
    fence(generation);
    return result;
  }

  async function executeRuntimeCommand(params, generation) {
    requireMethods(chatSessionStore, ["getSession"], "ChatSessionStore getSession");
    const session = chatSessionStore.getSession(params.sessionKey);
    if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
    if (!["draft", "ready"].includes(session.status)) {
      throw controllerError("CHAT_SESSION_NOT_READY", "ChatSession 当前不可执行原生命令");
    }
    if (sessionRuns(session.sessionKey)
      .some((run) => [
        "queued", "starting", "running", "waiting_approval", "waiting_input",
      ].includes(run.status))) {
      throw controllerError("THREAD_ACTIVE_TURN_CONFLICT", "ChatSession 已有待执行任务");
    }
    if (/^\/compact\s*$/u.test(params.text.trim())) {
      const acknowledgement = await coordinator.send({ operationId: `compact-${crypto.randomUUID()}`,
        sessionKey: session.sessionKey, prompt: "/compact" });
      fence(generation);
      return { kind: "output", text: acknowledgement.run.status === "queued"
        ? "上下文压缩已排队。" : "上下文压缩请求已提交，等待运行时完成。", warning: null };
    }
    const profile = profileForSession(session);
    const runtimeSessionId = runtimeSessionIdOf(session);
    if (runtimeSessionId !== null) assertSessionOwned(profile, session, runtimeSessionId);
    const runtimeHandle = await acquireRuntime(profile, session.workspace);
    fence(generation);
    if (runtimeHandle.capabilities?.["commands.execute"] !== true) {
      throw controllerError(
        "RUNTIME_CAPABILITY_UNSUPPORTED",
        "The bound Runtime does not support native commands",
      );
    }
    requireMethods(runtimeHandle, ["commandExecute"], "RuntimeHandle commandExecute");
    const result = await runtimeHandle.commandExecute({
      sessionId: runtimeSessionId,
      cwd: session.workspace,
      text: params.text,
    });
    fence(generation);
    return result;
  }

  async function handleImpl(method, rawParams, responseId, generation) {
    if (!IMPLEMENTED_METHODS.has(method)) {
      throw controllerError("UNKNOWN_METHOD", `Chat Service 方法尚未接线: ${String(method)}`);
    }
    const params = validateChatServiceParams(method, rawParams);
    let result;
    if (method === "profile.list") {
      const profiles = productStore.listAgentProfiles()
        .filter((profile) => profile.backendId === params.backendId)
        .filter((profile) => !params.enabledOnly || profile.enabled);
      return paginateChatServiceItems({
        method,
        params,
        responseId,
        cursorCodec,
        entries: stableEntries(profiles, (profile) => profile.id),
      });
    }
    if (method === "chat.session.list") {
      const sessions = chatSessionStore.listSessions()
        .filter((session) => session.profileId === params.profileId)
        .filter((session) => params.includeArchived || session.status !== "archived")
        .map((session) => {
          const origin = chatSessionStore.getCronSessionOrigin?.(session.sessionKey);
          const title = transcriptStore?.getSessionDerivedTitle(session.profileId, session.id) ?? null;
          let cronTitle = null;
          if (origin) {
            try { cronTitle = options.getCronJobName?.(origin.cronJobId) || null; } catch {}
          }
          return { ...session, ...(options.getRuntimeContext?.(session) || {}),
            ...(inspiration()?.sessionOrigin(session.sessionKey) || {}), ...(origin || {}),
            derivedTitle: origin ? `Cron · ${cronTitle || title || origin.cronJobId.slice(0, 8)}` : title };
        });
      return paginateChatServiceItems({
        method,
        params,
        responseId,
        cursorCodec,
        entries: stableEntries(sessions, (session) => session.sessionKey),
      });
    }
    if (method === "chat.session.create") {
      const profile = enabledProfile(params.profileId);
      const session = chatSessionStore.createSession({
        operationId: params.operationId,
        profileId: params.profileId,
        workspace: resolveProfileWorkspace({ paths: options.paths, profile, requested: params.workspace,
            sessionOperationId: params.operationId }),
        createdAt: params.createdAt,
      });
      if (transcriptStore) transcriptStore.ensureSession({
        profileId: session.profileId,
        sessionId: session.id,
      });
      result = { session };
    } else if (method === "chat.session.model.set") {
      result = await setSessionModel(params, generation);
    } else if (method === "chat.session.settings.set") {
      result = await setSessionSettings(params, generation);
    } else if (method === "chat.search") {
      result = searchChat(params, generation);
    } else if (method === "chat.session.permission.set") {
      result = setSessionPermission(params, generation);
    } else if ([
      "chat.session.rename", "chat.session.archive", "chat.session.delete",
    ].includes(method)) {
      return runRemoteOperation(method, params, generation);
    } else if (method === "chat.history") {
      return readHistory(params, responseId, generation);
    } else if (method === "chat.command.list") {
      result = await listRuntimeCommands(params, generation);
    } else if (method === "chat.command.exec") {
      result = await executeRuntimeCommand(params, generation);
    } else if (method === "chat.send") {
      requireMethods(chatSessionStore, ["getSession"], "ChatSessionStore getSession");
      const session = chatSessionStore.getSession(params.sessionKey);
      if (!session) throw controllerError("CHAT_SESSION_NOT_FOUND", "ChatSession 不存在");
      const origin = inspiration()?.sessionOrigin(params.sessionKey);
      const sendInput = {
        operationId: params.operationId,
        sessionKey: params.sessionKey,
        prompt: params.prompt,
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      };
      result = validateChatServiceResult(method, await (origin
        ? inspiration().sendFromSession(sendInput) : coordinator.send(sendInput)));
      fence(generation);
      if (runSessionKey(result.run) !== params.sessionKey
        || result.run.idempotencyKey !== (origin ? `inspiration:${params.operationId}` : `shoggoth:chat-send:${params.operationId}`)
        || result.run.profileId !== session.profileId) {
        throw controllerError("CHAT_RESPONSE_INVALID", "Coordinator send Run identity 不匹配");
      }
    } else if (method === "chat.steer") {
      requireMethods(coordinator, ["steer"], "WorkRunCoordinator steer");
      result = validateChatServiceResult(method, await coordinator.steer({
        operationId: params.operationId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        message: params.message,
      }));
      fence(generation);
      if (params.runId !== null && result.runId !== params.runId) {
        throw controllerError("CHAT_RESPONSE_INVALID", "Coordinator steer Run identity 不匹配");
      }
    } else if (method === "chat.abort") {
      requireMethods(coordinator, ["abort"], "WorkRunCoordinator abort");
      const run = await coordinator.abort({
        operationId: params.operationId,
        sessionKey: params.sessionKey,
        runId: params.runId,
      });
      fence(generation);
      result = validateChatServiceResult(method, { run });
      if (result.run !== null && (runSessionKey(result.run) !== params.sessionKey
        || (params.runId !== null && result.run.id !== params.runId))) {
        throw controllerError("CHAT_RESPONSE_INVALID", "Coordinator abort Run identity 不匹配");
      }
    } else if (method === "run.list") {
      const query = {};
      if (params.profileId !== null) query.profileId = params.profileId;
      if (params.status !== null) query.status = params.status;
      const runs = params.sessionKey !== null ? sessionRuns(params.sessionKey, query) : coordinator.listRuns(query);
      return paginateChatServiceItems({
        method,
        params,
        responseId,
        cursorCodec,
        entries: stableEntries(runs, (run) => run.id),
      });
    } else if (method === "run.get") {
      const run = coordinator.getRun(params.runId);
      if (!run) throw controllerError("WORK_RUN_NOT_FOUND", "WorkRun 不存在");
      result = { run };
    } else if (method === "run.subscribe") {
      const subscription = coordinator.subscribeRun(
        params.runId,
        { streamId: params.streamId, afterSeq: params.afterSeq },
        () => {},
      );
      try {
        return paginateRunSubscription({ params, subscription, responseId });
      } finally {
        subscription.unsubscribe();
      }
    } else if (method === "run.approval.respond") {
      requireMethods(coordinator, ["respondApproval"], "WorkRunCoordinator approval");
      result = validateChatServiceResult(method, await coordinator.respondApproval({
        operationId: params.operationId,
        runId: params.runId,
        requestId: params.requestId,
        choice: params.choice,
      }));
      fence(generation);
      if (result.requestId !== params.requestId || result.run.id !== params.runId) {
        throw controllerError("CHAT_RESPONSE_INVALID", "Coordinator approval identity 不匹配");
      }
    } else if (method === "run.input.respond") {
      requireMethods(coordinator, ["respondInput"], "WorkRunCoordinator input");
      result = validateChatServiceResult(method, await coordinator.respondInput({
        operationId: params.operationId,
        runId: params.runId,
        requestId: params.requestId,
        action: params.action,
        answers: params.answers,
      }));
      fence(generation);
      if (result.requestId !== params.requestId || result.run.id !== params.runId) {
        throw controllerError("CHAT_RESPONSE_INVALID", "Coordinator input identity 不匹配");
      }
    }
    return validateChatServiceResult(method, result);
  }

  async function handle(method, rawParams, responseId = null) {
    if (lifecycleState !== "open") throw lifecycleError();
    const generation = lifecycleGeneration;
    const task = handleImpl(method, rawParams, responseId, generation);
    inFlight.add(task);
    try {
      return await task;
    } finally {
      inFlight.delete(task);
    }
  }

  async function ensureDefaultSessions() {
    const profiles = productStore.listAgentProfiles().filter((profile) => profile.enabled);
    for (const profile of profiles) {
      const hasSession = chatSessionStore.listSessions()
        .some((session) => session.profileId === profile.id);
      if (hasSession) continue;
      const time = now();
      const operationId = `default-session-${randomUUID()}`;
      const session = chatSessionStore.createSession({
        operationId,
        profileId: profile.id,
        workspace: resolveProfileWorkspace({ paths: options.paths, profile, requested: null,
          sessionOperationId: operationId }),
        createdAt: time,
      });
      if (transcriptStore) transcriptStore.ensureSession({
        profileId: session.profileId,
        sessionId: session.id,
      });
    }
  }

  function open() {
    if (lifecycleState === "open") return Promise.resolve(api);
    if (lifecycleState === "opening") return openPromise;
    if (lifecycleState === "closing") {
      return Promise.reject(controllerError(
        "SERVICE_UNAVAILABLE", "ChatServiceController 正在关闭",
      ));
    }
    lifecycleState = "opening";
    const generation = ++lifecycleGeneration;
    const current = (async () => {
      requireMethods(chatSessionStore, ["listPendingRemoteOperations"],
        "ChatSessionStore pending remote recovery");
      for (const operation of chatSessionStore.listPendingRemoteOperations()) {
        const method = `chat.session.${operation.kind}`;
        const params = {
          operationId: operation.operationId,
          sessionKey: operation.sessionKey,
          createdAt: operation.createdAt,
          ...(operation.kind === "rename" ? { title: operation.title } : {}),
        };
        await runRemoteOperation(method, params, generation);
        fence(generation);
      }
      await ensureDefaultSessions();
      fence(generation);
      lifecycleState = "open";
      return api;
    })();
    openPromise = current;
    void current.then(
      () => { if (openPromise === current) openPromise = null; },
      () => {
        if (openPromise === current) openPromise = null;
        if (lifecycleGeneration === generation && lifecycleState === "opening") {
          lifecycleState = "closed";
        }
      },
    );
    return current;
  }

  function close() {
    if (["constructed", "closed"].includes(lifecycleState)) return Promise.resolve();
    if (lifecycleState === "closing") return closePromise;
    const pendingOpen = lifecycleState === "opening" ? openPromise : null;
    lifecycleState = "closing";
    lifecycleGeneration += 1;
    const current = (async () => {
      if (pendingOpen) await pendingOpen.catch(() => {});
      await Promise.allSettled([...inFlight]);
      lifecycleState = "closed";
    })();
    closePromise = current;
    void current.finally(() => { if (closePromise === current) closePromise = null; });
    return current;
  }

  const api = Object.freeze({ handle, open, close, ensureDefaultSessions });
  return api;
}

module.exports = { createChatServiceController, resolveProfileWorkspace };
