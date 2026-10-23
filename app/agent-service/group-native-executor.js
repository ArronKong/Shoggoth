"use strict";

const crypto = require("node:crypto");
const { validText } = require("../group-result-content");
const { isPassReply } = require("./group-mentions");
const { redactGrantTokens } = require("./group-tool-grant");
const { GROUP_SESSION_OPERATION_PREFIX } = require("./group-chat-run");
const { normalizeInteractiveRequestV1 } = require("../core/shoggoth-interaction-contract");
const { nativeCapabilities, groupCapabilities } = require("./group-capabilities");
const { isRuntimeAvailable } = require("../runtime-availability");
const { resolveRuntimePermissionMode } = require("./runtime-permission-modes");
const { assertModelCatalog, assertModelSelection, modelError } = require("../group-member-model");

// 原生成员的群回合：沿用 chat.session.create / chat.send / chat.abort，
// 会话是群内部会话（不进入用户的会话列表，见 chat-service-controller 的 isInternalSession）。
class GroupNativeExecutor {
  constructor({ getChatServiceController, getWorkRunCoordinator, chatSessionStore, transcriptStore,
    now = Date.now, listBindingModels = null, getGroupToolCapability = async () => null, resolveWorkspace = profile => profile.defaultCwd ?? null }) {
    this.getChatServiceController = getChatServiceController;
    this.getWorkRunCoordinator = getWorkRunCoordinator;
    this.chatSessionStore = chatSessionStore;
    this.transcriptStore = transcriptStore;
    this.now = now;
    this.resolveWorkspace = resolveWorkspace;
    this.getGroupToolCapability = getGroupToolCapability;
    this.listBindingModels = listBindingModels;
  }

  async getModels({ member, binding = null }) {
    const productStore = this.getWorkRunCoordinator().productStore;
    const session = binding?.sessionKey ? this.chatSessionStore.getSession(binding.sessionKey) : null;
    if (binding?.sessionKey && (!session || session.profileId !== member.profileId)) throw modelError();
    const profile = productStore.resolveAgentRuntimeProfile(member.profileId, session?.runtimeBindingId ?? undefined);
    const identity = JSON.stringify(profile), models = [], cursors = new Set();
    let cursor = null;
    for (let i = 0; i < 16; i++) {
      const page = await this.listBindingModels({ profileId: member.profileId,
        bindingId: profile.selectedBindingId ?? profile.defaultBindingId, cursor, limit: 100 });
      models.push(...page.models.map(item => ({ id: item.id, name: item.displayName || item.id, provider: profile.runtime })));
      if (models.length > 512) throw modelError("GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE");
      if (!page.hasMore) {
        const current = productStore.resolveAgentRuntimeProfile(member.profileId, session?.runtimeBindingId ?? undefined);
        if (JSON.stringify(current) !== identity || session && this.chatSessionStore.getSession(session.sessionKey)?.revision !== session.revision) throw modelError();
        return assertModelCatalog({ models, defaultModel: profile.defaultModel ?? null });
      }
      if (!page.nextCursor || cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw modelError("GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE");
  }

  async prepareModel({ member, sessionKey, modelSelection }) {
    const session = this.chatSessionStore.getSession(sessionKey);
    if (!session || session.profileId !== member.profileId || session.nextRuntimeSelection
      || this.getWorkRunCoordinator().isSessionBusy?.(sessionKey)) throw modelError();
    if (modelSelection !== null) {
      assertModelSelection(await this.getModels({ member, binding: { sessionKey } }), modelSelection);
      if (this.getWorkRunCoordinator().isSessionBusy?.(sessionKey)) throw modelError();
      this.chatSessionStore.setModelOverride(sessionKey, modelSelection.model);
    } else if (session.modelOverride !== null) {
      // Reset only this internal session. The default is resolved by the normal
      // immutable WorkRun contract, so later Agent model edits are inherited.
      this.chatSessionStore.setModelOverride(sessionKey, null);
    }
  }

  /** Observe the selected or frozen binding; preparation never starts a model turn. */
  async probe({ member, binding = null, runId = null, onCapabilitiesChanged = null } = {}) {
    const coordinator = this.getWorkRunCoordinator();
    const session = binding?.sessionKey ? this.chatSessionStore.getSession(binding.sessionKey) : null;
    const profileId = session?.profileId ?? binding?.profileId ?? member?.profileId;
    try {
      if (binding?.sessionKey && !session) {
        return groupCapabilities({ availability: "unknown", source: "native-binding", checkedAt: this.now() });
      }
      let profile, host, liveContext, liveContract, assertCurrent;
      if (runId) {
        const live = coordinator.getProductHelpContext?.(profileId, runId);
        const contract = coordinator.runExecutionContracts?.get(runId);
        const context = coordinator.runContexts?.get(runId);
        if (!live || !contract || contract.runId !== runId || contract.profileId !== profileId || !context?.host
          || context.profileId !== profileId || !context.runtimeBinding
          || ["runtime", "runtimeProfileId", "runtimeAccountId"]
            .some(key => context.runtimeBinding[key] !== contract[key])) {
          return groupCapabilities({ availability: "unknown", source: "native-binding", checkedAt: this.now() });
        }
        // A live execution keeps its original binding and both permission
        // policies. Missing context cannot authorize a replacement host.
        profile = { ...contract, id: contract.profileId };
        host = context.host;
        liveContext = context; liveContract = contract;
      } else {
        const selected = coordinator.productStore.resolveAgentRuntimeProfile?.(profileId, session?.runtimeBindingId)
          ?? coordinator.productStore.getAgentProfile(profileId);
        if (!selected?.enabled || !isRuntimeAvailable(selected.runtime)) {
          return groupCapabilities({ availability: "unavailable", checkedAt: this.now() });
        }
        const permission = resolveRuntimePermissionMode(selected.runtime, session?.permissionMode ?? null, selected.permissionPolicy);
        // Coordinator acquires the host with the profile policy; the selected
        // session mode is the separately frozen permission used by the turn.
        const runtimeHostPermissionPolicy = selected.permissionPolicy ? Object.freeze({ ...selected.permissionPolicy }) : undefined;
        const workspace = session ? session.workspace ?? null : binding?.workspace ?? this.resolveWorkspace(selected);
        profile = { ...selected, workspace, permissionMode: permission.mode, nativePermissionMode: permission.nativeMode,
          permissionPolicy: permission.permissionPolicy, runtimeHostPermissionPolicy };
        const selectedIdentity = JSON.stringify(selected);
        const account = coordinator.runtimeAccountAdmission?.read?.(selected.runtimeAccountId);
        assertCurrent = () => {
          const current = coordinator.productStore.resolveAgentRuntimeProfile?.(profileId, session?.runtimeBindingId)
            ?? coordinator.productStore.getAgentProfile(profileId);
          const currentSession = session && this.chatSessionStore.getSession(binding.sessionKey);
          const currentAccount = coordinator.runtimeAccountAdmission?.read?.(selected.runtimeAccountId);
          if (currentAccount?.mutationActive || currentAccount?.generation !== account?.generation) throw Error("group preparation account changed");
          if (JSON.stringify(current) !== selectedIdentity || session && (!currentSession
            || currentSession.revision !== session.revision || currentSession.runtimeBindingId !== session.runtimeBindingId
            || currentSession.workspace !== session.workspace)) throw Error("group preparation binding changed");
        };
        host = await coordinator.runtimeManager.acquire({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
          runtimeAccountId: profile.runtimeAccountId }, { workspace, permissionPolicy: runtimeHostPermissionPolicy });
      }
      const runtimeBinding = { runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
        runtimeAccountId: profile.runtimeAccountId };
      const capabilities = host?.capabilities;
      const proof = await this.getGroupToolCapability({ profile, binding: runtimeBinding, host, session, runId, assertCurrent, onCapabilitiesChanged });
      if (runId && (coordinator.runContexts?.get(runId) !== liveContext
        || coordinator.runExecutionContracts?.get(runId) !== liveContract
        || !coordinator.getProductHelpContext?.(profileId, runId))) {
        return groupCapabilities({ availability: "unknown", source: "native-binding", checkedAt: this.now() });
      }
      return nativeCapabilities(capabilities, proof, { checkedAt: this.now(), mode: profile.runtime });
    } catch {
      return groupCapabilities({ availability: runId ? "unknown" : "unavailable", source: runId ? "native-binding" : "unavailable", checkedAt: this.now() });
    }
  }

  // 逻辑键 groupId + memberId + threadId + purpose 决定唯一的创建操作，重放返回同一会话。
  async ensureSession(binding) {
    if (binding.sessionKey) return binding.sessionKey;
    // 会话被放弃重建过（任务换了工作副本）时，创建操作的键带上代次，不会命中旧会话。
    const epoch = binding.external?.retired?.length ?? 0;
    const key = crypto.createHash("sha256")
      .update([binding.groupId, binding.memberId, binding.threadId, binding.purpose, ...(epoch ? [`r${epoch}`] : [])].join("\0"), "utf8")
      .digest("hex");
    const result = await this.getChatServiceController().handle("chat.session.create", {
      operationId: `${GROUP_SESSION_OPERATION_PREFIX}${key}`,
      profileId: binding.profileId,
      // 任务的独立工作副本：会话直接以它为工作区；其余沿用成员的默认工作区。
      workspace: binding.workspace ?? null,
      createdAt: this.now(),
    });
    return result.session.sessionKey;
  }

  async start({ sessionKey, operationId, prompt, attachments = [] }) {
    const result = await this.getChatServiceController().handle("chat.send", {
      operationId, sessionKey, prompt, createdAt: this.now(), ...(attachments.length ? { attachments } : {}),
    });
    return result.run;
  }

  findRun({ operationId, sessionKey }) {
    if (!sessionKey) return null;
    return this.getWorkRunCoordinator().getChatRunByOperation(operationId, sessionKey) || null;
  }

  /**
   * 原生运行的交互请求 → 规范化请求（与灵感同一份交互合同）。钩子没带事件时从运行快照取当前请求。
   * @returns {{ request: object, context: {command: string|null, cwd: string|null} } | null}
   */
  interactionRequest(run, interaction) {
    const live = interaction?.phase === "requested" ? { type: interaction.eventType, payload: interaction.payload }
      : this.getWorkRunCoordinator().getRunSnapshot?.(run.id)?.interaction;
    if (!live?.payload) return null;
    const request = normalizeInteractiveRequestV1({ runId: run.id, eventType: live.type, payload: live.payload,
      expiresAt: live.payload.expiresAt ?? null });
    return { request, context: {
      command: typeof live.payload.command === "string" ? live.payload.command : null,
      cwd: typeof live.payload.cwd === "string" ? live.payload.cwd : null,
    } };
  }

  // 回应映射与灵感一致：运行时审批走 respondApproval，其余（含 MCP 授权）走 respondInput。
  async respond({ runId, request, response, operationId }) {
    const coordinator = this.getWorkRunCoordinator();
    const common = { operationId, runId, requestId: request.requestId };
    if (request.kind === "runtime_approval") {
      await coordinator.respondApproval({ ...common, choice: response.choice });
    } else if (request.kind === "mcp_permission") {
      await coordinator.respondInput({ ...common, action: response.choice === "deny" ? "cancel" : "submit", answers: {} });
    } else {
      await coordinator.respondInput({ ...common, action: response.action, answers: response.answers });
    }
  }

  /** 原生运行的事件流（按游标读取），用于群里的回复草稿。 */
  async readEvents({ runId, streamId, afterSeq }) {
    return this.getChatServiceController().handle("run.subscribe", { runId, streamId, afterSeq, limit: 100 });
  }

  getRun(runId) {
    return this.getWorkRunCoordinator().getRun(runId) || null;
  }

  async abort({ sessionKey, runId }) {
    await this.getChatServiceController().handle("chat.abort", {
      operationId: `group-abort-${runId}`, sessionKey, runId, createdAt: this.now(),
    });
  }

  publicProgress(run, { includeFinal = false, publishedText = null } = {}) {
    const session = this.chatSessionStore.getSession(run.sourceId);
    if (!session || session.profileId !== run.profileId) return null;
    return redactGrantTokens(this.transcriptStore.listEvents(session.profileId, session.id)
      .filter(event => event.runId === run.id && event.kind === "assistant"
        && (event.content?.phase === "commentary" || includeFinal
          && (event.content?.phase === "final_answer" || event.content?.phase == null))
        && event.content?.delivery !== "async")
      .map(event => (this.transcriptStore.displayEvent?.(session.profileId, session.id, event) ?? event).content.text)
      .filter(text => validText(text) && text.trim() && !isPassReply(text) && text !== publishedText)
      .join("\n\n"));
  }

  // 公开发言取该运行最后一条最终回答的完整正文；选择规则与 WorkRun resultSummary 一致，
  // 但不受 resultSummary 的 4 KiB 截断。
  async recoverFinalText(run, assertCurrent) {
    try { if (this.finalText(run)?.trim()) return; } catch { /* A missing full-text file also needs original-result recovery. */ }
    await this.getWorkRunCoordinator().recoverGroupChatResult(run.id, assertCurrent);
  }

  finalText(run) {
    const session = this.chatSessionStore.getSession(run.sourceId);
    if (!session) return null;
    const messages = this.transcriptStore.listEvents(session.profileId, session.id)
      .filter((event) => event.runId === run.id && event.kind === "assistant"
        && event.content?.delivery !== "async"
        && typeof event.content?.text === "string" && event.content.text.length > 0);
    const selected = [...messages].reverse().find((event) => event.content.phase === "final_answer")
      || [...messages].reverse().find((event) => event.content.phase == null);
    return selected ? (this.transcriptStore.displayEvent?.(session.profileId, session.id, selected) ?? selected).content.text : null;
  }

  responseMetadata(run) {
    return this.getWorkRunCoordinator().getRunMessageMetadata?.(run.id, { profileId: run.profileId, sessionKey: run.sourceId }) ?? null;
  }
}

module.exports = { GroupNativeExecutor };
