"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { serviceError } = require("./security");
const { hasSecret, matchesWorkspace, memoryTrust, quoteSupportsContent, UNTRUSTED_REF_PREFIX,
  workspaceMemoryRefs } = require("./memory-engine");
const { bindConversationSource } = require("./conversation-source");
const { isBorrowedMemoryDerived, isReferentialMemoryRequest } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
const PUBLIC_MEMORY_FIELDS = ["id", "profileId", "scope", "type", "content", "sourceRefs", "confidence", "sensitivity", "status", "validFrom", "validUntil", "supersedes", "createdAt", "updatedAt", "score", "citation"];
const PUBLIC_SEARCH_FIELDS = ["path", "startLine", "endLine", "score", "snippet", "source", "citation", "id", "ownerProfileId", "ownerDisplayName", "documentKind", "canonicalRelativePath",
  "sourceHash", "sourceRevision", "sourceOriginHash", "policyRevision", "sourceRef", "borrowed", "persistPolicy", "borrowedMemoryRefs", "version", "requesterProfileId"];
const projectFields = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

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
    if (this.engine.owner === "shoggoth-memory-core") {
      this.bind("memory_search", args, run);
      const result = await this.engine.searchMemory({ profileId, query: args.query, workspace: run.workspace,
        maxSensitivity: "private", maxResults: args.maxResults, minScore: args.minScore, run,
        memoryScope: args.memoryScope, ownerProfileId: args.ownerProfileId });
      this.bind("memory_search", args, run);
      // Upstream ranking records include optional undefined fields. Project the
      // public tool shape; the strict MCP serializer must remain fail-closed.
      return { ...result, items: result.items.map(item => this._publicItem(item)),
        results: result.results.map(item => projectFields(item, PUBLIC_SEARCH_FIELDS)),
        viewStatus: this.engine.viewStatus(profileId) };
    }
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
    if (this.engine.sharing?.recognizes(id)) return this.engine.sharing.get({ profileId, id, run, workspace: run.workspace, maxSensitivity: "private" });
    this.engine.recallPolicy?.assertReady(profileId);
    const own = this.store.get(profileId, id);
    // Another Agent's shared fact is readable here but checked as its owner's.
    const shared = own ? null : this.engine.findSharedItem?.(profileId, id) ?? null;
    const home = shared ? shared.home : profileId, item = shared ? shared.item : own;
    if (this.engine.owner === "shoggoth-memory-core" && !this.engine.visible(item, { workspace: run.workspace, maxSensitivity: "private" })) {
      throw serviceError("MEMORY_NOT_FOUND", "记忆来源已撤回或不属于当前工作区");
    }
    const now = this.engine.now();
    if (!item || item.status !== "active" || item.validFrom > now
      || (item.validUntil !== null && item.validUntil <= now)
      || (this.engine.recallPolicy && !this.engine.recallPolicy.isMemoryVisible(home, item))
      || (this.engine.isReviewCommitted && !this.engine.isReviewCommitted(home, item))
      || memoryTrust(item) === "untrusted"
      || item.sensitivity === "restricted" || hasSecret(item.content)
      || (["project", "workspace"].includes(item.scope) && !matchesWorkspace(item, run.workspace))) {
      throw serviceError("MEMORY_NOT_FOUND", "记忆不可读取");
    }
    return { item: this._publicItem(item), revision: this.store.getRevision(profileId), viewStatus: this.engine.viewStatus(profileId),
      ...(shared ? { sharedFrom: home } : {}) };
  }
  explain(profileId, id, run) {
    if (this.engine.sharing?.recognizes(id)) return this.engine.sharing.explain({ profileId, id, run, workspace: run.workspace, maxSensitivity: "private" });
    const current = this.get(profileId, id, run);
    if (!this.provenance) return { ...current,
      evidence: { status: "unavailable", reason: "provenance_store_unavailable" } };
    const value = this.provenance.explain({ profileId: current.sharedFrom ?? profileId, id, viewer: "agent", workspace: run.workspace });
    return { ...current, evidence: value.evidence };
  }
  write(name, profileId, args, call) {
    if (this.engine.owner === "shoggoth-memory-core") return this._writeShoggoth(name, profileId, args, call);
    this.engine.recallPolicy.assertReady(profileId);
    const binding = call.binding;
    const id = memoryOperationId(profileId, call.operationId);
    let item = name === "memory_save" ? this.store.get(profileId, id) : this.store.get(profileId, args.id);
    for (const target of [item, args.supersedes ? this.store.get(profileId, args.supersedes) : null]) {
      if (target && ["project", "workspace"].includes(target.scope) && !matchesWorkspace(target, binding.workspace)) {
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
      return this.result(profileId, this.engine.forgetEverywhere({ profileId, id: args.id,
        reason: "forgotten", operationId: `forget-${id}`,
        revocationSourceRefs: binding.sourceRefs }));
    }
    if (this.store.getRevision(profileId) !== args.expectedRevision) {
      throw serviceError("MEMORY_REVISION_CONFLICT", "记忆已经变化，请重新读取");
    }
    // Another Agent's shared fact is forgotten at its home and in every copy.
    const shared = name === "memory_forget" && !item ? this.engine.findSharedItem?.(profileId, args.id) : null;
    if (shared) {
      return this.result(profileId, this.engine.forgetEverywhere({ profileId: shared.home, id: args.id,
        reason: "forgotten", operationId: `forget-${id}` }));
    }
    if (name === "memory_save") {
      const workspaceRefs = ["project", "workspace"].includes(args.scope)
        ? workspaceMemoryRefs(binding.workspace, args.scope) : [];
      // Restating a fact another Agent shared keeps the single existing copy.
      const known = args.supersedes ? null : this.engine.findSharedDuplicate?.(profileId, { scope: args.scope,
        content: args.content, validUntil: args.validUntil ?? null, sourceRefs: workspaceRefs }) ?? null;
      if (known) return this.result(profileId, known);
      // A fact the user's quoted words do not support waits for the user's
      // confirmation instead of reaching any Agent's context.
      const unsupported = !quoteSupportsContent(args.sourceQuote ?? "", args.content);
      item = this.engine.propose({ profileId, id, content: args.content, scope: args.scope,
        type: args.validUntil == null ? "semantic" : "temporary", classification: args.classification,
        sensitivity: args.sensitivity,
        sourceRefs: [...binding.sourceRefs, ...workspaceRefs,
          ...(unsupported ? [`${UNTRUSTED_REF_PREFIX}quote-unsupported`] : [])],
        supersedes: args.supersedes ?? null, validUntil: args.validUntil ?? null });
      this._recordSource(profileId, id, item, binding);
    } else {
      item = this.engine.forgetEverywhere({ profileId, id: args.id,
        reason: "forgotten", operationId: `forget-${id}`,
        revocationSourceRefs: binding.sourceRefs });
    }
    if (!item) throw serviceError("MEMORY_NOT_FOUND", "记忆不存在");
    return this.result(profileId, item);
  }
  result(profileId, item) {
    this.engine.recallPolicy.assertReady(profileId);
    const now = this.engine.now();
    // Another Agent's shared fact is checked as its home Agent's.
    const recallable = item.status === "active" && item.validFrom <= now
      && (item.validUntil === null || item.validUntil > now)
      && item.sensitivity !== "restricted" && !hasSecret(item.content)
      && (item.profileId === profileId ? this.engine.isReviewCommitted(profileId, item)
        && this.engine.recallPolicy.isMemoryVisible(profileId, item)
        : this.engine.isRecallCommitted(profileId, item));
    const untrusted = Array.isArray(item.sourceRefs) && memoryTrust(item) === "untrusted";
    const visible = recallable && !untrusted;
    return { item: visible ? this._publicItem(item) : { id: item.id, status: item.status },
      revision: this.store.getRevision(profileId), viewStatus: this.engine.viewStatus(profileId),
      saved: visible, needsConfirmation: recallable && untrusted };
  }
  _publicItem(item) {
    return this.engine.owner === "shoggoth-memory-core" ? projectFields(item, PUBLIC_MEMORY_FIELDS) : item;
  }
  async _writeShoggoth(name, profileId, args, call) {
    this.engine.recallPolicy.assertReady(profileId);
    const binding = call.binding, id = memoryOperationId(profileId, call.operationId);
    const sharing = this.engine.sharing;
    if (name === "memory_save" && sharing?.recognizes(args.supersedes)) throw serviceError("MEMORY_BORROWED_READ_ONLY", "借阅记忆不能在当前助理中替代");
    if (name === "memory_forget" && sharing?.recognizes(args.id)) {
      const run = sharing.runs.get(binding.runId)?.input.run;
      return sharing.forget({ ...args, profileId, run, workspace: binding.workspace, maxSensitivity: "private" }, id);
    }
    if (name === "memory_save") {
      const sourceEvent = this.transcripts.listEvents(profileId, binding.source.sessionId).find(event => event.id === binding.source.eventId);
      if (isBorrowedMemoryDerived(sourceEvent) || (sharing?.borrowedRefsForRun(binding.runId).length
        && isReferentialMemoryRequest(sourceEvent?.content?.text))) throw serviceError("MEMORY_BORROWED_READ_ONLY", "借阅内容不能回存为当前助理记忆");
      this.engine.assertOwnedMemorySources({ ...args, profileId, sourceRefs: binding.sourceRefs });
    }
    const previous = this.store.get(profileId, name === "memory_save" ? id : args.id);
    const superseded = args.supersedes && this.store.get(profileId, args.supersedes);
    if (superseded && ["project", "workspace"].includes(superseded.scope) && !matchesWorkspace(superseded, binding.workspace)) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "不能替代其他工作区的记忆");
    }
    if (previous && ["project", "workspace"].includes(previous.scope) && !matchesWorkspace(previous, binding.workspace)) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "项目记忆不属于当前工作区");
    }
    if (name === "memory_save" && previous) return this.result(profileId, previous);
    if (this.store.getRevision(profileId) !== args.expectedRevision && previous?.status !== "deleted") {
      throw serviceError("MEMORY_REVISION_CONFLICT", "记忆已经变化，请重新读取");
    }
    let item;
    if (name === "memory_save") {
      const unsupported = !quoteSupportsContent(args.sourceQuote || "", args.content);
      item = await this.engine.propose({ ...args, profileId, id, type: args.validUntil == null ? "semantic" : "temporary",
        sourceRefs: [...binding.sourceRefs, ...(["project", "workspace"].includes(args.scope) ? workspaceMemoryRefs(binding.workspace, args.scope) : []),
          ...(unsupported ? [`${UNTRUSTED_REF_PREFIX}quote-unsupported`] : [])] });
      this._recordSource(profileId, id, item, binding);
    } else item = await this.engine.forgetEverywhere({ profileId, id: args.id, reason: "forgotten",
      operationId: `forget-${id}`, revocationSourceRefs: binding.sourceRefs });
    if (!item) throw serviceError("MEMORY_NOT_FOUND", "记忆不存在");
    return this.result(profileId, item);
  }
  getFile(profileId, args, run) {
    const result = this.engine.getFile({ profileId, path: args.path, from: args.from, lines: args.lines,
      workspace: run.workspace, maxSensitivity: "private", run });
    return { ...result, items: result.items.map(item => this._publicItem(item)) };
  }
  revalidateReadResult(profileId, result, run) {
    return this.engine.sharing?.validateResult({ profileId, run, workspace: run.workspace, maxSensitivity: "private" }, result) || result;
  }
  revalidateWriteResult(profileId, result, workspace) {
    if (result?.suppressed === true && this.engine.sharing?.suppressionCurrent(profileId, result.item?.id)) return result;
    this.engine.recallPolicy.assertReady(profileId);
    const id = result?.item?.id;
    const current = typeof id === "string" ? this.store.get(profileId, id)
      ?? this.engine.findSharedItem?.(profileId, id)?.item ?? this.engine.findPeerItem?.(profileId, id) ?? null : null;
    if (!current) throw serviceError("MEMORY_NOT_FOUND", "记忆不可读取");
    if (["project", "workspace"].includes(current.scope) && !matchesWorkspace(current, workspace)) {
      throw serviceError("MCP_TOOL_FORBIDDEN", "项目记忆不属于当前工作区");
    }
    const fresh = this.result(profileId, current);
    // Preserve an unchanged durable receipt byte for byte. Revoked, deleted,
    // or superseded items are projected from the current primary store.
    return isDeepStrictEqual(result.item, fresh.item) ? result : fresh;
  }
}

module.exports = { ConversationMemoryService, memoryOperationId };
