"use strict";

const { fail } = require("./group-chat-protocol");
const { resultPage, sha256 } = require("../group-result-content");
const { groupRunTarget, isGroupChatRun } = require("./group-chat-run");
const { serviceError } = require("./security");
const { redactGrantTokens } = require("./group-tool-grant");
const { systemText } = require("./group-room-prompt");
const { GroupResponsePages } = require("../group-response-pages");
const { assertModelCatalog, assertModelSelection } = require("../group-member-model");

const MAX_TOOL_MESSAGES = 20;
const MAX_TOOL_MESSAGES_BYTES = 32 * 1024;
const MAX_HISTORY_BYTES = 48 * 1024;

const NATIVE_BACKEND_ID = "shoggoth";
const EXTERNAL_BACKEND_IDS = new Set(["hermes", "openclaw"]);

function publicMessage(message, preview = false) {
  const { originKey: _originKey, requestedMentions: _requestedMentions, requestedTaskId: _requestedTaskId, ...rest } = message;
  if (message.author.kind !== "system") {
    rest.body = resultPage(message.body).text;
    if (preview) rest.body = Array.from(rest.body).slice(0, 256).join("");
    if (rest.body !== message.body) rest.fullResult = message.fullResult
      ?? { bytes: Buffer.byteLength(message.body), digest: sha256(message.body) };
  }
  return rest;
}

function publicMember(member) {
  const { profileId: _profileId, ...rest } = member;
  return { ...rest, modelSelection: member.modelSelection ?? null };
}

function publicGroupView(view) {
  return {
    ownerScope: view.ownerScope,
    group: view.group,
    currentOwnerId: view.currentOwnerId,
    members: view.members.map(publicMember),
    round: view.round,
    activeTurns: view.activeTurns,
    queuedMemberIds: view.queuedMemberIds,
    internalSessionKeys: view.internalSessionKeys,
    pendingInteractions: view.pendingInteractions,
    ...(Object.hasOwn(view, "lastMessage") ? { lastMessage: view.lastMessage && publicMessage(view.lastMessage, true) } : {}),
  };
}

// 群聊 RPC：参数已由 group-chat-protocol 严格校验；成员身份由宿主解析，不信任客户端。
class GroupChatService {
  constructor({ store, driver, directory = null, productStore, getFederationClient = () => null,
    getMediaStore = () => null, nativeExecutor = null, onChanged = () => {} }) {
    this.responsePages = new GroupResponsePages({ now: store.now ?? Date.now });
    this.store = store;
    this.driver = driver;
    this.directory = directory;
    this.productStore = productStore;
    this.nativeExecutor = nativeExecutor;
    this.getFederationClient = getFederationClient;
    this.getMediaStore = getMediaStore;
    this.onChanged = onChanged;
    this.agentAccess = new (require("./group-chat-agent-access").GroupChatAgentAccess)(this);
  }

  // 原生 Agent 查本机 Profile；Hermes / OpenClaw 经 App 私有桥确认 Agent 存在并取名字。
  resolveAgentAccessMembers(refs) { return Promise.all(refs.map(ref => this.#resolveMember(ref))); }

  assertAgentAccessMembersCurrent(members) {
    // External resolution can await a bridge. Recheck native identities at the
    // synchronous commit boundary so an intervening rename/archive is not lost.
    const profiles = this.productStore.listAgentProfiles();
    for (const member of members.filter(item => item.backendId === NATIVE_BACKEND_ID)) {
      const profile = profiles.find(item => item.id === member.profileId && item.agentId === member.agentId);
      if (!profile?.enabled) fail("GROUP_CHAT_PROFILE_UNAVAILABLE");
      if ((profile.name || profile.agentId) !== member.displayName) fail("GROUP_CHAT_REVISION_CONFLICT");
    }
  }

  async #resolveMember(ref) {
    if (EXTERNAL_BACKEND_IDS.has(ref.backendId)) {
      const client = this.getFederationClient();
      if (!client) fail("GROUP_CHAT_PROFILE_UNAVAILABLE");
      let agent;
      try { ({ agent } = await client.request(ref.peerId ? "group.external.member" : "agent.get", { backendId: ref.backendId, agentId: ref.agentId, ...(ref.peerId ? { peerId: ref.peerId } : {}) })); }
      catch { fail("GROUP_CHAT_PROFILE_UNAVAILABLE"); }
      return { backendId: ref.backendId, agentId: ref.agentId, ...(ref.peerId ? { peerId: ref.peerId } : {}), profileId: null, displayName: agent.name || ref.agentId };
    }
    if (ref.backendId !== NATIVE_BACKEND_ID) fail("GROUP_CHAT_MEMBER_UNSUPPORTED");
    const profile = this.productStore.listAgentProfiles().find((item) => item.agentId === ref.agentId);
    if (!profile || !profile.enabled) fail("GROUP_CHAT_PROFILE_UNAVAILABLE");
    return { backendId: ref.backendId, agentId: ref.agentId, profileId: profile.id,
      displayName: profile.name || ref.agentId };
  }

  async #memberModels(groupId, memberId) {
    const view = this.store.getGroup(groupId);
    const member = view.members.find(item => item.id === memberId && item.state === "active");
    if (!member) fail("GROUP_CHAT_MEMBER_NOT_FOUND");
    let catalog;
    try {
      catalog = member.profileId
        ? await this.nativeExecutor.getModels({ member, binding: this.store.getDiscussionBinding(groupId, memberId) })
        : await this.getFederationClient().request("group.external.models", { backendId: member.backendId,
          agentId: member.agentId, ...(member.peerId ? { peerId: member.peerId } : {}) });
    } catch { fail("GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE"); }
    const current = this.store.getGroup(groupId).members.find(item => item.id === memberId && item.state === "active");
    if (!current) fail("GROUP_CHAT_MEMBER_NOT_FOUND");
    return assertModelCatalog(catalog);
  }

  async #view(groupId, { refresh = false } = {}) {
    if (refresh && this.store.groupLifecycle(groupId) === "active") {
      try {
        const refreshed = await this.directory?.refresh(groupId);
        if (refreshed?.changed) this.#changed(groupId);
      } catch { /* 成员卡刷新失败时展示已有卡 */ }
    }
    const view = publicGroupView(this.store.getGroup(groupId));
    if (view.group.status !== "active") return view;
    // 正在发言 / 在后台干活的成员：带上它们的草稿与活动（只在内存，不进群日志）。
    view.activeTurns = view.activeTurns.map((turn) => ({ ...turn, draft: this.driver.draftFor?.(turn.opportunityId) ?? null,
      activity: this.driver.activityFor?.(turn.opportunityId) ?? null }));
    return view;
  }

  #changed(groupId) {
    try { this.onChanged(groupId); } catch { /* 通知是旁路，不影响已提交的写入 */ }
  }

  agentAccessChanged(groupId) {
    this.#changed(groupId);
    this.driver.wake(groupId);
  }

  async handle(method, params) {
    if (method === "group.execution.receipt") return this.store.executionTerminalReceipt(params);
    if (method === "group.delete") {
      this.store.deleteGroup(params);
      this.responsePages.deleteGroup(params.groupId);
      await this.driver.deleteGroup(params.groupId);
      this.#changed(params.groupId);
      return this.store.finishGroupDeletion(params.groupId);
    }
    if (params.groupId && this.store.groupLifecycle(params.groupId) === "deleted") fail("GROUP_CHAT_DELETED");
    if (method === "group.send.lookup") {
      const result = this.store.lookupSend(params);
      return { ...result, message: result.message ? publicMessage(result.message) : null };
    }
    if (method === "group.hosts.list") return this.getFederationClient() ? this.getFederationClient().request("group.hosts.list", {}) : { members: [] };
    if (method === "group.host.test") return this.getFederationClient().request("group.host.test", params);
    if (method === "group.remote.tool") {
      try { return await this.callBoundExternalTool(params.name, params.arguments, params.callId, params.identity); }
      catch (error) { if (["MCP_TOOL_FORBIDDEN", "MCP_TOOL_ARGUMENTS_INVALID"].includes(error?.code)) return { ok: false, code: error.code }; throw error; }
    }
    if (method === "group.response.read") return this.responsePages.read(params);
    if (method === "group.artifacts.list") {
      const result = this.store.listRecentArtifacts(params);
      let partial = false;
      const items = result.items.filter(item => {
        try { this.getMediaStore().assertAvailable([item.attachment]); return true; }
        catch { partial = true; return false; }
      });
      // Only metadata is read during Dashboard polling. File bytes use the existing media/reveal route on click.
      return { supported: true, items, truncated: result.truncated, partial };
    }
    if (method === "group.list") {
      return { groups: this.store.listGroups({ includeArchived: params.includeArchived }).map(publicGroupView),
        internalSessions: this.store.listInternalSessions() };
    }
    if (method === "group.get") return this.#view(params.groupId, { refresh: true });
    if (method === "group.member.role") {
      if (!this.directory) fail("GROUP_CHAT_UNAVAILABLE");
      return this.directory.readRole(params.groupId, params.memberId, { revision: params.revision ?? "latest", cursor: params.cursor });
    }
    if (method === "group.member.role.history") {
      if (!this.directory) fail("GROUP_CHAT_UNAVAILABLE");
      return this.directory.history(params.groupId, params.memberId, { before: params.before, limit: params.limit });
    }
    if (method === "group.history") {
      const result = this.store.listMessages(params);
      const rows = result.messages.map(message => publicMessage(message));
      // 仍以 seq 分页；向前取最早一段，向后取最近一段，正文总量也受 IPC 帧上限约束。
      const candidates = params.afterSeq !== null ? rows : [...rows].reverse();
      const messages = [];
      let bytes = 0;
      for (const message of candidates) {
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        if (bytes + size > MAX_HISTORY_BYTES) break;
        messages.push(message); bytes += size;
      }
      if (params.afterSeq === null) messages.reverse();
      return { messages, hasMore: result.hasMore || messages.length < rows.length };
    }
    if (method === "group.message.read") return this.store.readMessage(params);
    if (method === "group.search") return require("./group-message-search").searchGroupMessages(this.store, params);
    if (method === "group.execution.reconcile") {
      const opportunity = this.store.getOpportunity(params.target.opportunityId);
      if (!opportunity || opportunity.groupId !== params.groupId) fail("GROUP_CHAT_INTERACTION_EXPIRED");
      await this.driver.reconcile(opportunity.id);
      return this.#view(params.groupId);
    }
    if (method === "group.create") {
      const { groupId } = this.store.createGroup({
        operationId: params.operationId, name: params.name, purpose: params.purpose,
        members: await Promise.all(params.members.map((ref) => this.#resolveMember(ref))),
      });
      this.#changed(groupId);
      return this.#view(groupId, { refresh: true });
    }
    if (method === "group.update") {
      if (params.patch.status === "archived") {
        const view = publicGroupView(this.store.getGroup(params.groupId));
        this.store.deleteGroup(params);
        await this.driver.deleteGroup(params.groupId);
        this.responsePages.deleteGroup(params.groupId);
        this.#changed(params.groupId);
        return { ...view, group: { ...view.group, status: this.store.groupLifecycle(params.groupId) },
          activeTurns: [], queuedMemberIds: [], pendingInteractions: [], round: null };
      }
      this.store.updateGroup(params);
      this.#changed(params.groupId);
      this.driver.wake(params.groupId);
      return this.#view(params.groupId);
    }
    if (method === "group.members.add") {
      this.store.addMember({ groupId: params.groupId, expectedRosterRevision: params.expectedRosterRevision,
        member: await this.#resolveMember(params.member) });
      this.#changed(params.groupId);
      this.driver.wake(params.groupId);
      return this.#view(params.groupId, { refresh: true });
    }
    if (method === "group.member.models") return this.#memberModels(params.groupId, params.memberId);
    if (method === "group.members.model") {
      // Returning to inheritance remains possible when the old catalog is unavailable.
      if (params.modelSelection !== null) assertModelSelection(await this.#memberModels(params.groupId, params.memberId), params.modelSelection);
      this.store.setMemberModel(params);
      this.#changed(params.groupId);
      return this.#view(params.groupId);
    }
    if (method === "group.members.remove") {
      const { aborts } = this.store.removeMember(params);
      await this.driver.abortAll(aborts);
      this.#changed(params.groupId);
      this.driver.wake(params.groupId);
      return this.#view(params.groupId);
    }
    if (method === "group.members.stop") {
      const { aborts } = this.store.stopMember(params);
      await this.driver.abortAll(aborts);
      this.#changed(params.groupId);
      this.driver.wake(params.groupId);
      return this.#view(params.groupId);
    }
    if (method === "group.send") {
      if (params.attachments.length) {
        // 附件必须已经完整存进媒体库，名称、类型与大小要和上传时一致。
        try { this.getMediaStore().assertAvailable(params.attachments); }
        catch { fail("GROUP_CHAT_ATTACHMENT_INVALID"); }
      }
      const result = this.store.appendUserMessage({ groupId: params.groupId, clientMessageId: params.clientMessageId,
        ownerScope: params.ownerScope ?? null, expectedPolicyVersion: params.expectedPolicyVersion ?? null,
        body: params.body, mentionMemberIds: params.mentions, replyToSeq: params.replyTo, taskId: params.taskId ?? null, attachments: params.attachments,
        requestMode: params.requestMode ?? "auto", discussionId: params.discussionId ?? null, summaryMemberId: params.summaryMemberId ?? null });
      if (!result.duplicate) {
        this.#changed(params.groupId);
        this.driver.wake(params.groupId);
      }
      return { message: publicMessage(result.message), discussionId: result.discussionId,
        duplicate: result.duplicate };
    }
    if (method === "group.discussion.stop") {
      const { aborts } = this.store.stopDiscussion({ groupId: params.groupId });
      await this.driver.abortAll(aborts);
      this.#changed(params.groupId);
      return this.#view(params.groupId);
    }
    if (method === "group.interaction.respond") {
      try {
        const opportunity = this.store.getOpportunity(params.target.opportunityId);
        if (!opportunity || opportunity.groupId !== params.groupId) fail("GROUP_CHAT_INTERACTION_EXPIRED");
        await this.driver.respondInteraction({ opportunityId: opportunity.id, requestId: params.requestId,
          response: params.response, operationId: params.operationId });
      } catch (error) {
        if (error?.code === "INTERACTION_RESPONSE_INVALID") fail("GROUP_CHAT_INTERACTION_INVALID");
        throw error;
      }
      return this.#view(params.groupId);
    }
    if (method === "group.diagnostics") {
      return { ...this.store.diagnostics(), driverRunning: this.driver.fence !== null };
    }
    if (method === "group.turn.retry") {
      this.store.retryMember(params);
      this.#changed(params.groupId);
      this.driver.wake(params.groupId);
      return this.#view(params.groupId);
    }
    fail();
  }

  // ---- 群工具（模型可见，只读）：群与调用成员由宿主按当前运行确定，模型只选择目标 ----

  #toolCaller(run, profileId) {
    const forbidden = () => serviceError("MCP_TOOL_FORBIDDEN", "该工具只能在群聊回合中使用");
    if (!isGroupChatRun(run) || run.profileId !== profileId) throw forbidden();
    const target = groupRunTarget(run);
    if (target.kind !== "turn") throw forbidden();
    const opportunity = this.store.getOpportunity(target.opportunityId);
    if (!opportunity || !["running", "waiting"].includes(opportunity.state) || opportunity.abortReason
      || opportunity.fence !== this.store.getDriverFence()
      || opportunity.observation?.terminalStatus || (opportunity.runId && opportunity.runId !== run.id)) {
      throw forbidden();
    }
    const view = this.store.getGroup(opportunity.groupId);
    const self = view.members.find((member) => member.id === opportunity.memberId);
    if (!self || self.state !== "active" || self.profileId !== profileId) throw forbidden();
    return { view, self, opportunity };
  }

  // 外部成员：凭本轮令牌确定群、成员与回合；令牌只能经它所属那类后端的 MCP 使用。
  #grantCaller(groupToken, federationClient) {
    const forbidden = () => serviceError("MCP_TOOL_FORBIDDEN", "群工具令牌无效、已过期或不属于你");
    const grant = this.store.resolveToolGrant(groupToken);
    if (!grant) throw forbidden();
    const view = this.store.getGroup(grant.opportunity.groupId);
    const self = view.members.find((member) => member.id === grant.opportunity.memberId);
    if (!self || self.state !== "active" || self.profileId || self.backendId !== federationClient) throw forbidden();
    return { view, self, opportunity: grant.opportunity };
  }

  async callBoundExternalTool(name, args, callId, identity) {
    const caller = this.#grantCaller(args.groupToken, identity.backendId);
    if (caller.self.agentId !== identity.agentId || (caller.self.peerId && !identity.execution)) throw serviceError("MCP_TOOL_FORBIDDEN", "群工具调用者与本次运行不符");
    if (identity.execution) {
      const external = caller.opportunity.external;
      const fields = ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"];
      if (!external || fields.some(key => external[key] !== identity.execution[key]) || !external.remote
        || external.remote.hostId !== identity.hostId || external.remote.peerId !== identity.peerId
        || identity.ownerId !== this.store.getRemoteOwnerId() || identity.epoch !== this.store.getDriverFence()) {
        throw serviceError("MCP_TOOL_FORBIDDEN", "远端群工具运行绑定已失效");
      }
    }
    return this.callTool(name, args, null, null, callId, identity.backendId, identity);
  }

  /**
   * @param {string|null} federationClient 外部成员经 shoggoth MCP 调用时为 "hermes" / "openclaw"，
   *   此时 run / profileId 不代表调用者，身份只来自 args.groupToken。
   */
  async callTool(name, args, run, profileId, _callId = null, federationClient = null, boundIdentity = null) {
    const caller = federationClient ? this.#grantCaller(args.groupToken, federationClient) : this.#toolCaller(run, profileId);
    if (federationClient) {
      // 外部成员写进参数的令牌不进群库与时间线。
      args = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, key === "groupToken" ? value
        : Array.isArray(value) ? value.map(redactGrantTokens) : redactGrantTokens(value)]));
    }
    const { view, self } = caller;
    if (self.peerId && !boundIdentity) throw serviceError("MCP_TOOL_FORBIDDEN", "远端成员必须通过其已配对宿主调用群工具");
    if (self.state !== "active") return { ok: false, code: "access_revoked" };
    // 群聊改为直接对话：正式任务与结构化协作已停用（外部适配器仍登记这两个工具名，统一在这里回绝）。
    if (["group_task", "group_collaborate"].includes(name)) {
      return { ok: false, code: "GROUP_TOOL_RETIRED", message: "群聊里不再使用这个工具：直接在回复里说；要请同伴接手就写「@名字」。" };
    }
    if (name === "group_member_role_read") {
      const wanted = args.member.trim().replace(/^@/u, "").normalize("NFKC").toLocaleLowerCase("en-US");
      const target = view.members.find((member) => member.id === args.member.trim()
        || member.handle.normalize("NFKC").toLocaleLowerCase("en-US") === wanted);
      if (!target) return { ok: false, code: "member_not_found" };
      return this.directory ? this.directory.readRole(view.group.id, target.id, { revision: args.revision ?? "seen",
        cursor: args.cursor, seenSnapshotId: caller.opportunity.directorySnapshot?.[target.id] })
        : { ok: false, code: "source_unavailable" };
    }
    if (name === "group_messages_read") {
      if (args.messageSeq !== undefined) {
        return { ok: true, ...this.store.readMessage({ groupId: view.group.id,
          seq: args.messageSeq, offset: args.offset ?? 0, digest: args.digest ?? null }) };
      }
      const limit = Math.min(args.limit ?? 10, MAX_TOOL_MESSAGES);
      const page = this.store.listMessages({ groupId: view.group.id, afterSeq: args.afterSeq ?? null,
        beforeSeq: args.beforeSeq ?? null, limit });
      const byId = new Map(view.members.map((member) => [member.id, member]));
      const nameOf = (id) => byId.get(id)?.displayName ?? "一位已离开的成员";
      const messages = [];
      let bytes = 0;
      for (const message of page.messages) {
        const author = message.author.kind === "user" ? "用户"
          : message.author.kind === "member" ? (byId.get(message.author.memberId)?.displayName ?? "已离开的成员") : "系统";
        const body = message.author.kind === "system" ? systemText(message, nameOf) ?? "群状态更新" : resultPage(message.body).text;
        bytes += Buffer.byteLength(body, "utf8") + 64;
        if (messages.length > 0 && bytes > MAX_TOOL_MESSAGES_BYTES) break;
        messages.push({ seq: message.seq, author, body, createdAt: message.createdAt,
          ...(message.fullResult ? { fullResult: message.fullResult } : {}),
          ...(body !== message.body && message.author.kind !== "system" ? { excerpt: true } : {}),
          ...(message.replyTo ? { replyToSeq: message.replyTo.seq } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments.map((item) => item.name) } : {}) });
      }
      return { ok: true, groupName: view.group.name, messages,
        hasMore: page.hasMore || messages.length < page.messages.length };
    }
    throw serviceError("MCP_TOOL_NOT_FOUND", "未知的群聊工具");
  }
}

module.exports = { GroupChatService, NATIVE_BACKEND_ID };
