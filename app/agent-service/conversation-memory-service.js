"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { serviceError } = require("./security");
const { hasSecret, workspaceMemoryRef } = require("./memory-engine");
const { bindConversationSource } = require("./conversation-source");

function memoryOperationId(profileId, operationId) {
  return `mcp-memory-${crypto.createHash("sha256").update(`${profileId}\0${operationId}`).digest("hex")}`;
}

// The MCP authority and WorkRun supply ownership and provenance. Models never
// choose another profile, transcript, path, or source event ID.
class ConversationMemoryService {
  constructor({ memoryEngine, memoryStore, transcriptStore, chatSessionStore, getRunSessionKey,
    getInspirationOrigin = null, memoryProvenanceService = null, semanticSearch = null }) {
    this.engine = memoryEngine;
    this.store = memoryStore;
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.getRunSessionKey = getRunSessionKey;
    this.getInspirationOrigin = getInspirationOrigin;
    this.provenance = memoryProvenanceService;
    this.semanticSearch = semanticSearch;
  }
  _recordSource(profileId, id, item, binding) {
    if (!this.provenance || item?.id !== id) return;
    // The claim has already committed. A damaged optional provenance journal
    // must degrade explain, not turn a successful memory_save into a false failure.
    try {
      this.provenance.recordConversationSave({ profileId, item,
        operationId: id, source: binding.source });
    } catch {}
  }
  bind(name, args, run) {
    if (hasSecret(JSON.stringify(args))) throw serviceError("MEMORY_SECRET_REJECTED", "记忆不能包含凭据");
    if (run.source === "inspiration") {
      let origin;
      try { origin = this.getInspirationOrigin?.(run); } catch { origin = null; }
      if (origin?.runId !== run.id || origin.profileId !== run.profileId
        || origin.workspace !== run.workspace || origin.ideaId !== run.sourceId
        || origin.inputSource !== "chat") {
        throw serviceError("MCP_TOOL_FORBIDDEN", "该记忆操作需要当前用户对话");
      }
    }
    return { ...bindConversationSource({ args, run, transcriptStore: this.transcripts, chatSessionStore: this.sessions,
      getRunSessionKey: this.getRunSessionKey,
      requireQuote: (name === "memory_save" && args.classification === "explicit") || name === "memory_forget" }),
    workspace: run.workspace };
  }
  search(profileId, args, run) {
    if (args.includeCandidates === true) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "后台候选仅供用户审核，不能进入 Agent 检索");
    }
    const result = this.engine.search({ profileId, query: args.query, workspace: run.workspace,
      statuses: ["active"],
      // Only this Agent's direct conversation can use these private records.
      // Restricted records are never model-visible.
      maxSensitivity: "private", limit: 20, maxBytes: 24 * 1024 });
    return { ...result, viewStatus: this.engine.viewStatus(profileId) };
  }
  async searchWithSemantic(profileId, args, run) {
    // Validate before starting inference and again before projecting sources.
    const lexical = this.search(profileId, args, run);
    if (!this.semanticSearch || !args.query?.trim()) return lexical;
    const result = await this.semanticSearch.searchMemory({ profileId, query: args.query,
      workspace: run.workspace, statuses: ["active"], maxSensitivity: "private",
      limit: 20, maxBytes: 24 * 1024 });
    this.bind("memory_search", args, run);
    return { ...result, viewStatus: this.engine.viewStatus(profileId) };
  }
  get(profileId, id, run) {
    this.engine.recallPolicy?.assertReady(profileId);
    const item = this.store.get(profileId, id);
    const now = this.engine.now();
    if (!item || item.status !== "active" || item.validFrom > now
      || (item.validUntil !== null && item.validUntil <= now)
      || (this.engine.recallPolicy && !this.engine.recallPolicy.isMemoryVisible(profileId, item))
      || (this.engine.isReviewCommitted && !this.engine.isReviewCommitted(profileId, item))
      || item.sensitivity === "restricted" || hasSecret(item.content)
      || (["project", "workspace"].includes(item.scope)
        && !item.sourceRefs.includes(workspaceMemoryRef(run.workspace)))) {
      throw serviceError("MEMORY_NOT_FOUND", "记忆不可读取");
    }
    return { item, revision: this.store.getRevision(profileId), viewStatus: this.engine.viewStatus(profileId) };
  }
  explain(profileId, id, run) {
    const current = this.get(profileId, id, run);
    if (!this.provenance) return { ...current,
      evidence: { status: "unavailable", reason: "provenance_store_unavailable" } };
    const value = this.provenance.explain({ profileId, id, viewer: "agent", workspace: run.workspace });
    return { ...current, evidence: value.evidence };
  }
  write(name, profileId, args, call) {
    this.engine.recallPolicy.assertReady(profileId);
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
    if (name === "memory_save" && item) {
      this._recordSource(profileId, id, item, binding);
      return this.result(profileId, item);
    }
    if (name === "memory_forget" && item?.status === "deleted") {
      // A prior expiry and an explicit forget have different recall effects.
      // Record the user's request even when the primary item is already deleted.
      return this.result(profileId, this.engine.delete({ profileId, id: args.id,
        reason: "forgotten", operationId: `forget-${id}`,
        revocationSourceRefs: binding.sourceRefs }));
    }
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
      this._recordSource(profileId, id, item, binding);
    } else {
      item = this.engine.delete({ profileId, id: args.id,
        reason: "forgotten", operationId: `forget-${id}`,
        revocationSourceRefs: binding.sourceRefs });
    }
    if (!item) throw serviceError("MEMORY_NOT_FOUND", "记忆不存在");
    return this.result(profileId, item);
  }
  result(profileId, item) {
    this.engine.recallPolicy.assertReady(profileId);
    const now = this.engine.now();
    const visible = item.status === "active" && item.validFrom <= now
      && (item.validUntil === null || item.validUntil > now)
      && item.sensitivity !== "restricted" && !hasSecret(item.content)
      && this.engine.isReviewCommitted(profileId, item)
      && this.engine.recallPolicy.isMemoryVisible(profileId, item);
    return { item: visible ? item : { id: item.id, status: item.status },
      revision: this.store.getRevision(profileId), viewStatus: this.engine.viewStatus(profileId),
      saved: visible, needsConfirmation: false };
  }
  revalidateWriteResult(profileId, result, workspace) {
    this.engine.recallPolicy.assertReady(profileId);
    const id = result?.item?.id;
    const current = typeof id === "string" ? this.store.get(profileId, id) : null;
    if (!current) throw serviceError("MEMORY_NOT_FOUND", "记忆不可读取");
    if (["project", "workspace"].includes(current.scope)
      && !current.sourceRefs.includes(workspaceMemoryRef(workspace))) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "项目记忆不属于当前工作区");
    }
    const fresh = this.result(profileId, current);
    // Preserve an unchanged durable receipt byte for byte. Revoked, deleted,
    // or superseded items are projected from the current primary store.
    return isDeepStrictEqual(result.item, fresh.item) ? result : fresh;
  }
}

module.exports = { ConversationMemoryService, memoryOperationId };
