"use strict";

const { resultPage, sha256 } = require("../group-result-content");
const { groupSendPayloadDigest } = require("../group-send-payload");
const { parseMentions } = require("./group-mentions");
const { systemText } = require("./group-room-prompt");
const { PUBLIC_MESSAGES } = require("./group-chat-protocol");
const { serviceError } = require("./security");
const { validateGroupChatAgentArguments, GROUP_CHAT_AGENT_WRITE_TOOLS, groupManagementRequest } = require("./group-chat-agent-tools");

const budget = 40 * 1024;
const clip = (text, length) => [...String(text ?? "")].slice(0, length).join("");
const callerKey = authority => authority.federationClient ? `external:${authority.federationClient}` : `native:${authority.profileId}`;
const clientMessageId = (authority, requestId) => `agent-request:${sha256(JSON.stringify([callerKey(authority), requestId]))}`;
const conflict = () => { throw serviceError("MCP_TOOL_STATE_CONFLICT", "群或成员已变化，请重新读取"); };

// Explicit public projections: group views also contain internal session/run IDs,
// raw approvals and workspaces. None of those belong in App-level group tools.
function summary(view, currentAgent, preview = false) {
  const { group, members } = view;
  const active = members.filter(member => member.state === "active");
  const self = currentAgent && active.find(member => member.backendId === currentAgent.backendId && member.agentId === currentAgent.agentId);
  const purpose = preview ? clip(group.purpose, 200) : group.purpose;
  return { id: group.id, name: group.name, purpose, ...(purpose !== group.purpose ? { purposeExcerpt: true } : {}), status: group.status,
    memberCount: active.length,
    joined: currentAgent ? Boolean(self) : null, currentMemberId: self?.id ?? null,
    ownerMemberId: group.ownerMemberId ?? null,
    createdAt: group.createdAt, updatedAt: group.updatedAt };
}
function memberInfo(member) {
  const card = member.card ?? {};
  return { id: member.id, backendId: member.backendId, agentId: member.agentId,
    displayName: member.displayName, handle: member.handle, state: member.state,
    role: card.role ?? null, position: card.position ?? null, specialties: card.specialties ?? [],
    consultWhen: card.consultWhen ?? [], workingStyle: card.workingStyle ?? null,
    availability: card.availability ?? "unknown", freshness: card.freshness ?? "unknown",
    groupTools: card.groupTools ?? false, runtime: card.runtime ?? null };
}
function messageInfo(message, members) {
  const member = members.get(message.author.memberId);
  const body = message.author.kind === "system"
    ? systemText(message, id => members.get(id)?.displayName ?? "一位已离开的成员") ?? "群状态更新" : resultPage(message.body).text;
  return { seq: message.seq, author: { kind: message.author.kind,
    ...(message.author.kind === "member" ? { memberId: message.author.memberId } : {}),
    name: message.author.kind === "user" ? "用户" : message.author.kind === "system" ? "系统" : member?.displayName ?? "已离开的成员",
    ...(member ? { handle: member.handle } : {}) }, body, createdAt: message.createdAt,
    ...(message.author.kind !== "system" ? { fullResult: message.fullResult ?? { bytes: Buffer.byteLength(message.body), digest: sha256(message.body) },
      excerpt: body !== message.body || Boolean(message.fullResult && message.fullResult.bytes > Buffer.byteLength(body)),
      partial: message.author.kind === "member" && !message.fullResult } : {}),
    ...(message.replyTo ? { replyToSeq: message.replyTo.seq } : {}),
    ...(message.origin?.discussionId ? { discussionId: message.origin.discussionId } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(item => item.name) } : {}) };
}

class GroupChatAgentAccess {
  constructor(service) { this.service = service; }
  get store() { return this.service.store; }
  currentAgent(authority) {
    if (authority.federationClient) return null;
    const profile = this.service.productStore.getAgentProfile(authority.profileId);
    if (!profile || !profile.enabled) throw serviceError("MCP_TOOL_FORBIDDEN", "当前 Agent 不可用");
    return { backendId: "shoggoth", agentId: profile.agentId, name: profile.name };
  }
  query(name, args, authority) {
    if (!validateGroupChatAgentArguments(name, args) || GROUP_CHAT_AGENT_WRITE_TOOLS.includes(name)) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS", "群查询参数无效");
    const currentAgent = this.currentAgent(authority);
    if (name === "group_chat_prepare") return this.managementPreview(args, authority).then(value => value.public);
    if (name === "group_chat_list") {
      const scope = args.scope ?? (currentAgent ? "mine" : "all");
      if (scope === "mine" && !currentAgent) return { ok: false, code: "current_member_unknown", currentAgent: null,
        message: "共享 MCP 不能证明当前外部成员身份。可查全部群，或按已知 backendId/agentId 查询成员所在群。" };
      const selected = scope === "mine" ? currentAgent : scope === "member" ? { backendId: args.memberBackendId, agentId: args.memberAgentId } : null;
      const result = this.store.queryAgentGroups({ includeArchived: args.includeArchived ?? false, member: selected,
        query: args.query ?? "", afterId: args.afterId ?? "", limit: args.limit ?? 20 });
      const groups = [];
      let bytes = 0;
      for (const view of result.groups) {
        const item = summary(view, currentAgent, true), size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > budget) break;
        groups.push(item); bytes += size;
      }
      return { ok: true, scope, currentAgent, selectedMember: scope === "member" ? selected : null,
        includeArchived: args.includeArchived ?? false, total: result.total,
        groups, nextAfterId: groups.length < result.groups.length ? groups.at(-1).id : result.nextAfterId };
    }
    const view = this.store.getGroup(args.groupId);
    if (name === "group_chat_get") {
      const prior = args.clientRequestId ? this.store.lookupSend({ groupId: args.groupId,
        clientMessageId: clientMessageId(authority, args.clientRequestId) }) : null;
      return { ok: true, currentAgent, ownerScope: this.store.getOwnerScope(), group: { ...summary(view, currentAgent),
        rosterRevision: view.group.rosterRevision, policyVersion: view.group.policyVersion ?? 1 },
        members: view.members.filter(member => member.state === "active").map(memberInfo),
        removedMemberCount: view.members.filter(member => member.state !== "active").length,
        round: view.round ? { id: view.round.id, status: "running" } : null,
        activeTurns: view.activeTurns.map(turn => ({ memberId: turn.memberId,
          state: turn.stopping ? "stopping" : turn.recovery ? "recovering" : turn.released ? "working" : "speaking" })),
        queuedMemberIds: view.queuedMemberIds,
        waitingMemberIds: [...new Set(view.pendingInteractions.map(item => item.memberId))],
        ...(prior ? { dispatch: { clientRequestId: args.clientRequestId, status: prior.status,
          ...(prior.status === "found" ? { accepted: true, messageSeq: prior.message.seq,
            discussionId: prior.discussionId, targetMemberIds: prior.message.requestedMentions } : {}) } } : {}) };
    }
    const members = new Map(view.members.map(member => [member.id, member]));
    if (name === "group_chat_search") {
      const result = require("./group-message-search").searchGroupMessages(this.store, { groupId: args.groupId,
        query: args.query, discussionId: args.discussionId ?? null, authorKind: args.authorKind ?? null,
        memberId: args.memberId ?? null, cursor: args.cursor ?? null, limit: args.limit ?? 10 });
      return { ok: true, ...result, hits: result.hits.map(hit => ({ ...hit, message: messageInfo(hit.message, members) })) };
    }
    if (args.messageSeq !== undefined) {
      const source = this.store.listMessages({ groupId: args.groupId, afterSeq: args.messageSeq - 1, limit: 1 }).messages[0];
      const result = this.store.readMessage({ groupId: args.groupId, seq: args.messageSeq, offset: args.offset ?? 0, digest: args.digest ?? null });
      return { ok: true, groupId: args.groupId, seq: args.messageSeq, ...result,
        partial: source?.author.kind === "member" && !source.fullResult };
    }
    const forward = args.afterSeq !== undefined;
    const result = this.store.listMessages({ groupId: args.groupId, afterSeq: args.afterSeq ?? null,
      beforeSeq: args.beforeSeq ?? null, limit: args.limit ?? 10 });
    const candidates = forward ? result.messages : [...result.messages].reverse();
    const messages = [];
    let bytes = 0;
    for (const message of candidates) {
      const item = messageInfo(message, members), size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > budget) break;
      messages.push(item); bytes += size;
    }
    if (candidates.length && !messages.length) throw serviceError("MCP_TOOL_RESPONSE_TOO_LARGE", "请按消息序号读取正文");
    if (!forward) messages.reverse();
    const hasMore = result.hasMore || messages.length < result.messages.length;
    return { ok: true, groupId: args.groupId, groupName: view.group.name, messages, hasMore,
      nextBeforeSeq: !forward && hasMore ? messages[0].seq : null,
      nextAfterSeq: forward && hasMore ? messages.at(-1).seq : null };
  }
  managementOperationId(request, authority) {
    return `agent-management:${sha256(JSON.stringify([callerKey(authority), request.clientRequestId]))}`;
  }
  async managementPreview(args, authority) {
    if (!validateGroupChatAgentArguments("group_chat_prepare", args)) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS", "群管理参数无效");
    this.currentAgent(authority);
    const request = groupManagementRequest("group_chat_prepare", args);
    const operationId = this.managementOperationId(request, authority), ownerScope = this.store.getOwnerScope();
    const prior = this.store.lookupAgentManagement(operationId, request);
    if (prior) {
      if (prior.ownerScope !== ownerScope) conflict();
      return { public: { ok: true, state: "completed", ownerScope, receipt: prior }, request, operationId };
    }
    const members = await this.service.resolveAgentAccessMembers(request.members);
    this.currentAgent(authority);
    const group = request.action === "add_members" ? this.store.getGroup(request.groupId) : null;
    if (group) {
      if (group.group.status !== "active") conflict();
      const active = group.members.filter(member => member.state === "active");
      if (active.length + members.length > 32) throw serviceError("GROUP_CHAT_MEMBER_LIMIT", PUBLIC_MESSAGES.GROUP_CHAT_MEMBER_LIMIT);
      if (members.some(member => active.some(existing => existing.backendId === member.backendId && existing.agentId === member.agentId
        && (existing.peerId ?? null) === (member.peerId ?? null)))) {
        throw serviceError("GROUP_CHAT_MEMBER_DUPLICATE", PUBLIC_MESSAGES.GROUP_CHAT_MEMBER_DUPLICATE);
      }
    }
    const groupState = group ? { id: group.group.id, name: group.group.name,
      rosterRevision: group.group.rosterRevision, policyVersion: group.group.policyVersion ?? 1 } : null;
    const previewDigest = sha256(JSON.stringify({ ownerScope, request, members, group: groupState }));
    return { request, operationId, members, groupState, public: { ok: true, state: "prepared", action: request.action,
      ownerScope, previewDigest, ...(groupState ? { group: groupState } : { name: request.name, purpose: request.purpose }),
      members: members.map(({ backendId, agentId, displayName }) => ({ backendId, agentId, displayName })) } };
  }
  async prepareManagement(name, args, authority, runId) {
    if (!validateGroupChatAgentArguments(name, args)) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS", "群管理参数无效");
    const preview = await this.managementPreview(groupManagementRequest(name, args), authority);
    if (preview.public.ownerScope !== args.ownerScope || (preview.public.state === "prepared"
      ? preview.public.previewDigest : preview.public.receipt.previewDigest) !== args.previewDigest) conflict();
    return { callerKey: callerKey(authority), runId, ownerScope: args.ownerScope,
      previewDigest: args.previewDigest, request: preview.request };
  }
  async manage(name, args, authority, binding, assertCurrent) {
    if (binding?.callerKey !== callerKey(authority)) throw serviceError("MCP_TOOL_FORBIDDEN", "群管理调用身份不符");
    assertCurrent?.();
    const request = groupManagementRequest(name, args);
    if (JSON.stringify(request) !== JSON.stringify(binding.request) || binding.ownerScope !== args.ownerScope
      || binding.previewDigest !== args.previewDigest) conflict();
    const preview = await this.managementPreview(request, authority);
    assertCurrent?.();
    if (preview.public.ownerScope !== binding.ownerScope) conflict();
    if (preview.public.state === "completed") {
      if (preview.public.receipt.previewDigest !== binding.previewDigest) conflict();
      return preview.public.receipt;
    }
    if (preview.public.previewDigest !== binding.previewDigest) conflict();
    this.service.assertAgentAccessMembersCurrent(preview.members);
    const result = this.store.applyAgentManagement({ operationId: preview.operationId, request,
      ownerScope: binding.ownerScope, previewDigest: binding.previewDigest, members: preview.members,
      rosterRevision: preview.groupState?.rosterRevision, policyVersion: preview.groupState?.policyVersion });
    this.service.agentAccessChanged(result.groupId);
    return result;
  }
  prepareDispatch(args, authority, runId) {
    if (!validateGroupChatAgentArguments("group_chat_dispatch", args)) throw serviceError("MCP_TOOL_INVALID_ARGUMENTS", "群安排参数无效");
    const view = this.store.getGroup(args.groupId);
    if (args.ownerScope !== this.store.getOwnerScope() || view.group.status !== "active"
      || args.expectedRosterRevision !== view.group.rosterRevision || args.expectedPolicyVersion !== (view.group.policyVersion ?? 1)) conflict();
    const members = view.members.filter(member => member.state === "active");
    if (args.targetMemberIds.some(id => !members.some(member => member.id === id))) conflict();
    const mentions = parseMentions(args.instruction, members.map(member => ({ memberId: member.id, handle: member.handle })));
    if (mentions.unresolved.length || mentions.memberIds.some(id => !args.targetMemberIds.includes(id))
      || mentions.broadcast && members.some(member => !args.targetMemberIds.includes(member.id))) conflict();
    return { callerKey: callerKey(authority), runId, groupName: view.group.name,
      clientMessageId: clientMessageId(authority, args.clientRequestId),
      payload: { groupId: args.groupId, ownerScope: args.ownerScope, expectedPolicyVersion: args.expectedPolicyVersion,
        body: `用户通过私聊确认的群内安排：\n\n${args.instruction}`, mentionMemberIds: args.targetMemberIds,
        requestMode: args.requestMode ?? "new", discussionId: args.discussionId ?? null } };
  }
  dispatch(args, authority, binding, assertCurrent) {
    if (binding?.callerKey !== callerKey(authority)) throw serviceError("MCP_TOOL_FORBIDDEN", "群安排调用身份不符");
    assertCurrent?.();
    const payload = { ...binding.payload, clientMessageId: binding.clientMessageId };
    const prior = this.store.lookupSend({ groupId: args.groupId, ownerScope: args.ownerScope,
      clientMessageId: binding.clientMessageId, payloadDigest: groupSendPayloadDigest(payload) });
    if (prior.status === "unknown" || prior.status === "found" && prior.payloadMatches !== true) conflict();
    const receipt = result => ({ ok: true, accepted: true, status: "submitted", groupId: args.groupId,
      groupName: binding.groupName, clientRequestId: args.clientRequestId, messageSeq: result.message.seq,
      discussionId: result.discussionId, targetMemberIds: args.targetMemberIds,
      instruction: "The request was submitted to the group. Read group details and history for execution progress and results; submission does not prove completion." });
    if (prior.status === "found") return receipt(prior);
    // Membership, policy and owner may change while the confirmation UI is open.
    this.prepareDispatch(args, authority, binding.runId);
    assertCurrent?.();
    const result = this.store.appendUserMessage(payload);
    this.service.agentAccessChanged(args.groupId);
    return receipt(result);
  }
  static publicFailure(error) {
    return error?.code && PUBLIC_MESSAGES[error.code] ? { ok: false, code: error.code, message: PUBLIC_MESSAGES[error.code] } : null;
  }
}
module.exports = { GroupChatAgentAccess };
