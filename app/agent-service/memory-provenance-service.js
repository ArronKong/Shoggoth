"use strict";

const crypto = require("node:crypto");
const { hasPii, hasSecret, workspaceMemoryRef } = require("./memory-engine");
const { isHistoricalChatSession } = require("./historical-chat-session");
const { serviceError } = require("./security");

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const SAFE_IMPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}\.(?:md|txt|json)$/iu;
function safeImportName(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 255
    && SAFE_IMPORT_NAME.test(value) && !value.includes("..")
    && !hasSecret(value) && !hasPii(value) ? value : null;
}

class MemoryProvenanceService {
  constructor({ store, memoryStore, transcriptStore, chatSessionStore, recallPolicy,
    getRun = null, getRunSessionKey = null, getInspirationOrigin = null, now = Date.now }) {
    this.store = store;
    this.memoryStore = memoryStore;
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.recallPolicy = recallPolicy;
    this.getRun = getRun;
    this.getRunSessionKey = getRunSessionKey;
    this.getInspirationOrigin = getInspirationOrigin;
    this.now = now;
  }
  _verifiedDirectRun(profileId, session, runId) {
    if (!this.getRun || !this.getRunSessionKey || !runId
      || this.sessions.getCronSessionOrigin?.(session.sessionKey)) return false;
    try {
      const run = this.getRun(runId);
      if (!run || run.id !== runId || run.profileId !== profileId
        || run.workspace !== session.workspace || !["chat", "inspiration"].includes(run.source)
        || /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey || "")
        || this.getRunSessionKey(run) !== session.sessionKey
        || (run.source === "chat" && run.sourceId !== session.sessionKey)) return false;
      if (run.source === "inspiration") {
        const origin = this.getInspirationOrigin?.(run);
        if (origin?.runId !== run.id || origin.profileId !== profileId
          || origin.workspace !== session.workspace || origin.ideaId !== run.sourceId
          || origin.inputSource !== "chat") return false;
      }
      return true;
    } catch { return false; }
  }
  _legacyRelatedMessage(profileId, item, viewer, workspace) {
    if (!this.transcripts.getEvent) return null;
    const refs = item.sourceRefs.filter((ref) => !/^(?:workspace:|user-edit:|codex-memory:)/u.test(ref));
    if (refs.length < 2) return null;
    for (const session of this.sessions.listSessions()) {
      if (session.profileId !== profileId || !isHistoricalChatSession(session)
        || (viewer === "agent" && session.workspace !== workspace)
        || this.sessions.getCronSessionOrigin?.(session.sessionKey)) continue;
      for (const eventId of refs) {
        const event = this.transcripts.getEvent(profileId, session.id, eventId);
        if (!event || event.kind !== "user" || event.contextExcluded
          || !refs.includes(event.runId)
          || !this._verifiedDirectRun(profileId, session, event.runId)) continue;
        const resolved = this.transcripts.contextEvent?.(profileId, session.id, event) || event;
        if (typeof resolved.content?.text !== "string" || !resolved.content.text.trim()
          || (viewer === "agent" && !this.recallPolicy.isEventVisible(profileId, resolved))) continue;
        this.transcripts.assertJournalCurrent?.(profileId, session.id);
        return { status: "related_message", sessionId: session.id, eventId: event.id, quote: null,
          occurredAt: event.occurredAt };
      }
    }
    return null;
  }
  recordConversationSave({ profileId, item, operationId, source }) {
    if (!source || !item.sourceRefs.includes(source.eventId)) return null;
    const revision = this.memoryStore.getContentRevision(profileId, item.id, sha256(item.content));
    if (revision === null) return null;
    return this.store.append({
      operationId, profileId, memoryId: item.id, memoryRevision: revision,
      contentHash: sha256(item.content), origin: "conversation", runId: source.runId,
      sessionId: source.sessionId, eventId: source.eventId,
      eventTextHash: source.eventTextHash, quoteHash: source.quoteHash,
      quoteStartUtf16: source.quoteStartUtf16, quoteEndUtf16: source.quoteEndUtf16,
      observedAt: this.now(),
    });
  }
  recordUiWrite({ profileId, item, operationId, origin }) {
    if (!["ui_create", "ui_edit"].includes(origin)) throw new TypeError("UI origin invalid");
    const revision = this.memoryStore.getContentRevision(profileId, item.id, sha256(item.content));
    if (revision === null) return null;
    return this.store.append({
      operationId, profileId, memoryId: item.id, memoryRevision: revision,
      contentHash: sha256(item.content), origin, runId: null, sessionId: null, eventId: null,
      eventTextHash: null, quoteHash: null, quoteStartUtf16: null, quoteEndUtf16: null,
      observedAt: this.now(),
    });
  }
  recordImport({ profileId, item, sourceRef, fileName, fileHash }) {
    if (item?.profileId !== profileId || item.status !== "active"
      || !item.sourceRefs.includes(sourceRef)
      || !/^codex-memory:[a-f0-9]{32}$/u.test(sourceRef)
      || !/^[a-f0-9]{64}$/u.test(fileHash)) {
      throw serviceError("MEMORY_PROVENANCE_INVALID", "导入来源与记忆不匹配");
    }
    const revision = this.memoryStore.getContentRevision(profileId, item.id, sha256(item.content));
    if (revision === null) return null;
    return this.store.append({
      operationId: `import-${sha256(JSON.stringify([profileId, item.id, revision, sourceRef, fileHash]))}`,
      profileId, memoryId: item.id, memoryRevision: revision,
      contentHash: sha256(item.content), origin: "import", runId: null, sessionId: null,
      eventId: null, eventTextHash: null, quoteHash: null,
      quoteStartUtf16: null, quoteEndUtf16: null,
      importFile: { name: safeImportName(fileName), fileHash, sourceRef },
      observedAt: this.now(),
    });
  }
  getEvidenceRevision(profileId, id) {
    // The tool controller calls this before and after memory_explain. Compare
    // the evidence for this item, not the whole journal: an unrelated append
    // must not invalidate an otherwise current quote.
    try {
      const { evidence } = this.explain({ profileId, id, viewer: "user" });
      return sha256(JSON.stringify(evidence));
    } catch (cause) {
      return `unavailable:${cause?.code || "source_read_failed"}`;
    }
  }
  explain({ profileId, id, viewer = "agent", workspace = null }) {
    if (viewer !== "agent" && viewer !== "user") throw new TypeError("viewer invalid");
    if (viewer === "agent") this.recallPolicy.assertReady(profileId);
    const item = this.memoryStore.get(profileId, id);
    if (!item) throw serviceError("MEMORY_NOT_FOUND", "记忆不存在");
    if (viewer === "agent") {
      const now = this.now();
      if (item.status !== "active" || item.validFrom > now
        || (item.validUntil !== null && item.validUntil <= now)
        || !this.recallPolicy.isMemoryVisible(profileId, item)
        || item.sensitivity === "restricted"
        || (["project", "workspace"].includes(item.scope)
          && !item.sourceRefs.includes(workspaceMemoryRef(workspace)))) {
        throw serviceError("MEMORY_NOT_FOUND", "记忆不可读取");
      }
    }
    let withdrawalReason = null;
    if (item.status === "deleted") {
      try { withdrawalReason = this.recallPolicy.getMemoryReason(profileId, item) || "unavailable"; }
      catch { withdrawalReason = "unavailable"; }
    }
    const result = (evidence) => ({ item, evidence, withdrawalReason });
    let record;
    let contentRevision;
    try {
      contentRevision = this.memoryStore.getContentRevision(profileId, id, sha256(item.content));
      record = contentRevision === null ? null : this.store.findForItem(profileId, item, contentRevision);
    }
    catch {
      return result({ status: "unavailable", reason: "provenance_store_unavailable" });
    }
    if (!record) {
      let related = null;
      try { related = this._legacyRelatedMessage(profileId, item, viewer, workspace); }
      catch { /* Legacy source lookup is optional and must never invent evidence. */ }
      if (related && contentRevision !== null) {
        return result({ ...related, origin: "conversation", memoryRevision: contentRevision });
      }
      return result({ status: "legacy_unverified",
        reason: item.sourceRefs.some((ref) => ref.startsWith("user-edit:"))
          ? "legacy_ui_edit_may_have_changed_content" : "no_verified_provenance" });
    }
    const base = { origin: record.origin, memoryRevision: record.memoryRevision };
    if (record.origin === "import") {
      if (!record.importFile) {
        return result({ ...base, status: "legacy_unverified", reason: "import_source_not_recorded" });
      }
      if (!item.sourceRefs.includes(record.importFile.sourceRef)) {
        return result({ ...base, status: "unavailable", reason: "import_source_mismatch" });
      }
      return result({ ...base, status: "verified_origin", quote: null,
        importFile: { name: record.importFile.name, sha256: record.importFile.fileHash } });
    }
    if (record.origin !== "conversation") {
      return result({ ...base, status: "verified_origin", quote: null });
    }
    try {
      const session = this.sessions.listSessions().find((value) => value.id === record.sessionId
        && value.profileId === profileId);
      if (!isHistoricalChatSession(session)
        || (viewer === "agent" && session.workspace !== workspace)) {
        return result({ ...base, status: "unavailable", reason: "session_unavailable" });
      }
      if (!this._verifiedDirectRun(profileId, session, record.runId)) {
        return result({ ...base, status: "unavailable", reason: "source_unavailable" });
      }
      const event = typeof this.transcripts.getEvent === "function"
        ? this.transcripts.getEvent(profileId, record.sessionId, record.eventId)
        : this.transcripts.listEvents(profileId, record.sessionId)
          .find((value) => value.id === record.eventId);
      if (!event || event.kind !== "user" || event.runId !== record.runId
        || event.contextExcluded) {
        return result({ ...base, status: "unavailable", reason: "source_unavailable" });
      }
      // The journal may contain only a display excerpt. Resolve and verify its
      // content-addressed body before checking the quote or recall policy.
      const resolved = event.content?.contextRef
        ? this.transcripts.contextEvent(profileId, record.sessionId, event) : event;
      const text = resolved.content?.text;
      const currentHashMatches = typeof text === "string"
        && sha256(text) === record.eventTextHash;
      // Existing prefix-only saves on long messages recorded the journal hash.
      // Accept those only when that excerpt matches the verified full body.
      const legacyExcerptMatches = typeof text === "string" && event.content?.contextRef
        && typeof event.content.text === "string"
        && sha256(event.content.text) === record.eventTextHash
        && event.content.text === Buffer.from(text).subarray(0, 24 * 1024)
          .toString("utf8").toWellFormed();
      if ((!currentHashMatches && !legacyExcerptMatches)
        || (viewer === "agent" && !this.recallPolicy.isEventVisible(profileId, resolved))) {
        return result({ ...base, status: "unavailable", reason: "source_unavailable" });
      }
      if (record.quoteHash === null) {
        this.transcripts.assertJournalCurrent?.(profileId, record.sessionId);
        return result({ ...base, sessionId: record.sessionId,
          eventId: record.eventId, status: "related_message", quote: null });
      }
      const quote = text.slice(record.quoteStartUtf16, record.quoteEndUtf16);
      if (sha256(quote) !== record.quoteHash) {
        return result({ ...base, status: "unavailable", reason: "quote_mismatch" });
      }
      this.transcripts.assertJournalCurrent?.(profileId, record.sessionId);
      return result({ ...base, sessionId: record.sessionId,
        eventId: record.eventId, status: "verified_quote", quote,
        quoteStartUtf16: record.quoteStartUtf16, quoteEndUtf16: record.quoteEndUtf16,
        occurredAt: event.occurredAt });
    } catch {
      return result({ ...base, status: "unavailable", reason: "source_read_failed" });
    }
  }
}

module.exports = { MemoryProvenanceService };
