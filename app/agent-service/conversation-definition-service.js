"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");
const { bindConversationSource } = require("./conversation-source");
const { parseHeartbeat } = require("./heartbeat-document");

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const normalizeName = (name) => name.normalize("NFKC").trim();
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
  constructor({ definitionStore, productStore, agentLifecycleService, transcriptStore, chatSessionStore, getRunSessionKey, onProfileRenamed, memoryDefinitionLinks, heartbeatRules, memoryFiles }) {
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
    // { read(profileId, kind), write({ profileId, kind, content, expectedRevision }) }
    // over file memory; absent when an Agent's memory is not file-authoritative.
    this.memoryFiles = memoryFiles || null;
  }
  bind(name, args, run) {
    const source = bindConversationSource({ args, run, transcriptStore: this.transcripts, chatSessionStore: this.sessions,
      getRunSessionKey: this.getRunSessionKey,
      requireQuote: ["agent_definition_update", "heartbeat_rules_update", "memory_file_update"].includes(name) });
    if (hasSecret(JSON.stringify(args))) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    if (["agent_definition_read", "heartbeat_rules_read", "memory_file_read"].includes(name)) return source;
    if (name === "heartbeat_rules_update") return this.bindHeartbeat(run.profileId, args, source);
    if (name === "memory_file_update") return this.bindMemoryFile(run.profileId, args, source);
    const current = this.definitions.get(run.profileId);
    if (!current || current.manifest.revision !== args.expectedRevision) {
      throw serviceError("DEFINITION_REVISION_CONFLICT", "设定已经变化，请重新读取");
    }
    const content = patchDocument(current.documents[args.kind], args.oldText, args.newText);
    if (Buffer.byteLength(content, "utf8") > this.definitions.maxDocumentBytes) {
      throw serviceError("DEFINITION_DOCUMENT_INVALID", "设定文件超过容量上限");
    }
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    const profile = this.products.getAgentProfile(run.profileId);
    const newName = args.newName === undefined ? null : normalizeName(args.newName);
    if (newName !== null && (!newName || /[\r\n]/u.test(newName) || Buffer.byteLength(newName) > 128)) {
      throw serviceError("DEFINITION_NAME_INVALID", "名称无效");
    }
    if (args.kind === "IDENTITY") {
      const names = [...content.matchAll(/^- Name: (.+)$/gmu)].map((match) => normalizeName(match[1]));
      if (names.length > 1 || (newName !== null && names[0] !== newName)
        || (newName === null && names.length === 1 && names[0] !== normalizeName(profile.name))) {
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
  async update(profileId, args, call) {
    const reason = `conversation-definition:${call.operationId}`;
    const binding = call.binding;
    await this.memoryDefinitionLinks?.prepare(profileId, args, call);
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
  async heartbeatDocument(profileId) {
    if (!this.heartbeatRules) throw serviceError("DEFINITION_UNAVAILABLE", "心跳规则暂不可用");
    return this.heartbeatRules.read(profileId);
  }
  async bindHeartbeat(profileId, args, source) {
    const current = await this.heartbeatDocument(profileId);
    if (current.revision !== args.expectedRevision) {
      throw serviceError("DEFINITION_REVISION_CONFLICT", "心跳规则已经变化，请重新读取");
    }
    const content = patchDocument(current.content, args.oldText, args.newText);
    parseHeartbeat(content);
    if (hasSecret(content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    return { ...source, resultHash: hash(content) };
  }
  async readHeartbeat(profileId, args) {
    const current = await this.heartbeatDocument(profileId);
    if (hasSecret(current.content)) throw serviceError("DEFINITION_SECRET_REJECTED", "设定包含凭据");
    const points = [...current.content];
    const offset = args.offset || 0;
    if (offset > points.length) throw serviceError("DEFINITION_OFFSET_INVALID", "读取位置超出文件");
    const end = Math.min(offset + (args.limit || 4096), points.length);
    return { file: "HEARTBEAT.md", revision: current.revision, missing: current.missing === true,
      content: points.slice(offset, end).join(""), offset, nextOffset: end < points.length ? end : null,
      truncated: offset > 0 || end < points.length };
  }
  async updateHeartbeat(profileId, args, call) {
    const binding = call.binding;
    const current = await this.heartbeatDocument(profileId);
    // A pending receipt replayed after its write already landed.
    if (hash(current.content) === binding.resultHash) return this.heartbeatResult(current);
    if (current.revision !== args.expectedRevision) return this.heartbeatConflict(current);
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (hash(content) !== binding.resultHash) throw serviceError("DEFINITION_PATCH_CONFLICT", "心跳规则已变化");
    let saved;
    try { saved = await this.heartbeatRules.write(profileId, content, args.expectedRevision); }
    catch (error) {
      if (error?.code === "PROACTIVE_REVISION_CONFLICT") return this.heartbeatConflict(await this.heartbeatDocument(profileId));
      throw error;
    }
    return this.heartbeatResult(saved);
  }
  heartbeatConflict(current) {
    return { saved: false, status: "heartbeat-conflict", file: "HEARTBEAT.md", currentRevision: current.revision,
      instruction: "Read HEARTBEAT.md again with heartbeat_rules_read, preserve concurrent changes, and retry the requested edit. Nothing was saved by this call." };
  }
  heartbeatResult(document) {
    return { saved: true, status: "updated", file: "HEARTBEAT.md", revision: document.revision,
      effective: "next-heartbeat-check" };
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
  async updateMemoryFile(profileId, args, call) {
    const binding = call.binding;
    const current = this.memoryFile(profileId, args.kind);
    // A pending receipt replayed after its write already landed.
    if (current.revision === binding.resultHash) return this.memoryFileResult(args.kind, current.revision);
    if (current.revision !== args.expectedRevision) return this.memoryFileConflict(args.kind, current.revision);
    const content = patchDocument(current.content, args.oldText, args.newText);
    if (hash(content) !== binding.resultHash) throw serviceError("DEFINITION_PATCH_CONFLICT", "记忆文件已变化");
    let saved;
    try { saved = await this.memoryFiles.write({ profileId, kind: args.kind, content, expectedRevision: args.expectedRevision }); }
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
