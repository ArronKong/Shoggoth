"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");
const { bindConversationSource, latestConversationUserEvent } = require("./conversation-source");
const { parseHeartbeat } = require("./heartbeat-document");
const { parseDailyReview } = require("./daily-review-document");
const { DEFAULT_AGENT_PROFILE_ID } = require("./product-store");
const { isGroupChatRun } = require("./group-chat-run");

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const normalizeName = (name) => name.normalize("NFKC").trim();
const nameKey = (name) => normalizeName(name).toLocaleLowerCase("und");
const isRuleFile = (kind) => kind === "HEARTBEAT" || kind === "DAILY_REVIEW";
const isMemoryFile = (kind) => kind === "USER" || kind === "MEMORY";

function mentionOffsets(text, name, edge = /[a-z0-9_]/iu) {
  const offsets = [];
  if (!name) return offsets;
  for (let start = text.indexOf(name); start >= 0; start = text.indexOf(name, start + 1)) {
    const end = start + name.length;
    if (edge.test(name[0]) && edge.test(text.charAt(start - 1))) continue;
    if (edge.test(name.at(-1)) && edge.test(text.charAt(end))) continue;
    offsets.push(start);
  }
  return offsets;
}

function namesTarget(quote, target, profiles) {
  const hasRequestText = (text, start, size) => /[\p{L}\p{N}]/u.test(text.slice(0, start) + text.slice(start + size));
  if (mentionOffsets(quote, target.agentId, /[a-z0-9._:-]/iu)
    .some(start => hasRequestText(quote, start, target.agentId.length))) return true;
  const text = nameKey(quote);
  const name = nameKey(target.name);
  const others = profiles.filter(profile => profile.id !== target.id).map(profile => nameKey(profile.name));
  if (others.includes(name)) return false;
  // A name embedded in a longer Agent name does not identify the shorter Agent.
  const longer = others.filter(other => other.length > name.length && other.includes(name))
    .flatMap(other => mentionOffsets(text, other).map(start => ({ start, end: start + other.length })));
  return mentionOffsets(text, name).some(start => hasRequestText(text, start, name.length)
    && !longer.some(span => span.start <= start && span.end >= start + name.length));
}

function patchDocument(content, oldText, newText) {
  if (oldText === "") {
    if (content !== "") throw serviceError("DEFINITION_PATCH_CONFLICT", "空 oldText 只能用于空文件");
    return newText;
  }
  const at = content.indexOf(oldText);
  if (at < 0 || content.indexOf(oldText, at + 1) >= 0) {
    throw serviceError("DEFINITION_PATCH_CONFLICT", "oldText 必须精确且唯一匹配当前文件");
  }
  return content.slice(0, at) + newText + content.slice(at + oldText.length);
}

class ConversationDefinitionService {
  constructor({ definitionStore, productStore, agentLifecycleService, transcriptStore, chatSessionStore,
    getRunSessionKey, onProfileRenamed, memoryDefinitionLinks, heartbeatRules, dailyReviewRules, memoryFiles }) {
    this.definitions = definitionStore;
    this.products = productStore;
    this.lifecycle = agentLifecycleService;
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.getRunSessionKey = getRunSessionKey;
    this.onProfileRenamed = onProfileRenamed || (() => {});
    this.memoryDefinitionLinks = memoryDefinitionLinks;
    // { read(profileId), write(profileId, content, expectedRevision) } over the
    // proactive Service, which owns HEARTBEAT.md and stops stale checks on save.
    this.heartbeatRules = heartbeatRules || null;
    this.dailyReviewRules = dailyReviewRules || null;
    // { read(profileId, kind), write({ profileId, kind, content, expectedRevision }) }
    // over file memory; absent when an Agent's memory is not file-authoritative.
    this.memoryFiles = memoryFiles || null;
  }
  bindUserConversation(args, run, { requireQuote = false, latestUserOnly = false } = {}) {
    return bindConversationSource({ args, run, transcriptStore: this.transcripts, chatSessionStore: this.sessions,
      getRunSessionKey: this.getRunSessionKey, requireQuote, latestUserOnly });
  }
  canManageFiles(run) {
    if (run?.profileId !== DEFAULT_AGENT_PROFILE_ID || run.source !== "chat" || isGroupChatRun(run)
      || /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey || "")) return false;
    const session = this.sessions.getSession(run.sourceId);
    return session?.profileId === run.profileId && session.workspace === run.workspace;
  }
  requireManagedProfile(profileId, agentId) {
    const profile = this.products.getAgentProfile(profileId);
    if (!profile || profile.backendId !== "shoggoth" || profile.agentId !== agentId || profile.enabled !== true) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "目标助理已不可编辑");
    }
    return profile;
  }
  bindManagedTarget(args, run, previous) {
    if (!this.canManageFiles(run)) throw serviceError("MCP_AGENT_FILE_SHOGGOTH_CHAT_REQUIRED", "跨助理设定编辑需要与 Shoggoth 主 Agent 的直接会话");
    const source = this.bindUserConversation(args, run, { requireQuote: true, latestUserOnly: true });
    if (hasSecret(JSON.stringify(args))) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    if (previous) {
      if (!isDeepStrictEqual(previous.source, source.source)) throw serviceError("MCP_TOOL_FORBIDDEN", "原授权来源已变化");
      return { source, profile: this.requireManagedProfile(previous.targetProfileId, args.agentId) };
    }
    const profiles = this.products.listAgentProfiles().filter(profile => profile.backendId === "shoggoth" && profile.enabled === true);
    const profile = profiles.find(item => item.agentId === args.agentId);
    if (!profile) throw serviceError("MCP_TOOL_NOT_FOUND", "目标助理不存在或不可编辑");
    if (!namesTarget(args.sourceQuote, profile, profiles)) throw serviceError("MCP_AGENT_FILE_TARGET_REQUIRED", "当前请求需要准确点名目标助理");
    return { source, profile };
  }
  assertManagedSourceCurrent(run, source) {
    if (!this.canManageFiles(run) || source.runId !== run.id) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "当前会话授权已失效");
    }
    const event = latestConversationUserEvent(this.transcripts, run.profileId, source.sessionId, run.id);
    if (event?.id !== source.eventId) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "用户授权消息已失效");
    }
  }
  async readManagedFile(profile, args) {
    let result;
    if (isRuleFile(args.kind)) result = await this.readHeartbeat(profile.id, args);
    else if (isMemoryFile(args.kind)) result = this.readMemoryFile(profile.id, args);
    else result = this.read(profile.id, args);
    if (hasSecret(result.content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定包含凭据");
    return this.managedResult(profile, result);
  }
  async bindManagedUpdate(profile, args, source) {
    let binding;
    if (isRuleFile(args.kind)) binding = await this.bindHeartbeat(profile.id, args, source);
    else if (isMemoryFile(args.kind)) binding = this.bindMemoryFile(profile.id, args, source);
    else binding = this.bindDefinitionEdit(profile.id, { ...args, expectedRevision: Number(args.expectedRevision) }, source);
    return { ...binding, targetProfileId: profile.id };
  }
  async updateManagedFile(args, call, assertCurrent) {
    const profileId = call.binding.targetProfileId;
    let result;
    if (isRuleFile(args.kind)) result = await this.updateHeartbeat(profileId, args, call, assertCurrent);
    else if (isMemoryFile(args.kind)) result = await this.updateMemoryFile(profileId, args, call, assertCurrent);
    else result = await this.update(profileId, { ...args, expectedRevision: Number(args.expectedRevision) }, call, assertCurrent);
    if (result.saved === false) result.instruction = "Read this target and file again with native_agent_file_read and merge the requested edit into the current revision. Check profileRenamed before retrying a rename.";
    return this.managedResult(this.products.getAgentProfile(profileId), result);
  }
  managedResult(profile, result) {
    return { ...result, agentId: profile.agentId, profileName: profile.name,
      ...(result.revision !== undefined ? { revision: String(result.revision) } : {}),
      ...(result.currentRevision !== undefined ? { currentRevision: String(result.currentRevision) } : {}) };
  }
  bind(name, args, run) {
    const requireQuote = ["agent_definition_update", "heartbeat_rules_update", "memory_file_update"].includes(name);
    const source = this.bindUserConversation(args, run, { requireQuote });
    if (hasSecret(JSON.stringify(args))) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    if (["agent_definition_read", "heartbeat_rules_read", "memory_file_read"].includes(name)) return source;
    if (name === "heartbeat_rules_update") return this.bindHeartbeat(run.profileId, args, source);
    if (name === "memory_file_update") return this.bindMemoryFile(run.profileId, args, source);
    return this.bindDefinitionEdit(run.profileId, args, source);
  }
  bindDefinitionEdit(profileId, args, source) {
    const current = this.definitions.get(profileId);
    if (!current || current.manifest.revision !== args.expectedRevision) {
      throw serviceError("DEFINITION_REVISION_CONFLICT", "设定已经变化，请重新读取");
    }
    const content = patchDocument(current.documents[args.kind], args.oldText, args.newText);
    if (Buffer.byteLength(content, "utf8") > this.definitions.maxDocumentBytes) {
      throw serviceError("DEFINITION_DOCUMENT_INVALID", "设定文件超过容量上限");
    }
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    const profile = this.products.getAgentProfile(profileId);
    const newName = args.newName === undefined ? null : normalizeName(args.newName);
    if (newName !== null && (!newName || /[\r\n]/u.test(newName) || Buffer.byteLength(newName) > 128)) {
      throw serviceError("DEFINITION_NAME_INVALID", "名称无效");
    }
    if (args.kind === "IDENTITY") {
      const names = [...content.matchAll(/^- Name: (.+)$/gmu)].map((match) => normalizeName(match[1]));
      if (newName === null && names.length === 1 && names[0] !== normalizeName(profile.name)) {
        throw serviceError("MCP_TOOL_DEFINITION_NEW_NAME_REQUIRED", "改名缺少 newName");
      }
      if (names.length > 1 || (newName !== null && names[0] !== newName)) {
        throw serviceError("DEFINITION_NAME_INVALID", "改名需提供 newName，并与 IDENTITY 的 - Name: 字段一致");
      }
    }
    return { ...source, profileUpdatedAt: profile.updatedAt, profileName: profile.name,
      newName, resultHash: hash(content) };
  }
  read(profileId, args) {
    const current = this.definitions.get(profileId);
    const value = args.revision === undefined ? current : this.definitions.readRevision(profileId, args.revision);
    if (!value) throw serviceError("DEFINITION_NOT_FOUND", "设定版本不存在");
    const content = value.documents[args.kind];
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定包含凭据");
    const points = [...content];
    const offset = args.offset || 0;
    if (offset > points.length) throw serviceError("DEFINITION_OFFSET_INVALID", "读取位置超出文件");
    const end = Math.min(offset + (args.limit || 4096), points.length);
    return { file: `${args.kind}.md`, profileName: this.products.getAgentProfile(profileId).name,
      revision: value.manifest.revision, currentRevision: current.manifest.revision,
      agentRelativePath: value.manifest.documents[args.kind].path,
      contentHash: value.manifest.documents[args.kind].contentHash,
      content: points.slice(offset, end).join(""), offset, nextOffset: end < points.length ? end : null,
      truncated: offset > 0 || end < points.length };
  }
  async update(profileId, args, call, assertCurrent = () => {}) {
    const reason = `conversation-definition:${call.operationId}`;
    const binding = call.binding;
    assertCurrent();
    await this.memoryDefinitionLinks?.prepare(profileId, args, call);
    assertCurrent();
    let current = this.definitions.get(profileId);
    const applied = current.manifest.revision > args.expectedRevision
      ? (this.definitions.readRevision(profileId, args.expectedRevision + 1)
        || this.definitions.readReceipt?.(profileId, args.expectedRevision + 1)) : null;
    if (applied?.manifest.reason === reason
      && applied.manifest.documents[args.kind].contentHash === binding.resultHash) {
      return this.result(profileId, args.kind, applied, current, binding);
    }
    if (current.manifest.revision !== args.expectedRevision) return this.conflict(profileId, current, binding);
    const content = patchDocument(current.documents[args.kind], args.oldText, args.newText);
    if (hash(content) !== binding.resultHash) throw serviceError("DEFINITION_PATCH_CONFLICT", "设定内容已变化");
    const profile = this.products.getAgentProfile(profileId);
    if (binding.newName !== null && profile.name !== binding.newName) {
      if (profile.updatedAt !== binding.profileUpdatedAt || profile.name !== binding.profileName) {
        return this.conflict(profileId, current, binding, "profile-conflict");
      }
      // Reuse the established lifecycle writer and its durable receipt; never
      // change runtime/model/workspace bindings while renaming a Profile.
      await this.lifecycle.handle("agent.update", { operationId: `${call.operationId}:name`,
        profileId, name: binding.newName, defaultCwd: profile.defaultCwd,
        expectedUpdatedAt: binding.profileUpdatedAt, createdAt: call.createdAt });
      try { this.onProfileRenamed(profileId); } catch { /* Observers cannot undo a committed name. */ }
      assertCurrent();
      current = this.definitions.get(profileId);
      if (current.manifest.revision !== args.expectedRevision) {
        const committed = this.definitions.readRevision(profileId, args.expectedRevision + 1)
          || this.definitions.readReceipt?.(profileId, args.expectedRevision + 1);
        if (committed?.manifest.reason === reason
          && committed.manifest.documents[args.kind].contentHash === binding.resultHash) {
          return this.result(profileId, args.kind, committed, current, binding);
        }
        return this.conflict(profileId, current, binding);
      }
    }
    let saved;
    try {
      // The authenticated dialogue supplies user intent. A bare actor=agent
      // still cannot commit through DefinitionStore's low-level API.
      saved = this.definitions.update({ profileId, expectedRevision: args.expectedRevision,
        actor: "user", documents: { [args.kind]: content }, reason });
    } catch (cause) {
      // A filesystem failure may occur after the manifest commit. Keep the MCP
      // receipt pending and reconcile against that revision after restart.
      const error = serviceError("DEFINITION_COMMIT_UNCERTAIN", "设定提交结果待恢复");
      error.cause = cause;
      throw error;
    }
    return this.result(profileId, args.kind, saved, saved, binding);
  }
  rulesFor(kind) {
    const rules = kind === "DAILY_REVIEW" ? this.dailyReviewRules : this.heartbeatRules;
    if (!rules) throw serviceError("DEFINITION_UNAVAILABLE", "定时检查规则暂不可用");
    return rules;
  }
  async bindHeartbeat(profileId, args, source) {
    const current = await this.rulesFor(args.kind).read(profileId);
    if (current.revision !== args.expectedRevision) {
      throw serviceError("DEFINITION_REVISION_CONFLICT", "心跳规则已经变化，请重新读取");
    }
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (args.kind === "DAILY_REVIEW") parseDailyReview(content);
    else parseHeartbeat(content);
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    return { ...source, resultHash: hash(content) };
  }
  async readHeartbeat(profileId, args) {
    const current = await this.rulesFor(args.kind).read(profileId);
    if (hasSecret(current.content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定包含凭据");
    const points = [...current.content];
    const offset = args.offset || 0;
    if (offset > points.length) throw serviceError("DEFINITION_OFFSET_INVALID", "读取位置超出文件");
    const end = Math.min(offset + (args.limit || 4096), points.length);
    return { file: `${args.kind || "HEARTBEAT"}.md`, revision: current.revision, missing: current.missing === true,
      content: points.slice(offset, end).join(""), offset, nextOffset: end < points.length ? end : null,
      truncated: offset > 0 || end < points.length };
  }
  async updateHeartbeat(profileId, args, call, assertCurrent = () => {}) {
    const binding = call.binding;
    const kind = args.kind || "HEARTBEAT";
    const rules = this.rulesFor(kind);
    const current = await rules.read(profileId);
    assertCurrent();
    // A pending receipt replayed after its write already landed.
    if (hash(current.content) === binding.resultHash) return this.heartbeatResult(current, kind);
    if (current.revision !== args.expectedRevision) return this.heartbeatConflict(current, kind);
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (hash(content) !== binding.resultHash) throw serviceError("DEFINITION_PATCH_CONFLICT", "心跳规则已变化");
    let saved;
    try { saved = await rules.write(profileId, content, args.expectedRevision); }
    catch (error) {
      if (error?.code === "PROACTIVE_REVISION_CONFLICT") return this.heartbeatConflict(await rules.read(profileId), kind);
      throw error;
    }
    return this.heartbeatResult(saved, kind);
  }
  heartbeatConflict(current, kind) {
    return { saved: false, status: kind === "DAILY_REVIEW" ? "daily-review-conflict" : "heartbeat-conflict",
      file: `${kind}.md`, currentRevision: current.revision,
      instruction: "Read HEARTBEAT.md again with heartbeat_rules_read, preserve concurrent changes, and retry the requested edit. Nothing was saved by this call." };
  }
  heartbeatResult(document, kind) {
    return { saved: true, status: "updated", file: `${kind}.md`, revision: document.revision,
      effective: kind === "DAILY_REVIEW" ? "next-daily-review" : "next-heartbeat-check" };
  }
  memoryFile(profileId, kind) {
    if (!this.memoryFiles) throw serviceError("DEFINITION_UNAVAILABLE", "记忆文件暂不可用");
    return this.memoryFiles.read(profileId, kind);
  }
  bindMemoryFile(profileId, args, source) {
    const current = this.memoryFile(profileId, args.kind);
    if (current.revision !== args.expectedRevision) {
      throw serviceError("DEFINITION_REVISION_CONFLICT", "记忆文件已经变化，请重新读取");
    }
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "记忆文件不能包含凭据");
    return { ...source, resultHash: hash(content) };
  }
  readMemoryFile(profileId, args) {
    const current = this.memoryFile(profileId, args.kind);
    const points = [...current.content];
    const offset = args.offset || 0;
    if (offset > points.length) throw serviceError("DEFINITION_OFFSET_INVALID", "读取位置超出文件");
    const end = Math.min(offset + (args.limit || 4096), points.length);
    return { file: `${args.kind}.md`, revision: current.revision,
      content: points.slice(offset, end).join(""), offset, nextOffset: end < points.length ? end : null,
      truncated: offset > 0 || end < points.length };
  }
  async updateMemoryFile(profileId, args, call, assertCurrent) {
    const binding = call.binding;
    assertCurrent?.();
    const current = this.memoryFile(profileId, args.kind);
    // A pending receipt replayed after its write already landed.
    if (current.revision === binding.resultHash) return this.memoryFileResult(args.kind, current.revision);
    if (current.revision !== args.expectedRevision) return this.memoryFileConflict(args.kind, current.revision);
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (hash(content) !== binding.resultHash) throw serviceError("DEFINITION_PATCH_CONFLICT", "记忆文件已变化");
    let saved;
    try { saved = await this.memoryFiles.write({ profileId, kind: args.kind, content,
      expectedRevision: args.expectedRevision, ...(assertCurrent ? { assertCurrent } : {}) }); }
    catch (error) {
      if (error?.code === "MEMORY_REVISION_CONFLICT") return this.memoryFileConflict(args.kind, this.memoryFile(profileId, args.kind).revision);
      throw error;
    }
    return this.memoryFileResult(args.kind, saved.revision);
  }
  memoryFileConflict(kind, currentRevision) {
    return { saved: false, status: "memory-file-conflict", file: `${kind}.md`, currentRevision,
      instruction: "Read the file again with memory_file_read, preserve concurrent changes, and retry the requested edit. Nothing was saved by this call." };
  }
  memoryFileResult(kind, revision) {
    return { saved: true, status: "updated", file: `${kind}.md`, revision, effective: "memory-recall-now" };
  }
  conflict(profileId, current, binding, status = "definition-conflict") {
    const profileName = this.products.getAgentProfile(profileId).name;
    return { saved: false, status, currentRevision: current.manifest.revision, profileName,
      profileRenamed: binding.newName !== null && binding.profileName !== profileName
        && profileName === binding.newName,
      instruction: "Read the live definition again, preserve concurrent changes, and retry the requested edit. Report any completed rename separately; the definition has not been saved by this call." };
  }
  result(profileId, kind, applied, current, binding) {
    return { saved: true, status: "updated", file: `${kind}.md`, revision: applied.manifest.revision,
      currentRevision: current.manifest.revision, contentHash: applied.manifest.documents[kind].contentHash,
      agentRelativePath: applied.manifest.documents[kind].path,
      profileName: this.products.getAgentProfile(profileId).name,
      profileRenamed: binding.newName !== null && binding.newName !== binding.profileName,
      effective: "next-turn" };
  }
}

module.exports = { ConversationDefinitionService };
