"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");
const { hasSecret, workspaceMemoryRef } = require("./memory-engine");
const { bindConversationSource } = require("./conversation-source");

function memoryOperationId(profileId, operationId) {
  return `mcp-memory-${crypto.createHash("sha256").update(`${profileId}\0${operationId}`).digest("hex")}`;
}

// The MCP authority and WorkRun supply ownership and provenance. Models never
// choose another profile, transcript, path, or source event ID.
class ConversationMemoryService {
  constructor({ memoryEngine, memoryStore, transcriptStore, chatSessionStore, getRunSessionKey }) {
    this.engine = memoryEngine;
    this.store = memoryStore;
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.getRunSessionKey = getRunSessionKey;
  }
  bind(name, args, run) {
    if (hasSecret(JSON.stringify(args))) throw serviceError("MEMORY_SECRET_REJECTED", "记忆不能包含凭据");
    return { ...bindConversationSource({ args, run, transcriptStore: this.transcripts, chatSessionStore: this.sessions,
      getRunSessionKey: this.getRunSessionKey,
      requireQuote: (name === "memory_save" && args.classification === "explicit") || name === "memory_forget" }),
    workspace: run.workspace };
  }
  search(profileId, args, run) {
    const result = this.engine.search({ profileId, query: args.query, workspace: run.workspace,
      statuses: ["active"],
      // Only this Agent's direct conversation can use these private records.
      // Restricted records are never model-visible.
      maxSensitivity: "private", limit: 20, maxBytes: 24 * 1024 });
    return { ...result, viewStatus: this.engine.viewStatus(profileId) };
  }
  write(name, profileId, args, call) {
    const binding = call.binding;
    const id = memoryOperationId(profileId, call.operationId);
    let item = name === "memory_save" ? this.store.get(profileId, id) : this.store.get(profileId, args.id);
    for (const target of [item, args.supersedes ? this.store.get(profileId, args.supersedes) : null]) {
      if (target && ["project", "workspace"].includes(target.scope)
        && !target.sourceRefs.includes(workspaceMemoryRef(binding.workspace))) {
        throw serviceError("MCP_TOOL_FORBIDDEN", "项目记忆不属于当前工作区");
      }
    }
    // Reconcile a committed memory operation if the MCP receipt was lost. Never
    // resurrect a subsequently forgotten/superseded note on replay.
    if ((name === "memory_save" && item) || (name === "memory_forget" && item?.status === "deleted")) return this.result(profileId, item);
    if (this.store.getRevision(profileId) !== args.expectedRevision) {
      throw serviceError("MEMORY_REVISION_CONFLICT", "记忆已经变化，请重新读取");
    }
    if (name === "memory_save") {
      item = this.engine.propose({ profileId, id, content: args.content, scope: args.scope,
        type: args.validUntil == null ? "semantic" : "temporary", classification: args.classification,
        sensitivity: args.sensitivity,
        sourceRefs: [...binding.sourceRefs, ...(["project", "workspace"].includes(args.scope)
          ? [workspaceMemoryRef(binding.workspace)] : [])],
        supersedes: args.supersedes ?? null, validUntil: args.validUntil ?? null });
    } else {
      item = this.engine.delete({ profileId, id: args.id });
    }
    if (!item) throw serviceError("MEMORY_NOT_FOUND", "记忆不存在");
    return this.result(profileId, item);
  }
  result(profileId, item) {
    return { item, revision: this.store.getRevision(profileId), viewStatus: this.engine.viewStatus(profileId),
      saved: item.status === "active", needsConfirmation: false };
  }
}

module.exports = { ConversationMemoryService, memoryOperationId };
