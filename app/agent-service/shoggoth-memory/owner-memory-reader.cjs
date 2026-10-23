"use strict";

const { serviceError } = require("../security");
const { sha256 } = require("./migration.cjs");
const { SharedReadPolicy } = require("./shared-read-policy.cjs");
const { canonicalSharedPath, documentKind } = require("./shared-document.cjs");

class OwnerMemoryReader {
  constructor(service) { this.service = service; this.policy = new SharedReadPolicy(service); this.authorities = new Map(); }
  evidenceKey(input, evidence) {
    return sha256(JSON.stringify([input.ownerProfileId, input.requesterProfileId, input.workspace, input.maxSensitivity,
      evidence.canonicalRelativePath || evidence.path, evidence.startLine, evidence.endLine, evidence.sourceHash, evidence.sourceOriginHash]));
  }
  authoritySnapshot(input, evidence) {
    return this.service.store.list(input.ownerProfileId, { status: "active" }).filter(item => item.memoryPath === (evidence.canonicalRelativePath || evidence.path)
      && item.startLine <= evidence.endLine && item.endLine >= evidence.startLine).map(item => ({
        kind: item.projection ? "projection" : "entry", ...(item.projection ? {} : { id: item.id }),
        authorityHash: sha256(item.authorityText || item.content), startOffset: evidence.startLine - item.startLine,
      }));
  }
  recallRevisions(input) {
    return [input.ownerProfileId, input.requesterProfileId].map(id => this.service.recallPolicy.getHistoricalVisibilityRevision(id));
  }
  scopedRequest(input) {
    this.policy.scope(input);
    const sourceSignal = this.service.profileSignal(input.ownerProfileId);
    return { ...input, signal: input.signal ? AbortSignal.any([input.signal, sourceSignal]) : sourceSignal };
  }
  authorityIdentity(authorities) {
    return JSON.stringify(authorities.map(({ startOffset: _offset, ...authority }) => JSON.stringify(authority)).sort());
  }
  editedAuthorityVisible(input, previous, current) {
    const proof = this.authorities.get(this.evidenceKey(input, previous));
    return Boolean(proof?.entries?.length
      && JSON.stringify(proof.recallRevisions) === JSON.stringify(this.recallRevisions(input))
      && [input.ownerProfileId, input.requesterProfileId].every(profileId => this.service.recallPolicy.isSourceVisible(profileId, proof.sourceRefs))
      && !this.service.sharing?.suppressed(input.requesterProfileId, { ...current, sourceHash: previous.sourceHash }));
  }
  relocatedFragment(input, previous) {
    // This ephemeral proof retains only authority IDs and hashes. A moved
    // fragment must still belong to those same complete entries, with every
    // current permission and suppression check passing at its new position.
    const proof = this.authorities.get(this.evidenceKey(input, previous));
    if (!proof?.entries?.length) return false;
    const authorities = proof.entries;
    try {
      const relative = previous.canonicalRelativePath || previous.path;
      const current = this.service.store.list(input.ownerProfileId, { status: "active" }).filter(item => item.memoryPath === relative);
      const starts = new Set();
      for (const authority of authorities) for (const item of current) {
        if ((item.projection ? "projection" : "entry") !== authority.kind
          || authority.id && item.id !== authority.id || sha256(item.authorityText || item.content) !== authority.authorityHash) continue;
        starts.add(item.startLine + authority.startOffset);
      }
      for (const startLine of starts) {
        if (startLine < 1 || startLine === previous.startLine) continue;
        const candidate = this.evidence(input, { path: relative, startLine, endLine: startLine + previous.endLine - previous.startLine });
        if (candidate.sourceHash !== previous.sourceHash || candidate.documentKind !== previous.documentKind
          || this.authorityIdentity(this.authoritySnapshot(input, candidate)) !== this.authorityIdentity(authorities)
          || this.service.sharing?.suppressed(input.requesterProfileId, candidate)) continue;
        return true;
      }
      // A stable durable entry ID can survive an ordinary edit together with
      // a position change. Classification never grants a replacement body;
      // prepared output is discarded and a fresh query must create new refs.
      // Original forget-policy drift is fail-closed because no old plaintext
      // is retained to prove that a newly forgotten substring was unrelated.
      if (authorities.some(authority => authority.kind !== "entry")
        || JSON.stringify(proof.recallRevisions) !== JSON.stringify(this.recallRevisions(input))) return false;
      const retained = authorities.map(authority => current.find(item => !item.projection && item.id === authority.id));
      if (retained.some(item => !item) || retained.every((item, index) => sha256(item.authorityText || item.content) === authorities[index].authorityHash)) return false;
      const startLine = Math.min(...retained.map(item => item.startLine)), endLine = Math.max(...retained.map(item => item.endLine));
      if (endLine - startLine > 1000 || ![input.ownerProfileId, input.requesterProfileId].every(profileId => this.service.recallPolicy.isSourceVisible(profileId, proof.sourceRefs))) return false;
      const candidate = this.evidence(input, { path: relative, startLine, endLine });
      if (candidate.documentKind !== previous.documentKind || !this.editedAuthorityVisible(input, previous, candidate)) return false;
      return true;
    } catch { return false; }
    return false;
  }
  evidence(input, result) {
    const scope = this.policy.scope(input), host = this.service.host(input.ownerProfileId);
    const source = host.searchIndex.sourceFiles.read(result.path), text = source.text.split("\n").slice(result.startLine - 1, result.endLine).join("\n");
    const candidate = { ...result, source: "memory", snippet: text };
    if (!text.trim() || !this.policy.allowResult(input, candidate)) throw serviceError("MEMORY_SHARED_SOURCE_REVOKED", "借阅记忆的来源或权限已失效");
    host.assertWorkspace(host.workspaceDir);
    const hash = sha256(text), kind = documentKind(result.path, source.text, result.startLine, result.endLine);
    const sourceOriginHash = kind === "reflection_report" ? this.policy.originHash(input, candidate) : undefined;
    const evidence = { ...candidate, ownerProfileId: scope.profileId, canonicalRelativePath: result.path,
      documentKind: kind, ...(sourceOriginHash ? { sourceOriginHash } : {}),
      sourceHash: hash, sourceRevision: `sha256:${hash}`,
      citation: `${result.path}#L${result.startLine}-L${result.endLine}` };
    const key = this.evidenceKey(input, evidence);
    const entries = this.authoritySnapshot(input, evidence);
    const sourceRefs = this.service.store.list(input.ownerProfileId, { status: "active" }).filter(item => entries.some(authority => authority.id === item.id)).flatMap(item => item.sourceRefs || []);
    this.authorities.set(key, { entries, sourceRefs, recallRevisions: this.recallRevisions(input) });
    if (this.authorities.size > 8192) this.authorities.delete(this.authorities.keys().next().value);
    return evidence;
  }
  async search(input) {
    input = this.scopedRequest(input);
    const scope = this.policy.scope(input), host = this.service.host(input.ownerProfileId);
    const value = await this.service.searchScope.run(scope, () => host.searchIndex.withCandidateFilter(
      result => this.policy.allowResult(input, result), () => this.service.searchMemory({ ...scope, query: input.query,
        maxResults: input.maxResults ?? 10, minScore: input.minScore, lexicalOnly: input.lexicalOnly === true,
        signal: input.signal, record: false, sources: ["memory"] })));
    this.policy.scope(input);
    const results = value.results.map(result => this.evidence(input, result));
    return { status: "ready", results, semantic: value.semantic };
  }
  async triggerCandidates(input, options = {}) {
    input = this.scopedRequest(input);
    const scope = this.policy.scope(input), host = this.service.host(input.ownerProfileId);
    const results = await this.service.searchScope.run(scope, () => host.searchIndex.withCandidateFilter(
      result => this.policy.allowResult(input, result), () => host.run(() => host.searchIndex.listTriggerCandidates({ ...options, signal: input.signal }))));
    this.policy.scope(input);
    return { status: "ready", results: results.map(result => this.evidence(input, result)), semantic: { status: "ready", modelId: "lexical" } };
  }
  revalidate(input, evidence) {
    this.policy.scope(input);
    const relative = canonicalSharedPath(evidence?.canonicalRelativePath ?? evidence?.path);
    if (!relative || evidence?.ownerProfileId && evidence.ownerProfileId !== input.ownerProfileId
      || !Number.isSafeInteger(evidence?.startLine) || !Number.isSafeInteger(evidence?.endLine)
      || evidence.startLine < 1 || evidence.endLine < evidence.startLine || evidence.endLine - evidence.startLine > 1000
      || !/^[a-f0-9]{64}$/u.test(evidence?.sourceHash || "")
      || evidence.sourceOriginHash !== undefined && !/^[a-f0-9]{64}$/u.test(evidence.sourceOriginHash)) throw serviceError("MEMORY_SHARED_READ_INVALID", "借阅引用范围无效");
    let result;
    try { result = this.evidence(input, { path: relative, source: "memory", startLine: evidence.startLine, endLine: evidence.endLine }); }
    catch (error) {
      if (this.relocatedFragment(input, evidence) || this.editedAuthorityVisible(input, evidence, evidence) && this.policy.classifyOriginEdit(input, evidence)) throw serviceError("MEMORY_SOURCE_CHANGED", "借阅片段或原始来源已变化，请重新检索");
      if (["ENOENT", "ENOTDIR"].includes(error.code)) throw serviceError("MEMORY_SHARED_SOURCE_REVOKED", "借阅记忆来源已删除");
      throw error;
    }
    if (result.documentKind === "reflection_report" && !evidence.sourceOriginHash) throw serviceError("MEMORY_SHARED_READ_INVALID", "反思报告引用缺少原始来源依赖");
    if (result.sourceHash !== evidence.sourceHash || result.sourceOriginHash !== evidence.sourceOriginHash) {
      if (!this.editedAuthorityVisible(input, evidence, result)) throw serviceError("MEMORY_SHARED_SOURCE_REVOKED", "原始借阅权限或屏蔽状态已变化");
      throw serviceError("MEMORY_SOURCE_CHANGED", "借阅记忆来源片段或原始来源已变化，请重新检索");
    }
    return result;
  }
  read(input, evidence) { return this.revalidate(input, evidence); }
}
module.exports = { OwnerMemoryReader };
