"use strict";

const { serviceError } = require("../security");
const fs = require("node:fs"), path = require("node:path");
const { readPrivateFile } = require("../private-file");
const { canonicalSharedPath, documentKind } = require("./shared-document.cjs");
const { sha256 } = require("./migration.cjs");
const { core } = require("./host.cjs");
const FILE_RANGE = /([^\s`<>()[\]{}]+\.(?:txt|md))(?::(\d+)-(\d+)|#L(\d+)-L(\d+))/gu;
const FILE_RANGE_PREFIX = /([^\s`<>()[\]{}]+\.(?:txt|md))(:|#L)([^\s\n]*)/gu;
const SESSION_CITATION = /\[[^\]\s]+\/sessions\/(?:[^/\s]+\/)?([^#\s\]]+)#L(\d+)\]/gu;
const SOURCE_DECLARATION = /(?:^|\s)(?:Sources?|来源)\s*[:：]\s*([^\r\n]+)/giu;

class SharedReadPolicy {
  constructor(service) { this.service = service; }
  scope(input) {
    if (!input || typeof input.ownerProfileId !== "string" || typeof input.requesterProfileId !== "string"
      || input.ownerProfileId === input.requesterProfileId
      || !["normal", "private"].includes(input.maxSensitivity)) throw serviceError("MEMORY_SHARED_READ_INVALID", "借阅记忆范围无效");
    if ([input.ownerProfileId, input.requesterProfileId].some(id => this.service.profileControllers?.get(id)?.signal.aborted)) {
      throw serviceError("MEMORY_SHARED_SOURCE_REVOKED", "助理已停止，无法借阅记忆");
    }
    this.service.assertProfile(input.ownerProfileId); this.service.assertProfile(input.requesterProfileId);
    this.service.recallPolicy.assertReady(input.ownerProfileId); this.service.recallPolicy.assertReady(input.requesterProfileId);
    const source = this.service.profiles().find(profile => profile.id === input.ownerProfileId);
    const reader = this.service.profiles().find(profile => profile.id === input.requesterProfileId);
    if (source?.enabled !== true || reader?.enabled !== true) throw serviceError("MEMORY_SHARED_SOURCE_UNAVAILABLE", "助理已停用，无法借阅记忆");
    input.signal?.throwIfAborted(); input.assertCurrent?.();
    return { profileId: input.ownerProfileId, workspace: input.workspace, maxSensitivity: input.maxSensitivity };
  }
  foreignVisible(input, item) {
    const policy = this.service.recallPolicy, state = policy.assertReady(input.requesterProfileId);
    return policy._isForeignMemoryVisible(state, input.requesterProfileId, item)
      && !policy.hasRevokedContent(input.requesterProfileId, item.authorityText || item.content);
  }
  sessionOriginEvidence(input, sessionId, seq) {
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    try {
      const session = this.service.chatSessionStore.listSessions().find(value => value.profileId === input.ownerProfileId && value.id === sessionId);
      if (!session || session.workspace !== input.workspace) return null;
      const page = this.service.conversationRecall.scanEligibleSession({ profileId: input.ownerProfileId, sessionId, afterSeq: seq - 1, limit: 1, completedOnly: true });
      const event = page.events.find(value => value.seq === seq);
      if (!event || require("./borrowed-memory-provenance.cjs").isBorrowedMemoryDerived(event)
        || this.service.recallPolicy.hasRevokedContent(input.requesterProfileId, event.text)) return null;
      return { kind: "session", profileId: input.ownerProfileId, sessionId, seq, hash: sha256(`${event.kind}:${event.text}`) };
    } catch { return null; }
  }
  corpusOriginEvidence(input, origin, classificationOnly) {
    if (!/^memory\/\.dreams\/session-corpus\/\d{4}-\d{2}-\d{2}\.txt$/u.test(origin.path)) return null;
    try {
      const root = this.service.host(input.ownerProfileId).workspaceDir, absolute = path.join(root, origin.path);
      if (fs.realpathSync.native(absolute) !== absolute) return null;
      const content = readPrivateFile(absolute, { maxBytes: 16 * 1024 * 1024 }).toString("utf8");
      const lines = content.split("\n").slice(origin.startLine - 1, origin.endLine), fragment = lines.join("\n");
      if (lines.length !== origin.endLine - origin.startLine + 1 || !fragment.trim()
        || !classificationOnly && origin.sourceHash && sha256(fragment) !== origin.sourceHash
        || !this.service.sourceSessionsVisible(input.ownerProfileId,
          `Source: ${origin.path}:${origin.startLine}-${origin.endLine}`, input.workspace)
        || !this.service.sourceSessionsVisible(input.ownerProfileId, fragment, input.workspace)) return null;
      const sessions = [];
      for (const line of lines) {
        const match = /^\[([^/\s\]]+)\/sessions\/(?:[^/\s]+\/)?([^#\s\]]+)#L(\d+)\]\s+(.+)$/u.exec(line);
        if (!match || match[1] !== input.ownerProfileId) return null;
        const source = this.sessionOriginEvidence(input, match[2], Number(match[3]));
        if (!source) return null;
        sessions.push(source);
      }
      // Corpus is a trace to live Product events, never an independently
      // readable source or a new authority based on a hidden file's spelling.
      return [{ kind: "corpus", profileId: input.ownerProfileId, path: origin.path,
        startLine: origin.startLine, endLine: origin.endLine, hash: sha256(fragment) }, ...sessions];
    } catch { return null; }
  }
  reportSegments(relative, content, startLine, endLine) {
    const lines = content.split("\n"), segments = []; let phase = null, current = null, pending = null;
    const flush = () => { if (current) segments.push(current); current = null; };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index], number = index + 1;
      const start = line.match(/^\s*<!--\s*openclaw:dreaming:(light|rem):start\s*-->\s*$/u);
      const end = line.match(/^\s*<!--\s*openclaw:dreaming:(light|rem):end\s*-->\s*$/u);
      if (start || end) { flush(); pending = null; phase = start ? start[1] : null; continue; }
      const reflection = !/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(relative) || Boolean(phase);
      if (!reflection) { flush(); pending = null; continue; }
      if (/^\s*<!--\s*openclaw-memory-promotion:[^\n]*-->\s*$/iu.test(line)) { flush(); pending = line; continue; }
      if (!line.trim() || /^\s*(?:#{1,6}(?:\s|$)|---\s*$)/u.test(line)) { flush(); pending = null; continue; }
      if (/^\s*<!--.*-->\s*$/u.test(line)) continue;
      if (/^\s*(?:[-*+]\s|\d+[.)]\s)/u.test(line)) flush();
      if (!current) { current = { startLine: number, endLine: number, lines: pending ? [pending] : [] }; pending = null; }
      current.lines.push(line); current.endLine = number;
    }
    flush();
    return segments.filter(segment => segment.startLine <= endLine && segment.endLine >= startLine);
  }
  reportOrigins(input, active, relative, startLine, endLine, content) {
    const sources = [], sessions = [], receipts = [], host = this.service.host(input.ownerProfileId);
    const segments = this.reportSegments(relative, content, startLine, endLine);
    if (!segments.length) return null;
    for (const segment of segments) {
      const localSources = [], localSessions = [], localReceipts = [], text = segment.lines.join("\n");
      // Only a durable record covering this complete paragraph can supply its
      // session origins. Broad read projections never lend nearby authority.
      for (const item of active) if (!item.projection && item.startLine <= segment.startLine && item.endLine >= segment.endLine) {
        for (const source of item.sourceEvidence || []) localSessions.push({ sessionId: source.sessionId, seq: source.seq });
      }
      const citationText = text.replace(/<!--\s*openclaw-memory-promotion:[^\n]*?-->/giu, "");
      for (const match of text.matchAll(SESSION_CITATION)) localSessions.push({ sessionId: match[1], seq: Number(match[2]) });
      for (const match of citationText.matchAll(FILE_RANGE)) {
        localSources.push({ path: match[1], startLine: Number(match[2] || match[4]), endLine: Number(match[3] || match[5]) });
      }
      for (const declaration of citationText.matchAll(SOURCE_DECLARATION)) {
        const clean = declaration[1].replace(/<!--[\s\S]*?-->/gu, "").trim();
        for (const part of clean.split(/[;,；，]\s*/u)) {
          const value = part.trim().replace(/^`|`$/gu, "");
          const session = /^\[[^\]\s]+\/sessions\/(?:[^/\s]+\/)?[^#\s\]]+#L\d+\]/u.test(value);
          const file = /^\[?[^\s`<>()[\]{}]+\.(?:txt|md)(?::\d+-\d+|#L\d+-L\d+)\]?[.)]?\s*$/u.test(value);
          if (!session && !file) return null;
        }
      }
      for (const match of citationText.matchAll(FILE_RANGE_PREFIX)) {
        if (!(match[2] === ":" ? /^\d+-\d+/u : /^\d+-L\d+/u).test(match[3])) return null;
      }
      for (const key of core.extractPromotionKeys(text)) {
        const stateKey = `${core.memoryCoreWorkspaceStateKey(host.workspaceDir)}:${sha256(key)}`;
        let retained;
        try { retained = host.database.db.prepare("SELECT path,start_line AS startLine,end_line AS endLine,source_hash AS sourceHash FROM memory_promotion_sources WHERE state_key=?").get(stateKey); }
        catch { return null; }
        if (!retained) return null;
        localSources.push(retained); localReceipts.push({ kind: "promotion", profileId: input.ownerProfileId, key, ...retained });
      }
      const evidence = this.service.store.reportEvidence?.(input.ownerProfileId, relative,
        Math.max(segment.startLine, startLine), Math.min(segment.endLine, endLine));
      if (evidence?.sources?.length) localSources.push(...evidence.sources);
      if (!localSources.length && !localSessions.length) return null;
      sources.push(...localSources); sessions.push(...localSessions); receipts.push(...localReceipts);
    }
    const sessionEvidence = sessions.map(source => this.sessionOriginEvidence(input, source.sessionId, source.seq));
    if (sources.length + sessions.length > 128 || sessionEvidence.some(source => !source)) return null;
    return { sources, sessions: sessionEvidence, receipts };
  }
  classifyOriginEdit(input, previous) {
    const relative = canonicalSharedPath(previous.canonicalRelativePath || previous.path);
    if (!relative || previous.documentKind !== "reflection_report" || !previous.sourceOriginHash) return false;
    try {
      const source = this.service.host(input.ownerProfileId).searchIndex.sourceFiles.read(relative);
      const text = source.text.split("\n").slice(previous.startLine - 1, previous.endLine).join("\n");
      if (sha256(text) !== previous.sourceHash) return false;
      const evidence = [];
      if (!this.allowResult(input, { path: relative, source: "memory", startLine: previous.startLine, endLine: previous.endLine, snippet: text }, new Set(), evidence, true)) return false;
      const hash = sha256(JSON.stringify([...new Set(evidence.map(item => JSON.stringify(item)))].sort()));
      return evidence.length > 0 && hash !== previous.sourceOriginHash;
    } catch { return false; }
  }
  originHash(input, result) {
    const evidence = [];
    if (!this.allowResult(input, result, new Set(), evidence) || !evidence.length) {
      throw serviceError("MEMORY_SHARED_SOURCE_REVOKED", "反思报告缺少可验证原始来源");
    }
    return sha256(JSON.stringify([...new Set(evidence.map(item => JSON.stringify(item)))].sort()));
  }
  allowResult(input, result, visited = new Set(), evidence = null, classificationOnly = false) {
    const scope = this.scope(input), relative = canonicalSharedPath(result.path);
    if (!relative || result.source && result.source !== "memory" || !Number.isSafeInteger(result.startLine)
      || result.startLine < 1 || !Number.isSafeInteger(result.endLine) || result.endLine < result.startLine
      || result.endLine - result.startLine > 1000) return false;
    // Classification-only is used after a previously trusted report fails
    // revalidation. It can distinguish content edits from withdrawal, never
    // admit a new query or return any body with stale origin hashes.
    const source = this.service.host(input.ownerProfileId).searchIndex.sourceFiles.read(relative);
    const reflection = documentKind(relative, source.text, result.startLine, result.endLine) === "reflection_report";
    if ((!classificationOnly || !reflection) && !this.service.allowResult(input.ownerProfileId, { ...result, source: "memory" }, scope)) return false;
    const active = this.service.store.list(input.ownerProfileId, { status: "active" }).filter(item => item.memoryPath === relative
      && item.startLine <= result.endLine && item.endLine >= result.startLine);
    const permissionItem = item => {
      if (!classificationOnly || !reflection) return item;
      const text = (item.authorityText || item.content).replace(/<!--\s*openclaw-memory-promotion:[^\n]*?-->/giu, "")
        .replace(SESSION_CITATION, "").replace(FILE_RANGE, "");
      return { ...item, sourceEvidence: undefined, authorityText: text || "原始来源另行核验" };
    };
    if (!active.length || !active.every(item => this.service.visible(permissionItem(item), scope) && this.foreignVisible(input, item))) return false;
    if (!reflection) return true;
    const key = `${relative}:${result.startLine}:${result.endLine}`;
    if (visited.has(key) || visited.size > 32) return false;
    const origins = this.reportOrigins(input, active, relative, result.startLine, result.endLine, source.text);
    if (!origins) return false;
    const next = new Set(visited); next.add(key);
    if (evidence) evidence.push(...origins.sessions, ...origins.receipts);
    return origins.sources.every(origin => {
      try {
        if (!Number.isSafeInteger(origin.startLine) || origin.startLine < 1
          || !Number.isSafeInteger(origin.endLine) || origin.endLine < origin.startLine || origin.endLine - origin.startLine > 1000) return false;
        if (/^memory\/\.dreams\/session-corpus\/\d{4}-\d{2}-\d{2}\.txt$/u.test(origin.path)) {
          const corpus = this.corpusOriginEvidence(input, origin, classificationOnly);
          if (!corpus) return false;
          if (evidence) evidence.push(...corpus);
          return true;
        }
        if (!canonicalSharedPath(origin.path)) return false;
        const current = this.service.host(input.ownerProfileId).searchIndex.sourceFiles.read(origin.path), lines = current.text.split("\n");
        if (origin.endLine > lines.length) return false;
        const text = lines.slice(origin.startLine - 1, origin.endLine).join("\n");
        if (!classificationOnly && origin.sourceHash && sha256(text) !== origin.sourceHash) return false;
        if (evidence) evidence.push({ kind: "memory", profileId: input.ownerProfileId, path: origin.path, startLine: origin.startLine, endLine: origin.endLine, hash: sha256(text) });
        return this.allowResult(input, { ...origin, source: "memory", snippet: text }, next, evidence, classificationOnly);
      } catch { return false; }
    });
  }
}
module.exports = { SharedReadPolicy };
