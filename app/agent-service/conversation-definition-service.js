"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { hasSecret } = require("./memory-engine");
const { bindConversationSource } = require("./conversation-source");

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
  constructor({ definitionStore, productStore, agentLifecycleService, transcriptStore, chatSessionStore, getRunSessionKey, onProfileRenamed }) {
    this.definitions = definitionStore;
    this.products = productStore;
    this.lifecycle = agentLifecycleService;
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.getRunSessionKey = getRunSessionKey;
    this.onProfileRenamed = onProfileRenamed || (() => {});
  }
  bind(name, args, run) {
    const source = bindConversationSource({ args, run, transcriptStore: this.transcripts, chatSessionStore: this.sessions,
      getRunSessionKey: this.getRunSessionKey, requireQuote: name === "agent_definition_update" });
    if (hasSecret(JSON.stringify(args))) throw serviceError("DEFINITION_SECRET_REJECTED", "设定不能包含凭据");
    if (name === "agent_definition_read") return source;
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
    let current = this.definitions.get(profileId);
    const applied = current.manifest.revision > args.expectedRevision
      ? this.definitions.readRevision(profileId, args.expectedRevision + 1) : null;
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
        const committed = this.definitions.readRevision(profileId, args.expectedRevision + 1);
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
