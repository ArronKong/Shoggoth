"use strict";

const { isDeepStrictEqual } = require("node:util");
const { ConversationRecallIndex, hashText, lexicalTerms } = require("./conversation-recall-index");
const { HistoricalMemoryAnnotations } = require("./historical-memory-annotations");
const { hasSecret } = require("./memory-engine");
const { isHistoricalChatSession } = require("./historical-chat-session");
const { serviceError } = require("./security");
const { hybridScore, SEMANTIC_MIN_COSINE, sourceLanguage } = require("./memory-semantic-ranking");

const FEDERATION_CHAT = /^shoggoth:chat-send:federation-(?:send|message)-/u;
const MAX_INDEX_TEXT_BYTES = 256 * 1024;
const MAX_READ_TEXT_BYTES = 16 * 1024;
// The MCP bridge reserves a 64 KiB response frame, including a worst-case
// request ID. Leave room for that envelope and JSON metadata/escaping.
const MAX_GET_RESPONSE_BYTES = 48 * 1024;
const MAX_SNIPPET_CHARS = 480;
const MAX_CANDIDATES = 250;

function recallError(code, message) { return serviceError(code, message); }

function boundedText(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let chars = [...text];
  let left = 0, right = chars.length;
  while (left < right) {
    const mid = Math.ceil((left + right) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(""), "utf8") <= maxBytes) left = mid;
    else right = mid - 1;
  }
  return { text: chars.slice(0, left).join(""), truncated: true };
}

function jsonTextBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8") - 2; }

function boundedJsonText(text, maxBytes) {
  if (jsonTextBytes(text) <= maxBytes) return { text, truncated: false };
  const chars = [...text];
  let left = 0, right = chars.length;
  while (left < right) {
    const mid = Math.ceil((left + right) / 2);
    if (jsonTextBytes(chars.slice(0, mid).join("")) <= maxBytes) left = mid;
    else right = mid - 1;
  }
  return { text: chars.slice(0, left).join(""), truncated: true };
}

function budgetGetResponse(sessionId, eventId, events) {
  const result = { sessionId, eventId, events };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_GET_RESPONSE_BYTES) return result;
  const original = events.map((event) => event.hidden ? null : { ...event });
  for (const event of events) {
    if (!event.hidden) { event.text = ""; event.truncated = true; }
  }
  // Keep the requested event first, then its nearest context. An empty text
  // with truncated=true remains a visible event the caller can reread alone.
  const target = events.findIndex((event) => event.eventId === eventId);
  const order = events.map((_, index) => index).sort((left, right) => (
    Math.abs(left - target) - Math.abs(right - target) || left - right
  ));
  const visibleCount = original.filter(Boolean).length;
  let remaining = MAX_GET_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(result), "utf8") - visibleCount;
  for (const index of order) {
    if (!original[index]) continue;
    const fitted = boundedJsonText(original[index].text, Math.max(0, remaining));
    events[index].text = fitted.text;
    events[index].truncated = original[index].truncated || fitted.truncated;
    remaining -= jsonTextBytes(fitted.text);
  }
  return result;
}

function snippetFor(text, query) {
  const lower = text.toLocaleLowerCase();
  const index = lower.indexOf(query.toLocaleLowerCase());
  const begin = Math.max(0, (index < 0 ? 0 : index) - 120);
  const excerpt = [...text.slice(begin)].slice(0, MAX_SNIPPET_CHARS).join("");
  return `${begin > 0 ? "…" : ""}${excerpt}${begin + excerpt.length < text.length ? "…" : ""}`;
}

function lexicallyMatches(text, query) {
  const terms = lexicalTerms(query);
  if (terms.length === 0 || ([...query].length === 1 && /\p{Script=Han}/u.test(query))) {
    return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }
  const available = new Set(lexicalTerms(text));
  return terms.every((term) => available.has(term));
}

function semanticSnippet(text, range) {
  if (!range || hashText(text) !== range.contentHash
    || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > text.length
    || !text.slice(range.start, range.end).isWellFormed()) return null;
  const excerpt = [...text.slice(range.start, range.end)].slice(0, MAX_SNIPPET_CHARS).join("");
  return `${range.start > 0 ? "…" : ""}${excerpt}${range.start + excerpt.length < text.length ? "…" : ""}`;
}

// The caller run is authenticated by the MCP controller. This service also
// verifies the current user event and every target event against durable stores.
class ConversationRecallService {
  constructor({ paths, transcriptStore, chatSessionStore, workDispatcher, getRunSessionKey,
    getInspirationOrigin = null, recallPolicy, memoryStore = null, index = null, now = Date.now,
    semanticSearch = null }) {
    if (!transcriptStore?.listEvents || !transcriptStore?.getRevision || !chatSessionStore?.listSessions
      || !chatSessionStore?.getSession || !workDispatcher?.getRun
      || typeof getRunSessionKey !== "function" || !recallPolicy?.assertReady
      || !recallPolicy?.isEventVisible || !recallPolicy?.getRevision
      || (memoryStore && (!memoryStore.list || !memoryStore.getRevision
        || !recallPolicy.getMemoryReason)) || typeof now !== "function") {
      throw new TypeError("ConversationRecallService dependencies 无效");
    }
    this.transcripts = transcriptStore;
    this.sessions = chatSessionStore;
    this.runs = workDispatcher;
    this.getRunSessionKey = getRunSessionKey;
    this.getInspirationOrigin = getInspirationOrigin;
    this.policy = recallPolicy;
    this.memories = memoryStore;
    this.now = now;
    this.index = index || new ConversationRecallIndex({ paths });
    this.semanticSearch = semanticSearch;
    this.warmTimers = new Map();
    this.historicalMemory = memoryStore ? new HistoricalMemoryAnnotations({ memoryStore,
      recallPolicy, now }) : null;
  }

  close() {
    for (const timer of this.warmTimers.values()) clearTimeout(timer);
    this.warmTimers.clear();
    this.historicalMemory?.clear();
    this.index.close();
  }
  forgetProfile(profileId) {
    const timer = this.warmTimers.get(profileId);
    if (timer) clearTimeout(timer);
    this.warmTimers.delete(profileId);
    this.historicalMemory?.forgetProfile(profileId);
    this.index.forgetProfile(profileId);
  }
  invalidateProfile(profileId) { this.index.invalidateProfile(profileId); }
  refreshProfile(profileId) { this.invalidateProfile(profileId); }
  whenIndexReady(profileId) { return this.index.whenReady(profileId); }

  getVisibilityRevision(profileId) {
    this.policy.assertReady(profileId);
    if (typeof this.sessions.getRevision !== "function"
      || typeof this.transcripts.getChangeRevision !== "function") return null;
    return JSON.stringify([this.sessions.getRevision(),
      this.transcripts.getChangeRevision(profileId), this.memories?.getRevision(profileId) ?? null]);
  }

  assertResultCurrent({ name, profileId, args, run, result }) {
    if (name === "conversation_get") {
      if (!isDeepStrictEqual(this.get({ profileId, args, run }), result)) {
        throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件已变化");
      }
      return;
    }
    if (name !== "conversation_search" || !Array.isArray(result?.results)) {
      throw recallError("CONVERSATION_SEARCH_INVALID", "会话检索结果无效");
    }
    this._caller(profileId, args, run);
    const policyView = this._policyView(profileId);
    const outdatedView = result.results.length ? this._outdatedView(profileId) : null;
    const sessions = new Map(this.sessions.listSessions().map((session) => [session.id, session]));
    for (const row of result.results) {
      const session = sessions.get(row.sessionId);
      const current = session && this.sessions.getSession(session.sessionKey);
      if (!current || current.id !== session.id || current.profileId !== profileId
        || current.workspace !== run.workspace || !isHistoricalChatSession(current)
        || this.sessions.getCronSessionOrigin?.(current.sessionKey)) {
        throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件已变化");
      }
      const item = this._event(profileId, current, row.eventId, null, policyView);
      const snippet = item && (row.semanticEvidence
        ? semanticSnippet(item.text, row.semanticEvidence)
        : lexicallyMatches(item.text, result.query) ? snippetFor(item.text, result.query) : null);
      if (!item || item.event.kind !== row.kind || item.event.occurredAt !== row.occurredAt
        || snippet === null || snippet !== row.snippet
        || !isDeepStrictEqual(row.outdatedMemories ?? null,
          this._outdatedForEvent(outdatedView, item.event))
        || !isDeepStrictEqual(row.historicalRunNotice ?? null,
          this._historicalRunNotice(outdatedView, profileId, current, item.event))) {
        throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件已变化");
      }
    }
  }

  _outdatedView(profileId) {
    return this.historicalMemory?.view(profileId) ?? null;
  }

  // Background extraction cannot treat a superseded or expired user event as
  // fresh evidence. Historical search still returns the event with a notice;
  // extraction has no per-fact quote lineage, so exclude the whole event.
  assertCandidateSourceCurrent(profileId, event) {
    this.policy.assertReady(profileId);
    if (!this.historicalMemory || typeof event?.eventId !== "string"
      || typeof event?.runId !== "string") {
      throw recallError("MEMORY_CANDIDATE_SOURCE_UNAVAILABLE", "候选来源无法核实");
    }
    if (this.historicalMemory.view(profileId).forEvent({
      kind: "user", id: event.eventId, runId: event.runId,
    })) {
      throw recallError("MEMORY_CANDIDATE_SOURCE_OUTDATED", "候选来源包含已替代或已到期的记忆");
    }
    return true;
  }

  _outdatedForEvent(view, event) {
    return view?.forEvent(event) ?? null;
  }
  _historicalRunNotice(view, profileId, session, event) {
    return view?.forAssistant(event, (sourceEventId) => {
      const source = this.transcripts.getEvent?.(profileId, session.id, sourceEventId);
      return source?.kind === "user" && source.runId === event.runId ? source.seq : null;
    }) ?? null;
  }

  scheduleWarm(profileId) {
    if (this.warmTimers.has(profileId)) return;
    const timer = setTimeout(() => {
      this.warmTimers.delete(profileId);
      try { this.prebuildProfile(profileId); } catch { /* search reports the safe unavailable state */ }
    }, 250);
    timer.unref?.();
    this.warmTimers.set(profileId, timer);
  }

  prebuildProfile(profileId) {
    this.policy.assertReady(profileId);
    const sessions = this._targetSessions(profileId);
    const policyView = this._policyView(profileId);
    this._ensureSemantic(profileId, sessions, policyView);
    return this._ensureIndex(profileId, sessions, policyView);
  }

  _ensureSemantic(profileId, sessions = this._targetSessions(profileId), policyView = this._policyView(profileId)) {
    if (!this.semanticSearch) return null;
    const visibility = this.policy.getHistoricalVisibilityRevision?.(profileId) ?? policyView.revision;
    const sourceStamp = JSON.stringify([sessions, policyView.revision, visibility]);
    const stamp = hashText(sourceStamp);
    const runCache = new Map();
    const service = this;
    return this.semanticSearch.ensure({ profileId, domain: "conversation", stamp,
      isCurrent: () => this.policy.getRevision(profileId) === policyView.revision
        && (this.policy.getHistoricalVisibilityRevision?.(profileId) ?? this.policy.getRevision(profileId)) === visibility
        && JSON.stringify([this._targetSessions(profileId), policyView.revision, visibility]) === sourceStamp,
      documents: async function* () {
        for (const session of sessions) {
          let after = 0;
          while (after < session.lastSeq) {
            const page = service._loadPage(profileId, session, after, 100, policyView, runCache);
            for (const row of page.rows) yield {
              id: hashText(`conversation\0${session.id}\0${row.eventId}`), text: row.text, contentHash: row.contentHash,
              source: { sourceId: row.eventId, language: sourceLanguage(row.text), sessionId: session.id, eventId: row.eventId,
                seq: row.seq, runId: row.runId, kind: row.kind, workspace: session.workspace,
                occurredAt: row.occurredAt },
            };
            if (!page.hasMore || page.throughSeq <= after) break;
            after = page.throughSeq;
          }
        }
      } });
  }

  _ensureIndex(profileId, sessions, policyView) {
    if (this.policy.getRevision(profileId) !== policyView.revision) {
      throw recallError("CONVERSATION_INDEX_UNAVAILABLE", "会话可见性在索引准备期间改变");
    }
    // A committed new version can reauthorize one later user event without a
    // transcript or recall-ledger write. Only the historical visibility digest
    // changes, so unrelated MemoryStore writes do not rebuild the FTS index.
    const visibilityRevision = this.policy.getHistoricalVisibilityRevision?.(profileId)
      ?? policyView.revision;
    const runCache = new Map();
    return this.index.ensure(profileId, sessions, visibilityRevision,
      (session, afterSeq, pageSize) => this._loadPage(profileId, session, afterSeq,
        pageSize, policyView, runCache),
      () => this.policy.getRevision(profileId) === policyView.revision
        && (this.policy.getHistoricalVisibilityRevision?.(profileId)
          ?? this.policy.getRevision(profileId)) === visibilityRevision
        && JSON.stringify(this._targetSessions(profileId)) === JSON.stringify(sessions),
      (session, indexedRevision) => this.transcripts.getIndexPrefixDigest
        ? this.transcripts.getIndexPrefixDigest(profileId, session.id, indexedRevision)
        : null);
  }

  // Shared with memory_get/explain: one authoritative direct-user gate, also
  // excluding automatic Inspiration growth and generic idea-card executions.
  assertCaller({ profileId, run }) { return this._caller(profileId,
    { source: run?.source, sourceId: run?.sourceId }, run); }

  _policyView(profileId) {
    return this.policy.snapshot?.(profileId) || {
      revision: this.policy.getRevision(profileId),
      isEventVisible: (event) => this.policy.isEventVisible(profileId, event),
    };
  }

  _caller(profileId, args, run) {
    this.policy.assertReady(profileId);
    if (!run || run.profileId !== profileId || args.source !== run.source
      || args.sourceId !== run.sourceId || !["chat", "inspiration"].includes(run.source)
      || FEDERATION_CHAT.test(run.idempotencyKey || "")
      || !this._directInspiration(run)) {
      throw recallError("MCP_TOOL_FORBIDDEN", "该工具仅供当前原生用户对话使用");
    }
    const sessionKey = this.getRunSessionKey(run);
    const session = sessionKey ? this.sessions.getSession(sessionKey) : null;
    if (!session || !["ready", "archived"].includes(session.status)
      || session.profileId !== profileId || session.workspace !== run.workspace
      || this.sessions.getCronSessionOrigin?.(session.sessionKey)
      || (run.source === "chat" && run.sourceId !== session.sessionKey)) {
      throw recallError("MCP_TOOL_FORBIDDEN", "当前对话没有可用的记忆读取授权");
    }
    const hasUser = this.transcripts.hasUserEventForRun?.(profileId, session.id, run.id)
      ?? this.transcripts.listEvents(profileId, session.id).some((event) => event.runId === run.id
        && event.kind === "user" && !event.contextExcluded
        && typeof event.content?.text === "string");
    if (!hasUser) throw recallError("CONVERSATION_SOURCE_INVALID", "当前执行没有用户消息");
    return session;
  }

  _directInspiration(run) {
    if (run.source !== "inspiration") return true;
    if (typeof this.getInspirationOrigin !== "function") return false;
    let origin;
    try { origin = this.getInspirationOrigin(run); } catch { return false; }
    return origin?.runId === run.id && origin.profileId === run.profileId
      && origin.workspace === run.workspace && origin.ideaId === run.sourceId
      && origin.inputSource === "chat";
  }

  _targetSessions(profileId) {
    return this.sessions.listSessions().filter((session) => session.profileId === profileId
      && isHistoricalChatSession(session)
      && !this.sessions.getCronSessionOrigin?.(session.sessionKey))
      .map((session) => {
        const snapshot = this.transcripts.getIndexSnapshot?.(profileId, session.id);
        return { ...session,
          revision: snapshot?.revision ?? this.transcripts.getRevision(profileId, session.id),
          lastSeq: snapshot?.lastSeq ?? this.transcripts.getLastEventSeq?.(profileId, session.id)
            ?? this.transcripts.listEvents(profileId, session.id).at(-1)?.seq ?? 0,
          sourceIdentity: snapshot?.sourceIdentity ?? null };
      });
  }

  // Internal background extraction uses this exact target-event gate. It does
  // not grant an Agent tool call or bypass the recall policy.
  scanEligibleSession({ profileId, sessionId, afterSeq = 0, limit = 100,
    completedOnly = false }) {
    this.policy.assertReady(profileId);
    const policyView = this._policyView(profileId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || typeof completedOnly !== "boolean") {
      throw recallError("CONVERSATION_SEARCH_INVALID", "扫描范围无效");
    }
    const session = this.sessions.listSessions().find((entry) => entry.id === sessionId
      && entry.profileId === profileId && isHistoricalChatSession(entry)
      && !this.sessions.getCronSessionOrigin?.(entry.sessionKey));
    if (!session) throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件不可检索");
    session.lastSeq = this.transcripts.getLastEventSeq?.(profileId, session.id)
      ?? this.transcripts.listEvents(profileId, session.id).at(-1)?.seq ?? 0;
    const page = this._loadPage(profileId, session, afterSeq, limit, policyView,
      new Map(), completedOnly);
    return { revision: this.transcripts.getRevision(profileId, session.id),
      throughSeq: page.throughSeq, hasMore: page.hasMore,
      events: page.rows.map((row) => ({ sessionId: session.id, eventId: row.eventId,
        runId: row.runId, seq: row.seq, kind: row.kind, text: row.text,
        occurredAt: row.occurredAt, contentHash: row.contentHash })) };
  }

  _verifiedRun(profileId, session, runId, events, knownUserEvent = false) {
    if (!runId) return null;
    const run = this.runs.getRun(runId);
    if (!run || run.id !== runId || run.profileId !== profileId
      || run.workspace !== session.workspace || !["chat", "inspiration"].includes(run.source)
      || FEDERATION_CHAT.test(run.idempotencyKey || "") || !this._directInspiration(run)) return null;
    let linkedKey;
    try { linkedKey = this.getRunSessionKey(run); } catch { return null; }
    if (linkedKey !== session.sessionKey || (run.source === "chat" && run.sourceId !== session.sessionKey)) return null;
    if (!knownUserEvent) {
      const hasUser = events ? events.some((event) => event.runId === runId && event.kind === "user"
        && !event.contextExcluded && typeof event.content?.text === "string")
        : this.transcripts.hasUserEventForRun?.(profileId, session.id, runId)
          ?? this.transcripts.listEvents(profileId, session.id).some((event) => event.runId === runId
            && event.kind === "user" && !event.contextExcluded
            && typeof event.content?.text === "string");
      if (!hasUser) return null;
    }
    return run;
  }

  _eventContext(profileId, session) {
    const events = this.transcripts.listEvents(profileId, session.id);
    const byId = new Map(events.map((event) => [event.id, event]));
    const userRunIds = new Set(events.filter((event) => event.kind === "user"
      && !event.contextExcluded && typeof event.content?.text === "string")
      .map((event) => event.runId));
    return { events, byId, userRunIds, runs: new Map() };
  }

  _contextRun(profileId, session, runId, context) {
    if (!context.runs.has(runId)) {
      context.runs.set(runId, context.userRunIds.has(runId)
        ? this._verifiedRun(profileId, session, runId, context.events, true) : null);
    }
    return context.runs.get(runId);
  }

  _resolvedText(profileId, session, event, policyView = null) {
    if (event.contextExcluded || !["user", "assistant"].includes(event.kind)) return null;
    let current;
    try { current = this.transcripts.contextEvent?.(profileId, session.id, event) || event; }
    catch { return null; }
    const text = current.content?.text;
    if (typeof text !== "string" || !text.trim() || !text.isWellFormed()
      || Buffer.byteLength(text, "utf8") > MAX_INDEX_TEXT_BYTES || hasSecret(text)) return null;
    const visibleEvent = { ...current, content: { ...current.content, text } };
    if (!(policyView ? policyView.isEventVisible(visibleEvent)
      : this.policy.isEventVisible(profileId, visibleEvent))) return null;
    return text;
  }

  _rows(profileId, session, events, policyView) {
    const context = { events, byId: null, userRunIds: new Set(events.filter((event) => event.kind === "user"
      && !event.contextExcluded && typeof event.content?.text === "string")
      .map((event) => event.runId)), runs: new Map() };
    const rows = [];
    for (const event of events) {
      if (!this._contextRun(profileId, session, event.runId, context)) continue;
      const text = this._resolvedText(profileId, session, event, policyView);
      if (text === null) continue;
      rows.push({ eventId: event.id, seq: event.seq, runId: event.runId,
        kind: event.kind, occurredAt: event.occurredAt, contentHash: hashText(text), text });
    }
    return rows;
  }

  _loadRows(profileId, session, policyView) {
    const events = this.transcripts.listEvents(profileId, session.id);
    return { revision: this.transcripts.getRevision(profileId, session.id),
      rows: this._rows(profileId, session, events, policyView) };
  }

  _loadPage(profileId, session, afterSeq, limit, policyView, runCache,
    completedOnly = false) {
    if (afterSeq >= session.lastSeq) return { rows: [], throughSeq: afterSeq, hasMore: false };
    // The index builds against a captured session revision/lastSeq. A live
    // Runtime may append another event before this page is read; bound the
    // read to the snapshot so the build can discard itself on revision drift.
    const pageLimit = Math.min(limit, session.lastSeq - afterSeq);
    const events = this.transcripts.listEventsPage?.(profileId, session.id, afterSeq, pageLimit)
      || this.transcripts.listEvents(profileId, session.id, { afterSeq })
        .filter((event) => event.seq > afterSeq).slice(0, pageLimit);
    const rows = [];
    for (const event of events) {
      const key = `${session.id}\0${event.runId}`;
      if (!runCache.has(key)) runCache.set(key,
        this._verifiedRun(profileId, session, event.runId, null));
      const run = runCache.get(key);
      if (!run) continue;
      if (completedOnly && run.status !== "completed") {
        if (["failed", "canceled", "interrupted", "skipped"].includes(run.status)) continue;
        // The user turn may still change. Leave this and later events behind
        // the durable cursor so a later idle wake can retry after completion.
        return { rows, throughSeq: event.seq - 1, hasMore: true };
      }
      const text = this._resolvedText(profileId, session, event, policyView);
      if (text === null) continue;
      rows.push({ eventId: event.id, seq: event.seq, runId: event.runId,
        kind: event.kind, occurredAt: event.occurredAt, contentHash: hashText(text), text });
    }
    const throughSeq = events.at(-1)?.seq ?? afterSeq;
    return { rows, throughSeq, hasMore: throughSeq < session.lastSeq };
  }

  _event(profileId, session, eventId, expected = null, policyView = null, context = null) {
    if (!context && !this.transcripts.getEvent) context = this._eventContext(profileId, session);
    const event = context ? context.byId.get(eventId)
      : this.transcripts.getEvent(profileId, session.id, eventId);
    if (!event || !(context ? this._contextRun(profileId, session, event.runId, context)
      : this._verifiedRun(profileId, session, event.runId, null))) return null;
    const text = this._resolvedText(profileId, session, event, policyView);
    if (text === null || (expected && (event.seq !== expected.seq
      || event.runId !== expected.run_id || hashText(text) !== expected.content_hash))) return null;
    return { event, text, events: context?.events || null, context };
  }

  search({ profileId, args, run }) {
    this._caller(profileId, args, run);
    const query = args.query.trim();
    if (!query || hasSecret(query)) throw recallError("CONVERSATION_SEARCH_INVALID", "检索词无效");
    const limit = args.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw recallError("CONVERSATION_SEARCH_INVALID", "检索数量无效");
    }
    const sessions = this._targetSessions(profileId);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const policyView = this._policyView(profileId);
    const policyRevision = policyView.revision;
    const indexState = this._ensureIndex(profileId, sessions, policyView);
    if (indexState !== "ready") return { results: [], count: 0, query,
      status: "rebuilding", indexRevision: policyRevision };
    const candidates = this.index.search(profileId, query, MAX_CANDIDATES, run.workspace,
      args.sessionId ?? null);
    const results = [];
    const contexts = new Map();
    let outdatedView;
    for (const row of candidates) {
      if (results.length >= limit) break;
      if (row.run_id === run.id) continue;
      if (args.sessionId && row.session_id !== args.sessionId) continue;
      const session = byId.get(row.session_id);
      if (!session) continue;
      const current = this.sessions.getSession(session.sessionKey);
      if (!current || current.id !== session.id || current.profileId !== profileId
        || current.workspace !== run.workspace || !isHistoricalChatSession(current)
        || this.sessions.getCronSessionOrigin?.(session.sessionKey)) continue;
      if (!this.transcripts.getEvent && !contexts.has(session.id)) {
        contexts.set(session.id, this._eventContext(profileId, current));
      }
      const item = this._event(profileId, current, row.event_id, row, policyView,
        contexts.get(session.id) || null);
      if (!item) continue;
      if (!lexicallyMatches(item.text, query)) continue;
      const score = row.rank === 0 ? 1 : 1 / (1 + Math.abs(row.rank));
      if (outdatedView === undefined) outdatedView = this._outdatedView(profileId);
      const outdatedMemories = this._outdatedForEvent(outdatedView, item.event);
      const historicalRunNotice = this._historicalRunNotice(outdatedView, profileId,
        current, item.event);
      results.push({ sessionId: session.id, eventId: item.event.id,
        kind: item.event.kind, occurredAt: item.event.occurredAt,
        snippet: snippetFor(item.text, query), score, scoreBasis: row.rank === 0
          ? "single-character-literal" : "fts5-bigram-unicode61", source: "untrusted-transcript",
        ...(outdatedMemories ? { outdatedMemories } : {}),
        ...(historicalRunNotice ? { historicalRunNotice } : {}) });
    }
    return { results, count: results.length, query, status: "ready", indexRevision: policyRevision };
  }

  async searchWithSemantic({ profileId, args, run }) {
    const lexical = this.search({ profileId, args, run });
    if (!this.semanticSearch) return lexical;
    const job = this._ensureSemantic(profileId);
    const semantic = await this.semanticSearch.query({ profileId, domain: "conversation", job,
      query: lexical.query, filter: { workspace: run.workspace, sessionId: args.sessionId,
        excludeRunId: run.id }, limit: 100 });
    this._caller(profileId, args, run);
    if (this._ensureSemantic(profileId)?.stamp !== job?.stamp) {
      return { ...lexical, semantic: { status: "rebuilding" } };
    }
    const results = new Map(lexical.results.map(row => [`${row.sessionId}\0${row.eventId}`, {
      ...row, score: hybridScore(lexical.query, row.snippet, row.score).score } ]));
    const sessions = this.sessions.listSessions();
    const policyView = this._policyView(profileId);
    const outdatedView = this._outdatedView(profileId);
    for (const row of semantic.results) {
      if (row.score < SEMANTIC_MIN_COSINE) continue;
      const source = row.source;
      const session = sessions.find(entry => entry.id === source.sessionId && entry.profileId === profileId
        && entry.workspace === run.workspace && isHistoricalChatSession(entry)
        && !this.sessions.getCronSessionOrigin?.(entry.sessionKey));
      if (!session || source.runId === run.id || (args.sessionId && source.sessionId !== args.sessionId)) continue;
      const item = this._event(profileId, session, source.eventId, {
        seq: source.seq, run_id: source.runId, content_hash: row.contentHash }, policyView);
      const evidence = { contentHash: row.contentHash, start: row.start, end: row.end };
      const snippet = item ? semanticSnippet(item.text, evidence) : null;
      if (snippet === null) continue;
      const key = `${session.id}\0${source.eventId}`;
      const ranked = hybridScore(lexical.query, item.text, results.get(key)?.score ?? 0, row.score, row.rankScore);
      const outdatedMemories = this._outdatedForEvent(outdatedView, item.event);
      const historicalRunNotice = this._historicalRunNotice(outdatedView, profileId, session, item.event);
      results.set(key, { sessionId: session.id, eventId: item.event.id, kind: item.event.kind,
        occurredAt: item.event.occurredAt, snippet, score: ranked.score, scoreBasis: ranked.scoreBasis,
        semanticScore: row.score, semanticEvidence: evidence, source: "untrusted-transcript",
        ...(outdatedMemories ? { outdatedMemories } : {}), ...(historicalRunNotice ? { historicalRunNotice } : {}) });
    }
    const ranked = [...results.values()].sort((a,b) => b.score - a.score
      || b.occurredAt - a.occurredAt || a.eventId.localeCompare(b.eventId)).slice(0, args.limit ?? 5);
    const result = { ...lexical, results: ranked, count: ranked.length,
      status: semantic.status === "ready" ? "ready" : lexical.status,
      semantic: { status: semantic.status, modelId: "intfloat/multilingual-e5-small",
        approximate: true, requiresContentVerification: true } };
    this.assertResultCurrent({ name: "conversation_search", profileId, args, run, result });
    return result;
  }

  get({ profileId, args, run }) {
    this._caller(profileId, args, run);
    const policyView = this._policyView(profileId);
    const window = args.window ?? 0;
    if (!Number.isSafeInteger(window) || window < 0 || window > 3) {
      throw recallError("CONVERSATION_GET_INVALID", "原话窗口无效");
    }
    const session = this.sessions.listSessions().find((entry) => entry.id === args.sessionId
      && entry.profileId === profileId && entry.workspace === run.workspace
      && isHistoricalChatSession(entry)
      && !this.sessions.getCronSessionOrigin?.(entry.sessionKey));
    if (!session) throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件不可检索");
    const target = this._event(profileId, session, args.eventId, null, policyView);
    if (!target) throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件不可检索");
    const current = this.sessions.getSession(session.sessionKey);
    if (!current || current.id !== session.id || current.profileId !== profileId
      || current.workspace !== run.workspace || !isHistoricalChatSession(current)) {
      throw recallError("CONVERSATION_EVENT_NOT_FOUND", "会话事件不可检索");
    }
    const position = target.events?.findIndex((event) => event.id === args.eventId) ?? -1;
    const slice = this.transcripts.listEventWindow?.(profileId, session.id, args.eventId, window)
      || target.events?.slice(Math.max(0, position - window), position + window + 1) || [];
    const outdatedView = this._outdatedView(profileId);
    const events = slice.map((event) => {
      const visible = (target.context ? this._contextRun(profileId, current, event.runId, target.context)
        : this._verifiedRun(profileId, current, event.runId, null))
        ? this._resolvedText(profileId, current, event, policyView) : null;
      if (visible === null) return { hidden: true };
      const bounded = boundedText(visible, MAX_READ_TEXT_BYTES);
      const outdatedMemories = this._outdatedForEvent(outdatedView, event);
      const historicalRunNotice = this._historicalRunNotice(outdatedView, profileId,
        current, event);
      return { sessionId: session.id, eventId: event.id, kind: event.kind,
        occurredAt: event.occurredAt, text: bounded.text, truncated: bounded.truncated,
        source: "untrusted-transcript", ...(outdatedMemories ? { outdatedMemories } : {}),
        ...(historicalRunNotice ? { historicalRunNotice } : {}) };
    });
    return budgetGetResponse(session.id, args.eventId, events);
  }
}

module.exports = { ConversationRecallService };
